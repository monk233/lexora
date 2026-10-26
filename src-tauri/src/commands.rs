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
use serde::{Deserialize, Serialize};
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
    /// Every download currently in flight (engine + one entry per model id).
    pub downloads: Vec<DownloadProgress>,
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
        downloads: state.engine.download_state(),
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
    let previous_shortcut = state.settings.get().capture.region_shortcut;
    let settings = state.settings.update_json(patch)?;
    state.selection.apply_settings(&settings);
    state.abort_translate();
    if settings.capture.region_shortcut != previous_shortcut {
        sync_capture_hotkey(&app, &state, &settings);
    }
    crate::tray::refresh(&app);
    broadcast_state(&app, &state);
    Ok(json!({ "state": build_state(&app, &state) }))
}

#[tauri::command]
pub fn reset_settings(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let previous_shortcut = state.settings.get().capture.region_shortcut;
    let settings = state.settings.reset();
    state.selection.apply_settings(&settings);
    if settings.capture.region_shortcut != previous_shortcut {
        sync_capture_hotkey(&app, &state, &settings);
    }
    crate::tray::refresh(&app);
    broadcast_state(&app, &state);
    Ok(json!({ "state": build_state(&app, &state) }))
}

/// Keeps the registered screenshot hotkey in sync when a generic settings patch
/// (or a reset) changed `capture.regionShortcut` outside `capture_set_hotkey`.
/// The hotkey thread is the single owner of the registration, so this is a
/// cheap no-op whenever the shortcut did not change.
fn sync_capture_hotkey(
    app: &AppHandle,
    state: &Arc<AppState>,
    settings: &crate::settings::Settings,
) {
    match crate::capture::set_hotkey(app, &settings.capture.region_shortcut) {
        crate::capture::SetHotkeyOutcome::Applied {
            warning: Some(warning),
            ..
        } => state.log.warn(&warning),
        crate::capture::SetHotkeyOutcome::Failed { error, hint, .. } => {
            state
                .log
                .warn(&format!("screenshot hotkey sync failed: {error} / {hint}"));
        }
        _ => {}
    }
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
    // The engine has its own download slot; models can download in parallel.
    if state.engine.has_download("engine", "") {
        return json!({ "ok": false, "error": "引擎正在下载中，请等待完成或取消。" });
    }
    let engine = state.engine.clone();
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(state) = task_app.try_state::<Arc<AppState>>() {
            state.log.info("engine download started");
        }
        notify_changed(&task_app);
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
    // Only the same model id is blocked; other models may download in parallel.
    if state.engine.has_download("model", &id) {
        return json!({ "ok": false, "error": "该模型正在下载中，请等待完成或取消。" });
    }
    let engine = state.engine.clone();
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        notify_changed(&task_app);
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

/// Cancels one download or all of them: `id` is the model id or `engine`;
/// omitting it (or sending an empty string) cancels every active download.
#[tauri::command]
pub fn cancel_download(state: State<'_, Arc<AppState>>, id: Option<String>) -> Value {
    let wanted = id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    state.engine.cancel_download(wanted.as_deref());
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
// Update commands (§5.1)
// ---------------------------------------------------------------------------

/// Serializes [`crate::updater::UpdateInfo`] and adds the command-level `ok`
/// flag. The About page consumes `currentVersion` / `latestVersion` etc.
fn update_info_payload(info: crate::updater::UpdateInfo) -> Value {
    match serde_json::to_value(&info) {
        Ok(mut value) => {
            if let Some(object) = value.as_object_mut() {
                object.insert("ok".to_string(), json!(true));
            }
            value
        }
        Err(error) => json!({
            "ok": false,
            "error": "更新信息序列化失败。",
            "hint": format!("请重启程序后重试（{error}）。"),
        }),
    }
}

/// Checks GitHub for a newer release (About page "检查更新").
#[tauri::command]
pub async fn check_update() -> Value {
    match crate::updater::check_update().await {
        Ok(info) => update_info_payload(info),
        Err(error) => json!({
            "ok": false,
            "error": error.message,
            "hint": error.hint,
        }),
    }
}

/// Downloads and schedules the new portable exe. Progress is pushed to the
/// settings window as `update-progress`; the app exits right after this returns.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Value {
    match crate::updater::install_update(&app).await {
        Ok(info) => json!({
            "ok": true,
            "version": info.latest_version,
        }),
        Err(error) => json!({
            "ok": false,
            "error": error.message,
            "hint": error.hint,
        }),
    }
}

// ---------------------------------------------------------------------------
// Screenshot capture commands (contract §10.3)
// ---------------------------------------------------------------------------

/// Starts a region screenshot: hides our own windows, grabs every monitor,
/// pre-encodes the images and creates one **hidden** overlay window per monitor.
/// The capture page shows its overlay through `capture_ready` once painted.
#[tauri::command]
pub async fn start_capture(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    preset_skill_id: Option<String>,
) -> Result<Value, String> {
    let app_state = (*state).clone();
    match crate::capture::start_capture(&app, app_state.as_ref(), preset_skill_id).await {
        Ok(monitors) => Ok(json!({ "ok": true, "monitors": monitors })),
        Err(error) => Ok(json!({ "ok": false, "error": error.message, "hint": error.hint })),
    }
}

/// JPEG data URL + size (+ preset) of one captured monitor. The display URL was
/// pre-encoded by `start_capture`, so this never blocks on image encoding.
#[tauri::command]
pub fn capture_monitor_info(state: State<'_, Arc<AppState>>, index: u32) -> Value {
    match state.capture.monitor_info(index) {
        Ok(mut info) => {
            if let Some(object) = info.as_object_mut() {
                object.insert("ok".to_string(), json!(true));
            }
            info
        }
        Err(error) => json!({ "ok": false, "error": error.message, "hint": error.hint }),
    }
}

/// Shows the overlay window of one monitor; the capture page calls this once
/// the screenshot image has been painted (contract §10.1, no black flash).
#[tauri::command]
pub fn capture_ready(app: AppHandle, state: State<'_, Arc<AppState>>, index: u32) -> Value {
    state.capture.mark_ready(index);
    if crate::windows::show_capture_window(&app, index) {
        json!({ "ok": true })
    } else {
        json!({
            "ok": false,
            "error": "找不到截图窗口。",
            "hint": "请重新发起截图。",
        })
    }
}

/// Copies the selected screenshot region (with the annotation layer composited,
/// contract §11.4) to the clipboard and closes the overlays. `globalRect`
/// selects a cross-monitor region; without it the legacy single-monitor
/// `index` + `rect` path is used.
#[tauri::command]
pub fn capture_copy(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    index: u32,
    rect: crate::capture::HitRect,
    annotations: Option<String>,
    global_rect: Option<crate::capture::GlobalRect>,
) -> Value {
    match state
        .capture
        .copy(&app, index, &rect, annotations, global_rect.as_ref())
    {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error.message, "hint": error.hint }),
    }
}

