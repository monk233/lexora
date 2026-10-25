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
