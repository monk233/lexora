//! Global selection monitoring (low-level input hooks + UI Automation capture).
//!
//! The service owns three background threads:
//!
//! * the `rdev` hook thread — no stop API exists, so it lives for the whole
//!   process and the `picker.enabled` flag gates every trigger;
//! * a capture worker that reads the selection through UI Automation behind a
//!   watchdog, applies the filters and asks `windows::show_picker` to display
//!   the toolbar;
//! * a small action worker that hides the picker when the user clicks outside
//!   of its window.
//!
//! The hook callback only updates a local state machine and forwards work
//! through channels, keeping it far below the ~300 ms low-level hook budget.
//! Clipboard fallback is intentionally not implemented (the product decision is
//! UIA only), and this module never injects input events, so rdev cannot see its
//! own events.

mod hook;
mod uia;
mod win;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Manager;

use crate::logger::Logger;
use crate::settings::{Settings, SettingsStore};

/// Window label of the toolbar, see `tauri.conf.json`.
const PICKER_LABEL: &str = "picker";
/// Captures of the same text inside this window are considered duplicates.
const DUPLICATE_WINDOW: Duration = Duration::from_millis(400);
/// Triggers older than this are dropped: the user has moved on already.
const STALE_TRIGGER: Duration = Duration::from_secs(3);
/// Minimum interval between two capture failure log lines.
const ERROR_LOG_INTERVAL: Duration = Duration::from_secs(3);

/// Payload pushed to the picker webview when a selection is captured.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerPayload {
    pub text: String,
    pub program_name: String,
    /// Physical pixels: mouse position at release (or selection end).
    pub anchor_x: i32,
    pub anchor_y: i32,
    /// DPI scale of the monitor containing the anchor.
    pub scale_factor: f64,
    pub config: serde_json::Value,
}

/// Where a capture was triggered from; only used for logging.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TriggerSource {
    Mouse,
    /// Multi-click (double/triple click) selection, not a drag.
    Click,
}

impl TriggerSource {
    fn label(self) -> &'static str {
        match self {
            TriggerSource::Mouse => "鼠标拖选",
            TriggerSource::Click => "鼠标多击选词",
        }
    }
}

/// Work item handed from the hook thread to the capture worker.
struct CaptureRequest {
    source: TriggerSource,
    /// Physical anchor (release point); `None` means "current cursor position".
    anchor: Option<(i32, i32)>,
    at: Instant,
}

/// Work item handed from the hook thread to the picker action worker.
enum ActionRequest {
    /// Left button pressed outside of the picker: hide it unless pinned.
    OutsideClick { x: i32, y: i32 },
    /// The user pressed a key / scrolled / clicked another button while the
    /// toolbar was visible: the toolbar is an auxiliary overlay and must not
    /// get in the way of normal work, so it disappears.
    DismissOnInput { reason: &'static str },
}

/// Settings-derived data used by the capture worker. Replaced atomically on
/// `apply_settings`, so the hook thread never needs to restart.
#[derive(Clone)]
struct WorkerConfig {
    /// Normalized (lower case, no `.exe`) process names.
    blacklist: Vec<String>,
    /// `PickerData.config` as defined by contract §5.5.
    picker_config: serde_json::Value,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            blacklist: Vec::new(),
            picker_config: serde_json::Value::Null,
        }
    }
}

/// State shared between the service handle and the worker threads.
struct Inner {
    logger: Logger,
    own_pid: u32,
    /// Normalized image name of this executable, e.g. `lexora`.
    own_program: String,
    app: OnceLock<tauri::AppHandle>,
    capture_tx: Mutex<Option<Sender<CaptureRequest>>>,
    action_tx: Mutex<Option<Sender<ActionRequest>>>,
    enabled: AtomicBool,
    worker_config: Mutex<WorkerConfig>,
    picker_visible: AtomicBool,
    panel_pinned: AtomicBool,
    /// A result panel is open: the global input hook must not dismiss the
    /// picker (sticky panel), even when it is not pinned.
    panel_open: AtomicBool,
    capturing: AtomicBool,
    started: AtomicBool,
    last_selection: Mutex<Option<PickerPayload>>,
    dedup: Mutex<TextDedup>,
    last_error_log: Mutex<Option<Instant>>,
}

