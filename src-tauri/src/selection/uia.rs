//! Raw UI Automation selection capture with an explicit watchdog.
//!
//! The `uiautomation` crate used by the research spike does not expose the
//! connection/transaction timeouts and its types are `!Send`, so the raw
//! `windows` COM interfaces are used directly:
//!
//! 1. every capture runs on its own `CoInitializeEx(MTA)` thread,
//! 2. `IUIAutomation2::SetConnectionTimeout(1500)` /
//!    `SetTransactionTimeout(1000)` limit the COM waits,
//! 3. the caller waits at most [`CAPTURE_TIMEOUT`] and abandons (detaches) the
//!    thread on timeout, because a hung provider can block a UIA call far
//!    beyond those limits.
//!
//! Focused element first, then `ElementFromPoint(mouse)` walking up to
//! [`MAX_PARENT_HOPS`] parents (Chromium and Office often expose the text
//! pattern on an ancestor of the element under the cursor).

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use windows::core::Interface;
use windows::Win32::Foundation::POINT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationElement, IUIAutomationTextPattern,
    UIA_TextPatternId,
};

use super::win;

/// Hard watchdog for one capture attempt, including retries.
const CAPTURE_TIMEOUT: Duration = Duration::from_millis(1500);
/// `IUIAutomation2::SetConnectionTimeout` value in milliseconds.
const CONNECTION_TIMEOUT_MS: u32 = 1500;
/// `IUIAutomation2::SetTransactionTimeout` value in milliseconds.
const TRANSACTION_TIMEOUT_MS: u32 = 1000;
/// Number of focused-element attempts (first try + two retries).
const ATTEMPTS: u32 = 3;
/// Delay between attempts; some apps commit the selection on `WM_LBUTTONUP`.
const RETRY_DELAY: Duration = Duration::from_millis(150);
/// Maximum number of parents walked from the element under the mouse.
const MAX_PARENT_HOPS: usize = 6;
/// Text length requested per selection range.
const MAX_TEXT_LENGTH: i32 = 8192;

/// One successful capture: the selected text plus the image name of the process
/// that owns the element (used to re-check the blacklist).
pub(super) struct CapturedSelection {
    pub text: String,
    pub program_name: String,
}

/// Reads the current text selection of the foreground application.
///
/// `mouse` is the physical cursor position used by the `ElementFromPoint`
/// fallback. Returns a user-facing failure message on timeout / unsupported
/// applications; never blocks longer than [`CAPTURE_TIMEOUT`].
pub(super) fn capture_selection(mouse: Option<(i32, i32)>) -> Result<CapturedSelection, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let spawned = thread::Builder::new()
        .name("lexora-uia".to_string())
        .spawn(move || {
            let result = capture_on_thread(mouse);
            // The receiver is gone when the watchdog already gave up.
            let _ = sender.send(result);
        });
    if let Err(error) = spawned {
        return Err(format!("无法启动取词线程：{error}"));
    }

    match receiver.recv_timeout(CAPTURE_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // Do not join: a stuck provider thread is abandoned on purpose.
            Err("读取选中文本超时，目标应用未响应".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("取词线程异常退出".to_string()),
    }
}

fn capture_on_thread(mouse: Option<(i32, i32)>) -> Result<CapturedSelection, String> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|error| format!("COM 初始化失败：{error}"))?;
    }
    let result = capture_with_automation(mouse);
    unsafe {
        CoUninitialize();
    }
    result
}

fn capture_with_automation(mouse: Option<(i32, i32)>) -> Result<CapturedSelection, String> {
    let automation: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_ALL) }
        .map_err(|error| format!("创建 UI Automation 客户端失败：{error}"))?;

    unsafe {
        if let Ok(automation2) = automation.cast::<IUIAutomation2>() {
            let _ = automation2.SetConnectionTimeout(CONNECTION_TIMEOUT_MS);
            let _ = automation2.SetTransactionTimeout(TRANSACTION_TIMEOUT_MS);
        }
    }

    let mut last_error = String::from("未获取到选中文本");
    for attempt in 0..ATTEMPTS {
        match read_focused_selection(&automation) {
            Ok(selection) => return Ok(selection),
            Err(error) => last_error = error,
        }
        if attempt + 1 < ATTEMPTS {
            thread::sleep(RETRY_DELAY);
        }
    }

    // Fallback for applications whose focused element is a container without a
    // text pattern.
    if let Some((x, y)) = mouse {
        match read_point_selection(&automation, x, y) {
            Ok(Some(selection)) => return Ok(selection),
            Ok(None) => {}
            Err(error) => last_error = error,
        }
    }

    Err(last_error)
}

fn read_focused_selection(automation: &IUIAutomation) -> Result<CapturedSelection, String> {
    unsafe {
        let element = automation
            .GetFocusedElement()
            .map_err(|error| format!("无法获取焦点控件：{error}"))?;
        read_element_selection(&element)
    }
}

fn read_point_selection(
    automation: &IUIAutomation,
    x: i32,
    y: i32,
) -> Result<Option<CapturedSelection>, String> {
    unsafe {
        let mut element = automation
            .ElementFromPoint(POINT { x, y })
            .map_err(|error| format!("鼠标位置没有可用的 UI 元素：{error}"))?;
        let walker = automation.ControlViewWalker().ok();
        for _ in 0..MAX_PARENT_HOPS {
            if let Ok(selection) = read_element_selection(&element) {
                return Ok(Some(selection));
            }
            let Some(walker) = walker.as_ref() else {
                break;
            };
            match walker.GetParentElement(&element) {
                Ok(parent) => element = parent,
                Err(_) => break,
            }
        }
        Ok(None)
    }
}

/// Reads the selection of one element through `UIA_TextPatternId`.
fn read_element_selection(element: &IUIAutomationElement) -> Result<CapturedSelection, String> {
    unsafe {
        let pattern: IUIAutomationTextPattern = element
            .GetCurrentPatternAs(UIA_TextPatternId)
            .map_err(|error| format!("控件不支持文本选区：{error}"))?;
        let ranges = pattern
            .GetSelection()
            .map_err(|error| format!("读取选区失败：{error}"))?;
        let count = ranges
            .Length()
            .map_err(|error| format!("读取选区数量失败：{error}"))?;
        if count <= 0 {
            return Err("没有选中文本".to_string());
        }

        let mut text = String::new();
        for index in 0..count {
            let range = ranges
                .GetElement(index)
                .map_err(|error| format!("读取选区失败：{error}"))?;
            let value = range
                .GetText(MAX_TEXT_LENGTH)
                .map_err(|error| format!("读取选区文本失败：{error}"))?;
            text.push_str(&value.to_string());
        }

        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("没有选中文本".to_string());
        }

        let pid = element.CurrentProcessId().unwrap_or(0).max(0) as u32;
        Ok(CapturedSelection {
            text,
            program_name: win::process_image_name(pid),
        })
    }
}
