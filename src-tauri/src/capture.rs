//! Screenshot capture core: monitor grabbing (`xcap`), overlay windows,
//! on-device OCR (`native-ocr`) and online vision streaming.
//!
//! Flow: `start` hides our own windows, grabs every monitor on the `xcap` side
//! (physical pixels), stores an in-memory [`Session`] and opens one overlay
//! window per monitor (`capture.html?monitor=<index>`). The capture page then
//! asks for the PNG (`monitor_info`), the user draws a rectangle and chooses an
//! action: `copy` (clipboard + close), `ocr` (text) or `ai` (translate the OCR
//! text, explain the image, or run a user-defined image skill). AI results are
//! streamed to every overlay window as `capture-event` messages.

use std::io::Cursor;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use futures_util::StreamExt;
use image::{DynamicImage, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::engine::{EngineError, EngineService};
use crate::settings::Settings;
use crate::state::{lock, AppState};

/// Wait after hiding our windows so they are gone before the screenshot is taken.
const WINDOW_HIDE_DELAY: Duration = Duration::from_millis(120);
/// Event pushed to every capture overlay window.
const CAPTURE_EVENT: &str = "capture-event";
/// Actions accepted by [`CaptureService::ai`].
const AI_ACTIONS: [&str; 3] = ["translate", "explain", "custom"];
/// Monotonic part of generated request ids.
static REQUEST_SEQ: AtomicU64 = AtomicU64::new(0);

/// A physical-pixel rectangle on the selected monitor, sent by the capture page.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Optional preset chosen when the screenshot was started from a picker skill.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PresetInfo {
    skill_id: String,
    label: String,
}

/// One captured monitor.
struct Shot {
    index: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    image: RgbaImage,
}

/// Screenshot in progress: one image per monitor plus the optional preset.
struct Session {
    shots: Vec<Shot>,
    preset: Option<PresetInfo>,
}

/// What a capture AI request should do.
enum AiTask {
    /// OCR the region, then translate the recognized text.
    Translate { target_lang: String },
    /// Send the cropped image to a vision model with a system prompt.
    Vision { system: String },
}

/// Screenshot state stored in [`AppState`].
pub struct CaptureService {
    session: Mutex<Option<Session>>,
}

