//! Manual-scroll long screenshot (contract §11.14).
//!
//! `longshot_start` hides the capture overlay, seeds the stitcher with the
//! selected region and shows a small preview window **beside** the selection.
//! The user scrolls the target application manually; a background thread grabs
//! the same screen region ~8 times per second and stitches the new content:
//!
//! * vertical scrolling uses the row-overlap stitcher from [`crate::capture`];
//! * horizontal scrolling rotates each frame by 90° and reuses the same row
//!   stitcher (columns become rows), rotating the result back for preview/export.
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
    clamp_rect, find_overlap, frames_identical, png_data_url, write_clipboard_image, HitRect,
    LongshotSeed, Stitched,
};
use crate::engine::EngineError;
use crate::state::AppState;
use crate::win32;

/// Window label of the long-screenshot preview (fixed: one session at a time).
pub const LONG_SHOT_LABEL: &str = "longshot";
/// Rust → `longshot` window: stitched size/frame counter changed.
const EVENT_PROGRESS: &str = "longshot-progress";
/// Rust → capture overlay windows: the manual session was cancelled.
pub const EVENT_CANCELLED: &str = "longshot-cancelled";

/// Preview window logical width (contract §11.14: 340–420 logical px).
const PREVIEW_LOGICAL_WIDTH: f64 = 360.0;
/// Preview window may cover at most this share of the work area.
const PREVIEW_MAX_WORK_RATIO: f64 = 0.70;
/// Upper/lower bounds for the preview window height in logical pixels.
const PREVIEW_MAX_LOGICAL_HEIGHT: f64 = 640.0;
const PREVIEW_MIN_LOGICAL_HEIGHT: f64 = 260.0;
/// Gap between the selection and the preview window (physical pixels).
const PREVIEW_GAP: i32 = 8;
/// Screen grabbing cadence of the background stitcher (~8 fps).
const FRAME_INTERVAL: Duration = Duration::from_millis(120);
/// Size limits (contract §11.14).
const MAX_VERTICAL_HEIGHT: u32 = 30_000;
const MAX_HORIZONTAL_WIDTH: u32 = 40_000;
const MAX_PIXELS: u64 = 64_000_000;
/// The preview image is downscaled to this longest side before PNG encoding so
/// `longshot_preview` stays cheap even for very long pages (the full-resolution
/// image is used for the clipboard/pin on finish).
const PREVIEW_MAX_SIDE: u32 = 1400;

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
    crop: (u32, u32, u32, u32),
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
        let (left, top, width, height) = self.crop;
        (
            self.origin_x + left as i32,
            self.origin_y + top as i32,
            width as i32,
            height as i32,
        )
    }

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
    last_overlap: Option<u32>,
    frames: u32,
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

