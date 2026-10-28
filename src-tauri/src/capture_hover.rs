//! QQ-style screenshot snapping: the topmost window under the physical pointer.
//!
//! While a capture overlay is up the capture page polls [`capture_cursor`] (for
//! the physical cursor position and whether a session is still active) and, on
//! every mouse move, [`capture_hover_at`] to highlight the window the selection
//! would snap to. All coordinates are **physical pixels** in virtual-screen
//! space, matching the frozen screenshot and [`crate::win32`]; the overlay
//! converts them to its own CSS space through the monitor scale factor.
//!
//! Walk the explicit top-level z-order chain, skipping capture overlays, to
//! select the foremost eligible window under the pointer.
//!
//! It also exposes [`capture_layout`]: the physical monitor layout of the active
//! capture session, so the capture page can keep a cross-monitor selection in
//! global virtual-screen coordinates.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetDesktopWindow, GetLayeredWindowAttributes, GetTopWindow, GetWindow,
    GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    GWL_EXSTYLE, GW_HWNDNEXT, LWA_ALPHA, WS_EX_LAYERED,
};

use crate::state::AppState;

/// Windows smaller than this many physical pixels (on either side) never become
/// a snap target: zero-size popups and hidden helper windows would otherwise
/// steal the selection.
const MIN_SNAP_SIDE: i32 = 8;

