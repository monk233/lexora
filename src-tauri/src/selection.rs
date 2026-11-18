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
//! through channels, keeping it far below the ~300 ms low-level hook budget:
//! it never calls the Tauri window API (visibility mirrors live in atomics) and
//! this module never injects input events while listening, so rdev cannot see
//! its own events. When UI Automation cannot read a selection, the worker falls
//! back to a synthetic Ctrl+C + clipboard read (`picker.clipboardFallback`),
//! which is the only path for Firefox, WeChat/QQ, Excel and PDF viewers.

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
    /// Forward captures after earlier outside presses have been handled.
    Capture(CaptureRequest),
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
    /// Read the selection through Ctrl+C + clipboard when UI Automation fails.
    clipboard_fallback: bool,
    /// `PickerData.config` as defined by contract §5.5.
    picker_config: serde_json::Value,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            blacklist: Vec::new(),
            clipboard_fallback: true,
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
    /// Mirror of `is_toolbar_visible` maintained by `windows.rs`, so the input
    /// hook callback never has to call into the Tauri window API (a blocking
    /// cross-thread call there risks the ~300 ms `LowLevelHooksTimeout`).
    toolbar_visible: AtomicBool,
    panel_pinned: AtomicBool,
    /// A result panel is open: keyboard, wheel and secondary buttons keep it
    /// open; an outside left press dismisses it unless pinned.
    panel_open: AtomicBool,
    /// A screenshot overlay is active: the picker/settings stay open and the
    /// global input hook must not dismiss the picker while the user frames the
    /// screenshot (contract §10.1). Set by `capture.rs`, cleared when the
    /// capture flow ends.
    capture_active: AtomicBool,
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

    /// Queues a capture request. The worker drains the channel to the newest
    /// trigger before capturing, so a slow capture can never swallow the
    /// selection the user made next.
    fn send_capture(&self, source: TriggerSource, anchor: Option<(i32, i32)>) {
        self.send_action(ActionRequest::Capture(CaptureRequest {
            source,
            anchor,
            at: Instant::now(),
        }));
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
            toolbar_visible: AtomicBool::new(false),
            panel_pinned: AtomicBool::new(false),
            panel_open: AtomicBool::new(false),
            capture_active: AtomicBool::new(false),
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
            self.inner.toolbar_visible.store(false, Ordering::Release);
            self.inner.panel_pinned.store(false, Ordering::Release);
            self.inner.panel_open.store(false, Ordering::Release);
        }
    }

    /// Mirror of the transient toolbar's visibility for the input hook.
    pub fn set_toolbar_visible(&self, visible: bool) {
        self.inner.toolbar_visible.store(visible, Ordering::Release);
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

    /// Marks whether a screenshot overlay is currently active. While active the
    /// picker/settings are kept open on purpose and the global input hook must
    /// not dismiss them (contract §10.1). It is cleared by `capture_close`,
    /// `capture_skill` and `capture_copy`.
    pub fn set_capture_active(&self, active: bool) {
        self.inner.capture_active.store(active, Ordering::Release);
    }

    pub fn is_capture_active(&self) -> bool {
        self.inner.capture_active.load(Ordering::Acquire)
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
    while let Ok(mut request) = receiver.recv() {
        // Only the newest trigger matters: drop anything the user superseded
        // while the previous capture was still running. The old code refused
        // such triggers in the hook callback, which read as "no reaction".
        while let Ok(newer) = receiver.try_recv() {
            request = newer;
        }
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
            // Every failure is logged with the foreground program name: the old
            // rule discarded "没有选中文本" entirely, so "划词没反应" reports had
            // no trace at all.
            inner.log_capture_failure(&message);
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

    let captured = match uia::capture_selection(Some(anchor)) {
        Ok(captured) => captured,
        Err(failure) => {
            let program = display_program(&foreground_program);
            if !config.clipboard_fallback {
                return Err(format!("{program}：{}", failure.detail));
            }
            // Firefox, WeChat/QQ, Excel, most PDF viewers and canvas UIs expose
            // no UIA text pattern at all, so without this fallback the picker
            // simply never appears there.
            let foreground_class = win::foreground_window_class();
            match clipboard_fallback(&foreground_program, &foreground_class) {
                Ok(text) => {
                    let shortcut = if is_terminal_target(&foreground_program, &foreground_class) {
                        "Ctrl+Shift+C"
                    } else {
                        "Ctrl+C"
                    };
                    inner.logger.info(&format!(
                        "{program}：UI Automation 无文本选区（{}），已用 {shortcut} 回退捕获 {} 字符",
                        failure.detail,
                        text.chars().count()
                    ));
                    uia::CapturedSelection {
                        text,
                        program_name: foreground_program.clone(),
                    }
                }
                Err(reason) => {
                    return Err(format!(
                        "{program}：没有取到选中文本（UIA：{}；剪贴板回退：{}）",
                        failure.detail, reason
                    ));
                }
            }
        }
    };

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
    let display_name = display_program(&program_name);
    let payload = PickerPayload {
        text: captured.text,
        program_name,
        anchor_x: anchor.0,
        anchor_y: anchor.1,
        scale_factor: crate::win32::monitor_scale_factor(anchor.0, anchor.1),
        config: {
            let mut picker_config = config.picker_config;
            let state = app.state::<Arc<crate::AppState>>();
            picker_config["suggestionsAvailable"] =
                serde_json::json!(state.engine.suggestions_available());
            picker_config
        },
    };

    let preserve_open_panel = preserve_panel_for_selection(
        inner.panel_open.load(Ordering::Acquire),
        inner.panel_pinned.load(Ordering::Acquire),
    );
    let shown = if preserve_open_panel {
        crate::windows::show_toolbar(app, &payload)
    } else {
        crate::windows::show_picker(app, &payload)
    };
    if !shown {
        return Err("取词成功但 picker 窗口不存在，无法显示".to_string());
    }
    *lock(&inner.last_selection) = Some(payload);
    inner.picker_visible.store(true, Ordering::Release);
    inner.logger.info(&format!(
        "已捕获选中文本（{} 字符，来源：{}，应用：{}）",
        char_count,
        request.source.label(),
        display_name
    ));
    Ok(())
}

fn preserve_panel_for_selection(panel_open: bool, panel_pinned: bool) -> bool {
    panel_open && panel_pinned
}
fn action_worker(inner: Arc<Inner>, receiver: Receiver<ActionRequest>) {
    while let Ok(request) = receiver.recv() {
        // While a screenshot is being taken the picker/settings stay open and
        // ordinary input (keyboard, wheel, right/middle click, outside click)
        // must not dismiss them (contract §10.1). The requests are simply
        // dropped: after the capture ends the next input dismisses normally.
        if inner.capture_active.load(Ordering::Acquire) {
            continue;
        }
        match request {
            ActionRequest::Capture(request) => {
                if let Some(sender) = lock(&inner.capture_tx).as_ref() {
                    let _ = sender.send(request);
                }
            }
            ActionRequest::OutsideClick { x, y } => {
                let Some(app) = inner.app.get() else {
                    continue;
                };
                if crate::windows::is_toolbar_visible(app)
                    && !window_contains_point(app, crate::windows::PICKER_TOOLBAR_LABEL, x, y)
                {
                    crate::windows::hide_toolbar(app);
                }
                if !outside_click_dismisses_panel(
                    inner.panel_pinned.load(Ordering::Acquire),
                    window_contains_point(app, crate::windows::PICKER_LABEL, x, y),
                    window_contains_point(app, crate::windows::PICKER_TOOLBAR_LABEL, x, y),
                ) {
                    continue;
                }
                if !crate::windows::is_any_picker_visible(app) {
                    inner.picker_visible.store(false, Ordering::Release);
                    continue;
                }
                crate::windows::hide_picker(app);
                inner.picker_visible.store(false, Ordering::Release);
            }
            ActionRequest::DismissOnInput { reason } => {
                let Some(app) = inner.app.get() else {
                    continue;
                };
                if crate::windows::is_toolbar_visible(app) {
                    crate::windows::hide_toolbar(app);
                    continue;
                }
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

fn outside_click_dismisses_panel(pinned: bool, inside_panel: bool, inside_toolbar: bool) -> bool {
    !pinned && !inside_panel && !inside_toolbar
}

/// True when the physical point lies inside one picker surface rectangle.
fn window_contains_point(app: &tauri::AppHandle, label: &str, x: i32, y: i32) -> bool {
    let Some(window) = app.get_webview_window(label) else {
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

/// True when the physical point lies inside the panel window rectangle.
fn picker_contains_point(app: &tauri::AppHandle, x: i32, y: i32) -> bool {
    window_contains_point(app, PICKER_LABEL, x, y)
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
        clipboard_fallback: settings.picker.clipboard_fallback,
        picker_config: picker_config(settings),
    }
}

/// `PickerData.config` as defined by contract §5.5, built from the current
/// settings. Shared by the text-selection picker and the screenshot result
/// panel (`capture_skill` opens the picker with the same config, §10.3).
pub(crate) fn picker_config(settings: &Settings) -> serde_json::Value {
    serde_json::json!({
        "skills": &settings.picker.skills,
        "compact": settings.picker.compact,
        "suggestionsAvailable": if settings.is_local_mode() { false } else { settings.online_configured() },
        "defaultTargetLang": &settings.picker.default_target_lang,
        // Search engine used by the built-in `search` skill.
        "searchEngine": &settings.picker.search_engine,
        // Remembered pin preference: the picker restores it when a panel opens.
        "panelPinned": settings.picker.panel_pinned,
        // Panel sizing mode: "auto" grows with content, "scroll" keeps a
        // fixed window and scrolls the panel body.
        "panelMode": &settings.picker.panel_mode,
        // UI language of the picker window: initialises shared/i18n.js.
        "locale": settings.effective_language(),
        // Only enabled custom skills are sent to the picker; the full
        // definition (including the prompt) stays in settings.
        "customSkills": enabled_custom_skill_metadata(settings),
    })
}

/// Runtime capability for screenshot result panels and other picker entry points.
pub(crate) fn picker_config_with_engine(
    settings: &Settings,
    engine: &crate::engine::EngineService,
) -> serde_json::Value {
    let mut config = picker_config(settings);
    config["suggestionsAvailable"] = serde_json::json!(engine.suggestions_available());
    config
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

/// Dedicated terminal hosts: the whole window is a console, so a synthetic
/// Ctrl+C would interrupt the running command.
const TERMINAL_PROGRAMS: [&str; 10] = [
    "windowsterminal",
    "conhost",
    "mintty",
    "alacritty",
    "wezterm-gui",
    "putty",
    "xshell",
    "mobaxterm",
    "tabby",
    "conemu",
];
/// Window classes that host a console even though the process is a generic
/// shell (`cmd.exe`, `powershell.exe`, ...). The class check keeps GUI apps that
/// merely run under `powershell.exe` (or a script host) out of that exclusion.
const TERMINAL_WINDOW_CLASSES: [&str; 3] = [
    "ConsoleWindowClass",
    "CASCADIA_HOSTING_WINDOW_CLASS",
    "mintty",
];
/// How long the clipboard fallback waits for the application to publish the
/// copied text after the synthetic Ctrl+C.
const CLIPBOARD_WAIT: Duration = Duration::from_millis(240);
/// Clipboard polling interval inside [`CLIPBOARD_WAIT`].
const CLIPBOARD_POLL: Duration = Duration::from_millis(20);

/// User-facing program name for log lines.
fn display_program(program: &str) -> String {
    let normalized = normalize_program_name(program);
    if normalized.is_empty() {
        "未知应用".to_string()
    } else {
        normalized
    }
}

fn is_terminal_target(program: &str, window_class: &str) -> bool {
    let program = normalize_program_name(program);
    if !program.is_empty() && TERMINAL_PROGRAMS.contains(&program.as_str()) {
        return true;
    }
    !window_class.is_empty() && TERMINAL_WINDOW_CLASSES.contains(&window_class)
}

/// Reads the selection through the clipboard: synthesize a copy shortcut, wait
/// for the clipboard to change, then restore the previous text clipboard.
///
/// Terminals get `Ctrl+Shift+C` (their copy shortcut) instead of `Ctrl+C`,
/// which would interrupt the running command. A clipboard that holds image or
/// file data is still overwritten (that is the only way those applications can
/// be read at all) but its content cannot be restored, so it is left with the
/// copied text and a warning is logged.
fn clipboard_fallback(program: &str, window_class: &str) -> Result<String, String> {
    let terminal = is_terminal_target(program, window_class);
    let previous = crate::win32::read_clipboard_text();
    let rich_clipboard = crate::win32::clipboard_has_non_text_content();
    if !crate::win32::send_copy_shortcut(terminal) {
        return Err("无法发送复制快捷键".to_string());
    }
    let deadline = Instant::now() + CLIPBOARD_WAIT;
    let mut captured = None;
    while Instant::now() < deadline {
        std::thread::sleep(CLIPBOARD_POLL);
        if let Some(text) = crate::win32::read_clipboard_text() {
            if !text.trim().is_empty() && Some(&text) != previous.as_ref() {
                captured = Some(text.trim().to_string());
                break;
            }
        }
    }
    if captured.is_some() {
        if rich_clipboard {
            // Nothing to restore: the previous clipboard was image/file data.
        } else {
            match previous.as_ref() {
                Some(text) => {
                    let _ = crate::win32::write_clipboard_text(text);
                }
                None => {
                    let _ = crate::win32::clear_clipboard();
                }
            }
        }
    }
    captured.ok_or_else(|| {
        if terminal {
            "终端没有复制到新文本（已发 Ctrl+Shift+C）".to_string()
        } else {
            "剪贴板没有出现新文本".to_string()
        }
    })
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
    fn outside_press_respects_panel_and_toolbar_boundaries_and_pin() {
        assert!(outside_click_dismisses_panel(false, false, false));
        assert!(!outside_click_dismisses_panel(false, true, false));
        assert!(!outside_click_dismisses_panel(false, false, true));
        assert!(!outside_click_dismisses_panel(true, false, false));
    }

    #[test]
    fn screenshot_worker_drops_outside_clicks_and_capture_requests() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = Arc::new(SettingsStore::load(dir.path().join("settings.json")));
        let service = SelectionService::new(
            store,
            Logger::new(&dir.path().join("logs"), "selection-test"),
        );
        service.set_capture_active(true);
        service.set_picker_visible(true);
        service.set_panel_open(true);
        let (capture_tx, capture_rx) = mpsc::channel();
        *lock(&service.inner.capture_tx) = Some(capture_tx);
        let (action_tx, action_rx) = mpsc::channel();
        action_tx
            .send(ActionRequest::OutsideClick { x: 10, y: 20 })
            .unwrap();
        action_tx
            .send(ActionRequest::Capture(CaptureRequest {
                source: TriggerSource::Mouse,
                anchor: Some((40, 20)),
                at: Instant::now(),
            }))
            .unwrap();
        drop(action_tx);
        action_worker(service.inner.clone(), action_rx);
        assert!(service.is_panel_open());
        assert!(service.inner.picker_visible.load(Ordering::Acquire));
        assert!(capture_rx.try_recv().is_err());
    }

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
    fn only_pinned_panels_survive_a_new_selection() {
        assert!(!preserve_panel_for_selection(false, false));
        assert!(!preserve_panel_for_selection(false, true));
        assert!(!preserve_panel_for_selection(true, false));
        assert!(preserve_panel_for_selection(true, true));
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
    fn capture_active_gates_the_input_dismissal() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = Arc::new(SettingsStore::load(dir.path().join("settings.json")));
        let logger = Logger::new(&dir.path().join("logs"), "selection-test");
        let service = SelectionService::new(store, logger);

        // Off by default: input dismissal works normally.
        assert!(!service.is_capture_active());
        service.set_capture_active(true);
        assert!(service.is_capture_active());
        // Hiding the picker does not clear the screenshot gate: only the
        // capture flow itself ends it.
        service.set_picker_visible(false);
        assert!(service.is_capture_active());
        service.set_capture_active(false);
        assert!(!service.is_capture_active());
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
