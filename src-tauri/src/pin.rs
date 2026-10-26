//! Pinned-to-desktop screenshot windows (contract §11.5).
//!
//! Every pin lives in an in-memory registry (the image is kept so `pin_ready`
//! can hand it to the renderer and `pin_copy` can write it to the clipboard)
//! plus one transparent, borderless, always-on-top `pin-<id>` window hosting
//! `pin.html?id=<id>`. Closing a pin destroys its window and forgets the image;
//! the id counter only moves forward, so ids are never reused while running.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use image::RgbaImage;
use serde_json::{json, Value};
use tauri::window::Color;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::capture::CaptureJob;
use crate::engine::EngineError;
use crate::state::AppState;
use crate::win32;

/// Window label prefix of pinned images (`pin-<id>`).
pub const PIN_PREFIX: &str = "pin-";
/// Event emitted when a pin is closed (contract §11.4).
pub const EVENT_PIN_CLOSE: &str = "pin-close";
/// A pin may cover at most this share of the work area; larger images scale down.
const MAX_WORK_AREA_RATIO: f64 = 0.70;
/// Lowest zoom a pinned image can be scaled to with the mouse wheel (15%, user
/// requirement). 100% means one image pixel per physical pixel.
const PIN_ZOOM_MIN: f64 = 0.15;
/// There is no product limit on zooming a pin in (user requirement); this is
/// only the Windows/toolkit window-size ceiling so the window stays valid.
const PIN_MAX_WINDOW_PX: f64 = 30_000.0;
/// Very small snippets are enlarged for readability, but never more than this.
const MAX_READABLE_UPSCALE: f64 = 4.0;
/// A pinned window is never displayed smaller than this (logical pixels).
const MIN_READABLE_LOGICAL: f64 = 48.0;

/// Window geometry saved while the pin is in edit mode. The window is enlarged
/// so the annotation toolbar can float **outside** the image, exactly like the
/// screenshot toolbar floats outside the selection (contract §11.5).
#[derive(Debug, Clone, Copy)]
struct EditRestore {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

struct PinEntry {
    image: RgbaImage,
    /// Lazily encoded `data:image/png;base64,...` handed to `pin.html`.
    data_url: Option<String>,
    /// `true` when the image is taller than its window (long screenshot): the
    /// pin scrolls inside the window, and only then a scrollbar may appear.
    scrollable: bool,
    /// Mouse-wheel zoom of the window relative to the image's 1:1 physical size.
    zoom: f64,
    /// Original window geometry while the edit-mode toolbar is expanded.
    edit_restore: Option<EditRestore>,
}

/// In-memory pin images plus the forward-only id counter.
#[derive(Default)]
struct PinRegistry {
    next_id: u64,
    entries: HashMap<u64, PinEntry>,
}

impl PinRegistry {
    fn insert(&mut self, image: RgbaImage, scrollable: bool, initial_zoom: f64) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.entries.insert(
            id,
            PinEntry {
                image,
                data_url: None,
                scrollable,
                zoom: initial_zoom,
                edit_restore: None,
            },
        );
        id
    }

    fn get_mut(&mut self, id: u64) -> Option<&mut PinEntry> {
        self.entries.get_mut(&id)
    }

    fn remove(&mut self, id: u64) -> Option<PinEntry> {
        self.entries.remove(&id)
    }

    fn len(&self) -> usize {
        self.entries.len()
    }
}

fn registry() -> &'static Mutex<PinRegistry> {
    static REGISTRY: OnceLock<Mutex<PinRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(PinRegistry::default()))
}

fn lock_registry() -> std::sync::MutexGuard<'static, PinRegistry> {
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Parses the numeric id of a `pin-<id>` window label.
pub fn pin_id_from_label(label: &str) -> Option<u64> {
    label.strip_prefix(PIN_PREFIX)?.parse::<u64>().ok()
}

fn label_for(id: u64) -> String {
    format!("{PIN_PREFIX}{id}")
}

/// Height/width ratio above which an image counts as a "long screenshot": it
/// keeps a readable width and scrolls inside the pin window. Anything less
/// extreme is scaled uniformly to fit the work area (no scrollbar).
const TALL_IMAGE_ASPECT: f64 = 3.0;

