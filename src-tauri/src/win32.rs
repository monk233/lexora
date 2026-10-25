//! Small Win32 helpers: cursor position, monitor work area, DPI.
//!
//! All values returned here are **physical pixels**, matching what UI Automation
//! and the low-level input hooks report. Tauri window positions are logical
//! pixels, so callers divide by the monitor scale factor.

use std::time::Duration;

use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

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
