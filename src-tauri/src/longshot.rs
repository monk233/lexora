//! Manual-scroll long screenshot (contract §11.14/§11.14.1).
//!
//! `longshot_start` keeps the capture overlay **visible** (the selection shows a
//! live view of the target application) but makes it click-through, seeds the
//! stitcher with the selected region and shows a small preview window **beside**
//! the selection. The user scrolls the target application manually, in either
//! direction; a background thread grabs the same screen region ~8 times per
//! second and stitches the new content:
//!
//! * vertical scrolling uses the row-overlap stitcher from [`crate::capture`];
//! * horizontal scrolling rotates each frame by 90° and reuses the same row
//!   stitcher (columns become rows), rotating the result back for preview/export;
//! * every frame is tried both as an append (scrolling forward) and as a prepend
//!   (scrolling back), so the user can move up/down/left/right freely.
//!
//! No synthetic wheel input or cursor movement is ever generated here — the user
//! is in full control. `longshot_finish` copies + pins the stitched image and
//! closes the preview; `longshot_cancel` restores the capture overlay.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use image::RgbaImage;
use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

use crate::capture::{
    clamp_rect, find_overlap, find_overlap_prepend, frames_identical, preview_jpeg_data_url,
    write_clipboard_image, HitRect, LongshotSeed, Stitched,
};
use crate::engine::EngineError;
use crate::state::AppState;
use crate::win32;

/// Window label of the long-screenshot preview (fixed: one session at a time).
pub const LONG_SHOT_LABEL: &str = "longshot";
/// Window label of the floating control bar (direction / cancel / finish). It is
/// a separate clickable window because the capture overlays are click-through
/// during a manual long screenshot (the wheel must reach the target app).
pub const LONG_SHOT_BAR_LABEL: &str = "longshot-bar";
/// Rust → `longshot` window: stitched size/frame counter changed.
const EVENT_PROGRESS: &str = "longshot-progress";
/// Rust → capture overlay windows: enter the live long-screenshot mode.
pub const EVENT_STARTED: &str = "longshot-started";
/// Rust → capture overlay windows: the manual session was cancelled.
pub const EVENT_CANCELLED: &str = "longshot-cancelled";

/// Preview window layout: FIXED height (bounded), width follows the stitched
/// aspect ratio (it narrows as the image grows) and the window sits under the
/// control bar; the content is scaled to fit the window.
const PREVIEW_MAX_WORK_RATIO: f64 = 0.62;
const PREVIEW_MAX_LOGICAL_HEIGHT: f64 = 760.0;
const PREVIEW_MIN_LOGICAL_HEIGHT: f64 = 240.0;
const PREVIEW_WIDTH_MIN: u32 = 90;
const PREVIEW_WIDTH_MAX: u32 = 560;
/// Throttle for preview window resizes: the width follows the aspect ratio and
/// changes with every stitch, so resize at most every 200ms and only for
/// meaningful changes.
const PREVIEW_MIN_RESIZE_CSS: f64 = 6.0;
const PREVIEW_RESIZE_INTERVAL: Duration = Duration::from_millis(200);
/// Gap between the selection and the preview / control bar (physical pixels).
const PREVIEW_GAP: i32 = 8;
/// Control bar logical size (white floating card, capture-toolbar style).
const BAR_LOGICAL_WIDTH: f64 = 660.0;
const BAR_LOGICAL_HEIGHT: f64 = 56.0;
/// How long the grab loop waits for a new frame from the continuous capture
/// session before looping again (the session pushes a frame only when the screen
/// changes, so an idle desktop simply waits here).
const FRAME_WAIT: Duration = Duration::from_millis(160);
/// Auto-scroll mode (ShareX-style scrolling capture): the shell scrolls the
/// target application itself in small steps, waits for the frame to settle and
/// only then stitches. Deterministic steps make the overlap search trivial and
/// remove the "user scrolled but nothing was stitched" failures that happen when
/// a frame is grabbed while the page is still animating. The cursor is never
/// moved; scrolling stops when the pointer leaves the selection.
const AUTOSCROLL_NOTCHES: i32 = 2;
const AUTOSCROLL_SETTLE: Duration = Duration::from_millis(520);
/// Stop auto-scrolling after this many identical frames (end of the content).
const AUTOSCROLL_STOP_STREAK: u32 = 2;
/// Size limits (contract §11.14).
const MAX_VERTICAL_HEIGHT: u32 = 30_000;
const MAX_HORIZONTAL_WIDTH: u32 = 40_000;
const MAX_PIXELS: u64 = 64_000_000;
/// Grab inset on each side of the selection in CSS pixels, converted to physical
/// pixels with the monitor DPI scale so the selection border never lands in the
/// stitched image (contract §11.14.1).
const CROP_INSET_CSS: f64 = 2.0;

/// Scroll direction of the manual long screenshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Direction {
    #[default]
    Vertical,
    Horizontal,
}

impl Direction {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "vertical" => Some(Direction::Vertical),
            "horizontal" => Some(Direction::Horizontal),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Direction::Vertical => "vertical",
            Direction::Horizontal => "horizontal",
        }
    }
}

/// Physical geometry of the stitched region inside its monitor.
#[derive(Debug, Clone, Copy)]
struct Geometry {
    origin_x: i32,
    origin_y: i32,
    monitor_width: u32,
    monitor_height: u32,
    /// Grabbed region inside the monitor image (selection inset by the border
    /// safety margin, contract §11.14.1).
    crop: (u32, u32, u32, u32),
    /// Original selection rectangle in physical screen coordinates (used to
    /// place the preview window beside the selection).
    selection_screen: (i32, i32, i32, i32),
}

impl Geometry {
    fn capture_rect(&self) -> HitRect {
        let (left, top, width, height) = self.crop;
        HitRect {
            x: left as f64,
            y: top as f64,
            width: width as f64,
            height: height as f64,
        }
    }

    /// Selection rectangle in physical screen coordinates.
    fn screen_rect(&self) -> (i32, i32, i32, i32) {
        self.selection_screen
    }

    #[cfg(test)]
    fn center(&self) -> (i32, i32) {
        let (left, top, width, height) = self.screen_rect();
        (left + width / 2, top + height / 2)
    }
}

/// Cached `longshot_preview` payload; re-encoded only when the stitched image
/// changed.
struct PreviewCache {
    revision: u64,
    width: u32,
    height: u32,
    data_url: String,
}

/// Mutable stitching state, shared between the commands and the grab thread.
struct Shared {
    direction: Direction,
    /// First frame in its original orientation; direction switches reset from it.
    first_frame: RgbaImage,
    /// Stitched image in **stitch space** (rotated for horizontal scrolling).
    stitched: Stitched,
    /// Last grabbed frame in stitch space (used for the identical-frame check).
    last_frame: RgbaImage,
    /// Overlap hint of the most recent append (forward scrolling).
    last_append_overlap: Option<u32>,
    /// Overlap hint of the most recent prepend (backwards scrolling).
    last_prepend_overlap: Option<u32>,
    frames: u32,
    /// Consecutive frames that could not be matched; the stalled flag only
    /// surfaces after a few misses so a single torn/blurred frame does not flash
    /// the "scroll slower" warning (fast scrolling is supported).
    misses: u32,
    /// After a direction switch the next grabbed frame becomes the new base:
    /// the user has already scrolled away from the original first frame.
    resync: bool,
    /// Auto-scroll mode: the grab thread scrolls the target app itself in small
    /// steps and waits for the frame to settle before stitching (ShareX-style
    /// scrolling capture), so matching is deterministic while it runs.
    autoscroll: bool,
    stalled: bool,
    limit_reached: bool,
    revision: u64,
    preview: Option<PreviewCache>,
}

/// One running manual long-screenshot session.
struct Runtime {
    shared: Mutex<Shared>,
    stop: Arc<AtomicBool>,
    /// Set by the grab thread when its loop has actually exited (used by
    /// `longshot_finish` so the exported image cannot miss a late frame).
    finished: Arc<AtomicBool>,
    geometry: Geometry,
    /// Work area of the selection monitor (preview window layout).
    work: win32::WorkArea,
    /// DPI scale of the selection monitor.
    scale: f64,
    /// Physical size of the control bar window (preview layout below it).
    bar_physical: (i32, i32),
}

