//! Picker / settings window geometry and lifecycle.
//!
//! Geometry rules (see `docs/research-tauri.md` §2):
//!
//! * the selection anchor and the monitor work area are **physical** pixels,
//!   exactly as reported by the UI Automation / input hooks, so they are fed
//!   straight into `PhysicalPosition` / `PhysicalSize` — no logical conversion;
//! * the picker base size (440 × 56) is a **logical** (CSS) size and is scaled
//!   by the DPI factor of the monitor under the anchor;
//! * the preferred spot is just below the selection, `anchor_x - 40 * scale`;
//!   when the panel would leave the work area it flips above the anchor and is
//!   clamped back inside.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

use crate::selection::PickerPayload;
use crate::state::AppState;
use crate::win32;

pub const PICKER_LABEL: &str = "picker";
pub const SETTINGS_LABEL: &str = "settings";

/// Base toolbar size in logical (CSS) pixels, matching `tauri.conf.json`.
const BASE_WIDTH: f64 = 440.0;
const BASE_HEIGHT: f64 = 56.0;
/// Bounds accepted by `resize_picker`, in logical pixels (contract §6.3).
const MIN_WIDTH: f64 = 200.0;
const MAX_WIDTH: f64 = 780.0;
const MIN_HEIGHT: f64 = 40.0;
const MAX_HEIGHT: f64 = 620.0;
/// Horizontal offset of the toolbar's left edge from the selection anchor.
const ANCHOR_LEFT_OFFSET: f64 = 40.0;
/// Vertical gap between selection and toolbar.
const ANCHOR_GAP: f64 = 12.0;
/// Ignore blur events right after showing: `show()` + `set_focus()` races.
const FOCUS_GUARD: Duration = Duration::from_millis(250);
const EVENT_PICKER_DATA: &str = "picker-data";
const EVENT_PICKER_HIDDEN: &str = "picker-hidden";

/// Payload pushed to the picker renderer, contract §5.3.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerData {
    pub text: String,
    pub program_name: String,
    pub config: serde_json::Value,
}

impl From<&PickerPayload> for PickerData {
    fn from(payload: &PickerPayload) -> Self {
        Self {
            text: payload.text.clone(),
            program_name: payload.program_name.clone(),
            config: payload.config.clone(),
        }
    }
}

/// Last payload, kept so `picker_ready` can replay a selection captured while
/// the webview was still loading.
static PENDING: Mutex<Option<PickerData>> = Mutex::new(None);
/// Instant of the last `show_picker`, used to swallow the show/blur race.
static LAST_SHOWN: Mutex<Option<Instant>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// Settings window
// ---------------------------------------------------------------------------