/// Stops and forgets the current session without touching any window (used when
/// the preview window is destroyed by the shell or during shutdown).
pub fn forget_session() {
    if let Some(runtime) = take_runtime() {
        runtime.stop.store(true, Ordering::SeqCst);
    }
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

// ---------------------------------------------------------------------------
// Pure layout / direction helpers (unit-tested below)
// ---------------------------------------------------------------------------

/// Logical preview window size: fixed width, height capped by the work area and
/// a comfortable maximum (contract §11.14).
fn preview_window_size(scale: f64, work: &win32::WorkArea) -> (f64, f64) {
    let scale = if scale.is_finite() && scale > 0.1 {
        scale
    } else {
        1.0
    };
    let available = (work.height().max(1) as f64 * PREVIEW_MAX_WORK_RATIO / scale).max(1.0);
    let height = available
        .min(PREVIEW_MAX_LOGICAL_HEIGHT)
        .max(PREVIEW_MIN_LOGICAL_HEIGHT.min(available));
    (PREVIEW_LOGICAL_WIDTH, height)
}

/// Physical top-left position of the preview window: left of the selection when
/// there is room, otherwise right of it; vertically aligned with the selection
/// top and clamped into the work area (contract §11.14).
fn preview_window_position(
    selection: (i32, i32, i32, i32),
    window: (i32, i32),
    work: &win32::WorkArea,
) -> (i32, i32) {
    let (left, top, width, _height) = selection;
    let (window_width, window_height) = (window.0.max(1), window.1.max(1));
    let right = left.saturating_add(width);
    let left_space = left - work.left;
    let x = if left_space >= window_width + PREVIEW_GAP {
        left - PREVIEW_GAP - window_width
    } else {
        right + PREVIEW_GAP
    };
    win32::clamp_to_work_area(x, top, window_width, window_height, work)
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

/// Downscaled stitched image in the original orientation, used only for the
/// preview IPC. The finish path uses the full-resolution [`display_image`].
fn display_preview_image(shared: &Shared) -> RgbaImage {
    let scaled = shared.stitched.scaled_to_image(PREVIEW_MAX_SIDE);
    match shared.direction {
        Direction::Vertical => scaled,
        Direction::Horizontal => image::imageops::rotate270(&scaled),
    }
}

/// Resets the stitcher to the first frame in `direction` (direction switch).
fn reset_stitch(shared: &mut Shared, direction: Direction) {
    let first = orient_frame(shared.first_frame.clone(), direction);
    *shared = Shared {
        direction,
        first_frame: shared.first_frame.clone(),
        stitched: Stitched::from_image(&first),
        last_frame: first,
        last_overlap: None,
        frames: 1,
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
        "stalled": shared.stalled,
    })
}

// ---------------------------------------------------------------------------
// Background stitcher
// ---------------------------------------------------------------------------

/// Merges one grabbed frame into the session. Returns the progress payload when
/// the frame was processed (also when it was skipped/stalled), `None` when the
/// session is already done.
fn stitch_frame(runtime: &Runtime, frame: RgbaImage) -> Option<Value> {
    let mut shared = lock(&runtime.shared);
    if shared.limit_reached {
        return None;
    }
    let direction = shared.direction;
    let oriented = orient_frame(frame, direction);
    if frames_identical(&shared.last_frame, &oriented) {
        return None;
    }
    let overlap = find_overlap(&shared.stitched, &oriented, shared.last_overlap);
    let Some(overlap) = overlap else {
        shared.last_frame = oriented;
        shared.stalled = true;
        return Some(progress_payload(&shared));
    };
    let added_rows = oriented.height().saturating_sub(overlap);
    let projected = shared.stitched.height().saturating_add(added_rows);
    if added_rows == 0 {
        shared.last_frame = oriented;
        shared.stalled = true;
        return Some(progress_payload(&shared));
    }
    if exceeds_limits(direction, shared.stitched.width(), projected) {
        shared.last_frame = oriented;
        shared.limit_reached = true;
        shared.stalled = true;
        return Some(progress_payload(&shared));
    }
    shared.stitched.push_rows(&oriented, overlap);
    shared.last_overlap = Some(overlap);
    shared.last_frame = oriented;
    shared.frames = shared.frames.saturating_add(1);
    shared.stalled = false;
    shared.revision = shared.revision.wrapping_add(1);
    Some(progress_payload(&shared))
}

/// Background grab loop: `xcap::Monitor` is not `Send`, which is why it lives
/// entirely inside one dedicated thread.
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
    let monitors = match xcap::Monitor::all() {
        Ok(monitors) => monitors,
        Err(error) => {
            log_warn(
                &app,
                &format!("longshot: cannot enumerate monitors: {error}"),
            );
            runtime.stop.store(true, Ordering::SeqCst);
            return;
        }
    };
    let monitor = monitors
        .iter()
        .find(|monitor| {
            monitor.x().unwrap_or(i32::MIN) == geometry.origin_x
                && monitor.y().unwrap_or(i32::MIN) == geometry.origin_y
                && monitor.width().unwrap_or(0) == geometry.monitor_width
                && monitor.height().unwrap_or(0) == geometry.monitor_height
        })
        .or_else(|| monitors.first());
    let Some(monitor) = monitor else {
        log_warn(&app, "longshot: no monitor available for grabbing");
        runtime.stop.store(true, Ordering::SeqCst);
        return;
    };
    let capture_rect = geometry.capture_rect();
    let mut failures = 0u32;
    let mut logged_stalled = false;
    let mut logged_limit = false;
    while !runtime.stop.load(Ordering::SeqCst) {
        std::thread::sleep(FRAME_INTERVAL);
        if runtime.stop.load(Ordering::SeqCst) {
            break;
        }
        let captured = match monitor.capture_image() {
            Ok(captured) => {
                failures = 0;
                captured
            }
            Err(error) => {
                failures = failures.saturating_add(1);
                if failures == 3 {
                    log_warn(&app, &format!("longshot: frame grab failed: {error}"));
                }
                if failures >= 12 {
                    log_warn(&app, "longshot: too many failed grabs, stopping");
                    runtime.stop.store(true, Ordering::SeqCst);
                }
                continue;
            }
        };
        let Some((left, top, width, height)) = clamp_rect(&captured, &capture_rect) else {
            continue;
        };
        let frame = image::imageops::crop_imm(&captured, left, top, width, height).to_image();
        let Some(progress) = stitch_frame(&runtime, frame) else {
            continue;
        };
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
        let _ = app.emit_to(LONG_SHOT_LABEL, EVENT_PROGRESS, progress);
    }
}

