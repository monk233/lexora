//! Translation engine: online (OpenAI-compatible HTTP) and local (llama.cpp).
//!
//! Public surface used by the shell. Internal helpers (HTTP client, llama-server
//! process manager, model catalog/downloader) live under `engine/` and are owned
//! by this module:
//!
//! * [`openai`] — URL normalization, SSE decoding, request execution and
//!   Chinese error mapping;
//! * [`llama`] — local `llama-server.exe` process manager + state machine;
//! * [`models`] — GGUF catalog, directory scanning and file-name safety;
//! * [`prompts`] — translation / summarize / explain / polish and custom-skill
//!   prompt construction.
//!
//! Streaming downloads emit `download-progress` events roughly every 200 ms and
//! can be cancelled with [`EngineService::cancel_download`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use futures_util::stream::{BoxStream, Stream, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::pin::Pin;
use std::task::{Context, Poll};
use tauri::Emitter;

use crate::logger::Logger;
use crate::paths::AppPaths;
use crate::settings::{Settings, SettingsStore};

pub mod hardware;
mod llama;
pub(crate) mod models;
mod openai;
mod prompts;

pub use llama::LocalState;
pub use prompts::{
    default_prompts, render_image_prompt, resolve_target_lang, DEFAULT_EXPLAIN_IMAGE_PROMPT,
    DEFAULT_OCR_PROMPT,
};

/// Pinned llama.cpp Windows CPU release used when the user installs the engine.
/// Verified to exist and to contain `llama-server.exe`; the archive is ~23 MB.
pub const ENGINE_DOWNLOAD_URL: &str =
    "https://github.com/ggml-org/llama.cpp/releases/download/b11851/llama-b11851-bin-win-cpu-x64.zip";

/// Optional environment override for the engine archive URL.
pub const ENV_LLAMA_URL: &str = "LEXORA_LLAMA_URL";
/// Optional runtime override for the online API key (§4 of the contract).
pub const ENV_API_KEY: &str = "LEXORA_API_KEY";

/// Event name used for both model and engine download progress.
const DOWNLOAD_EVENT: &str = "download-progress";
/// UI updates are throttled; state snapshots are updated for every chunk.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
/// A download must at least reach the response headers / deliver a chunk within
/// these windows, otherwise it is treated as a dead connection.
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(120);
/// Local requests have no total timeout (model prefill can be slow on CPUs), so
/// only the "waiting for headers" phase is bounded.
const LOCAL_HEADER_TIMEOUT_MS: u64 = 300_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineError {
    pub message: String,
    pub hint: String,
}

impl EngineError {
    pub fn new(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            hint: hint.into(),
        }
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for EngineError {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub mode: String,
    pub ready: bool,
    pub hint: String,
    pub provider_label: String,
    pub online_configured: bool,
    pub local_state: String,
    pub local_model_file: String,
    pub local_model_name: String,
    pub local_error: String,
    pub engine_available: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub models: Vec<String>,
    pub model: String,
    pub error: String,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub file: String,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified_at: u64,
    pub catalog_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub filename: String,
    pub size_bytes: u64,
    pub license: String,
    pub languages: String,
    pub recommended: bool,
    pub installed: bool,
    /// `true` for Qwen3.5 multimodal variants that require a projector.
    pub vision: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub kind: String,
    pub id: String,
    pub filename: String,
    pub received: u64,
    pub total: u64,
    pub percent: f64,
    pub status: String,
    pub error: String,
}

/// Registry key of the llama.cpp engine download.
const ENGINE_DOWNLOAD_KEY: &str = "engine";

/// One in-flight download: latest progress snapshot plus its own cancel flag.
struct ActiveDownload {
    progress: DownloadProgress,
    cancel: Arc<AtomicBool>,
}

/// Shared download bookkeeping. Several downloads may run at the same time:
/// the engine plus one per model id. Keys are `engine` and `model:<id>`.
#[derive(Default)]
struct DownloadState {
    tasks: HashMap<String, ActiveDownload>,
}

/// Registry key for a download (`engine` or `model:<id>`).
fn download_key(kind: &str, id: &str) -> String {
    if kind == "engine" {
        ENGINE_DOWNLOAD_KEY.to_string()
    } else {
        format!("model:{id}")
    }
}

/// Snapshot of the active downloads, sorted by registry key (`engine` first,
/// then models by id) so the settings UI always sees a stable order.
fn download_list(state: &DownloadState) -> Vec<DownloadProgress> {
    let mut entries: Vec<(&String, &DownloadProgress)> = state
        .tasks
        .iter()
        .map(|(key, task)| (key, &task.progress))
        .collect();
    entries.sort_by(|left, right| left.0.cmp(right.0));
    entries
        .into_iter()
        .map(|(_, progress)| progress.clone())
        .collect()
}

/// Error returned when the same engine/model download is already running.
fn duplicate_download_error(kind: &str) -> EngineError {
    if kind == "engine" {
        EngineError::new("引擎正在下载中。", "请等待当前下载完成，或先取消后再试。")
    } else {
        EngineError::new("该模型正在下载中。", "请等待当前下载完成，或先取消后再试。")
    }
}

/// Reserves a slot in the download registry. Fails when the same id is already
/// running; different ids may download concurrently. The caller owns the
/// returned cancel token and must drop its [`DownloadReporter`] to free the slot.
fn reserve_download(
    state: &Mutex<DownloadState>,
    kind: &str,
    id: &str,
    filename: &str,
    total: u64,
) -> Result<(String, Arc<AtomicBool>, DownloadProgress), EngineError> {
    let key = download_key(kind, id);
    let mut guard = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.tasks.contains_key(&key) {
        return Err(duplicate_download_error(kind));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let progress = DownloadProgress {
        kind: kind.to_string(),
        id: id.to_string(),
        filename: filename.to_string(),
        received: 0,
        total,
        percent: 0.0,
        status: "downloading".to_string(),
        error: String::new(),
    };
    guard.tasks.insert(
        key.clone(),
        ActiveDownload {
            progress: progress.clone(),
            cancel: cancel.clone(),
        },
    );
    Ok((key, cancel, progress))
}

/// Marks matching downloads as cancelled. `id = None` (or an empty/blank id)
/// cancels every task; `Some("engine")` only the engine and `Some(model_id)`
/// only that model. Returns the cancelled registry keys, sorted.
fn cancel_tasks(state: &Mutex<DownloadState>, id: Option<&str>) -> Vec<String> {
    let wanted = id.map(str::trim).filter(|value| !value.is_empty());
    let guard = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut cancelled: Vec<String> = Vec::new();
    for (key, task) in &guard.tasks {
        let matches = match wanted {
            None => true,
            Some("engine") => key.as_str() == ENGINE_DOWNLOAD_KEY,
            Some(model_id) => key.as_str() == format!("model:{model_id}"),
        };
        if matches {
            task.cancel.store(true, Ordering::SeqCst);
            cancelled.push(key.clone());
        }
    }
    cancelled.sort();
    cancelled
}

/// Emits throttled `download-progress` events and keeps the registry snapshot
/// in sync. Dropping the reporter removes its entry, so finished/cancelled
/// downloads disappear from [`EngineService::download_state`].
struct DownloadReporter<'a> {
    app: &'a tauri::AppHandle,
    state: &'a Mutex<DownloadState>,
    key: String,
    progress: DownloadProgress,
    cancel: Arc<AtomicBool>,
    last_emit: Instant,
}

impl<'a> DownloadReporter<'a> {
    /// Registers a new download; fails when the same id is already running.
    fn begin(
        app: &'a tauri::AppHandle,
        state: &'a Mutex<DownloadState>,
        kind: &str,
        id: &str,
        filename: &str,
        total: u64,
    ) -> Result<Self, EngineError> {
        let (key, cancel, progress) = reserve_download(state, kind, id, filename, total)?;
        let mut reporter = Self {
            app,
            state,
            key,
            progress,
            cancel,
            last_emit: Instant::now()
                .checked_sub(PROGRESS_INTERVAL)
                .unwrap_or_else(Instant::now),
        };
        reporter.emit(true);
        Ok(reporter)
    }

    /// `true` when this specific download was cancelled by the user.
    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn phase(&mut self, filename: &str, total: u64) {
        self.progress.filename = filename.to_string();
        self.progress.received = 0;
        self.progress.total = total;
        self.progress.percent = 0.0;
        self.status("downloading");
    }

    fn set_total(&mut self, total: u64) {
        if total > 0 {
            self.progress.total = total;
            self.progress.percent = percent(self.progress.received, total);
            self.emit(false);
        }
    }

    fn advance(&mut self, bytes: u64) {
        self.progress.received = self.progress.received.saturating_add(bytes);
        self.progress.percent = percent(self.progress.received, self.progress.total);
        self.emit(false);
    }

    fn status(&mut self, status: &str) {
        self.progress.status = status.to_string();
        self.emit(true);
    }

    fn succeed(&mut self) {
        self.progress.status = "verifying".to_string();
        self.progress.percent = 100.0;
        if self.progress.total > 0 {
            self.progress.received = self.progress.total;
        }
        self.emit(true);
        self.finish();
    }

    fn fail(&mut self, message: &str) {
        self.progress.status = "failed".to_string();
        self.progress.error = message.to_string();
        self.emit(true);
        self.finish();
    }

    fn cancelled(&mut self) {
        self.progress.status = "cancelled".to_string();
        self.emit(true);
        self.finish();
    }

    /// Removes this download from the registry (idempotent).
    fn finish(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.tasks.remove(&self.key);
        }
    }

    fn emit(&mut self, force: bool) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(task) = state.tasks.get_mut(&self.key) {
                task.progress = self.progress.clone();
            }
        }
        if force || self.last_emit.elapsed() >= PROGRESS_INTERVAL {
            self.last_emit = Instant::now();
            let _ = self.app.emit(DOWNLOAD_EVENT, &self.progress);
        }
    }
}

impl Drop for DownloadReporter<'_> {
    fn drop(&mut self) {
        self.finish();
    }
}

/// Rounds a progress percentage to one decimal and clamps it to 0..=100.
fn percent(received: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    let value = ((received as f64 / total as f64) * 100.0).clamp(0.0, 100.0);
    (value * 10.0).round() / 10.0
}

pub struct EngineService {
    paths: AppPaths,
    settings: Arc<SettingsStore>,
    logger: Logger,
    model_logger: Logger,
    model_call_seq: AtomicU64,
    http: reqwest::Client,
    local: llama::LocalServer,
    /// True after the user clicked "启动" and until they click "停止". While it
    /// is false a request never starts the local server on its own.
    local_desired: AtomicBool,
    /// Catalog id captured by explicit start, retained across task role changes.
    active_selection: Mutex<Option<String>>,
    /// Serialize start/stop and request preparation, without holding a lock during streaming.
    local_lifecycle: tokio::sync::Mutex<()>,
    /// Registry of concurrent downloads (engine + one per model id).
    download: Mutex<DownloadState>,
    /// Serialize shared projector installation so Q3/Q4 never overwrite it concurrently.
    projector_download: tokio::sync::Mutex<()>,
}

/// Which model role a request needs. Hy-MT2 is translation-specialised,
/// the manually selected Qwen3.5 handles general text and images with its projector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalRole {
    Translate,
    General,
    Vision,
}

/// Error returned when local mode is selected but the VL model (or its
/// projector) is not installed. Shared by `vision_stream` and the local chat
/// config so both paths give the same actionable hint.
fn local_vision_missing_error() -> EngineError {
    EngineError::new(
        "本地视觉模型未安装或尚未选择。",
        "请在「设置 → 本地模型」手动选择 Qwen3.5，并完整下载模型权重及视觉投影器；也可切换到支持视觉的在线模型。",
    )
}

struct ModelLogMeta {
    logger: Logger,
    call_id: u64,
    operation: String,
    provider: String,
    model: String,
    detail: String,
    started: Instant,
}

struct LoggedModelStream {
    inner: BoxStream<'static, Result<String, EngineError>>,
    logger: Logger,
    call_id: u64,
    operation: String,
    started: Instant,
    chunks: u64,
    output_chars: usize,
    finished: bool,
}

