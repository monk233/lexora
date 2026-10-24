//! Application data paths.
//!
//! Lexora is a portable Windows app: by default it keeps everything next to
//! the executable (``<exe dir>\\data``) so a zip can be moved around without
//! leaving traces in %APPDATA%. If that directory is not writable (Program
//! Files, read-only share) it falls back to ``%APPDATA%\\Lexora``.

use std::path::{Path, PathBuf};

/// Environment override for the whole data directory (tests, dev harnesses).
pub const ENV_DATA_DIR: &str = "LEXORA_DATA_DIR";
/// Environment override for the GGUF model directory.
pub const ENV_MODEL_DIR: &str = "LEXORA_MODEL_DIR";
/// Environment override for the llama.cpp engine directory.
pub const ENV_LLAMA_DIR: &str = "LEXORA_LLAMA_DIR";

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub models_dir: PathBuf,
    pub engine_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub settings_file: PathBuf,
}

impl AppPaths {
    /// Resolves and creates all directories needed by the app.
    pub fn resolve() -> Self {
        let data_dir = resolve_data_dir();
        let models_dir = std::env::var_os(ENV_MODEL_DIR)
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("models"));
        let engine_dir = std::env::var_os(ENV_LLAMA_DIR)
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("engine"));
        let logs_dir = data_dir.join("logs");
        let cache_dir = data_dir.join("cache");

        let paths = Self {
            settings_file: data_dir.join("settings.json"),
            data_dir,
            models_dir,
            engine_dir,
            logs_dir,
            cache_dir,
        };
        paths.ensure_dirs();
        paths
    }

    pub fn ensure_dirs(&self) {
        for dir in [
            &self.data_dir,
            &self.models_dir,
            &self.engine_dir,
            &self.logs_dir,
            &self.cache_dir,
        ] {
            let _ = std::fs::create_dir_all(dir);
        }
    }

    pub fn llama_binary(&self) -> PathBuf {
        self.engine_dir.join("llama-server.exe")
    }

    pub fn engine_installed(&self) -> bool {
        self.llama_binary().is_file()
    }
}

fn resolve_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os(ENV_DATA_DIR) {
        return PathBuf::from(dir);
    }
    if cfg!(debug_assertions) {
        if let Some(project_root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            return project_root.join("data");
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let candidate = exe_dir.join("data");
            if dir_is_writable(exe_dir) {
                return candidate;
            }
        }
    }
    appdata_dir()
}

fn appdata_dir() -> PathBuf {
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return PathBuf::from(appdata).join("Lexora");
    }
    std::env::temp_dir().join("Lexora")
}

fn dir_is_writable(dir: &Path) -> bool {
    let probe = dir.join(".lexora-write-test");
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}