/// Logical display size of a pinned image: physical pixels divided by the DPI
/// scale, scaled down to at most 70% of the work area, tiny snippets enlarged
/// so they stay readable (capped, and never above the work-area cap).
fn pin_display_size(
    width: u32,
    height: u32,
    scale: f64,
    work_width: i32,
    work_height: i32,
) -> (f64, f64) {
    let scale = if scale.is_finite() && scale > 0.1 {
        scale
    } else {
        1.0
    };
    let logical_w = (width.max(1) as f64 / scale).max(1.0);
    let logical_h = (height.max(1) as f64 / scale).max(1.0);
    let max_w = ((work_width.max(1) as f64) * MAX_WORK_AREA_RATIO / scale).max(1.0);
    let max_h = ((work_height.max(1) as f64) * MAX_WORK_AREA_RATIO / scale).max(1.0);
    let fit_w = (max_w / logical_w).min(1.0);
    let fit_h = (max_h / logical_h).min(1.0);
    let uniform = fit_w.min(fit_h);
    let tall = logical_h / logical_w >= TALL_IMAGE_ASPECT;
    // Ordinary images (including big screenshots) scale uniformly so the whole
    // image is visible without a scrollbar. Long screenshots keep the readable
    // width and are windowed to the work-area height (pin.js enables scrolling).
    let mut factor = if tall { fit_w } else { uniform };
    let smallest = logical_w.min(logical_h);
    if !tall && uniform >= 1.0 && smallest < MIN_READABLE_LOGICAL {
        factor = (MIN_READABLE_LOGICAL / smallest).min(MAX_READABLE_UPSCALE);
    }
    let display_h = (logical_h * factor).round();
    let display_h = if tall {
        display_h.min(max_h)
    } else {
        display_h
    };
    ((logical_w * factor).round().max(1.0), display_h.max(1.0))
}

/// Physical top-left position of a pin: centred on the cursor, then clamped into
/// the work area so the whole window stays visible (contract §11.5).
fn pin_window_position(
    cursor_x: i32,
    cursor_y: i32,
    width: i32,
    height: i32,
    work: &win32::WorkArea,
) -> (i32, i32) {
    win32::clamp_to_work_area(
        cursor_x - width.max(1) / 2,
        cursor_y - height.max(1) / 2,
        width,
        height,
        work,
    )
}

fn pin_missing_error() -> EngineError {
    EngineError::new("钉图不存在或已关闭。", "请重新截图后再点击「钉在桌面」。")
}

/// Whether the pinned image is taller than its window (the window keeps the
/// width, so the image is rendered at `display_w`; a long screenshot overflows
/// and scrolls). Ordinary images are scaled to fit and never scroll.
fn pin_is_scrollable(display_w: f64, display_h: f64, width: u32, height: u32) -> bool {
    if width == 0 || height == 0 {
        return false;
    }
    let rendered = display_w * (height as f64 / width as f64);
    rendered > display_h + 1.0
}

/// Logical window size of a pin at `zoom` (1.0 = image pixel per physical
/// pixel). Tall screenshots keep the work-area height cap and scroll inside the
/// window instead of growing beyond the screen (contract §11.5).
fn pin_zoom_size(
    width: u32,
    height: u32,
    scale: f64,
    zoom: f64,
    work_height: i32,
) -> (f64, f64) {
    let scale = if scale.is_finite() && scale > 0.1 {
        scale
    } else {
        1.0
    };
    let base_w = (width.max(1) as f64 / scale).max(1.0);
    let base_h = (height.max(1) as f64 / scale).max(1.0);
    let logical_w = (base_w * zoom).max(1.0);
    let logical_h = (base_h * zoom).max(1.0);
    let max_h = ((work_height.max(1) as f64) * MAX_WORK_AREA_RATIO / scale).max(1.0);
    let tall = base_h / base_w >= TALL_IMAGE_ASPECT;
    let display_h = if tall { logical_h.min(max_h) } else { logical_h };
    let physical_w = ((logical_w * scale).round() as i64).max(1);
    let physical_h = ((display_h * scale).round() as i64).max(1);
    (physical_w as f64 / scale, physical_h as f64 / scale)
}

/// Highest allowed zoom: there is **no product limit** (the user asked for
/// unbounded zoom-in), only the window-size ceiling keeps the window valid.
fn max_pin_zoom(width: u32, height: u32) -> f64 {
    let largest = width.max(height).max(1) as f64;
    (PIN_MAX_WINDOW_PX / largest).max(1.0)
}

/// Clamps a renderer-provided zoom into `[15%, window-size ceiling]`.
/// Non-finite values fall back to 100% so a broken wheel event can never
/// collapse or blow up a pin.
fn clamp_pin_zoom(value: f64, max_zoom: f64) -> f64 {
    let max_zoom = if max_zoom.is_finite() && max_zoom >= PIN_ZOOM_MIN {
        max_zoom
    } else {
        1.0
    };
    let value = if value.is_finite() { value } else { 1.0 };
    value.clamp(PIN_ZOOM_MIN, max_zoom)
}

fn log_info(app: &AppHandle, message: &str) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        state.log.info(message);
    }
}

