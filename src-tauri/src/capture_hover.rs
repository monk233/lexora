//! QQ-style screenshot snapping: the topmost window under the physical pointer.
//!
//! While a capture overlay is up the capture page polls [`capture_cursor`] (for
//! the physical cursor position and whether a session is still active) and, on
//! every mouse move, [`capture_hover_at`] to highlight the window the selection
//! would snap to. All coordinates are **physical pixels** in virtual-screen
//! space, matching the frozen screenshot and [`crate::win32`]; the overlay
//! converts them to its own CSS space through the monitor scale factor.
//!
//! `EnumWindows` walks top-level windows from front to back, so the first
//! candidate that contains the point is also the window a real click would hit
//! (QQ screenshot behavior).
//!
//! It also exposes [`capture_layout`]: the physical monitor layout of the active
//! capture session, so the capture page can keep a cross-monitor selection in
//! global virtual-screen coordinates.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

use crate::state::AppState;

/// Windows smaller than this many physical pixels (on either side) never become
/// a snap target: zero-size popups and hidden helper windows would otherwise
/// steal the selection.
const MIN_SNAP_SIDE: i32 = 8;

/// Shell windows that must never become a snap target: the taskbar, the desktop
/// (`Progman`) and its wallpaper hosts (`WorkerW`), plus the invisible
/// CoreWindow host of the Windows shell. Snapping to one of them would frame
/// the whole screen instead of an application.
const IGNORED_CLASSES: [&str; 4] = [
    "Shell_TrayWnd",
    "Progman",
    "WorkerW",
    "Windows.UI.Core.CoreWindow",
];

/// Snap rectangle returned to the capture page, in physical virtual-screen
/// pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HoverRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Physical bounds of a window in virtual-screen coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowBounds {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl WindowBounds {
    fn from_rect(rect: RECT) -> Self {
        Self {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }

    fn width(&self) -> i32 {
        self.right - self.left
    }

    fn height(&self) -> i32 {
        self.bottom - self.top
    }

    fn contains(&self, x: i32, y: i32) -> bool {
        rect_contains(self.left, self.top, self.right, self.bottom, x, y)
    }

    fn to_hover_rect(self) -> HoverRect {
        HoverRect {
            x: self.left,
            y: self.top,
            width: self.width(),
            height: self.height(),
        }
    }
}

/// Context passed through `EnumWindows`; `bounds` is the first match found.
struct HoverSearch {
    point: POINT,
    bounds: Option<WindowBounds>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Topmost snap-able top-level window under the physical screen point `(x, y)`.
///
/// Returns `{"ok": true, "rect": null}` when no capture session is active or the
/// point is over the desktop / taskbar; otherwise `rect` carries the physical
/// bounds `{x, y, width, height}` the capture page highlights.
#[tauri::command]
pub fn capture_hover_at(state: State<'_, Arc<AppState>>, x: i32, y: i32) -> Value {
    // Never enumerate windows outside a live screenshot session: the page may
    // still poll while its overlay is hidden between captures.
    if !state.capture.is_active() {
        return json!({ "ok": true, "rect": null });
    }
    match window_rect_at(x, y) {
        Some(rect) => json!({ "ok": true, "rect": rect }),
        None => json!({ "ok": true, "rect": null }),
    }
}

/// Physical cursor position plus whether a screenshot session is active.
///
/// The capture page polls this at animation-frame rate while the user frames
/// the region; it is a single cheap `GetCursorPos` call.
#[tauri::command]
pub fn capture_cursor(state: State<'_, Arc<AppState>>) -> Value {
    let (x, y) = crate::win32::cursor_physical();
    json!({ "ok": true, "x": x, "y": y, "active": state.capture.is_active() })
}

/// Physical monitor layout + virtual-screen bounds of the active capture
/// session:
/// `{"ok":true,"monitors":[{"index","x","y","width","height"},...],"bounds":{"x","y","width","height"}}`.
///
/// The capture page keeps its selection in these global virtual-screen pixels,
/// so one drag can cross monitor borders and be cropped by `globalRect`.
/// `{"ok":false,...}` means no session is armed (the page is stale).
#[tauri::command]
pub fn capture_layout(state: State<'_, Arc<AppState>>) -> Value {
    match state.capture.layout_snapshot() {
        Some(snapshot) => json!({
            "ok": true,
            "monitors": snapshot.monitors,
            "bounds": snapshot.bounds,
        }),
        None => json!({
            "ok": false,
            "error": "截图尚未准备好。",
            "hint": "请稍候片刻再试，或重新发起截图（快捷键）。",
        }),
    }
}

// ---------------------------------------------------------------------------
// Window hit testing
// ---------------------------------------------------------------------------

/// Reports the topmost snap-able top-level window under the physical point
/// `(x, y)`. `None` means desktop / taskbar / nothing worth snapping to.
///
/// Exposed for manual verification as well; [`capture_hover_at`] adds the
/// `{"ok": ...}` envelope plus the capture-session guard.
pub fn window_rect_at(x: i32, y: i32) -> Option<HoverRect> {
    let mut search = HoverSearch {
        point: POINT { x, y },
        bounds: None,
    };
    // SAFETY: the callback only dereferences `lparam`, which points at the live
    // `search` stack value; `EnumWindows` runs synchronously.
    unsafe {
        let _ = EnumWindows(
            Some(enum_window),
            LPARAM(&mut search as *mut HoverSearch as isize),
        );
    }
    search.bounds.map(WindowBounds::to_hover_rect)
}

/// `EnumWindows` callback: records the first (topmost) snap target and stops.
unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: `window_rect_at` passes a pointer to a live `HoverSearch`.
    let search = unsafe { &mut *(lparam.0 as *mut HoverSearch) };
    match unsafe { snap_bounds(hwnd, search.point.x, search.point.y) } {
        Some(bounds) => {
            search.bounds = Some(bounds);
            // Stop enumerating: windows are listed front to back.
            BOOL::from(false)
        }
        None => BOOL::from(true),
    }
}

