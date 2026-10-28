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

/// Conservative planning hints, not allocation guarantees. The recommendation
/// follows the CPU-only engine that ships with the app: available memory and
/// thread count decide the tier, while a large dedicated GPU can lift a
/// mid-range machine one tier (a user-supplied GPU backend can use it).
/// Memory reserves leave room for the OS, projector and inference context.
pub fn recommend(memory: u64, threads: u32, vram: u64, gpu_name: String) -> HardwareRecommendation {
    const GIB: u64 = 1024 * 1024 * 1024;
    let gpu = vram >= 10 * GIB;
    let (size, quant, reason) =
        if (memory >= 32 * GIB && threads >= 12) || (gpu && memory >= 16 * GIB && threads >= 8) {
            (
                "4b",
                "Q4_K_M",
                if gpu {
                    "检测到 GPU 显存，建议 4B Q4 档位；实际速度取决于引擎后端与上下文"
                } else {
                    "处理器与内存较充足，建议 4B Q4 档位；实际速度取决于处理器与上下文"
                },
            )
        } else if memory >= 24 * GIB && threads >= 8 {
            (
                "4b",
                "Q3_K_M",
                "内存较充足，建议 4B Q3 档位；实际速度取决于处理器与上下文",
            )
        } else if memory >= 16 * GIB && threads >= 8 {
            (
                "2b",
                "Q4_K_M",
                "建议 2B Q4 档位；实际速度取决于处理器与上下文",
            )
        } else if memory >= 16 * GIB && threads >= 6 {
            (
                "2b",
                "Q3_K_M",
                "建议 2B Q3 档位；实际速度取决于处理器与上下文",
            )
        } else if memory >= 8 * GIB && threads >= 6 {
            (
                "0.8b",
                "Q4_K_M",
                "建议轻量 0.8B Q4 档位；实际速度取决于处理器与上下文",
            )
        } else {
            (
                "0.8b",
                "Q3_K_M",
                "资源有限或检测不完整，建议从最小 0.8B Q3 档位开始",
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
    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn recommendation_tiers_and_catalog_membership() {
        for (memory, cpu, vram, expected) in [
            (0, 1, 0, "qwen3.5-0.8b-q3-k-m"),
            (7, 6, 0, "qwen3.5-0.8b-q3-k-m"),
            (8, 5, 0, "qwen3.5-0.8b-q3-k-m"),
            (8, 6, 0, "qwen3.5-0.8b-q4-k-m"),
            (15, 8, 0, "qwen3.5-0.8b-q4-k-m"),
            (16, 7, 0, "qwen3.5-2b-q3-k-m"),
            (16, 8, 0, "qwen3.5-2b-q4-k-m"),
            (23, 8, 0, "qwen3.5-2b-q4-k-m"),
            (24, 8, 0, "qwen3.5-4b-q3-k-m"),
            (31, 20, 0, "qwen3.5-4b-q3-k-m"),
            (32, 11, 0, "qwen3.5-4b-q3-k-m"),
            (32, 12, 0, "qwen3.5-4b-q4-k-m"),
            (62, 16, 16, "qwen3.5-4b-q4-k-m"),
            (128, 64, 24, "qwen3.5-4b-q4-k-m"),
            (16, 8, 12, "qwen3.5-4b-q4-k-m"),
            (128, 4, 24, "qwen3.5-0.8b-q3-k-m"),
            (31, 12, 24, "qwen3.5-4b-q4-k-m"),
        ] {
            let result = recommend(memory * GIB, cpu, vram * GIB, String::new());
            assert_eq!(
                result.recommended_model_id, expected,
                "memory={memory} cpu={cpu} vram={vram}"
            );
            assert!(crate::engine::models::spec_by_id(expected).unwrap().vision);
            let json = serde_json::to_value(result).unwrap();
            assert!(json.get("totalMemoryBytes").is_some());
            assert!(json.get("recommendedModelId").is_some());
            assert!(
                !json.get("totalMemoryBytes").unwrap().is_null(),
                "memory must be reported even when the tier is small"
            );
        }
    }

    #[test]
    fn memory_thresholds_are_exact_bytes() {
        for (memory, threads, expected) in [
            (8 * GIB - 1, 6, "qwen3.5-0.8b-q3-k-m"),
            (8 * GIB, 6, "qwen3.5-0.8b-q4-k-m"),
            (16 * GIB - 1, 8, "qwen3.5-0.8b-q4-k-m"),
            (16 * GIB, 6, "qwen3.5-2b-q3-k-m"),
            (16 * GIB, 8, "qwen3.5-2b-q4-k-m"),
            (24 * GIB - 1, 8, "qwen3.5-2b-q4-k-m"),
            (24 * GIB, 8, "qwen3.5-4b-q3-k-m"),
            (32 * GIB - 1, 12, "qwen3.5-4b-q3-k-m"),
            (32 * GIB, 12, "qwen3.5-4b-q4-k-m"),
        ] {
            assert_eq!(
                recommend(memory, threads, 0, String::new()).recommended_model_id,
                expected,
                "memory={memory} threads={threads}"
            );
        }
    }

    #[test]
    fn user_machine_uses_a_four_b_tier_and_preserves_gpu_display() {
        let result = recommend(31 * GIB, 12, 496 * 1024 * 1024, "AMD Radeon".into());
        assert_eq!(result.recommended_model_id, "qwen3.5-4b-q3-k-m");
        assert_eq!(result.gpu_vram_bytes, 496 * 1024 * 1024);
        assert_eq!(result.gpu_name, "AMD Radeon");
        assert!(result.reason.contains("4B Q3"));

        let result = recommend(62 * GIB, 16, 16 * GIB, "AMD Radeon RX 9070 XT".into());
        assert_eq!(result.recommended_model_id, "qwen3.5-4b-q4-k-m");
        assert_eq!(result.recommended_quant, "Q4_K_M");
        assert!(result.reason.contains("4B Q4"));
        assert!(result.reason.contains("GPU"));
    }

    #[test]
    fn cpu_tiers_ignore_vram_and_keep_reason_tiers() {
        for (memory, threads, expected, reason_tier) in [
            (0, 0, "qwen3.5-0.8b-q3-k-m", "0.8B Q3"),
            (8, 6, "qwen3.5-0.8b-q4-k-m", "0.8B Q4"),
            (16, 6, "qwen3.5-2b-q3-k-m", "2B Q3"),
            (16, 8, "qwen3.5-2b-q4-k-m", "2B Q4"),
            (24, 8, "qwen3.5-4b-q3-k-m", "4B Q3"),
            (32, 12, "qwen3.5-4b-q4-k-m", "4B Q4"),
        ] {
            for vram in [0, 496 * 1024 * 1024] {
                let result = recommend(memory * GIB, threads, vram, "GPU".into());
                assert_eq!(result.recommended_model_id, expected);
                assert!(result.reason.contains(reason_tier));
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
    fn recommendations_require_real_thread_budget() {
        for threads in [0, 1, 4] {
            let result = recommend(128 * GIB, threads, 24 * GIB, String::new());
            assert_eq!(result.recommended_model_id, "qwen3.5-0.8b-q3-k-m");
        }
        // A GPU alone is not enough: memory and threads still gate the tier.
        let result = recommend(8 * GIB, 6, 24 * GIB, String::new());
        assert_eq!(result.recommended_model_id, "qwen3.5-0.8b-q4-k-m");
    }

    #[test]
    fn native_probe_is_safe_and_stable() {
        let first = detect();
        assert!(first.cpu_threads > 0);
        assert_eq!(detect().total_memory_bytes, first.total_memory_bytes);
    }
}