/// Stores `image` in the registry and creates its pin window. Returns the pin
/// id plus the physical image size (`width`/`height` of the pinned screenshot).
///
/// `anchor` is the physical screen position the pinned image should keep: the
/// original selection's top-left corner, so pinning a screenshot does not make
/// it jump towards the cursor (the toolbar button sits below the selection).
/// `None` falls back to the cursor-centred placement.
pub fn create_pin(
    app: &AppHandle,
    image: RgbaImage,
    anchor: Option<(i32, i32)>,
) -> Result<(u64, u32, u32), EngineError> {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err(EngineError::new("钉图内容为空。", "请重新框选区域后再试。"));
    }
    /* The work area and DPI scale follow the anchor when there is one (the pin
     * stays where the screenshot was taken), otherwise the cursor. */
    let (anchor_point, scale, work) = match anchor {
        Some((x, y)) => (Some((x, y)), win32::monitor_scale_factor(x, y), win32::work_area_physical(x, y)),
        None => {
            let cursor = win32::cursor_physical();
            (
                None,
                win32::monitor_scale_factor(cursor.0, cursor.1),
                win32::work_area_physical(cursor.0, cursor.1),
            )
        }
    };
    let (logical_w, logical_h) =
        pin_display_size(width, height, scale, work.width(), work.height());
    let scale = if scale.is_finite() && scale > 0.1 {
        scale
    } else {
        1.0
    };
    let physical_w = ((logical_w * scale).round() as u32).max(1);
    let physical_h = ((logical_h * scale).round() as u32).max(1);
    // The image is rendered at the window width; if that makes it taller than
    // the window (long screenshot), the pin scrolls inside the window.
    let scrollable = pin_is_scrollable(logical_w, logical_h, width, height);
    let position = match anchor_point {
        /* Keep the image exactly where the selection was; only clamp it back
         * into the work area when the display size differs from the selection. */
        Some((x, y)) => win32::clamp_to_work_area(
            x,
            y,
            physical_w as i32,
            physical_h as i32,
            &work,
        ),
        None => {
            let cursor = win32::cursor_physical();
            pin_window_position(
                cursor.0,
                cursor.1,
                physical_w as i32,
                physical_h as i32,
                &work,
            )
        }
    };
    // 100% zoom means one image pixel per physical pixel: derive the wheel zoom
    // the window starts at (large screenshots start below 1.0, tiny snippets
    // above it; it is also the upper wheel limit).
    let base_logical_w = (width as f64 / scale).max(1.0);
    let initial_zoom = (logical_w / base_logical_w).max(PIN_ZOOM_MIN);

    let id = lock_registry().insert(image, scrollable, initial_zoom);
    let label = label_for(id);
    let window = match WebviewWindowBuilder::new(
        app,
        label.as_str(),
        WebviewUrl::App(format!("pin.html?id={id}").into()),
    )
    .title("Lexora 钉图")
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .shadow(false)
    .visible(false)
    .background_color(Color(0, 0, 0, 0))
    .inner_size(logical_w, logical_h)
    .build()
    {
        Ok(window) => window,
        Err(error) => {
            lock_registry().remove(id);
            return Err(EngineError::new(
                "无法创建钉图窗口。",
                format!("请重试或重启程序（{error}）。"),
            ));
        }
    };

    let placed = window
        .set_position(PhysicalPosition::new(position.0, position.1))
        .and_then(|_| window.set_size(PhysicalSize::new(physical_w, physical_h)));
    if let Err(error) = placed {
        let _ = window.destroy();
        lock_registry().remove(id);
        return Err(EngineError::new(
            "无法定位钉图窗口。",
            format!("请重试或重启程序（{error}）。"),
        ));
    }
    // Close instantly (no DWM fade-out flash) like the capture overlay.
    let _ = crate::win32::disable_transitions(&window);

    let _ = window.show();
    let _ = window.set_focus();
    log_info(
        app,
        &format!(
            "pin created: id={id} image={width}x{height} display={physical_w}x{physical_h} \
             at ({},{}) scale={scale:.3}",
            position.0, position.1
        ),
    );
    Ok((id, width, height))
}

/// PNG data URL + physical size of one pin (`pin_ready`, contract §11.4).
pub fn ready(id: u64) -> Result<Value, EngineError> {
    let mut registry = lock_registry();
    let Some(entry) = registry.get_mut(id) else {
        return Err(pin_missing_error());
    };
    if entry.data_url.is_none() {
        entry.data_url = Some(crate::capture::png_data_url(&entry.image)?);
    }
    let (width, height) = entry.image.dimensions();
    let data_url = entry.data_url.clone().unwrap_or_default();
    let scrollable = entry.scrollable;
    let zoom = entry.zoom;
    let min_zoom = PIN_ZOOM_MIN;
    let max_zoom = max_pin_zoom(width, height);
    Ok(json!({
        "dataUrl": data_url,
        "width": width,
        "height": height,
        "scrollable": scrollable,
        "zoom": zoom,
        "minZoom": min_zoom,
        "maxZoom": max_zoom,
    }))
}