fn session_cell() -> &'static Mutex<Option<Arc<Runtime>>> {
    static SESSION: OnceLock<Mutex<Option<Arc<Runtime>>>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(None))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn active_runtime() -> Option<Arc<Runtime>> {
    lock(session_cell()).clone()
}

fn take_runtime() -> Option<Arc<Runtime>> {
    lock(session_cell()).take()
}

/// Stops and forgets the current session without destroying any window (used
/// when the preview window is destroyed by the shell or during shutdown) and
/// restores the capture overlay's normal mouse handling.
pub fn forget_session(app: &AppHandle) {
    if let Some(runtime) = take_runtime() {
        runtime.stop.store(true, Ordering::SeqCst);
    }
    set_overlay_click_through(app, false);
}

fn not_running_error() -> EngineError {
    EngineError::new("长截图未在进行中。", "请先在截图上点击「长截图」后再试。")
}

fn already_running_error() -> EngineError {
    EngineError::new("长截图已在进行中。", "请先完成或取消当前长截图后再试。")
}

fn log_info(app: &AppHandle, message: &str) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        state.log.info(message);
    }
}

fn log_warn(app: &AppHandle, message: &str) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        state.log.warn(message);
    }
}

/// Toggles click-through (`ignore_cursor_events`) on every capture overlay
/// window. During the manual long screenshot the overlays stay visible (live
/// selection frame) but must not swallow wheel/mouse input, so the user can
/// scroll the target application below them (contract §11.14.1). Returns the
/// number of overlay windows updated.
fn set_overlay_click_through(app: &AppHandle, ignore: bool) -> usize {
    let mut updated = 0;
    for (label, window) in app.webview_windows() {
        if !label.starts_with(crate::windows::CAPTURE_PREFIX) {
            continue;
        }
        if window.set_ignore_cursor_events(ignore).is_ok() {
            updated += 1;
        }
    }
    updated
}

// ---------------------------------------------------------------------------
// Pure layout / direction helpers (unit-tested below)
// ---------------------------------------------------------------------------

/// Logical preview window size + physical position.
///
/// The preview hugs the **side of the selection** (right when there is room,
/// otherwise left) and is **bottom-aligned with the selection**; its height is
/// fixed (bounded by the selection height and the work area) while the width
/// follows the stitched aspect ratio, so the window narrows as the long
/// screenshot grows and the image fills it edge to edge (no big white/transparent
/// letterbox window around the picture).
fn preview_placement(
    display_width: u32,
    display_height: u32,
    scale: f64,
    work: &win32::WorkArea,
    selection: (i32, i32, i32, i32),
    _bar_physical: (i32, i32),
) -> ((f64, f64), (i32, i32)) {
    let scale = if scale.is_finite() && scale > 0.1 {
        scale
    } else {
        1.0
    };
    let (left, top, sel_width, sel_height) = selection;
    let right = left.saturating_add(sel_width);
    let bottom = top.saturating_add(sel_height);
    let aspect = display_width.max(1) as f64 / display_height.max(1) as f64;
    let max_height = ((work.height().max(1) as f64) * PREVIEW_MAX_WORK_RATIO / scale)
        .min(PREVIEW_MAX_LOGICAL_HEIGHT)
        .max(PREVIEW_MIN_LOGICAL_HEIGHT);
    let selection_height = (sel_height.max(1) as f64) / scale;
    let height = max_height.min(selection_height.max(PREVIEW_MIN_LOGICAL_HEIGHT));
    let width = (height * aspect).clamp(PREVIEW_WIDTH_MIN as f64, PREVIEW_WIDTH_MAX as f64);
    let physical = (
        ((width * scale).round() as i32).max(1),
        ((height * scale).round() as i32).max(1),
    );
    let gap = PREVIEW_GAP;
    // Side of the selection: right when there is room, otherwise left; clamp as
    // the last resort.
    let x = if work.right - right >= physical.0 + gap {
        right + gap
    } else if left - work.left >= physical.0 + gap {
        left - gap - physical.0
    } else {
        work.right - physical.0
    };
    // Bottom edge aligned with the selection bottom.
    let y = bottom - physical.1;
    (
        (width, height),
        win32::clamp_to_work_area(x, y, physical.0, physical.1, work),
    )
}

/// Physical top-left position of the floating control bar: below the selection
/// (like the screenshot toolbar), above it when there is no room below, clamped
/// into the work area.
fn control_bar_position(
    selection: (i32, i32, i32, i32),
    window: (i32, i32),
    work: &win32::WorkArea,
) -> (i32, i32) {
    let (left, top, _width, height) = selection;
    let (window_width, window_height) = (window.0.max(1), window.1.max(1));
    let bottom = top.saturating_add(height);
    let y = if bottom + PREVIEW_GAP + window_height <= work.bottom {
        bottom + PREVIEW_GAP
    } else if top - PREVIEW_GAP - window_height >= work.top {
        top - PREVIEW_GAP - window_height
    } else {
        bottom + PREVIEW_GAP
    };
    win32::clamp_to_work_area(left, y, window_width, window_height, work)
}

/// Insets a crop rectangle by the selection-border margin (≈2 CSS pixels,
/// converted with `scale`) so the blue selection border never appears in the
/// stitched image (contract §11.14.1). The inset is capped so at least 1×1 pixel
/// remains.
fn inset_crop(crop: (u32, u32, u32, u32), scale: f64) -> (u32, u32, u32, u32) {
    let (left, top, width, height) = crop;
    let scale = if scale.is_finite() && scale > 0.1 {
        scale
    } else {
        1.0
    };
    let requested = (CROP_INSET_CSS * scale).round().max(1.0) as u32;
    let inset_x = requested.min(width.saturating_sub(1) / 2);
    let inset_y = requested.min(height.saturating_sub(1) / 2);
    (
        left + inset_x,
        top + inset_y,
        width.saturating_sub(inset_x * 2).max(1),
        height.saturating_sub(inset_y * 2).max(1),
    )
}

/// Side of the stitched image a frame was merged on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MergeSide {
    /// Appended after the stitched content (scrolling forward/down/right).
    Append,
    /// Prepended before the stitched content (scrolling back/up/left).
    Prepend,
}

/// Chooses the better of the two overlap candidates: the larger reliable
/// overlap wins, ties prefer appending (forward scrolling is the common case).
fn choose_merge(append: Option<u32>, prepend: Option<u32>) -> Option<(MergeSide, u32)> {
    match (append, prepend) {
        (None, None) => None,
        (Some(overlap), None) => Some((MergeSide::Append, overlap)),
        (None, Some(overlap)) => Some((MergeSide::Prepend, overlap)),
        (Some(append_overlap), Some(prepend_overlap)) => {
            if prepend_overlap > append_overlap {
                Some((MergeSide::Prepend, prepend_overlap))
            } else {
                Some((MergeSide::Append, append_overlap))
            }
        }
    }
}

/// `true` when appending `stitched_height` (stitch space) would exceed the
/// direction's size or the global pixel budget.
fn exceeds_limits(direction: Direction, stitched_width: u32, stitched_height: u32) -> bool {
    let pixel_budget = (stitched_width as u64).saturating_mul(stitched_height as u64);
    if pixel_budget > MAX_PIXELS {
        return true;
    }
    match direction {
        Direction::Vertical => stitched_height > MAX_VERTICAL_HEIGHT,
        // For horizontal scrolling the stitch-space height is the final width.
        Direction::Horizontal => stitched_height > MAX_HORIZONTAL_WIDTH,
    }
}

/// Puts a frame into stitch space (horizontal frames are rotated 90°).
fn orient_frame(frame: RgbaImage, direction: Direction) -> RgbaImage {
    match direction {
        Direction::Vertical => frame,
        Direction::Horizontal => image::imageops::rotate90(&frame),
    }
}

//// Stitched display size (original orientation) for `(width, height)` reporting.
fn display_dimensions(shared: &Shared) -> (u32, u32) {
    match shared.direction {
        Direction::Vertical => (shared.stitched.width(), shared.stitched.height()),
        Direction::Horizontal => (shared.stitched.height(), shared.stitched.width()),
    }
}