impl Stream for LoggedModelStream {
    type Item = Result<String, EngineError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.as_mut().get_mut();
        match this.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                this.chunks += 1;
                this.output_chars += chunk.chars().count();
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(error))) => {
                this.finished = true;
                this.logger.error(&format!(
                    "model call finish: id={} operation={} status=error duration_ms={} chunks={} output_chars={} error={}",
                    this.call_id,
                    this.operation,
                    this.started.elapsed().as_millis(),
                    this.chunks,
                    this.output_chars,
                    error.message
                ));
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                this.finished = true;
                this.logger.info(&format!(
                    "model call finish: id={} operation={} status=success duration_ms={} chunks={} output_chars={}",
                    this.call_id,
                    this.operation,
                    this.started.elapsed().as_millis(),
                    this.chunks,
                    this.output_chars
                ));
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for LoggedModelStream {
    fn drop(&mut self) {
        if !self.finished {
            self.logger.warn(&format!(
                "model call finish: id={} operation={} status=cancelled duration_ms={} chunks={} output_chars={}",
                self.call_id,
                self.operation,
                self.started.elapsed().as_millis(),
                self.chunks,
                self.output_chars
            ));
        }
    }
}

impl EngineService {
    pub fn new(paths: AppPaths, settings: Arc<SettingsStore>, logger: Logger) -> Self {
        let model_logger = Logger::new(&paths.logs_dir, "model");
        let http = reqwest::Client::builder()
            .user_agent(concat!("Lexora/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .unwrap_or_default();
        Self {
            paths,
            settings,
            logger,
            model_logger,
            model_call_seq: AtomicU64::new(1),
            http,
            local: llama::LocalServer::new(),
            local_desired: AtomicBool::new(false),
            active_selection: Mutex::new(None),
            local_lifecycle: tokio::sync::Mutex::new(()),
            download: Mutex::new(DownloadState::default()),
            projector_download: tokio::sync::Mutex::new(()),
        }
    }

    async fn logged_stream(
        &self,
        operation: &str,
        config: &openai::OnlineConfig,
        detail: String,
        messages: Vec<Value>,
    ) -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError> {
        let meta = ModelLogMeta {
            logger: self.model_logger.clone(),
            call_id: self.model_call_seq.fetch_add(1, Ordering::Relaxed),
            operation: operation.to_string(),
            provider: if config.local {
                "local".to_string()
            } else if config.preset.trim().is_empty() {
                "online".to_string()
            } else {
                format!("online:{}", config.preset)
            },
            model: config.model.clone(),
            detail,
            started: Instant::now(),
        };
        meta.logger.info(&format!(
            "model call start: id={} operation={} provider={} model={} {}",
            meta.call_id, meta.operation, meta.provider, meta.model, meta.detail
        ));

        match openai::stream_chat(&self.http, config, messages, config.header_timeout()).await {
            Ok(stream) => Ok(Box::pin(LoggedModelStream {
                inner: stream,
                logger: meta.logger,
                call_id: meta.call_id,
                operation: meta.operation,
                started: meta.started,
                chunks: 0,
                output_chars: 0,
                finished: false,
            })),
            Err(error) => {
                meta.logger.error(&format!(
                    "model call finish: id={} operation={} status=error duration_ms={} chunks=0 output_chars=0 error={}",
                    meta.call_id,
                    meta.operation,
                    meta.started.elapsed().as_millis(),
                    error.message
                ));
                Err(error)
            }
        }
    }
    // -- status ------------------------------------------------------------- //

    pub fn status(&self) -> EngineStatus {
        let settings = self.settings.get();
        let local = self.local.snapshot();
        let engine_available = self.paths.engine_installed();
        let online_configured = settings.online_configured();
        let has_models = self.default_local_model().is_some();

        let local_model_file = local.model_file.clone();
        let local_model_name = local.model_name.clone();

        let (ready, hint) = if settings.is_local_mode() {
            match local.state {
                LocalState::Ready => (true, String::new()),
                LocalState::Starting => (
                    false,
                    "本地模型加载中，通常需要 10–60 秒，请稍候…".to_string(),
                ),
                LocalState::Error => {
                    let hint = if local.error.trim().is_empty() {
                        "本地引擎启动失败，请查看 logs/llama.log 获取详细原因。".to_string()
                    } else {
                        local.error.clone()
                    };
                    (false, hint)
                }
                LocalState::Stopped => {
                    if !engine_available {
                        (
                            false,
                            "本地引擎尚未安装。请在「设置 → 本地模型」中下载 llama.cpp 引擎，或切换到在线模式。"
                                .to_string(),
                        )
                    } else if !has_models {
                        (
                            false,
                            "尚未安装本地模型。请下载 Hy-MT2（翻译），或手动选择并完整安装 Qwen3.5（通用与视觉）。"
                                .to_string(),
                        )
                    } else {
                        (false, "本地模型未启动。点击「启动」后使用。".to_string())
                    }
                }
            }
        } else if online_configured {
            (true, String::new())
        } else {
            (
                false,
                "在线服务未配置。请在「设置 → 翻译服务」填写服务地址与模型名，或切换到本地模型。"
                    .to_string(),
            )
        };

        let provider_label = if settings.is_local_mode() {
            if local_model_name.trim().is_empty() {
                "本地模型".to_string()
            } else {
                format!("本地 · {}", local_model_name.trim())
            }
        } else if settings.provider.online.model.trim().is_empty() {
            "在线服务".to_string()
        } else {
            format!("在线 · {}", settings.provider.online.model.trim())
        };

        EngineStatus {
            mode: settings.provider.mode.clone(),
            ready,
            hint,
            provider_label,
            online_configured,
            local_state: local.state.as_str().to_string(),
            local_model_file,
            local_model_name,
            local_error: local.error,
            engine_available,
        }
    }

    /// Translation uses Hy-MT2 exclusively. General/vision require an explicit,
    /// completely installed catalog selection; imported or legacy files never win.
    fn model_for_role(&self, role: LocalRole) -> Option<String> {
        if role != LocalRole::Translate {
            return self.installed_vision_model().map(|(weights, _)| weights);
        }
        let spec = models::spec_by_id(models::TRANSLATION_MODEL_ID)?;
        self.paths
            .models_dir
            .join(spec.filename)
            .is_file()
            .then(|| spec.filename.to_string())
    }

    /// Multimodal projector that belongs to `model_file`, when it is installed.
    /// A vision model is always loaded together with its projector — even for
    /// text requests — so switching between text and image tasks does not
    /// restart the server. Both files are required for every Qwen3.5 task.
    fn mmproj_for_model(&self, model_file: &str) -> Option<String> {
        let mmproj = models::spec_by_filename(model_file)?.mmproj?;
        self.paths
            .models_dir
            .join(mmproj.filename)
            .is_file()
            .then(|| mmproj.filename.to_string())
    }

    /// The installed vision model as `(weights, projector)` file names. Both
    /// files must exist; a lone projector or lone weights is not usable.
    fn installed_vision_model(&self) -> Option<(String, String)> {
        let selection = self
            .active_selection
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let selected =
            selection.unwrap_or_else(|| self.settings.get().provider.local.selected_model);
        self.installed_selection(&selected)
    }

    fn installed_selection(&self, selected: &str) -> Option<(String, String)> {
        let spec = models::spec_by_id(selected)?;
        if !spec.vision {
            return None;
        }
        let mmproj = spec.mmproj?;
        let has_weights = self.paths.models_dir.join(spec.filename).is_file();
        let has_mmproj = self.paths.models_dir.join(mmproj.filename).is_file();
        if has_weights && has_mmproj {
            Some((spec.filename.to_string(), mmproj.filename.to_string()))
        } else {
            None
        }
    }

    /// `true` when the local vision model (weights + projector) is installed.
    pub fn has_local_vision(&self) -> bool {
        self.installed_vision_model().is_some()
    }

    /// `true` when an image request can be served right now: online mode with a
    /// configured endpoint, or local mode with the selected Qwen3.5 model installed
    /// (the call itself still fails with a clear message when the local engine
    /// was not started). Screenshot OCR/translate use this to prefer the vision
    /// model and fall back to the Windows OCR engine otherwise.
    pub fn can_use_vision(&self) -> bool {
        let settings = self.settings.get();
        if settings.is_local_mode() {
            self.has_local_vision()
        } else {
            settings.online_configured()
        }
    }

    /// Resolve the explicit selection; never fall back when it is empty.
    fn default_local_model(&self) -> Option<String> {
        self.model_for_role(LocalRole::General)
    }

    fn clear_local_selection(&self) {
        self.local_desired.store(false, Ordering::Release);
        *self
            .active_selection
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
    }

    // -- translation -------------------------------------------------------- //

    pub async fn translate_stream(
        &self,
        text: &str,
        target_lang: &str,
    ) -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError> {
        let settings = self.settings.get();
        let cleaned = text.trim();
        if cleaned.is_empty() {
            return Err(EngineError::new(
                "没有可翻译的文本。",
                "请先选中一段文字，然后再点击翻译。",
            ));
        }
        let truncated = prompts::truncate_chars(cleaned, settings.picker.max_chars as usize);
        let target = prompts::resolve_target_lang(target_lang, &truncated);
        // A single English word gets a dictionary entry instead of a plain
        // translation; the entry is localized to the requested target language.
        let dictionary = prompts::is_single_word(&truncated);
        let (system, user) = prompts::translate_or_dictionary_messages(
            &truncated,
            &target,
            &settings.picker.prompts.translate,
        );
        let messages = vec![
            json!({"role": "system", "content": system}),
            json!({"role": "user", "content": user}),
        ];
        let config = self.chat_config(&settings, LocalRole::Translate).await?;
        self.logger.info(&format!(
            "translate stream start: provider={} model={} chars={} target={} mode={}",
            if config.local { "local" } else { "online" },
            config.model,
            truncated.chars().count(),
            target,
            if dictionary {
                "dictionary"
            } else {
                "translate"
            }
        ));
        self.logged_stream(
            "translate",
            &config,
            format!(
                "input_chars={} target={} mode={}",
                truncated.chars().count(),
                target,
                if dictionary {
                    "dictionary"
                } else {
                    "translate"
                }
            ),
            messages,
        )
        .await
    }

    /// Streams the translation of a screenshot region's text with the
    /// screenshot-specific system prompt (`picker.capturePrompts.translate`).
    /// An empty prompt falls back to the normal text translation pipeline
    /// (single-word dictionary handling included).
    pub async fn translate_stream_with_prompt(
        &self,
        text: &str,
        target_lang: &str,
        custom_prompt: &str,
    ) -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError> {
        let custom = custom_prompt.trim();
        if custom.is_empty() {
            return self.translate_stream(text, target_lang).await;
        }
        let settings = self.settings.get();
        let cleaned = text.trim();
        if cleaned.is_empty() {
            return Err(EngineError::new(
                "没有可翻译的文本。",
                "截图中没有识别到文字，请重新框选后再试。",
            ));
        }
        let truncated = prompts::truncate_chars(cleaned, settings.picker.max_chars as usize);
        let target = prompts::resolve_target_lang(target_lang, &truncated);
        let (system, user) = prompts::translate_messages(&truncated, &target, custom);
        let messages = vec![
            json!({"role": "system", "content": system}),
            json!({"role": "user", "content": user}),
        ];
        let config = self.chat_config(&settings, LocalRole::Translate).await?;
        self.logger.info(&format!(
            "screenshot translate stream start: provider={} model={} chars={} target={} custom_prompt=true",
            if config.local { "local" } else { "online" },
            config.model,
            truncated.chars().count(),
            target
        ));
        self.logged_stream(
            "screenshot_translate",
            &config,
            format!(
                "input_chars={} target={} custom_prompt=true",
                truncated.chars().count(),
                target
            ),
            messages,
        )
        .await
    }

    /// Streams a vision (screenshot) request.
    ///
    /// `image_data_url` is a `data:image/png;base64,...` URL; `system` is the
    /// rendered instruction. Online mode uses the configured OpenAI-compatible
    /// endpoint; local mode uses the manually selected Qwen3.5 together with its
    /// multimodal projector (`--mmproj`), both loaded on demand by
    /// [`llama::LocalServer::ensure_model`].
    pub async fn vision_stream(
        &self,
        image_data_url: &str,
        system: &str,
    ) -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError> {
        let settings = self.settings.get();
        // Local mode needs the VL weights *and* the projector; report a precise
        // "not installed" error instead of a generic provider error.
        if settings.is_local_mode() && !self.has_local_vision() {
            return Err(local_vision_missing_error());
        }
        let role = if settings.is_local_mode() {
            LocalRole::Vision
        } else {
            LocalRole::General
        };
        let config = self.chat_config(&settings, role).await?;
        let instruction = system.trim();
        let system_content = if instruction.is_empty() {
            "请用简体中文解释这张截图的内容、文字信息和关键细节，使用 Markdown。"
        } else {
            instruction
        };
        let messages = vec![
            json!({"role": "system", "content": system_content}),
            json!({
                "role": "user",
                "content": [
                    {"type": "text", "text": "请分析这张截图。"},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ],
            }),
        ];
        self.logger.info(&format!(
            "vision stream start: provider={} model={} bytes={}",
            if config.local { "local" } else { "online" },
            config.model,
            image_data_url.len()
        ));
        self.logged_stream(
            "vision",
            &config,
            format!("image_bytes={}", image_data_url.len()),
            messages,
        )
        .await
    }

    /// Streams a follow-up question about a screenshot that was already
    /// explained. Works in both online and local modes: the conversation is
    /// system explanation prompt → image → previous answer → earlier Q/A turns →
    /// the new question, so the model keeps the screenshot in context.
    ///
    /// `history` contains `(question, answer)` pairs of the earlier follow-ups
    /// (same shape as [`Self::followup_stream`]); only the most recent
    /// [`prompts::FOLLOWUP_HISTORY_MAX_TURNS`] turns are sent and every block is
    /// capped at [`prompts::FOLLOWUP_SEGMENT_MAX_CHARS`].
    pub async fn vision_followup_stream(
        &self,
        image_data_url: &str,
        previous_answer: &str,
        question: &str,
        history: &[(String, String)],
    ) -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError> {
        let settings = self.settings.get();
        let question = question.trim();
        if question.is_empty() {
            return Err(EngineError::new(
                "没有可回答的问题。",
                "请在结果下方的输入框中输入要继续提问的问题后再提交。",
            ));
        }
        if settings.is_local_mode() && !self.has_local_vision() {
            return Err(local_vision_missing_error());
        }
        let role = if settings.is_local_mode() {
            LocalRole::Vision
        } else {
            LocalRole::General
        };
        let config = self.chat_config(&settings, role).await?;

        let recent = if history.len() > prompts::FOLLOWUP_HISTORY_MAX_TURNS {
            &history[history.len() - prompts::FOLLOWUP_HISTORY_MAX_TURNS..]
        } else {
            history
        };
        let mut messages = vec![
            json!({"role": "system", "content": prompts::DEFAULT_EXPLAIN_IMAGE_PROMPT}),
            json!({
                "role": "user",
                "content": [
                    {"type": "text", "text": "请分析这张截图。"},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ],
            }),
        ];
        let previous =
            prompts::truncate_chars(previous_answer.trim(), prompts::FOLLOWUP_SEGMENT_MAX_CHARS);
        if !previous.is_empty() {
            messages.push(json!({"role": "assistant", "content": previous}));
        }
        for (turn_question, turn_answer) in recent {
            let turn_question =
                prompts::truncate_chars(turn_question.trim(), prompts::FOLLOWUP_SEGMENT_MAX_CHARS);
            let turn_answer =
                prompts::truncate_chars(turn_answer.trim(), prompts::FOLLOWUP_SEGMENT_MAX_CHARS);
            if turn_question.is_empty() && turn_answer.is_empty() {
                continue;
            }
            messages.push(json!({"role": "user", "content": turn_question}));
            messages.push(json!({"role": "assistant", "content": turn_answer}));
        }
        messages.push(json!({
            "role": "user",
            "content": prompts::truncate_chars(question, prompts::FOLLOWUP_SEGMENT_MAX_CHARS),
        }));
        self.logger.info(&format!(
            "vision followup stream start: provider={} model={} bytes={} history={}",
            if config.local { "local" } else { "online" },
            config.model,
            image_data_url.len(),
            recent.len()
        ));
        self.logged_stream(
            "vision_followup",
            &config,
            format!(
                "image_bytes={} history={}",
                image_data_url.len(),
                recent.len()
            ),
            messages,
        )
        .await
    }

    /// Streams a polish (rewriting) request. Uses the general model role like
    /// summarize/explain; an empty `picker.prompts.polish` falls back to the
    /// built-in English default.
    pub async fn polish_stream(
        &self,
        text: &str,
    ) -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError> {
        let settings = self.settings.get();
        let cleaned = text.trim();
        if cleaned.is_empty() {
            return Err(EngineError::new(
                "没有可润色的文本。",
                "请先选中一段文字，然后再点击润色。",
            ));
        }
        let truncated = prompts::truncate_chars(cleaned, settings.picker.max_chars as usize);
        let (system, user) = prompts::polish_messages(&truncated, &settings.picker.prompts.polish);
        let messages = vec![
            json!({"role": "system", "content": system}),
            json!({"role": "user", "content": user}),
        ];
        let config = self.chat_config(&settings, LocalRole::General).await?;
        self.logger.info(&format!(
            "polish stream start: provider={} chars={}",
            if config.local { "local" } else { "online" },
            truncated.chars().count()
        ));
        self.logged_stream(
            "polish",
            &config,
            format!("input_chars={}", truncated.chars().count()),
            messages,
        )
        .await
    }

    /// Streams a user-defined skill: the stored prompt is rendered with the
    /// `{text}` / `{target}` / `{language}` / `{program}` / `{app}`
    /// placeholders, then sent through the general model role (custom skills
    /// are free-form instructions, so they use the same role as summarize).
    pub async fn custom_stream(
        &self,
        skill_id: &str,
        text: &str,
        target_lang: &str,
        program: &str,
    ) -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError> {
        let settings = self.settings.get();
        let skill_id = skill_id.trim();
        let skill = settings
            .picker
            .custom_skills
            .iter()
            .find(|skill| skill.id == skill_id)
            .cloned()
            .ok_or_else(|| {
                EngineError::new(
                    "技能不存在（可能已被删除）",
                    "请在设置 → 划词行为中重新添加该技能。",
                )
            })?;
        // A defined skill can be disabled while keeping its definition.
        if !settings.picker.skills.iter().any(|id| id == skill_id) {
            return Err(EngineError::new(
                "技能未启用",
                "请在设置 → 划词行为中启用该技能。",
            ));
        }
        let cleaned = text.trim();
        if cleaned.is_empty() {
            return Err(EngineError::new(
                "没有可翻译的文本。",
                "请先选中一段文字，然后再点击翻译。",
            ));
        }
        let truncated = prompts::truncate_chars(cleaned, settings.picker.max_chars as usize);
        let target = prompts::resolve_target_lang(target_lang, &truncated);
        let system = prompts::render_custom_prompt(&skill.prompt, &truncated, &target, program);
        let messages = vec![
            json!({"role": "system", "content": system}),
            json!({"role": "user", "content": truncated}),
        ];
        let config = self.chat_config(&settings, LocalRole::General).await?;
        self.logger.info(&format!(
            "custom skill stream start: skill={} provider={} chars={}",
            skill_id,
            if config.local { "local" } else { "online" },
            truncated.chars().count()
        ));
        self.logged_stream(
            "custom_skill",
            &config,
            format!(
                "skill={} input_chars={}",
                skill_id,
                truncated.chars().count()
            ),
            messages,
        )
        .await
    }

    pub async fn assist_stream(
        &self,
        action: &str,
        text: &str,
    ) -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError> {
        let settings = self.settings.get();
        let cleaned = text.trim();
        if cleaned.is_empty() {
            return Err(EngineError::new(
                "没有可处理的文本。",
                "请先选中一段文字，然后再点击总结或解释。",
            ));
        }
        let truncated = prompts::truncate_chars(cleaned, prompts::ASSIST_MAX_CHARS);
        let custom_prompt = match action.trim().to_ascii_lowercase().as_str() {
            "summarize" | "summary" | "总结" => settings.picker.prompts.summarize.as_str(),
            "explain" | "解释" => settings.picker.prompts.explain.as_str(),
            _ => "",
        };
        // `explain` on a single English word becomes a dictionary entry;
        // `summarize` keeps its normal prompt.
        let (system, user) =
            prompts::assist_or_dictionary_messages(action, &truncated, custom_prompt)?;
        let messages = vec![
            json!({"role": "system", "content": system}),
            json!({"role": "user", "content": user}),
        ];
        let config = self.chat_config(&settings, LocalRole::General).await?;
        self.logger.info(&format!(
            "assist stream start: action={} provider={} chars={}",
            action,
            if config.local { "local" } else { "online" },
            truncated.chars().count()
        ));
        self.logged_stream(
            "assist",
            &config,
            format!(
                "action={} input_chars={}",
                action,
                truncated.chars().count()
            ),
            messages,
        )
        .await
    }

    /// Streams a follow-up question about the original selection and the
    /// previous AI answer. History is the Q/A exchange shown in the panel's
    /// follow-up thread; [`prompts::followup_messages`] caps its size.
    pub async fn followup_stream(
        &self,
        text: &str,
        previous_answer: &str,
        question: &str,
        history: &[(String, String)],
    ) -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError> {
        let settings = self.settings.get();
        let question = question.trim();
        if question.is_empty() {
            return Err(EngineError::new(
                "没有可回答的问题。",
                "请在结果下方的输入框中输入要继续提问的问题后再提交。",
            ));
        }
        let (system, user) = prompts::followup_messages(text, previous_answer, question, history);
        let user_chars = user.chars().count();
        let messages = vec![
            json!({"role": "system", "content": system}),
            json!({"role": "user", "content": user}),
        ];
        let config = self.chat_config(&settings, LocalRole::General).await?;
        self.logger.info(&format!(
            "followup stream start: provider={} chars={} history={}",
            if config.local { "local" } else { "online" },
            user_chars,
            history.len()
        ));
        self.logged_stream(
            "followup",
            &config,
            format!("input_chars={} history={}", user_chars, history.len()),
            messages,
        )
        .await
    }

    pub async fn assist(&self, action: &str, text: &str) -> Result<String, EngineError> {
        let settings = self.settings.get();
        let cleaned = text.trim();
        if cleaned.is_empty() {
            return Err(EngineError::new(
                "没有可处理的文本。",
                "请先选中一段文字，然后再点击总结或解释。",
            ));
        }
        let truncated = prompts::truncate_chars(cleaned, prompts::ASSIST_MAX_CHARS);
        let custom_prompt = match action.trim().to_ascii_lowercase().as_str() {
            "summarize" | "summary" | "总结" => settings.picker.prompts.summarize.as_str(),
            "explain" | "解释" => settings.picker.prompts.explain.as_str(),
            _ => "",
        };
        let (system, user) = prompts::assist_messages(action, &truncated, custom_prompt)?;
        let messages = vec![
            json!({"role": "system", "content": system}),
            json!({"role": "user", "content": user}),
        ];
        let config = self.chat_config(&settings, LocalRole::General).await?;
        let max_tokens = settings.provider.online.max_tokens.clamp(256, 1024);
        let timeout = Duration::from_millis(config.timeout_ms.clamp(5_000, 300_000));
        self.logger.info(&format!(
            "assist start: action={} provider={} chars={}",
            action,
            if config.local { "local" } else { "online" },
            truncated.chars().count()
        ));
        let result =
            openai::chat_completion(&self.http, &config, messages, max_tokens, timeout).await;
        match &result {
            Ok(answer) => self
                .logger
                .info(&format!("assist done: {} chars", answer.chars().count())),
            Err(error) => self
                .logger
                .warn(&format!("assist failed: {} {}", error.message, error.hint)),
        }
        result
    }

    /// Resolves the endpoint used for translation / assist / vision. In local
    /// mode the user must have started the engine explicitly ("启动"); the model
    /// is then picked by role and swapped automatically when necessary. The
    /// vision role additionally loads the model's multimodal projector.
    async fn chat_config(
        &self,
        settings: &Settings,
        role: LocalRole,
    ) -> Result<openai::OnlineConfig, EngineError> {
        if settings.is_local_mode() {
            let _lifecycle = self.local_lifecycle.lock().await;
            if !self.local_desired.load(Ordering::Acquire) {
                return Err(EngineError::new(
                    "本地模型未启动。",
                    "请在「设置 → 翻译服务 → 本地模型」点击「启动」，或切换到在线 API。",
                ));
            }
            let Some(model_file) = self.model_for_role(role) else {
                return Err(if role != LocalRole::Translate {
                    local_vision_missing_error()
                } else {
                    EngineError::new(
                        "尚未安装本地模型。",
                        "请在「设置 → 本地模型」下载 Hy-MT2（翻译）；通用与视觉任务需手动选择并完整安装 Qwen3.5。",
                    )
                });
            };
            let mmproj_file = self.mmproj_for_model(&model_file);
            self.local
                .ensure_model(
                    &self.paths,
                    settings,
                    &model_file,
                    mmproj_file.as_deref(),
                    &self.http,
                    &self.logger,
                )
                .await?;
            if !self.local_desired.load(Ordering::Acquire) {
                self.local.stop(Some(&self.logger));
                return Err(EngineError::new("本地模型已停止。", "请重新点击启动。"));
            }
            self.local_config(settings, &model_file)
        } else {
            let config = self.online_config(settings);
            if !config.is_configured() {
                return Err(EngineError::new(
                    "在线服务尚未配置。",
                    "请在「设置 → 翻译服务」中填写服务地址和模型名，或切换到本地模型模式。",
                ));
            }
            Ok(config)
        }
    }

    fn online_config(&self, settings: &Settings) -> openai::OnlineConfig {
        let online = &settings.provider.online;
        let env_key = std::env::var(ENV_API_KEY)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        openai::OnlineConfig {
            base_url: openai::normalize_base_url(&online.base_url),
            models_base_url: online.models_base_url.trim().to_string(),
            api_key: env_key.unwrap_or_else(|| online.api_key.clone()),
            model: online.model.trim().to_string(),
            timeout_ms: online.timeout_ms,
            temperature: online.temperature,
            max_tokens: online.max_tokens,
            preset: online.preset.trim().to_string(),
            local: false,
        }
    }

    fn local_config(
        &self,
        settings: &Settings,
        model_file: &str,
    ) -> Result<openai::OnlineConfig, EngineError> {
        let base_url = self.local.base_url().ok_or_else(|| {
            EngineError::new(
                "本地引擎尚未就绪。",
                "请先在「设置 → 本地模型」中启动本地模型，然后重试。",
            )
        })?;
        Ok(openai::OnlineConfig {
            base_url,
            models_base_url: String::new(),
            api_key: String::new(),
            model: models::model_display_name(model_file),
            timeout_ms: LOCAL_HEADER_TIMEOUT_MS,
            temperature: settings.provider.online.temperature,
            max_tokens: settings.provider.online.max_tokens,
            preset: String::new(),
            local: true,
        })
    }

    // -- online helpers ----------------------------------------------------- //

    pub async fn test_online(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        timeout_ms: u64,
    ) -> TestResult {
        let started = Instant::now();
        let base = openai::normalize_base_url(base_url);
        let requested_model = model.trim().to_string();
        if base.is_empty() {
            return TestResult {
                ok: false,
                latency_ms: 0,
                models: Vec::new(),
                model: requested_model,
                error: "服务地址不能为空。".to_string(),
                hint: "请填写完整的 http(s) 地址，例如 https://api.deepseek.com/v1。".to_string(),
            };
        }
        let timeout = Duration::from_millis(timeout_ms.clamp(2_000, 120_000));
        let mut result = TestResult {
            ok: false,
            latency_ms: started.elapsed().as_millis() as u64,
            models: Vec::new(),
            model: requested_model.clone(),
            error: String::new(),
            hint: String::new(),
        };

        let online_settings = self.settings.get().provider.online.clone();
        let list_config = openai::OnlineConfig {
            base_url: base.clone(),
            models_base_url: online_settings.models_base_url.trim().to_string(),
            api_key: api_key.trim().to_string(),
            model: requested_model.clone(),
            timeout_ms,
            temperature: 0.0,
            max_tokens: 1,
            preset: online_settings.preset.trim().to_string(),
            local: false,
        };
        let mut list_error: Option<EngineError> = None;
        match openai::list_models(&self.http, &list_config, timeout).await {
            Ok(models) => result.models = models,
            Err(error) => {
                self.logger.warn(&format!(
                    "test_online models request failed: {}",
                    error.message
                ));
                list_error = Some(error);
            }
        }

        if requested_model.is_empty() {
            if let Some(error) = list_error {
                result.error = error.message;
                result.hint = error.hint;
                return result;
            }
            if result.models.is_empty() {
                result.error = "服务可访问，但模型列表为空。".to_string();
                result.hint = "请手动填写模型名后重试。".to_string();
                return result;
            }
            result.ok = true;
            return result;
        }

        let config = openai::OnlineConfig {
            base_url: base,
            models_base_url: list_config.models_base_url.clone(),
            api_key: api_key.trim().to_string(),
            model: requested_model.clone(),
            timeout_ms,
            temperature: 0.0,
            max_tokens: 1,
            preset: list_config.preset.clone(),
            local: false,
        };
        let ping_started = Instant::now();
        let ping = openai::ping(&self.http, &config, timeout).await;
        result.latency_ms = ping_started.elapsed().as_millis() as u64;
        match ping {
            Ok(_) => {
                result.ok = true;
                if let Some(error) = &list_error {
                    result.hint = format!(
                        "模型列表接口不可用（{}），但对话接口可以正常访问。",
                        error.message
                    );
                }
            }
            Err(error) => {
                self.logger
                    .warn(&format!("test_online chat failed: {}", error.message));
                result.error = error.message;
                result.hint = error.hint;
                if !result.models.is_empty()
                    && !result
                        .models
                        .iter()
                        .any(|item| item.eq_ignore_ascii_case(&requested_model))
                {
                    let preview: Vec<String> = result.models.iter().take(5).cloned().collect();
                    result.hint = format!(
                        "{} 服务返回的可用模型示例：{}。",
                        result.hint,
                        preview.join("、")
                    );
                }
            }
        }
        result
    }

    pub async fn list_online_models(
        &self,
        base_url: &str,
        api_key: &str,
    ) -> Result<Vec<String>, EngineError> {
        let settings = self.settings.get();
        let timeout =
            Duration::from_millis(settings.provider.online.timeout_ms.clamp(2_000, 120_000));
        let config = openai::OnlineConfig {
            base_url: openai::normalize_base_url(base_url),
            models_base_url: settings.provider.online.models_base_url.trim().to_string(),
            api_key: api_key.trim().to_string(),
            model: String::new(),
            timeout_ms: settings.provider.online.timeout_ms,
            temperature: 0.0,
            max_tokens: 1,
            preset: settings.provider.online.preset.trim().to_string(),
            local: false,
        };
        openai::list_models(&self.http, &config, timeout).await
    }

    // -- models ------------------------------------------------------------- //

    pub fn installed_models(&self) -> Vec<ModelInfo> {
        models::scan_models(&self.paths.models_dir)
    }

    pub fn catalog(&self) -> Vec<CatalogEntry> {
        models::catalog_entries(&self.paths.models_dir)
    }

    /// Snapshot of every active download (engine + models), sorted by key.
    pub fn download_state(&self) -> Vec<DownloadProgress> {
        self.download
            .lock()
            .map(|state| download_list(&state))
            .unwrap_or_default()
    }

    /// `true` when the same engine/model download is already registered.
    pub fn has_download(&self, kind: &str, id: &str) -> bool {
        let key = download_key(kind, id);
        self.download
            .lock()
            .map(|state| state.tasks.contains_key(&key))
            .unwrap_or(false)
    }

    /// Cancels one download or all of them. `None` (or a blank id) cancels every
    /// active task; `Some("engine")` only the engine, `Some(model_id)` only
    /// that model. The download loops observe their own token and stop.
    pub fn cancel_download(&self, id: Option<&str>) {
        let cancelled = cancel_tasks(&self.download, id);
        if cancelled.is_empty() {
            self.logger.info(&format!(
                "download cancellation requested: no active download (id={:?})",
                id
            ));
        } else {
            self.logger.info(&format!(
                "download cancellation requested: {}",
                cancelled.join(", ")
            ));
        }
    }

    pub fn engine_installed(&self) -> bool {
        self.paths.engine_installed()
    }

    pub async fn download_model(
        &self,
        app: tauri::AppHandle,
        id: &str,
    ) -> Result<ModelInfo, EngineError> {
        let spec = models::spec_by_id(id).copied().ok_or_else(|| {
            EngineError::new(
                format!("未知的模型标识：{id}。"),
                "请在「设置 → 本地模型」的内置模型列表中选择要下载的模型。",
            )
        })?;

        let final_path = self.paths.models_dir.join(spec.filename);
        let mmproj_installed = spec
            .mmproj
            .map(|mmproj| self.paths.models_dir.join(mmproj.filename).is_file())
            .unwrap_or(true);
        // A vision model is only installed once weights *and* projector exist,
        // so a retry after a failed projector download resumes at phase 2.
        if final_path.is_file() && mmproj_installed {
            self.logger
                .info(&format!("model already installed: {}", spec.filename));
            return Ok(self.model_info_for(&final_path));
        }

        let mut reporter = DownloadReporter::begin(
            &app,
            &self.download,
            "model",
            spec.id,
            spec.filename,
            spec.size_bytes,
        )?;

        // Phase 1: model weights (skipped when a previous attempt already saved
        // them but failed on the projector).
        if !final_path.is_file() {
            self.download_model_file(
                &mut reporter,
                spec.id,
                spec.filename,
                spec.size_bytes,
                models::download_urls(&spec),
                "也可以手动下载该 GGUF 文件，然后通过「导入 GGUF」加入模型列表。",
            )
            .await?;
        } else {
            self.logger.info(&format!(
                "model weights already present, skipping download: {}",
                spec.filename
            ));
        }

        // Phase 2: multimodal projector (same model id, distinct filename in the
        // progress events so the UI shows both stages).
        if let Some(mmproj) = spec.mmproj {
            reporter.phase(mmproj.filename, mmproj.size_bytes);
            reporter.status("waiting");
            let _projector_guard = match cancellable_projector_lock(
                &self.projector_download,
                &reporter.cancel,
            )
            .await
            {
                Ok(guard) => guard,
                Err(error) => {
                    reporter.cancelled();
                    return Err(error);
                }
            };
            let mmproj_path = self.paths.models_dir.join(mmproj.filename);
            if !mmproj_path.is_file() {
                self.logger.info(&format!(
                    "downloading vision projector {} for {}",
                    mmproj.filename, spec.filename
                ));
                self.download_model_file(
                    &mut reporter,
                    spec.id,
                    mmproj.filename,
                    mmproj.size_bytes,
                    models::mmproj_download_urls(&mmproj),
                    "请重试：已下载的主模型会跳过，只重新下载投影器。",
                )
                .await
                .map_err(|error| {
                    // Cancellation is not a projector failure: keep its wording.
                    if error.message.contains("已取消") {
                        return error;
                    }
                    EngineError::new(
                        format!("视觉投影器下载失败：{}", error.message),
                        format!(
                            "主模型已安装，只差视觉投影器（{}）。{}",
                            mmproj.filename, error.hint
                        ),
                    )
                })?;
            } else {
                self.logger.info(&format!(
                    "vision projector already present: {}",
                    mmproj.filename
                ));
            }
        }

        if reporter.is_cancelled() {
            reporter.cancelled();
            return Err(cancelled_error());
        }
        reporter.succeed();
        self.logger.info(&format!(
            "model installed: {} ({} bytes)",
            spec.filename, spec.size_bytes
        ));
        Ok(self.model_info_for(&final_path))
    }

    /// Downloads one file of a model (weights or vision projector) with the
    /// ModelScope → Hugging Face fallback, size verification, cancellation and
    /// `.part` cleanup. The caller retains one registry entry and cancellation
    /// token across both files and the projector lock wait.
    async fn download_model_file(
        &self,
        reporter: &mut DownloadReporter<'_>,
        spec_id: &str,
        filename: &str,
        size_bytes: u64,
        urls: Vec<&'static str>,
        manual_hint: &str,
    ) -> Result<(), EngineError> {
        let part = models::part_path(&self.paths.cache_dir, &format!("{spec_id}-{filename}"));
        let final_path = self.paths.models_dir.join(filename);
        reporter.phase(filename, size_bytes);
        if urls.is_empty() {
            let error = EngineError::new(
                "该模型没有可用的下载地址。",
                "请在「设置 → 本地模型」中重试，或手动下载后导入。",
            );
            reporter.fail(&format!("{} {}", error.message, error.hint));
            return Err(error);
        }
        let mut last_error: Option<EngineError> = None;
        // ModelScope first (mainland-friendly), Hugging Face as fallback.
        for (index, url) in urls.iter().enumerate() {
            if reporter.is_cancelled() {
                let _ = std::fs::remove_file(&part);
                reporter.cancelled();
                return Err(cancelled_error());
            }
            if index > 0 {
                self.logger
                    .warn(&format!("model download falling back to mirror: {url}"));
                reporter.phase(filename, size_bytes);
            }
            self.logger
                .info(&format!("downloading model {} from {}", filename, url));
            let attempt = self
                .download_to_file(url, &part, reporter, Some(size_bytes))
                .await;
            match attempt {
                Ok(()) => {
                    last_error = None;
                    break;
                }
                Err(error) => {
                    self.logger.warn(&format!(
                        "model download failed from {url}: {} / {}",
                        error.message, error.hint
                    ));
                    let _ = std::fs::remove_file(&part);
                    if reporter.is_cancelled() {
                        reporter.cancelled();
                        return Err(cancelled_error());
                    }
                    last_error = Some(error);
                }
            }
        }
        if let Some(error) = last_error {
            reporter.fail(&format!("{} {}", error.message, error.hint));
            return Err(EngineError::new(
                error.message,
                format!("{} {manual_hint}", error.hint),
            ));
        }

        if reporter.is_cancelled() {
            let _ = std::fs::remove_file(&part);
            reporter.cancelled();
            return Err(cancelled_error());
        }
        reporter.status("verifying");
        let actual = std::fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
        if actual != size_bytes {
            let _ = std::fs::remove_file(&part);
            let error = EngineError::new(
                format!(
                    "模型文件大小校验失败（期望 {}，实际 {}）。",
                    models::format_size(size_bytes),
                    models::format_size(actual)
                ),
                "下载可能未完成或镜像文件已更新：请重试，或手动下载 GGUF 文件后导入。",
            );
            reporter.fail(&format!("{} {}", error.message, error.hint));
            return Err(error);
        }

        if let Some(parent) = final_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(error) = move_file(&part, &final_path) {
            reporter.fail(&format!("保存模型文件失败：{error}"));
            return Err(EngineError::new(
                "保存模型文件失败。",
                format!("请检查磁盘空间与目录权限后重试；系统错误：{error}"),
            ));
        }
        self.logger.info(&format!(
            "model file saved: {} ({} bytes)",
            filename, size_bytes
        ));
        Ok(())
    }

    pub async fn install_engine(&self, app: tauri::AppHandle) -> Result<(), EngineError> {
        let url = std::env::var(ENV_LLAMA_URL)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| ENGINE_DOWNLOAD_URL.to_string());
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(EngineError::new(
                "引擎下载地址无效。",
                format!("LEXORA_LLAMA_URL 必须是 http(s) 地址；当前值：{url}"),
            ));
        }
        let filename = url
            .rsplit('/')
            .next()
            .unwrap_or("llama-server.zip")
            .split('?')
            .next()
            .unwrap_or("llama-server.zip")
            .to_string();

        let part = models::part_path(&self.paths.cache_dir, &filename);
        // The engine is one registry entry; a second install while it runs
        // returns "引擎正在下载中" while model downloads keep working.
        let mut reporter =
            DownloadReporter::begin(&app, &self.download, "engine", "", &filename, 0)?;
        self.logger
            .info(&format!("downloading llama.cpp engine from {url}"));
        let attempt = self
            .download_to_file(&url, &part, &mut reporter, None)
            .await;
        if let Err(error) = attempt {
            let _ = std::fs::remove_file(&part);
            if reporter.is_cancelled() {
                reporter.cancelled();
                return Err(cancelled_error());
            }
            self.logger
                .warn(&format!("engine download failed: {}", error.message));
            reporter.fail(&format!("{} {}", error.message, error.hint));
            return Err(EngineError::new(
                error.message,
                format!(
                    "{} 也可手动下载 {}，解压后把 llama-server.exe 所在目录的全部文件复制到 {}。",
                    error.hint,
                    url,
                    self.paths.engine_dir.display()
                ),
            ));
        }
        if reporter.is_cancelled() {
            let _ = std::fs::remove_file(&part);
            reporter.cancelled();
            return Err(cancelled_error());
        }

        reporter.status("verifying");
        let size = std::fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
        if size < 1_000_000 {
            let _ = std::fs::remove_file(&part);
            let error = EngineError::new(
                "引擎压缩包异常（文件过小）。",
                format!(
                    "下载可能被中断。可重试，或手动下载 {} 并解压到 {}。",
                    url,
                    self.paths.engine_dir.display()
                ),
            );
            reporter.fail(&format!("{} {}", error.message, error.hint));
            return Err(error);
        }
        self.logger
            .info(&format!("extracting engine package ({} bytes)", size));
        // A running llama-server locks llama-server.exe / DLLs; stop it before
        // overwriting the engine directory.
        self.local.stop(Some(&self.logger));
        let extracted = extract_engine_zip(&part, &self.paths.engine_dir);
        let _ = std::fs::remove_file(&part);
        match extracted {
            Ok(()) => {
                reporter.succeed();
                self.logger
                    .info("llama.cpp engine installed into engine directory");
                Ok(())
            }
            Err(error) => {
                reporter.fail(&format!("{} {}", error.message, error.hint));
                Err(EngineError::new(
                    error.message,
                    format!(
                        "{} 手动方式：下载 {} 并解压，把 llama-server.exe 所在目录的全部文件复制到 {}。",
                        error.hint,
                        url,
                        self.paths.engine_dir.display()
                    ),
                ))
            }
        }
    }

    pub async fn import_model(&self, path: PathBuf) -> Result<ModelInfo, EngineError> {
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            return Err(EngineError::new(
                "无效的模型文件路径。",
                "请选择一个 .gguf 格式的模型文件。",
            ));
        };
        let file_name = file_name.to_string();
        if !models::is_gguf_file(&file_name) {
            return Err(EngineError::new(
                "仅支持 .gguf 格式的模型文件。",
                "请下载 Lexora 模型列表中的 GGUF 文件，或先在设置中下载内置模型。",
            ));
        }
        let metadata = std::fs::metadata(&path).map_err(|error| {
            EngineError::new(
                "无法读取所选模型文件。",
                format!("请确认文件存在且可访问；系统错误：{error}"),
            )
        })?;
        if !metadata.is_file() {
            return Err(EngineError::new(
                "所选路径不是文件。",
                "请选择一个 .gguf 格式的模型文件。",
            ));
        }
        if metadata.len() > models::MAX_IMPORT_BYTES {
            return Err(EngineError::new(
                "模型文件超过 4GB，暂不支持导入。",
                "请选择 4GB 以内的 GGUF 模型，例如内置列表中的 Qwen3.5 系列。",
            ));
        }
        if !models::looks_like_gguf(&path) {
            return Err(EngineError::new(
                "不是有效的 GGUF 模型文件。",
                "文件头校验失败：请确认选择的是 .gguf 格式的模型文件。",
            ));
        }

        let target_name = models::dedupe_filename(&self.paths.models_dir, &file_name);
        let target = self.paths.models_dir.join(&target_name);
        let source = path.clone();
        let models_dir = self.paths.models_dir.clone();
        let target_for_task = target.clone();
        let copied = tokio::task::spawn_blocking(move || -> std::io::Result<u64> {
            std::fs::create_dir_all(&models_dir)?;
            std::fs::copy(&source, &target_for_task)
        })
        .await
        .map_err(|error| {
            EngineError::new(
                "导入模型失败。",
                format!("后台任务异常，请重试；详细信息：{error}"),
            )
        })?
        .map_err(|error| {
            EngineError::new(
                "导入模型失败。",
                format!("请检查磁盘空间与文件权限；系统错误：{error}"),
            )
        })?;

        self.logger.info(&format!(
            "model imported: {} <- {} ({} bytes)",
            target_name,
            path.display(),
            copied
        ));
        Ok(self.model_info_for(&target))
    }

    /// Delete only unselected residual/imported weights, without stopping the engine.
    pub async fn remove_model_file(&self, file: &str) -> Result<(), EngineError> {
        let _lifecycle = self.local_lifecycle.lock().await;
        let file = models::clean_model_file_name(file)?;
        let selected = self.settings.get().provider.local.selected_model;
        if file.to_ascii_lowercase().starts_with("mmproj")
            || models::CATALOG
                .iter()
                .any(|spec| spec.filename.eq_ignore_ascii_case(&file))
            || selected.eq_ignore_ascii_case(&file)
            || models::spec_by_id(&selected)
                .is_some_and(|spec| spec.filename.eq_ignore_ascii_case(&file))
            || self.local.is_running_file(&file)
        {
            return Err(EngineError::new(
                "该模型文件受保护，不能删除。",
                "仅可删除未选中、未运行或加载的残留或导入 GGUF；目录模型和视觉投影器不可删除。",
            ));
        }
        let path = self.paths.models_dir.join(&file);
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            EngineError::new(
                format!("模型文件不存在或无法访问：{file}。"),
                format!("请刷新列表重试；系统错误：{error}"),
            )
        })?;
        if !metadata.file_type().is_file() {
            return Err(EngineError::new(
                "模型文件类型无效。",
                "只能删除模型目录内的普通 GGUF 文件。",
            ));
        }
        std::fs::remove_file(&path).map_err(|error| {
            EngineError::new(
                format!("删除模型文件失败：{file}。"),
                format!("请检查文件占用与权限；系统错误：{error}"),
            )
        })?;
        self.logger.info(&format!("model removed: {file}"));
        Ok(())
    }

    // -- local engine ------------------------------------------------------- //

    pub async fn start_local(&self) -> Result<(), EngineError> {
        let _lifecycle = self.local_lifecycle.lock().await;
        self.start_local_locked().await
    }

    /// Caller must hold local_lifecycle throughout startup.
    async fn start_local_locked(&self) -> Result<(), EngineError> {
        if self.local_desired.load(Ordering::Acquire) {
            return Ok(());
        }
        self.clear_local_selection();
        let settings = self.settings.get();
        let Some((model_file, projector)) =
            self.installed_selection(&settings.provider.local.selected_model)
        else {
            return Err(if settings.provider.local.selected_model.is_empty() {
                EngineError::new(
                    "尚未选择本地模型。",
                    "请手动选择并完整下载 Qwen3.5 后启动。",
                )
            } else {
                local_vision_missing_error()
            });
        };
        let mmproj_file = Some(projector);
        *self
            .active_selection
            .lock()
            .unwrap_or_else(|e| e.into_inner()) =
            Some(settings.provider.local.selected_model.clone());
        self.local_desired.store(true, Ordering::Release);
        let result = self
            .local
            .ensure_model(
                &self.paths,
                &settings,
                &model_file,
                mmproj_file.as_deref(),
                &self.http,
                &self.logger,
            )
            .await;
        if !self.local_desired.load(Ordering::Acquire) {
            self.local.stop(Some(&self.logger));
            self.clear_local_selection();
            return Err(EngineError::new("本地引擎启动已取消。", "请重新点击启动。"));
        }
        if result.is_err() {
            self.local.stop(Some(&self.logger));
            self.clear_local_selection();
            self.set_keep_running(false);
        } else {
            // Remember the user's explicit start so the next launch can restore
            // the engine (see `main::restore_local_engine`).
            self.set_keep_running(true);
        }
        result.map(|_| ())
    }

    pub async fn stop_local(&self) -> Result<(), EngineError> {
        let _lifecycle = self.local_lifecycle.lock().await;
        self.clear_local_selection();
        self.local.stop(Some(&self.logger));
        self.set_keep_running(false);
        Ok(())
    }

    /// Restart atomically using the latest explicit selection.
    pub async fn restart_local(&self) -> Result<(), EngineError> {
        let _lifecycle = self.local_lifecycle.lock().await;
        self.clear_local_selection();
        self.local.stop(Some(&self.logger));
        self.set_keep_running(false);
        self.start_local_locked().await
    }

    /// App shutdown: kill llama-server without forgetting that the user had
    /// started it, so a restart can restore the previous running state.
    pub fn shutdown_local(&self) {
        self.clear_local_selection();
        self.local.stop(Some(&self.logger));
    }

    /// Persists `provider.local.keepRunning` (best effort; a read-only config
    /// must never break engine start/stop).
    fn set_keep_running(&self, keep_running: bool) {
        let patch = json!({ "provider": { "local": { "keepRunning": keep_running } } });
        if let Err(error) = self.settings.update_json(patch) {
            self.logger
                .warn(&format!("failed to persist local keepRunning: {error}"));
        }
    }

    // -- paths / settings --------------------------------------------------- //

    pub fn models_dir(&self) -> &Path {
        &self.paths.models_dir
    }

    pub fn engine_dir(&self) -> &Path {
        &self.paths.engine_dir
    }

    pub fn settings(&self) -> Settings {
        self.settings.get()
    }

    // -- internals ---------------------------------------------------------- //

    fn model_info_for(&self, path: &Path) -> ModelInfo {
        let file = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
        let metadata = std::fs::metadata(path);
        let size_bytes = metadata.as_ref().map(|meta| meta.len()).unwrap_or(0);
        let modified_at = metadata
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        ModelInfo {
            catalog_id: models::catalog_id_for(&file),
            name: models::model_display_name(&file),
            file,
            path: path.to_string_lossy().to_string(),
            size_bytes,
            modified_at,
        }
    }

    /// Streams `url` into `part`, updating progress and honouring cancellation.
    async fn download_to_file(
        &self,
        url: &str,
        part: &Path,
        reporter: &mut DownloadReporter<'_>,
        expected_size: Option<u64>,
    ) -> Result<(), EngineError> {
        if let Some(parent) = part.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let response =
            match tokio::time::timeout(DOWNLOAD_CONNECT_TIMEOUT, self.http.get(url).send()).await {
                Err(_) => {
                    return Err(EngineError::new(
                        "下载连接超时。",
                        "网络长时间无响应：请检查网络或代理设置后重试。",
                    ))
                }
                Ok(Err(error)) => return Err(openai::map_reqwest_error(error, false)),
                Ok(Ok(response)) => response,
            };
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(openai::map_http_status(status.as_u16(), &body, false));
        }
        let total = response.content_length().or(expected_size).unwrap_or(0);
        reporter.set_total(total);

        let mut file = std::fs::File::create(part).map_err(|error| {
            EngineError::new(
                "无法创建下载临时文件。",
                format!("请检查磁盘空间与缓存目录权限；系统错误：{error}"),
            )
        })?;
        let mut body = response.bytes_stream();
        loop {
            if reporter.is_cancelled() {
                drop(file);
                let _ = std::fs::remove_file(part);
                return Err(cancelled_error());
            }
            let next = match tokio::time::timeout(DOWNLOAD_READ_TIMEOUT, body.next()).await {
                Err(_) => {
                    drop(file);
                    let _ = std::fs::remove_file(part);
                    return Err(EngineError::new(
                        "下载超时。",
                        "网络长时间没有数据：请检查网络后重试（临时文件已清理）。",
                    ));
                }
                Ok(None) => break,
                Ok(Some(Err(error))) => {
                    drop(file);
                    let _ = std::fs::remove_file(part);
                    return Err(openai::map_reqwest_error(error, false));
                }
                Ok(Some(Ok(bytes))) => bytes,
            };
            if let Err(error) = std::io::Write::write_all(&mut file, &next) {
                drop(file);
                let _ = std::fs::remove_file(part);
                return Err(EngineError::new(
                    "写入下载文件失败。",
                    format!("请检查磁盘空间后重试；系统错误：{error}"),
                ));
            }
            reporter.advance(next.len() as u64);
        }
        let _ = std::io::Write::flush(&mut file);
        let _ = file.sync_all();
        Ok(())
    }
}

