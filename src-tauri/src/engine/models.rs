//! Local GGUF model catalog, directory scanning and filename helpers.
//!
//! The catalog is a compile-time constant so the settings UI always has a stable
//! list of downloadable models, even offline. All local AI tasks use Qwen3.5;
//! six Qwen3.5 variants share one projector per model size.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::engine::{CatalogEntry, EngineError, ModelInfo};

/// The multimodal projector (mmproj) of a vision model. llama.cpp cannot feed
/// images to a GGUF model without it, so it is downloaded alongside the weights.
#[derive(Debug, Clone, Copy)]
pub struct MmprojSpec {
    pub remote_filename: &'static str,
    pub filename: &'static str,
    pub size_bytes: u64,
    pub hf_url: &'static str,
    pub modelscope_url: &'static str,
}

/// One downloadable model definition (not serialized directly).
#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub filename: &'static str,
    pub size_bytes: u64,
    pub license: &'static str,
    pub languages: &'static str,
    pub recommended: bool,
    pub hf_url: &'static str,
    pub modelscope_url: &'static str,
    /// `true` when the model can understand images (requires `mmproj`).
    pub vision: bool,
    /// Vision projector that must be installed next to the weights.
    pub mmproj: Option<MmprojSpec>,
}

/// Six manually selected multimodal variants for all local AI tasks.
/// Downloads try `modelscope_url` first and fall back to `hf_url`; `hf_url` may
/// be empty when the model is only distributed through ModelScope.
pub const CATALOG: [ModelSpec; 6] = [
    ModelSpec {
        id: "qwen3.5-0.8b-q4-k-m",
        name: "Qwen3.5 0.8B Q4_K_M",
        description: "通用文本与视觉理解；需同时安装模型和视觉投影器，使用前请手动选择",
        filename: "Qwen3.5-0.8B-Q4_K_M.gguf", size_bytes: 532517120,
        license: "Apache-2.0", languages: "多语言", recommended: false,
        hf_url: "", modelscope_url: "https://www.modelscope.cn/models/unsloth/Qwen3.5-0.8B-GGUF/resolve/master/Qwen3.5-0.8B-Q4_K_M.gguf", vision: true,
        mmproj: Some(MmprojSpec { filename: "mmproj-Qwen3.5-0.8B-F16.gguf",
            remote_filename: "mmproj-F16.gguf", size_bytes: 204987232, hf_url: "",
            modelscope_url: "https://www.modelscope.cn/models/unsloth/Qwen3.5-0.8B-GGUF/resolve/master/mmproj-F16.gguf" }),
    },
    ModelSpec {
        id: "qwen3.5-0.8b-q3-k-m",
        name: "Qwen3.5 0.8B Q3_K_M",
        description: "通用文本与视觉理解；需同时安装模型和视觉投影器，使用前请手动选择",
        filename: "Qwen3.5-0.8B-Q3_K_M.gguf", size_bytes: 470167808,
        license: "Apache-2.0", languages: "多语言", recommended: false,
        hf_url: "", modelscope_url: "https://www.modelscope.cn/models/unsloth/Qwen3.5-0.8B-GGUF/resolve/master/Qwen3.5-0.8B-Q3_K_M.gguf", vision: true,
        mmproj: Some(MmprojSpec { filename: "mmproj-Qwen3.5-0.8B-F16.gguf",
            remote_filename: "mmproj-F16.gguf", size_bytes: 204987232, hf_url: "",
            modelscope_url: "https://www.modelscope.cn/models/unsloth/Qwen3.5-0.8B-GGUF/resolve/master/mmproj-F16.gguf" }),
    },
    ModelSpec {
        id: "qwen3.5-2b-q4-k-m",
        name: "Qwen3.5 2B Q4_K_M",
        description: "通用文本与视觉理解；需同时安装模型和视觉投影器，使用前请手动选择",
        filename: "Qwen3.5-2B-Q4_K_M.gguf", size_bytes: 1280835840,
        license: "Apache-2.0", languages: "多语言", recommended: false,
        hf_url: "", modelscope_url: "https://www.modelscope.cn/models/unsloth/Qwen3.5-2B-GGUF/resolve/master/Qwen3.5-2B-Q4_K_M.gguf", vision: true,
        mmproj: Some(MmprojSpec { filename: "mmproj-Qwen3.5-2B-F16.gguf",
            remote_filename: "mmproj-F16.gguf", size_bytes: 668227264, hf_url: "",
            modelscope_url: "https://www.modelscope.cn/models/unsloth/Qwen3.5-2B-GGUF/resolve/master/mmproj-F16.gguf" }),
    },
    ModelSpec {
        id: "qwen3.5-2b-q3-k-m",
        name: "Qwen3.5 2B Q3_K_M",
        description: "通用文本与视觉理解；需同时安装模型和视觉投影器，使用前请手动选择",
        filename: "Qwen3.5-2B-Q3_K_M.gguf", size_bytes: 1107149056,
        license: "Apache-2.0", languages: "多语言", recommended: false,
        hf_url: "", modelscope_url: "https://www.modelscope.cn/models/unsloth/Qwen3.5-2B-GGUF/resolve/master/Qwen3.5-2B-Q3_K_M.gguf", vision: true,
        mmproj: Some(MmprojSpec { filename: "mmproj-Qwen3.5-2B-F16.gguf",
            remote_filename: "mmproj-F16.gguf", size_bytes: 668227264, hf_url: "",
            modelscope_url: "https://www.modelscope.cn/models/unsloth/Qwen3.5-2B-GGUF/resolve/master/mmproj-F16.gguf" }),
    },
    ModelSpec {
        id: "qwen3.5-4b-q4-k-m",
        name: "Qwen3.5 4B Q4_K_M",
        description: "通用文本与视觉理解；需同时安装模型和视觉投影器，使用前请手动选择",
        filename: "Qwen3.5-4B-Q4_K_M.gguf", size_bytes: 2740937888,
        license: "Apache-2.0", languages: "多语言", recommended: false,
        hf_url: "", modelscope_url: "https://www.modelscope.cn/models/unsloth/Qwen3.5-4B-GGUF/resolve/master/Qwen3.5-4B-Q4_K_M.gguf", vision: true,
        mmproj: Some(MmprojSpec { filename: "mmproj-Qwen3.5-4B-F16.gguf",
            remote_filename: "mmproj-F16.gguf", size_bytes: 672423616, hf_url: "",
            modelscope_url: "https://www.modelscope.cn/models/unsloth/Qwen3.5-4B-GGUF/resolve/master/mmproj-F16.gguf" }),
    },
    ModelSpec {
        id: "qwen3.5-4b-q3-k-m",
        name: "Qwen3.5 4B Q3_K_M",
        description: "通用文本与视觉理解；需同时安装模型和视觉投影器，使用前请手动选择",
        filename: "Qwen3.5-4B-Q3_K_M.gguf", size_bytes: 2293388448,
        license: "Apache-2.0", languages: "多语言", recommended: false,
        hf_url: "", modelscope_url: "https://www.modelscope.cn/models/unsloth/Qwen3.5-4B-GGUF/resolve/master/Qwen3.5-4B-Q3_K_M.gguf", vision: true,
        mmproj: Some(MmprojSpec { filename: "mmproj-Qwen3.5-4B-F16.gguf",
            remote_filename: "mmproj-F16.gguf", size_bytes: 672423616, hf_url: "",
            modelscope_url: "https://www.modelscope.cn/models/unsloth/Qwen3.5-4B-GGUF/resolve/master/mmproj-F16.gguf" }),
    },
];