/// Writes plain text (e.g. the colour loupe's hex value from the screenshot
/// overlay) to the system clipboard. Returns `{"ok": true}` or a Chinese error
/// payload the page can show as a toast.
#[tauri::command]
pub fn capture_copy_text(app: AppHandle, text: String) -> Value {
    match app.clipboard().write_text(text) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({
            "ok": false,
            "error": "复制到剪贴板失败。",
            "hint": format!("请重试（{error}）。"),
        }),
    }
}

/// Pins the selected region as a new always-on-top desktop window
/// (`capture_pin`, contract §11.4/§11.5). `globalRect` pins a cross-monitor
/// selection; otherwise the legacy single-monitor path is used. The annotation
/// layer is composited into the pinned image; the capture overlay is closed on
/// success.
///
/// Async on purpose: creating a webview window from a sync command would block
/// the event loop that has to build it (deadlock).
#[tauri::command]
pub async fn capture_pin(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    index: u32,
    rect: crate::capture::HitRect,
    annotations: Option<String>,
    global_rect: Option<crate::capture::GlobalRect>,
) -> Result<Value, String> {
    let image = match state
        .capture
        .crop_selection(index, &rect, annotations, global_rect.as_ref())
    {
        Ok(image) => image,
        Err(error) => {
            return Ok(json!({ "ok": false, "error": error.message, "hint": error.hint }));
        }
    };
    // Place the pin where the selection was, not at the cursor (the toolbar
    // button that triggered this sits below the selection).
    let origin = match state
        .capture
        .selection_origin(index, &rect, global_rect.as_ref())
    {
        Ok(origin) => Some(origin),
        Err(_) => None,
    };
    match crate::pin::create_pin(&app, image, origin) {
        Ok((id, width, height)) => {
            state.capture.close(&app);
            Ok(json!({ "ok": true, "id": id, "width": width, "height": height }))
        }
        Err(error) => Ok(json!({ "ok": false, "error": error.message, "hint": error.hint })),
    }
}