/// Moves a pin window by a logical-pixel delta and clamps it into the virtual
/// desktop so it can travel across monitors (`pin_drag`, contract §11.5).
pub fn drag(app: &AppHandle, id: u64, dx: f64, dy: f64) -> Result<(), EngineError> {
    let Some(window) = app.get_webview_window(&label_for(id)) else {
        return Err(pin_missing_error());
    };
    let scale = window
        .scale_factor()
        .ok()
        .filter(|scale| scale.is_finite() && *scale > 0.1)
        .unwrap_or(1.0);
    let current = window
        .outer_position()
        .map_err(|error| EngineError::new("无法移动钉图。", format!("请重试（{error}）。")))?;
    let size = window
        .outer_size()
        .map_err(|error| EngineError::new("无法移动钉图。", format!("请重试（{error}）。")))?;
    let x = current.x + (dx * scale).round() as i32;
    let y = current.y + (dy * scale).round() as i32;
    // A pinned image may be dragged across monitors: clamp to the whole virtual
    // desktop, not to the work area of the monitor it currently sits on.
    let (x, y) = win32::clamp_to_virtual_screen(x, y, size.width as i32, size.height as i32);
    let _ = window.set_position(PhysicalPosition::new(x, y));
    Ok(())
}

/// Mouse-wheel zoom of one pin window (`pin_zoom`, contract §11.5): the window
/// grows/shrinks from its **top-left corner** (user requirement, not centred),
/// there is **no product maximum** (only the OS window-size ceiling), the floor
/// is 15%, and a long screenshot keeps the work-area height cap (it scrolls
/// instead of growing past the screen).
pub fn zoom(app: &AppHandle, id: u64, zoom: f64) -> Result<Value, EngineError> {
    let Some(window) = app.get_webview_window(&label_for(id)) else {
        return Err(pin_missing_error());
    };
    let (width, height) = {
        let registry = lock_registry();
        let Some(entry) = registry.entries.get(&id) else {
            return Err(pin_missing_error());
        };
        entry.image.dimensions()
    };
    let max_zoom = max_pin_zoom(width, height);
    let scale = window
        .scale_factor()
        .ok()
        .filter(|scale| scale.is_finite() && *scale > 0.1)
        .unwrap_or(1.0);
    let next = clamp_pin_zoom(zoom, max_zoom);
    let current = window
        .outer_position()
        .map_err(|error| EngineError::new("无法缩放钉图。", format!("请重试（{error}）。")))?;
    let old_size = window
        .outer_size()
        .map_err(|error| EngineError::new("无法缩放钉图。", format!("请重试（{error}）。")))?;
    let center_x = current.x + old_size.width as i32 / 2;
    let center_y = current.y + old_size.height as i32 / 2;
    let work = win32::work_area_physical(center_x, center_y);
    let (logical_w, logical_h) = pin_zoom_size(width, height, scale, next, work.height());
    // The top-left corner is the zoom anchor: it stays exactly where it is, so
    // zooming in grows the pin to the right/bottom (and a zoomed-in pin may
    // extend past the desktop; it can still be dragged).
    let x = current.x;
    let y = current.y;
    let scrollable = pin_is_scrollable(logical_w, logical_h, width, height);
    window
        .set_size(LogicalSize::new(logical_w, logical_h))
        .and_then(|_| window.set_position(PhysicalPosition::new(x, y)))
        .map_err(|error| EngineError::new("无法缩放钉图。", format!("请重试（{error}）。")))?;
    if let Some(entry) = lock_registry().get_mut(id) {
        entry.zoom = next;
        entry.scrollable = scrollable;
    }
    log_info(
        app,
        &format!(
            "pin zoom: id={id} zoom={next:.3} display={logical_w:.0}x{logical_h:.0} at ({x},{y})"
        ),
    );
    Ok(json!({
        "ok": true,
        "zoom": next,
        "minZoom": PIN_ZOOM_MIN,
        "maxZoom": max_zoom,
        "width": logical_w,
        "height": logical_h,
        "scrollable": scrollable,
    }))
}

