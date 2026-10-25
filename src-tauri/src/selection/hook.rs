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

use super::{ActionRequest, Inner, TriggerSource};

/// Minimum physical drag distance for a mouse gesture to count as a selection.
const DRAG_THRESHOLD_PX: f64 = 6.0;

/// State tracked between events of the single hook callback.
#[derive(Default)]
struct HookState {
    mouse: Option<(f64, f64)>,
    press_origin: Option<(f64, f64)>,
    clicks: ClickChain,
    /// Modifier state for the Win+Shift+X screenshot shortcut.
    meta: bool,
    shift: bool,
    /// `true` once the shortcut fired, so auto-repeat only starts one capture.
    capture_fired: bool,
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
        .name("lexora-hook".to_string())
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
        // Any other user input means the toolbar is in the way: hide it so the
        // application under the cursor keeps receiving normal input.
        EventType::ButtonPress(Button::Right) | EventType::ButtonPress(Button::Middle) => {
            dismiss_picker_on_input(inner, "鼠标按键");
        }
        // Wheel over a toolbar-only capsule dismisses it (the capsule is in the
        // way of normal scrolling). While a result panel is open the shell vetoes
        // this dismissal via `panel_open`, so long content stays scrollable.
        EventType::Wheel { .. } => dismiss_picker_on_input(inner, "滚轮"),
        _ => {}
    }
}

/// Keyboard input: track the Win/Shift modifiers, start a screenshot on
/// Win+Shift+X, and otherwise keep the legacy "typing dismisses the toolbar"
/// behavior.
fn handle_key_press(inner: &Arc<Inner>, state: &mut HookState, key: Key) {
    match key {
        Key::MetaLeft | Key::MetaRight => state.meta = true,
        Key::ShiftLeft | Key::ShiftRight => state.shift = true,
        Key::KeyX => {}
        _ => {}
    }
    dismiss_picker_on_input(inner, "键盘操作");
}

fn handle_key_release(state: &mut HookState, key: Key) {
    match key {
        Key::MetaLeft | Key::MetaRight => {
            state.meta = false;
            state.capture_fired = false;
        }
        Key::ShiftLeft | Key::ShiftRight => {
            state.shift = false;
            state.capture_fired = false;
        }
        Key::KeyX => state.capture_fired = false,
        _ => {}
    }
}

/// Hides an un-pinned toolbar when the user keeps typing/clicking.
///
/// The picker window is non-activating, so these events already go to the
/// foreground application; the toolbar only steps out of the way. A sticky
/// panel (pinned or an open result panel) is never dismissed this way.
fn dismiss_picker_on_input(inner: &Arc<Inner>, reason: &'static str) {
    if !inner.picker_visible.load(Ordering::Acquire)
        || inner.panel_pinned.load(Ordering::Acquire)
        || inner.panel_open.load(Ordering::Acquire)
    {
        return;
    }
    inner.send_action(ActionRequest::DismissOnInput { reason });
}

fn handle_left_press(inner: &Arc<Inner>, state: &mut HookState) {
    // `ButtonRelease` carries no coordinates, so the latest `MouseMove` is the
    // drag origin. Mouse events are always delivered before the button event.
    state.press_origin = state.mouse;

    // A left click outside the picker dismisses it (unless the panel is pinned).
    // An open result panel is sticky for keyboard/right-click input, but an
    // outside click still hides the picker while it is not pinned.
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