/// Bounds of `hwnd` when it qualifies as the snap target for `(x, y)`.
unsafe fn snap_bounds(hwnd: HWND, x: i32, y: i32) -> Option<WindowBounds> {
    if hwnd.is_invalid() {
        return None;
    }
    // Our own overlays fill the screen while the user frames the region; they
    // must never snap to themselves (that would select the frozen screenshot).
    let mut process_id = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process_id as *mut u32));
    }
    if process_id == 0 || process_id == std::process::id() {
        return None;
    }
    // Cheap state/style checks first: the DWM queries below then only run for
    // the handful of windows that actually contain the pointer.
    let ignored = unsafe {
        !IsWindowVisible(hwnd).as_bool()
            || IsIconic(hwnd).as_bool()
            || is_tool_window(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
            || GetWindowTextLengthW(hwnd) == 0
            || is_ignored_class(&window_class(hwnd))
    };
    if ignored {
        return None;
    }
    // `GetWindowRect` is the cheap outer rectangle and always contains the DWM
    // frame bounds, so it works as a first containment filter.
    let outer = unsafe { window_rect(hwnd) }?;
    if !outer.contains(x, y) {
        return None;
    }
    // Cloaked windows live on another virtual desktop (or are suspended UWP
    // apps); they pass the checks above but must not steal the hover.
    if unsafe { is_cloaked(hwnd) } {
        return None;
    }
    // The extended frame bounds exclude the invisible resize border that
    // `GetWindowRect` includes (up to ~7 px), which would offset the highlight.
    let bounds = unsafe { extended_frame_bounds(hwnd) }.unwrap_or(outer);
    if !bounds.contains(x, y) || !is_snapable_size(bounds.width(), bounds.height()) {
        return None;
    }
    Some(bounds)
}

/// Visible frame bounds reported by DWM, in physical pixels.
unsafe fn extended_frame_bounds(hwnd: HWND) -> Option<WindowBounds> {
    let mut rect = RECT::default();
    let result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
    };
    result.is_ok().then(|| WindowBounds::from_rect(rect))
}

/// Full window rectangle (`GetWindowRect`), in physical pixels.
unsafe fn window_rect(hwnd: HWND) -> Option<WindowBounds> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }
        .is_ok()
        .then(|| WindowBounds::from_rect(rect))
}

/// `true` when DWM cloaks the window (other virtual desktop, suspended UWP).
unsafe fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    let result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
    };
    result.is_ok() && cloaked != 0
}