/// Runs a panel skill (OCR / translate / explain / custom image skill) on a
/// pinned image, optionally with the pin editor's annotation layer
/// (`pin_skill`, contract §11.5). The result streams into the picker panel,
/// which opens below the pin like the screenshot flow opens below its selection.
#[allow(clippy::too_many_arguments)]
pub fn skill(
    app: &AppHandle,
    state: &AppState,
    id: u64,
    action: &str,
    skill_id: Option<String>,
    target_lang: Option<String>,
    request_id: Option<String>,
    annotations: Option<String>,
) -> Result<CaptureJob, EngineError> {
    let Some(window) = app.get_webview_window(&label_for(id)) else {
        return Err(pin_missing_error());
    };
    let image = {
        let registry = lock_registry();
        let Some(entry) = registry.entries.get(&id) else {
            return Err(pin_missing_error());
        };
        entry.image.clone()
    };
    let position = window
        .outer_position()
        .unwrap_or(PhysicalPosition::new(0, 0));
    let size = window.outer_size().unwrap_or(PhysicalSize::new(1, 1));
    let anchor = (
        position.x + size.width as i32 / 2,
        position.y + size.height as i32 - 1,
    );
    let scale = win32::monitor_scale_factor(anchor.0, anchor.1);
    state.capture.skill_image(
        app,
        image,
        annotations,
        action,
        skill_id,
        target_lang,
        request_id,
        anchor,
        scale,
    )
}

/// Composites the pin editor's annotation layer into a pinned image and writes
/// it to the clipboard (`pin_export_annotations`, contract §11.5). With `apply`
/// the pinned image itself is replaced by the annotated one and the renderer
/// gets the new PNG back; without it the original pin stays untouched (plain
/// "copy with annotations").
pub fn export_annotations(
    app: &AppHandle,
    id: u64,
    annotations: Option<String>,
    apply: bool,
) -> Result<Value, EngineError> {
    let mut image = {
        let registry = lock_registry();
        let Some(entry) = registry.entries.get(&id) else {
            return Err(pin_missing_error());
        };
        entry.image.clone()
    };
    crate::capture::compose_annotations(&mut image, annotations)?;
    let (width, height) = image.dimensions();
    let clipboard = app
        .clipboard()
        .write_image(&tauri::image::Image::new(image.as_raw(), width, height))
        .is_ok();
    if !apply {
        log_info(
            app,
            &format!("pin annotations copied: id={id} {width}x{height} clipboard={clipboard}"),
        );
        return Ok(json!({
            "ok": true,
            "clipboard": clipboard,
            "width": width,
            "height": height,
        }));
    }
    let data_url = crate::capture::png_data_url(&image)?;
    // Annotations never change the image size, so the window/scroll state stays
    // exactly as it was; only the pixels and the cached PNG are replaced.
    if let Some(entry) = lock_registry().get_mut(id) {
        entry.image = image;
        entry.data_url = Some(data_url.clone());
    }
    log_info(
        app,
        &format!("pin annotations applied: id={id} {width}x{height} clipboard={clipboard}"),
    );
    Ok(json!({
        "ok": true,
        "clipboard": clipboard,
        "width": width,
        "height": height,
        "dataUrl": data_url,
    }))
}

/// Converts a logical length reported by the renderer to physical pixels.
fn logical_px(value: f64, scale: f64) -> i32 {
    if value.is_finite() {
        (value.clamp(0.0, 30_000.0) * scale).round() as i32
    } else {
        0
    }
}