/// Runs a scrolling long screenshot of the selected region (contract §11.6).
/// Progress/finish events are emitted to the capture overlay
/// (`capture-longshot-progress` / `capture-longshot-done`).
#[tauri::command]
pub async fn capture_longshot(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    index: u32,
    rect: crate::capture::HitRect,
) -> Result<Value, String> {
    match state.capture.longshot(&app, index, &rect).await {
        Ok(outcome) => Ok(outcome),
        Err(error) => Ok(json!({ "ok": false, "error": error.message, "hint": error.hint })),
    }
}

/// Runs a panel skill on the selected region (contract §10.3/§11.4): crop →
/// annotations → image clipboard → remember the last capture → close the
/// overlays → show the picker result panel (`picker-image`) → stream the result
/// through `translate-event`. `globalRect` runs the skill on a cross-monitor
/// selection; otherwise the legacy single-monitor path is used.
#[tauri::command]
pub fn capture_skill(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request_id: String,
    index: u32,
    rect: crate::capture::HitRect,
    action: String,
    skill_id: Option<String>,
    target_lang: Option<String>,
    annotations: Option<String>,
    global_rect: Option<crate::capture::GlobalRect>,
) -> Value {
    match state.capture.skill(
        &app,
        index,
        &rect,
        &action,
        skill_id,
        target_lang,
        Some(request_id),
        annotations,
        global_rect.as_ref(),
    ) {
        Ok(job) => {
            let clipboard = job.clipboard();
            let app_state = (*state).clone();
            crate::capture::spawn_capture_job(app, app_state, job);
            json!({ "ok": true, "clipboard": clipboard })
        }
        Err(error) => json!({
            "ok": false,
            "clipboard": false,
            "error": error.message,
            "hint": error.hint,
        }),
    }
}

/// Re-runs the last screenshot action; the result is streamed into the panel
/// that is already open (`translate-event`). For screenshot translations
/// `targetLang` switches the target language before re-translating.
#[tauri::command]
pub fn capture_retry(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request_id: String,
    target_lang: Option<String>,
) -> Value {
    match state.capture.retry(&app, request_id, target_lang) {
        Ok(job) => {
            let app_state = (*state).clone();
            crate::capture::spawn_capture_job(app, app_state, job);
            json!({ "ok": true })
        }
        Err(error) => json!({ "ok": false, "error": error.message, "hint": error.hint }),
    }
}

/// One follow-up question about the last screenshot (contract §10.3): vision
/// actions continue with the image, OCR/translate with the recognized text.
#[tauri::command]
pub fn capture_followup(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request_id: String,
    question: String,
    previous_answer: String,
    history: Vec<FollowupTurn>,
) -> Value {
    let question = question.trim().to_string();
    if question.is_empty() {
        return json!({
            "ok": false,
            "error": "没有可回答的问题。",
            "hint": "请在结果下方的输入框中输入要继续提问的问题后再提交。",
        });
    }
    let turns: Vec<(String, String)> = history
        .into_iter()
        .map(|turn| (turn.question, turn.answer))
        .collect();
    match state.capture.followup(
        request_id,
        question,
        previous_answer.trim().to_string(),
        turns,
    ) {
        Ok(job) => {
            let app_state = (*state).clone();
            crate::capture::spawn_followup_job(app, app_state, job);
            json!({ "ok": true })
        }
        Err(error) => json!({ "ok": false, "error": error.message, "hint": error.hint }),
    }
}

/// Closes the capture overlays and forgets the session. The last capture is
/// kept so retry/follow-up still work on an open result panel (contract §10.3).
#[tauri::command]
pub fn capture_close(app: AppHandle, state: State<'_, Arc<AppState>>) -> Value {
    state.capture.close(&app);
    json!({ "ok": true })
}

/// Updates the global screenshot shortcut: normalizes, re-registers it on the
/// hotkey thread and persists the canonical value (contract §10.4).
#[tauri::command]
pub fn capture_set_hotkey(app: AppHandle, shortcut: String) -> Value {
    match crate::capture::set_hotkey(&app, &shortcut) {
        crate::capture::SetHotkeyOutcome::Applied { shortcut, warning } => match warning {
            Some(warning) => json!({ "ok": true, "shortcut": shortcut, "hint": warning }),
            None => json!({ "ok": true, "shortcut": shortcut }),
        },
        crate::capture::SetHotkeyOutcome::Failed {
            shortcut,
            error,
            hint,
        } => json!({
            "ok": false,
            "shortcut": shortcut,
            "error": error,
            "hint": hint,
        }),
    }
}

// ---------------------------------------------------------------------------
// Pinned desktop windows (contract §11.5)
// ---------------------------------------------------------------------------

