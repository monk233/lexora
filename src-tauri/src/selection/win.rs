//! Small process-name helpers shared by the selection pipeline.
//!
//! UI Automation and the input hook both deal with process ids only; the
//! blacklist and the "do not react to ourselves" rule need image names such as
//! `chrome.exe`.

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, MAX_PATH};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

/// Full image path of a process id. Returns an empty string when the process
/// cannot be opened (protected / elevated / already exited).
pub(super) fn process_image_path(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buffer = [0u16; MAX_PATH as usize];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        if result.is_err() {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..size as usize])
    }
}

/// File name (e.g. `chrome.exe`) of a process id.
pub(super) fn process_image_name(pid: u32) -> String {
    file_name_of(&process_image_path(pid))
}

/// Returns `(pid, image name)` of the window that currently has the input
/// focus. Both values are empty / zero when no foreground window exists.
pub(super) fn foreground_process() -> (u32, String) {
    unsafe {
        let window = GetForegroundWindow();
        if window.is_invalid() {
            return (0, String::new());
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid as *mut u32));
        (pid, process_image_name(pid))
    }
}

fn file_name_of(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .next()
        .unwrap_or_default()
        .to_string()
}