//// Full-resolution stitched image in the original orientation.
fn display_image(shared: &Shared) -> RgbaImage {
    let image = shared.stitched.to_image();
    match shared.direction {
        Direction::Vertical => image,
        Direction::Horizontal => image::imageops::rotate270(&image),
    }
}

/// Preview-sized stitched image: resized (non-uniformly, to match the preview
/// window's content box) so the encoded PNG is always about one window large no
/// matter how long the stitched image gets — constant encoding cost and no
/// growing IPC payload. The finish path uses the full-resolution
/// [`display_image`].
fn display_preview_image(shared: &Shared, target_width: u32, target_height: u32) -> RgbaImage {
    match shared.direction {
        Direction::Vertical => shared.stitched.resized_to(target_width, target_height),
        Direction::Horizontal => {
            let rotated = shared.stitched.resized_to(target_height, target_width);
            image::imageops::rotate270(&rotated)
        }
    }
}

/// Window layout (logical size + physical position) of the preview for a stitched
/// image.
fn preview_placement_for(
    runtime: &Runtime,
    display_width: u32,
    display_height: u32,
) -> ((f64, f64), (i32, i32)) {
    preview_placement(
        display_width,
        display_height,
        runtime.scale,
        &runtime.work,
        runtime.geometry.screen_rect(),
        runtime.bar_physical,
    )
}

/// Physical pixel target for the preview JPEG: the window is already shaped to
/// the stitched image (fixed height, aspect-ratio width), so the target is the
/// window's client size, capped so the JPEG stays cheap to encode/send.
fn preview_target_size(runtime: &Runtime, display_width: u32, display_height: u32) -> (u32, u32) {
    let (_, physical) = preview_placement_for(runtime, display_width, display_height);
    let width = (physical.0 as u32).clamp(60, 900);
    let height = (physical.1 as u32).clamp(60, 1200);
    (width, height)
}

/// Resets the stitcher for a direction switch. The preview immediately shows the
/// original first frame, and the grab thread re-seeds itself with the **current**
/// screen on its next frame (`resync`), because the user has usually scrolled
/// away from where the long screenshot was started.
fn reset_stitch(shared: &mut Shared, direction: Direction) {
    let first = orient_frame(shared.first_frame.clone(), direction);
    let autoscroll = shared.autoscroll;
    *shared = Shared {
        direction,
        first_frame: shared.first_frame.clone(),
        stitched: Stitched::from_image(&first),
        last_frame: first,
        last_append_overlap: None,
        last_prepend_overlap: None,
        frames: 1,
        misses: 0,
        resync: true,
        autoscroll,
        stalled: false,
        limit_reached: false,
        revision: shared.revision.wrapping_add(1),
        preview: None,
    };
}

fn progress_payload(shared: &Shared) -> Value {
    let (width, height) = display_dimensions(shared);
    json!({
        "width": width,
        "height": height,
        "frames": shared.frames,
        "revision": shared.revision,
        "stalled": shared.stalled,
        "autoscroll": shared.autoscroll,
    })
}

// ---------------------------------------------------------------------------
// Background stitcher
// ---------------------------------------------------------------------------

/// Merges one grabbed frame into the session (forward append or backward
/// prepend, whichever overlap is larger). Returns the progress payload when the
/// frame was processed (also when it stalled), `None` when the session is
/// already done.
fn stitch_frame(runtime: &Runtime, frame: RgbaImage) -> Option<Value> {
    let mut shared = lock(&runtime.shared);
    if shared.limit_reached {
        return None;
    }
    let direction = shared.direction;
    let oriented = orient_frame(frame, direction);
    if shared.resync {
        /* Direction switched: restart from what is on screen right now. */
        let revision = shared.revision.wrapping_add(1);
        let autoscroll = shared.autoscroll;
        let first_frame = oriented.clone();
        *shared = Shared {
            direction,
            first_frame: first_frame.clone(),
            stitched: Stitched::from_image(&oriented),
            last_frame: oriented,
            last_append_overlap: None,
            last_prepend_overlap: None,
            frames: 1,
            misses: 0,
            resync: false,
            autoscroll,
            stalled: false,
            limit_reached: false,
            revision,
            preview: None,
        };
        return Some(progress_payload(&shared));
    }
    if frames_identical(&shared.last_frame, &oriented) {
        return None;
    }
    let append = find_overlap(&shared.stitched, &oriented, shared.last_append_overlap);
    let prepend = find_overlap_prepend(&shared.stitched, &oriented, shared.last_prepend_overlap);
    let Some((side, overlap)) = choose_merge(append, prepend) else {
        return miss(&mut shared, oriented);
    };
    let added_rows = oriented.height().saturating_sub(overlap);
    if added_rows == 0 {
        return miss(&mut shared, oriented);
    }
    let projected = shared.stitched.height().saturating_add(added_rows);
    if exceeds_limits(direction, shared.stitched.width(), projected) {
        shared.last_frame = oriented;
        shared.limit_reached = true;
        shared.stalled = true;
        return Some(progress_payload(&shared));
    }
    match side {
        MergeSide::Append => {
            shared.stitched.push_rows(&oriented, overlap);
            shared.last_append_overlap = Some(overlap);
        }
        MergeSide::Prepend => {
            shared.stitched.prepend_rows(&oriented, overlap);
            shared.last_prepend_overlap = Some(overlap);
        }
    }
    shared.last_frame = oriented;
    shared.frames = shared.frames.saturating_add(1);
    shared.misses = 0;
    shared.stalled = false;
    shared.revision = shared.revision.wrapping_add(1);
    Some(progress_payload(&shared))
}

/// A frame that could not be matched (torn grab / very fast flick). One miss is
/// tolerated silently so fast scrolling does not flash the warning; only three
/// consecutive misses surface `stalled`.
fn miss(shared: &mut Shared, frame: RgbaImage) -> Option<Value> {
    shared.last_frame = frame;
    shared.misses = shared.misses.saturating_add(1);
    shared.stalled = shared.misses >= 3;
    Some(progress_payload(shared))
}