impl CaptureService {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }

    /// Hides our own windows, grabs every monitor and opens one overlay per
    /// monitor. Returns the number of monitors. On failure all partially created
    /// overlay windows are closed again and the session is dropped.
    pub async fn start(
        &self,
        app: &AppHandle,
        state: &AppState,
        preset_skill_id: Option<String>,
    ) -> Result<usize, EngineError> {
        // A new capture always replaces the previous session.
        self.close(app);
        crate::windows::hide_picker(app);
        crate::windows::hide_settings(app);
        tokio::time::sleep(WINDOW_HIDE_DELAY).await;

        let settings = state.settings.get();
        let preset = preset_skill_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .and_then(|id| image_skill(&settings, id).map(|skill| skill.id.clone()));
        let preset = preset.map(|id| {
            let label = settings
                .picker
                .custom_skills
                .iter()
                .find(|skill| skill.id == id)
                .map(|skill| skill.label.clone())
                .unwrap_or_default();
            PresetInfo {
                skill_id: id,
                label,
            }
        });

        let monitors = xcap::Monitor::all().map_err(|error| {
            EngineError::new(
                "无法枚举显示器。",
                format!("请确认系统允许屏幕截图后重试（{error}）。"),
            )
        })?;
        if monitors.is_empty() {
            return Err(EngineError::new(
                "未检测到显示器。",
                "请确认显示器连接正常后重试。",
            ));
        }

        let mut shots = Vec::with_capacity(monitors.len());
        for (index, monitor) in monitors.iter().enumerate() {
            let image = monitor.capture_image().map_err(|error| {
                EngineError::new(
                    "截取屏幕失败。",
                    format!("请确认没有其他程序独占屏幕后重试（{error}）。"),
                )
            })?;
            let x = monitor.x().unwrap_or(0);
            let y = monitor.y().unwrap_or(0);
            let width = monitor.width().unwrap_or_else(|_| image.width());
            let height = monitor.height().unwrap_or_else(|_| image.height());
            shots.push(Shot {
                index: index as u32,
                x,
                y,
                width,
                height,
                image,
            });
        }
        let overlays: Vec<(u32, i32, i32, u32, u32)> = shots
            .iter()
            .map(|shot| (shot.index, shot.x, shot.y, shot.width, shot.height))
            .collect();
        let count = shots.len();
        *lock(&self.session) = Some(Session { shots, preset });

        for (index, x, y, width, height) in overlays {
            if let Err(error) =
                crate::windows::create_capture_window(app, index, x, y, width, height)
            {
                self.close(app);
                return Err(EngineError::new(
                    "无法创建截图窗口。",
                    format!("请重试或重启程序（{error}）。"),
                ));
            }
        }
        // Make sure the first overlay owns the keyboard (Escape / selection keys).
        if let Some(window) =
            app.get_webview_window(&format!("{}{}", crate::windows::CAPTURE_PREFIX, 0))
        {
            let _ = window.set_focus();
        }

        state
            .log
            .info(&format!("screenshot capture started: monitors={count}"));
        Ok(count)
    }

    /// PNG data URL + monitor size (+ preset) for the capture page of `index`.
    pub fn monitor_info(&self, index: u32) -> Result<Value, EngineError> {
        let guard = lock(&self.session);
        let Some(session) = guard.as_ref() else {
            return Err(not_ready_error());
        };
        let shot = session
            .shots
            .iter()
            .find(|shot| shot.index == index)
            .ok_or_else(|| missing_monitor_error(index))?;
        let data_url = png_data_url(&shot.image)?;
        let preset = session
            .preset
            .as_ref()
            .map(|preset| serde_json::to_value(preset).unwrap_or(Value::Null))
            .unwrap_or(Value::Null);
        Ok(json!({
            "index": index,
            "width": shot.width,
            "height": shot.height,
            "dataUrl": data_url,
            "preset": preset,
        }))
    }

    /// Copies the cropped region to the clipboard, then closes the capture UI.
    pub fn copy(&self, app: &AppHandle, index: u32, rect: &HitRect) -> Result<(), EngineError> {
        let cropped = {
            let guard = lock(&self.session);
            let Some(session) = guard.as_ref() else {
                return Err(not_ready_error());
            };
            let shot = session
                .shots
                .iter()
                .find(|shot| shot.index == index)
                .ok_or_else(|| missing_monitor_error(index))?;
            crop_image(&shot.image, rect)?
        };
        let (width, height) = cropped.dimensions();
        let image = tauri::image::Image::new_owned(cropped.into_raw(), width, height);
        app.clipboard().write_image(&image).map_err(|error| {
            EngineError::new(
                "复制到剪贴板失败。",
                format!("请重试，或改用「提取文字」（{error}）。"),
            )
        })?;
        self.close(app);
        Ok(())
    }

    /// Recognizes the text inside `rect` with the OS OCR engine.
    pub async fn ocr(&self, index: u32, rect: &HitRect) -> Result<String, EngineError> {
        let cropped = {
            let guard = lock(&self.session);
            let Some(session) = guard.as_ref() else {
                return Err(not_ready_error());
            };
            let shot = session
                .shots
                .iter()
                .find(|shot| shot.index == index)
                .ok_or_else(|| missing_monitor_error(index))?;
            crop_image(&shot.image, rect)?
        };
        recognize_text(&cropped).await
    }

    /// Starts an AI action on the cropped region; results stream to the capture
    /// windows as `capture-event` chunks. Validation errors are returned
    /// synchronously so the command can report them before streaming.
    pub fn ai(
        &self,
        app: &AppHandle,
        index: u32,
        rect: &HitRect,
        action: &str,
        skill_id: Option<String>,
        target_lang: Option<String>,
        request_id: Option<String>,
    ) -> Result<(), EngineError> {
        let settings = settings_of(app)?;
        if settings.is_local_mode() {
            return Err(local_vision_error());
        }
        let action = action.trim().to_ascii_lowercase();
        if !AI_ACTIONS.contains(&action.as_str()) {
            return Err(EngineError::new(
                "不支持的截图操作。",
                "支持翻译文字（translate）、解释图片（explain）或自定义图片技能（custom）。",
            ));
        }
        let requested_target = target_lang
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| settings.picker.default_target_lang.clone());
        let requested_skill = skill_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        let task = match action.as_str() {
            "translate" => AiTask::Translate {
                target_lang: requested_target,
            },
            "explain" => AiTask::Vision {
                system: crate::engine::DEFAULT_EXPLAIN_IMAGE_PROMPT.to_string(),
            },
            _ => {
                let Some(skill_id) = requested_skill else {
                    return Err(EngineError::new(
                        "缺少图片技能标识。",
                        "请选择要使用的图片技能后重试。",
                    ));
                };
                let Some(skill) = settings
                    .picker
                    .custom_skills
                    .iter()
                    .find(|skill| skill.id == skill_id)
                else {
                    return Err(EngineError::new(
                        "技能不存在（可能已被删除）",
                        "请在设置 → 划词行为中重新添加该技能。",
                    ));
                };
                if skill.kind != "image" {
                    return Err(EngineError::new(
                        "该技能不是图片技能。",
                        "请在设置中把技能类型改为「图片」，或改用文字技能。",
                    ));
                }
                if !settings.picker.skills.iter().any(|id| id == &skill.id) {
                    return Err(EngineError::new(
                        "技能未启用",
                        "请在设置 → 划词行为中启用该技能。",
                    ));
                }
                let target = crate::engine::resolve_target_lang(&requested_target, "");
                AiTask::Vision {
                    system: crate::engine::render_image_prompt(&skill.prompt, &target),
                }
            }
        };

        let image = {
            let guard = lock(&self.session);
            let Some(session) = guard.as_ref() else {
                return Err(not_ready_error());
            };
            let shot = session
                .shots
                .iter()
                .find(|shot| shot.index == index)
                .ok_or_else(|| missing_monitor_error(index))?;
            crop_image(&shot.image, rect)?
        };
        let data_url = png_data_url(&image)?;
        let request_id = normalize_request_id(request_id);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            run_ai(app, image, data_url, task, request_id).await;
        });
        Ok(())
    }

    /// Destroys every overlay window and forgets the session.
    pub fn close(&self, app: &AppHandle) {
        crate::windows::close_capture_windows(app);
        *lock(&self.session) = None;
    }
}

