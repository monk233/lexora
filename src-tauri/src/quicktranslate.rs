//! Quick-translate panel: window lifecycle, its own global hotkey thread and
//! the translation history store (contract `docs/quick-translate.md` §2-5).
//!
//! The panel is a normal decorated window (`label = "quicktranslate"`) that is
//! shown/hidden by the global hotkey (default `Alt+Space`), by `quick_open` and
//! by `quick-show`/`quick_hide` in the renderer. Hiding never exits the app: the
//! window is only hidden and the running stream is aborted, so the next hotkey
//! press reuses the already loaded webview with the previous content.
//!
//! The hotkey lives on a dedicated Windows message thread, exactly like the
//! screenshot hotkey in [`crate::capture`], so `quick_set_hotkey` and
//! `update_settings` can re-register it at runtime without restarting the app.
//! Registration failures roll back to the previous shortcut, and
//! `quick.enabled = false` unregisters it entirely.
//!
//! [`HistoryStore`] persists `quick-history.json` (newest first, at most
//! [`MAX_HISTORY`] entries) with an atomic write. A corrupted file is backed up
//! as `quick-history.json.broken` and treated as an empty history, so a broken
//! file can never block translations.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

use crate::engine::{EngineError, QUICK_MAX_TEXT_CHARS};
use crate::settings::{
    normalize_quick_shortcut, parse_shortcut, Settings, Shortcut, DEFAULT_QUICK_SHORTCUT,
    DEFAULT_QUICK_TARGET_LANG, TARGET_LANGS,
};
use crate::state::{lock, AppState};

/// Tauri label of the quick-translate window (`tauri.conf.json`).
pub const QUICK_LABEL: &str = "quicktranslate";
/// Event pushed to the panel when it is shown; the renderer focuses its input
/// and refreshes its configuration.
pub const EVENT_SHOW: &str = "quick-show";
/// Stream event name shared with the picker (`chunk` / `done` / `error`), but
/// always emitted **to the quick panel only** (contract §4).
pub const EVENT_TRANSLATE: &str = "translate-event";
/// File name of the history store inside `<data>/`.
pub const HISTORY_FILE_NAME: &str = "quick-history.json";
/// Newest-first history cap (contract §5).
pub const MAX_HISTORY: usize = 500;
/// On-disk schema of `quick-history.json`.
const HISTORY_VERSION: u32 = 1;
/// `createdAt`/`target`/`source` text cap: same limit as the panel input.
const HISTORY_TEXT_MAX_CHARS: usize = QUICK_MAX_TEXT_CHARS;
/// Renderer-controlled panel size limits, logical (CSS) pixels (contract §4).
const MIN_PANEL_WIDTH: f64 = 640.0;
const MAX_PANEL_WIDTH: f64 = 1_600.0;
const MIN_PANEL_HEIGHT: f64 = 420.0;
const MAX_PANEL_HEIGHT: f64 = 760.0;
/// Free space kept between the panel and the monitor work-area edges, so the
/// floating window never touches the taskbar or the screen border.
const PANEL_WORK_AREA_MARGIN: f64 = 80.0;

// ---------------------------------------------------------------------------
// Source-language heuristic (contract §5, shared with the renderer)
// ---------------------------------------------------------------------------

/// Best-effort source language of the text, returned as a [`TARGET_LANGS`]
/// code. Purely script-presence based (never by character count), with the same
/// priority order as `qtDetectSourceLang` in `web/quicktranslate.js` so the
/// history label and the swap button agree on both sides:
///
/// kana → `ja` (even with many Han characters), Han → `zh` (Traditional and
/// Simplified share the ideograph ranges), Hangul → `ko`, Cyrillic → `ru`,
/// Arabic → `ar`, Thai → `th`, Devanagari → `hi`, Hebrew → `he`, everything
/// else (including empty or digit/punctuation-only text) → `en`.
pub fn detect_source_lang(text: &str) -> &'static str {
    let mut seen_han = false;
    let mut seen_kana = false;
    let mut seen_hangul = false;
    let mut seen_cyrillic = false;
    let mut seen_arabic = false;
    let mut seen_thai = false;
    let mut seen_devanagari = false;
    let mut seen_hebrew = false;
    for character in text.chars() {
        let code = character as u32;
        // Kana wins over Han: Japanese sentences mix both scripts.
        if (0x3040..=0x30FF).contains(&code) || (0x31F0..=0x31FF).contains(&code) {
            seen_kana = true;
            continue;
        }
        // Half-width Katakana is part of the alignment.
        if (0xFF66..=0xFF9D).contains(&code) {
            seen_kana = true;
            continue;
        }
        if (0x4E00..=0x9FFF).contains(&code)
            || (0x3400..=0x4DBF).contains(&code)
            || (0xF900..=0xFAFF).contains(&code)
        {
            seen_han = true;
        } else if (0xAC00..=0xD7AF).contains(&code) || (0x1100..=0x11FF).contains(&code) {
            seen_hangul = true;
        } else if (0x0400..=0x04FF).contains(&code) || (0x0500..=0x052F).contains(&code) {
            seen_cyrillic = true;
        } else if (0x0600..=0x06FF).contains(&code) || (0x0750..=0x077F).contains(&code) {
            seen_arabic = true;
        } else if (0x0E00..=0x0E7F).contains(&code) {
            seen_thai = true;
        } else if (0x0900..=0x097F).contains(&code) {
            seen_devanagari = true;
        } else if (0x0590..=0x05FF).contains(&code) {
            seen_hebrew = true;
        }
    }
    if seen_kana {
        "ja"
    } else if seen_han {
        "zh"
    } else if seen_hangul {
        "ko"
    } else if seen_cyrillic {
        "ru"
    } else if seen_arabic {
        "ar"
    } else if seen_thai {
        "th"
    } else if seen_devanagari {
        "hi"
    } else if seen_hebrew {
        "he"
    } else {
        "en"
    }
}

