//! Local llama.cpp server lifecycle (`llama-server.exe`).
//!
//! One server process at a time. The manager owns:
//! * the `Child` handle,
//! * the state machine exposed as `stopped | starting | ready | error`,
//! * the loopback port and base URL handed to the OpenAI-compatible client,
//! * log redirection into ``<data>/logs/llama.log``.
//!
//! Startup validates engine/model paths, picks a free loopback port, spawns the
//! process without a console window, then polls `/health` for at most 90s while
//! watching for an early exit. `stop()` (and `Drop`) always terminate the child.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::engine::models::model_display_name;
use crate::engine::EngineError;
use crate::logger::Logger;
use crate::paths::AppPaths;
use crate::settings::Settings;

/// How long the model is allowed to load before startup is declared failed.
pub const START_TIMEOUT: Duration = Duration::from_secs(90);
const HEALTH_INTERVAL: Duration = Duration::from_millis(300);
const HEALTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const LLAMA_LOG_FILE: &str = "llama.log";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Exposed to the UI as `localState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalState {
    Stopped,
    Starting,
    Ready,
    Error,
}

impl LocalState {
    pub fn as_str(self) -> &'static str {
        match self {
            LocalState::Stopped => "stopped",
            LocalState::Starting => "starting",
            LocalState::Ready => "ready",
            LocalState::Error => "error",
        }
    }
}

/// Copy of the runtime fields needed by `EngineService::status()`.
#[derive(Debug, Clone)]
pub struct LocalSnapshot {
    pub state: LocalState,
    pub port: u16,
    pub model_file: String,
    pub model_name: String,
    pub error: String,
}

#[cfg(test)]
impl LocalSnapshot {
    fn stopped() -> Self {
        Self {
            state: LocalState::Stopped,
            port: 0,
            model_file: String::new(),
            model_name: String::new(),
            error: String::new(),
        }
    }
}

struct Runtime {
    child: Option<Child>,
    state: LocalState,
    port: u16,
    model_file: String,
    model_name: String,
    error: String,
}

impl Runtime {
    fn new() -> Self {
        Self {
            child: None,
            state: LocalState::Stopped,
            port: 0,
            model_file: String::new(),
            model_name: String::new(),
            error: String::new(),
        }
    }
}

/// Process manager for the bundled llama.cpp server.
pub struct LocalServer {
    runtime: Mutex<Runtime>,
    /// Serializes `ensure_ready` so two translations cannot race a spawn.
    start_lock: tokio::sync::Mutex<()>,
}

impl LocalServer {
    pub fn new() -> Self {
        Self {
            runtime: Mutex::new(Runtime::new()),
            start_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Runtime> {
        self.runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Current state; also notices a child that died after becoming ready.
    pub fn snapshot(&self) -> LocalSnapshot {
        let mut runtime = self.lock();
        if matches!(runtime.state, LocalState::Starting | LocalState::Ready) {
            if let Some(child) = runtime.child.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    runtime.state = LocalState::Error;
                    runtime.error = format!("本地引擎进程已退出（{}）。", describe_exit(&status));
                    runtime.child = None;
                }
            }
        }
        LocalSnapshot {
            state: runtime.state,
            port: runtime.port,
            model_file: runtime.model_file.clone(),
            model_name: runtime.model_name.clone(),
            error: runtime.error.clone(),
        }
    }

    /// Base URL for the OpenAI-compatible client when the server is ready.
    pub fn base_url(&self) -> Option<String> {
        let snapshot = self.snapshot();
        if snapshot.state == LocalState::Ready && snapshot.port != 0 {
            Some(format!("http://127.0.0.1:{}/v1", snapshot.port))
        } else {
            None
        }
    }

    pub fn is_running_model(&self, model_file: &str) -> bool {
        let runtime = self.lock();
        runtime.state == LocalState::Ready
            && runtime.model_file.eq_ignore_ascii_case(model_file.trim())
    }

    /// Starts (or reuses) the server and returns the base URL.
    pub async fn ensure_ready(
        &self,
        paths: &AppPaths,
        settings: &Settings,
        http: &reqwest::Client,
        logger: &Logger,
    ) -> Result<String, EngineError> {
        let _guard = self.start_lock.lock().await;

        let snapshot = self.snapshot();
        if snapshot.state == LocalState::Ready {
            if let Some(url) = self.base_url() {
                return Ok(url);
            }
        }

        let binary = paths.llama_binary();
        if !binary.is_file() {
            return Err(EngineError::new(
                "尚未安装本地引擎（llama-server.exe）。",
                "请在「设置 → 翻译服务 → 本地模型」中下载引擎，或切换到在线模式。",
            ));
        }

        let local = &settings.provider.local;
        let model_file = local.model_file.trim().to_string();
        if model_file.is_empty() {
            return Err(EngineError::new(
                "尚未选择本地模型。",
                "请先下载或导入 GGUF 模型，并在「本地模型」下拉框中选择一个。",
            ));
        }
        let model_path = paths.models_dir.join(&model_file);
        if !model_path.is_file() {
            return Err(EngineError::new(
                format!("本地模型文件不存在：{model_file}。"),
                "请在「设置 → 本地模型」中重新下载或导入 GGUF 文件。",
            ));
        }

        // Drop a stale process (crashed, errored, or another model) first.
        self.stop(Some(logger));

        let port = free_port()?;
        let context_size = local.context_size.clamp(1024, 32_768);
        let threads = resolve_threads(local.threads);
        let gpu_layers = local.gpu_layers.min(200);
        let log_path = paths.logs_dir.join(LLAMA_LOG_FILE);
        logger.info(&format!(
            "starting llama-server: model={model_file} port={port} ctx={context_size} threads={threads} ngl={gpu_layers}"
        ));
        let child = spawn_server(
            &binary,
            &model_path,
            port,
            context_size,
            threads,
            gpu_layers,
            &log_path,
        )
        .map_err(|error| {
            self.fail(
                "无法启动本地引擎（llama-server.exe）。",
                format!(
                    "请确认引擎文件完整且未被杀毒软件拦截；可停止后重试或重新下载引擎。系统错误：{error}"
                ),
            )
        })?;

        {
            let mut runtime = self.lock();
            runtime.child = Some(child);
            runtime.state = LocalState::Starting;
            runtime.port = port;
            runtime.model_file = model_file.clone();
            runtime.model_name = model_display_name(&model_file);
            runtime.error.clear();
        }

        let health_url = format!("http://127.0.0.1:{port}/health");
        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            if Instant::now() >= deadline {
                let error = self.fail(
                    "本地引擎启动超时（90 秒）。",
                    "首次加载模型可能需要较长时间：请确认内存充足后重试，或查看 logs/llama.log 获取详情。",
                );
                logger.error(&format!("llama-server start timeout: {health_url}"));
                return Err(error);
            }
            if let Some(exit) = self.take_exit_status() {
                let error = self.fail(
                    "本地引擎启动失败（进程已退出）。",
                    format!(
                        "请查看 logs/llama.log 获取详细原因（{exit}）。可尝试更小的模型，或重新下载引擎。"
                    ),
                );
                logger.error(&format!("llama-server exited during startup: {exit}"));
                return Err(error);
            }
            let healthy = match http
                .get(&health_url)
                .timeout(HEALTH_REQUEST_TIMEOUT)
                .send()
                .await
            {
                Ok(response) => response.status().is_success(),
                Err(_) => false,
            };
            if healthy {
                {
                    let mut runtime = self.lock();
                    runtime.state = LocalState::Ready;
                    runtime.error.clear();
                }
                logger.info(&format!("llama-server ready at http://127.0.0.1:{port}/v1"));
                return Ok(format!("http://127.0.0.1:{port}/v1"));
            }
            tokio::time::sleep(HEALTH_INTERVAL).await;
        }
    }

    /// Terminates the child process (idempotent).
    pub fn stop(&self, logger: Option<&Logger>) {
        let mut runtime = self.lock();
        let was_active = runtime.state != LocalState::Stopped || runtime.child.is_some();
        if let Some(mut child) = runtime.child.take() {
            kill_child(&mut child);
        }
        *runtime = Runtime::new();
        drop(runtime);
        if was_active {
            if let Some(logger) = logger {
                logger.info("llama-server stopped");
            }
        }
    }

    /// Records an error state and kills the child; returns the built error.
    fn fail(&self, message: impl Into<String>, hint: impl Into<String>) -> EngineError {
        let message = message.into();
        let hint = hint.into();
        {
            let mut runtime = self.lock();
            if let Some(mut child) = runtime.child.take() {
                kill_child(&mut child);
            }
            runtime.state = LocalState::Error;
            runtime.error = message.clone();
        }
        EngineError::new(message, hint)
    }

    /// Returns a description of the exit status when the child already died.
    fn take_exit_status(&self) -> Option<String> {
        let mut runtime = self.lock();
        let child = runtime.child.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => {
                runtime.child = None;
                runtime.state = LocalState::Error;
                let description = describe_exit(&status);
                runtime.error = format!("本地引擎进程已退出（{description}）。");
                Some(description)
            }
            _ => None,
        }
    }
}

impl Default for LocalServer {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for LocalServer {
    fn drop(&mut self) {
        let mut runtime = self.lock();
        if let Some(mut child) = runtime.child.take() {
            kill_child(&mut child);
        }
        runtime.state = LocalState::Stopped;
    }
}

fn kill_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn describe_exit(status: &ExitStatus) -> String {
    match status.code() {
        Some(code) => format!("退出码 {code}"),
        None => "进程被强制结束".to_string(),
    }
}

/// Chooses `-t`: the user value when set, otherwise half the logical CPUs
/// clamped to a sensible 2..=8 range.
pub fn resolve_threads(configured: u32) -> u32 {
    if configured > 0 {
        return configured.clamp(1, 128);
    }
    let cpus = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4) as u32;
    (cpus / 2).clamp(2, 8)
}

/// Binds `127.0.0.1:0` to find a free port, then releases it for llama-server.
pub fn free_port() -> Result<u16, EngineError> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        EngineError::new(
            "无法分配本地端口。",
            format!("请检查防火墙或网络设置后重试；系统错误：{error}"),
        )
    })?;
    let port = listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| {
            EngineError::new(
                "无法获取本地端口。",
                format!("请重启应用后重试；系统错误：{error}"),
            )
        })?;
    drop(listener);
    Ok(port)
}

fn spawn_server(
    binary: &Path,
    model: &Path,
    port: u16,
    context_size: u32,
    threads: u32,
    gpu_layers: u32,
    log_path: &Path,
) -> std::io::Result<Child> {
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)?;
    let _ = writeln!(
        log,
        "\n=== llama-server start (port {port}, ctx {context_size}, threads {threads}, ngl {gpu_layers}) ==="
    );
    let stdout = log.try_clone()?;
    let stderr = log.try_clone()?;

    let mut command = Command::new(binary);
    command
        .arg("-m")
        .arg(model)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("-c")
        .arg(context_size.to_string())
        .arg("-t")
        .arg(threads.to_string())
        .arg("-ngl")
        .arg(gpu_layers.to_string())
        .arg("--no-webui")
        .current_dir(binary.parent().unwrap_or_else(|| Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_strings_match_contract() {
        assert_eq!(LocalState::Stopped.as_str(), "stopped");
        assert_eq!(LocalState::Starting.as_str(), "starting");
        assert_eq!(LocalState::Ready.as_str(), "ready");
        assert_eq!(LocalState::Error.as_str(), "error");
    }

    #[test]
    fn fresh_server_is_stopped() {
        let server = LocalServer::new();
        let snapshot = server.snapshot();
        assert_eq!(snapshot.state, LocalState::Stopped);
        assert_eq!(snapshot.port, 0);
        assert!(snapshot.error.is_empty());
        assert!(server.base_url().is_none());
        assert!(!server.is_running_model("qwen2.5-1.5b-instruct-q4_k_m.gguf"));
    }

    #[test]
    fn stop_on_fresh_server_is_idempotent() {
        let server = LocalServer::new();
        server.stop(None);
        server.stop(None);
        assert_eq!(server.snapshot().state, LocalState::Stopped);
    }

    #[test]
    fn thread_defaults_are_sane() {
        assert_eq!(resolve_threads(4), 4);
        assert_eq!(resolve_threads(1), 1);
        assert_eq!(resolve_threads(500), 128);
        let automatic = resolve_threads(0);
        assert!((2..=8).contains(&automatic), "auto threads = {automatic}");
    }

    #[test]
    fn free_port_is_usable() {
        let port = free_port().expect("should find a free port");
        assert!(port > 1024);
        // The port must actually be bindable again.
        let listener = std::net::TcpListener::bind(("127.0.0.1", port));
        assert!(listener.is_ok(), "port {port} should be free");
    }

    #[test]
    fn snapshot_of_stopped_server_has_empty_model() {
        let snapshot = LocalSnapshot::stopped();
        assert_eq!(snapshot.state, LocalState::Stopped);
        assert!(snapshot.model_file.is_empty());
        assert!(snapshot.model_name.is_empty());
    }
}