/// Files larger than this are rejected on import (the FLINT const keeps the
/// comparison lossless on 32-bit builds; Lexora ships 64-bit only).
pub const MAX_IMPORT_BYTES: u64 = 4 * 1024 * 1024 * 1024;

pub fn spec_by_id(id: &str) -> Option<&'static ModelSpec> {
    let wanted = id.trim();
    CATALOG.iter().find(|spec| spec.id == wanted)
}

/// Download mirrors in priority order: ModelScope first, then Hugging Face.
/// Empty URLs (mirror not published) are skipped.
fn mirror_urls(modelscope_url: &'static str, hf_url: &'static str) -> Vec<&'static str> {
    [modelscope_url, hf_url]
        .into_iter()
        .filter(|url| !url.is_empty())
        .collect()
}

/// Download mirrors for a model's main weights file.
pub fn download_urls(spec: &ModelSpec) -> Vec<&'static str> {
    mirror_urls(spec.modelscope_url, spec.hf_url)
}

/// Download mirrors for a vision model's multimodal projector.
pub fn mmproj_download_urls(mmproj: &MmprojSpec) -> Vec<&'static str> {
    mirror_urls(mmproj.modelscope_url, mmproj.hf_url)
}

/// `true` for the multimodal projector files that accompany a vision model.
/// They are fetched automatically with the model, so they must never be listed
/// or selectable as a standalone model.
pub fn is_mmproj_file(file_name: &str) -> bool {
    file_name.trim().to_ascii_lowercase().starts_with("mmproj")
}

