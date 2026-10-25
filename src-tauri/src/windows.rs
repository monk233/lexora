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
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::window::Color;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::selection::PickerPayload;
use crate::state::AppState;
use crate::win32;

pub const PICKER_LABEL: &str = "picker";
pub const SETTINGS_LABEL: &str = "settings";
/// Label prefix of the screenshot overlay windows (`capture-<monitor index>`).
pub const CAPTURE_PREFIX: &str = "capture-";

/// Base toolbar size in logical (CSS) pixels, matching `tauri.conf.json`.
const BASE_WIDTH: f64 = 440.0;
const BASE_HEIGHT: f64 = 56.0;
/// Safety ceiling for renderer-provided panel sizes (no product limit: panels
/// may grow to whatever the screen/UI needs, this only rejects absurd values).
const MAX_PANEL_DIMENSION: f64 = 100_000.0;
/// Horizontal offset of the toolbar's left edge from the selection anchor.
const ANCHOR_LEFT_OFFSET: f64 = 40.0;
/// Vertical gap between selection and toolbar.
const ANCHOR_GAP: f64 = 12.0;
/// Ignore blur events right after showing (the window can briefly report blur
/// while it is being shown without activating).
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

/// Hides the settings window. Returns whether it was actually visible, so the
/// screenshot flow can skip its "wait until our windows are gone" pause on the
/// common path where nothing is on screen.
pub fn hide_settings(app: &tauri::AppHandle) -> bool {
    let Some(window) = app.get_webview_window(SETTINGS_LABEL) else {
        return false;
    };
    let was_visible = window.is_visible().unwrap_or(false);
    if was_visible {
        let _ = window.hide();
    }
    was_visible
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
/// pinned it, while a screenshot is being taken (the picker stays open on
/// purpose, contract §10.1), or when it was just shown and has not received
/// focus yet.
pub fn handle_picker_blur(app: &tauri::AppHandle) {
    if capture_active(app) {
        return;
    }
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
    // The picker is configured as a non-activating window (`focusable: false`),
    // so `show()` never steals keyboard focus from the application the user is
    // working in. Do not call `set_focus()` here.
    let _ = window.set_size(PhysicalSize::new(width as u32, height as u32));
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let was_visible = window.is_visible().unwrap_or(false);
    if !was_visible {
        let _ = window.show();
    }

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

/// Hides the picker and tells the renderer to reset its state. Returns whether
/// the picker was actually visible (see [`hide_settings`]: the screenshot flow
/// only pauses when one of our windows really had to disappear from screen).
pub fn hide_picker(app: &tauri::AppHandle) -> bool {
    let Some(window) = app.get_webview_window(PICKER_LABEL) else {
        return false;
    };
    // The picker may have been made focusable for the follow-up input; make
    // sure a hidden picker never keeps keyboard focus.
    let _ = window.set_focusable(false);
    let was_visible = window.is_visible().unwrap_or(false);
    if was_visible {
        let _ = window.hide();
    }
    *lock(&PENDING) = None;
    let _ = app.emit_to(PICKER_LABEL, EVENT_PICKER_HIDDEN, serde_json::json!({}));
    if let Some(state) = state(app) {
        state.selection.set_panel_open(false);
        state.selection.set_picker_visible(false);
        state.selection.set_panel_pinned(false);
        state.abort_translate();
        if was_visible {
            state.log.info("picker hidden");
        }
    }
    was_visible
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

/// Applies renderer-requested bounds (menus/panels need a bigger surface).
/// `width`/`height` are logical pixels; there is no product size limit anymore,
/// only basic sanitizing (`NaN`/infinite/<=0 fall back to the base size, at
/// least 1 px, absurd values capped by [`MAX_PANEL_DIMENSION`]). The window is
/// kept inside the work area of the monitor under it. Returns the final bounds
/// in logical pixels.
pub fn resize_picker(app: &tauri::AppHandle, width: f64, height: f64) -> Option<serde_json::Value> {
    let window = app.get_webview_window(PICKER_LABEL)?;
    let scale = window
        .scale_factor()
        .ok()
        .filter(|scale| scale.is_finite() && *scale > 0.1)
        .unwrap_or(1.0);

    let logical_width = sanitize_dimension(width, BASE_WIDTH);
    let logical_height = sanitize_dimension(height, BASE_HEIGHT);
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

/// Moves the picker window by a logical-pixel delta (panel header drag) and
/// clamps it inside the work area. Returns the new logical top-left position.
pub fn move_picker_by(app: &tauri::AppHandle, dx: f64, dy: f64) -> Option<(f64, f64)> {
    let window = app.get_webview_window(PICKER_LABEL)?;
    if !window.is_visible().unwrap_or(false) {
        return None;
    }
    let scale = window
        .scale_factor()
        .ok()
        .filter(|scale| scale.is_finite() && *scale > 0.1)
        .unwrap_or(1.0);
    let current = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let mut x = current.x + (dx * scale).round() as i32;
    let mut y = current.y + (dy * scale).round() as i32;

    let work = win32::work_area_physical(
        current.x + size.width as i32 / 2,
        current.y + size.height as i32 / 2,
    );
    let max_x = work.right - size.width as i32;
    x = if max_x >= work.left {
        x.clamp(work.left, max_x)
    } else {
        work.left
    };
    let max_y = work.bottom - size.height as i32;
    y = if max_y >= work.top {
        y.clamp(work.top, max_y)
    } else {
        work.top
    };

    let _ = window.set_position(PhysicalPosition::new(x, y));
    Some((x as f64 / scale, y as f64 / scale))
}

/// Sanitizes a renderer-provided dimension. There is no product min/max: only
/// non-finite/non-positive values fall back to `base`, the value is rounded and
/// clamped to `1..=MAX_PANEL_DIMENSION` so it can never break the window API.
fn sanitize_dimension(value: f64, base: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        return base;
    }
    value.round().clamp(1.0, MAX_PANEL_DIMENSION)
}

fn state(app: &tauri::AppHandle) -> Option<tauri::State<'_, std::sync::Arc<AppState>>> {
    app.try_state::<std::sync::Arc<AppState>>()
}

/// Whether a screenshot overlay is currently waiting for input. While active the
/// picker/settings stay open and ordinary input must not dismiss them.
fn capture_active(app: &tauri::AppHandle) -> bool {
    state(app)
        .map(|state| state.selection.is_capture_active())
        .unwrap_or(false)
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

// ---------------------------------------------------------------------------
// Screenshot overlay windows
// ---------------------------------------------------------------------------

/// Physical bounds of one overlay window: monitor origin and size exactly as
/// reported by `xcap` (physical pixels). The overlay window is borderless and
/// transparent, so its bounds are identical to the monitor rectangle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureGeometry {
    pub index: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl CaptureGeometry {
    pub fn label(&self) -> String {
        format!("{CAPTURE_PREFIX}{}", self.index)
    }
}

/// Compares the monitor layout the overlay windows were created for with the
/// current one. Identical count/indices/origins/sizes → the already loaded
/// webviews are reused; any difference → they must be destroyed and recreated
/// (contract §10.1).
pub fn layout_matches(previous: &[CaptureGeometry], next: &[CaptureGeometry]) -> bool {
    previous == next
}

/// Creates one transparent, borderless full-monitor overlay window hosting
/// `capture.html?monitor=<index>`.
///
/// The window is created **hidden** and fully transparent (`transparent(true)`,
/// transparent background color, no shadow), so showing it later never flashes
/// a black or white surface before the renderer has painted the pre-encoded
/// JPEG (contract §10.1). Coordinates/sizes are physical pixels from `xcap`.
pub fn create_capture_window(
    app: &tauri::AppHandle,
    geometry: CaptureGeometry,
) -> tauri::Result<()> {
    let label = geometry.label();
    let window = WebviewWindowBuilder::new(
        app,
        label.as_str(),
        WebviewUrl::App(format!("capture.html?monitor={}", geometry.index).into()),
    )
    .title("Lexora 截图")
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .shadow(false)
    .visible(false)
    .background_color(Color(0, 0, 0, 0))
    // Keep the hidden renderer scheduled: its `capture-armed` handler has to
    // fetch and paint the next screenshot while the window is still hidden, so
    // `capture_ready` can show it with the pixels already on screen.
    .background_throttling(BackgroundThrottlingPolicy::Disabled)
    .build()?;
    window.set_position(PhysicalPosition::new(geometry.x, geometry.y))?;
    window.set_size(PhysicalSize::new(
        geometry.width.max(1),
        geometry.height.max(1),
    ))?;
    Ok(())
}

/// Extracts the monitor index from a `capture-<index>` window label.
fn capture_index(label: &str) -> Option<u32> {
    label.strip_prefix(CAPTURE_PREFIX)?.parse::<u32>().ok()
}

/// Shows one overlay window once its renderer has painted the screenshot. The
/// first monitor also receives keyboard focus so Escape / arrow keys work.
/// Returns `false` when the window does not exist (capture already closed).
pub fn show_capture_window(app: &tauri::AppHandle, index: u32) -> bool {
    let Some(window) = app.get_webview_window(&format!("{CAPTURE_PREFIX}{index}")) else {
        return false;
    };
    let _ = window.show();
    if index == 0 {
        let _ = window.set_focus();
    }
    true
}

/// Fallback used 2.5 s after `capture_start`: shows every overlay even when a
/// renderer never sent `capture_ready`.
pub fn show_all_capture_windows(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        if capture_index(&label).is_none() {
            continue;
        }
        let _ = window.show();
    }
    // Focus monitor 0 last so it wins over the other overlays.
    if let Some(window) = app.get_webview_window(&format!("{CAPTURE_PREFIX}0")) {
        let _ = window.set_focus();
    }
}

/// Hides every screenshot overlay window **without destroying it**, so the next
/// capture can reuse the already loaded webviews (contract §10.1). Returns
/// whether at least one overlay was visible, i.e. whether the caller has to
/// wait a moment before grabbing the screen so the overlay is really gone.
pub fn hide_capture_windows(app: &tauri::AppHandle) -> bool {
    let mut hid_any = false;
    for (label, window) in app.webview_windows() {
        if capture_index(&label).is_none() {
            continue;
        }
        if window.is_visible().unwrap_or(false) {
            hid_any = true;
        }
        let _ = window.hide();
    }
    hid_any
}

/// Destroys every screenshot overlay window (`capture-*` labels). Needed when
/// the monitor layout changed (the loaded webview no longer fits) and as the
/// explicit teardown path; normal closing only hides (contract §10.1).
pub fn destroy_capture_windows(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        if capture_index(&label).is_some() {
            let _ = window.destroy();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        capture_index, layout_matches, sanitize_dimension, CaptureGeometry, BASE_HEIGHT,
        BASE_WIDTH, MAX_PANEL_DIMENSION,
    };

    fn geometry(index: u32, x: i32, y: i32, width: u32, height: u32) -> CaptureGeometry {
        CaptureGeometry {
            index,
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn capture_labels_expose_their_monitor_index() {
        assert_eq!(capture_index("capture-0"), Some(0));
        assert_eq!(capture_index("capture-12"), Some(12));
        assert_eq!(capture_index("capture-"), None);
        assert_eq!(capture_index("capture-abc"), None);
        assert_eq!(capture_index("picker"), None);
        assert_eq!(
            geometry(3, -1920, 0, 1920, 1080).label(),
            "capture-3".to_string()
        );
    }

    #[test]
    fn overlay_layouts_are_reused_only_when_identical() {
        let single = [geometry(0, 0, 0, 3840, 2160)];
        // Same layout → reuse the existing webviews.
        assert!(layout_matches(&single, &single));
        assert!(layout_matches(&[], &[]));
        // Different monitor count (display connected/disconnected).
        assert!(!layout_matches(&single, &[]));
        // Different origin (monitor rearranged).
        assert!(!layout_matches(
            &single,
            &[geometry(0, 1920, 0, 3840, 2160)]
        ));
        // Different resolution / DPI-scaled size.
        assert!(!layout_matches(&single, &[geometry(0, 0, 0, 2560, 1440)]));
        // Different index ordering is a layout change too.
        assert!(!layout_matches(
            &[
                geometry(0, 0, 0, 1920, 1080),
                geometry(1, 1920, 0, 1920, 1080)
            ],
            &[
                geometry(1, 0, 0, 1920, 1080),
                geometry(0, 1920, 0, 1920, 1080)
            ]
        ));
    }

    #[test]
    fn dimensions_are_sanitized_without_product_limits() {
        // Non-finite / non-positive values fall back to the base size.
        assert_eq!(sanitize_dimension(f64::NAN, BASE_WIDTH), BASE_WIDTH);
        assert_eq!(sanitize_dimension(f64::INFINITY, BASE_HEIGHT), BASE_HEIGHT);
        assert_eq!(
            sanitize_dimension(f64::NEG_INFINITY, BASE_WIDTH),
            BASE_WIDTH
        );
        assert_eq!(sanitize_dimension(-12.0, BASE_HEIGHT), BASE_HEIGHT);
        assert_eq!(sanitize_dimension(0.0, BASE_WIDTH), BASE_WIDTH);
        // Rounding still applies.
        assert_eq!(sanitize_dimension(321.4, BASE_WIDTH), 321.0);
        assert_eq!(sanitize_dimension(321.6, BASE_WIDTH), 322.0);
        // The old 780x620 / 200x40 limits are gone: any positive size is valid.
        assert_eq!(sanitize_dimension(120.0, BASE_WIDTH), 120.0);
        assert_eq!(sanitize_dimension(900.0, BASE_WIDTH), 900.0);
        assert_eq!(sanitize_dimension(1200.0, BASE_HEIGHT), 1200.0);
        assert_eq!(sanitize_dimension(100_000.0, BASE_WIDTH), 100_000.0);
        // At least one pixel, and an absurd upper bound stays safe.
        assert_eq!(sanitize_dimension(0.4, BASE_WIDTH), 1.0);
        assert_eq!(sanitize_dimension(0.5, BASE_WIDTH), 1.0);
        assert_eq!(sanitize_dimension(1e12, BASE_WIDTH), MAX_PANEL_DIMENSION);
    }
}