impl Inner {
    fn config(&self) -> WorkerConfig {
        lock(&self.worker_config).clone()
    }

    /// Queues a capture request. Triggers fired while a capture is already
    /// running are dropped on purpose (contract §6.2).
    fn send_capture(&self, source: TriggerSource, anchor: Option<(i32, i32)>) {
        if self.capturing.load(Ordering::Acquire) {
            return;
        }
        let sender = lock(&self.capture_tx).as_ref().cloned();
        if let Some(sender) = sender {
            let request = CaptureRequest {
                source,
                anchor,
                at: Instant::now(),
            };
            let _ = sender.send(request);
        }
    }

    fn send_action(&self, action: ActionRequest) {
        let sender = lock(&self.action_tx).as_ref().cloned();
        if let Some(sender) = sender {
            let _ = sender.send(action);
        }
    }

    fn is_duplicate(&self, text: &str) -> bool {
        lock(&self.dedup).should_skip(text, Instant::now(), DUPLICATE_WINDOW)
    }

    /// Capture errors are expected for non-text applications; throttle them so
    /// a user clicking around cannot flood the log file.
    fn log_capture_failure(&self, message: &str) {
        let now = Instant::now();
        let should_log = {
            let mut slot = lock(&self.last_error_log);
            let should_log = (*slot)
                .map(|at| now.saturating_duration_since(at) >= ERROR_LOG_INTERVAL)
                .unwrap_or(true);
            if should_log {
                *slot = Some(now);
            }
            should_log
        };
        if should_log {
            self.logger.warn(&format!("取词失败：{message}"));
        }
    }
}

/// Service handle stored in `AppState`.
pub struct SelectionService {
    settings: Arc<SettingsStore>,
    inner: Arc<Inner>,
}

impl SelectionService {
    pub fn new(settings: Arc<SettingsStore>, logger: Logger) -> Self {
        let own_pid = std::process::id();
        let own_program = std::env::current_exe()
            .ok()
            .and_then(|path| {
                path.file_name()
                    .map(|name| normalize_program_name(&name.to_string_lossy()))
            })
            .unwrap_or_default();
        let inner = Arc::new(Inner {
            logger,
            own_pid,
            own_program,
            app: OnceLock::new(),
            capture_tx: Mutex::new(None),
            action_tx: Mutex::new(None),
            enabled: AtomicBool::new(true),
            worker_config: Mutex::new(WorkerConfig::default()),
            picker_visible: AtomicBool::new(false),
            panel_pinned: AtomicBool::new(false),
            panel_open: AtomicBool::new(false),
            capturing: AtomicBool::new(false),
            started: AtomicBool::new(false),
            last_selection: Mutex::new(None),
            dedup: Mutex::new(TextDedup::default()),
            last_error_log: Mutex::new(None),
        });
        let service = Self { settings, inner };
        service.apply_settings(&service.settings.get());
        service
    }

    /// Starts the hook and worker threads. Safe to call only once; later calls
    /// are ignored.
    pub fn start(&self, app: tauri::AppHandle) {
        if self.inner.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.inner.app.set(app);

        let (capture_tx, capture_rx) = mpsc::channel::<CaptureRequest>();
        let (action_tx, action_rx) = mpsc::channel::<ActionRequest>();
        *lock(&self.inner.capture_tx) = Some(capture_tx);
        *lock(&self.inner.action_tx) = Some(action_tx);

        let capture_inner = self.inner.clone();
        if let Err(error) = thread::Builder::new()
            .name("lexora-capture".to_string())
            .spawn(move || capture_worker(capture_inner, capture_rx))
        {
            self.inner
                .logger
                .error(&format!("无法启动取词工作线程：{error}"));
        }

        let action_inner = self.inner.clone();
        if let Err(error) = thread::Builder::new()
            .name("lexora-picker-action".to_string())
            .spawn(move || action_worker(action_inner, action_rx))
        {
            self.inner
                .logger
                .error(&format!("无法启动 picker 动作线程：{error}"));
        }

        hook::start(self.inner.clone());
        self.inner
            .logger
            .info("划词服务已启动（全局钩子 + UI Automation 取词）");
    }