pub fn spec_by_filename(filename: &str) -> Option<&'static ModelSpec> {
    let wanted = filename.trim();
    CATALOG
        .iter()
        .find(|spec| spec.filename.eq_ignore_ascii_case(wanted))
}

/// Returns the catalog id for a model file, or an empty string when the file
/// was imported by the user and is not part of the built-in catalog.
pub fn catalog_id_for(filename: &str) -> String {
    spec_by_filename(filename)
        .map(|spec| spec.id.to_string())
        .unwrap_or_default()
}

/// Builds the serializable catalog view, marking already installed entries.
///
/// A vision model counts as installed only when both the weights and its
/// multimodal projector are present; the projector is useless on its own.
pub fn catalog_entries(models_dir: &Path) -> Vec<CatalogEntry> {
    CATALOG
        .iter()
        .map(|spec| {
            let has_main = models_dir.join(spec.filename).is_file();
            let has_mmproj = spec
                .mmproj
                .map(|mmproj| models_dir.join(mmproj.filename).is_file())
                .unwrap_or(true);
            CatalogEntry {
                id: spec.id.to_string(),
                name: spec.name.to_string(),
                description: spec.description.to_string(),
                filename: spec.filename.to_string(),
                size_bytes: spec.size_bytes,
                license: spec.license.to_string(),
                languages: spec.languages.to_string(),
                recommended: spec.recommended,
                installed: has_main && has_mmproj,
                vision: spec.vision,
            }
        })
        .collect()
}