impl Default for CaptureService {
    fn default() -> Self {
        Self::new()
    }
}

/// Entry point used by the commands and by the Win+Shift+X action worker.
pub async fn start_capture(
    app: &AppHandle,
    state: &AppState,
    preset_skill_id: Option<String>,
) -> Result<usize, EngineError> {
    state.capture.start(app, state, preset_skill_id).await
}

// ---------------------------------------------------------------------------
// AI streaming
// ---------------------------------------------------------------------------

async fn run_ai(
    app: AppHandle,
    image: RgbaImage,
    data_url: String,
    task: AiTask,
    request_id: String,
) {
    let result = match task {
        AiTask::Translate { target_lang } => {
            run_translate(app.clone(), image, target_lang, request_id.clone()).await
        }
        AiTask::Vision { system } => {
            run_vision(app.clone(), data_url, system, request_id.clone()).await
        }
    };
    if let Err(error) = result {
        emit_capture_event(
            &app,
            json!({
                "requestId": request_id,
                "type": "error",
                "message": error.message,
                "hint": error.hint,
            }),
        );
    }
}

async fn run_vision(
    app: AppHandle,
    data_url: String,
    system: String,
    request_id: String,
) -> Result<(), EngineError> {
    let engine = engine_of(&app)?;
    let mut stream = engine.vision_stream(&data_url, &system).await?;
    stream_chunks(&app, &request_id, &mut stream).await?;
    emit_capture_event(&app, json!({"requestId": request_id, "type": "done"}));
    Ok(())
}

async fn run_translate(
    app: AppHandle,
    image: RgbaImage,
    requested_target: String,
    request_id: String,
) -> Result<(), EngineError> {
    let text = recognize_text(&image).await?;
    let target = crate::engine::resolve_target_lang(&requested_target, &text);
    let engine = engine_of(&app)?;
    let mut stream = engine.translate_stream(&text, &target).await?;
    stream_chunks(&app, &request_id, &mut stream).await?;
    emit_capture_event(&app, json!({"requestId": request_id, "type": "done"}));
    Ok(())
}

async fn stream_chunks(
    app: &AppHandle,
    request_id: &str,
    stream: &mut futures_util::stream::BoxStream<'static, Result<String, EngineError>>,
) -> Result<(), EngineError> {
    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => {
                if chunk.is_empty() {
                    continue;
                }
                emit_capture_event(
                    app,
                    json!({"requestId": request_id, "type": "chunk", "text": chunk}),
                );
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn emit_capture_event(app: &AppHandle, payload: Value) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(crate::windows::CAPTURE_PREFIX) {
            let _ = window.emit(CAPTURE_EVENT, payload.clone());
        }
    }
}