/// Grows (or restores) the pin window for the edit-mode toolbar
/// (`pin_edit_window`, contract §11.5). The window gets an extra transparent
/// strip below the image — or above it when there is no room below — so the
/// toolbar floats **outside** the image like the screenshot toolbar floats
/// outside the selection. The window is also widened to the single-row toolbar
/// width: the extra transparent area is added on the right, or the window
/// shifts left (clamped to the work area) and reports `leftPadding` so the
/// renderer can push the image back to its original on-screen position.
/// `toolbar_height`/`toolbar_width` are logical pixels; `topPadding` and
/// `leftPadding` in the reply tell the renderer how far the image must move
/// inside the window.
pub fn edit_window(
    app: &AppHandle,
    id: u64,
    editing: bool,
    toolbar_height: f64,
    toolbar_width: f64,
) -> Result<Value, EngineError> {
    let Some(window) = app.get_webview_window(&label_for(id)) else {
        return Err(pin_missing_error());
    };
    let scale = window
        .scale_factor()
        .ok()
        .filter(|scale| scale.is_finite() && *scale > 0.1)
        .unwrap_or(1.0);
    let toolbar = logical_px(toolbar_height.min(4_000.0), scale);
    let bar_width = logical_px(toolbar_width, scale);

    if !editing {
        let restore = {
            let mut registry = lock_registry();
            let Some(entry) = registry.get_mut(id) else {
                return Err(pin_missing_error());
            };
            entry.edit_restore.take()
        };
        let Some(restore) = restore else {
            return Ok(json!({
                "ok": true,
                "editing": false,
                "topPadding": 0.0,
                "leftPadding": 0.0,
            }));
        };
        window
            .set_size(PhysicalSize::new(
                restore.width.max(1) as u32,
                restore.height.max(1) as u32,
            ))
            .and_then(|_| window.set_position(PhysicalPosition::new(restore.x, restore.y)))
            .map_err(|error| {
                EngineError::new("无法收起编辑工具栏。", format!("请重试（{error}）。"))
            })?;
        log_info(
            app,
            &format!(
                "pin edit window closed: id={id} restored={}x{} at ({},{})",
                restore.width, restore.height, restore.x, restore.y
            ),
        );
        return Ok(json!({
            "ok": true,
            "editing": false,
            "topPadding": 0.0,
            "leftPadding": 0.0,
        }));
    }

    // First call records the original geometry; repeated layout passes (compact
    // mode, toolbar wrapping) always start from it so the window never grows
    // step by step.
    let saved = {
        let mut registry = lock_registry();
        let Some(entry) = registry.get_mut(id) else {
            return Err(pin_missing_error());
        };
        entry.edit_restore.take()
    };
    let base = match saved {
        Some(restore) => restore,
        None => {
            let position = window.outer_position().map_err(|error| {
                EngineError::new("无法展开编辑工具栏。", format!("请重试（{error}）。"))
            })?;
            let size = window.outer_size().map_err(|error| {
                EngineError::new("无法展开编辑工具栏。", format!("请重试（{error}）。"))
            })?;
            let restore = EditRestore {
                x: position.x,
                y: position.y,
                width: size.width as i32,
                height: size.height as i32,
            };
            if let Some(entry) = lock_registry().get_mut(id) {
                entry.edit_restore = Some(restore);
            }
            restore
        }
    };
    // Snap back to the original size first: the strip is always computed from
    // the unexpanded window.
    let _ = window.set_size(PhysicalSize::new(
        base.width.max(1) as u32,
        base.height.max(1) as u32,
    ));
    let _ = window.set_position(PhysicalPosition::new(base.x, base.y));
    let work = win32::work_area_physical(base.x + base.width / 2, base.y + base.height / 2);
    // Width: the toolbar is a single row, so the window must be at least as wide
    // as the bar. The image keeps its on-screen position: the extra area grows to
    // the right, and when the work area's right edge is in the way the window
    // shifts left instead (`leftPadding` below tells the renderer how far to push
    // the image back).
    let max_width = work.width().max(1) as i32;
    let desired_width = bar_width.max(base.width).max(1);
    let new_width = desired_width.min(max_width);
    let mut new_x = base.x;
    if new_x + new_width > work.right {
        new_x = work.right - new_width;
    }
    if new_x < work.left {
        new_x = work.left;
    }
    let left_padding = (base.x - new_x).max(0);
    let can_down = base.y + base.height + toolbar <= work.bottom;
    let can_up = base.y - toolbar >= work.top;
    let (new_y, top_padding, new_height) = if can_down || !can_up {
        (base.y, 0, base.height + toolbar)
    } else {
        (base.y - toolbar, toolbar, base.height + toolbar)
    };
    window
        .set_size(PhysicalSize::new(
            new_width.max(1) as u32,
            new_height.max(1) as u32,
        ))
        .and_then(|_| window.set_position(PhysicalPosition::new(new_x, new_y)))
        .map_err(|error| EngineError::new("无法展开编辑工具栏。", format!("请重试（{error}）。")))?;
    if let Some(entry) = lock_registry().get_mut(id) {
        entry.edit_restore = Some(base);
    }
    log_info(
        app,
        &format!(
            "pin edit window: id={id} base={}x{} toolbar={toolbar} bar_width={bar_width} \
             top_padding={top_padding} left_padding={left_padding} at ({new_x},{new_y})",
            base.width, base.height
        ),
    );
    Ok(json!({
        "ok": true,
        "editing": true,
        "topPadding": top_padding as f64 / scale,
        "leftPadding": left_padding as f64 / scale,
        "toolbarHeight": toolbar as f64 / scale,
        "toolbarWidth": bar_width as f64 / scale,
        "width": new_width as f64 / scale,
        "height": new_height as f64 / scale,
        "clamped": new_width < desired_width,
    }))
}

/// Writes the pin image to the system clipboard (`pin_copy`, contract §11.5).
pub fn copy(app: &AppHandle, id: u64) -> Result<(), EngineError> {
    let registry = lock_registry();
    let Some(entry) = registry.entries.get(&id) else {
        return Err(pin_missing_error());
    };
    let (width, height) = entry.image.dimensions();
    let image = tauri::image::Image::new(entry.image.as_raw(), width, height);
    app.clipboard()
        .write_image(&image)
        .map_err(|error| EngineError::new("复制钉图到剪贴板失败。", format!("请重试（{error}）。")))
}

