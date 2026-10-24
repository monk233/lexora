//! Tauri commands exposed to the settings and picker webviews.
//!
//! Contract: `docs/contracts.md` §5.1 (settings window), §5.2 (picker window),
//! §5.3 (events) and §5.4 (`StatePayload`).
//!
//! Every long-running operation (translation stream, downloads, local engine)
//! is spawned on the Tauri async runtime and reports progress through events, so
//! the commands themselves return quickly and the webviews never block.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::engine::{CatalogEntry, DownloadProgress, EngineStatus, ModelInfo, TestResult};
use crate::settings::Settings;
use crate::state::{lock, AppState, TranslateTask};

// ---------------------------------------------------------------------------
// StatePayload (§5.4)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub platform: String,
    pub packaged: bool,
    pub portable: bool,
    pub data_dir: String,
    pub models_dir: String,
    pub logs_dir: String,
    pub repo_url: String,
    pub license: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePayload {
    pub app: AppInfo,
    pub settings: Settings,
    /// Built-in English default prompts for the skill customization UI.
    pub prompt_defaults: serde_json::Value,
    pub engine: EngineStatus,
    pub models: Vec<ModelInfo>,
    pub catalog: Vec<CatalogEntry>,
    pub download: Option<DownloadProgress>,
    pub picker: PickerRuntime,
    pub login_item: LoginItemState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerRuntime {
    pub visible: bool,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginItemState {
    pub supported: bool,
    pub enabled: bool,
}

/// `PORTABLE_EXECUTABLE_DIR` is used by portable launchers; a plain Lexora
/// zip has no such variable, so autostart stays available unless it is set.
pub fn portable_mode() -> bool {
    std::env::var_os("PORTABLE_EXECUTABLE_DIR").is_some()
}

pub fn build_state(app: &AppHandle, state: &AppState) -> StatePayload {
    let settings = state.settings.get();
    let login_supported = !portable_mode();
    let login_enabled = if login_supported {
        crate::autostart::is_enabled()
    } else {
        false
    };
    StatePayload {
        app: AppInfo {
            name: "Lexora".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            platform: std::env::consts::OS.to_string(),
            packaged: !cfg!(debug_assertions),
            portable: portable_mode(),
            data_dir: state.paths.data_dir.to_string_lossy().to_string(),
            models_dir: state.paths.models_dir.to_string_lossy().to_string(),
            logs_dir: state.paths.logs_dir.to_string_lossy().to_string(),
            repo_url: "https://github.com/monk233/lexora".to_string(),
            license: "MIT".to_string(),
        },
        settings,
        prompt_defaults: crate::engine::default_prompts(),
        engine: state.engine.status(),
        models: state.engine.installed_models(),
        catalog: state.engine.catalog(),
        download: state.engine.download_state(),
        picker: PickerRuntime {
            visible: crate::windows::is_picker_visible(app),
            pinned: state.selection.is_panel_pinned(),
        },
        login_item: LoginItemState {
            supported: login_supported,
            enabled: login_enabled,
        },
    }
}

/// Pushes a fresh `StatePayload` to the settings window.
pub fn broadcast_state(app: &AppHandle, state: &AppState) {
    if state.is_quitting() {
        return;
    }
    let payload = build_state(app, state);
    let _ = app.emit_to(crate::windows::SETTINGS_LABEL, "state-changed", payload);
}

fn toast(app: &AppHandle, kind: &str, message: impl Into<String>) {
    let _ = app.emit_to(
        crate::windows::SETTINGS_LABEL,
        "toast",
        json!({ "type": kind, "message": message.into() }),
    );
}

/// Refreshes tray + settings UI after anything that changes the app state.
fn notify_changed(app: &AppHandle) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        crate::tray::refresh(app);
        broadcast_state(app, &state);
    }
}

fn active_download(state: &AppState) -> bool {
    state
        .engine
        .download_state()
        .map(|progress| progress.status == "downloading" || progress.status == "verifying")
        .unwrap_or(false)
}

fn normalize_program_name(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim()
        .to_ascii_lowercase()
        .trim_end_matches(".exe")
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// Settings window commands (§5.1)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_state(app: AppHandle, state: State<'_, Arc<AppState>>) -> StatePayload {
    build_state(&app, &state)
}