// ---------------------------------------------------------------------------
// OCR / image helpers
// ---------------------------------------------------------------------------

/// Runs the OS OCR engine on an RGBA bitmap (blocking work on a worker thread).
async fn recognize_text(image: &RgbaImage) -> Result<String, EngineError> {
    let (width, height) = image.dimensions();
    let bytes = image.clone().into_raw();
    let result = tauri::async_runtime::spawn_blocking(move || {
        native_ocr::recognize_rgba(&bytes, width, height)
    })
    .await
    .map_err(|error| {
        EngineError::new(
            "文字识别失败。",
            format!("后台识别任务异常，请重试（{error}）。"),
        )
    })?;
    let text = result.map_err(map_ocr_error)?.trim().to_string();
    if text.is_empty() {
        return Err(EngineError::new(
            "没有识别到文字。",
            "请重新框选包含文字的区域；若系统缺少语言包，请在 Windows 设置 → 时间和语言 → 语言中安装对应语言的 OCR 组件。",
        ));
    }
    Ok(text)
}

fn map_ocr_error(error: native_ocr::Error) -> EngineError {
    match error {
        native_ocr::Error::NoLanguage => EngineError::new(
            "系统缺少可用的 OCR 语言包。",
            "请在 Windows 设置 → 时间和语言 → 语言中安装对应语言包（含 OCR 组件）后重试。",
        ),
        native_ocr::Error::Unavailable => EngineError::new(
            "当前系统不支持文字识别。",
            "请升级 Windows 后再使用文字识别，或改用图片解释功能。",
        ),
        native_ocr::Error::NotInstalled => {
            EngineError::new("文字识别组件未安装。", "请安装系统的 OCR 组件后重试。")
        }
        native_ocr::Error::InvalidImage(_) => {
            EngineError::new("截图区域无效。", "请重新框选一个区域后再试。")
        }
        native_ocr::Error::Failed(message) => {
            EngineError::new("文字识别失败。", format!("请重试或更换区域（{message}）。"))
        }
    }
}

/// Clamps a physical-pixel hit rect to `image`, rounding the edges. Returns
/// `None` when the rectangle does not cover any pixel.
fn clamp_rect(image: &RgbaImage, rect: &HitRect) -> Option<(u32, u32, u32, u32)> {
    let (image_width, image_height) = image.dimensions();
    if image_width == 0 || image_height == 0 {
        return None;
    }
    let edge = |value: f64, max: u32| -> i64 {
        if !value.is_finite() {
            return 0;
        }
        (value.round() as i64).clamp(0, max as i64)
    };
    let left = edge(rect.x, image_width);
    let top = edge(rect.y, image_height);
    let right = edge(rect.x + rect.width, image_width);
    let bottom = edge(rect.y + rect.height, image_height);
    let width = right.saturating_sub(left) as u32;
    let height = bottom.saturating_sub(top) as u32;
    if width == 0 || height == 0 {
        return None;
    }
    Some((left as u32, top as u32, width, height))
}

fn crop_image(image: &RgbaImage, rect: &HitRect) -> Result<RgbaImage, EngineError> {
    let (x, y, width, height) = clamp_rect(image, rect)
        .ok_or_else(|| EngineError::new("选区无效。", "请重新框选一个有效的区域后再试。"))?;
    Ok(image::imageops::crop_imm(image, x, y, width, height).to_image())
}

/// ENCODE the image as PNG bytes.
fn png_bytes(image: &RgbaImage) -> Result<Vec<u8>, EngineError> {
    let mut cursor = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.clone())
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|error| {
            EngineError::new("编码截图失败。", format!("请重试或更换区域（{error}）。"))
        })?;
    Ok(cursor.into_inner())
}

/// `data:image/png;base64,...` URL used both by the capture page and the model.
fn png_data_url(image: &RgbaImage) -> Result<String, EngineError> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(png_bytes(image)?);
    Ok(format!("data:image/png;base64,{encoded}"))
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn not_ready_error() -> EngineError {
    EngineError::new(
        "截图尚未准备好。",
        "请稍候片刻再试，或重新发起截图（Win+Shift+X）。",
    )
}

fn missing_monitor_error(index: u32) -> EngineError {
    EngineError::new(
        format!("找不到第 {} 块屏幕。", index + 1),
        "请重新发起截图（Win+Shift+X）。",
    )
}