/// Background grab loop: `xcap::Monitor` is not `Send`, which is why it lives
/// entirely inside one dedicated thread.
///
/// It uses ONE continuous WGC capture session (`video_recorder`) instead of a
/// fresh `capture_image()` per frame: creating and tearing down a GraphicsCapture
/// session every 40ms proved unreliable on real desktops (a session can stall or
/// time out, after which the preview kept showing the first frame forever). The
/// session pushes a frame whenever the screen changes; the loop drains to the
/// newest one and stitches it.
fn capture_loop(app: AppHandle, runtime: Arc<Runtime>) {
    // Publish "loop has exited" on every return path (including early errors).
    struct FinishGuard(Arc<AtomicBool>);
    impl Drop for FinishGuard {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let _finished = FinishGuard(runtime.finished.clone());

    let geometry = runtime.geometry;
    let (selection_x, selection_y, selection_w, selection_h) = geometry.screen_rect();
    let selection_center = (selection_x + selection_w / 2, selection_y + selection_h / 2);
    // Pick the monitor under the selection directly: matching by position/size
    // could fail (toolkit vs physical geometry) and the old fallback to the first
    // monitor could grab the wrong screen on multi-monitor setups.
    let monitor = match xcap::Monitor::from_point(selection_center.0, selection_center.1) {
        Ok(monitor) => monitor,
        Err(error) => {
            log_warn(&app, &format!("longshot: monitor lookup failed: {error}"));
            match xcap::Monitor::all() {
                Ok(mut monitors) if !monitors.is_empty() => monitors.swap_remove(0),
                Ok(_) => {
                    log_warn(&app, "longshot: no monitor available for grabbing");
                    runtime.stop.store(true, Ordering::SeqCst);
                    return;
                }
                Err(error) => {
                    log_warn(
                        &app,
                        &format!("longshot: cannot enumerate monitors: {error}"),
                    );
                    runtime.stop.store(true, Ordering::SeqCst);
                    return;
                }
            }
        }
    };
    let capture_rect = geometry.capture_rect();
    let preview_window = app.get_webview_window(LONG_SHOT_LABEL);
    let mut preview_physical: Option<(u32, u32, i32, i32)> = None;
    let mut last_preview_resize = std::time::Instant::now()
        .checked_sub(PREVIEW_RESIZE_INTERVAL)
        .unwrap_or_else(std::time::Instant::now);
    let mut logged_stalled = false;
    let mut logged_limit = false;
    let mut identical_streak = 0u32;
    let mut fallback_shown = false;
    let loop_started = std::time::Instant::now();

    // One continuous capture session for the whole long screenshot.
    let (recorder, receiver) = match monitor.video_recorder() {
        Ok((recorder, receiver)) => {
            if recorder.start().is_ok() {
                (Some(recorder), Some(receiver))
            } else {
                log_warn(
                    &app,
                    "longshot: continuous capture did not start, using per-frame grabs",
                );
                (None, None)
            }
        }
        Err(error) => {
            log_warn(
                &app,
                &format!("longshot: continuous capture unavailable: {error}"),
            );
            (None, None)
        }
    };
    if let Some(recorder) = &recorder {
        // A stale Escape press from before the session started.
        let _ = win32::escape_pressed();
        let _ = recorder;
    }
    let mut grab_failures = 0u32;
    // True once auto-scrolling actually started (the pointer entered the
    // selection). While false the loop waits for the pointer instead of stopping
    // immediately: the user has just clicked the control bar below the selection.
    let mut autoscroll_armed = false;

    while !runtime.stop.load(Ordering::SeqCst) {
        // Esc cancels the whole long screenshot (the overlay is click-through and
        // the keyboard focus belongs to the scrolled application).
        if win32::escape_pressed() {
            log_info(&app, "longshot: cancelled with Escape");
            crate::longshot::cancel(&app);
            break;
        }
        let (autoscroll, direction) = {
            let shared = lock(&runtime.shared);
            (shared.autoscroll, shared.direction)
        };
        if !autoscroll {
            autoscroll_armed = false;
        }
        let mut scrolled_this_round = false;
        if autoscroll {
            let pointer_inside =
                win32::cursor_inside(selection_x, selection_y, selection_w, selection_h);
            if pointer_inside {
                autoscroll_armed = true;
                match direction {
                    Direction::Horizontal => {
                        win32::scroll_wheel_horizontal(AUTOSCROLL_NOTCHES);
                    }
                    Direction::Vertical => {
                        win32::scroll_wheel_notches(AUTOSCROLL_NOTCHES);
                    }
                }
                scrolled_this_round = true;
                std::thread::sleep(AUTOSCROLL_SETTLE);
            } else if autoscroll_armed {
                // The pointer left the selection after scrolling started: stop.
                let progress = {
                    let mut shared = lock(&runtime.shared);
                    shared.autoscroll = false;
                    progress_payload(&shared)
                };
                emit_progress(&app, progress);
                autoscroll_armed = false;
                log_info(
                    &app,
                    "longshot: auto-scroll stopped (pointer left the selection)",
                );
            } else {
                // Waiting for the pointer to come back into the selection; do not
                // scroll other windows and do not stop the mode.
                std::thread::sleep(Duration::from_millis(120));
            }
        }

        let captured = if let Some(receiver) = &receiver {
            match receiver.recv_timeout(FRAME_WAIT) {
                Ok(first) => {
                    // Drain the backlog: only the newest frame matters.
                    let mut latest = first;
                    while let Ok(next) = receiver.try_recv() {
                        latest = next;
                    }
                    RgbaImage::from_raw(latest.width, latest.height, latest.raw)
                }
                Err(_) => None,
            }
        } else {
            match monitor.capture_image() {
                Ok(captured) => {
                    grab_failures = 0;
                    Some(captured)
                }
                Err(error) => {
                    grab_failures = grab_failures.saturating_add(1);
                    if grab_failures == 3 {
                        log_warn(&app, &format!("longshot: frame grab failed: {error}"));
                    }
                    None
                }
            }
        };

        let Some(captured) = captured else {
            if autoscroll && scrolled_this_round {
                identical_streak = identical_streak.saturating_add(1);
                if identical_streak >= AUTOSCROLL_STOP_STREAK {
                    identical_streak = 0;
                    let progress = {
                        let mut shared = lock(&runtime.shared);
                        shared.autoscroll = false;
                        progress_payload(&shared)
                    };
                    emit_progress(&app, progress);
                    log_info(&app, "longshot: auto-scroll reached the end");
                }
            }
            maybe_show_preview_fallback(
                &preview_window,
                &mut fallback_shown,
                loop_started.elapsed(),
            );
            continue;
        };
        identical_streak = 0;

        let Some((left, top, width, height)) = clamp_rect(&captured, &capture_rect) else {
            if grab_failures <= 3 {
                grab_failures = grab_failures.saturating_add(1);
                log_warn(
                    &app,
                    &format!(
                        "longshot: frame {}x{} smaller than the capture region at ({},{})",
                        captured.width(),
                        captured.height(),
                        capture_rect.x,
                        capture_rect.y
                    ),
                );
            }
            maybe_show_preview_fallback(
                &preview_window,
                &mut fallback_shown,
                loop_started.elapsed(),
            );
            continue;
        };
        let frame = image::imageops::crop_imm(&captured, left, top, width, height).to_image();
        if let Some(progress) = stitch_frame(&runtime, frame) {
            // Log stall/limit transitions once instead of per frame.
            let (stalled, limit) = {
                let shared = lock(&runtime.shared);
                (shared.stalled, shared.limit_reached)
            };
            if stalled && !logged_stalled {
                logged_stalled = true;
                log_info(
                    &app,
                    "longshot: stalled (scroll slower or check the direction)",
                );
            }
            if limit && !logged_limit {
                logged_limit = true;
                log_info(
                    &app,
                    "longshot: size limit reached, further frames are ignored",
                );
            }
            if let Some(window) = &preview_window {
                if last_preview_resize.elapsed() >= PREVIEW_RESIZE_INTERVAL {
                    resize_preview_window(window, &runtime, &progress, &mut preview_physical);
                    last_preview_resize = std::time::Instant::now();
                }
            }
            emit_progress(&app, progress);
        }
        maybe_show_preview_fallback(&preview_window, &mut fallback_shown, loop_started.elapsed());
    }
    if let Some(recorder) = recorder {
        let _ = recorder.stop();
    }
}

/// Sizes/moves the preview window to the side of the selection, bottom-aligned,
/// with its width following the stitched aspect ratio (throttled by the caller).
fn resize_preview_window(
    window: &tauri::WebviewWindow,
    runtime: &Runtime,
    progress: &Value,
    last: &mut Option<(u32, u32, i32, i32)>,
) {
    let display_width = progress.get("width").and_then(Value::as_u64).unwrap_or(0) as u32;
    let display_height = progress.get("height").and_then(Value::as_u64).unwrap_or(0) as u32;
    if display_width == 0 || display_height == 0 {
        return;
    }
    let scale = runtime.scale;
    let (_, position) = preview_placement_for(runtime, display_width, display_height);
    let (logical_w, logical_h) = preview_placement_for(runtime, display_width, display_height).0;
    let physical = (
        ((logical_w * scale).round() as u32).max(1),
        ((logical_h * scale).round() as u32).max(1),
    );
    let next = (physical.0, physical.1, position.0, position.1);
    let changed = match last {
        None => true,
        Some((width, height, x, y)) => {
            *width != next.0
                || (*height as i64 - next.1 as i64).unsigned_abs() as f64
                    > PREVIEW_MIN_RESIZE_CSS * scale
                || (*x - next.2).abs() > 1
                || (*y - next.3).abs() > 1
        }
    };
    if !changed {
        return;
    }
    let sized = window
        .set_size(PhysicalSize::new(physical.0.max(1), physical.1.max(1)))
        .is_ok();
    if sized {
        let _ = window.set_position(PhysicalPosition::new(position.0, position.1));
        *last = Some(next);
    }
}

/// Shows the preview window after a few seconds even if the renderer never
/// reports its first painted frame (broken page), so the feature stays usable.
fn maybe_show_preview_fallback(
    preview_window: &Option<tauri::WebviewWindow>,
    shown: &mut bool,
    elapsed: Duration,
) {
    if *shown || elapsed < Duration::from_secs(3) {
        return;
    }
    *shown = true;
    if let Some(window) = preview_window {
        let _ = window.show();
    }
}

/// Applies the fixed preview window layout once (the window never resizes: a
/// stable window is what keeps the transparent preview flicker-free).
/// Sends one progress payload to every long-screenshot surface (preview + bar).
fn emit_progress(app: &AppHandle, progress: Value) {
    let _ = app.emit_to(LONG_SHOT_LABEL, EVENT_PROGRESS, progress.clone());
    let _ = app.emit_to(LONG_SHOT_BAR_LABEL, EVENT_PROGRESS, progress);
}

// ---------------------------------------------------------------------------
// Window + session commands
// ---------------------------------------------------------------------------

fn destroy_preview_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LONG_SHOT_LABEL) {
        let _ = window.destroy();
    }
}