#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    patch: Value,
) -> Result<Value, String> {
    let settings = state.settings.update_json(patch)?;
    state.selection.apply_settings(&settings);
    state.abort_translate();
    crate::tray::refresh(&app);
    broadcast_state(&app, &state);
    Ok(json!({ "state": build_state(&app, &state) }))
}

#[tauri::command]
pub fn reset_settings(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let settings = state.settings.reset();
    state.selection.apply_settings(&settings);
    crate::tray::refresh(&app);
    broadcast_state(&app, &state);
    Ok(json!({ "state": build_state(&app, &state) }))
}

#[tauri::command]
pub async fn test_online(
    state: State<'_, Arc<AppState>>,
    base_url: String,
    api_key: String,
    model: String,
    timeout_ms: Option<u64>,
) -> Result<TestResult, String> {
    let timeout = timeout_ms.unwrap_or(60_000);
    Ok(state
        .engine
        .test_online(&base_url, &api_key, &model, timeout)
        .await)
}

#[tauri::command]
pub async fn list_online_models(
    state: State<'_, Arc<AppState>>,
    base_url: String,
    api_key: String,
) -> Result<Value, String> {
    match state.engine.list_online_models(&base_url, &api_key).await {
        Ok(models) => Ok(json!({ "ok": true, "models": models })),
        Err(error) => Ok(json!({
            "ok": false,
            "models": [],
            "error": error.message,
            "hint": error.hint,
        })),
    }
}

/// Starts the llama.cpp engine download in the background. Progress is pushed
/// by the engine through `download-progress` events.
#[tauri::command]
pub fn download_engine(app: AppHandle, state: State<'_, Arc<AppState>>) -> Value {
    if state.engine.engine_installed() {
        return json!({ "ok": true, "installed": true });
    }
    if active_download(&state) {
        return json!({ "ok": false, "error": "已有下载任务正在进行，请等待完成或取消。" });
    }
    let engine = state.engine.clone();
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(state) = task_app.try_state::<Arc<AppState>>() {
            state.log.info("engine download started");
        }
        match engine.install_engine(task_app.clone()).await {
            Ok(()) => {
                toast(
                    &task_app,
                    "success",
                    "llama.cpp 引擎安装完成，可以下载并启动本地模型了。",
                );
            }
            Err(error) => {
                toast(
                    &task_app,
                    "error",
                    format!("引擎下载失败：{}", error.message),
                );
                if let Some(state) = task_app.try_state::<Arc<AppState>>() {
                    state.log.error(&format!(
                        "engine install failed: {} / {}",
                        error.message, error.hint
                    ));
                }
            }
        }
        notify_changed(&task_app);
    });
    json!({ "ok": true })
}

#[tauri::command]
pub fn download_model(app: AppHandle, state: State<'_, Arc<AppState>>, id: String) -> Value {
    let id = id.trim().to_string();
    if id.is_empty() {
        return json!({ "ok": false, "error": "缺少模型标识。" });
    }
    if active_download(&state) {
        return json!({ "ok": false, "error": "已有下载任务正在进行，请等待完成或取消。" });
    }
    let engine = state.engine.clone();
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        match engine.download_model(task_app.clone(), &id).await {
            Ok(model) => {
                toast(&task_app, "success", format!("模型已安装：{}", model.name));
            }
            Err(error) => {
                toast(
                    &task_app,
                    "error",
                    format!("模型下载失败：{}", error.message),
                );
                if let Some(state) = task_app.try_state::<Arc<AppState>>() {
                    state.log.error(&format!(
                        "model download failed: {} / {}",
                        error.message, error.hint
                    ));
                }
            }
        }
        notify_changed(&task_app);
    });
    json!({ "ok": true })
}

#[tauri::command]
pub fn cancel_download(state: State<'_, Arc<AppState>>) -> Value {
    state.engine.cancel_download();
    json!({ "ok": true })
}