/// PNG data URL + physical size of a pinned image; `pin.html` calls this after
/// loading (contract §11.5). The PNG is encoded on a blocking worker because a
/// long-screenshot pin can be very large.
#[tauri::command]
pub async fn pin_ready(id: u64) -> Value {
    let encoded = tauri::async_runtime::spawn_blocking(move || crate::pin::ready(id)).await;
    match encoded {
        Ok(Ok(mut info)) => {
            if let Some(object) = info.as_object_mut() {
                object.insert("ok".to_string(), json!(true));
            }
            info
        }
        Ok(Err(error)) => json!({ "ok": false, "error": error.message, "hint": error.hint }),
        Err(error) => json!({
            "ok": false,
            "error": "读取钉图失败。",
            "hint": format!("请重试；若问题持续请重启程序（{error}）。"),
        }),
    }
}

/// Moves a pinned window by a logical-pixel delta, clamped into the work area.
#[tauri::command]
pub fn pin_drag(app: AppHandle, id: u64, dx: f64, dy: f64) -> Value {
    match crate::pin::drag(&app, id, dx, dy) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error.message, "hint": error.hint }),
    }
}

/// Resizes a pinned window from the mouse wheel (zoom, 15% minimum; contract
/// §11.5). Returns the applied zoom, the window size and whether it scrolls.
#[tauri::command]
pub fn pin_zoom(app: AppHandle, id: u64, zoom: f64) -> Value {
    match crate::pin::zoom(&app, id, zoom) {
        Ok(payload) => payload,
        Err(error) => json!({ "ok": false, "error": error.message, "hint": error.hint }),
    }
}

/// Runs a panel skill (OCR / translate / explain / custom image skill) on the
/// pinned image, optionally with the pin editor's annotation layer
/// (`pin_skill`, contract §11.5). The result streams into the picker panel.
#[tauri::command]
pub fn pin_skill(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: u64,
    request_id: String,
    action: String,
    skill_id: Option<String>,
    target_lang: Option<String>,
    annotations: Option<String>,
) -> Value {
    match crate::pin::skill(
        &app,
        state.inner().as_ref(),
        id,
        &action,
        skill_id,
        target_lang,
        Some(request_id),
        annotations,
    ) {
        Ok(job) => {
            let clipboard = job.clipboard();
            let app_state = (*state).clone();
            crate::capture::spawn_capture_job(app, app_state, job);
            json!({ "ok": true, "clipboard": clipboard })
        }
        Err(error) => json!({
            "ok": false,
            "clipboard": false,
            "error": error.message,
            "hint": error.hint,
        }),
    }
}

/// Composites the pin editor's annotations into the pinned image; `apply`
/// replaces the pinned image (returning the new PNG), otherwise the result is
/// only copied to the clipboard (`pin_export_annotations`, contract §11.5).
#[tauri::command]
pub fn pin_export_annotations(
    app: AppHandle,
    id: u64,
    annotations: Option<String>,
    apply: bool,
) -> Value {
    match crate::pin::export_annotations(&app, id, annotations, apply) {
        Ok(payload) => payload,
        Err(error) => json!({ "ok": false, "error": error.message, "hint": error.hint }),
    }
}

/// Grows (or restores) a pinned window so the edit-mode toolbar floats outside
/// the image (contract §11.5). `toolbar_height`/`toolbar_width` are logical
/// pixels: the window grows by the strip height and is widened to the
/// single-row toolbar width. The reply carries `topPadding`/`leftPadding` for
/// the renderer (and `clamped` when the work area limited the width).
#[tauri::command]
pub fn pin_edit_window(
    app: AppHandle,
    id: u64,
    editing: bool,
    toolbar_height: f64,
    toolbar_width: f64,
) -> Value {
    match crate::pin::edit_window(&app, id, editing, toolbar_height, toolbar_width) {
        Ok(payload) => payload,
        Err(error) => json!({ "ok": false, "error": error.message, "hint": error.hint }),
    }
}

/// Writes the pinned image to the system clipboard.
#[tauri::command]
pub fn pin_copy(app: AppHandle, id: u64) -> Value {
    match crate::pin::copy(&app, id) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error.message, "hint": error.hint }),
    }
}