fn destroy_control_bar(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LONG_SHOT_BAR_LABEL) {
        let _ = window.destroy();
    }
}

fn destroy_longshot_windows(app: &AppHandle) {
    destroy_preview_window(app);
    destroy_control_bar(app);
}

/// Creates one non-activating long-screenshot window. The preview window is
/// **opaque** (white card filling the window): a transparent window repaints
/// through the DWM alpha compositor on every resize, which showed as flicker
/// while the preview grew. The control bar stays transparent (it never resizes).
fn create_longshot_window(
    app: &AppHandle,
    label: &str,
    page: &str,
    title: &str,
    logical_size: (f64, f64),
    physical_size: (u32, u32),
    position: (i32, i32),
    transparent: bool,
) -> Result<tauri::WebviewWindow, EngineError> {
    let background = if transparent {
        tauri::window::Color(0, 0, 0, 0)
    } else {
        tauri::window::Color(255, 255, 255, 255)
    };
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title(title)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .transparent(transparent)
        .shadow(false)
        .visible(false)
        .focused(false)
        .background_color(background)
        .inner_size(logical_size.0, logical_size.1)
        .build()
        .map_err(|error| {
            EngineError::new(
                "无法创建长截图窗口。",
                format!("请重试或重启程序（{error}）。"),
            )
        })?;

    let place = window
        .set_position(PhysicalPosition::new(position.0, position.1))
        .and_then(|_| {
            window.set_size(PhysicalSize::new(
                physical_size.0.max(1),
                physical_size.1.max(1),
            ))
        });
    if let Err(error) = place {
        let _ = window.destroy();
        return Err(EngineError::new(
            "无法定位长截图窗口。",
            format!("请重试或重启程序（{error}）。"),
        ));
    }
    // Never steal focus from the application the user scrolls; the buttons still
    // receive mouse clicks (contract §11.14).
    if !win32::set_no_activate(&window) {
        log_warn(
            app,
            "longshot: could not set WS_EX_NOACTIVATE on a longshot window",
        );
    }
    if !win32::disable_transitions(&window) {
        log_warn(app, "longshot: could not disable DWM transitions");
    }
    Ok(window)
}

/// `longshot_start {index, rect}` — seeds the stitcher, hides the capture
/// overlay and shows the preview window (contract §11.14).
///
/// Async on purpose: creating a webview window from a sync command would block
/// the event loop that has to build it (deadlock).
#[tauri::command]
pub async fn longshot_start(app: AppHandle, index: u32, rect: HitRect) -> Result<Value, String> {
    Ok(match start_impl(&app, index, &rect) {
        Ok(value) => value,
        Err(error) => {
            json!({ "ok": false, "error": error.message, "hint": error.hint })
        }
    })
}

fn start_impl(app: &AppHandle, index: u32, rect: &HitRect) -> Result<Value, EngineError> {
    if active_runtime().is_some() {
        return Err(already_running_error());
    }
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return Err(EngineError::new("应用状态不可用。", "请重启程序后重试。"));
    };
    if !state.capture.is_active() {
        return Err(EngineError::new(
            "截图会话不存在。",
            "请重新截图后再点击「长截图」。",
        ));
    }
    let seed = state.capture.longshot_seed(index, rect)?;
    let LongshotSeed {
        origin_x,
        origin_y,
        monitor_width,
        monitor_height,
        crop: selection_crop,
        first_frame: selection_image,
    } = seed;
    let selection_screen = (
        origin_x + selection_crop.0 as i32,
        origin_y + selection_crop.1 as i32,
        selection_crop.2 as i32,
        selection_crop.3 as i32,
    );
    let center = (
        selection_screen.0 + selection_screen.2 / 2,
        selection_screen.1 + selection_screen.3 / 2,
    );
    let scale = win32::monitor_scale_factor(center.0, center.1);
    let scale = if scale.is_finite() && scale > 0.1 {
        scale
    } else {
        1.0
    };
    let work = win32::work_area_physical(center.0, center.1);
    // Inset the grabbed region so the blue selection border never lands in the
    // stitched image (contract §11.14.1).
    let crop = inset_crop(selection_crop, scale);
    let first_frame = image::imageops::crop_imm(
        &selection_image,
        crop.0 - selection_crop.0,
        crop.1 - selection_crop.1,
        crop.2,
        crop.3,
    )
    .to_image();
    let geometry = Geometry {
        origin_x,
        origin_y,
        monitor_width,
        monitor_height,
        crop,
        selection_screen,
    };
    let (initial_width, initial_height) = first_frame.dimensions();
    let bar_logical = (BAR_LOGICAL_WIDTH, BAR_LOGICAL_HEIGHT);
    let bar_physical = (
        ((bar_logical.0 * scale).round() as u32).max(1),
        ((bar_logical.1 * scale).round() as u32).max(1),
    );
    let bar_position = control_bar_position(
        geometry.screen_rect(),
        (bar_physical.0 as i32, bar_physical.1 as i32),
        &work,
    );
    let (logical_size, position) = preview_placement(
        initial_width,
        initial_height,
        scale,
        &work,
        geometry.screen_rect(),
        (bar_physical.0 as i32, bar_physical.1 as i32),
    );
    let physical_size = (
        ((logical_size.0 * scale).round() as u32).max(1),
        ((logical_size.1 * scale).round() as u32).max(1),
    );

    // The overlay stays visible (live selection frame + dimmed outside) but must
    // not swallow the wheel/mouse input the user needs to scroll the target
    // application: make every capture window click-through (contract §11.14.1).
    // The control bar is a separate, clickable window below the selection.
    set_overlay_click_through(app, true);
    let preview = match create_longshot_window(
        app,
        LONG_SHOT_LABEL,
        "longshot.html",
        "Lexora 长截图",
        logical_size,
        physical_size,
        position,
        false,
    ) {
        Ok(window) => window,
        Err(error) => {
            set_overlay_click_through(app, false);
            return Err(error);
        }
    };
    let bar = match create_longshot_window(
        app,
        LONG_SHOT_BAR_LABEL,
        "longshot-bar.html",
        "Lexora 长截图控制",
        bar_logical,
        bar_physical,
        bar_position,
        true,
    ) {
        Ok(window) => window,
        Err(error) => {
            let _ = preview.destroy();
            set_overlay_click_through(app, false);
            return Err(error);
        }
    };
    // The overlay keeps keyboard focus after its buttons were used; hand it to
    // the application under the selection (both longshot windows are NOACTIVATE,
    // so they will not take it back).
    if !win32::focus_window_at(center.0, center.1) {
        log_warn(
            app,
            "longshot: could not focus the application under the selection",
        );
    }

    let shared = Shared {
        direction: Direction::Vertical,
        stitched: Stitched::from_image(&first_frame),
        last_frame: first_frame.clone(),
        first_frame,
        last_append_overlap: None,
        last_prepend_overlap: None,
        frames: 1,
        misses: 0,
        resync: false,
        autoscroll: false,
        stalled: false,
        limit_reached: false,
        revision: 0,
        preview: None,
    };
    let runtime = Arc::new(Runtime {
        shared: Mutex::new(shared),
        stop: Arc::new(AtomicBool::new(false)),
        finished: Arc::new(AtomicBool::new(false)),
        geometry,
        work,
        scale,
        bar_physical: (bar_physical.0 as i32, bar_physical.1 as i32),
    });
    *lock(session_cell()) = Some(runtime.clone());

    let thread_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("lexora-longshot".to_string())
        .spawn(move || capture_loop(thread_app, runtime));
    if let Err(error) = spawned {
        forget_session(app);
        destroy_longshot_windows(app);
        return Err(EngineError::new(
            "无法启动长截图线程。",
            format!("请重试或重启程序（{error}）。"),
        ));
    }

    // Session state is ready before the pages become visible, so their first
    // `longshot_state`/`longshot_preview` calls already succeed.
    //
    // The preview window stays HIDDEN here: showing it before the first stitched
    // frame is painted flashed a white window at the start of every long
    // screenshot. `longshot_preview_ready` shows it once the renderer has the
    // first image decoded (the grab thread has a 3s fallback show).
    if let Err(error) = bar.show() {
        forget_session(app);
        destroy_longshot_windows(app);
        return Err(EngineError::new(
            "无法显示长截图控制栏。",
            format!("请重试或重启程序（{error}）。"),
        ));
    }
    // Showing the control bar can still activate it on some systems (Tauri calls
    // SetForegroundWindow), which would swallow the user's wheel input. Hand the
    // focus back to the application under the selection.
    let _ = win32::focus_window_at(center.0, center.1);
    // Tell the overlays to switch to the live long-screenshot mode (hide the
    // frozen screenshot/handles, keep the selection border + mask; the page also
    // makes its own area transparent so the real application shows through).
    let _ = app.emit(EVENT_STARTED, json!({ "index": index }));

    log_info(
        app,
        &format!(
            "longshot: manual session started index={index} crop={}x{} at ({},{}) \
             preview={}x{} logical at ({},{})",
            geometry.crop.2,
            geometry.crop.3,
            geometry.screen_rect().0,
            geometry.screen_rect().1,
            logical_size.0,
            logical_size.1,
            position.0,
            position.1
        ),
    );
    Ok(json!({
        "ok": true,
        "width": initial_width,
        "height": initial_height,
        "direction": Direction::Vertical.as_str(),
    }))
}