/// Opens the native `.gguf` file picker, then imports the chosen file.
#[tauri::command]
pub async fn import_model(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("选择 GGUF 模型文件")
            .add_filter("GGUF 模型", &["gguf"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| format!("打开文件对话框失败：{error}"))?;

    let Some(file_path) = picked else {
        return Ok(json!({ "ok": false, "cancelled": true, "error": "已取消选择模型文件。" }));
    };
    let path: PathBuf = file_path
        .into_path()
        .map_err(|error| format!("无法读取所选文件路径：{error}"))?;

    match state.engine.import_model(path).await {
        Ok(model) => {
            toast(&app, "success", format!("模型已导入：{}", model.name));
            notify_changed(&app);
            Ok(json!({ "ok": true, "model": model }))
        }
        Err(error) => Ok(json!({
            "ok": false,
            "error": error.message,
            "hint": error.hint,
        })),
    }
}

#[tauri::command]
pub fn remove_model(app: AppHandle, state: State<'_, Arc<AppState>>, file: String) -> Value {
    match state.engine.remove_model(&file) {
        Ok(()) => {
            notify_changed(&app);
            json!({ "ok": true })
        }
        Err(error) => json!({
            "ok": false,
            "error": error.message,
            "hint": error.hint,
        }),
    }
}

#[tauri::command]
pub async fn start_local(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    match state.engine.start_local().await {
        Ok(()) => {
            notify_changed(&app);
            Ok(json!({ "ok": true }))
        }
        Err(error) => {
            notify_changed(&app);
            Ok(json!({
                "ok": false,
                "error": error.message,
                "hint": error.hint,
            }))
        }
    }
}

#[tauri::command]
pub async fn stop_local(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    match state.engine.stop_local().await {
        Ok(()) => {
            notify_changed(&app);
            Ok(json!({ "ok": true }))
        }
        Err(error) => {
            notify_changed(&app);
            Ok(json!({
                "ok": false,
                "error": error.message,
                "hint": error.hint,
            }))
        }
    }
}

#[tauri::command]
pub fn open_dir(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    which: String,
) -> Result<Value, String> {
    let path = match which.trim() {
        "models" => state.paths.models_dir.clone(),
        "logs" => state.paths.logs_dir.clone(),
        "engine" => state.paths.engine_dir.clone(),
        _ => state.paths.data_dir.clone(),
    };
    let _ = std::fs::create_dir_all(&path);
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| format!("无法打开目录 {}：{error}", path.display()))?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<Value, String> {
    let url = url.trim().to_string();
    if !url.to_ascii_lowercase().starts_with("https://") {
        return Err("仅允许打开 https 链接。".to_string());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("无法打开链接：{error}"))?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn set_start_at_login(app: AppHandle, state: State<'_, Arc<AppState>>, enabled: bool) -> Value {
    if portable_mode() {
        return json!({
            "ok": false,
            "error": "便携版不支持开机自启。请把 Lexora 放到固定目录，或在启动文件夹中手动创建快捷方式。",
        });
    }
    let result = crate::autostart::set_enabled(enabled);
    if let Err(error) = result {
        return json!({
            "ok": false,
            "error": format!("设置开机自启失败：{error}"),
        });
    }
    if let Err(error) = state
        .settings
        .update_json(json!({ "app": { "startAtLogin": enabled } }))
    {
        return json!({ "ok": false, "error": error });
    }
    notify_changed(&app);
    json!({ "ok": true })
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        if state.is_quitting() {
            return;
        }
        state.set_quitting();
        state.log.info("quit requested by UI");
    }
    // Give the IPC response and the log flush a moment, then exit.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        app.exit(0);
    });
}

// ---------------------------------------------------------------------------
// Picker window commands (§5.2)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn picker_ready(app: AppHandle) -> Value {
    if let Some(data) = crate::windows::take_pending() {
        let _ = app.emit_to(crate::windows::PICKER_LABEL, "picker-data", data);
    }
    json!({ "ok": true })
}

#[tauri::command]
pub fn picker_close(app: AppHandle) -> Value {
    crate::windows::hide_picker(&app);
    json!({ "ok": true })
}

#[tauri::command]
pub fn picker_pin(state: State<'_, Arc<AppState>>, pinned: bool) -> Value {
    state.selection.set_panel_pinned(pinned);
    json!({ "ok": true, "pinned": state.selection.is_panel_pinned() })
}

#[tauri::command]
pub fn picker_resize(app: AppHandle, width: Option<f64>, height: Option<f64>) -> Option<Value> {
    crate::windows::resize_picker(&app, width.unwrap_or(440.0), height.unwrap_or(56.0))
}

/// Moves the picker window by a logical-pixel delta (dragging the result panel).
#[tauri::command]
pub fn picker_drag_panel(app: AppHandle, dx: f64, dy: f64) -> Value {
    match crate::windows::move_picker_by(&app, dx, dy) {
        Some((x, y)) => json!({ "ok": true, "x": x, "y": y }),
        None => json!({ "ok": false }),
    }
}