/// Win32 class name of `hwnd` (empty string when it cannot be read).
unsafe fn window_class(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
    if length <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..length as usize])
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/// `true` when the point lies inside `[left, right) x [top, bottom)`.
///
/// The right/bottom edges are exclusive so adjacent windows never both claim
/// the shared pixel row/column.
fn rect_contains(left: i32, top: i32, right: i32, bottom: i32, x: i32, y: i32) -> bool {
    x >= left && x < right && y >= top && y < bottom
}

/// `true` for `WS_EX_TOOLWINDOW` windows (small utility/overlay windows).
fn is_tool_window(ex_style: isize) -> bool {
    (ex_style as u32) & WS_EX_TOOLWINDOW.0 != 0
}

/// `true` for shell window classes that are not useful snap targets.
fn is_ignored_class(class: &str) -> bool {
    IGNORED_CLASSES
        .iter()
        .any(|ignored| ignored.eq_ignore_ascii_case(class))
}

/// `true` when both sides are at least [`MIN_SNAP_SIDE`] physical pixels.
fn is_snapable_size(width: i32, height: i32) -> bool {
    width >= MIN_SNAP_SIDE && height >= MIN_SNAP_SIDE
}

#[cfg(test)]
mod tests {
    use super::{
        is_ignored_class, is_snapable_size, is_tool_window, rect_contains, HoverRect, WindowBounds,
    };
    use windows::Win32::UI::WindowsAndMessaging::{WS_EX_LAYERED, WS_EX_TOOLWINDOW};

    #[test]
    fn point_containment_uses_half_open_rects() {
        // Top-left is inside; the right/bottom edges belong to the next window.
        assert!(rect_contains(0, 0, 1920, 1080, 0, 0));
        assert!(rect_contains(0, 0, 1920, 1080, 1919, 1079));
        assert!(!rect_contains(0, 0, 1920, 1080, 1920, 1079));
        assert!(!rect_contains(0, 0, 1920, 1080, 1919, 1080));
        assert!(!rect_contains(0, 0, 1920, 1080, -1, 100));
        // A monitor left of the primary one has a negative virtual-screen x.
        assert!(rect_contains(-1920, 0, 0, 1080, -1000, 500));
        assert!(!rect_contains(-1920, 0, 0, 1080, 0, 500));
    }

    #[test]
    fn tool_windows_are_never_snap_targets() {
        assert!(!is_tool_window(0));
        assert!(is_tool_window(WS_EX_TOOLWINDOW.0 as isize));
        // Other extended styles alone do not match; a combined style still does.
        assert!(!is_tool_window(WS_EX_LAYERED.0 as isize));
        assert!(is_tool_window(
            (WS_EX_LAYERED.0 | WS_EX_TOOLWINDOW.0) as isize
        ));
    }

    #[test]
    fn shell_window_classes_are_not_snap_targets() {
        for class in [
            "Shell_TrayWnd",
            "Progman",
            "WorkerW",
            "Windows.UI.Core.CoreWindow",
        ] {
            assert!(is_ignored_class(class), "{class} must be skipped");
        }
        // Real application windows (and an unreadable class name) are kept.
        assert!(!is_ignored_class("Chrome_WidgetWin_1"));
        assert!(!is_ignored_class("ApplicationFrameWindow"));
        assert!(!is_ignored_class("Shell_TrayWndEx"));
        assert!(!is_ignored_class(""));
    }

    #[test]
    fn tiny_windows_are_not_snapable() {
        assert!(is_snapable_size(8, 8));
        assert!(is_snapable_size(1920, 1080));
        assert!(!is_snapable_size(7, 1080));
        assert!(!is_snapable_size(1920, 7));
        assert!(!is_snapable_size(0, 0));
        assert!(!is_snapable_size(-100, 100));
    }

    #[test]
    fn bounds_serialize_as_the_rect_json_the_page_expects() {
        let bounds = WindowBounds {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1080,
        };
        let rect: HoverRect = bounds.to_hover_rect();
        assert_eq!(
            rect,
            HoverRect {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1080,
            }
        );
        assert_eq!(
            serde_json::to_value(rect).unwrap(),
            serde_json::json!({ "x": -1920, "y": 0, "width": 1920, "height": 1080 })
        );
    }
}