// ---------------------------------------------------------------------------
// Window + session commands
// ---------------------------------------------------------------------------

fn destroy_preview_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LONG_SHOT_LABEL) {
        let _ = window.destroy();
    }
}

/// Creates the non-activating preview window beside the selection. The window
/// stays hidden until the session state exists, so `longshot.html` can already
/// call `longshot_state`/`longshot_preview` while it loads.
fn create_preview_window(
    app: &AppHandle,
    logical_size: (f64, f64),
    physical_size: (u32, u32),
    position: (i32, i32),
) -> Result<tauri::WebviewWindow, EngineError> {
    let window = WebviewWindowBuilder::new(
        app,
        LONG_SHOT_LABEL,
        WebviewUrl::App("longshot.html".into()),
    )
    .title("Lexora 长截图")
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .visible(false)
    .focused(false)
    .inner_size(logical_size.0, logical_size.1)
    .build()
    .map_err(|error| {
        EngineError::new(
            "无法创建长截图预览窗口。",
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
            "无法定位长截图预览窗口。",
            format!("请重试或重启程序（{error}）。"),
        ));
    }
    // Never steal focus from the application the user scrolls; the buttons still
    // receive mouse clicks (contract §11.14).
    if !win32::set_no_activate(&window) {
        log_warn(
            app,
            "longshot: could not set WS_EX_NOACTIVATE on the preview",
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
    let geometry = Geometry {
        origin_x: seed.origin_x,
        origin_y: seed.origin_y,
        monitor_width: seed.monitor_width,
        monitor_height: seed.monitor_height,
        crop: seed.crop,
    };
    let center = geometry.center();
    let scale = win32::monitor_scale_factor(center.0, center.1);
    let scale = if scale.is_finite() && scale > 0.1 {
        scale
    } else {
        1.0
    };
    let work = win32::work_area_physical(center.0, center.1);
    let logical_size = preview_window_size(scale, &work);
    let physical_size = (
        ((logical_size.0 * scale).round() as u32).max(1),
        ((logical_size.1 * scale).round() as u32).max(1),
    );
    let position = preview_window_position(
        geometry.screen_rect(),
        (physical_size.0 as i32, physical_size.1 as i32),
        &work,
    );

    // The overlay would cover the application being scrolled and would appear in
    // every grabbed frame: hide it (not destroy) for the whole session.
    crate::windows::hide_capture_windows(app);
    let window = match create_preview_window(app, logical_size, physical_size, position) {
        Ok(window) => window,
        Err(error) => {
            crate::windows::show_all_capture_windows(app);
            return Err(error);
        }
    };
    // Hiding the overlay leaves keyboard focus on the (now hidden) overlay, which
    // would swallow the wheel input the user needs to scroll. Hand the focus to
    // the application under the selection (the preview window is NOACTIVATE, so
    // it will not take it back).
    if !win32::focus_window_at(center.0, center.1) {
        log_warn(
            app,
            "longshot: could not focus the application under the selection",
        );
    }

    let LongshotSeed { first_frame, .. } = seed;
    let (initial_width, initial_height) = first_frame.dimensions();
    let shared = Shared {
        direction: Direction::Vertical,
        stitched: Stitched::from_image(&first_frame),
        last_frame: first_frame.clone(),
        first_frame,
        last_overlap: None,
        frames: 1,
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
    });
    *lock(session_cell()) = Some(runtime.clone());

    let thread_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("lexora-longshot".to_string())
        .spawn(move || capture_loop(thread_app, runtime));
    if let Err(error) = spawned {
        forget_session();
        let _ = window.destroy();
        crate::windows::show_all_capture_windows(app);
        return Err(EngineError::new(
            "无法启动长截图线程。",
            format!("请重试或重启程序（{error}）。"),
        ));
    }

    // Session state is ready before the page becomes visible, so its first
    // `longshot_state`/`longshot_preview` calls already succeed.
    if let Err(error) = window.show() {
        forget_session();
        let _ = window.destroy();
        crate::windows::show_all_capture_windows(app);
        return Err(EngineError::new(
            "无法显示长截图预览窗口。",
            format!("请重试或重启程序（{error}）。"),
        ));
    }
    // Showing the preview can still activate it on some systems (Tauri calls
    // SetForegroundWindow), which would swallow the user's wheel input. Hand the
    // focus back to the application under the selection.
    let _ = win32::focus_window_at(center.0, center.1);

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
    })
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
                }));
            }
        }
    }
    let (revision, width, height, frames, direction, image) = {
        let shared = lock(&runtime.shared);
        let (width, height) = display_dimensions(&shared);
        (
            shared.revision,
            width,
            height,
            shared.frames,
            shared.direction,
            display_preview_image(&shared),
        )
    };
    let data_url = png_data_url(&image)?;
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
    }))
}