#[tauri::command]
pub async fn picker_copy(app: AppHandle, text: String) -> Result<Value, String> {
    match app.clipboard().write_text(text) {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(error) => Ok(json!({ "ok": false, "error": format!("复制到剪贴板失败：{error}") })),
    }
}

#[tauri::command]
pub fn picker_open_settings(app: AppHandle) -> Value {
    crate::windows::show_settings(&app);
    json!({ "ok": true })
}

/// Starts a streaming translation. Returns immediately; the stream itself is
/// pushed through `translate-event` events targeted at the picker window.
#[tauri::command]
pub fn picker_translate(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request_id: String,
    text: String,
    target_lang: String,
) -> Value {
    let text = text.trim().to_string();
    if text.is_empty() {
        return json!({
            "ok": false,
            "error": "没有可翻译的文本。",
            "hint": "请先选中一段文字，然后再点击翻译。",
        });
    }

    // Only one stream at a time: abort the previous request.
    state.abort_translate();

    let engine = state.engine.clone();
    let task_app = app.clone();
    let rid = request_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let emit = |payload: Value| {
            let _ = task_app.emit_to(crate::windows::PICKER_LABEL, "translate-event", payload);
        };

        match engine.translate_stream(&text, &target_lang).await {
            Ok(mut stream) => {
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(chunk) => {
                            if chunk.is_empty() {
                                continue;
                            }
                            emit(json!({
                                "requestId": rid.clone(),
                                "type": "chunk",
                                "text": chunk,
                            }));
                        }
                        Err(error) => {
                            emit(json!({
                                "requestId": rid.clone(),
                                "type": "error",
                                "message": error.message,
                            }));
                            return;
                        }
                    }
                }
                emit(json!({
                    "requestId": rid.clone(),
                    "type": "done",
                }));
            }
            Err(error) => {
                emit(json!({
                    "requestId": rid.clone(),
                    "type": "error",
                    "message": error.message,
                }));
            }
        }
    });

    *lock(&state.translate_task) = Some(TranslateTask { request_id, handle });
    json!({ "ok": true })
}

/// Streams a polish (rewriting) request. Same event contract as
/// [`picker_translate`]: all chunks, errors and the final `done` event are
/// pushed through the picker's `translate-event` channel.
#[tauri::command]
pub fn picker_polish(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request_id: String,
    text: String,
) -> Value {
    let text = text.trim().to_string();
    if text.is_empty() {
        return json!({
            "ok": false,
            "error": "没有可润色的文本。",
            "hint": "请先选中一段文字，然后再点击润色。",
        });
    }

    // Only one stream at a time: abort the previous request.
    state.abort_translate();

    let engine = state.engine.clone();
    let task_app = app.clone();
    let rid = request_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let emit = |payload: Value| {
            let _ = task_app.emit_to(crate::windows::PICKER_LABEL, "translate-event", payload);
        };

        match engine.polish_stream(&text).await {
            Ok(mut stream) => {
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(chunk) => {
                            if chunk.is_empty() {
                                continue;
                            }
                            emit(json!({
                                "requestId": rid.clone(),
                                "type": "chunk",
                                "text": chunk,
                            }));
                        }
                        Err(error) => {
                            emit(json!({
                                "requestId": rid.clone(),
                                "type": "error",
                                "message": error.message,
                            }));
                            return;
                        }
                    }
                }
                emit(json!({
                    "requestId": rid.clone(),
                    "type": "done",
                }));
            }
            Err(error) => {
                emit(json!({
                    "requestId": rid.clone(),
                    "type": "error",
                    "message": error.message,
                }));
            }
        }
    });

    *lock(&state.translate_task) = Some(TranslateTask { request_id, handle });
    json!({ "ok": true })
}

