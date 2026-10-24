//! Low-level global input hook built on `rdev`.
//!
//! `rdev::listen` blocks and has no stop API, so the hook thread is installed
//! once and lives until the process exits; `picker.enabled` gates every trigger
//! instead of removing the hook. The callback only maintains a small state
//! machine and forwards work through channels: staying below the ~300 ms
//! low-level hook budget is a hard requirement, otherwise Windows silently
//! drops the hook.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use rdev::{listen, Button, Event, EventType, Key};

use super::shortcut::{self, ShortcutKey};
use super::{ActionRequest, Inner, TriggerSource};

/// Minimum physical drag distance for a mouse gesture to count as a selection.
const DRAG_THRESHOLD_PX: f64 = 6.0;
/// Guards against a sticky key / duplicate KeyPress sequence.
const HOTKEY_COOLDOWN: Duration = Duration::from_millis(250);

/// State tracked between events of the single hook callback.
#[derive(Default)]
struct HookState {
    ctrl_left: bool,
    ctrl_right: bool,
    shift_left: bool,
    shift_right: bool,
    alt_left: bool,
    alt_right: bool,
    mouse: Option<(f64, f64)>,
    press_origin: Option<(f64, f64)>,
    down_key: Option<ShortcutKey>,
    last_hotkey: Option<Instant>,
}

/// Spawns the hook thread. Called once by [`super::SelectionService::start`].
pub(super) fn start(inner: Arc<Inner>) {
    let logger = inner.logger.clone();
    let spawned = thread::Builder::new()
        .name("lingopick-hook".to_string())
        .spawn(move || run(inner));
    if let Err(error) = spawned {
        logger.error(&format!("无法启动全局输入钩子线程：{error}"));
    }
}

fn run(inner: Arc<Inner>) {
    loop {
        let callback_inner = inner.clone();
        let mut state = HookState::default();
        let result = listen(move |event| on_event(&callback_inner, &mut state, event));
        match result {
            Ok(()) => inner.logger.warn("全局输入钩子已停止，1 秒后尝试重启"),
            Err(error) => inner
                .logger
                .warn(&format!("全局输入钩子安装失败：{error:?}，1 秒后重试")),
        }
        thread::sleep(Duration::from_secs(1));
    }
}

fn on_event(inner: &Arc<Inner>, state: &mut HookState, event: Event) {
    match event.event_type {
        EventType::KeyPress(key) => handle_key_press(inner, state, key),
        EventType::KeyRelease(key) => handle_key_release(state, key),
        EventType::MouseMove { x, y } => state.mouse = Some((x, y)),
        EventType::ButtonPress(Button::Left) => handle_left_press(inner, state),
        EventType::ButtonRelease(Button::Left) => handle_left_release(inner, state),
        _ => {}
    }
}

fn handle_key_press(inner: &Arc<Inner>, state: &mut HookState, key: Key) {
    match key {
        Key::ControlLeft => state.ctrl_left = true,
        Key::ControlRight => state.ctrl_right = true,
        Key::ShiftLeft => state.shift_left = true,
        Key::ShiftRight => state.shift_right = true,
        Key::Alt => state.alt_left = true,
        Key::AltGr => state.alt_right = true,
        _ => {}
    }

    let Some(spec) = inner.shortcut() else {
        return;
    };
    let Some(pressed) = shortcut::key_from_rdev(key) else {
        return;
    };
    if pressed != spec.key {
        return;
    }
    // Auto-repeat emits repeated KeyPress events; only the first one counts.
    if state.down_key == Some(pressed) {
        return;
    }
    state.down_key = Some(pressed);

    if !inner.enabled.load(Ordering::Acquire) {
        return;
    }
    let ctrl = state.ctrl_left || state.ctrl_right;
    let shift = state.shift_left || state.shift_right;
    let alt = state.alt_left || state.alt_right;
    if !spec.matches(ctrl, shift, alt, pressed) {
        return;
    }
    if let Some(last) = state.last_hotkey {
        if last.elapsed() < HOTKEY_COOLDOWN {
            return;
        }
    }
    state.last_hotkey = Some(Instant::now());
    inner.send_capture(TriggerSource::Hotkey, None);
}

fn handle_key_release(state: &mut HookState, key: Key) {
    match key {
        Key::ControlLeft => state.ctrl_left = false,
        Key::ControlRight => state.ctrl_right = false,
        Key::ShiftLeft => state.shift_left = false,
        Key::ShiftRight => state.shift_right = false,
        Key::Alt => state.alt_left = false,
        Key::AltGr => state.alt_right = false,
        _ => {}
    }
    if let Some(released) = shortcut::key_from_rdev(key) {
        if state.down_key == Some(released) {
            state.down_key = None;
        }
    }
}

fn handle_left_press(inner: &Arc<Inner>, state: &mut HookState) {
    // `ButtonRelease` carries no coordinates, so the latest `MouseMove` is the
    // drag origin. Mouse events are always delivered before the button event.
    state.press_origin = state.mouse;

    // A left click outside the picker dismisses it (unless the panel is pinned).
    if !inner.picker_visible.load(Ordering::Acquire) || inner.panel_pinned.load(Ordering::Acquire) {
        return;
    }
    if let Some((x, y)) = state.mouse {
        inner.send_action(ActionRequest::OutsideClick {
            x: x.round() as i32,
            y: y.round() as i32,
        });
    }
}

fn handle_left_release(inner: &Arc<Inner>, state: &mut HookState) {
    let Some(origin) = state.press_origin.take() else {
        return;
    };
    let Some(end) = state.mouse else {
        return;
    };
    if !is_drag_gesture(origin, end, DRAG_THRESHOLD_PX) {
        return;
    }
    if !inner.enabled.load(Ordering::Acquire) {
        return;
    }
    let anchor = (end.0.round() as i32, end.1.round() as i32);
    inner.send_capture(TriggerSource::Mouse, Some(anchor));
}

/// A selection gesture needs a real drag, otherwise every click would fire UIA.
fn is_drag_gesture(origin: (f64, f64), end: (f64, f64), threshold: f64) -> bool {
    let dx = end.0 - origin.0;
    let dy = end.1 - origin.1;
    dx * dx + dy * dy >= threshold * threshold
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drag_threshold_is_six_physical_pixels() {
        assert!(!is_drag_gesture((0.0, 0.0), (5.9, 0.0), 6.0));
        assert!(is_drag_gesture((0.0, 0.0), (6.0, 0.0), 6.0));
        assert!(is_drag_gesture((0.0, 0.0), (6.1, 0.0), 6.0));
        // 3-4-5 triangle stays below the threshold.
        assert!(!is_drag_gesture((0.0, 0.0), (3.0, 4.0), 6.0));
        // Negative directions work as well.
        assert!(is_drag_gesture((100.0, 100.0), (94.0, 102.0), 6.0));
        assert!(is_drag_gesture((0.0, 0.0), (0.0, -6.0), 6.0));
        assert!(!is_drag_gesture((0.0, 0.0), (0.0, 0.0), 6.0));
    }
}