// ---------------------------------------------------------------------------
// Window lifecycle (contract §2)
// ---------------------------------------------------------------------------

fn state_of(app: &AppHandle) -> Option<tauri::State<'_, Arc<AppState>>> {
    app.try_state::<Arc<AppState>>()
}

/// The panel only reacts to the hotkey while `quick.enabled` is true.
pub fn is_enabled(app: &AppHandle) -> bool {
    state_of(app)
        .map(|state| state.settings.get().quick.enabled)
        .unwrap_or(false)
}

pub fn is_visible(app: &AppHandle) -> bool {
    app.get_webview_window(QUICK_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// Shows and focuses the panel, restores the remembered pin state and tells the
/// renderer to focus its input (`quick-show`). The webview is reused, so the
/// previous content is intentionally kept (contract §6, behavior notes).
pub fn show(app: &AppHandle) {
    let Some(window) = app.get_webview_window(QUICK_LABEL) else {
        log_warn(app, "quicktranslate window missing");
        return;
    };
    let pinned = state_of(app)
        .map(|state| state.settings.get().quick.pinned)
        .unwrap_or(false);
    // Apply the persisted pin state before the window becomes visible, so it
    // never flashes at the wrong z-order.
    let _ = window.set_always_on_top(pinned);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit_to(QUICK_LABEL, EVENT_SHOW, serde_json::json!({}));
    if let Some(state) = state_of(app) {
        state
            .log
            .info(&format!("quicktranslate shown (pinned={pinned})"));
    }
}

/// Hides the panel and aborts the running stream (contract §2: hiding must not
/// write a history entry and must stop the network work).
pub fn hide(app: &AppHandle) {
    let Some(window) = app.get_webview_window(QUICK_LABEL) else {
        return;
    };
    let was_visible = window.is_visible().unwrap_or(false);
    if was_visible {
        let _ = window.hide();
    }
    let Some(state) = state_of(app) else {
        return;
    };
    if was_visible {
        state.abort_translate();
        state.log.info("quicktranslate hidden");
    }
}

/// Hotkey behavior: visible → hide, hidden → show + focus.
pub fn toggle(app: &AppHandle) {
    if !is_enabled(app) {
        return;
    }
    if is_visible(app) {
        hide(app);
    } else {
        show(app);
    }
}

/// Applies the "always on top" flag; returns whether the window accepted it.
pub fn set_pinned(app: &AppHandle, pinned: bool) -> bool {
    let Some(window) = app.get_webview_window(QUICK_LABEL) else {
        return false;
    };
    window.set_always_on_top(pinned).is_ok()
}

// ---------------------------------------------------------------------------
// Borderless window geometry (contract §2/§4)
// ---------------------------------------------------------------------------

/// Current DPI scale of the panel, sanitized like the picker helpers.
fn window_scale<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> f64 {
    window
        .scale_factor()
        .ok()
        .filter(|scale| scale.is_finite() && *scale > 0.1)
        .unwrap_or(1.0)
}

/// Converts a logical (CSS) pixel length to physical pixels, at least 1.
fn physical_length(logical: f64, scale: f64) -> i32 {
    ((logical * scale).round() as i32).max(1)
}

/// Pure size clamp of [`resize`] (contract §4): width `[640, 1600]`, height
/// `[420, min(760, work-area height - 80)]`. On a tiny work area the minimum
/// height still wins instead of producing an invalid range.
fn clamp_panel_size(width: f64, height: f64, work_height_logical: f64) -> (f64, f64) {
    let max_height = (work_height_logical - PANEL_WORK_AREA_MARGIN)
        .min(MAX_PANEL_HEIGHT)
        .max(MIN_PANEL_HEIGHT);
    (
        width.clamp(MIN_PANEL_WIDTH, MAX_PANEL_WIDTH).round(),
        height.clamp(MIN_PANEL_HEIGHT, max_height).round(),
    )
}

/// Applies a renderer-provided logical panel size (`quick_resize`, contract §4).
///
/// The panel is a borderless transparent surface whose height follows the
/// renderer content: `width`/`height` are logical (CSS) pixels, converted to
/// physical pixels and clamped to the work area of the monitor the window
/// currently lives on. A grown panel is kept inside the virtual desktop (the
/// position is only written when it actually has to move). Returns the applied
/// logical width/height, or `None` when the panel window is gone.
pub fn resize(app: &AppHandle, width: f64, height: f64) -> Option<(f64, f64)> {
    let window = app.get_webview_window(QUICK_LABEL)?;
    let scale = window_scale(&window);
    let current = window.outer_position().ok()?;
    let current_size = window.outer_size().ok();
    // Work area of the monitor the panel currently lives on (physical pixels).
    let work = crate::win32::work_area_physical(current.x, current.y);
    let work_height_logical = if work.bottom > work.top {
        (work.bottom - work.top) as f64 / scale
    } else {
        MAX_PANEL_HEIGHT + PANEL_WORK_AREA_MARGIN
    };
    // Non-finite renderer values fall back to the current window size instead
    // of breaking the window API.
    let fallback_width = current_size
        .map(|size| size.width as f64 / scale)
        .unwrap_or(MIN_PANEL_WIDTH);
    let fallback_height = current_size
        .map(|size| size.height as f64 / scale)
        .unwrap_or(MIN_PANEL_HEIGHT);
    let requested_width = if width.is_finite() && width > 0.0 {
        width
    } else {
        fallback_width
    };
    let requested_height = if height.is_finite() && height > 0.0 {
        height
    } else {
        fallback_height
    };
    let (logical_width, logical_height) =
        clamp_panel_size(requested_width, requested_height, work_height_logical);

    let physical_width = physical_length(logical_width, scale);
    let physical_height = physical_length(logical_height, scale);
    let _ = window.set_size(PhysicalSize::new(
        physical_width as u32,
        physical_height as u32,
    ));

    // The grown panel may stick out of the screen: keep it inside the virtual
    // desktop. An unchanged position never receives a redundant `set_position`.
    let position = window.outer_position().unwrap_or(current);
    let (x, y) = crate::win32::clamp_to_virtual_screen(
        position.x,
        position.y,
        physical_width,
        physical_height,
    );
    if (x, y) != (position.x, position.y) {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    if let Some(state) = state_of(app) {
        state.log.info(&format!(
            "quicktranslate resized to logical={logical_width:.0}x{logical_height:.0} \
             physical={physical_width}x{physical_height} scale={scale:.3} \
             work_height={work_height_logical:.0}"
        ));
    }
    Some((logical_width, logical_height))
}

/// Moves the borderless panel by a logical-pixel delta (`quick_drag_panel`,
/// contract §4): the top bar drags the window, and the whole window is clamped
/// into the virtual desktop so it can travel across monitors. Returns whether
/// the window accepted the move (hidden/non-finite input is a no-op).
pub fn drag_panel(app: &AppHandle, dx: f64, dy: f64) -> bool {
    let Some(window) = app.get_webview_window(QUICK_LABEL) else {
        return false;
    };
    if !window.is_visible().unwrap_or(false) || !dx.is_finite() || !dy.is_finite() {
        return false;
    }
    let scale = window_scale(&window);
    let Ok(current) = window.outer_position() else {
        return false;
    };
    let size = window
        .outer_size()
        .unwrap_or(PhysicalSize::new(1, 1));
    let x = current.x + (dx * scale).round() as i32;
    let y = current.y + (dy * scale).round() as i32;
    let (x, y) =
        crate::win32::clamp_to_virtual_screen(x, y, size.width as i32, size.height as i32);
    window.set_position(PhysicalPosition::new(x, y)).is_ok()
}

/// Cleanup hook for the `Destroyed` window event: the panel only goes away with
/// the process, so never keep a stream alive behind its back.
pub fn handle_destroyed(app: &AppHandle) {
    if let Some(state) = state_of(app) {
        state.abort_translate();
        state.log.info("quicktranslate window destroyed");
    }
}

fn log_warn(app: &AppHandle, message: &str) {
    if let Some(state) = state_of(app) {
        state.log.warn(message);
    }
}

// ---------------------------------------------------------------------------
// Global hotkey thread (contract §2/§3)
// ---------------------------------------------------------------------------

/// Result of `quick_set_hotkey`, mapped to the contract's JSON by the command.
pub enum SetHotkeyOutcome {
    Applied {
        shortcut: String,
        /// Set when the shortcut works but persisting it failed.
        warning: Option<String>,
    },
    Failed {
        /// Shortcut still in effect (the previous one).
        shortcut: String,
        error: String,
        hint: String,
    },
}

/// A registration command handed to the hotkey thread.
#[derive(Debug, Clone, Copy)]
enum HotkeyCommand {
    /// Register (or replace) the global shortcut.
    Register(Shortcut),
    /// Unregister; used when `quick.enabled` is turned off.
    Unregister,
}

/// A command pushed by a Tauri command thread and answered by the hotkey
/// thread (`Err` carries message + hint).
struct HotkeyRequest {
    command: HotkeyCommand,
    reply: mpsc::Sender<Result<(), EngineError>>,
}

const HOTKEY_ID: i32 = 0x5154; // 'QT'
/// `WM_APP + 2`: posted to the quick hotkey thread to apply a command. Distinct
/// from the screenshot thread's `WM_APP + 1` even though the threads are
/// independent message queues.
const HOTKEY_RELOAD_MESSAGE: u32 = 0x8002;

/// Thread id of the hotkey message loop (0 = not running yet).
static HOTKEY_THREAD_ID: AtomicU32 = AtomicU32::new(0);
/// Shortcut currently registered by the hotkey thread (used for rollback).
static CURRENT_HOTKEY: Mutex<Option<Shortcut>> = Mutex::new(None);
/// Pending command handed from a command to the hotkey thread.
static PENDING_HOTKEY: Mutex<Option<HotkeyRequest>> = Mutex::new(None);

fn default_quick_shortcut() -> Shortcut {
    parse_shortcut(DEFAULT_QUICK_SHORTCUT).expect("the default quick shortcut must parse")
}

fn registered_shortcut() -> Option<Shortcut> {
    *lock(&CURRENT_HOTKEY)
}

/// Normalizes renderer input and persists it through the settings store. The
/// command has already applied the registration, so a persistence failure is
/// only reported as a warning (the shortcut stays in effect).
fn persist_hotkey(app: &AppHandle, shortcut: &str) -> SetHotkeyOutcome {
    let Some(state) = state_of(app) else {
        return SetHotkeyOutcome::Applied {
            shortcut: shortcut.to_string(),
            warning: Some("快捷键已生效，但应用状态不可用，未能保存设置。".to_string()),
        };
    };
    match state
        .settings
        .update_json(serde_json::json!({ "quick": { "hotkey": shortcut } }))
    {
        Ok(updated) => {
            state
                .log
                .info(&format!("quicktranslate hotkey updated to {}", updated.quick.hotkey));
            // Keep the settings window in sync (its hotkey row must show the
            // canonical value saved by the panel).
            crate::commands::broadcast_state(app, &state);
            SetHotkeyOutcome::Applied {
                shortcut: updated.quick.hotkey,
                warning: None,
            }
        }
        Err(error) => {
            state
                .log
                .warn(&format!("quick hotkey applied but not persisted: {error}"));
            SetHotkeyOutcome::Applied {
                shortcut: shortcut.to_string(),
                warning: Some(format!("快捷键已生效，但保存设置失败：{error}")),
            }
        }
    }
}

/// Applies `quick_set_hotkey`: normalize → re-register on the hotkey thread →
/// persist + broadcast (contract §4). An invalid combination falls back to the
/// default `Alt+Space`; a failed registration rolls back to the previous
/// shortcut. While the panel is disabled nothing is registered, but the chosen
/// shortcut is still remembered for the next enable.
pub fn set_hotkey(app: &AppHandle, raw: &str) -> SetHotkeyOutcome {
    let settings = state_of(app)
        .map(|state| state.settings.get())
        .unwrap_or_default();
    let normalized = normalize_quick_shortcut(raw);
    let requested = parse_shortcut(&normalized).unwrap_or_else(default_quick_shortcut);

    if !settings.quick.enabled {
        return persist_hotkey(app, &normalized);
    }
    let current = registered_shortcut();
    if current == Some(requested) {
        // Already registered: only make sure the canonical value is persisted.
        return persist_hotkey(app, &normalized);
    }
    // Compare against the shortcut that is actually registered, not the
    // persisted one: after a failed startup registration the two differ, and
    // re-saving the same shortcut must retry the registration.
    if let Err(error) = request_command(HotkeyCommand::Register(requested)) {
        return SetHotkeyOutcome::Failed {
            shortcut: current
                .map(|shortcut| shortcut.label())
                .unwrap_or_else(|| normalized.clone()),
            error: error.message,
            hint: error.hint,
        };
    }
    persist_hotkey(app, &normalized)
}

/// Keeps the registered shortcut in sync with settings (`update_settings` /
/// `reset_settings` changed `quick.hotkey` or `quick.enabled`). The hotkey
/// thread is the single owner of the registration, so this is a cheap no-op
/// whenever nothing changed; failures are only logged (a conflicting shortcut
/// must never block saving settings).
pub fn sync_hotkey(app: &AppHandle, settings: &Settings) {
    let desired = if settings.quick.enabled {
        Some(parse_shortcut(&settings.quick.hotkey).unwrap_or_else(default_quick_shortcut))
    } else {
        None
    };
    if !settings.quick.enabled && is_visible(app) {
        // "关闭时面板不显示": hide immediately when the switch is turned off.
        hide(app);
    }
    if desired == registered_shortcut() {
        return;
    }
    let command = match desired {
        Some(shortcut) => HotkeyCommand::Register(shortcut),
        None => HotkeyCommand::Unregister,
    };
    match request_command(command) {
        Ok(()) => {
            let description = match desired {
                Some(shortcut) => format!("registered {}", shortcut.label()),
                None => "unregistered (disabled)".to_string(),
            };
            if let Some(state) = state_of(app) {
                state
                    .log
                    .info(&format!("quicktranslate hotkey synchronized: {description}"));
            }
        }
        Err(error) => log_warn(
            app,
            &format!(
                "quicktranslate hotkey sync failed: {} / {}",
                error.message, error.hint
            ),
        ),
    }
}

/// Asks the hotkey thread to apply `command` and waits (bounded) for the
/// result. Returns the thread's message + hint on failure.
fn request_command(command: HotkeyCommand) -> Result<(), EngineError> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW;

    let thread_id = HOTKEY_THREAD_ID.load(Ordering::SeqCst);
    if thread_id == 0 {
        return Err(EngineError::new(
            "快捷翻译快捷键服务尚未就绪。",
            "请重启程序后重试。",
        ));
    }
    let (sender, receiver) = mpsc::channel();
    *lock(&PENDING_HOTKEY) = Some(HotkeyRequest {
        command,
        reply: sender,
    });
    let posted =
        unsafe { PostThreadMessageW(thread_id, HOTKEY_RELOAD_MESSAGE, WPARAM(0), LPARAM(0)) };
    if posted.is_err() {
        *lock(&PENDING_HOTKEY) = None;
        return Err(EngineError::new(
            "无法通知快捷翻译快捷键服务。",
            "请重试；若仍失败请重启程序。",
        ));
    }
    match receiver.recv_timeout(Duration::from_millis(1_500)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(_) => {
            *lock(&PENDING_HOTKEY) = None;
            Err(EngineError::new(
                "快捷键更新超时。",
                "请重试；若仍失败请重启程序。",
            ))
        }
    }
}

/// Registers `new` after unregistering the old shortcut; when registration
/// fails the previous shortcut is restored so the app never loses its hotkey.
fn swap_hotkey<U, R>(
    unregister: U,
    previous: Option<Shortcut>,
    new: Shortcut,
    mut register: R,
) -> Result<(), EngineError>
where
    U: FnOnce(),
    R: FnMut(Shortcut) -> bool,
{
    unregister();
    if register(new) {
        return Ok(());
    }
    if let Some(previous) = previous {
        let _ = register(previous);
    }
    Err(EngineError::new(
        "快捷键注册失败（可能已被其他程序占用）",
        "请换一个组合键后重试",
    ))
}

/// Registers the quick-translate hotkey on a dedicated Windows message thread.
/// The thread also handles `WM_APP+2` re-registration/unregistration commands
/// triggered by `quick_set_hotkey` and `update_settings`, so changing or
/// disabling the shortcut never restarts the app.
pub fn start_hotkey_listener(app: AppHandle) {
    let thread_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("lexora-quick-hotkey".to_string())
        .spawn(move || {
            use windows::Win32::System::Threading::GetCurrentThreadId;
            use windows::Win32::UI::Input::KeyboardAndMouse::{
                RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS,
            };
            use windows::Win32::UI::WindowsAndMessaging::{
                GetMessageW, PeekMessageW, MSG, PM_NOREMOVE, WM_HOTKEY,
            };

            fn register(shortcut: Shortcut) -> windows::core::Result<()> {
                let (modifiers, virtual_key) = crate::capture::native_hotkey(shortcut);
                unsafe {
                    RegisterHotKey(None, HOTKEY_ID, HOT_KEY_MODIFIERS(modifiers), virtual_key)
                }
            }

            let thread_id = unsafe { GetCurrentThreadId() };
            // Create the thread's message queue before registering the hotkey or
            // publishing the thread id: `PostThreadMessageW` (used by the
            // commands) only works once the queue exists.
            let mut queue_message = MSG::default();
            unsafe {
                let _ = PeekMessageW(&mut queue_message, None, 0, 0, PM_NOREMOVE);
            }

            // Startup registration follows `quick.enabled`; a conflict is only
            // logged so it never blocks the app (contract §3).
            let quick = thread_app
                .try_state::<Arc<AppState>>()
                .map(|state| state.settings.get().quick);
            let initial = match quick {
                Some(quick) if quick.enabled => {
                    Some(parse_shortcut(&quick.hotkey).unwrap_or_else(default_quick_shortcut))
                }
                Some(_) => None,
                // State is not registered yet: keep the default hotkey instead
                // of silently losing the panel.
                None => Some(default_quick_shortcut()),
            };
            match initial {
                Some(shortcut) => match register(shortcut) {
                    Ok(()) => {
                        *lock(&CURRENT_HOTKEY) = Some(shortcut);
                        if let Some(log) = log_of(&thread_app) {
                            log.info(&format!(
                                "quicktranslate hotkey registered: {}",
                                shortcut.label()
                            ));
                        }
                    }
                    Err(error) => {
                        *lock(&CURRENT_HOTKEY) = None;
                        if let Some(log) = log_of(&thread_app) {
                            log.warn(&format!(
                                "quicktranslate hotkey {} registration failed: {error:?}",
                                shortcut.label()
                            ));
                        }
                    }
                },
                None => {
                    if let Some(log) = log_of(&thread_app) {
                        log.info("quicktranslate hotkey not registered: panel disabled");
                    }
                }
            }
            HOTKEY_THREAD_ID.store(thread_id, Ordering::SeqCst);

            loop {
                let mut message = MSG::default();
                let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
                if result.0 <= 0 {
                    break;
                }
                if message.message == HOTKEY_RELOAD_MESSAGE {
                    let Some(request) = lock(&PENDING_HOTKEY).take() else {
                        continue;
                    };
                    match request.command {
                        HotkeyCommand::Register(shortcut) => {
                            let previous = registered_shortcut();
                            let outcome = swap_hotkey(
                                || unsafe {
                                    let _ = UnregisterHotKey(None, HOTKEY_ID);
                                },
                                previous,
                                shortcut,
                                |shortcut| register(shortcut).is_ok(),
                            );
                            match outcome {
                                Ok(()) => {
                                    *lock(&CURRENT_HOTKEY) = Some(shortcut);
                                    if let Some(log) = log_of(&thread_app) {
                                        log.info(&format!(
                                            "quicktranslate hotkey registered: {}",
                                            shortcut.label()
                                        ));
                                    }
                                    let _ = request.reply.send(Ok(()));
                                }
                                Err(error) => {
                                    if let Some(log) = log_of(&thread_app) {
                                        log.warn(&format!(
                                            "quicktranslate hotkey {} rejected: {}",
                                            shortcut.label(),
                                            error.message
                                        ));
                                    }
                                    let _ = request.reply.send(Err(error));
                                }
                            }
                        }
                        HotkeyCommand::Unregister => {
                            unsafe {
                                let _ = UnregisterHotKey(None, HOTKEY_ID);
                            }
                            *lock(&CURRENT_HOTKEY) = None;
                            if let Some(log) = log_of(&thread_app) {
                                log.info("quicktranslate hotkey unregistered: panel disabled");
                            }
                            let _ = request.reply.send(Ok(()));
                        }
                    }
                    continue;
                }
                if message.message != WM_HOTKEY {
                    continue;
                }
                if message.wParam.0 as i32 != HOTKEY_ID {
                    continue;
                }
                let app = thread_app.clone();
                tauri::async_runtime::spawn(async move {
                    toggle(&app);
                });
            }

            unsafe {
                let _ = UnregisterHotKey(None, HOTKEY_ID);
            }
            *lock(&CURRENT_HOTKEY) = None;
            HOTKEY_THREAD_ID.store(0, Ordering::SeqCst);
        });
    if let Err(error) = spawned {
        log_warn(
            &app,
            &format!("could not start quicktranslate hotkey thread: {error}"),
        );
    }
}

fn log_of(app: &AppHandle) -> Option<crate::logger::Logger> {
    state_of(app).map(|state| state.log.clone())
}

// ---------------------------------------------------------------------------
// History store (contract §5)
// ---------------------------------------------------------------------------

/// One quick-translation history record.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct HistoryEntry {
    /// `<yyyymmdd-hhmmss>-<6 hex>`, see [`new_entry_id`].
    pub id: String,
    /// Original text (up to [`HISTORY_TEXT_MAX_CHARS`]).
    pub source: String,
    /// Full streamed translation.
    pub target: String,
    /// [`detect_source_lang`] result.
    pub source_lang: String,
    /// Translation target that was used.
    pub target_lang: String,
    /// Unix epoch milliseconds.
    pub created_at: u64,
    /// Stream duration reported by the `done` event.
    pub elapsed_ms: u64,
}

/// On-disk shape of `quick-history.json`.
#[derive(Debug, Serialize, Deserialize)]
struct HistoryFile {
    #[serde(default = "history_version")]
    version: u32,
    #[serde(default)]
    entries: Vec<HistoryEntry>,
}

fn history_version() -> u32 {
    HISTORY_VERSION
}

/// Thread-safe, atomically persisted quick-translation history. Entries are
/// kept newest-first; adding one trims the list to [`MAX_HISTORY`].
pub struct HistoryStore {
    file: PathBuf,
    entries: Mutex<Vec<HistoryEntry>>,
}

impl HistoryStore {
    /// Loads the store read-only: a missing file is an empty history, a
    /// corrupted one is backed up as `.broken` and also treated as empty.
    pub fn load(file: PathBuf) -> Self {
        let entries = load_entries(&file);
        Self {
            file,
            entries: Mutex::new(entries),
        }
    }

    pub fn file(&self) -> &Path {
        self.file.as_path()
    }

    /// Newest first.
    pub fn list(&self) -> Vec<HistoryEntry> {
        lock(&self.entries).clone()
    }

    /// Inserts one completed translation at the front and persists. Text is
    /// clamped to [`HISTORY_TEXT_MAX_CHARS`] here too, so a caller cannot bloat
    /// the file even if it forgot the panel input limit. The in-memory list is
    /// only replaced after the atomic write succeeded.
    pub fn add(&self, entry: HistoryEntry) -> Result<(), String> {
        let mut entries = lock(&self.entries);
        let entry = HistoryEntry {
            source: crate::engine::truncate_chars(&entry.source, HISTORY_TEXT_MAX_CHARS),
            target: crate::engine::truncate_chars(&entry.target, HISTORY_TEXT_MAX_CHARS),
            ..entry
        };
        let mut next = Vec::with_capacity(entries.len() + 1);
        next.push(entry);
        next.extend(entries.iter().cloned());
        next.truncate(MAX_HISTORY);
        self.persist(&next)?;
        *entries = next;
        Ok(())
    }

    /// Removes one entry; returns whether it existed.
    pub fn delete(&self, id: &str) -> Result<bool, String> {
        let mut entries = lock(&self.entries);
        if !entries.iter().any(|entry| entry.id == id) {
            return Ok(false);
        }
        let mut next = entries.clone();
        next.retain(|entry| entry.id != id);
        self.persist(&next)?;
        *entries = next;
        Ok(true)
    }

    /// Removes every entry (and persists the empty file).
    pub fn clear(&self) -> Result<(), String> {
        let mut entries = lock(&self.entries);
        self.persist(&[])?;
        entries.clear();
        Ok(())
    }

    fn persist(&self, entries: &[HistoryEntry]) -> Result<(), String> {
        let data = HistoryFile {
            version: HISTORY_VERSION,
            entries: entries.to_vec(),
        };
        let json = serde_json::to_string_pretty(&data)
            .map_err(|error| format!("序列化翻译历史失败：{error}"))?;
        let tmp = self.file.with_extension("json.tmp");
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("创建历史目录失败：{error}"))?;
        }
        std::fs::write(&tmp, json).map_err(|error| format!("写入翻译历史失败：{error}"))?;
        std::fs::rename(&tmp, self.file.as_path())
            .map_err(|error| format!("保存翻译历史失败：{error}"))
    }
}

