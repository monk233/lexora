//! Small Win32 helpers: cursor position, monitor work area, DPI.
//!
//! All values returned here are **physical pixels**, matching what UI Automation
//! and the low-level input hooks report. Tauri window positions are logical
//! pixels, so callers divide by the monitor scale factor.

use std::time::Duration;

use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetDoubleClickTime, SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_WHEEL, MOUSEINPUT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetAncestor, GetCursorPos, GetForegroundWindow, GetWindowThreadProcessId,
    SetCursorPos, SetForegroundWindow, SetWindowPos, WindowFromPoint, GA_ROOT, HWND_TOP,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WHEEL_DELTA,
};

#[derive(Debug, Clone, Copy)]
pub struct WorkArea {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl WorkArea {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

pub fn cursor_physical() -> (i32, i32) {
    let mut point = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut point);
    }
    (point.x, point.y)
}

/// Moves the physical cursor position (used to aim the long-screenshot scroll).
pub fn set_cursor_position(x: i32, y: i32) {
    unsafe {
        let _ = SetCursorPos(x, y);
    }
}

/// Sends `notches` mouse-wheel steps (negative data = scroll down) through
/// `SendInput`, i.e. exactly what a real wheel would generate. Returns whether
/// the input was accepted by the OS.
pub fn scroll_wheel_notches(notches: i32) -> bool {
    if notches == 0 {
        return true;
    }
    let delta = -(WHEEL_DELTA as i32 * notches);
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: delta as u32,
                dwFlags: MOUSEEVENTF_WHEEL,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) == 1 }
}

/// Brings the top-level window under `(x, y)` to the foreground so synthetic
/// Disables DWM open/close transitions for one of our windows. Without this the
/// transparent capture overlay fades out over ~150 ms when hidden, which reads as
/// a flash/jitter on exit (round 21). Returns `false` on unsupported systems.
pub fn disable_transitions(window: &tauri::WebviewWindow) -> bool {
    let Ok(hwnd) = window.hwnd() else {
        return false;
    };
    let value: i32 = 1;
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED,
            &value as *const i32 as *const core::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        )
        .is_ok()
    }
}

/// wheel input is delivered to it (Windows routes wheel events to the focused
/// window unless "scroll inactive windows on hover" is enabled). Our own
/// hidden overlay never appears under the cursor, so this targets the
/// application being captured. Failures are ignored (the long screenshot then
/// relies on the hover setting).
pub fn focus_window_at(x: i32, y: i32) -> bool {
    unsafe {
        let hwnd = WindowFromPoint(POINT { x, y });
        if hwnd.is_invalid() {
            return false;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        let target = if root.is_invalid() { hwnd } else { root };
        // Raise it in the z-order (works even when another app owns the
        // foreground), then hand focus over by temporarily attaching to the
        // foreground thread's input queue (bypasses the foreground lock without
        // synthesizing keyboard input, which could open e.g. a menu).
        let _ = SetWindowPos(
            target,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        let foreground_thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let current_thread = GetCurrentThreadId();
        let attached = foreground_thread != 0
            && foreground_thread != current_thread
            && AttachThreadInput(current_thread, foreground_thread, true).as_bool();
        let _ = BringWindowToTop(target);
        let focused = SetForegroundWindow(target).as_bool();
        if attached {
            let _ = AttachThreadInput(current_thread, foreground_thread, false);
        }
        focused
    }
}

/// Clamps a window's physical top-left position so a `width`×`height` window
/// stays fully inside `work` (pure, shared by the picker and pin window drags).
pub fn clamp_to_work_area(x: i32, y: i32, width: i32, height: i32, work: &WorkArea) -> (i32, i32) {
    let max_x = work.right - width.max(1);
    let x = if max_x >= work.left {
        x.clamp(work.left, max_x)
    } else {
        work.left
    };
    let max_y = work.bottom - height.max(1);
    let y = if max_y >= work.top {
        y.clamp(work.top, max_y)
    } else {
        work.top
    };
    (x, y)
}

/// Maximum interval between two clicks of a double click (system setting).
///
/// `GetDoubleClickTime` has no documented failure mode and is cheap enough to
/// call from the low-level hook callback; no UIA or blocking work is involved.
pub fn double_click_time() -> Duration {
    Duration::from_millis(u64::from(unsafe { GetDoubleClickTime() }))
}

fn monitor_from_point(x: i32, y: i32) -> HMONITOR {
    unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST) }
}

/// Work area (screen minus taskbar) of the monitor containing the point.
pub fn work_area_physical(x: i32, y: i32) -> WorkArea {
    let monitor = monitor_from_point(x, y);
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !monitor.is_invalid() && unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        WorkArea {
            left: info.rcWork.left,
            top: info.rcWork.top,
            right: info.rcWork.right,
            bottom: info.rcWork.bottom,
        }
    } else {
        // Fall back to the primary screen bounds; still better than panicking.
        WorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        }
    }
}

/// Effective DPI scale (1.0 = 100%) of the monitor containing the point.
pub fn monitor_scale_factor(x: i32, y: i32) -> f64 {
    let monitor = monitor_from_point(x, y);
    if monitor.is_invalid() {
        return 1.0;
    }
    let mut dpi_x = 96u32;
    let mut dpi_y = 96u32;
    let result = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
    if result.is_ok() && dpi_x > 0 {
        dpi_x as f64 / 96.0
    } else {
        1.0
    }
}

#[cfg(test)]
mod tests {
    use super::{clamp_to_work_area, WorkArea};

    fn work() -> WorkArea {
        WorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        }
    }

    #[test]
    fn window_positions_are_clamped_to_the_work_area() {
        // Inside stays untouched.
        assert_eq!(clamp_to_work_area(100, 200, 400, 300, &work()), (100, 200));
        // Negative / beyond the right/bottom edges are pulled back in.
        assert_eq!(clamp_to_work_area(-50, -20, 400, 300, &work()), (0, 0));
        assert_eq!(
            clamp_to_work_area(5000, 5000, 400, 300, &work()),
            (1520, 780)
        );
        // A multi-monitor work area with a negative origin.
        let secondary = WorkArea {
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1040,
        };
        assert_eq!(
            clamp_to_work_area(-2000, 3000, 800, 600, &secondary),
            (-1920, 440)
        );
        // A window larger than the work area anchors at the top-left corner.
        assert_eq!(clamp_to_work_area(50, 50, 4000, 3000, &work()), (0, 0));
    }
}