/// Destroys the pinned window, forgets its image and emits `pin-close`.
#[tauri::command]
pub fn pin_close(app: AppHandle, id: u64) -> Value {
    crate::pin::close(&app, id);
    json!({ "ok": true })
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

/// Persists the "pin panel" preference so the picker can restore it later.
fn persist_panel_pinned(
    settings: &crate::settings::SettingsStore,
    pinned: bool,
) -> Result<crate::settings::Settings, String> {
    settings.update_json(json!({ "picker": { "panelPinned": pinned } }))
}

/// Pins the picker panel at runtime; with `remember == Some(true)` the
/// preference is also written to settings. A persistence failure keeps the
/// runtime pin and only reports the error.
#[tauri::command]
pub fn picker_pin(state: State<'_, Arc<AppState>>, pinned: bool, remember: Option<bool>) -> Value {
    state.selection.set_panel_pinned(pinned);
    let mut error: Option<String> = None;
    if remember == Some(true) {
        match persist_panel_pinned(&state.settings, pinned) {
            Ok(updated) => state.selection.apply_settings(&updated),
            Err(message) => error = Some(format!("保存固定面板偏好失败：{message}")),
        }
    }
    match error {
        Some(message) => json!({
            "ok": false,
            "pinned": state.selection.is_panel_pinned(),
            "error": message,
        }),
        None => json!({ "ok": true, "pinned": state.selection.is_panel_pinned() }),
    }
}

/// Tells the shell whether a tool panel is currently open. While open, the
/// global input hook no longer dismisses the picker (sticky panel).
#[tauri::command]
pub fn picker_panel_state(state: State<'_, Arc<AppState>>, open: bool) -> Value {
    state.selection.set_panel_open(open);
    json!({ "ok": true })
}

/// Makes the picker focusable so the follow-up input can receive keyboard
/// input, and returns it to non-activating mode when the panel closes.
#[tauri::command]
pub fn picker_activate(app: AppHandle, active: bool) -> Value {
    let Some(window) = app.get_webview_window(crate::windows::PICKER_LABEL) else {
        return json!({ "ok": false });
    };
    if active {
        if window.set_focusable(true).is_err() || window.set_focus().is_err() {
            return json!({ "ok": false });
        }
    } else if window.set_focusable(false).is_err() {
        return json!({ "ok": false });
    }
    json!({ "ok": true })
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

/// Streams a summarize/explain request through the same `translate-event`
/// channel as translation. Returns immediately; chunks/errors/done are emitted
/// to the picker window so every AI result in the UI is rendered as a stream.
#[tauri::command]
pub fn picker_assist(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request_id: String,
    action: String,
    text: String,
) -> Value {
    let action = action.trim().to_ascii_lowercase();
    if action != "summarize" && action != "explain" {
        return json!({ "ok": false, "error": "不支持的操作。" });
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return json!({
            "ok": false,
            "error": "没有可处理的文本。",
            "hint": "请先选中一段文字。",
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

        match engine.assist_stream(&action, &text).await {
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

/// One Q/A turn of the picker's follow-up thread (frontend `history` items).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowupTurn {
    pub question: String,
    pub answer: String,
}

/// Streams a follow-up question about the original selection and the previous
/// answer through the same `translate-event` channel as translation; the picker
/// appends the streamed answer below the previous result.
#[tauri::command]
pub fn picker_followup(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request_id: String,
    text: String,
    previous_answer: String,
    question: String,
    history: Vec<FollowupTurn>,
) -> Value {
    let question = question.trim().to_string();
    if question.is_empty() {
        return json!({
            "ok": false,
            "error": "没有可回答的问题。",
            "hint": "请在结果下方的输入框中输入要继续提问的问题后再提交。",
        });
    }
    let text = text.trim().to_string();
    let previous_answer = previous_answer.trim().to_string();
    let turns: Vec<(String, String)> = history
        .into_iter()
        .map(|turn| (turn.question, turn.answer))
        .collect();

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
            .followup_stream(&text, &previous_answer, &question, &turns)
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

#[cfg(test)]
mod tests {
    use super::persist_panel_pinned;

    #[test]
    fn pin_preference_is_persisted_through_settings() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("settings.json");
        let store = crate::settings::SettingsStore::load(file.clone());
        assert!(!store.get().picker.panel_pinned);

        let updated = persist_panel_pinned(&store, true).unwrap();
        assert!(updated.picker.panel_pinned);
        assert!(store.get().picker.panel_pinned);
        let reloaded = crate::settings::SettingsStore::load(file.clone());
        assert!(reloaded.get().picker.panel_pinned);

        let cleared = persist_panel_pinned(&store, false).unwrap();
        assert!(!cleared.picker.panel_pinned);
        let reloaded = crate::settings::SettingsStore::load(file);
        assert!(!reloaded.get().picker.panel_pinned);
    }
}