/// `longshot_direction {direction}` — switches the scroll direction and resets
/// the stitching from the current selection frame (contract §11.14).
#[tauri::command]
pub fn longshot_direction(direction: String) -> Value {
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
    {
        let mut shared = lock(&runtime.shared);
        reset_stitch(&mut shared, parsed);
    }
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
    match crate::pin::create_pin(app, image) {
        Ok((pin_id, _, _)) => {
            let _ = take_runtime();
            destroy_preview_window(app);
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
            // error and the user can retry or cancel; the overlay stays hidden.
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
    destroy_preview_window(app);
    crate::windows::show_all_capture_windows(app);
    let _ = app.emit(EVENT_CANCELLED, json!({}));
    if runtime.is_some() {
        log_info(app, "longshot: cancelled, capture overlay restored");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        display_dimensions, exceeds_limits, orient_frame, preview_window_position,
        preview_window_size, reset_stitch, Direction, Geometry, Shared, LONG_SHOT_LABEL,
        MAX_PIXELS, PREVIEW_LOGICAL_WIDTH, PREVIEW_MAX_LOGICAL_HEIGHT,
    };
    use crate::capture::{find_overlap, Stitched};
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
    fn longshot_window_label_is_fixed() {
        assert_eq!(LONG_SHOT_LABEL, "longshot");
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
    fn preview_window_fits_the_work_area() {
        let (width, height) = preview_window_size(1.0, &work());
        assert_eq!(width, PREVIEW_LOGICAL_WIDTH);
        assert!((height - PREVIEW_MAX_LOGICAL_HEIGHT).abs() < 0.01);
        // 150% display: the same 70% cap in logical pixels.
        let hidpi_work = WorkArea {
            left: 0,
            top: 0,
            right: 3840,
            bottom: 2160,
        };
        let (_, height) = preview_window_size(1.5, &hidpi_work);
        assert!((height - PREVIEW_MAX_LOGICAL_HEIGHT).abs() < 0.01);
        // Small work area: never exceed its 70%.
        let small = WorkArea {
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
        };
        let (_, height) = preview_window_size(1.0, &small);
        assert!((height - 420.0).abs() < 0.01, "height={height}");
        // Even smaller: clamp to the available space, never negative.
        let tiny = WorkArea {
            left: 0,
            top: 0,
            right: 300,
            bottom: 200,
        };
        let (_, height) = preview_window_size(1.0, &tiny);
        assert!((height - 140.0).abs() < 0.01, "height={height}");
    }

    #[test]
    fn preview_window_prefers_the_left_side_then_the_right() {
        // Enough room on the left: 900 - 8 - 360 = 532.
        assert_eq!(
            preview_window_position((900, 300, 400, 300), (360, 500), &work()),
            (532, 300)
        );
        // Not enough room: place it right of the selection: 500 + 8 = 508.
        assert_eq!(
            preview_window_position((100, 300, 400, 300), (360, 500), &work()),
            (508, 300)
        );
        // Right side would overflow: clamped into the work area.
        let placed = preview_window_position((100, 300, 1700, 300), (360, 500), &work());
        assert_eq!(placed.0, 1920 - 360);
        // Vertical clamp keeps the whole window visible.
        let placed = preview_window_position((900, 1000, 400, 300), (360, 500), &work());
        assert_eq!(placed.1, 1080 - 500);
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
            last_overlap: Some(12),
            frames: 4,
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
        assert_eq!(shared.last_overlap, None);
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
        };
        assert_eq!(geometry.screen_rect(), (-1820, 200, 400, 300));
        assert_eq!(geometry.center(), (-1620, 350));
        let rect = geometry.capture_rect();
        assert_eq!(
            (rect.x, rect.y, rect.width, rect.height),
            (100.0, 200.0, 400.0, 300.0)
        );
    }
}
