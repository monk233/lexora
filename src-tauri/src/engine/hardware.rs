//! Hardware hints only: recommendations never change the user's model selection.
use serde::Serialize;
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareRecommendation {
    pub total_memory_bytes: u64,
    pub cpu_threads: u32,
    pub gpu_vram_bytes: u64,
    pub gpu_name: String,
    pub recommended_model_id: String,
    pub recommended_quant: String,
    pub reason: String,
}

/// Conservative planning hints, not allocation guarantees. Memory reserves leave
/// room for the OS, projector and inference context; CPU affects latency.
pub fn recommend(memory: u64, threads: u32, vram: u64, gpu_name: String) -> HardwareRecommendation {
    const GIB: u64 = 1024 * 1024 * 1024;
    let (size, quant, reason) = if memory == 0 {
        ("0.8b", "Q3_K_M", "未能检测物理内存，建议从最小模型开始")
    } else if memory >= 16 * GIB && (threads >= 8 || vram >= 4 * GIB) {
        ("4b", "Q4_K_M", "内存和计算资源充足，优先模型效果")
    } else if memory >= 12 * GIB && threads >= 4 {
        ("4b", "Q3_K_M", "内存适中，采用较小量化控制占用")
    } else if memory >= 8 * GIB && threads >= 4 {
        ("2b", "Q4_K_M", "兼顾内存占用与通用、视觉效果")
    } else if memory >= 6 * GIB && threads >= 4 {
        ("2b", "Q3_K_M", "可用内存较少，采用较小量化")
    } else if memory >= 4 * GIB {
        ("0.8b", "Q4_K_M", "内存或 CPU 资源有限，优先轻量模型")
    } else {
        ("0.8b", "Q3_K_M", "内存较少，建议最小模型并关闭其他应用")
    };
    HardwareRecommendation {
        total_memory_bytes: memory,
        cpu_threads: threads,
        gpu_vram_bytes: vram,
        gpu_name,
        recommended_model_id: format!(
            "qwen3.5-{size}-{}",
            quant.to_ascii_lowercase().replace('_', "-")
        ),
        recommended_quant: quant.to_string(),
        reason: reason.to_string(),
    }
}

/// Probe once per process, avoiding DXGI enumeration on every state update.
pub fn detect() -> HardwareRecommendation {
    static PROFILE: OnceLock<HardwareRecommendation> = OnceLock::new();
    PROFILE
        .get_or_init(|| {
            let threads = std::thread::available_parallelism()
                .map(|n| n.get() as u32)
                .unwrap_or(1);
            let (memory, vram, name) = platform_hardware();
            recommend(memory, threads, vram, name)
        })
        .clone()
}

#[cfg(windows)]
fn platform_hardware() -> (u64, u64, String) {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
    };
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    unsafe {
        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        let memory = if GlobalMemoryStatusEx(&mut status).is_ok() {
            status.ullTotalPhys
        } else {
            0
        };
        let mut vram = 0;
        let mut name = String::new();
        if let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() {
            let mut index = 0;
            while let Ok(adapter) = factory.EnumAdapters1(index) {
                index += 1;
                if let Ok(desc) = adapter.GetDesc1() {
                    if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                        continue;
                    }
                    let bytes = desc.DedicatedVideoMemory as u64;
                    if name.is_empty() || bytes > vram {
                        vram = bytes;
                        let len = desc
                            .Description
                            .iter()
                            .position(|c| *c == 0)
                            .unwrap_or(desc.Description.len());
                        name = String::from_utf16_lossy(&desc.Description[..len]);
                    }
                }
            }
        }
        (memory, vram, name)
    }
}

#[cfg(not(windows))]
fn platform_hardware() -> (u64, u64, String) {
    (0, 0, String::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recommendation_tiers_and_catalog_membership() {
        const GIB: u64 = 1024 * 1024 * 1024;
        for (memory, cpu, vram, expected) in [
            (0, 1, 0, "qwen3.5-0.8b-q3-k-m"),
            (3, 2, 0, "qwen3.5-0.8b-q3-k-m"),
            (4, 2, 0, "qwen3.5-0.8b-q4-k-m"),
            (6, 4, 0, "qwen3.5-2b-q3-k-m"),
            (8, 4, 0, "qwen3.5-2b-q4-k-m"),
            (12, 4, 0, "qwen3.5-4b-q3-k-m"),
            (16, 8, 0, "qwen3.5-4b-q4-k-m"),
            (16, 4, 4, "qwen3.5-4b-q4-k-m"),
        ] {
            let result = recommend(memory * GIB, cpu, vram * GIB, String::new());
            assert_eq!(result.recommended_model_id, expected);
            assert!(crate::engine::models::spec_by_id(expected).unwrap().vision);
            let json = serde_json::to_value(result).unwrap();
            assert!(json.get("totalMemoryBytes").is_some());
            assert!(json.get("recommendedModelId").is_some());
        }
    }
    #[test]
    fn native_probe_is_safe_and_stable() {
        let first = detect();
        assert!(first.cpu_threads > 0);
        assert_eq!(detect().total_memory_bytes, first.total_memory_bytes);
    }
}