    /// Applies settings changes without restarting the hook (hot reload).
    pub fn apply_settings(&self, settings: &Settings) {
        let picker = &settings.picker;
        self.inner.enabled.store(picker.enabled, Ordering::Release);
        *lock(&self.inner.worker_config) = config_from_settings(settings);

        self.inner.logger.info(&format!(
            "划词设置已应用：启用={}，黑名单={} 项",
            picker.enabled,
            picker.blacklist.len()
        ));
    }

    /// State pushed by the picker window so outside clicks can be detected.
    pub fn set_picker_visible(&self, visible: bool) {
        self.inner.picker_visible.store(visible, Ordering::Release);
        if !visible {
            self.inner.panel_pinned.store(false, Ordering::Release);
            self.inner.panel_open.store(false, Ordering::Release);
        }
    }

    pub fn set_panel_pinned(&self, pinned: bool) {
        self.inner.panel_pinned.store(pinned, Ordering::Release);
    }

    /// Marks whether a tool panel is currently open. While open, keyboard and
    /// right/middle mouse input no longer dismiss the picker; clicking outside
    /// of an un-pinned picker still hides it.
    pub fn set_panel_open(&self, open: bool) {
        self.inner.panel_open.store(open, Ordering::Release);
    }

    pub fn is_panel_open(&self) -> bool {
        self.inner.panel_open.load(Ordering::Acquire)
    }

    pub fn last_selection(&self) -> Option<PickerPayload> {
        lock(&self.inner.last_selection).as_ref().cloned()
    }

    /// Takes the last payload; lets `picker_ready` re-send a selection that was
    /// captured before the webview finished loading.
    pub fn take_pending(&self) -> Option<PickerPayload> {
        lock(&self.inner.last_selection).take()
    }

    pub fn is_panel_pinned(&self) -> bool {
        self.inner.panel_pinned.load(Ordering::Acquire)
    }
}

fn capture_worker(inner: Arc<Inner>, receiver: Receiver<CaptureRequest>) {
    while let Ok(request) = receiver.recv() {
        if request.at.elapsed() > STALE_TRIGGER {
            continue;
        }
        if !inner.enabled.load(Ordering::Acquire) {
            continue;
        }
        if inner.capturing.swap(true, Ordering::AcqRel) {
            // Defensive: only this worker captures, so this is unreachable.
            continue;
        }
        let result = process_capture(&inner, &request);
        inner.capturing.store(false, Ordering::Release);
        if let Err(message) = result {
            // "Nothing selected" happens on every drag across non-text content;
            // it is a normal outcome, not a failure worth a log line.
            if message != "没有选中文本" {
                inner.log_capture_failure(&message);
            }
        }
    }
}

fn process_capture(inner: &Arc<Inner>, request: &CaptureRequest) -> Result<(), String> {
    let anchor = request.anchor.unwrap_or_else(crate::win32::cursor_physical);
    let Some(app) = inner.app.get() else {
        return Err("划词服务尚未初始化（缺少 AppHandle）".to_string());
    };

    // Selecting text inside our own toolbar must not start a nested capture.
    if picker_contains_point(app, anchor.0, anchor.1) {
        return Ok(());
    }

    let (foreground_pid, foreground_program) = win::foreground_process();
    if foreground_pid != 0 && foreground_pid == inner.own_pid {
        return Ok(());
    }
    if is_own_program(&foreground_program, &inner.own_program) {
        return Ok(());
    }

    let config = inner.config();
    if is_blacklisted(&foreground_program, &config.blacklist) {
        inner
            .logger
            .info(&format!("忽略黑名单应用中的划词：{foreground_program}"));
        return Ok(());
    }

    let captured = uia::capture_selection(Some(anchor))?;

    // Chromium and Office may expose the text from a child process; re-check
    // the element owner against our own name and the blacklist.
    if is_own_program(&captured.program_name, &inner.own_program) {
        return Ok(());
    }
    if is_blacklisted(&captured.program_name, &config.blacklist) {
        inner.logger.info(&format!(
            "忽略黑名单应用中的划词：{}",
            captured.program_name
        ));
        return Ok(());
    }
    if inner.is_duplicate(&captured.text) {
        return Ok(());
    }

    let program_name = if foreground_program.trim().is_empty() {
        captured.program_name
    } else {
        foreground_program
    };
    let char_count = captured.text.chars().count();
    let payload = PickerPayload {
        text: captured.text,
        program_name,
        anchor_x: anchor.0,
        anchor_y: anchor.1,
        scale_factor: crate::win32::monitor_scale_factor(anchor.0, anchor.1),
        config: config.picker_config,
    };

    if !crate::windows::show_picker(app, &payload) {
        return Err("取词成功但 picker 窗口不存在，无法显示".to_string());
    }
    *lock(&inner.last_selection) = Some(payload);
    inner.picker_visible.store(true, Ordering::Release);
    inner.logger.info(&format!(
        "已捕获选中文本（{} 字符，来源：{}）",
        char_count,
        request.source.label()
    ));
    Ok(())
}