/// Scans `<models>/*.gguf` and returns sorted metadata (catalog models first).
pub fn scan_models(models_dir: &Path) -> Vec<ModelInfo> {
    let mut models: Vec<ModelInfo> = Vec::new();
    let Ok(entries) = fs::read_dir(models_dir) else {
        return models;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !is_gguf_file(file_name) {
            continue;
        }
        // The vision projector is not a standalone model: it is downloaded with
        // its weights and passed to llama-server through `--mmproj`.
        if is_mmproj_file(file_name) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        let name = model_display_name(file_name);
        models.push(ModelInfo {
            file: file_name.to_string(),
            name,
            path: path.to_string_lossy().to_string(),
            size_bytes: metadata.len(),
            modified_at,
            catalog_id: catalog_id_for(file_name),
        });
    }
    models.sort_by(|left, right| {
        catalog_rank(&left.file)
            .cmp(&catalog_rank(&right.file))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    models
}

fn catalog_rank(file: &str) -> usize {
    CATALOG
        .iter()
        .position(|spec| spec.filename.eq_ignore_ascii_case(file))
        .unwrap_or(usize::MAX)
}

/// `qwen2.5-1.5b-instruct-q4_k_m.gguf` -> `qwen2.5-1.5b-instruct-q4_k_m`.
pub fn model_display_name(file_name: &str) -> String {
    Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(file_name)
        .to_string()
}

pub fn is_gguf_file(file_name: &str) -> bool {
    Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("gguf"))
        .unwrap_or(false)
}

/// Validates a model file name supplied by the UI before it touches the disk.
///
/// Only a plain, single-component `.gguf` file name inside the models directory
/// is accepted: no separators, no drive prefixes, no wildcards, no traversal.
pub fn clean_model_file_name(file: &str) -> Result<String, EngineError> {
    let name = file.trim();
    if name.is_empty() {
        return Err(EngineError::new(
            "未指定模型文件名。",
            "请刷新模型列表后重试。",
        ));
    }
    if name == "." || name == ".." || name.starts_with('.') {
        return Err(EngineError::new(
            "模型文件名无效。",
            "只能删除模型目录内的 GGUF 文件。",
        ));
    }
    if name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\0']) {
        return Err(EngineError::new(
            "模型文件名包含非法字符。",
            "只能删除模型目录内的 GGUF 文件，不能包含路径。",
        ));
    }
    if !is_gguf_file(name) {
        return Err(EngineError::new(
            "只能删除 .gguf 模型文件。",
            "请在模型列表中操作，避免误删其他文件。",
        ));
    }
    let path = Path::new(name);
    if path.file_name().and_then(|part| part.to_str()) != Some(name) {
        return Err(EngineError::new(
            "模型文件名无效。",
            "只能删除模型目录内的 GGUF 文件。",
        ));
    }
    Ok(name.to_string())
}

/// Returns a non-colliding file name inside `dir`, appending ` (1)`, ` (2)`…
pub fn dedupe_filename(dir: &Path, file_name: &str) -> String {
    if !dir.join(file_name).exists() {
        return file_name.to_string();
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file_name);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("gguf");
    for index in 1..=9_999u32 {
        let candidate = format!("{stem} ({index}).{extension}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem} (copy).{extension}")
}

/// Human readable size used in Chinese error messages ("1.04 GB").
pub fn format_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    let value = bytes as f64;
    if value >= GB {
        trim_zeros(format!("{:.2}", value / GB)) + " GB"
    } else if value >= MB {
        trim_zeros(format!("{:.1}", value / MB)) + " MB"
    } else if value >= KB {
        trim_zeros(format!("{:.1}", value / KB)) + " KB"
    } else {
        format!("{bytes} B")
    }
}

fn trim_zeros(text: String) -> String {
    if text.contains('.') {
        let trimmed = text.trim_end_matches('0').trim_end_matches('.').to_string();
        if trimmed.is_empty() {
            "0".to_string()
        } else {
            trimmed
        }
    } else {
        text
    }
}

/// Returns the `.part` staging path for a download inside the cache directory.
pub fn part_path(cache_dir: &Path, file_name: &str) -> PathBuf {
    cache_dir.join(format!("{file_name}.part"))
}