/// `longshot_state {}` — size/frame counter/direction/stalled/done snapshot.
#[tauri::command]
pub fn longshot_state() -> Value {
    let Some(runtime) = active_runtime() else {
        return json!({
            "ok": false,
            "error": not_running_error().message,
            "hint": not_running_error().hint,
        });
    };
    let shared = lock(&runtime.shared);
    let (width, height) = display_dimensions(&shared);
    json!({
        "ok": true,
        "width": width,
        "height": height,
        "frames": shared.frames,
        "direction": shared.direction.as_str(),
        "stalled": shared.stalled,
        "done": shared.limit_reached,
        "revision": shared.revision,
        "autoscroll": shared.autoscroll,
    })
}

/// `longshot_preview_ready {}` — the renderer decoded the first preview frame:
/// show the preview window now. It is created hidden so the start of a long
/// screenshot never flashes a white window.
#[tauri::command]
pub fn longshot_preview_ready(app: AppHandle) -> Value {
    let Some(window) = app.get_webview_window(LONG_SHOT_LABEL) else {
        return json!({ "ok": false });
    };
    if window.is_visible().unwrap_or(false) {
        return json!({ "ok": true, "shown": false });
    }
    let shown = window.show().is_ok();
    if shown {
        if let Some(runtime) = active_runtime() {
            let (left, top, width, height) = runtime.geometry.screen_rect();
            let _ = win32::focus_window_at(left + width / 2, top + height / 2);
        }
    }
    json!({ "ok": shown, "shown": shown })
}

/// `longshot_autoscroll {enabled}` — toggles ShareX-style stepped auto-scrolling:
/// the shell scrolls the target application itself in small settled steps (the
/// grab thread does the actual scrolling), which makes stitching deterministic.
#[tauri::command]
pub fn longshot_autoscroll(app: AppHandle, enabled: bool) -> Value {
    let Some(runtime) = active_runtime() else {
        return json!({
            "ok": false,
            "error": not_running_error().message,
            "hint": not_running_error().hint,
        });
    };
    let (payload, active) = {
        let mut shared = lock(&runtime.shared);
        shared.autoscroll = enabled && !shared.limit_reached;
        (progress_payload(&shared), shared.autoscroll)
    };
    emit_progress(&app, payload);
    json!({ "ok": true, "autoscroll": active })
}

/// `longshot_preview {}` — PNG data URL of the current stitched image. The PNG is
/// built on a blocking worker and downscaled for the preview window; unchanged
/// revisions are served from a cache.
#[tauri::command]
pub async fn longshot_preview() -> Value {
    match tauri::async_runtime::spawn_blocking(preview_payload).await {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            json!({ "ok": false, "error": error.message, "hint": error.hint })
        }
        Err(error) => json!({
            "ok": false,
            "error": "读取长截图预览失败。",
            "hint": format!("请重试；若问题持续请重启程序（{error}）。"),
        }),
    }
}

fn preview_payload() -> Result<Value, EngineError> {
    let runtime = active_runtime().ok_or_else(not_running_error)?;
    {
        let shared = lock(&runtime.shared);
        let (width, height) = display_dimensions(&shared);
        if let Some(cache) = &shared.preview {
            if cache.revision == shared.revision && cache.width == width && cache.height == height {
                return Ok(json!({
                    "ok": true,
                    "dataUrl": cache.data_url,
                    "width": width,
                    "height": height,
                    "frames": shared.frames,
                    "direction": shared.direction.as_str(),
                    "revision": shared.revision,
                }));
            }
        }
    }
    let (revision, width, height, frames, direction, image) = {
        let shared = lock(&runtime.shared);
        let (width, height) = display_dimensions(&shared);
        let (target_width, target_height) = preview_target_size(&runtime, width, height);
        (
            shared.revision,
            width,
            height,
            shared.frames,
            shared.direction,
            display_preview_image(&shared, target_width, target_height),
        )
    };
    let data_url = preview_jpeg_data_url(&image, 78)?;
    {
        let mut shared = lock(&runtime.shared);
        if shared.revision == revision {
            shared.preview = Some(PreviewCache {
                revision,
                width,
                height,
                data_url: data_url.clone(),
            });
        }
    }
    Ok(json!({
        "ok": true,
        "dataUrl": data_url,
        "width": width,
        "height": height,
        "frames": frames,
        "direction": direction.as_str(),
        "revision": revision,
    }))
}

/// `longshot_direction {direction}` — switches the scroll direction and resets
/// the stitching from the current selection frame (contract §11.14).
#[tauri::command]
pub fn longshot_direction(app: AppHandle, direction: String) -> Value {
    let Some(parsed) = Direction::parse(&direction) else {
        return json!({
            "ok": false,
            "error": "不支持的长截图方向。",
            "hint": "请选择「竖向」或「横向」。",
        });
    };
    let Some(runtime) = active_runtime() else {
        return json!({
            "ok": false,
            "error": not_running_error().message,
            "hint": not_running_error().hint,
        });
    };
    let progress = {
        let mut shared = lock(&runtime.shared);
        reset_stitch(&mut shared, parsed);
        progress_payload(&shared)
    };
    // Notify the preview right away: a reset changes the stitched image even
    // though no new frame was merged (contract §11.14.1).
    let _ = emit_progress(&app, progress);
    json!({ "ok": true, "direction": parsed.as_str() })
}

/// `longshot_finish {}` — stops the loop, copies + pins the stitched image and
/// closes the preview (contract §11.14).
/// Async on purpose: it creates the pinned webview window from the event-loop
/// thread would deadlock (same reason as `capture_pin`).
#[tauri::command]
pub async fn longshot_finish(app: AppHandle) -> Result<Value, String> {
    Ok(match finish_impl(&app) {
        Ok(value) => value,
        Err(error) => {
            json!({ "ok": false, "error": error.message, "hint": error.hint })
        }
    })
}