fn action_worker(inner: Arc<Inner>, receiver: Receiver<ActionRequest>) {
    while let Ok(request) = receiver.recv() {
        match request {
            ActionRequest::OutsideClick { x, y } => {
                if inner.panel_pinned.load(Ordering::Acquire) {
                    continue;
                }
                let Some(app) = inner.app.get() else {
                    continue;
                };
                let Some(window) = app.get_webview_window(PICKER_LABEL) else {
                    inner.picker_visible.store(false, Ordering::Release);
                    continue;
                };
                // The authoritative visibility check: `set_picker_visible` may lag
                // behind a hide performed by the window/main layer.
                if !window.is_visible().unwrap_or(false) {
                    inner.picker_visible.store(false, Ordering::Release);
                    continue;
                }
                let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size())
                else {
                    continue;
                };
                // Positions from Tauri are physical pixels, like the hook coordinates.
                let inside = x >= position.x
                    && x < position.x + size.width as i32
                    && y >= position.y
                    && y < position.y + size.height as i32;
                if inside {
                    continue;
                }
                crate::windows::hide_picker(app);
                inner.picker_visible.store(false, Ordering::Release);
            }
            ActionRequest::DismissOnInput { reason } => {
                // Sticky panel: pinned pickers and open result panels must not
                // be dismissed by keyboard/right-click input. An outside left
                // click is handled by `OutsideClick` and still hides un-pinned
                // pickers.
                if inner.panel_pinned.load(Ordering::Acquire)
                    || inner.panel_open.load(Ordering::Acquire)
                {
                    continue;
                }
                // A keypress that arrived right before a fresh capture (e.g. the
                // modifier of the hotkey that re-opened the toolbar) must not
                // immediately hide the new toolbar.
                if crate::windows::show_guard_active() {
                    continue;
                }
                let Some(app) = inner.app.get() else {
                    continue;
                };
                if !crate::windows::is_picker_visible(app) {
                    inner.picker_visible.store(false, Ordering::Release);
                    continue;
                }
                crate::windows::hide_picker(app);
                inner.picker_visible.store(false, Ordering::Release);
                inner
                    .logger
                    .info(&format!("用户操作（{reason}），picker 已自动隐藏"));
            }
        }
    }
}

/// True when the physical point lies inside the picker window rectangle.
fn picker_contains_point(app: &tauri::AppHandle, x: i32, y: i32) -> bool {
    let Some(window) = app.get_webview_window(PICKER_LABEL) else {
        return false;
    };
    if !window.is_visible().unwrap_or(false) {
        return false;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return false;
    };
    x >= position.x
        && x < position.x + size.width as i32
        && y >= position.y
        && y < position.y + size.height as i32
}

fn config_from_settings(settings: &Settings) -> WorkerConfig {
    WorkerConfig {
        blacklist: settings
            .picker
            .blacklist
            .iter()
            .map(|entry| normalize_program_name(entry))
            .filter(|entry| !entry.is_empty())
            .collect(),
        picker_config: serde_json::json!({
            "skills": &settings.picker.skills,
            "compact": settings.picker.compact,
            "defaultTargetLang": &settings.picker.default_target_lang,
            // Search engine used by the built-in `search` skill.
            "searchEngine": &settings.picker.search_engine,
            // Remembered pin preference: the picker restores it when a panel opens.
            "panelPinned": settings.picker.panel_pinned,
            // Panel sizing mode: "auto" grows with content, "scroll" keeps a
            // fixed window and scrolls the panel body.
            "panelMode": &settings.picker.panel_mode,
            // Only enabled custom skills are sent to the picker; the full
            // definition (including the prompt) stays in settings.
            "customSkills": enabled_custom_skill_metadata(settings),
        }),
    }
}