/// Shell windows that must never become a snap target: the taskbar, the desktop
/// (`Progman`) and its wallpaper hosts (`WorkerW`). Snapping to them would frame
/// the whole screen instead of an application.
const IGNORED_CLASSES: [&str; 4] = [
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "Progman",
    "WorkerW",
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

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Topmost snap-able top-level window under the physical screen point `(x, y)`.
///
/// Returns `{"ok": true, "rect": null}` when no capture session is active or the
/// point is over the desktop / taskbar; otherwise `rect` carries the physical
/// bounds `{x, y, width, height}` the capture page highlights.
#[tauri::command]
pub fn capture_hover_at(app: AppHandle, state: State<'_, Arc<AppState>>, x: i32, y: i32) -> Value {
    // Never enumerate windows outside a live screenshot session: the page may
    // still poll while its overlay is hidden between captures.
    if !state.capture.is_active() {
        return json!({ "ok": true, "rect": null });
    }
    match window_rect_at(&app, x, y) {
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
pub fn window_rect_at(app: &AppHandle, x: i32, y: i32) -> Option<HoverRect> {
    // Only registered non-capture webviews may be selected within this process.
    let own_targets: Vec<HWND> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| !label.starts_with("capture-"))
        .filter_map(|(_, window)| window.hwnd().ok())
        .collect();
    unsafe { topmost_bounds_at(x, y, &own_targets) }.map(WindowBounds::to_hover_rect)
}

/// Follow the desktop's explicit front-to-back z-order, never entering children.
unsafe fn topmost_bounds_at(x: i32, y: i32, own_targets: &[HWND]) -> Option<WindowBounds> {
    let mut current = unsafe { GetTopWindow(Some(GetDesktopWindow())) }.ok();
    // Windows can be reordered/destroyed during traversal. Bound the walk and
    // stop on a repeated handle instead of risking an endless GetWindow loop.
    let mut visited = std::collections::HashSet::new();
    while let Some(hwnd) = current {
        if hwnd.is_invalid() || visited.len() >= 4096 || !visited.insert(hwnd.0 as usize) {
            break;
        }
        if let Some(bounds) = unsafe { snap_bounds(hwnd, x, y, own_targets) } {
            return Some(bounds);
        }
        current = unsafe { GetWindow(hwnd, GW_HWNDNEXT) }.ok();
    }
    None
}

/// Bounds of `hwnd` when it qualifies as the snap target for `(x, y)`.
unsafe fn snap_bounds(hwnd: HWND, x: i32, y: i32, own_targets: &[HWND]) -> Option<WindowBounds> {
    if hwnd.is_invalid() {
        return None;
    }
    // Capture overlays must never select their own frozen screenshot. Other
    // registered Lexora windows can be selected just like external windows.
    let mut process_id = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process_id as *mut u32));
    }
    if !is_snapable_owner(process_id, hwnd, own_targets) {
        return None;
    }
    // Cheap state/style checks first: the DWM queries below then only run for
    // the handful of windows that actually contain the pointer.
    let ignored = unsafe {
        !is_snapable_state(
            IsWindowVisible(hwnd).as_bool(),
            IsIconic(hwnd).as_bool(),
            false,
        ) || is_ignored_class(&window_class(hwnd))
    };
    if ignored {
        return None;
    }
    let outer = unsafe { window_rect(hwnd) }?;
    let bounds = snap_frame_at(outer, unsafe { extended_frame_bounds(hwnd) }, x, y)?;
    // Only reject explicitly zero global alpha; unreadable attributes and
    // per-pixel transparency do not establish that the window is invisible.
    if unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32 & WS_EX_LAYERED.0 != 0 {
        let mut alpha = 255u8;
        let mut flags = Default::default();
        if unsafe { GetLayeredWindowAttributes(hwnd, None, Some(&mut alpha), Some(&mut flags)) }
            .is_ok()
            && flags.contains(LWA_ALPHA)
            && alpha == 0
        {
            return None;
        }
    }
    // Cloaked windows live on another virtual desktop (or are suspended UWP
    // apps); they pass the checks above but must not steal the hover.
    if !is_snapable_state(true, false, unsafe { is_cloaked(hwnd) }) {
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

/// Prefer a valid DWM frame; fall back for failed, empty, tiny or disjoint
/// frames. Either rectangle may contain the point, including resize borders.
fn snap_frame_at(
    outer: WindowBounds,
    frame: Option<WindowBounds>,
    x: i32,
    y: i32,
) -> Option<WindowBounds> {
    if !is_snapable_size(outer.width(), outer.height()) {
        return None;
    }
    let bounds = frame
        .filter(|frame| {
            is_snapable_size(frame.width(), frame.height())
                && frame.left < outer.right
                && frame.right > outer.left
                && frame.top < outer.bottom
                && frame.bottom > outer.top
        })
        .unwrap_or(outer);
    (outer.contains(x, y) || bounds.contains(x, y)).then_some(bounds)
}

/// `true` when the point lies inside `[left, right) x [top, bottom)`.
///
/// The right/bottom edges are exclusive so adjacent windows never both claim
/// the shared pixel row/column.
fn rect_contains(left: i32, top: i32, right: i32, bottom: i32, x: i32, y: i32) -> bool {
    x >= left && x < right && y >= top && y < bottom
}

/// Same-process helper windows are excluded unless explicitly registered as a
/// non-capture webview. A title or tool-window style does not imply invisibility.
fn is_snapable_owner(process_id: u32, hwnd: HWND, own_targets: &[HWND]) -> bool {
    process_id != 0 && (process_id != std::process::id() || own_targets.contains(&hwnd))
}

fn is_snapable_state(visible: bool, minimized: bool, cloaked: bool) -> bool {
    visible && !minimized && !cloaked
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
        is_ignored_class, is_snapable_owner, is_snapable_size, is_snapable_state, rect_contains,
        snap_bounds, HoverRect, WindowBounds,
    };
    use windows::Win32::Foundation::HWND;

    #[test]
    fn hidden_minimized_and_cloaked_windows_are_not_snap_targets() {
        assert!(is_snapable_state(true, false, false));
        assert!(!is_snapable_state(false, false, false));
        assert!(!is_snapable_state(true, true, false));
        assert!(!is_snapable_state(true, false, true));
    }

    #[test]
    fn visible_titled_and_untitled_tool_windows_can_snap() {
        use windows::core::w;
        use windows::Win32::UI::HiDpi::{
            SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT,
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, SetLayeredWindowAttributes, ShowWindow, LWA_ALPHA,
            LWA_COLORKEY, SW_HIDE, SW_MINIMIZE, WINDOW_EX_STYLE, WS_EX_LAYERED, WS_EX_TOOLWINDOW,
            WS_POPUP, WS_VISIBLE,
        };
        struct TestWindow(HWND);
        struct TestDpi(DPI_AWARENESS_CONTEXT);
        impl Drop for TestDpi {
            fn drop(&mut self) {
                unsafe {
                    SetThreadDpiAwarenessContext(self.0);
                }
            }
        }
        // The application is DPI-aware; test runner threads are not by default.
        let _dpi = TestDpi(unsafe {
            SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
        });
        impl Drop for TestWindow {
            fn drop(&mut self) {
                unsafe {
                    let _ = DestroyWindow(self.0);
                }
            }
        }
        // Keep fixture windows off-screen and destroy them even on assertion failure.
        for (title, style, width, attributes, expected) in [
            (w!("Snap fixture"), WINDOW_EX_STYLE(0), 80, None, true),
            (w!(""), WS_EX_TOOLWINDOW, 80, None, true),
            (w!(""), WS_EX_TOOLWINDOW, 7, None, false),
            (
                w!(""),
                WS_EX_TOOLWINDOW | WS_EX_LAYERED,
                80,
                Some((0, LWA_ALPHA)),
                false,
            ),
            (
                w!(""),
                WS_EX_TOOLWINDOW | WS_EX_LAYERED,
                80,
                Some((128, LWA_ALPHA)),
                true,
            ),
            (
                w!(""),
                WS_EX_TOOLWINDOW | WS_EX_LAYERED,
                80,
                Some((255, LWA_ALPHA)),
                true,
            ),
            (
                w!(""),
                WS_EX_TOOLWINDOW | WS_EX_LAYERED,
                80,
                Some((0, LWA_COLORKEY)),
                true,
            ),
            (w!(""), WS_EX_TOOLWINDOW | WS_EX_LAYERED, 80, None, true),
        ] {
            let window = TestWindow(unsafe {
                CreateWindowExW(
                    style,
                    w!("STATIC"),
                    title,
                    WS_POPUP | WS_VISIBLE,
                    -30000,
                    -30000,
                    width,
                    80,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap()
            });
            let hwnd = window.0;
            if let Some((alpha, flags)) = attributes {
                unsafe {
                    SetLayeredWindowAttributes(hwnd, Default::default(), alpha, flags).unwrap();
                }
            } else if style.contains(WS_EX_LAYERED) {
                let mut alpha = 255u8;
                let mut flags = Default::default();
                assert!(unsafe {
                    super::GetLayeredWindowAttributes(
                        hwnd,
                        None,
                        Some(&mut alpha),
                        Some(&mut flags),
                    )
                }
                .is_err());
            }
            assert_eq!(
                unsafe { snap_bounds(hwnd, -29999, -29999, &[hwnd]) }.is_some(),
                expected,
                "width={width}, outer={:?}, frame={:?}, cloaked={}",
                unsafe { super::window_rect(hwnd) },
                unsafe { super::extended_frame_bounds(hwnd) },
                unsafe { super::is_cloaked(hwnd) }
            );
            assert!(unsafe { snap_bounds(hwnd, -29999, -29999, &[]) }.is_none());
            unsafe {
                let _ = ShowWindow(hwnd, SW_MINIMIZE);
            }
            assert!(unsafe { snap_bounds(hwnd, -29999, -29999, &[hwnd]) }.is_none());
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
            assert!(unsafe { snap_bounds(hwnd, -29999, -29999, &[hwnd]) }.is_none());
        }
    }

    #[test]
    fn frame_fallback_and_resize_edges_are_snapable() {
        let outer = WindowBounds {
            left: -200,
            top: -100,
            right: -100,
            bottom: 0,
        };
        let frame = WindowBounds {
            left: -192,
            top: -92,
            right: -108,
            bottom: -8,
        };
        for invalid in [
            None,
            Some(WindowBounds {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            }),
            Some(WindowBounds {
                left: 100,
                top: 100,
                right: 200,
                bottom: 200,
            }),
            Some(WindowBounds {
                right: -201,
                ..outer
            }),
            Some(WindowBounds {
                right: -199,
                ..outer
            }),
        ] {
            assert_eq!(super::snap_frame_at(outer, invalid, -199, -99), Some(outer));
        }
        assert_eq!(
            super::snap_frame_at(outer, Some(frame), -199, -99),
            Some(frame)
        );
        let expanded = WindowBounds {
            left: -210,
            ..frame
        };
        assert_eq!(
            super::snap_frame_at(outer, Some(expanded), -205, -50),
            Some(expanded)
        );
        assert_eq!(super::snap_frame_at(outer, Some(frame), 0, 0), None);
        assert_eq!(
            super::snap_frame_at(
                WindowBounds {
                    right: -199,
                    ..outer
                },
                None,
                -200,
                -99
            ),
            None
        );
    }

    #[test]
    fn overlapping_windows_follow_z_order_and_skip_overlay() {
        use windows::core::w;
        use windows::Win32::UI::HiDpi::{
            SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
            SWP_NOSIZE, WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE,
        };
        struct Fixture {
            windows: Vec<HWND>,
            dpi: windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT,
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                unsafe {
                    for hwnd in self.windows.iter().rev() {
                        let _ = DestroyWindow(*hwnd);
                    }
                    SetThreadDpiAwarenessContext(self.dpi);
                }
            }
        }
        let mut fixture = Fixture {
            windows: Vec::new(),
            dpi: unsafe {
                SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
            },
        };
        for width in [80, 100, 120] {
            fixture.windows.push(unsafe {
                CreateWindowExW(
                    WS_EX_TOOLWINDOW,
                    w!("STATIC"),
                    w!("Snap z-order fixture"),
                    WS_POPUP | WS_VISIBLE,
                    -28000,
                    -28000,
                    width,
                    80,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap()
            });
        }
        let back = fixture.windows[0];
        let front = fixture.windows[1];
        let overlay = fixture.windows[2];
        let raise = |hwnd| unsafe {
            SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            )
            .unwrap()
        };
        raise(back);
        raise(front);
        raise(overlay);
        let targets = [back, front];
        assert_eq!(
            unsafe { super::topmost_bounds_at(-27999, -27999, &targets) },
            unsafe { snap_bounds(front, -27999, -27999, &targets) }
        );
        raise(back);
        raise(overlay);
        assert_eq!(
            unsafe { super::topmost_bounds_at(-27999, -27999, &targets) },
            unsafe { snap_bounds(back, -27999, -27999, &targets) }
        );
        assert!(unsafe { snap_bounds(overlay, -27999, -27999, &targets) }.is_none());
    }

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
    fn only_registered_non_capture_own_windows_are_snap_targets() {
        let panel = HWND(1usize as _);
        let overlay = HWND(2usize as _);
        assert!(is_snapable_owner(std::process::id(), panel, &[panel]));
        assert!(!is_snapable_owner(std::process::id(), overlay, &[panel]));
        assert!(!is_snapable_owner(0, panel, &[panel]));
        assert!(is_snapable_owner(
            std::process::id().wrapping_add(1),
            panel,
            &[]
        ));
    }

    #[test]
    fn shell_window_classes_are_not_snap_targets() {
        for class in [
            "Shell_TrayWnd",
            "Shell_SecondaryTrayWnd",
            "Progman",
            "WorkerW",
        ] {
            assert!(is_ignored_class(class), "{class} must be skipped");
        }
        // Real application windows (and an unreadable class name) are kept.
        assert!(!is_ignored_class("Chrome_WidgetWin_1"));
        assert!(!is_ignored_class("ApplicationFrameWindow"));
        assert!(!is_ignored_class("Windows.UI.Core.CoreWindow"));
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