fn local_vision_error() -> EngineError {
    EngineError::new(
        "本地模型不支持图片理解。",
        "请在「设置 → 翻译服务」切换到在线 API，并使用支持视觉的模型（如 GPT-4o / Qwen-VL）；也可以改用「提取文字」。",
    )
}

fn settings_of(app: &AppHandle) -> Result<Settings, EngineError> {
    app.try_state::<std::sync::Arc<AppState>>()
        .map(|state| state.settings.get())
        .ok_or_else(not_ready_error)
}

fn engine_of(app: &AppHandle) -> Result<std::sync::Arc<EngineService>, EngineError> {
    app.try_state::<std::sync::Arc<AppState>>()
        .map(|state| state.engine.clone())
        .ok_or_else(not_ready_error)
}

/// Finds an enabled-or-not custom skill that acts on images.
fn image_skill<'a>(
    settings: &'a Settings,
    skill_id: &str,
) -> Option<&'a crate::settings::CustomSkill> {
    settings
        .picker
        .custom_skills
        .iter()
        .find(|skill| skill.id == skill_id && skill.kind == "image")
}

fn normalize_request_id(request_id: Option<String>) -> String {
    let provided = request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match provided {
        Some(value) => value.to_string(),
        None => next_request_id(),
    }
}

fn next_request_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let sequence = REQUEST_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("capture-{millis}-{sequence}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn pixel_image() -> RgbaImage {
        RgbaImage::from_fn(10, 10, |x, y| Rgba([x as u8, y as u8, 0, 255]))
    }

    #[test]
    fn hit_rect_uses_camel_case_and_defaults() {
        let parsed: HitRect = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed, HitRect::default());
        let parsed: HitRect =
            serde_json::from_str(r#"{"x":1.5,"y":2,"width":30,"height":40}"#).unwrap();
        assert_eq!(parsed.x, 1.5);
        assert_eq!(parsed.width, 30.0);
        let value = serde_json::to_value(HitRect {
            x: 1.0,
            y: 2.0,
            width: 3.0,
            height: 4.0,
        })
        .unwrap();
        assert_eq!(value["x"], 1.0);
        assert_eq!(value["height"], 4.0);
    }

    #[test]
    fn clamp_rect_rounds_and_clamps_to_the_image() {
        let tiny = RgbaImage::new(100, 80);
        // 10.4 -> 10, 20.6 -> 21, right 40.6 -> 41, bottom 61.5 -> 62.
        assert_eq!(
            clamp_rect(
                &tiny,
                &HitRect {
                    x: 10.4,
                    y: 20.6,
                    width: 30.2,
                    height: 40.9
                }
            ),
            Some((10, 21, 31, 41))
        );
        // Negative origins clamp to the top-left corner.
        assert_eq!(
            clamp_rect(
                &tiny,
                &HitRect {
                    x: -5.0,
                    y: -3.0,
                    width: 10.0,
                    height: 4.0
                }
            ),
            Some((0, 0, 5, 1))
        );
        // Beyond the right/bottom edges clamps to the image size.
        assert_eq!(
            clamp_rect(
                &tiny,
                &HitRect {
                    x: 90.0,
                    y: 70.0,
                    width: 100.0,
                    height: 100.0
                }
            ),
            Some((90, 70, 10, 10))
        );
        // Empty/outside rectangles cover no pixel.
        assert_eq!(
            clamp_rect(
                &tiny,
                &HitRect {
                    x: 150.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0
                }
            ),
            None
        );
        assert_eq!(
            clamp_rect(
                &tiny,
                &HitRect {
                    x: 5.0,
                    y: 5.0,
                    width: 0.0,
                    height: 10.0
                }
            ),
            None
        );
        assert_eq!(
            clamp_rect(
                &tiny,
                &HitRect {
                    x: f64::NAN,
                    y: 0.0,
                    width: f64::NAN,
                    height: 10.0
                }
            ),
            None
        );
    }

    #[test]
    fn crop_image_returns_the_selected_pixels() {
        let image = pixel_image();
        let cropped = crop_image(
            &image,
            &HitRect {
                x: 2.0,
                y: 3.0,
                width: 4.0,
                height: 5.0,
            },
        )
        .unwrap();
        assert_eq!(cropped.dimensions(), (4, 5));
        assert_eq!(*cropped.get_pixel(0, 0), *image.get_pixel(2, 3));
        assert_eq!(*cropped.get_pixel(3, 4), *image.get_pixel(5, 7));
        assert!(crop_image(
            &image,
            &HitRect {
                x: 100.0,
                y: 0.0,
                width: 1.0,
                height: 1.0
            }
        )
        .is_err());
    }

    #[test]
    fn png_data_url_is_base64_encoded_png() {
        let image = pixel_image();
        let url = png_data_url(&image).unwrap();
        let encoded = url
            .strip_prefix("data:image/png;base64,")
            .expect("data URL prefix");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        // Round-trip through the image crate.
        let decoded = image::load_from_memory(&bytes).unwrap().into_rgba8();
        assert_eq!(decoded.dimensions(), (10, 10));
    }

    #[test]
    fn request_ids_are_unique_and_prefixed() {
        let first = next_request_id();
        let second = next_request_id();
        assert!(first.starts_with("capture-"));
        assert_ne!(first, second);
        assert_eq!(
            normalize_request_id(Some("frontend-1".to_string())),
            "frontend-1"
        );
        assert!(normalize_request_id(Some("   ".to_string())).starts_with("capture-"));
        assert!(normalize_request_id(None).starts_with("capture-"));
    }

    #[test]
    fn only_image_skills_are_preset_candidates() {
        let mut settings = Settings::default();
        settings.picker.custom_skills = vec![
            crate::settings::CustomSkill {
                id: "custom-text".to_string(),
                label: "文字技能".to_string(),
                icon: "star".to_string(),
                kind: "text".to_string(),
                prompt: "Explain {text}".to_string(),
            },
            crate::settings::CustomSkill {
                id: "custom-image".to_string(),
                label: "图片技能".to_string(),
                icon: "wand".to_string(),
                kind: "image".to_string(),
                prompt: "Extract {text} in {target}".to_string(),
            },
        ];
        assert!(image_skill(&settings, "custom-text").is_none());
        assert_eq!(
            image_skill(&settings, "custom-image").map(|skill| skill.label.as_str()),
            Some("图片技能")
        );
        assert!(image_skill(&settings, "custom-missing").is_none());
    }
}