/// Destroys the pin window, forgets its image and notifies listeners
/// (`pin_close`, contract §11.4).
pub fn close(app: &AppHandle, id: u64) {
    let removed = lock_registry().remove(id);
    if let Some(window) = app.get_webview_window(&label_for(id)) {
        let _ = window.destroy();
    }
    if removed.is_some() {
        let _ = app.emit(EVENT_PIN_CLOSE, json!({ "id": id }));
        log_info(app, &format!("pin closed: id={id}"));
    }
}

/// Forgets a pin whose window was destroyed by the shell/OS without going
/// through [`close`] (keeps the registry from leaking images).
pub fn forget(id: u64) {
    lock_registry().remove(id);
}

/// Drops every pinned image (app shutdown; the windows die with the process).
pub fn clear_registry() {
    lock_registry().entries.clear();
}

/// Number of live pins (used by tests/monitoring).
pub fn pin_count() -> usize {
    lock_registry().len()
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_pin_zoom, max_pin_zoom, pin_display_size, pin_id_from_label, pin_is_scrollable,
        pin_window_position, pin_zoom_size, PinRegistry, MAX_WORK_AREA_RATIO, PIN_MAX_WINDOW_PX,
        PIN_ZOOM_MIN,
    };
    use crate::win32::WorkArea;
    use image::{Rgba, RgbaImage};

    fn image(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_pixel(width, height, Rgba([10, 20, 30, 255]))
    }

    fn work() -> WorkArea {
        WorkArea {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        }
    }

    #[test]
    fn pin_zoom_scales_the_window_and_keeps_long_screenshots_capped() {
        // 100% = one image pixel per physical pixel.
        assert_eq!(pin_zoom_size(1000, 500, 1.0, 1.0, 1080), (1000.0, 500.0));
        // 15% minimum window size.
        assert_eq!(
            pin_zoom_size(1000, 500, 1.0, PIN_ZOOM_MIN, 1080),
            (150.0, 75.0)
        );
        // On a 150% screen the same physical image is 2/3 of the logical size.
        let (width, height) = pin_zoom_size(1000, 500, 1.5, 1.0, 1440);
        assert!((width - 666.6667).abs() < 0.01, "width={width}");
        assert!((height - 333.3333).abs() < 0.01, "height={height}");
        // A tall screenshot keeps the readable width and the work-area height cap
        // (pin.js enables scrolling instead of growing past the screen).
        let (width, height) = pin_zoom_size(1000, 30000, 1.0, 0.5, 1080);
        assert_eq!(width, 500.0);
        assert!((height - 756.0).abs() < 0.01, "height={height}");
    }

    #[test]
    fn pin_zoom_clamps_to_fifteen_percent_without_a_product_maximum() {
        // Never smaller than 15% (user requirement).
        assert_eq!(clamp_pin_zoom(0.05, 30.0), PIN_ZOOM_MIN);
        assert_eq!(clamp_pin_zoom(0.5, 30.0), 0.5);
        // Zooming in has no product limit: only the window-size ceiling applies.
        assert_eq!(clamp_pin_zoom(2.0, 30.0), 2.0);
        assert_eq!(clamp_pin_zoom(12.5, 30.0), 12.5);
        assert_eq!(clamp_pin_zoom(40.0, 30.0), 30.0);
        assert_eq!(clamp_pin_zoom(f64::NAN, 30.0), 1.0);
        // A broken ceiling falls back to a sane 100% maximum.
        assert_eq!(clamp_pin_zoom(5.0, 0.0), 1.0);
    }

    #[test]
    fn pin_max_zoom_only_guards_the_window_size_ceiling() {
        // A 1000x500 image can be magnified up to the 30k px window ceiling.
        assert_eq!(max_pin_zoom(1000, 500), PIN_MAX_WINDOW_PX / 1000.0);
        // A 4K screenshot still supports roughly 7.8x before the window ceiling.
        let max_zoom = max_pin_zoom(3840, 2160);
        assert!((max_zoom - 7.8125).abs() < 0.001, "max_zoom={max_zoom}");
        // Degenerate dimensions never disable zooming.
        assert_eq!(max_pin_zoom(0, 0), PIN_MAX_WINDOW_PX);
    }

    #[test]
    fn pin_labels_expose_their_id() {
        assert_eq!(pin_id_from_label("pin-1"), Some(1));
        assert_eq!(pin_id_from_label("pin-42"), Some(42));
        assert_eq!(pin_id_from_label("pin-"), None);
        assert_eq!(pin_id_from_label("pin-abc"), None);
        assert_eq!(pin_id_from_label("capture-1"), None);
        assert_eq!(pin_id_from_label("picker"), None);
    }

    #[test]
    fn pin_ids_are_monotonic_and_removal_cleans_up() {
        let mut registry = PinRegistry::default();
        let first = registry.insert(image(4, 4), false, 1.0);
        let second = registry.insert(image(5, 5), false, 1.0);
        assert_eq!((first, second), (1, 2));
        assert_eq!(registry.len(), 2);
        assert!(registry.get_mut(first).is_some());
        assert!(registry.remove(first).is_some());
        assert_eq!(registry.len(), 1);
        assert!(registry.remove(first).is_none());
        // Ids are never reused, even after a closed pin.
        let third = registry.insert(image(6, 6), false, 1.0);
        assert_eq!(third, 3);
        assert!(registry.get_mut(second).is_some());
        // Removing everything leaves an empty registry that keeps counting.
        registry.remove(second);
        assert_eq!(registry.len(), 1);
        assert!(registry.remove(third).is_some());
        assert_eq!(registry.len(), 0);
        assert_eq!(registry.insert(image(1, 1), false, 1.0), 4);
    }

    #[test]
    fn pin_display_size_fits_the_work_area_and_stays_readable() {
        // Small images keep their physical/DIP size.
        assert_eq!(
            pin_display_size(1000, 500, 1.0, 1920, 1080),
            (1000.0, 500.0)
        );
        // On a 150% display the logical size shrinks; the 70% cap applies.
        let (width, height) = pin_display_size(3840, 2160, 1.5, 3840, 2160);
        assert!((width - 1792.0).abs() < 0.01, "width={width}");
        assert!((height - 1008.0).abs() < 0.01, "height={height}");
        assert!(width <= 3840.0 * MAX_WORK_AREA_RATIO / 1.5 + 0.01);
        // Oversized images are scaled down proportionally.
        let (width, height) = pin_display_size(3840, 2160, 1.0, 1920, 1080);
        assert!((width - 1344.0).abs() < 0.01, "width={width}");
        assert!((height - 756.0).abs() < 0.01, "height={height}");
        // Very small snippets are enlarged (capped at 4x).
        assert_eq!(pin_display_size(10, 10, 1.0, 1920, 1080), (40.0, 40.0));
        assert_eq!(pin_display_size(40, 40, 1.0, 1920, 1080), (48.0, 48.0));
        // A tall long-screenshot keeps its readable width and is windowed to the
        // work-area height (the pin window scrolls its content).
        let (width, height) = pin_display_size(1000, 30000, 1.0, 1920, 1080);
        assert_eq!((width, height), (1000.0, 756.0));
        // Too-wide long screenshots still scale to the work area width.
        let (width, height) = pin_display_size(4000, 30000, 1.0, 1920, 1080);
        assert!((width - 1344.0).abs() < 0.01, "width={width}");
        assert!((height - 756.0).abs() < 0.01, "height={height}");
        // Big non-long images (aspect < 3) scale uniformly: the pin shows the
        // whole image and never needs a scrollbar.
        let (width, height) = pin_display_size(4000, 4000, 1.0, 1920, 1080);
        assert_eq!((width, height), (756.0, 756.0));
        // Wide screenshots whose height also exceeds the cap fit both axes.
        let (width, height) = pin_display_size(2560, 1440, 1.5, 3840, 2088);
        assert!(
            height <= 2088.0 * MAX_WORK_AREA_RATIO / 1.5 + 0.01,
            "height={height}"
        );
        assert!(
            (width / height - 2560.0 / 1440.0).abs() < 0.02,
            "{width}x{height}"
        );
    }

    #[test]
    fn pin_scrollable_only_for_tall_images() {
        // Uniformly fitted screenshot: rendered height equals the window height.
        assert!(!pin_is_scrollable(1792.0, 1008.0, 3840, 2160));
        // Long screenshot: the width is kept, the window height is capped.
        assert!(pin_is_scrollable(1000.0, 756.0, 1000, 30000));
        assert!(!pin_is_scrollable(320.0, 200.0, 320, 200));
        assert!(!pin_is_scrollable(320.0, 200.0, 0, 0));
    }

    #[test]
    fn pin_windows_open_near_the_cursor_and_stay_inside_the_work_area() {
        // Centred on the cursor when there is room.
        assert_eq!(pin_window_position(500, 500, 200, 100, &work()), (400, 450));
        // Clamped at the top-left corner.
        assert_eq!(pin_window_position(10, 10, 200, 100, &work()), (0, 0));
        // Clamped at the bottom-right corner.
        assert_eq!(
            pin_window_position(1910, 1070, 200, 100, &work()),
            (1720, 980)
        );
        // Images wider than the work area anchor at the left edge.
        assert_eq!(pin_window_position(500, 500, 4000, 100, &work()).0, 0);
    }
}