/// Metadata (`{id,label,icon}`) of the custom skills enabled in
/// `picker.skills`, in their stored order. Prompts are never exposed here: the
/// picker only needs them to render the toolbar and dispatch the command.
fn enabled_custom_skill_metadata(settings: &Settings) -> Vec<serde_json::Value> {
    settings
        .picker
        .custom_skills
        .iter()
        .filter(|skill| settings.picker.skills.iter().any(|id| id == &skill.id))
        .map(|skill| {
            serde_json::json!({
                "id": skill.id,
                "label": skill.label,
                "icon": skill.icon,
                "kind": skill.kind,
            })
        })
        .collect()
}

/// Lower-cases a process name and strips a trailing `.exe` so `Chrome.EXE`,
/// `chrome` and `chrome.exe` compare equal.
fn normalize_program_name(value: &str) -> String {
    let lowered = value.trim().trim_matches('"').trim().to_ascii_lowercase();
    lowered
        .strip_suffix(".exe")
        .unwrap_or(lowered.as_str())
        .trim_end()
        .to_string()
}

fn is_blacklisted(program: &str, blacklist: &[String]) -> bool {
    let program = normalize_program_name(program);
    if program.is_empty() {
        return false;
    }
    blacklist
        .iter()
        .any(|entry| normalize_program_name(entry) == program)
}

fn is_own_program(program: &str, own_program: &str) -> bool {
    let program = normalize_program_name(program);
    !program.is_empty() && program == normalize_program_name(own_program)
}

/// Same-text de-duplication with a rolling 400 ms window.
#[derive(Default)]
struct TextDedup {
    last_text: Option<String>,
    last_at: Option<Instant>,
}