fn load_entries(file: &Path) -> Vec<HistoryEntry> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    match serde_json::from_str::<HistoryFile>(&text) {
        Ok(data) => normalize_entries(data.entries),
        Err(error) => {
            // Preserve the unreadable file instead of silently overwriting it on
            // the next save, then continue with an empty history.
            let backup = file.with_extension("json.broken");
            let _ = std::fs::copy(file, &backup);
            eprintln!(
                "quick-history.json 解析失败，已备份为 {}：{error}",
                backup.display()
            );
            Vec::new()
        }
    }
}

/// Validates persisted entries: drops empty/duplicate records, clamps text and
/// unknown language codes, and enforces [`MAX_HISTORY`].
fn normalize_entries(entries: Vec<HistoryEntry>) -> Vec<HistoryEntry> {
    let mut normalized: Vec<HistoryEntry> = Vec::new();
    for entry in entries {
        if normalized.len() >= MAX_HISTORY {
            break;
        }
        let source = crate::engine::truncate_chars(&entry.source, HISTORY_TEXT_MAX_CHARS);
        let target = crate::engine::truncate_chars(&entry.target, HISTORY_TEXT_MAX_CHARS);
        if source.trim().is_empty() || target.trim().is_empty() {
            continue;
        }
        let id = {
            let id = entry.id.trim();
            if id.is_empty() {
                new_entry_id()
            } else {
                id.to_string()
            }
        };
        if normalized.iter().any(|current| current.id == id) {
            continue;
        }
        let source_lang = normalize_history_lang(&entry.source_lang, detect_source_lang(&source));
        let target_lang = normalize_history_lang(&entry.target_lang, DEFAULT_QUICK_TARGET_LANG);
        normalized.push(HistoryEntry {
            id,
            source,
            target,
            source_lang,
            target_lang,
            created_at: entry.created_at,
            elapsed_ms: entry.elapsed_ms,
        });
    }
    normalized
}