/// Streams a user-defined skill (`picker.customSkills`) through the same
/// `translate-event` channel as [`picker_translate`]: chunk/error/done events
/// carry the same payload shape, so the picker UI reuses one renderer.
#[tauri::command]
pub fn picker_custom_skill(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request_id: String,
    skill_id: String,
    text: String,
    program_name: String,
) -> Value {
    let text = text.trim().to_string();
    if text.is_empty() {
        return json!({
            "ok": false,
            "error": "没有可翻译的文本。",
            "hint": "请先选中一段文字，然后再点击翻译。",
        });
    }
    let skill_id = skill_id.trim().to_string();
    // Custom skills follow the picker's default target language; there is no
    // per-request target on this command (the toolbar has one target setting).
    let target_lang = state.settings.get().picker.default_target_lang;

    // Only one stream at a time: abort the previous request.
    state.abort_translate();

    let engine = state.engine.clone();
    let task_app = app.clone();
    let rid = request_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let emit = |payload: Value| {
            let _ = task_app.emit_to(crate::windows::PICKER_LABEL, "translate-event", payload);
        };

        match engine
            .custom_stream(&skill_id, &text, &target_lang, &program_name)
            .await
        {
            Ok(mut stream) => {
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(chunk) => {
                            if chunk.is_empty() {
                                continue;
                            }
                            emit(json!({
                                "requestId": rid.clone(),
                                "type": "chunk",
                                "text": chunk,
                            }));
                        }
                        Err(error) => {
                            emit(json!({
                                "requestId": rid.clone(),
                                "type": "error",
                                "message": error.message,
                            }));
                            return;
                        }
                    }
                }
                emit(json!({
                    "requestId": rid.clone(),
                    "type": "done",
                }));
            }
            Err(error) => {
                emit(json!({
                    "requestId": rid.clone(),
                    "type": "error",
                    "message": error.message,
                }));
            }
        }
    });

    *lock(&state.translate_task) = Some(TranslateTask { request_id, handle });
    json!({ "ok": true })
}

#[tauri::command]
pub fn picker_abort_translate(state: State<'_, Arc<AppState>>, request_id: String) -> Value {
    let mut guard = lock(&state.translate_task);
    let matches_current = guard
        .as_ref()
        .map(|task| task.request_id == request_id)
        .unwrap_or(false);
    if matches_current {
        if let Some(task) = guard.take() {
            task.handle.abort();
        }
    }
    json!({ "ok": true })
}

#[tauri::command]
pub async fn picker_assist(
    state: State<'_, Arc<AppState>>,
    action: String,
    text: String,
) -> Result<Value, String> {
    let action = action.trim().to_ascii_lowercase();
    if action != "summarize" && action != "explain" {
        return Ok(json!({ "ok": false, "error": "不支持的操作。" }));
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(json!({
            "ok": false,
            "error": "没有可处理的文本。",
            "hint": "请先选中一段文字。",
        }));
    }
    Ok(match state.engine.assist(&action, &text).await {
        Ok(result) => json!({ "ok": true, "text": result }),
        Err(error) => json!({
            "ok": false,
            "error": error.message,
            "hint": error.hint,
        }),
    })
}

#[tauri::command]
pub fn picker_status(state: State<'_, Arc<AppState>>) -> Value {
    let settings = state.settings.get();
    let status = state.engine.status();
    let configured = if settings.is_local_mode() {
        status.engine_available
    } else {
        status.online_configured
    };
    json!({
        "mode": status.mode,
        "ready": status.ready,
        "configured": configured,
        "providerLabel": status.provider_label,
        "localState": status.local_state,
        "hint": status.hint,
    })
}

#[tauri::command]
pub fn picker_disable_in_app(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    program_name: String,
) -> Value {
    let program_name = program_name.trim().to_string();
    if program_name.is_empty() {
        return json!({ "ok": false, "error": "无法识别当前应用名称，暂时不能禁用。" });
    }
    let settings = state.settings.get();
    let mut blacklist = settings.picker.blacklist.clone();
    let normalized = normalize_program_name(&program_name);
    let already = blacklist
        .iter()
        .any(|entry| normalize_program_name(entry) == normalized);
    if !already {
        blacklist.push(program_name);
    }
    match state
        .settings
        .update_json(json!({ "picker": { "blacklist": blacklist } }))
    {
        Ok(updated) => {
            state.selection.apply_settings(&updated);
            notify_changed(&app);
            json!({ "ok": true })
        }
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
pub fn picker_disable_tool(app: AppHandle, state: State<'_, Arc<AppState>>) -> Value {
    match state
        .settings
        .update_json(json!({ "picker": { "enabled": false } }))
    {
        Ok(updated) => {
            state.selection.apply_settings(&updated);
            crate::windows::hide_picker(&app);
            notify_changed(&app);
            toast(
                &app,
                "info",
                "划词工具已禁用，可在托盘菜单或设置中重新启用。",
            );
            json!({ "ok": true })
        }
        Err(error) => json!({ "ok": false, "error": error }),
    }
}