/// Cancellation remains observable while queued and is rechecked after acquisition.
async fn cancellable_projector_lock<'a>(
    lock: &'a tokio::sync::Mutex<()>,
    cancel: &AtomicBool,
) -> Result<tokio::sync::MutexGuard<'a, ()>, EngineError> {
    let acquire = lock.lock();
    tokio::pin!(acquire);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled_error());
        }
        if let Ok(guard) = tokio::time::timeout(Duration::from_millis(25), &mut acquire).await {
            if cancel.load(Ordering::SeqCst) {
                return Err(cancelled_error());
            }
            return Ok(guard);
        }
    }
}

fn cancelled_error() -> EngineError {
    EngineError::new("下载已取消。", "可随时重新开始下载。")
}

/// `rename` first (same volume) and fall back to copy+delete when the cache and
/// models directories live on different drives (`LEXORA_MODEL_DIR` override).
fn move_file(source: &Path, target: &Path) -> std::io::Result<()> {
    match std::fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(source, target)?;
            std::fs::remove_file(source)?;
            Ok(())
        }
    }
}

/// Extracts the directory containing `llama-server.exe` from the official
/// llama.cpp zip, flattening its contents into `engine_dir`.
fn extract_engine_zip(zip_path: &Path, engine_dir: &Path) -> Result<(), EngineError> {
    use std::io::Read;

    let file = std::fs::File::open(zip_path).map_err(|error| {
        EngineError::new(
            "无法读取引擎压缩包。",
            format!("下载文件可能已损坏，请重试；系统错误：{error}"),
        )
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        EngineError::new(
            "引擎压缩包格式无效。",
            format!("下载文件可能不完整，请重试；系统错误：{error}"),
        )
    })?;

    // Find the archive folder that contains llama-server.exe (usually
    // `llama-b11851/`). Everything outside that folder is ignored.
    let mut prefix: Option<String> = None;
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index(index) else {
            continue;
        };
        let name = entry.name().replace('\\', "/");
        if name.to_ascii_lowercase().ends_with("llama-server.exe") {
            prefix = Some(match name.rfind('/') {
                Some(position) => name[..=position].to_string(),
                None => String::new(),
            });
            break;
        }
    }
    let Some(prefix) = prefix else {
        return Err(EngineError::new(
            "引擎压缩包中未找到 llama-server.exe。",
            "请确认下载地址是 llama.cpp 官方 Windows 压缩包；也可手动解压后把文件放入 engine 目录。",
        ));
    };

    std::fs::create_dir_all(engine_dir).map_err(|error| {
        EngineError::new(
            "无法创建引擎目录。",
            format!("请检查目录权限；系统错误：{error}"),
        )
    })?;

    let mut extracted = 0usize;
    for index in 0..archive.len() {
        let mut entry = match archive.by_index(index) {
            Ok(entry) => entry,
            Err(error) => {
                return Err(EngineError::new(
                    "读取引擎压缩包内容失败。",
                    format!("下载文件可能不完整，请重试；系统错误：{error}"),
                ))
            }
        };
        let name = entry.name().replace('\\', "/");
        if !name.starts_with(&prefix) {
            continue;
        }
        let relative = name[prefix.len()..].trim_start_matches('/');
        if relative.is_empty() {
            continue;
        }
        let mut target = engine_dir.to_path_buf();
        let mut invalid = false;
        for component in relative.split('/') {
            if component.is_empty() || component == "." || component == ".." {
                invalid = true;
                break;
            }
            target.push(component);
        }
        if invalid {
            continue;
        }
        if entry.is_dir() {
            let _ = std::fs::create_dir_all(&target);
            continue;
        }
        if entry.size() > 512 * 1024 * 1024 {
            return Err(EngineError::new(
                "引擎压缩包内容异常。",
                "压缩包内单个文件超过 512MB，已中止解压；请重新下载官方引擎压缩包。",
            ));
        }
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut data = Vec::new();
        entry.read_to_end(&mut data).map_err(|error| {
            EngineError::new(
                "解压引擎文件失败。",
                format!("请检查磁盘空间后重试；系统错误：{error}"),
            )
        })?;
        std::fs::write(&target, &data).map_err(|error| {
            EngineError::new(
                "写入引擎文件失败。",
                format!("请检查磁盘空间与杀毒软件拦截；系统错误：{error}"),
            )
        })?;
        extracted += 1;
    }

    if extracted == 0 || !engine_dir.join("llama-server.exe").is_file() {
        return Err(EngineError::new(
            "引擎解压后缺少 llama-server.exe。",
            "压缩包结构可能已变化：请手动下载并解压到 engine 目录。",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    struct TestEnv {
        service: EngineService,
        store: Arc<SettingsStore>,
        paths: AppPaths,
        _dir: TempDir,
    }

    fn test_env() -> TestEnv {
        let dir = TempDir::new().unwrap();
        let data = dir.path().to_path_buf();
        let paths = AppPaths {
            data_dir: data.clone(),
            models_dir: data.join("models"),
            engine_dir: data.join("engine"),
            logs_dir: data.join("logs"),
            cache_dir: data.join("cache"),
            settings_file: data.join("settings.json"),
        };
        paths.ensure_dirs();
        let store = Arc::new(SettingsStore::load(paths.settings_file.clone()));
        let logger = Logger::new(&paths.logs_dir, "engine-test");
        let service = EngineService::new(paths.clone(), store.clone(), logger);
        TestEnv {
            service,
            store,
            paths,
            _dir: dir,
        }
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
            .block_on(future)
    }

    /// Registers a custom skill and enables (or disables) it in `picker.skills`.
    fn save_custom_skill(env: &TestEnv, skill_id: &str, prompt: &str, enabled: bool) {
        let mut skills = vec!["translate".to_string()];
        if enabled {
            skills.push(skill_id.to_string());
        }
        env.store
            .update_json(json!({
                "picker": {
                    "skills": skills,
                    "customSkills": [{
                        "id": skill_id,
                        "label": "测试技能",
                        "icon": "wand",
                        "prompt": prompt
                    }]
                }
            }))
            .unwrap();
    }

    #[test]
    fn logged_model_stream_records_chunks_output_and_completion() {
        let dir = TempDir::new().unwrap();
        let logger = Logger::new(dir.path(), "model");
        logger.info("model call start: id=1 operation=test provider=local model=stub");
        let inner: BoxStream<'static, Result<String, EngineError>> =
            Box::pin(futures_util::stream::iter(vec![
                Ok("ab".to_string()),
                Ok("c".to_string()),
            ]));
        let mut logged = LoggedModelStream {
            inner,
            logger: logger.clone(),
            call_id: 1,
            operation: "test".to_string(),
            started: Instant::now(),
            chunks: 0,
            output_chars: 0,
            finished: false,
        };
        block_on(async { while logged.next().await.is_some() {} });
        let text = std::fs::read_to_string(logger.path()).unwrap();
        assert!(text.contains("model call start"));
        assert!(text.contains("status=success"));
        assert!(text.contains("chunks=2"));
        assert!(text.contains("output_chars=3"));
    }
    #[test]
    fn active_selection_survives_settings_changes_until_cleared() {
        let env = test_env();
        for spec in &models::CATALOG {
            std::fs::write(env.paths.models_dir.join(spec.filename), b"fake").unwrap();
            if let Some(projector) = spec.mmproj {
                std::fs::write(env.paths.models_dir.join(projector.filename), b"fake").unwrap();
            }
        }
        let first = &models::CATALOG[1];
        let second = &models::CATALOG[3];
        *env.service.active_selection.lock().unwrap() = Some(first.id.to_string());
        env.service.local_desired.store(true, Ordering::Release);
        env.store
            .update_json(json!({"provider":{"local":{"selectedModel":second.id}}}))
            .unwrap();
        for role in [LocalRole::General, LocalRole::Vision] {
            assert_eq!(
                env.service.model_for_role(role).as_deref(),
                Some(first.filename)
            );
        }
        assert_eq!(
            env.service.model_for_role(LocalRole::Translate).as_deref(),
            Some(models::CATALOG[0].filename)
        );
        env.service.clear_local_selection();
        assert_eq!(
            env.service.model_for_role(LocalRole::General).as_deref(),
            Some(second.filename)
        );
        assert!(!env.service.local_desired.load(Ordering::Acquire));
    }

    #[test]
    fn failed_start_clears_snapshot_and_missing_selection_never_uses_translation() {
        block_on(async {
            let env = test_env();
            std::fs::write(
                env.paths.models_dir.join(models::CATALOG[0].filename),
                b"fake",
            )
            .unwrap();
            let error = env.service.start_local().await.unwrap_err();
            assert!(error.message.contains("选择"));
            assert!(env.service.active_selection.lock().unwrap().is_none());
            let spec = &models::CATALOG[1];
            std::fs::write(env.paths.models_dir.join(spec.filename), b"fake").unwrap();
            std::fs::write(
                env.paths.models_dir.join(spec.mmproj.unwrap().filename),
                b"fake",
            )
            .unwrap();
            env.store
                .update_json(json!({"provider":{"local":{"selectedModel":spec.id}}}))
                .unwrap();
            assert!(env.service.start_local().await.is_err()); // No engine binary installed.
            assert!(env.service.active_selection.lock().unwrap().is_none());
            assert!(!env.service.local_desired.load(Ordering::Acquire));
            assert!(
                !env.service
                    .chat_config(&env.store.get(), LocalRole::General)
                    .await
                    .unwrap()
                    .local
            );
        });
    }

    #[test]
    fn repeated_start_keeps_snapshot_and_stop_clears_it() {
        block_on(async {
            let env = test_env();
            *env.service.active_selection.lock().unwrap() = Some(models::CATALOG[1].id.to_string());
            env.service.local_desired.store(true, Ordering::Release);
            env.service.start_local().await.unwrap();
            assert_eq!(
                env.service.active_selection.lock().unwrap().as_deref(),
                Some(models::CATALOG[1].id)
            );
            env.service.stop_local().await.unwrap();
            assert!(env.service.active_selection.lock().unwrap().is_none());
        });
    }

    #[test]
    fn queued_projector_download_can_be_cancelled_without_releasing_lock() {
        block_on(async {
            let registry = Mutex::new(DownloadState::default());
            let (_, cancel, _) =
                reserve_download(&registry, "model", "queued", "weights", 1).unwrap();
            let lock = tokio::sync::Mutex::new(());
            let held = lock.lock().await;
            let waiter = cancellable_projector_lock(&lock, &cancel);
            tokio::pin!(waiter);
            assert!(tokio::time::timeout(Duration::from_millis(10), &mut waiter)
                .await
                .is_err());
            assert!(reserve_download(&registry, "model", "queued", "projector", 1).is_err());
            assert_eq!(cancel_tasks(&registry, Some("queued")).len(), 1);
            assert!(tokio::time::timeout(Duration::from_secs(1), &mut waiter)
                .await
                .unwrap()
                .is_err());
            drop(held);
            assert!(lock.try_lock().is_ok());
            assert!(cancellable_projector_lock(&lock, &cancel).await.is_err());
        });
    }

    #[test]
    fn projector_waiter_acquires_after_previous_task_and_cancel_all_reaches_queue() {
        block_on(async {
            let registry = Mutex::new(DownloadState::default());
            let (_, first, _) =
                reserve_download(&registry, "model", "first", "projector", 1).unwrap();
            let (_, second, _) =
                reserve_download(&registry, "model", "second", "projector", 1).unwrap();
            let lock = tokio::sync::Mutex::new(());
            let held = cancellable_projector_lock(&lock, &first).await.unwrap();
            let waiter = cancellable_projector_lock(&lock, &second);
            tokio::pin!(waiter);
            assert!(tokio::time::timeout(Duration::from_millis(10), &mut waiter)
                .await
                .is_err());
            drop(held);
            let acquired = tokio::time::timeout(Duration::from_secs(1), &mut waiter)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(cancel_tasks(&registry, None).len(), 2);
            assert!(second.load(Ordering::SeqCst));
            drop(acquired);
            assert!(cancellable_projector_lock(&lock, &second).await.is_err());
        });
    }

    #[test]
    fn service_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<EngineService>();
    }

    #[test]
    fn default_status_is_online_ready() {
        let env = test_env();
        let status = env.service.status();
        assert_eq!(status.mode, "online");
        assert!(status.ready);
        assert!(status.online_configured);
        assert!(status.hint.is_empty());
        assert_eq!(status.provider_label, "在线 · deepseek-chat");
        assert_eq!(status.local_state, "stopped");
        assert!(!status.engine_available);
        assert!(env.service.installed_models().is_empty());
    }

    #[test]
    fn serializes_status_fields_as_camel_case() {
        let env = test_env();
        let value = serde_json::to_value(env.service.status()).unwrap();
        for key in [
            "providerLabel",
            "onlineConfigured",
            "localState",
            "localModelFile",
            "localModelName",
            "localError",
            "engineAvailable",
        ] {
            assert!(value.get(key).is_some(), "missing status field {key}");
        }
        let local_state = value.get("localState").unwrap().as_str().unwrap();
        assert_eq!(local_state, LocalState::Stopped.as_str());
    }

    #[test]
    fn local_mode_without_engine_reports_actionable_hint() {
        let env = test_env();
        env.store
            .update_json(json!({"provider": {"mode": "local"}}))
            .unwrap();
        let status = env.service.status();
        assert_eq!(status.mode, "local");
        assert!(!status.ready);
        assert!(!status.engine_available);
        assert!(status.hint.contains("引擎"), "hint: {}", status.hint);
        assert!(status.provider_label.starts_with("本地"));
    }

    #[test]
    fn unselected_models_never_fall_back() {
        let env = test_env();
        for spec in &models::CATALOG {
            std::fs::write(env.paths.models_dir.join(spec.filename), b"fake").unwrap();
            if let Some(projector) = spec.mmproj {
                std::fs::write(env.paths.models_dir.join(projector.filename), b"fake").unwrap();
            }
        }
        std::fs::write(
            env.paths.models_dir.join("qwen2.5-3b-instruct-q4_k_m.gguf"),
            b"legacy",
        )
        .unwrap();
        assert_eq!(env.service.model_for_role(LocalRole::General), None);
        assert_eq!(env.service.model_for_role(LocalRole::Vision), None);
        assert!(!env.service.has_local_vision());
        assert_eq!(
            env.service.model_for_role(LocalRole::Translate),
            Some(models::CATALOG[0].filename.to_string())
        );
        assert!(env.store.get().provider.local.selected_model.is_empty());
    }

    #[test]
    fn local_mode_without_models_reports_download_hint() {
        let env = test_env();
        std::fs::write(env.paths.llama_binary(), b"stub").unwrap();
        env.store
            .update_json(json!({"provider": {"mode": "local"}}))
            .unwrap();
        let status = env.service.status();
        assert!(!status.ready);
        assert!(
            status.hint.contains("下载") || status.hint.contains("导入"),
            "hint: {}",
            status.hint
        );
        assert!(env.service.default_local_model().is_none());
    }

    #[test]
    fn model_roles_follow_manual_selection() {
        let env = test_env();
        for spec in &models::CATALOG {
            std::fs::write(env.paths.models_dir.join(spec.filename), b"fake").unwrap();
            if let Some(projector) = spec.mmproj {
                std::fs::write(env.paths.models_dir.join(projector.filename), b"fake").unwrap();
            }
        }
        for spec in models::CATALOG.iter().filter(|spec| spec.vision) {
            env.store
                .update_json(json!({"provider":{"local":{"selectedModel":spec.id}}}))
                .unwrap();
            assert_eq!(
                env.service.model_for_role(LocalRole::General),
                Some(spec.filename.to_string())
            );
            assert_eq!(
                env.service.model_for_role(LocalRole::Vision),
                Some(spec.filename.to_string())
            );
            assert_eq!(
                env.service.model_for_role(LocalRole::Translate),
                Some(models::CATALOG[0].filename.to_string())
            );
        }
    }

    #[test]
    fn selected_model_requires_both_files_for_text_and_vision() {
        let env = test_env();
        let spec = &models::CATALOG[2];
        let projector = spec.mmproj.unwrap();
        env.store
            .update_json(json!({"provider":{"local":{"selectedModel":spec.id}}}))
            .unwrap();
        std::fs::write(env.paths.models_dir.join(spec.filename), b"fake").unwrap();
        assert_eq!(env.service.model_for_role(LocalRole::General), None);
        assert_eq!(env.service.model_for_role(LocalRole::Vision), None);
        assert_eq!(env.service.model_for_role(LocalRole::Translate), None);
        std::fs::write(env.paths.models_dir.join(projector.filename), b"fake").unwrap();
        assert!(env.service.has_local_vision());
        assert_eq!(
            env.service.model_for_role(LocalRole::General),
            Some(spec.filename.to_string())
        );
        assert_eq!(
            env.service.model_for_role(LocalRole::Vision),
            Some(spec.filename.to_string())
        );
        assert_eq!(
            env.service.mmproj_for_model(spec.filename),
            Some(projector.filename.to_string())
        );
        assert_eq!(
            env.service.mmproj_for_model(models::CATALOG[0].filename),
            None
        );
        std::fs::remove_file(env.paths.models_dir.join(spec.filename)).unwrap();
        assert!(!env.service.has_local_vision());
    }

    #[test]
    fn installed_models_and_catalog_track_files() {
        let env = test_env();
        std::fs::write(
            env.paths.models_dir.join(models::CATALOG[1].filename),
            b"gguf-data",
        )
        .unwrap();
        let installed = env.service.installed_models();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].catalog_id, "qwen3.5-0.8b-q4-k-m");
        assert_eq!(installed[0].size_bytes, 9);

        let catalog = env.service.catalog();
        assert_eq!(catalog.len(), 7);
        assert!(!catalog[0].installed);
        assert!(!catalog[1].installed);
        assert_eq!(catalog[1].filename, models::CATALOG[1].filename);
        assert_eq!(catalog[2].id, "qwen3.5-0.8b-q3-k-m");
        assert!(catalog[2].vision);
        assert!(!catalog[2].installed);
    }

    #[test]
    fn catalogs_are_stable_without_files() {
        let env = test_env();
        let catalog = env.service.catalog();
        assert!(catalog.iter().all(|entry| !entry.installed));
        assert!(catalog.iter().any(|entry| entry.recommended));
        assert!(catalog.iter().any(|entry| entry.vision));
        let value = serde_json::to_value(&catalog[2]).unwrap();
        assert_eq!(
            value.get("vision").and_then(|value| value.as_bool()),
            Some(true)
        );
        // camelCase serialization feeds the settings page directly.
        assert!(value.get("sizeBytes").is_some());
        assert!(value.get("vision").is_some());
    }

    #[test]
    fn empty_translation_input_is_rejected() {
        let env = test_env();
        let error = block_on(env.service.translate_stream("   ", "zh"))
            .err()
            .expect("expected engine error");
        assert!(error.message.contains("没有可翻译"));
        assert!(!error.hint.is_empty());
    }

    #[test]
    fn empty_polish_input_is_rejected() {
        let env = test_env();
        let error = block_on(env.service.polish_stream("   "))
            .err()
            .expect("expected engine error");
        assert!(
            error.message.contains("没有可润色"),
            "message: {}",
            error.message
        );
        assert!(error.hint.contains("润色"), "hint: {}", error.hint);
    }

    #[test]
    fn polish_online_requires_configuration() {
        let env = test_env();
        env.store
            .update_json(json!({"provider": {"online": {"baseUrl": ""}}}))
            .unwrap();
        let error = block_on(env.service.polish_stream("hello"))
            .err()
            .expect("expected engine error");
        assert!(error.message.contains("配置"), "message: {}", error.message);
    }

    #[test]
    fn local_vision_without_model_reports_install_hint() {
        let env = test_env();
        std::fs::write(env.paths.llama_binary(), b"stub").unwrap();
        env.store
            .update_json(json!({"provider": {"mode": "local"}}))
            .unwrap();
        // No Qwen2.5-VL installed: the error must point at the download instead
        // of claiming "local models cannot read images" like before.
        let error = block_on(
            env.service
                .vision_stream("data:image/png;base64,AA", "解释这张图"),
        )
        .err()
        .expect("expected engine error");
        assert!(
            error.message.contains("本地视觉模型未安装"),
            "message: {}",
            error.message
        );
        assert!(
            error.hint.contains("Qwen3.5") && error.hint.contains("设置"),
            "hint: {}",
            error.hint
        );
        assert!(!env.service.has_local_vision());
    }

    #[test]
    fn local_vision_requires_started_engine() {
        let env = test_env();
        std::fs::write(env.paths.llama_binary(), b"stub").unwrap();
        let spec = &models::CATALOG[2];
        let mmproj = spec.mmproj.expect("vision model must ship a projector");
        std::fs::write(env.paths.models_dir.join(spec.filename), b"fake").unwrap();
        std::fs::write(env.paths.models_dir.join(mmproj.filename), b"fake").unwrap();
        env.store
            .update_json(json!({"provider":{"local":{"selectedModel":spec.id}}}))
            .unwrap();
        env.store
            .update_json(json!({"provider": {"mode": "local"}}))
            .unwrap();
        // Model installed but the engine was never started: the request must not
        // auto-start it (same rule as translation).
        assert!(env.service.has_local_vision());
        let error = block_on(
            env.service
                .vision_stream("data:image/png;base64,AA", "解释这张图"),
        )
        .err()
        .expect("expected engine error");
        assert!(
            error.message.contains("未启动"),
            "message: {}",
            error.message
        );
        assert!(error.hint.contains("启动"), "hint: {}", error.hint);
    }

    #[test]
    fn vision_online_requires_configuration() {
        let env = test_env();
        env.store
            .update_json(json!({"provider": {"online": {"baseUrl": ""}}}))
            .unwrap();
        let error = block_on(
            env.service
                .vision_stream("data:image/png;base64,AA", "解释这张图"),
        )
        .err()
        .expect("expected engine error");
        assert!(error.message.contains("配置"), "message: {}", error.message);
    }

    #[test]
    fn vision_followup_requires_a_question() {
        let env = test_env();
        let error = block_on(env.service.vision_followup_stream(
            "data:image/png;base64,AA",
            "previous answer",
            "   ",
            &[("first?".to_string(), "first answer".to_string())],
        ))
        .err()
        .expect("expected engine error");
        assert!(error.message.contains("问题"), "message: {}", error.message);
        assert!(!error.hint.is_empty());
    }

    #[test]
    fn vision_followup_online_requires_configuration() {
        let env = test_env();
        env.store
            .update_json(json!({"provider": {"online": {"baseUrl": ""}}}))
            .unwrap();
        let error = block_on(env.service.vision_followup_stream(
            "data:image/png;base64,AA",
            "previous answer",
            "为什么？",
            &[],
        ))
        .err()
        .expect("expected engine error");
        assert!(error.message.contains("配置"), "message: {}", error.message);
    }

    #[test]
    fn vision_followup_local_without_vision_model_reports_install_hint() {
        let env = test_env();
        std::fs::write(env.paths.llama_binary(), b"stub").unwrap();
        env.store
            .update_json(json!({"provider": {"mode": "local"}}))
            .unwrap();
        let error = block_on(env.service.vision_followup_stream(
            "data:image/png;base64,AA",
            "previous answer",
            "图片里还有什么？",
            &[],
        ))
        .err()
        .expect("expected engine error");
        assert!(
            error.message.contains("本地视觉模型未安装"),
            "message: {}",
            error.message
        );
        assert!(error.hint.contains("Qwen3.5"), "hint: {}", error.hint);
    }

    #[test]
    fn followup_requires_a_question() {
        let env = test_env();
        let error = block_on(env.service.followup_stream("text", "answer", "   ", &[]))
            .err()
            .expect("expected engine error");
        assert!(error.message.contains("问题"), "message: {}", error.message);
        assert!(!error.hint.is_empty());
    }

    #[test]
    fn followup_online_requires_configuration() {
        let env = test_env();
        env.store
            .update_json(json!({"provider": {"online": {"baseUrl": ""}}}))
            .unwrap();
        let history = vec![("first?".to_string(), "first answer".to_string())];
        let error = block_on(
            env.service
                .followup_stream("text", "answer", "为什么？", &history),
        )
        .err()
        .expect("expected engine error");
        assert!(error.message.contains("配置"), "message: {}", error.message);
    }

    #[test]
    fn custom_skill_must_exist_and_be_enabled() {
        let env = test_env();
        let error = block_on(
            env.service
                .custom_stream("custom-missing", "hello", "zh", "Code"),
        )
        .err()
        .expect("expected engine error");
        assert!(
            error.message.contains("技能不存在"),
            "message: {}",
            error.message
        );
        assert!(error.hint.contains("重新添加"), "hint: {}", error.hint);

        // A defined but disabled skill is rejected with its own hint.
        save_custom_skill(&env, "custom-disabled", "Explain {text}", false);
        let error = block_on(
            env.service
                .custom_stream("custom-disabled", "hello", "zh", "Code"),
        )
        .err()
        .expect("expected engine error");
        assert!(
            error.message.contains("技能未启用"),
            "message: {}",
            error.message
        );
        assert!(error.hint.contains("启用"), "hint: {}", error.hint);
    }

    #[test]
    fn custom_skill_rejects_empty_text() {
        let env = test_env();
        save_custom_skill(&env, "custom-empty", "Explain {text}", true);
        let error = block_on(
            env.service
                .custom_stream("custom-empty", "   ", "zh", "Code"),
        )
        .err()
        .expect("expected engine error");
        assert!(error.message.contains("没有可翻译"));
        assert!(!error.hint.is_empty());
    }

    #[test]
    fn custom_skill_requires_a_configured_provider() {
        let env = test_env();
        save_custom_skill(&env, "custom-lookup", "Explain {text}", true);
        env.store
            .update_json(json!({"provider": {"online": {"baseUrl": ""}}}))
            .unwrap();
        // Skill lookup and text checks pass, then provider resolution fails
        // before any HTTP request is made.
        let error = block_on(
            env.service
                .custom_stream("custom-lookup", "hello", "zh", "Code"),
        )
        .err()
        .expect("expected engine error");
        assert!(error.message.contains("配置"), "message: {}", error.message);
    }

    #[test]
    fn online_translation_requires_configuration() {
        let env = test_env();
        env.store
            .update_json(json!({"provider": {"online": {"baseUrl": ""}}}))
            .unwrap();
        let error = block_on(env.service.translate_stream("hello", "zh"))
            .err()
            .expect("expected engine error");
        assert!(error.message.contains("配置"), "message: {}", error.message);
        assert!(!error.hint.is_empty());
    }

    #[test]
    fn local_translation_requires_explicit_start() {
        let env = test_env();
        std::fs::write(env.paths.llama_binary(), b"stub").unwrap();
        std::fs::write(
            env.paths.models_dir.join(models::CATALOG[0].filename),
            b"fake",
        )
        .unwrap();
        env.store
            .update_json(json!({"provider": {"mode": "local"}}))
            .unwrap();
        // Translation must never auto-start the local engine (issue: after the
        // user pressed 停止 a request started it again).
        let error = block_on(env.service.translate_stream("hello", "zh"))
            .err()
            .expect("expected engine error");
        assert!(
            error.message.contains("未启动"),
            "message: {}",
            error.message
        );
        assert!(error.hint.contains("启动"));
    }

    #[test]
    fn start_local_without_engine_reports_download_hint() {
        let env = test_env();
        std::fs::write(
            env.paths.models_dir.join(models::CATALOG[1].filename),
            b"fake",
        )
        .unwrap();
        std::fs::write(
            env.paths
                .models_dir
                .join(models::CATALOG[1].mmproj.unwrap().filename),
            b"fake",
        )
        .unwrap();
        env.store
            .update_json(json!({"provider": {"mode": "local", "local": {"selectedModel": models::CATALOG[1].id}}}))
            .unwrap();
        let error = block_on(env.service.start_local()).unwrap_err();
        assert!(error.message.contains("引擎"), "message: {}", error.message);
        assert!(error.hint.contains("下载"));
        // A failed start leaves the engine in the stopped state.
        assert_eq!(env.service.status().local_state, "stopped");
        assert!(!env.store.get().provider.local.keep_running);
    }

    #[test]
    fn start_local_without_models_reports_install_hint() {
        let env = test_env();
        std::fs::write(env.paths.llama_binary(), b"stub").unwrap();
        env.store
            .update_json(json!({"provider": {"mode": "local"}}))
            .unwrap();
        let error = block_on(env.service.start_local()).unwrap_err();
        assert!(error.message.contains("模型"), "message: {}", error.message);
        assert!(error.hint.contains("下载") || error.hint.contains("导入"));
    }

    #[test]
    fn assist_validates_action_and_text() {
        let env = test_env();
        let error = block_on(env.service.assist("summarize", " "))
            .err()
            .expect("expected engine error");
        assert!(error.message.contains("没有可处理"));
        let error = block_on(env.service.assist("read", "text"))
            .err()
            .expect("expected engine error");
        assert!(
            error.message.contains("技能操作"),
            "message: {}",
            error.message
        );
    }

    #[test]
    fn assist_online_requires_configuration() {
        let env = test_env();
        env.store
            .update_json(json!({"provider": {"online": {"baseUrl": ""}}}))
            .unwrap();
        let error = block_on(env.service.assist("explain", "hello"))
            .err()
            .expect("expected engine error");
        assert!(error.message.contains("配置"), "message: {}", error.message);
    }

    #[test]
    fn test_online_rejects_empty_and_invalid_urls() {
        let env = test_env();
        let empty = block_on(env.service.test_online("", "", "deepseek-chat", 5_000));
        assert!(!empty.ok);
        assert!(empty.error.contains("不能为空"));
        assert!(!empty.hint.is_empty());

        let invalid = block_on(env.service.test_online("not a valid url", "", "", 5_000));
        assert!(!invalid.ok);
        assert!(!invalid.error.is_empty());
        assert!(!invalid.hint.is_empty());
    }

    #[test]
    fn list_online_models_rejects_empty_url() {
        let env = test_env();
        let error = block_on(env.service.list_online_models("", ""))
            .err()
            .expect("expected engine error");
        assert!(error.message.contains("不能为空"));
    }

    #[test]
    fn downloads_are_empty_initially_and_cancel_is_a_noop() {
        let env = test_env();
        assert!(env.service.download_state().is_empty());
        assert!(!env.service.has_download("engine", ""));
        env.service.cancel_download(None);
        assert!(env.service.download_state().is_empty());
    }

    #[test]
    fn download_keys_follow_the_registry_contract() {
        assert_eq!(download_key("engine", ""), "engine");
        // The engine id is always the empty string in the UI contract.
        assert_eq!(download_key("engine", "llama.cpp"), "engine");
        assert_eq!(download_key("model", "hy-mt2-1.8b"), "model:hy-mt2-1.8b");
    }

    #[test]
    fn concurrent_downloads_are_tracked_independently() {
        let state = Mutex::new(DownloadState::default());
        reserve_download(&state, "engine", "", "llama.zip", 0).unwrap();
        reserve_download(&state, "model", "hy-mt2-1.8b", "a.gguf", 10).unwrap();
        reserve_download(&state, "model", "qwen2.5-3b", "b.gguf", 20).unwrap();

        let guard = state.lock().unwrap();
        let downloads = download_list(&guard);
        assert_eq!(downloads.len(), 3);
        // Stable order: engine first, then models sorted by id.
        assert_eq!(downloads[0].kind, "engine");
        assert_eq!(downloads[0].id, "");
        assert_eq!(downloads[1].id, "hy-mt2-1.8b");
        assert_eq!(downloads[1].status, "downloading");
        assert_eq!(downloads[1].total, 10);
        assert_eq!(downloads[2].id, "qwen2.5-3b");
        assert_eq!(downloads[2].total, 20);
    }

    #[test]
    fn duplicate_downloads_of_the_same_id_are_rejected() {
        let state = Mutex::new(DownloadState::default());
        reserve_download(&state, "model", "hy-mt2-1.8b", "a.gguf", 1).unwrap();
        let error = reserve_download(&state, "model", "hy-mt2-1.8b", "a.gguf", 1).unwrap_err();
        assert!(
            error.message.contains("该模型正在下载中"),
            "message: {}",
            error.message
        );
        assert!(!error.hint.is_empty());

        // Different model ids and the engine may run concurrently.
        reserve_download(&state, "model", "qwen2.5-3b", "b.gguf", 1).unwrap();
        reserve_download(&state, "engine", "", "engine.zip", 0).unwrap();
        let error = reserve_download(&state, "engine", "", "engine.zip", 0).unwrap_err();
        assert!(
            error.message.contains("引擎正在下载中"),
            "message: {}",
            error.message
        );
    }

    #[test]
    fn cancel_by_id_only_stops_the_selected_download() {
        let state = Mutex::new(DownloadState::default());
        let (_, engine_cancel, _) =
            reserve_download(&state, "engine", "", "engine.zip", 0).unwrap();
        let (_, model_cancel, _) =
            reserve_download(&state, "model", "hy-mt2-1.8b", "a.gguf", 1).unwrap();
        let (_, other_cancel, _) =
            reserve_download(&state, "model", "qwen2.5-3b", "b.gguf", 1).unwrap();

        assert_eq!(
            cancel_tasks(&state, Some("hy-mt2-1.8b")),
            vec!["model:hy-mt2-1.8b".to_string()]
        );
        assert!(!engine_cancel.load(Ordering::SeqCst));
        assert!(model_cancel.load(Ordering::SeqCst));
        assert!(!other_cancel.load(Ordering::SeqCst));

        assert_eq!(
            cancel_tasks(&state, Some("engine")),
            vec!["engine".to_string()]
        );
        assert!(engine_cancel.load(Ordering::SeqCst));

        // Unknown ids cancel nothing.
        assert!(cancel_tasks(&state, Some("missing-model")).is_empty());
        assert!(!other_cancel.load(Ordering::SeqCst));

        // No id (or a blank id) cancels every registered task.
        assert_eq!(cancel_tasks(&state, Some("   ")).len(), 3);
        assert!(other_cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn finished_downloads_leave_the_registry() {
        let state = Mutex::new(DownloadState::default());
        reserve_download(&state, "model", "hy-mt2-1.8b", "a.gguf", 1).unwrap();
        assert_eq!(download_list(&state.lock().unwrap()).len(), 1);
        state.lock().unwrap().tasks.remove("model:hy-mt2-1.8b");
        assert!(download_list(&state.lock().unwrap()).is_empty());
    }

    #[test]
    fn engine_service_exposes_the_download_registry() {
        let env = test_env();
        assert!(env.service.download_state().is_empty());
        let (_, cancel, _) =
            reserve_download(&env.service.download, "model", "hy-mt2-1.8b", "a.gguf", 10).unwrap();
        assert!(env.service.has_download("model", "hy-mt2-1.8b"));
        assert!(!env.service.has_download("model", "other"));
        assert_eq!(env.service.download_state().len(), 1);

        env.service.cancel_download(Some("hy-mt2-1.8b"));
        assert!(cancel.load(Ordering::SeqCst));
        // The entry stays until its reporter finishes/drops.
        assert_eq!(env.service.download_state().len(), 1);
        env.service.download.lock().unwrap().tasks.clear();
        assert!(env.service.download_state().is_empty());
    }

    #[test]
    fn model_removal_only_deletes_unselected_residual_weights() {
        block_on(async {
            let env = test_env();
            for bad in [
                "../evil.gguf",
                "sub/model.gguf",
                "C:\\evil.gguf",
                "",
                "notes.txt",
            ] {
                assert!(env.service.remove_model_file(bad).await.is_err());
            }
            assert!(env.service.remove_model_file("missing.gguf").await.is_err());
            for file in [
                models::CATALOG[0].filename,
                "mmproj-old.gguf",
                models::CATALOG[1].filename,
            ] {
                let path = env.paths.models_dir.join(file);
                std::fs::write(&path, b"fake").unwrap();
                env.store
                    .update_json(
                        json!({"provider":{"local":{"selectedModel":models::CATALOG[1].id}}}),
                    )
                    .unwrap();
                assert!(env.service.remove_model_file(file).await.is_err());
                assert!(path.is_file());
            }
            let path = env.paths.models_dir.join("legacy.gguf");
            std::fs::write(&path, b"fake").unwrap();
            env.service.remove_model_file("legacy.gguf").await.unwrap();
            assert!(!path.exists());
            assert_eq!(
                env.store.get().provider.local.selected_model,
                models::CATALOG[1].id
            );
        });
    }

    #[test]
    fn removal_rejects_loading_weights_and_projector_without_stopping() {
        block_on(async {
            let env = test_env();
            env.service
                .local
                .set_test_loading_files("legacy.gguf", "projection.gguf");
            for file in ["legacy.gguf", "projection.gguf"] {
                let path = env.paths.models_dir.join(file);
                std::fs::write(&path, b"fake").unwrap();
                assert!(env.service.remove_model_file(file).await.is_err());
                assert!(path.is_file());
                assert!(env.service.local.is_running_file(file));
            }
        });
    }

    #[test]
    fn removal_and_restart_wait_for_lifecycle_lock() {
        block_on(async {
            let env = test_env();
            let path = env.paths.models_dir.join("legacy.gguf");
            std::fs::write(&path, b"fake").unwrap();
            let guard = env.service.local_lifecycle.lock().await;
            assert!(tokio::time::timeout(
                Duration::from_millis(20),
                env.service.remove_model_file("legacy.gguf")
            )
            .await
            .is_err());
            assert!(
                tokio::time::timeout(Duration::from_millis(20), env.service.restart_local())
                    .await
                    .is_err()
            );
            assert!(path.exists());
            drop(guard);
            env.service.remove_model_file("legacy.gguf").await.unwrap();
            assert!(!path.exists());
        });
    }

    #[test]
    fn restart_failure_clears_previous_lifecycle_and_uses_latest_selection() {
        block_on(async {
            let env = test_env();
            *env.service.active_selection.lock().unwrap() = Some(models::CATALOG[1].id.into());
            env.service.local_desired.store(true, Ordering::Release);
            env.store
                .update_json(json!({"provider":{"local":{"keepRunning":true,"selectedModel":""}}}))
                .unwrap();
            let error = tokio::time::timeout(Duration::from_secs(2), env.service.restart_local())
                .await
                .unwrap()
                .unwrap_err();
            assert!(error.message.contains("尚未选择"));
            assert!(!error.hint.is_empty());
            assert!(!env.service.local_desired.load(Ordering::Acquire));
            assert!(env.service.active_selection.lock().unwrap().is_none());
            assert!(!env.store.get().provider.local.keep_running);
            assert_eq!(env.service.local.snapshot().state, LocalState::Stopped);
            let spec = &models::CATALOG[3];
            std::fs::write(env.paths.models_dir.join(spec.filename), b"fake").unwrap();
            std::fs::write(
                env.paths.models_dir.join(spec.mmproj.unwrap().filename),
                b"fake",
            )
            .unwrap();
            env.store
                .update_json(json!({"provider":{"local":{"selectedModel":spec.id}}}))
                .unwrap();
            let error = env.service.restart_local().await.unwrap_err();
            assert!(!error.hint.is_empty());
            assert!(!env.service.local_desired.load(Ordering::Acquire));
            assert!(!env.store.get().provider.local.keep_running);
            assert_eq!(env.service.local.snapshot().state, LocalState::Stopped);
        });
    }

    #[test]
    fn legacy_imports_and_incomplete_selection_never_start_as_fallback() {
        let env = test_env();
        for file in [
            "qwen2.5-3b-instruct-q4_k_m.gguf",
            "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
            "custom.gguf",
        ] {
            std::fs::write(env.paths.models_dir.join(file), b"fake").unwrap();
        }
        assert_eq!(env.service.model_for_role(LocalRole::Translate), None);
        assert_eq!(env.service.default_local_model(), None);
        std::fs::write(
            env.paths.models_dir.join(models::CATALOG[0].filename),
            b"translation",
        )
        .unwrap();
        env.store
            .update_json(json!({"provider":{"local":{"selectedModel":models::CATALOG[1].id}}}))
            .unwrap();
        assert_eq!(env.service.default_local_model(), None);
        let error = block_on(env.service.start_local()).unwrap_err();
        assert!(error.hint.contains("手动选择 Qwen3.5"));
        assert!(error.hint.contains("视觉投影器"));
        assert_eq!(env.service.installed_models().len(), 4);
    }

    #[test]
    fn import_rejects_non_gguf_and_bad_magic() {
        let env = test_env();
        let text_file = env.paths.data_dir.join("model.txt");
        std::fs::write(&text_file, b"hello").unwrap();
        let error = block_on(env.service.import_model(text_file))
            .err()
            .expect("expected engine error");
        assert!(error.message.contains("gguf") || error.message.contains("GGUF"));

        let bad_gguf = env.paths.data_dir.join("bad.gguf");
        std::fs::write(&bad_gguf, b"not-gguf-magic").unwrap();
        let error = block_on(env.service.import_model(bad_gguf))
            .err()
            .expect("expected engine error");
        assert!(error.message.contains("GGUF"));
    }

    #[test]
    fn import_copies_model_and_dedupes_names() {
        let env = test_env();
        let source = env.paths.data_dir.join("custom.gguf");
        std::fs::write(&source, b"GGUF\x03\x00rest").unwrap();

        let first = block_on(env.service.import_model(source.clone())).unwrap();
        assert_eq!(first.file, "custom.gguf");
        assert_eq!(first.name, "custom");
        assert!(env.paths.models_dir.join("custom.gguf").is_file());

        let second = block_on(env.service.import_model(source)).unwrap();
        assert_eq!(second.file, "custom (1).gguf");
        let models = env.service.installed_models();
        assert_eq!(models.len(), 2);
        assert!(models.iter().all(|model| model.catalog_id.is_empty()));
    }

    #[test]
    fn paths_are_exposed() {
        let env = test_env();
        assert_eq!(env.service.models_dir(), env.paths.models_dir.as_path());
        assert_eq!(env.service.engine_dir(), env.paths.engine_dir.as_path());
        assert!(!env.service.engine_installed());
        std::fs::write(env.paths.llama_binary(), b"stub").unwrap();
        assert!(env.service.engine_installed());
    }

    #[test]
    fn progress_percent_is_clamped_and_rounded() {
        assert_eq!(percent(0, 0), 0.0);
        assert_eq!(percent(50, 100), 50.0);
        assert_eq!(percent(1, 3), 33.3);
        assert_eq!(percent(100, 100), 100.0);
        assert_eq!(percent(200, 100), 100.0);
        assert_eq!(percent(1, 1_000_000), 0.0);
    }

    #[test]
    fn stop_local_is_idempotent() {
        let env = test_env();
        block_on(env.service.stop_local()).unwrap();
        block_on(env.service.stop_local()).unwrap();
        assert_eq!(env.service.status().local_state, "stopped");
        assert!(!env.store.get().provider.local.keep_running);
    }

    #[test]
    fn extracts_engine_zip_and_flattens_folder() {
        use std::io::Write;

        let env = test_env();
        let zip_path = env.paths.cache_dir.join("engine.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer
            .start_file("llama-b999/llama-server.exe", options)
            .unwrap();
        writer.write_all(b"binary").unwrap();
        writer.start_file("llama-b999/ggml.dll", options).unwrap();
        writer.write_all(b"dll").unwrap();
        writer
            .start_file("llama-b999/sub/ghost.exe", options)
            .unwrap();
        writer.write_all(b"nested").unwrap();
        writer.start_file("README.md", options).unwrap();
        writer.write_all(b"readme").unwrap();
        writer.finish().unwrap();

        extract_engine_zip(&zip_path, &env.paths.engine_dir).unwrap();
        assert!(env.paths.engine_dir.join("llama-server.exe").is_file());
        assert!(env.paths.engine_dir.join("ggml.dll").is_file());
        assert!(env.paths.engine_dir.join("sub").join("ghost.exe").is_file());
        // Files outside the llama-server folder are not copied.
        assert!(!env.paths.engine_dir.join("README.md").exists());
    }

    #[test]
    fn engine_zip_without_server_is_rejected() {
        use std::io::Write;

        let env = test_env();
        let zip_path = env.paths.cache_dir.join("bad-engine.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer.start_file("random/file.txt", options).unwrap();
        writer.write_all(b"not an engine").unwrap();
        writer.finish().unwrap();

        let error = extract_engine_zip(&zip_path, &env.paths.engine_dir).unwrap_err();
        assert!(error.message.contains("llama-server.exe"));
        assert!(!error.hint.is_empty());
    }

    /// Optional developer smoke test (not run by CI).
    ///
    /// ```text
    /// $env:LEXORA_LLAMA_DIR="...\vendor\llama"
    /// $env:LEXORA_MODEL_DIR="...\models"
    /// cargo test manual_local_engine_smoke -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "manual smoke test: needs a real llama.cpp engine and GGUF model"]
    fn manual_local_engine_smoke() {
        let Ok(engine_dir) = std::env::var("LEXORA_LLAMA_DIR") else {
            eprintln!("skip: LEXORA_LLAMA_DIR is not set");
            return;
        };
        let Ok(models_dir) = std::env::var("LEXORA_MODEL_DIR") else {
            eprintln!("skip: LEXORA_MODEL_DIR is not set");
            return;
        };
        let dir = TempDir::new().unwrap();
        let data = dir.path().to_path_buf();
        let paths = AppPaths {
            data_dir: data.clone(),
            models_dir: PathBuf::from(models_dir),
            engine_dir: PathBuf::from(engine_dir),
            logs_dir: data.join("logs"),
            cache_dir: data.join("cache"),
            settings_file: data.join("settings.json"),
        };
        paths.ensure_dirs();
        let store = Arc::new(SettingsStore::load(paths.settings_file.clone()));
        store
            .update_json(json!({
                "provider": {
                    "mode": "local",
                    "local": {"contextSize": 2048, "threads": 4}
                }
            }))
            .unwrap();
        let logger = Logger::new(&paths.logs_dir, "engine-smoke");
        let service = EngineService::new(paths.clone(), store, logger);
        block_on(async {
            service
                .start_local()
                .await
                .expect("llama-server should start within 90s");
            assert_eq!(service.status().local_state, "ready");

            let mut stream = service
                .translate_stream("Hello, world!", "zh")
                .await
                .expect("translation stream should start");
            let mut output = String::new();
            let deadline = Instant::now() + Duration::from_secs(180);
            while let Some(item) = futures_util::StreamExt::next(&mut stream).await {
                match item {
                    Ok(text) => output.push_str(&text),
                    Err(error) => panic!("stream error: {} / {}", error.message, error.hint),
                }
                if Instant::now() > deadline {
                    panic!("translation timed out");
                }
                if output.chars().count() > 80 {
                    break;
                }
            }
            eprintln!("smoke translation: {}", output.trim());
            assert!(
                !output.trim().is_empty(),
                "expected a non-empty translation"
            );

            let summary = service
                .assist("summarize", "Lexora is a selection translator for Windows.")
                .await
                .expect("assist should succeed");
            eprintln!("smoke summary: {}", summary.trim());
            assert!(!summary.trim().is_empty());

            service.stop_local().await.unwrap();
            assert_eq!(service.status().local_state, "stopped");
        });
    }
}