/// Keeps only concrete translation-language codes (`auto` is not a language).
fn normalize_history_lang(raw: &str, fallback: &str) -> String {
    let value = raw.trim().to_ascii_lowercase();
    if value != "auto" && TARGET_LANGS.contains(&value.as_str()) {
        value
    } else {
        fallback.to_string()
    }
}

/// Unix epoch milliseconds, the `createdAt` of a history entry.
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Monotonic part of generated history ids.
static ENTRY_SEQ: AtomicU64 = AtomicU64::new(0);

/// Creates a unique history id in the contract's shape
/// `<yyyymmdd-hhmmss>-<6 hex>` (local time + 6 random hex digits).
pub fn new_entry_id() -> String {
    let (year, month, day, hour, minute, second) = local_time_parts();
    // `RandomState` is seeded from OS entropy per process; mixing the clock and
    // a sequence keeps ids unique even within the same millisecond.
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0),
    );
    hasher.write_u64(ENTRY_SEQ.fetch_add(1, Ordering::Relaxed));
    let suffix = hasher.finish() & 0xFF_FFFF;
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}-{suffix:06x}")
}

/// Local wall-clock parts via `GetLocalTime` (no time-zone crate needed).
fn local_time_parts() -> (u16, u16, u16, u16, u16, u16) {
    let time = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    (
        time.wYear,
        time.wMonth,
        time.wDay,
        time.wHour,
        time.wMinute,
        time.wSecond,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(id: &str, source: &str) -> HistoryEntry {
        HistoryEntry {
            id: id.to_string(),
            source: source.to_string(),
            target: format!("译文：{source}"),
            source_lang: detect_source_lang(source).to_string(),
            target_lang: DEFAULT_QUICK_TARGET_LANG.to_string(),
            created_at: now_millis(),
            elapsed_ms: 842,
        }
    }

    fn temp_store() -> (HistoryStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = HistoryStore::load(dir.path().join(HISTORY_FILE_NAME));
        (store, dir)
    }

    #[test]
    fn detects_the_source_language_by_script_presence() {
        for (text, expected) in [
            ("这是一段中文文字。", "zh"),
            ("繁體中文也可以。", "zh"),
            ("日本語のテキストです", "ja"),
            ("漢字とかな", "ja"),
            ("これは中文 mixed 汉字", "ja"),
            ("한국어 텍스트입니다", "ko"),
            ("Русский текст", "ru"),
            ("نص عربي", "ar"),
            ("ข้อความภาษาไทย", "th"),
            ("यह हिंदी है", "hi"),
            ("טקסט עברי", "he"),
            ("This is English.", "en"),
            ("Hello 你好", "zh"),
            ("12345 !!!", "en"),
            ("", "en"),
            ("   ", "en"),
            // Katakana-only text is still Japanese.
            ("コンピュータ", "ja"),
            // Half-width katakana (alignment with the renderer heuristic).
            ("ｺﾝﾋﾟｭｰﾀ", "ja"),
            // Cyrillic wins in mixed text as long as no higher-priority script
            // (kana/Han/Hangul) is present.
            ("API документ", "ru"),
            // Han has a higher priority than Cyrillic, matching the renderer.
            ("API 接口 документ", "zh"),
        ] {
            assert_eq!(detect_source_lang(text), expected, "text={text:?}");
        }
        // The result is always a concrete `TARGET_LANGS` code, never `auto`.
        for text in ["中文", "hello", "こんにちは", "한국어", ""] {
            let code = detect_source_lang(text);
            assert!(TARGET_LANGS.contains(&code), "code={code}");
            assert_ne!(code, "auto");
        }
    }

    #[test]
    fn panel_size_follows_the_contract_limits() {
        // Normal 1080p work area: the height is only capped at 760.
        assert_eq!(clamp_panel_size(900.0, 640.0, 1040.0), (900.0, 640.0));
        assert_eq!(clamp_panel_size(100.0, 100.0, 1040.0), (640.0, 420.0));
        assert_eq!(clamp_panel_size(2_000.0, 2_000.0, 1040.0), (1_600.0, 760.0));
        // The height follows the current monitor work area (`work - 80`).
        assert_eq!(clamp_panel_size(900.0, 700.0, 800.0), (900.0, 700.0));
        assert_eq!(clamp_panel_size(900.0, 750.0, 800.0), (900.0, 720.0));
        // Tiny work areas never invert the range: the minimum height wins.
        assert_eq!(clamp_panel_size(900.0, 700.0, 400.0), (900.0, 420.0));
        // Fractional CSS sizes are rounded to whole logical pixels.
        assert_eq!(clamp_panel_size(900.4, 640.6, 1040.0), (900.0, 641.0));
        // Physical conversion is scale-aware and never produces zero.
        assert_eq!(physical_length(900.0, 1.0), 900);
        assert_eq!(physical_length(900.0, 1.5), 1_350);
        assert_eq!(physical_length(900.0, 1.25), 1_125);
        assert_eq!(physical_length(0.0, 1.0), 1);
    }

    #[test]
    fn history_is_newest_first_and_capped_at_the_limit() {
        let (store, dir) = temp_store();
        for index in 0..(MAX_HISTORY + 5) {
            store
                .add(sample_entry(&format!("id-{index}"), &format!("source {index}")))
                .unwrap();
        }
        let entries = store.list();
        assert_eq!(entries.len(), MAX_HISTORY);
        assert_eq!(entries[0].id, format!("id-{}", MAX_HISTORY + 4));
        assert_eq!(entries[MAX_HISTORY - 1].id, "id-5");

        // Reloading from disk keeps the same order/limit (newest first).
        let reloaded = HistoryStore::load(dir.path().join(HISTORY_FILE_NAME));
        assert_eq!(reloaded.list(), entries);
        // The atomic tmp file never stays behind.
        assert!(!dir.path().join("quick-history.json.tmp").exists());

        // The on-disk shape matches the contract: version 1 + camelCase fields.
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(store.file()).unwrap()).unwrap();
        assert_eq!(value["version"], 1);
        let first = &value["entries"][0];
        assert_eq!(first["id"], format!("id-{}", MAX_HISTORY + 4));
        assert_eq!(first["sourceLang"], "en");
        assert_eq!(first["targetLang"], "zh");
        assert!(first["createdAt"].as_u64().unwrap() > 0);
        assert_eq!(first["elapsedMs"], 842);
    }

    #[test]
    fn history_delete_and_clear_persist() {
        let (store, dir) = temp_store();
        store.add(sample_entry("id-a", "hello")).unwrap();
        store.add(sample_entry("id-b", "你好")).unwrap();
        assert_eq!(store.list().len(), 2);

        assert!(store.delete("id-b").unwrap());
        assert_eq!(store.list().len(), 1);
        assert!(!store.delete("missing").unwrap());
        let reloaded = HistoryStore::load(dir.path().join(HISTORY_FILE_NAME));
        assert_eq!(reloaded.list()[0].id, "id-a");

        store.clear().unwrap();
        assert!(store.list().is_empty());
        let reloaded = HistoryStore::load(dir.path().join(HISTORY_FILE_NAME));
        assert!(reloaded.list().is_empty());
        assert!(reloaded.add(sample_entry("id-c", "after clear")).is_ok());
        assert_eq!(reloaded.list().len(), 1);
    }

    #[test]
    fn corrupted_history_is_backed_up_and_treated_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(HISTORY_FILE_NAME);
        std::fs::write(&path, "{not valid json").unwrap();
        let store = HistoryStore::load(path.clone());
        assert!(store.list().is_empty());
        let backup = path.with_extension("json.broken");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "{not valid json");

        // A later save overwrites the history file, never the backup.
        store.add(sample_entry("id-1", "hello")).unwrap();
        assert!(store.list()[0].id == "id-1");
        assert_eq!(std::fs::read_to_string(backup).unwrap(), "{not valid json");
    }

    #[test]
    fn history_load_normalizes_invalid_and_duplicate_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(HISTORY_FILE_NAME);
        std::fs::write(
            &path,
            serde_json::json!({
                "version": 1,
                "entries": [
                    {"id": "id-1", "source": "  hello  ", "target": "你好",
                     "sourceLang": "auto", "targetLang": "xx", "createdAt": 1, "elapsedMs": 2},
                    // Duplicate id: dropped.
                    {"id": "id-1", "source": "dup", "target": "dup",
                     "sourceLang": "en", "targetLang": "zh", "createdAt": 3, "elapsedMs": 4},
                    // Empty content: dropped.
                    {"id": "id-2", "source": "   ", "target": "x",
                     "sourceLang": "en", "targetLang": "zh", "createdAt": 5, "elapsedMs": 6},
                    // Missing id/created fields fall back safely.
                    {"source": "中文", "target": "Chinese", "createdAt": 7, "elapsedMs": 8}
                ]
            })
            .to_string(),
        )
        .unwrap();
        let entries = HistoryStore::load(path).list();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, "id-1");
        // `auto` is not a concrete language: the source is re-detected.
        assert_eq!(entries[0].source_lang, "en");
        assert_eq!(entries[0].target_lang, DEFAULT_QUICK_TARGET_LANG);
        assert_eq!(entries[1].source_lang, "zh");
        assert!(!entries[1].id.is_empty());
        assert_eq!(entries[1].source, "中文");
    }

    #[test]
    fn history_entries_are_truncated_to_the_input_limit() {
        let long_source = "源".repeat(HISTORY_TEXT_MAX_CHARS + 100);
        let long_target = "译".repeat(HISTORY_TEXT_MAX_CHARS + 100);
        let entry = HistoryEntry {
            id: "id-long".to_string(),
            source: long_source,
            target: long_target,
            source_lang: "zh".to_string(),
            target_lang: "en".to_string(),
            created_at: 1,
            elapsed_ms: 2,
        };
        let (store, _dir) = temp_store();
        store.add(entry).unwrap();
        let stored = &store.list()[0];
        assert_eq!(stored.source.chars().count(), HISTORY_TEXT_MAX_CHARS);
        assert_eq!(stored.target.chars().count(), HISTORY_TEXT_MAX_CHARS);
    }

    #[test]
    fn history_ids_follow_the_contract_shape() {
        let id = new_entry_id();
        assert_eq!(id.chars().count(), 22, "id={id}");
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 3, "id={id}");
        assert_eq!(parts[0].len(), 8);
        assert_eq!(parts[1].len(), 6);
        assert_eq!(parts[2].len(), 6);
        assert!(parts[0].chars().all(|c| c.is_ascii_digit()), "id={id}");
        assert!(parts[1].chars().all(|c| c.is_ascii_digit()), "id={id}");
        assert!(parts[2].chars().all(|c| c.is_ascii_hexdigit()), "id={id}");
        assert_eq!(parts[2], parts[2].to_ascii_lowercase(), "id={id}");
        // Ids stay unique even within one millisecond.
        let first = new_entry_id();
        let second = new_entry_id();
        assert_ne!(first, second);
    }
}
