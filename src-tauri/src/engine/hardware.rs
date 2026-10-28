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
    let (size, quant, reason) = if memory >= 32 * GIB && threads >= 20 {
        (
            "2b",
            "Q4_K_M",
            "按 CPU 推理估算，建议 2B Q4 档位；实际速度取决于处理器与上下文",
        )
    } else if memory >= 16 * GIB && threads >= 8 {
        (
            "2b",
            "Q3_K_M",
            "按 CPU 推理估算，建议 2B Q3 档位；实际速度取决于处理器与上下文",
        )
    } else if memory >= 8 * GIB && threads >= 6 {
        (
            "0.8b",
            "Q4_K_M",
            "按 CPU 推理估算，建议轻量 0.8B Q4 档位；实际速度取决于处理器与上下文",
        )
    } else {
        (
            "0.8b",
            "Q3_K_M",
            "按 CPU 推理估算，资源有限或检测不完整，建议从最小 0.8B Q3 档位开始",
        )
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
            (7, 6, 0, "qwen3.5-0.8b-q3-k-m"),
            (8, 5, 0, "qwen3.5-0.8b-q3-k-m"),
            (8, 6, 0, "qwen3.5-0.8b-q4-k-m"),
            (15, 8, 0, "qwen3.5-0.8b-q4-k-m"),
            (16, 7, 0, "qwen3.5-0.8b-q4-k-m"),
            (16, 8, 0, "qwen3.5-2b-q3-k-m"),
            (31, 20, 0, "qwen3.5-2b-q3-k-m"),
            (32, 19, 0, "qwen3.5-2b-q3-k-m"),
            (32, 20, 0, "qwen3.5-2b-q4-k-m"),
            (128, 64, 24, "qwen3.5-2b-q4-k-m"),
            (128, 4, 24, "qwen3.5-0.8b-q3-k-m"),
            (31, 12, 24, "qwen3.5-2b-q3-k-m"),
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
    fn memory_thresholds_are_exact_bytes() {
        const GIB: u64 = 1024 * 1024 * 1024;
        for (memory, threads, expected) in [
            (8 * GIB - 1, 6, "qwen3.5-0.8b-q3-k-m"),
            (16 * GIB - 1, 8, "qwen3.5-0.8b-q4-k-m"),
            (32 * GIB - 1, 20, "qwen3.5-2b-q3-k-m"),
        ] {
            assert_eq!(
                recommend(memory, threads, 0, String::new()).recommended_model_id,
                expected
            );
        }
    }
    #[test]
    fn user_machine_uses_cpu_tier_and_preserves_gpu_display() {
        let result = recommend(
            31 * 1024 * 1024 * 1024,
            12,
            496 * 1024 * 1024,
            "AMD Radeon".into(),
        );
        assert_eq!(result.recommended_model_id, "qwen3.5-2b-q3-k-m");
        assert_eq!(result.gpu_vram_bytes, 496 * 1024 * 1024);
        assert_eq!(result.gpu_name, "AMD Radeon");
        assert!(result.reason.contains("CPU"));
    }
    #[test]
    fn cpu_recommendations_match_reasons_and_ignore_vram() {
        const GIB: u64 = 1024 * 1024 * 1024;
        for (memory, threads, expected, reason_tier) in [
            (0, 0, "qwen3.5-0.8b-q3-k-m", "0.8B Q3"),
            (8, 6, "qwen3.5-0.8b-q4-k-m", "0.8B Q4"),
            (16, 8, "qwen3.5-2b-q3-k-m", "2B Q3"),
            (32, 20, "qwen3.5-2b-q4-k-m", "2B Q4"),
        ] {
            for vram in [0, 496 * 1024 * 1024, 24 * GIB, u64::MAX] {
                let result = recommend(memory * GIB, threads, vram, "GPU".into());
                assert_eq!(result.recommended_model_id, expected);
                assert!(result.reason.contains("CPU"));
                assert!(result.reason.contains(reason_tier));
                assert!(!result.reason.contains("4B"));
                assert_eq!(result.gpu_vram_bytes, vram);
                assert_eq!(result.gpu_name, "GPU");
                assert_eq!(
                    result.recommended_quant,
                    if expected.contains("-q4-") {
                        "Q4_K_M"
                    } else {
                        "Q3_K_M"
                    }
                );
            }
        }
    }
    #[test]
    fn cpu_detection_ranges_never_recommend_4b() {
        const GIB: u64 = 1024 * 1024 * 1024;
        for memory in [
            0,
            8 * GIB - 1,
            8 * GIB,
            16 * GIB - 1,
            16 * GIB,
            32 * GIB - 1,
            32 * GIB,
            u64::MAX,
        ] {
            for threads in [0, 1, 5, 6, 7, 8, 19, 20, u32::MAX] {
                for vram in [0, u64::MAX] {
                    let result = recommend(memory, threads, vram, String::new());
                    assert!(!result.recommended_model_id.contains("-4b-"));
                }
            }
        }
    }
    #[test]
    fn native_probe_is_safe_and_stable() {
        let first = detect();
        assert!(first.cpu_threads > 0);
        assert_eq!(detect().total_memory_bytes, first.total_memory_bytes);
    }
}
