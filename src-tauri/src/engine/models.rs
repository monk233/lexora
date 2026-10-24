//! Local GGUF model catalog, directory scanning and filename helpers.
//!
//! The catalog is a compile-time constant so the settings UI always has a stable
//! list of downloadable models, even offline. LingoPick offers exactly two
//! models: a translation-specialised Tencent Hunyuan Hy-MT2 and a general-purpose
//! Qwen2.5 3B. `tests` in this module guard against accidental edits that would
//! break a download.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::engine::{CatalogEntry, EngineError, ModelInfo};

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
}

/// The two local models offered by LingoPick: one translation-specialised
/// (Hy-MT2) and one general-purpose (Qwen2.5 3B). `hf_url` may be empty when the
/// model is only distributed through ModelScope.
pub const CATALOG: [ModelSpec; 2] = [
    ModelSpec {
        id: "hy-mt2-1.8b",
        name: "腾讯混元 Hy-MT2 1.8B（翻译模型）",
        description: "翻译专用：混元 Hy-MT2 1.8B Q4_K_M，速度快，适合中英及多语互译",
        filename: "Hy-MT2-1.8B-Q4_K_M.gguf",
        size_bytes: 1_133_080_448,
        license: "Apache-2.0",
        languages: "多语言",
        recommended: true,
        hf_url: "",
        modelscope_url: "https://www.modelscope.cn/models/liaowenbin/Hy-MT2-1.8B-Q4_K_M-GGUF/resolve/master/Hy-MT2-1.8B-Q4_K_M.gguf",
    },
    ModelSpec {
        id: "qwen2.5-3b",
        name: "Qwen2.5 3B（通用模型）",
        description: "通用模型：翻译、总结、解释都能用；适合内存 16GB 以上的电脑",
        filename: "qwen2.5-3b-instruct-q4_k_m.gguf",
        size_bytes: 2_104_932_768,
        license: "Apache-2.0",
        languages: "多语言",
        recommended: false,
        hf_url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
        modelscope_url: "https://www.modelscope.cn/models/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/master/qwen2.5-3b-instruct-q4_k_m.gguf",
    },
];

/// Files larger than this are rejected on import (the FLINT const keeps the
/// comparison lossless on 32-bit builds; LingoPick ships 64-bit only).
pub const MAX_IMPORT_BYTES: u64 = 4 * 1024 * 1024 * 1024;

pub fn spec_by_id(id: &str) -> Option<&'static ModelSpec> {
    let wanted = id.trim();
    CATALOG.iter().find(|spec| spec.id == wanted)
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
pub fn catalog_entries(models_dir: &Path) -> Vec<CatalogEntry> {
    CATALOG
        .iter()
        .map(|spec| CatalogEntry {
            id: spec.id.to_string(),
            name: spec.name.to_string(),
            description: spec.description.to_string(),
            filename: spec.filename.to_string(),
            size_bytes: spec.size_bytes,
            license: spec.license.to_string(),
            languages: spec.languages.to_string(),
            recommended: spec.recommended,
            installed: models_dir.join(spec.filename).is_file(),
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
    fn catalog_has_one_translation_and_one_general_model() {
        assert_eq!(CATALOG.len(), 2);
        assert_eq!(CATALOG[0].id, "hy-mt2-1.8b");
        assert_eq!(CATALOG[1].id, "qwen2.5-3b");
        let recommended: Vec<&str> = CATALOG
            .iter()
            .filter(|spec| spec.recommended)
            .map(|spec| spec.id)
            .collect();
        assert_eq!(recommended, vec!["hy-mt2-1.8b"]);
    }

    #[test]
    fn catalog_sizes_and_urls_are_complete() {
        let mut filenames = Vec::new();
        for spec in CATALOG.iter() {
            assert!(spec.size_bytes > 400_000_000);
            assert!(spec.filename.ends_with(".gguf"));
            assert!(!spec.license.is_empty());
            assert!(!spec.languages.is_empty());
            assert!(spec
                .modelscope_url
                .starts_with("https://www.modelscope.cn/models/"));
            assert!(spec.modelscope_url.ends_with(spec.filename));
            assert!(spec.modelscope_url.contains("/resolve/master/"));
            // Empty HF URL means ModelScope is the only source.
            if !spec.hf_url.is_empty() {
                assert!(spec.hf_url.starts_with("https://huggingface.co/"));
                assert!(spec.hf_url.ends_with(spec.filename));
                assert!(spec.hf_url.contains("/resolve/main/"));
            }
            assert!(!filenames.contains(&spec.filename));
            filenames.push(spec.filename);
        }
        assert_eq!(CATALOG[0].size_bytes, 1_133_080_448);
        assert_eq!(CATALOG[1].size_bytes, 2_104_932_768);
        // Hy-MT2 is only distributed through ModelScope.
        assert!(CATALOG[0].hf_url.is_empty());
    }

    #[test]
    fn spec_lookup_matches_case_insensitively() {
        assert_eq!(
            spec_by_filename("Hy-MT2-1.8B-Q4_K_M.gguf").map(|spec| spec.id),
            Some("hy-mt2-1.8b")
        );
        assert_eq!(
            spec_by_filename("Qwen2.5-3B-Instruct-Q4_K_M.GGUF").map(|spec| spec.id),
            Some("qwen2.5-3b")
        );
        assert!(spec_by_id("unknown").is_none());
        assert_eq!(catalog_id_for("custom.gguf"), "");
    }

    #[test]
    fn scan_finds_gguf_models_and_ignores_others() {
        let dir = tempfile::TempDir::new().unwrap();
        let models_dir = dir.path();
        fs::write(models_dir.join(CATALOG[0].filename), b"gguf-one").unwrap();
        fs::write(models_dir.join("my-custom-model.gguf"), b"custom").unwrap();
        fs::write(models_dir.join("notes.txt"), b"not a model").unwrap();
        fs::create_dir(models_dir.join("sub.gguf")).unwrap();

        let models = scan_models(models_dir);
        assert_eq!(models.len(), 2);
        // Catalog models are listed before imported ones.
        assert_eq!(models[0].file, CATALOG[0].filename);
        assert_eq!(models[0].catalog_id, "hy-mt2-1.8b");
        assert_eq!(models[0].size_bytes, 8);
        assert_eq!(models[0].name, "Hy-MT2-1.8B-Q4_K_M");
        assert!(models[0].modified_at > 0);
        assert_eq!(models[1].file, "my-custom-model.gguf");
        assert_eq!(models[1].catalog_id, "");
    }

    #[test]
    fn scan_missing_directory_is_empty() {
        assert!(scan_models(Path::new("E:\\definitely-missing-dir-lingopick")).is_empty());
    }

    #[test]
    fn catalog_marks_installed_files() {
        let dir = tempfile::TempDir::new().unwrap();
        fs::write(dir.path().join(CATALOG[1].filename), b"x").unwrap();
        let entries = catalog_entries(dir.path());
        assert_eq!(entries.len(), 2);
        assert!(entries[0].installed == false);
        assert!(entries[1].installed);
        assert_eq!(entries[1].id, "qwen2.5-3b");
        assert_eq!(entries[1].license, "Apache-2.0");
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