/// Validates that a file starts with the GGUF magic before importing it.
pub fn looks_like_gguf(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).is_ok() && &magic == b"GGUF"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_contract() {
        assert_eq!(CATALOG.len(), 6);
        assert!(spec_by_id("hy-mt2-1.8b").is_none());
        for (spec, expected_size) in CATALOG.iter().zip([
            532_517_120,
            470_167_808,
            1_280_835_840,
            1_107_149_056,
            2_740_937_888,
            2_293_388_448,
        ]) {
            assert_eq!(spec.size_bytes, expected_size);
        }
        let mut filenames = std::collections::HashSet::new();
        for spec in &CATALOG {
            assert!(filenames.insert(spec.filename));
            assert!(spec.hf_url.is_empty());
            assert!(spec.modelscope_url.ends_with(spec.filename));
            assert_eq!(download_urls(spec), vec![spec.modelscope_url]);
            if spec.vision {
                let projector = spec.mmproj.unwrap();
                assert!(projector
                    .modelscope_url
                    .ends_with(projector.remote_filename));
                assert!(projector.hf_url.is_empty());
                assert_eq!(
                    mmproj_download_urls(&projector),
                    vec![projector.modelscope_url]
                );
            }
        }
        assert_eq!(CATALOG.iter().filter(|spec| spec.vision).count(), 6);
        assert_ne!(
            CATALOG[1].mmproj.unwrap().filename,
            CATALOG[3].mmproj.unwrap().filename
        );
    }

    #[test]
    fn spec_lookup_matches_case_insensitively() {
        assert_eq!(
            spec_by_filename("Hy-MT2-1.8B-Q4_K_M.gguf").map(|spec| spec.id),
            None
        );
        assert_eq!(
            spec_by_filename("QWEN3.5-0.8B-Q4_K_M.GGUF").map(|spec| spec.id),
            Some("qwen3.5-0.8b-q4-k-m")
        );
        assert_eq!(
            spec_by_filename("Qwen3.5-0.8B-Q3_K_M.gguf").map(|spec| spec.id),
            Some("qwen3.5-0.8b-q3-k-m")
        );
        // The projector is never resolved as a standalone model.
        assert!(spec_by_filename("mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf").is_none());
        assert!(spec_by_id("unknown").is_none());
        assert_eq!(catalog_id_for("custom.gguf"), "");
        assert_eq!(
            catalog_id_for("mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf"),
            ""
        );
    }

    #[test]
    fn scan_finds_gguf_models_and_ignores_others() {
        let dir = tempfile::TempDir::new().unwrap();
        let models_dir = dir.path();
        fs::write(models_dir.join(CATALOG[0].filename), b"gguf-one").unwrap();
        fs::write(models_dir.join("my-custom-model.gguf"), b"custom").unwrap();
        fs::write(models_dir.join("notes.txt"), b"not a model").unwrap();
        // The vision projector must never be listed as an independent model.
        fs::write(
            models_dir.join("mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf"),
            b"projector",
        )
        .unwrap();
        fs::write(models_dir.join("MMPROJ-other.gguf"), b"projector").unwrap();
        fs::create_dir(models_dir.join("sub.gguf")).unwrap();

        let models = scan_models(models_dir);
        assert_eq!(models.len(), 2);
        // Catalog models are listed before imported ones.
        assert_eq!(models[0].file, CATALOG[0].filename);
        assert_eq!(models[0].catalog_id, CATALOG[0].id);
        assert_eq!(models[0].size_bytes, 8);
        assert_eq!(
            models[0].name,
            CATALOG[0].filename.trim_end_matches(".gguf")
        );
        assert!(models[0].modified_at > 0);
        assert_eq!(models[1].file, "my-custom-model.gguf");
        assert_eq!(models[1].catalog_id, "");
        assert!(
            models.iter().all(|model| !is_mmproj_file(&model.file)),
            "projector files must be filtered out: {models:?}"
        );
    }

    #[test]
    fn legacy_translation_model_is_a_custom_residual() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = "Hy-MT2-1.8B-Q4_K_M.gguf";
        fs::write(dir.path().join(file), b"legacy").unwrap();
        let models = scan_models(dir.path());
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].file, file);
        assert!(models[0].catalog_id.is_empty());
        assert!(dir.path().join(file).is_file());
    }

    #[test]
    fn scan_missing_directory_is_empty() {
        assert!(scan_models(Path::new("E:\\definitely-missing-dir-lexora")).is_empty());
    }

    #[test]
    fn catalog_marks_installed_files() {
        let dir = tempfile::TempDir::new().unwrap();
        fs::write(dir.path().join(CATALOG[1].filename), b"x").unwrap();
        let entries = catalog_entries(dir.path());
        assert_eq!(entries.len(), 6);
        assert!(!entries[0].installed);
        assert!(!entries[1].installed);
        assert_eq!(entries[1].id, "qwen3.5-0.8b-q3-k-m");
        assert_eq!(entries[1].license, "Apache-2.0");
        assert!(entries[1].vision);
        assert_eq!(entries[2].id, "qwen3.5-2b-q4-k-m");
        assert!(entries[2].vision);
    }

    #[test]
    fn vision_catalog_entry_requires_weights_and_projector() {
        let dir = tempfile::TempDir::new().unwrap();
        let spec = &CATALOG[2];
        let mmproj = spec.mmproj.expect("vision model must ship a projector");

        // Weights alone are not enough: llama.cpp cannot see images without
        // the projector, so the entry stays "not installed".
        fs::write(dir.path().join(spec.filename), b"weights").unwrap();
        let entries = catalog_entries(dir.path());
        assert!(!entries[2].installed);

        // Adding the projector completes the installation.
        fs::write(dir.path().join(mmproj.filename), b"projector").unwrap();
        let entries = catalog_entries(dir.path());
        assert!(entries[2].installed);
        // The projector itself never shows up as an installed model.
        assert!(scan_models(dir.path())
            .iter()
            .all(|model| { model.file.eq_ignore_ascii_case(spec.filename) }));
    }

    #[test]
    fn mmproj_files_are_detected_case_insensitively() {
        assert!(is_mmproj_file("mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf"));
        assert!(is_mmproj_file("MMPROJ-model.gguf"));
        assert!(is_mmproj_file("  mmproj-model.gguf"));
        assert!(!is_mmproj_file("Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf"));
        assert!(!is_mmproj_file("Qwen2.5-3B-Instruct-Q4_K_M.gguf"));
        assert!(!is_mmproj_file(""));
    }

    #[test]
    fn clean_model_file_name_rejects_traversal() {
        assert!(clean_model_file_name("model.gguf").is_ok());
        for bad in [
            "",
            "..",
            ".",
            "../model.gguf",
            "..\\model.gguf",
            "sub/model.gguf",
            "sub\\model.gguf",
            "C:\\model.gguf",
            "model.txt",
            "a:b.gguf",
        ] {
            assert!(
                clean_model_file_name(bad).is_err(),
                "expected rejection for {bad:?}"
            );
        }
    }

    #[test]
    fn dedupe_filename_appends_counter() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(dedupe_filename(dir.path(), "a.gguf"), "a.gguf");
        fs::write(dir.path().join("a.gguf"), b"x").unwrap();
        assert_eq!(dedupe_filename(dir.path(), "a.gguf"), "a (1).gguf");
        fs::write(dir.path().join("a (1).gguf"), b"x").unwrap();
        assert_eq!(dedupe_filename(dir.path(), "a.gguf"), "a (2).gguf");
    }

    #[test]
    fn format_size_is_readable() {
        assert_eq!(format_size(512), "512 B");
        assert_eq!(format_size(1_117_320_736), "1.04 GB");
        assert_eq!(format_size(23_100_000), "22 MB");
    }

    #[test]
    fn gguf_magic_is_checked() {
        let dir = tempfile::TempDir::new().unwrap();
        let good = dir.path().join("good.gguf");
        fs::write(&good, b"GGUF\x03\x00").unwrap();
        assert!(looks_like_gguf(&good));
        let bad = dir.path().join("bad.gguf");
        fs::write(&bad, b"not a model").unwrap();
        assert!(!looks_like_gguf(&bad));
        assert!(!looks_like_gguf(&dir.path().join("missing.gguf")));
    }
}
