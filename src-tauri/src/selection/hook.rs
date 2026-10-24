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
    clicks: ClickChain,
}

/// Tracks consecutive non-drag clicks so double/triple click selections can
/// trigger a capture while a single click stays silent (no UIA per click).
#[derive(Default)]
struct ClickChain {
    /// Release instant of the previous click in the chain.
    released_at: Option<Instant>,
    /// Release position of the previous click in the chain.
    point: Option<(f64, f64)>,
    /// Number of clicks in the current chain (0 = no chain).
    count: u32,
}

impl ClickChain {
    /// Folds one click release into the chain and returns the new run length.
    /// Releasing too late or too far from the previous click starts a new chain.
    fn register(&mut self, point: (f64, f64), now: Instant, double_click_time: Duration) -> u32 {
        let continues = match (self.released_at, self.point) {
            (Some(released_at), Some(previous)) => {
                now.saturating_duration_since(released_at) <= double_click_time
                    && points_within(previous, point, DRAG_THRESHOLD_PX)
            }
            _ => false,
        };
        self.count = if continues {
            self.count.saturating_add(1)
        } else {
            1
        };
        self.released_at = Some(now);
        self.point = Some(point);
        self.count
    }

    /// A drag selects text on its own, so it ends any multi-click chain.
    fn reset(&mut self) {
        self.released_at = None;
        self.point = None;
        self.count = 0;
    }
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

    if is_drag_gesture(origin, end, DRAG_THRESHOLD_PX) {
        state.clicks.reset();
        if !inner.enabled.load(Ordering::Acquire) {
            return;
        }
        let anchor = (end.0.round() as i32, end.1.round() as i32);
        inner.send_capture(TriggerSource::Mouse, Some(anchor));
        return;
    }

    // Plain click: the first click of a chain never captures, only a
    // double/triple click selects a word or paragraph worth reading.
    let count = state
        .clicks
        .register(end, Instant::now(), crate::win32::double_click_time());
    if count < 2 || !inner.enabled.load(Ordering::Acquire) {
        return;
    }
    let anchor = (end.0.round() as i32, end.1.round() as i32);
    inner.send_capture(TriggerSource::Click, Some(anchor));
}

/// A selection gesture needs a real drag, otherwise every click would fire UIA.
fn is_drag_gesture(origin: (f64, f64), end: (f64, f64), threshold: f64) -> bool {
    let dx = end.0 - origin.0;
    let dy = end.1 - origin.1;
    dx * dx + dy * dy >= threshold * threshold
}

/// True when two points are at most `threshold` physical pixels apart.
fn points_within(a: (f64, f64), b: (f64, f64), threshold: f64) -> bool {
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    dx * dx + dy * dy <= threshold * threshold
}

#[cfg(test)]
mod tests {
    use super::*;

    /// System default double-click time, used by the pure-function tests.
    const TEST_DOUBLE_CLICK: Duration = Duration::from_millis(500);

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

    #[test]
    fn click_points_use_the_same_threshold() {
        assert!(points_within((0.0, 0.0), (0.0, 0.0), DRAG_THRESHOLD_PX));
        assert!(points_within((0.0, 0.0), (3.0, 4.0), DRAG_THRESHOLD_PX));
        assert!(points_within((0.0, 0.0), (6.0, 0.0), DRAG_THRESHOLD_PX));
        assert!(!points_within((0.0, 0.0), (4.0, 5.0), DRAG_THRESHOLD_PX));
        assert!(!points_within(
            (100.0, 100.0),
            (100.0, 110.0),
            DRAG_THRESHOLD_PX
        ));
    }

    #[test]
    fn nearby_click_within_double_click_time_counts_as_double_click() {
        let start = Instant::now();
        let mut chain = ClickChain::default();
        assert_eq!(chain.register((100.0, 100.0), start, TEST_DOUBLE_CLICK), 1);
        assert_eq!(
            chain.register(
                (101.0, 101.0),
                start + Duration::from_millis(120),
                TEST_DOUBLE_CLICK
            ),
            2
        );
        // Exactly at the double-click threshold is still one chain.
        assert_eq!(
            chain.register(
                (100.0, 100.0),
                start + Duration::from_millis(620),
                TEST_DOUBLE_CLICK
            ),
            3
        );
    }

    #[test]
    fn slow_follow_up_click_starts_a_new_chain() {
        let start = Instant::now();
        let mut chain = ClickChain::default();
        assert_eq!(chain.register((10.0, 10.0), start, TEST_DOUBLE_CLICK), 1);
        let count = chain.register(
            (10.0, 10.0),
            start + Duration::from_millis(600),
            TEST_DOUBLE_CLICK,
        );
        assert_eq!(count, 1);
    }

    #[test]
    fn distant_follow_up_click_starts_a_new_chain() {
        let start = Instant::now();
        let mut chain = ClickChain::default();
        assert_eq!(chain.register((10.0, 10.0), start, TEST_DOUBLE_CLICK), 1);
        let count = chain.register(
            (30.0, 10.0),
            start + Duration::from_millis(80),
            TEST_DOUBLE_CLICK,
        );
        assert_eq!(count, 1);
    }

    #[test]
    fn triple_click_counts_three_and_drag_resets_the_chain() {
        let start = Instant::now();
        let mut chain = ClickChain::default();
        let mut count = 0;
        for step in 0u64..3 {
            count = chain.register(
                (50.0, 50.0),
                start + Duration::from_millis(step * 100),
                TEST_DOUBLE_CLICK,
            );
        }
        assert_eq!(count, 3);

        chain.reset();
        assert_eq!(
            chain.register(
                (50.0, 50.0),
                start + Duration::from_millis(400),
                TEST_DOUBLE_CLICK
            ),
            1
        );
    }
}
