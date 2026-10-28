//! Application state shared by all Tauri commands.
//!
//! Everything here is `Send + Sync` so the state can be cloned into the async
//! runtime tasks spawned for translation streams and downloads.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::capture::CaptureService;
use crate::engine::EngineService;
use crate::logger::Logger;
use crate::paths::AppPaths;
use crate::selection::SelectionService;
use crate::settings::SettingsStore;

/// Handle of the translation task currently streaming into the picker.
///
/// Only one stream may run at a time: a new `picker_translate` aborts the
/// previous task so stale chunks can never interleave with a new request.
pub struct TranslateTask {
    pub request_id: String,
    pub handle: tauri::async_runtime::JoinHandle<()>,
}

pub struct AppState {
    pub paths: AppPaths,
    pub log: Logger,
    pub settings: Arc<SettingsStore>,
    pub engine: Arc<EngineService>,
    pub selection: SelectionService,
    /// Screenshot sessions + overlay windows (xcap/OCR/vision).
    pub capture: CaptureService,
    pub translate_task: Mutex<Option<TranslateTask>>,
    pub started_at: std::time::Instant,
    /// Set when the process is shutting down, so late UI events are skipped.
    pub quitting: AtomicBool,
}

impl AppState {
    pub fn new(paths: AppPaths, log: Logger) -> Arc<Self> {
        // Directory failures must not prevent command state registration.
        for dir in [
            &paths.data_dir,
            &paths.models_dir,
            &paths.engine_dir,
            &paths.logs_dir,
            &paths.cache_dir,
        ] {
            if let Err(error) = std::fs::create_dir_all(dir) {
                log.warn(&format!(
                    "startup directory unavailable: {}: {error}",
                    dir.display()
                ));
            }
        }
        let settings = Arc::new(SettingsStore::load(paths.settings_file.clone()));
        let engine = Arc::new(EngineService::new(
            paths.clone(),
            settings.clone(),
            log.clone(),
        ));
        let selection = SelectionService::new(settings.clone(), log.clone());
        Arc::new(Self {
            paths,
            log,
            settings,
            engine,
            selection,
            capture: CaptureService::new(),
            translate_task: Mutex::new(None),
            started_at: std::time::Instant::now(),
            quitting: AtomicBool::new(false),
        })
    }

    /// Called by setup only after the single-instance plugin accepts this process.
    pub fn persist_initial_settings(&self) -> Result<(), String> {
        self.settings
            .persist_initial_settings()
            .inspect_err(|error| {
                self.log.warn(&format!(
                    "startup settings could not be persisted; using in-memory settings: {error}"
                ));
            })
    }

    pub fn data_dir(&self) -> PathBuf {
        self.paths.data_dir.clone()
    }

    /// Aborts the running translation stream, if any.
    pub fn abort_translate(&self) {
        let mut guard = lock(&self.translate_task);
        if let Some(task) = guard.take() {
            task.handle.abort();
            self.log.info(&format!(
                "translation stream aborted: request={}",
                task.request_id
            ));
        }
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::Acquire)
    }

    pub fn set_quitting(&self) {
        self.quitting.store(true, Ordering::Release);
    }
}

/// Locks a mutex, recovering the value if a panic poisoned it.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(root: &std::path::Path) -> AppPaths {
        AppPaths {
            data_dir: root.to_path_buf(),
            settings_file: root.join("settings.json"),
            models_dir: root.join("models"),
            engine_dir: root.join("engine"),
            logs_dir: root.join("logs"),
            cache_dir: root.join("cache"),
        }
    }

    #[test]
    fn fresh_state_can_be_registered_before_any_app_or_window_exists() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths(&temp.path().join("fresh"));
        assert!(!paths.data_dir.exists());
        let log = Logger::new(&paths.logs_dir, "main");
        let state = AppState::new(paths.clone(), log);
        assert!(!paths.settings_file.exists());
        assert!(!paths.settings_file.with_extension("json.tmp").exists());
        state.persist_initial_settings().unwrap();
        assert!(paths.settings_file.is_file());
        assert!(paths.models_dir.is_dir());
        assert!(paths.engine_dir.is_dir());
        assert!(!state.engine.engine_installed());
        // Compile against the exact command state type without building a GUI.
        let _: tauri::Builder<tauri::Wry> = tauri::Builder::default().manage(state.clone());
        let reopened = AppState::new(paths.clone(), state.log.clone());
        assert_eq!(reopened.settings.get(), state.settings.get());
    }

    #[test]
    fn loading_existing_or_malformed_settings_never_writes() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths(temp.path());
        let log = Logger::new(&paths.logs_dir, "main");
        for contents in [r#"{"version":1}"#, "invalid json"] {
            std::fs::write(&paths.settings_file, contents).unwrap();
            let before = std::fs::metadata(&paths.settings_file)
                .unwrap()
                .modified()
                .unwrap();
            // A second process may construct state but never reaches setup.
            let _state = AppState::new(paths.clone(), log.clone());
            assert_eq!(
                std::fs::read_to_string(&paths.settings_file).unwrap(),
                contents
            );
            assert_eq!(
                std::fs::metadata(&paths.settings_file)
                    .unwrap()
                    .modified()
                    .unwrap(),
                before
            );
            assert!(!paths.settings_file.with_extension("json.tmp").exists());
            assert!(!paths.settings_file.with_extension("json.broken").exists());
        }
    }

    #[cfg(windows)]
    #[test]
    fn existing_file_replacement_failure_is_returned_and_logged() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let paths = paths(temp.path());
        std::fs::write(&paths.settings_file, "{}").unwrap();
        // Allow reads, but deny replacement of an existing file deterministically.
        let _held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&paths.settings_file)
            .unwrap();
        let log = Logger::new(&paths.logs_dir, "main");
        let state = AppState::new(paths.clone(), log.clone());
        let error = state.persist_initial_settings().unwrap_err();
        assert!(error.contains("保存设置失败"));
        assert_eq!(std::fs::read_to_string(&paths.settings_file).unwrap(), "{}");
        let output = std::fs::read_to_string(log.path()).unwrap();
        assert!(output.contains("WARN"));
        assert!(output.contains("startup settings could not be persisted"));
        assert!(output.contains(&error));
    }

    #[test]
    fn production_entry_registers_state_before_windows_and_persists_only_in_setup() {
        let source = include_str!("main.rs");
        let identity = source.find("let notification_process_identity =").unwrap();
        let load = source
            .find("let state = AppState::new(paths, log)")
            .unwrap();
        let manage = source.find(".manage(state)").unwrap();
        let single = source
            .find(".plugin(tauri_plugin_single_instance::init")
            .unwrap();
        let setup = source.find(".setup(move |app|").unwrap();
        let persist = source
            .find("let _ = state.persist_initial_settings()")
            .unwrap();
        let services = source.find("state.selection.start(").unwrap();
        assert!(identity < load && load < manage && manage < single);
        assert!(single < setup && setup < persist && persist < services);
    }

    #[test]
    fn unavailable_directories_do_not_prevent_state_construction() {
        let temp = tempfile::tempdir().unwrap();
        let blocked = temp.path().join("file");
        std::fs::write(&blocked, b"blocked").unwrap();
        let paths = paths(&blocked);
        let log = Logger::new(&temp.path().join("logs"), "main");
        let state = AppState::new(paths, log.clone());
        assert!(!state.is_quitting());
        assert!(state.persist_initial_settings().is_err());
        let output = std::fs::read_to_string(log.path()).unwrap();
        assert!(output.contains("startup directory unavailable"));
        assert!(output.contains("settings could not be persisted"));
    }
}