fn finish_impl(app: &AppHandle) -> Result<Value, EngineError> {
    let Some(runtime) = active_runtime() else {
        return Err(not_running_error());
    };
    // Stop the grab thread and wait (bounded) until it has exited, so no late
    // frame can be appended between the snapshot and the export.
    runtime.stop.store(true, Ordering::SeqCst);
    for _ in 0..20 {
        if runtime.finished.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    let (image, width, height, frames, direction) = {
        let shared = lock(&runtime.shared);
        let (width, height) = display_dimensions(&shared);
        (
            display_image(&shared),
            width,
            height,
            shared.frames,
            shared.direction,
        )
    };

    let clipboard = write_clipboard_image(app, &image);
    // Keep the stitched pin where the selection was on screen.
    let (pin_x, pin_y, _, _) = runtime.geometry.screen_rect();
    match crate::pin::create_pin(app, image, Some((pin_x, pin_y))) {
        Ok((pin_id, _, _)) => {
            let _ = take_runtime();
            // The overlay is visible again from the cancel path; finish closes
            // the whole capture UI, so restore its normal mouse handling first.
            set_overlay_click_through(app, false);
            destroy_longshot_windows(app);
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                // The screenshot session is finished: hide the overlays and release
                // the capture input gate so the next screenshot can start.
                state.capture.close(app);
            }
            log_info(
                app,
                &format!(
                    "longshot: finished frames={frames} size={width}x{height} \
                     direction={} pin={pin_id} clipboard={clipboard}",
                    direction.as_str()
                ),
            );
            Ok(json!({
                "ok": true,
                "width": width,
                "height": height,
                "pinId": pin_id,
            }))
        }
        Err(error) => {
            // Keep the preview (and the session) so the renderer can show the
            // error and the user can retry or cancel.
            log_warn(
                app,
                &format!("longshot: finish failed while pinning: {}", error.message),
            );
            Err(error)
        }
    }
}

/// `longshot_cancel {}` — stops the loop, closes the preview, restores the
/// capture overlay and notifies it (contract §11.14). Idempotent.
#[tauri::command]
pub fn longshot_cancel(app: AppHandle) -> Value {
    cancel(&app);
    json!({ "ok": true })
}

