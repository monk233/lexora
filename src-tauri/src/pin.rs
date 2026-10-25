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
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::engine::EngineError;
use crate::state::AppState;
use crate::win32;

/// Window label prefix of pinned images (`pin-<id>`).
pub const PIN_PREFIX: &str = "pin-";
/// Event emitted when a pin is closed (contract §11.4).
pub const EVENT_PIN_CLOSE: &str = "pin-close";
/// A pin may cover at most this share of the work area; larger images scale down.
const MAX_WORK_AREA_RATIO: f64 = 0.70;
/// Very small snippets are enlarged for readability, but never more than this.
const MAX_READABLE_UPSCALE: f64 = 4.0;
/// A pinned window is never displayed smaller than this (logical pixels).
const MIN_READABLE_LOGICAL: f64 = 48.0;

struct PinEntry {
    image: RgbaImage,
    /// Lazily encoded `data:image/png;base64,...` handed to `pin.html`.
    data_url: Option<String>,
    /// `true` when the image is taller than its window (long screenshot): the
    /// pin scrolls inside the window, and only then a scrollbar may appear.
    scrollable: bool,
}

/// In-memory pin images plus the forward-only id counter.
#[derive(Default)]
struct PinRegistry {
    next_id: u64,
    entries: HashMap<u64, PinEntry>,
}

impl PinRegistry {
    fn insert(&mut self, image: RgbaImage, scrollable: bool) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.entries.insert(
            id,
            PinEntry {
                image,
                data_url: None,
                scrollable,
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

fn log_info(app: &AppHandle, message: &str) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        state.log.info(message);
    }
}

/// Stores `image` in the registry and creates its pin window. Returns the pin
/// id plus the physical image size (`width`/`height` of the pinned screenshot).
pub fn create_pin(app: &AppHandle, image: RgbaImage) -> Result<(u64, u32, u32), EngineError> {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err(EngineError::new("钉图内容为空。", "请重新框选区域后再试。"));
    }
    let cursor = win32::cursor_physical();
    let scale = win32::monitor_scale_factor(cursor.0, cursor.1);
    let work = win32::work_area_physical(cursor.0, cursor.1);
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
    let position = pin_window_position(
        cursor.0,
        cursor.1,
        physical_w as i32,
        physical_h as i32,
        &work,
    );

    let id = lock_registry().insert(image, scrollable);
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
    Ok(json!({
        "dataUrl": data_url,
        "width": width,
        "height": height,
        "scrollable": scrollable,
    }))
}

/// Moves a pin window by a logical-pixel delta and clamps it into the work area
/// (`pin_drag`, contract §11.5).
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
    let work = win32::work_area_physical(
        current.x + size.width as i32 / 2,
        current.y + size.height as i32 / 2,
    );
    let (x, y) = win32::clamp_to_work_area(x, y, size.width as i32, size.height as i32, &work);
    let _ = window.set_position(PhysicalPosition::new(x, y));
    Ok(())
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
        pin_display_size, pin_id_from_label, pin_is_scrollable, pin_window_position, PinRegistry,
        MAX_WORK_AREA_RATIO,
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
        let first = registry.insert(image(4, 4), false);
        let second = registry.insert(image(5, 5), false);
        assert_eq!((first, second), (1, 2));
        assert_eq!(registry.len(), 2);
        assert!(registry.get_mut(first).is_some());
        assert!(registry.remove(first).is_some());
        assert_eq!(registry.len(), 1);
        assert!(registry.remove(first).is_none());
        // Ids are never reused, even after a closed pin.
        let third = registry.insert(image(6, 6), false);
        assert_eq!(third, 3);
        assert!(registry.get_mut(second).is_some());
        // Removing everything leaves an empty registry that keeps counting.
        registry.remove(second);
        assert_eq!(registry.len(), 1);
        assert!(registry.remove(third).is_some());
        assert_eq!(registry.len(), 0);
        assert_eq!(registry.insert(image(1, 1), false), 4);
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