/// Registers the global Win+Shift+X hotkey on a dedicated Windows message
/// thread. This is independent of the rdev input hook (which only tracks text
/// selection) and works even when no Lexora window has keyboard focus.
pub fn start_hotkey_listener(app: AppHandle) {
    let thread_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("lexora-capture-hotkey".to_string())
        .spawn(move || unsafe {
            use windows::Win32::UI::Input::KeyboardAndMouse::{
                RegisterHotKey, UnregisterHotKey, MOD_SHIFT, MOD_WIN,
            };
            use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

            const HOTKEY_ID: i32 = 0x4c58; // 'LX'
            if let Err(error) = RegisterHotKey(
                None,
                HOTKEY_ID,
                MOD_WIN | MOD_SHIFT,
                0x58, // X
            ) {
                let logger = thread_app
                    .try_state::<std::sync::Arc<AppState>>()
                    .map(|state| state.log.clone());
                if let Some(logger) = logger {
                    logger.warn(&format!(
                        "Win+Shift+X hotkey registration failed: {error:?}"
                    ));
                }
                return;
            }

            loop {
                let mut message = MSG::default();
                let result = GetMessageW(&mut message, None, 0, 0);
                if result.0 <= 0 {
                    break;
                }
                if message.message != WM_HOTKEY {
                    continue;
                }
                let app = thread_app.clone();
                tauri::async_runtime::spawn(async move {
                    let Some(state) = app.try_state::<std::sync::Arc<AppState>>() else {
                        return;
                    };
                    let state = state.inner().clone();
                    state
                        .log
                        .info("hotkey Win+Shift+X: starting screenshot capture");
                    if let Err(error) = start_capture(&app, &state, None).await {
                        state.log.warn(&format!(
                            "hotkey screenshot failed: {} / {}",
                            error.message, error.hint
                        ));
                    }
                });
            }

            let _ = UnregisterHotKey(None, HOTKEY_ID);
        });
    if let Err(error) = spawned {
        let logger = app
            .try_state::<std::sync::Arc<AppState>>()
            .map(|state| state.log.clone());
        if let Some(logger) = logger {
            logger.warn(&format!(
                "could not start screenshot hotkey thread: {error}"
            ));
        }
    }
}