impl TextDedup {
    fn should_skip(&mut self, text: &str, now: Instant, window: Duration) -> bool {
        if let (Some(last_text), Some(last_at)) = (&self.last_text, self.last_at) {
            if last_text == text && now.saturating_duration_since(last_at) < window {
                return true;
            }
        }
        self.last_text = Some(text.to_string());
        self.last_at = Some(now);
        false
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_program_names() {
        assert_eq!(normalize_program_name("Chrome.EXE"), "chrome");
        assert_eq!(normalize_program_name("  notepad.exe  "), "notepad");
        assert_eq!(normalize_program_name("\"WINWORD.EXE\""), "winword");
        assert_eq!(normalize_program_name("code"), "code");
        assert_eq!(normalize_program_name(".exe"), "");
        assert_eq!(normalize_program_name("   "), "");
    }

    #[test]
    fn blacklist_is_case_and_extension_tolerant() {
        let blacklist = vec![
            "chrome.exe".to_string(),
            normalize_program_name("Notepad.EXE"),
            String::new(),
        ];
        assert!(is_blacklisted("Chrome", &blacklist));
        assert!(is_blacklisted("chrome.EXE", &blacklist));
        assert!(is_blacklisted("notepad.exe", &blacklist));
        assert!(!is_blacklisted("code", &blacklist));
        // A missing process name must never match a blacklist entry.
        assert!(!is_blacklisted("", &blacklist));
        assert!(!is_blacklisted("   ", &blacklist));
    }

    #[test]
    fn own_program_is_ignored() {
        assert!(is_own_program("Lexora.EXE", "lexora"));
        assert!(is_own_program("lexora", "lexora.exe"));
        assert!(!is_own_program("chrome.exe", "lexora"));
        assert!(!is_own_program("", "lexora"));
        assert!(!is_own_program("", ""));
    }

    #[test]
    fn duplicate_text_within_400ms_is_skipped() {
        let start = Instant::now();
        let mut dedup = TextDedup::default();

        assert!(!dedup.should_skip("hello", start, DUPLICATE_WINDOW));
        assert!(dedup.should_skip(
            "hello",
            start + Duration::from_millis(200),
            DUPLICATE_WINDOW
        ));
        assert!(dedup.should_skip(
            "hello",
            start + Duration::from_millis(399),
            DUPLICATE_WINDOW
        ));
        // A different text is not a duplicate, even inside the window.
        assert!(!dedup.should_skip(
            "world",
            start + Duration::from_millis(400),
            DUPLICATE_WINDOW
        ));
        // Same text again after the window has passed is accepted.
        assert!(!dedup.should_skip(
            "hello",
            start + Duration::from_millis(450),
            DUPLICATE_WINDOW
        ));
    }

    #[test]
    fn trigger_sources_have_log_labels() {
        assert_eq!(TriggerSource::Mouse.label(), "鼠标拖选");
        assert_eq!(TriggerSource::Click.label(), "鼠标多击选词");
    }

    #[test]
    fn picker_config_matches_contract() {
        let mut settings = Settings::default();
        settings.picker.compact = true;
        settings.picker.skills = vec!["translate".to_string(), "copy".to_string()];
        settings.picker.default_target_lang = "zh".to_string();

        let config = config_from_settings(&settings);
        assert_eq!(config.picker_config["compact"], true);
        assert_eq!(config.picker_config["defaultTargetLang"], "zh");
        assert_eq!(config.picker_config["searchEngine"], "google");
        assert_eq!(config.picker_config["panelPinned"], false);
        assert_eq!(config.picker_config["panelMode"], "auto");
        assert_eq!(config.picker_config["skills"][0], "translate");
        assert_eq!(config.picker_config["skills"][1], "copy");
        assert_eq!(config.picker_config["customSkills"], serde_json::json!([]));
    }

    #[test]
    fn picker_config_forwards_the_panel_mode() {
        let mut settings = Settings::default();
        assert_eq!(
            config_from_settings(&settings).picker_config["panelMode"],
            "auto"
        );

        settings.picker.panel_mode = "scroll".to_string();
        assert_eq!(
            config_from_settings(&settings).picker_config["panelMode"],
            "scroll"
        );
    }

    #[test]
    fn picker_config_forwards_the_panel_pin_preference() {
        let mut settings = Settings::default();
        settings.picker.panel_pinned = true;

        let config = config_from_settings(&settings);
        assert_eq!(config.picker_config["panelPinned"], true);
    }

    #[test]
    fn panel_open_state_is_tracked_and_reset_when_hidden() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = Arc::new(SettingsStore::load(dir.path().join("settings.json")));
        let logger = Logger::new(&dir.path().join("logs"), "selection-test");
        let service = SelectionService::new(store, logger);

        assert!(!service.is_panel_open());
        service.set_panel_pinned(true);
        service.set_panel_open(true);
        assert!(service.is_panel_open());
        assert!(service.is_panel_pinned());

        // Hiding the picker clears both the pin and the open-panel state.
        service.set_picker_visible(false);
        assert!(!service.is_panel_open());
        assert!(!service.is_panel_pinned());
    }

    #[test]
    fn picker_config_forwards_the_configured_search_engine() {
        let mut settings = Settings::default();
        settings.picker.search_engine = "bing".to_string();

        let config = config_from_settings(&settings);
        assert_eq!(config.picker_config["searchEngine"], "bing");
    }

    #[test]
    fn picker_config_exposes_only_enabled_custom_skills() {
        let mut settings = Settings::default();
        settings.picker.skills = vec!["translate".to_string(), "custom-enabled".to_string()];
        settings.picker.custom_skills = vec![
            crate::settings::CustomSkill {
                id: "custom-disabled".to_string(),
                label: "未启用".to_string(),
                icon: "star".to_string(),
                kind: crate::settings::default_custom_skill_kind(),
                prompt: "disabled {text}".to_string(),
            },
            crate::settings::CustomSkill {
                id: "custom-enabled".to_string(),
                label: "已启用".to_string(),
                icon: "wand".to_string(),
                kind: "image".to_string(),
                prompt: "Explain {text} for {program} in {target}".to_string(),
            },
        ];

        let config = config_from_settings(&settings);
        let custom = config.picker_config["customSkills"]
            .as_array()
            .expect("customSkills must be an array");
        assert_eq!(custom.len(), 1, "customSkills: {custom:?}");
        assert_eq!(custom[0]["id"], "custom-enabled");
        assert_eq!(custom[0]["label"], "已启用");
        assert_eq!(custom[0]["icon"], "wand");
        assert_eq!(custom[0]["kind"], "image");
        // Prompts stay in settings; the picker never receives them.
        assert!(custom[0].get("prompt").is_none());
    }
}