/// Shared by `longshot_cancel` and the preview window's close event.
pub fn cancel(app: &AppHandle) {
    let runtime = take_runtime();
    if let Some(runtime) = &runtime {
        runtime.stop.store(true, Ordering::SeqCst);
    }
    // Restore normal mouse handling on the (still visible) capture overlays and
    // re-show them as a safety net; the page switches back from the live mode on
    // the `longshot-cancelled` event (contract §11.14.1).
    set_overlay_click_through(app, false);
    destroy_longshot_windows(app);
    crate::windows::show_all_capture_windows(app);
    let _ = app.emit(EVENT_CANCELLED, json!({}));
    if runtime.is_some() {
        log_info(app, "longshot: cancelled, capture overlay restored");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        choose_merge, control_bar_position, display_dimensions, exceeds_limits, inset_crop,
        orient_frame, preview_placement, progress_payload, reset_stitch, Direction, Geometry,
        MergeSide, Shared, BAR_LOGICAL_HEIGHT, BAR_LOGICAL_WIDTH, EVENT_CANCELLED, EVENT_STARTED,
        LONG_SHOT_BAR_LABEL, LONG_SHOT_LABEL, MAX_PIXELS, PREVIEW_MIN_LOGICAL_HEIGHT,
        PREVIEW_WIDTH_MAX, PREVIEW_WIDTH_MIN,
    };
    use crate::capture::{find_overlap, find_overlap_prepend, Stitched};
    use crate::win32::WorkArea;
    use image::{Rgba, RgbaImage};

    fn work() -> WorkArea {
        WorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        }
    }

    fn noise_image(width: u32, height: u32, seed: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            let mut value = seed
                .wrapping_mul(0x9E37_79B1)
                .wrapping_add((y * width + x).wrapping_mul(0x85EB_CA77));
            value ^= value >> 13;
            Rgba([
                (value & 0xFF) as u8,
                ((value >> 8) & 0xFF) as u8,
                ((value >> 16) & 0xFF) as u8,
                255,
            ])
        })
    }

    #[test]
    fn longshot_window_labels_are_fixed() {
        assert_eq!(LONG_SHOT_LABEL, "longshot");
        assert_eq!(LONG_SHOT_BAR_LABEL, "longshot-bar");
        assert_eq!(EVENT_STARTED, "longshot-started");
        assert_eq!(EVENT_CANCELLED, "longshot-cancelled");
    }

    #[test]
    fn direction_parsing_accepts_the_contract_values() {
        assert_eq!(Direction::parse("vertical"), Some(Direction::Vertical));
        assert_eq!(
            Direction::parse("  HORIZONTAL "),
            Some(Direction::Horizontal)
        );
        assert_eq!(Direction::parse(""), None);
        assert_eq!(Direction::parse("diagonal"), None);
        assert_eq!(Direction::Vertical.as_str(), "vertical");
        assert_eq!(Direction::Horizontal.as_str(), "horizontal");
    }

    #[test]
    fn size_limits_follow_the_contract() {
        // Vertical: height cap.
        assert!(!exceeds_limits(Direction::Vertical, 1000, 30_000));
        assert!(exceeds_limits(Direction::Vertical, 1000, 30_001));
        // Horizontal: stitch-space height is the final width cap.
        assert!(!exceeds_limits(Direction::Horizontal, 1000, 40_000));
        assert!(exceeds_limits(Direction::Horizontal, 1000, 40_001));
        // Global pixel budget wins for very wide images.
        assert!(exceeds_limits(Direction::Vertical, 4000, 20_000));
        assert!((4000u64 * 20_000) > MAX_PIXELS);
    }

    #[test]
    fn preview_sits_beside_the_selection_bottom_aligned() {
        // Selection 600×300 at (100,100): preview to its right (700+8), bottom
        // aligned with the selection bottom (400), height = selection height,
        // width = height × aspect (2:1, capped at 560).
        let selection = (100, 100, 600, 300);
        let bar = (BAR_LOGICAL_WIDTH as i32, BAR_LOGICAL_HEIGHT as i32);
        let ((width, height), position) = preview_placement(600, 300, 1.0, &work(), selection, bar);
        assert!((height - 300.0).abs() < 0.01, "height={height}");
        assert!(
            (width - PREVIEW_WIDTH_MAX as f64).abs() < 0.01,
            "width={width}"
        );
        assert_eq!(position, (708, 100));

        // A very long image keeps height/bottom alignment and narrows.
        let ((tall_width, tall_height), tall_position) =
            preview_placement(600, 6_000, 1.0, &work(), selection, bar);
        assert!(
            (tall_height - 300.0).abs() < 0.01,
            "tall_height={tall_height}"
        );
        assert!(
            (tall_width - PREVIEW_WIDTH_MIN as f64).abs() < 0.01,
            "width={tall_width}"
        );
        assert_eq!(tall_position, (708, 100));

        // No room on the right: the preview moves to the left side.
        let right_edge = (1700, 100, 200, 300);
        let (_, placed) = preview_placement(600, 300, 1.0, &work(), right_edge, bar);
        assert!(
            placed.0 < 1700,
            "x={} should be left of the selection",
            placed.0
        );
        assert!(placed.0 >= 0);
    }

    #[test]
    fn preview_stays_inside_the_work_area_when_both_sides_are_tight() {
        let small = WorkArea {
            left: 0,
            top: 0,
            right: 800,
            bottom: 300,
        };
        let selection = (300, 100, 150, 100);
        let bar = (BAR_LOGICAL_WIDTH as i32, BAR_LOGICAL_HEIGHT as i32);
        let ((preview_width, height), position) =
            preview_placement(400, 300, 1.0, &small, selection, bar);
        assert!(height >= PREVIEW_MIN_LOGICAL_HEIGHT - 0.01);
        assert!(position.0 >= 0 && position.1 >= 0);
        assert!(
            position.0 + (preview_width as i32) <= small.width() + 1,
            "x={} width={preview_width} should stay inside the work area",
            position.0
        );
        assert!(
            position.1 + (height as i32) <= small.height() + 1,
            "y={} height={height} should stay inside the work area",
            position.1
        );
    }

    #[test]
    fn control_bar_sits_below_the_selection_when_there_is_room() {
        let bar = (BAR_LOGICAL_WIDTH as i32, BAR_LOGICAL_HEIGHT as i32);
        // 300 + 300 + 8 = 608; 608 + 56 fits above the work-area bottom.
        assert_eq!(
            control_bar_position((500, 300, 400, 300), bar, &work()),
            (500, 608)
        );
        // No room below: place it above the selection.
        let placed = control_bar_position((500, 900, 400, 150), bar, &work());
        assert_eq!(placed.1, 900 - 8 - BAR_LOGICAL_HEIGHT as i32);
        // Horizontal clamp keeps it on screen.
        let placed = control_bar_position((1700, 200, 300, 200), bar, &work());
        assert_eq!(placed.0, 1920 - BAR_LOGICAL_WIDTH as i32);
    }

    #[test]
    fn horizontal_stitching_matches_a_rotated_row_overlap() {
        // A wide page: frames are column slices of the same canvas. Rotating each
        // frame 90° turns the horizontal overlap into a row overlap, so the
        // shared vertical stitcher can append the new columns.
        let canvas = noise_image(600, 200, 11);
        let frame = |x: u32| image::imageops::crop_imm(&canvas, x, 0, 200, 200).to_image();
        let first = orient_frame(frame(0), Direction::Horizontal);
        let second = orient_frame(frame(100), Direction::Horizontal);
        let third = orient_frame(frame(200), Direction::Horizontal);
        let mut stitched = Stitched::from_image(&first);
        let overlap = find_overlap(&stitched, &second, None).expect("column overlap");
        assert_eq!(overlap, 100);
        stitched.push_rows(&second, overlap);
        let overlap = find_overlap(&stitched, &third, None).expect("column overlap");
        assert_eq!(overlap, 100);
        stitched.push_rows(&third, overlap);
        // Unrotate: the result is the original page columns 0..400.
        let restored = image::imageops::rotate270(&stitched.to_image());
        assert_eq!(restored.dimensions(), (400, 200));
        let expected = image::imageops::crop_imm(&canvas, 0, 0, 400, 200).to_image();
        assert_eq!(restored.as_raw(), expected.as_raw());
    }

    #[test]
    fn direction_switch_resets_the_stitch_from_the_first_frame() {
        let first = noise_image(80, 60, 5);
        let mut shared = Shared {
            direction: Direction::Vertical,
            first_frame: first.clone(),
            stitched: Stitched::from_image(&first),
            last_frame: first.clone(),
            last_append_overlap: Some(12),
            last_prepend_overlap: Some(8),
            frames: 4,
            misses: 0,
            resync: false,
            autoscroll: false,
            stalled: true,
            limit_reached: true,
            revision: 9,
            preview: None,
        };
        // Append some fabricated rows so the reset is observable.
        let extra = noise_image(80, 20, 7);
        shared.stitched.push_rows(&extra, 0);
        assert_eq!(shared.stitched.height(), 80);

        reset_stitch(&mut shared, Direction::Horizontal);
        assert_eq!(shared.direction, Direction::Horizontal);
        // Horizontal stitch space is the rotated first frame.
        assert_eq!(
            (shared.stitched.width(), shared.stitched.height()),
            (60, 80)
        );
        assert_eq!(shared.frames, 1);
        assert!(!shared.stalled);
        assert!(!shared.limit_reached);
        assert_eq!(shared.last_append_overlap, None);
        assert_eq!(shared.last_prepend_overlap, None);
        assert_eq!(shared.revision, 10);
        let (width, height) = display_dimensions(&shared);
        assert_eq!((width, height), (80, 60));
    }

    #[test]
    fn geometry_maps_crop_to_screen_coordinates() {
        let geometry = Geometry {
            origin_x: -1920,
            origin_y: 0,
            monitor_width: 1920,
            monitor_height: 1080,
            crop: (100, 200, 400, 300),
            selection_screen: (-1820, 200, 400, 300),
        };
        assert_eq!(geometry.screen_rect(), (-1820, 200, 400, 300));
        assert_eq!(geometry.center(), (-1620, 350));
        let rect = geometry.capture_rect();
        assert_eq!(
            (rect.x, rect.y, rect.width, rect.height),
            (100.0, 200.0, 400.0, 300.0)
        );
    }

    #[test]
    fn crop_inset_follows_the_dpi_scale() {
        // 2 CSS px per side at 100% and 150%.
        assert_eq!(inset_crop((100, 200, 400, 300), 1.0), (102, 202, 396, 296));
        assert_eq!(inset_crop((100, 200, 400, 300), 1.5), (103, 203, 394, 294));
        // Tiny selections never become empty.
        assert_eq!(inset_crop((10, 20, 3, 4), 1.0), (11, 21, 1, 2));
        assert_eq!(inset_crop((10, 20, 1, 1), 1.0), (10, 20, 1, 1));
    }

    #[test]
    fn preview_resize_matches_the_content_box() {
        // The preview PNG is resized to the window's content box, so its size is
        // constant no matter how long the stitched image grows.
        let stitched = Stitched::from_image(&noise_image(960, 1600, 3));
        let resized = stitched.resized_to(690, 1300);
        assert_eq!(resized.dimensions(), (690, 1300));
    }

    #[test]
    fn merge_choice_prefers_the_larger_overlap_and_appends_on_ties() {
        assert_eq!(choose_merge(None, None), None);
        assert_eq!(choose_merge(Some(10), None), Some((MergeSide::Append, 10)));
        assert_eq!(choose_merge(None, Some(20)), Some((MergeSide::Prepend, 20)));
        // Forward scrolling is preferred when both overlaps are equally good.
        assert_eq!(
            choose_merge(Some(25), Some(25)),
            Some((MergeSide::Append, 25))
        );
        assert_eq!(
            choose_merge(Some(20), Some(30)),
            Some((MergeSide::Prepend, 30))
        );
        assert_eq!(
            choose_merge(Some(30), Some(20)),
            Some((MergeSide::Append, 30))
        );
    }

    #[test]
    fn vertical_prepend_stitches_rows_scrolled_back_up() {
        // The user scrolled up: the new frame sits above the current image. Its
        // bottom rows overlap the stitched top rows.
        let canvas = noise_image(40, 200, 21);
        let stitched_image = image::imageops::crop_imm(&canvas, 0, 60, 40, 80).to_image();
        let frame = image::imageops::crop_imm(&canvas, 0, 20, 40, 80).to_image();
        let mut stitched = Stitched::from_image(&stitched_image);
        let overlap = find_overlap_prepend(&stitched, &frame, None).expect("prepend overlap");
        assert_eq!(overlap, 40);
        assert_eq!(
            choose_merge(None, Some(overlap)),
            Some((MergeSide::Prepend, overlap))
        );
        stitched.prepend_rows(&frame, overlap);
        assert_eq!(stitched.height(), 120);
        let restored = stitched.to_image();
        assert_eq!(restored.dimensions(), (40, 120));
        for y in 0..120 {
            assert_eq!(
                *restored.get_pixel(0, y),
                *canvas.get_pixel(0, 20 + y),
                "row {y} mismatched"
            );
        }
    }

    #[test]
    fn horizontal_prepend_uses_the_rotated_column_overlap() {
        // Same trick as horizontal appending: rotate 90°, prepend rows, rotate
        // the result back.
        let canvas = noise_image(600, 120, 31);
        let frame = |x: u32| image::imageops::crop_imm(&canvas, x, 0, 200, 120).to_image();
        let current = orient_frame(frame(200), Direction::Horizontal);
        let previous = orient_frame(frame(100), Direction::Horizontal);
        let mut stitched = Stitched::from_image(&current);
        let overlap =
            find_overlap_prepend(&stitched, &previous, None).expect("column prepend overlap");
        assert_eq!(overlap, 100);
        stitched.prepend_rows(&previous, overlap);
        let restored = image::imageops::rotate270(&stitched.to_image());
        // Covered columns: 100..399 (the current frame already held 200..399).
        assert_eq!(restored.dimensions(), (300, 120));
        let expected = image::imageops::crop_imm(&canvas, 100, 0, 300, 120).to_image();
        assert_eq!(restored.as_raw(), expected.as_raw());
    }

    #[test]
    fn progress_payload_carries_the_revision() {
        let first = noise_image(10, 10, 1);
        let shared = Shared {
            direction: Direction::Vertical,
            first_frame: first.clone(),
            stitched: Stitched::from_image(&first),
            last_frame: first,
            last_append_overlap: None,
            last_prepend_overlap: None,
            frames: 2,
            misses: 0,
            resync: false,
            autoscroll: false,
            stalled: true,
            limit_reached: false,
            revision: 7,
            preview: None,
        };
        let payload = progress_payload(&shared);
        assert_eq!(payload["revision"], 7);
        assert_eq!(payload["stalled"], true);
        assert_eq!(payload["frames"], 2);
        assert_eq!(payload["width"], 10);
        assert_eq!(payload["height"], 10);
    }
}