/// Shows and focuses the settings window (also restores it from minimized).
pub fn show_settings(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(SETTINGS_LABEL) else {
        log_warn(app, "settings window missing");
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn hide_settings(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.hide();
    }
}

// ---------------------------------------------------------------------------
// Picker window
// ---------------------------------------------------------------------------

/// True while a freshly shown picker must ignore blur events.
pub fn show_guard_active() -> bool {
    lock(&LAST_SHOWN)
        .as_ref()
        .map(|shown| shown.elapsed() < FOCUS_GUARD)
        .unwrap_or(false)
}

/// Blur handling shared by the window-event hook: keep the picker when the user
/// pinned it, or when it was just shown and has not received focus yet.
pub fn handle_picker_blur(app: &tauri::AppHandle) {
    if show_guard_active() {
        return;
    }
    let pinned = state(app)
        .map(|state| state.selection.is_panel_pinned())
        .unwrap_or(false);
    if pinned {
        return;
    }
    if is_picker_visible(app) {
        hide_picker(app);
    }
}

/// Positions the transparent picker at the selection anchor and shows it.
/// Returns `false` when the picker window is missing.
pub fn show_picker(app: &tauri::AppHandle, payload: &PickerPayload) -> bool {
    let Some(window) = app.get_webview_window(PICKER_LABEL) else {
        log_warn(app, "picker window missing");
        return false;
    };

    let mut scale = payload.scale_factor;
    if !scale.is_finite() || scale < 0.5 || scale > 8.0 {
        scale = window.scale_factor().unwrap_or(1.0);
    }
    let scale = if scale.is_finite() && scale > 0.1 {
        scale
    } else {
        1.0
    };

    let (anchor_x, anchor_y) = (payload.anchor_x, payload.anchor_y);
    let work = win32::work_area_physical(anchor_x, anchor_y);

    let width = ((BASE_WIDTH * scale).round() as i32).max(1);
    let height = ((BASE_HEIGHT * scale).round() as i32).max(1);
    let left_offset = (ANCHOR_LEFT_OFFSET * scale).round() as i32;
    let gap = (ANCHOR_GAP * scale).round() as i32;

    // Preferred: below the selection, shifted left so the toolbar centres under
    // the start of the selected word.
    let mut x = anchor_x - left_offset;
    let mut y = anchor_y + gap;
    let mut placement = "below";

    let max_x = work.right - width;
    if max_x >= work.left {
        x = x.clamp(work.left, max_x);
    } else {
        x = work.left;
    }

    if y + height > work.bottom {
        // No room below: flip above the selection.
        y = anchor_y - height - gap;
        placement = "above";
    }
    let max_y = work.bottom - height;
    if max_y >= work.top {
        y = y.clamp(work.top, max_y);
    } else {
        y = work.top;
    }

    // Resize/reposition while hidden, then show (avoids transient artifacts).
    let _ = window.set_size(PhysicalSize::new(width as u32, height as u32));
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let was_visible = window.is_visible().unwrap_or(false);
    if !was_visible {
        let _ = window.show();
    }
    let _ = window.set_focus();

    *lock(&LAST_SHOWN) = Some(Instant::now());

    // A new selection always starts un-pinned and aborts a running stream.
    if let Some(state) = state(app) {
        state.abort_translate();
        state.selection.set_panel_pinned(false);
        state.selection.set_picker_visible(true);
        state.log.info(&format!(
            "picker shown at physical=({x},{y}) size={width}x{height} scale={scale:.3} \
             anchor=({anchor_x},{anchor_y}) placement={placement} text_chars={}",
            payload.text.chars().count()
        ));
    }

    let data = PickerData::from(payload);
    *lock(&PENDING) = Some(data.clone());
    let _ = app.emit_to(PICKER_LABEL, EVENT_PICKER_DATA, data);
    true
}

/// Hides the picker and tells the renderer to reset its state.
pub fn hide_picker(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(PICKER_LABEL) else {
        return;
    };
    let was_visible = window.is_visible().unwrap_or(false);
    if was_visible {
        let _ = window.hide();
    }
    *lock(&PENDING) = None;
    let _ = app.emit_to(PICKER_LABEL, EVENT_PICKER_HIDDEN, serde_json::json!({}));
    if let Some(state) = state(app) {
        state.selection.set_picker_visible(false);
        state.selection.set_panel_pinned(false);
        state.abort_translate();
        if was_visible {
            state.log.info("picker hidden");
        }
    }
}

pub fn is_picker_visible(app: &tauri::AppHandle) -> bool {
    app.get_webview_window(PICKER_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

pub fn picker_scale_factor(app: &tauri::AppHandle) -> f64 {
    app.get_webview_window(PICKER_LABEL)
        .and_then(|window| window.scale_factor().ok())
        .filter(|scale| scale.is_finite() && *scale > 0.1)
        .unwrap_or(1.0)
}

/// Takes the payload buffered by `show_picker` (used by `picker_ready`).
pub fn take_pending() -> Option<PickerData> {
    lock(&PENDING).take()
}

/// Applies clamped bounds requested by the picker renderer (menus/panels need a
/// bigger surface). `width`/`height` are logical pixels. Returns the final
/// bounds in logical pixels.
pub fn resize_picker(app: &tauri::AppHandle, width: f64, height: f64) -> Option<serde_json::Value> {
    let window = app.get_webview_window(PICKER_LABEL)?;
    let scale = window
        .scale_factor()
        .ok()
        .filter(|scale| scale.is_finite() && *scale > 0.1)
        .unwrap_or(1.0);

    let logical_width = clamp_dimension(width, MIN_WIDTH, MAX_WIDTH, BASE_WIDTH);
    let logical_height = clamp_dimension(height, MIN_HEIGHT, MAX_HEIGHT, BASE_HEIGHT);
    let physical_width = ((logical_width * scale).round() as i32).max(1);
    let physical_height = ((logical_height * scale).round() as i32).max(1);

    let current = window
        .outer_position()
        .unwrap_or(PhysicalPosition::new(0, 0));
    let center_x = current.x + (physical_width / 2).max(1);
    let center_y = current.y + (physical_height / 2).max(1);
    let work = win32::work_area_physical(center_x, center_y);

    let mut x = current.x;
    let mut y = current.y;
    let max_x = work.right - physical_width;
    if max_x >= work.left {
        x = x.clamp(work.left, max_x);
    } else {
        x = work.left;
    }
    let max_y = work.bottom - physical_height;
    if max_y >= work.top {
        y = y.clamp(work.top, max_y);
    } else {
        y = work.top;
    }

    let _ = window.set_size(PhysicalSize::new(
        physical_width as u32,
        physical_height as u32,
    ));
    let _ = window.set_position(PhysicalPosition::new(x, y));

    if let Some(state) = state(app) {
        state.log.info(&format!(
            "picker resized to logical={logical_width:.0}x{logical_height:.0} \
             physical={physical_width}x{physical_height} at ({x},{y})"
        ));
    }

    Some(serde_json::json!({
        "x": x as f64 / scale,
        "y": y as f64 / scale,
        "width": logical_width,
        "height": logical_height,
    }))
}

/// Clamps a renderer-provided dimension; `NaN`/infinite fall back to `base`.
fn clamp_dimension(value: f64, min: f64, max: f64, base: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        return base;
    }
    value.round().clamp(min, max)
}

fn state(app: &tauri::AppHandle) -> Option<tauri::State<'_, std::sync::Arc<AppState>>> {
    app.try_state::<std::sync::Arc<AppState>>()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn log_warn(app: &tauri::AppHandle, message: &str) {
    if let Some(state) = state(app) {
        state.log.warn(message);
    }
}

#[cfg(test)]
mod tests {
    use super::clamp_dimension;

    #[test]
    fn dimensions_are_clamped() {
        assert_eq!(clamp_dimension(120.0, 200.0, 780.0, 440.0), 200.0);
        assert_eq!(clamp_dimension(900.0, 200.0, 780.0, 440.0), 780.0);
        assert_eq!(clamp_dimension(f64::NAN, 40.0, 620.0, 56.0), 56.0);
        assert_eq!(clamp_dimension(-12.0, 40.0, 620.0, 56.0), 56.0);
        assert_eq!(clamp_dimension(321.4, 200.0, 780.0, 440.0), 321.0);
    }
}
