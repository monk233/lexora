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

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Mutex;
#[cfg(windows)]
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

use crate::engine::models::model_display_name;
use crate::engine::EngineError;
use crate::logger::Logger;
use crate::paths::AppPaths;
use crate::settings::Settings;

/// How long the model is allowed to load before startup is declared failed.
pub const START_TIMEOUT: Duration = Duration::from_secs(90);
const HEALTH_INTERVAL: Duration = Duration::from_millis(300);
const HEALTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

/// Pid of the running server, written next to the settings file so a crashed
/// app run cannot leak an orphan `llama-server.exe` forever.
const PID_FILE_NAME: &str = "llama-server.pid";

/// Minimum context size for vision models: image tokens can easily consume
/// several thousand positions, so the configured value is raised to this floor
/// (and logged) when a multimodal projector is loaded.
pub const VISION_MIN_CONTEXT: u32 = 8_192;

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
    /// Multimodal projector currently loaded by the server (empty for text-only
    /// models). Switching either the model or the projector restarts it.
    pub mmproj_file: String,
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
            mmproj_file: String::new(),
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
    mmproj_file: String,
    pid_file: Option<PathBuf>,
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
            mmproj_file: String::new(),
            pid_file: None,
            error: String::new(),
        }
    }
}

/// Process manager for the bundled llama.cpp server.
pub struct LocalServer {
    runtime: Mutex<Runtime>,
    /// Serializes `ensure_model` so two requests cannot race a spawn.
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
            mmproj_file: runtime.mmproj_file.clone(),
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

    /// `true` when the ready server can serve `model_file` without a restart.
    /// Text requests reuse a server that already loaded a projector (loading it
    /// again would only cost memory), while vision requests require one.
    pub fn is_running_for(&self, model_file: &str, need_vision: bool) -> bool {
        let runtime = self.lock();
        runtime.state == LocalState::Ready
            && runtime.model_file.eq_ignore_ascii_case(model_file.trim())
            && (!need_vision || !runtime.mmproj_file.trim().is_empty())
    }

    /// `true` when the ready server already runs exactly this model + projector
    /// combination. `mmproj_file = None` (or blank) means a text-only server;
    /// loading a vision projector and loading none are different configurations
    /// and therefore force a restart.
    pub fn is_running_model(&self, model_file: &str, mmproj_file: Option<&str>) -> bool {
        let runtime = self.lock();
        runtime.state == LocalState::Ready
            && runtime.model_file.eq_ignore_ascii_case(model_file.trim())
            && runtime
                .mmproj_file
                .eq_ignore_ascii_case(mmproj_file.map(str::trim).unwrap_or(""))
    }

    /// `true` when `file` is the weights **or** the projector of the running
    /// server. Deletion must reject these files without stopping the server.
    pub fn is_running_file(&self, file: &str) -> bool {
        let runtime = self.lock();
        let file = file.trim();
        (runtime.state == LocalState::Ready || runtime.state == LocalState::Starting)
            && (runtime.model_file.eq_ignore_ascii_case(file)
                || runtime.mmproj_file.eq_ignore_ascii_case(file))
    }

    #[cfg(test)]
    pub(super) fn set_test_loading_files(&self, weights: &str, projector: &str) {
        let mut runtime = self.lock();
        runtime.state = LocalState::Starting;
        runtime.model_file = weights.to_string();
        runtime.mmproj_file = projector.to_string();
    }

    /// Starts (or reuses) the server for `model_file` and returns the base URL.
    /// `need_vision` decides whether the multimodal projector is loaded: text
    /// requests start a text-only server (lower memory) and vision requests
    /// restart it with the projector. A different running model is stopped
    /// first (role-based model switching).
    pub async fn ensure_model(
        &self,
        paths: &AppPaths,
        settings: &Settings,
        model_file: &str,
        mmproj_file: Option<&str>,
        need_vision: bool,
        http: &reqwest::Client,
        logger: &Logger,
    ) -> Result<String, EngineError> {
        let _guard = self.start_lock.lock().await;
        let model_file = model_file.trim().to_string();
        let mmproj_file = mmproj_file
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if model_file.is_empty() {
            return Err(EngineError::new(
                "尚未安装本地模型。",
                "请先在「设置 → 本地模型」手动选择并完整安装 Qwen3.5 模型及视觉投影器。",
            ));
        }

        let snapshot = self.snapshot();
        if self.is_running_for(&model_file, need_vision) {
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

        let model_path = paths.models_dir.join(&model_file);
        if !model_path.is_file() {
            return Err(EngineError::new(
                format!("本地模型文件不存在：{model_file}。"),
                "请在「设置 → 本地模型」中重新下载或导入 GGUF 文件。",
            ));
        }

        let mmproj_path = match (need_vision, mmproj_file.as_deref()) {
            (true, Some(file)) => {
                let path = paths.models_dir.join(file);
                if !path.is_file() {
                    return Err(EngineError::new(
                        format!("视觉投影器文件不存在：{file}。"),
                        "请在「设置 → 本地模型」中重新下载所选 Qwen3.5 的视觉投影器，或重新下载该模型。",
                    ));
                }
                Some(path)
            }
            _ => None,
        };

        if !snapshot.model_file.is_empty()
            && (!snapshot.model_file.eq_ignore_ascii_case(&model_file)
                || !snapshot
                    .mmproj_file
                    .eq_ignore_ascii_case(mmproj_file.as_deref().unwrap_or("")))
        {
            logger.info(&format!(
                "switching local model: {} + {} -> {model_file} + {}",
                snapshot.model_file,
                if snapshot.mmproj_file.is_empty() {
                    "(text)"
                } else {
                    snapshot.mmproj_file.as_str()
                },
                mmproj_file.as_deref().unwrap_or("(text)")
            ));
        }

        // Drop a stale process (crashed, errored, or another configuration) first.
        self.stop(Some(logger));

        let local = &settings.provider.local;
        let port = free_port()?;
        let context_size = effective_context_size(local.context_size, need_vision);
        if need_vision && context_size != local.context_size.clamp(1024, 32_768) {
            logger.info(&format!(
                "vision model context raised to {context_size} (configured {})",
                local.context_size
            ));
        }
        let threads = resolve_threads(local.threads);
        let gpu_layers = local.gpu_layers.min(200);
        logger.info(&format!(
            "starting llama-server: model={model_file} mmproj={} port={port} ctx={context_size} threads={threads} ngl={gpu_layers}",
            mmproj_file.as_deref().unwrap_or("-")
        ));
        let child = spawn_server(
            &binary,
            &model_path,
            mmproj_path.as_deref(),
            port,
            context_size,
            threads,
            gpu_layers,
            logger.clone(),
        )
        .map_err(|error| {
            self.fail(
                "无法启动本地引擎（llama-server.exe）。",
                format!(
                    "请确认引擎文件完整且未被拦截；可停止后重试或重新下载引擎。系统错误：{error}"
                ),
            )
        })?;

        let server_pid = child.id();
        {
            let mut runtime = self.lock();
            runtime.child = Some(child);
            runtime.state = LocalState::Starting;
            runtime.port = port;
            runtime.model_file = model_file.clone();
            runtime.model_name = model_display_name(&model_file);
            runtime.mmproj_file = mmproj_file.clone().unwrap_or_default();
            runtime.error.clear();
            let pid_file = paths.data_dir.join(PID_FILE_NAME);
            if let Err(error) = std::fs::write(&pid_file, server_pid.to_string()) {
                logger.warn(&format!(
                    "could not record llama-server pid ({}): {error}",
                    pid_file.display()
                ));
            } else {
                runtime.pid_file = Some(pid_file);
            }
        }

        let health_url = format!("http://127.0.0.1:{port}/health");
        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            if Instant::now() >= deadline {
                let error = self.fail(
                    "本地引擎启动超时（90 秒）。",
                    "首次加载模型可能较慢：请确认内存充足后重试，或查看 logs/llama.log。",
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
        if let Some(pid_file) = runtime.pid_file.take() {
            let _ = std::fs::remove_file(pid_file);
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
            if let Some(pid_file) = runtime.pid_file.take() {
                let _ = std::fs::remove_file(pid_file);
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

/// Kills a `llama-server.exe` left behind by an earlier crashed/exited run.
/// Only a process whose image is exactly this app's engine binary is touched,
/// so an unrelated process that reused the recorded pid is never killed.
pub fn cleanup_stale_server(paths: &AppPaths, logger: &Logger) -> Option<u32> {
    let pid_file = paths.data_dir.join(PID_FILE_NAME);
    let pid = std::fs::read_to_string(&pid_file)
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok());
    let killed = match pid {
        Some(pid) => kill_stale_process(pid, &paths.llama_binary(), logger),
        None => false,
    };
    let _ = std::fs::remove_file(&pid_file);
    if killed {
        pid
    } else {
        None
    }
}

#[cfg(windows)]
fn kill_stale_process(pid: u32, binary: &Path, logger: &Logger) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };
    if pid == 0 {
        return false;
    }
    unsafe {
        let Ok(process) = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            false,
            pid,
        ) else {
            return false;
        };
        let mut buffer = [0u16; 32_768];
        let mut size = buffer.len() as u32;
        let image_matches = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .is_ok()
            && same_binary(
                Path::new(&String::from_utf16_lossy(&buffer[..size as usize])),
                binary,
            );
        let killed = image_matches && TerminateProcess(process, 1).is_ok();
        let _ = CloseHandle(process);
        if killed {
            logger.warn(&format!(
                "killed stale llama-server from a previous run (pid {pid})"
            ));
        }
        killed
    }
}

#[cfg(not(windows))]
fn kill_stale_process(_pid: u32, _binary: &Path, _logger: &Logger) -> bool {
    false
}

fn same_binary(actual: &Path, expected: &Path) -> bool {
    if actual.as_os_str().is_empty() {
        return false;
    }
    let normalize = |path: &Path| {
        path.to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .to_ascii_lowercase()
    };
    normalize(actual) == normalize(expected)
}

/// Process-wide job object that kills the child if this app dies without
/// running its cleanup (crash, task manager, power loss).
#[cfg(windows)]
fn kill_on_close_job() -> Option<windows::Win32::Foundation::HANDLE> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    static JOB: OnceLock<usize> = OnceLock::new();
    let raw = *JOB.get_or_init(|| unsafe {
        let Ok(job) = CreateJobObjectW(None, None) else {
            return 0;
        };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .is_ok();
        if !configured {
            let _ = windows::Win32::Foundation::CloseHandle(job);
            return 0;
        }
        job.0 as usize
    });
    (raw != 0).then(|| HANDLE(raw as *mut core::ffi::c_void))
}

#[cfg(windows)]
fn attach_to_kill_on_close_job(child: &Child) {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::AssignProcessToJobObject;
    let Some(job) = kill_on_close_job() else {
        return;
    };
    let process = HANDLE(child.as_raw_handle() as *mut core::ffi::c_void);
    unsafe {
        // Best effort: a process that already belongs to a non-breakaway job
        // cannot be added, and that must never break engine startup.
        let _ = AssignProcessToJobObject(job, process);
    }
}

#[cfg(not(windows))]
fn attach_to_kill_on_close_job(_child: &Child) {}

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

/// Context size passed to `-c`. Vision models need more room for image tokens,
/// so their configured value is raised to [`VISION_MIN_CONTEXT`].
pub fn effective_context_size(configured: u32, vision: bool) -> u32 {
    let clamped = configured.clamp(1024, 32_768);
    if vision {
        clamped.max(VISION_MIN_CONTEXT)
    } else {
        clamped
    }
}

/// Builds the `llama-server` invocation. Extracted from [`spawn_server`] so the
/// argument list (especially `--mmproj` for vision models) is unit-testable
/// without starting a process.
fn build_server_command(
    binary: &Path,
    model: &Path,
    mmproj: Option<&Path>,
    port: u16,
    context_size: u32,
    threads: u32,
    gpu_layers: u32,
) -> Command {
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
        // One request at a time (contract §5.2): spare server slots only cost
        // memory. Small prefill batches and no warmup keep the resident set and
        // the startup peak low; warmup would allocate the maximum batch once.
        .arg("-np")
        .arg("1")
        .arg("-b")
        .arg("512")
        .arg("-ub")
        .arg("256")
        .arg("--no-warmup")
        .arg("--no-webui");
    if let Some(mmproj) = mmproj {
        command.arg("--mmproj").arg(mmproj);
    }
    command
        .current_dir(binary.parent().unwrap_or_else(|| Path::new(".")))
        .stdin(Stdio::null());
    command
}

fn spawn_server(
    binary: &Path,
    model: &Path,
    mmproj: Option<&Path>,
    port: u16,
    context_size: u32,
    threads: u32,
    gpu_layers: u32,
    logger: Logger,
) -> std::io::Result<Child> {
    logger.info(&format!(
        "llama-server start: port={port} ctx={context_size} threads={threads} ngl={gpu_layers} mmproj={}",
        mmproj
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "-".to_string())
    ));

    let mut command = build_server_command(
        binary,
        model,
        mmproj,
        port,
        context_size,
        threads,
        gpu_layers,
    );
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn()?;
    attach_to_kill_on_close_job(&child);
    if let Some(stdout) = child.stdout.take() {
        forward_output(stdout, logger.clone(), "stdout");
    }
    if let Some(stderr) = child.stderr.take() {
        forward_output(stderr, logger, "stderr");
    }
    Ok(child)
}

fn forward_output<R: std::io::Read + Send + 'static>(
    reader: R,
    logger: Logger,
    channel: &'static str,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) => logger.info(&format!("{channel}: {line}")),
                Err(error) => {
                    logger.warn(&format!("{channel} read failed: {error}"));
                    break;
                }
            }
        }
    });
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
        assert!(!server.is_running_model("qwen2.5-1.5b-instruct-q4_k_m.gguf", None));
        assert!(!server.is_running_model(
            "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
            Some("mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf")
        ));
        assert!(!server.is_running_file("Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf"));
    }

    /// Puts the manager into the ready state without spawning a real process.
    fn mark_ready(server: &LocalServer, model: &str, mmproj: Option<&str>, port: u16) {
        let mut runtime = server.runtime.lock().unwrap();
        runtime.state = LocalState::Ready;
        runtime.port = port;
        runtime.model_file = model.to_string();
        runtime.model_name = model_display_name(model);
        runtime.mmproj_file = mmproj.unwrap_or("").to_string();
    }

    #[test]
    fn running_model_matches_weights_and_projector() {
        let server = LocalServer::new();
        let model = "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf";
        let projector = "mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf";
        mark_ready(&server, model, Some(projector), 18080);

        assert!(server.is_running_model(model, Some(projector)));
        assert!(server.is_running_model(&model.to_ascii_uppercase(), Some(projector)));
        // Case-insensitive, and None/blank both mean "text-only".
        assert!(!server.is_running_model(model, None));
        assert!(!server.is_running_model(model, Some("")));
        assert!(!server.is_running_model(model, Some("other-mmproj.gguf")));
        // A different model never matches, even with the same projector.
        assert!(!server.is_running_model("qwen2.5-3b-instruct-q4_k_m.gguf", Some(projector)));

        // Text-only server: asking for the same model + no projector reuses it.
        mark_ready(&server, "qwen2.5-3b-instruct-q4_k_m.gguf", None, 18080);
        assert!(server.is_running_model("qwen2.5-3b-instruct-q4_k_m.gguf", None));
        assert!(!server.is_running_model("qwen2.5-3b-instruct-q4_k_m.gguf", Some(projector)));
    }

    #[test]
    fn running_file_matches_weights_or_projector() {
        let server = LocalServer::new();
        let model = "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf";
        let projector = "mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf";
        mark_ready(&server, model, Some(projector), 18081);
        assert!(server.is_running_file(model));
        assert!(server.is_running_file(projector));
        assert!(server.is_running_file(&projector.to_ascii_uppercase()));
        assert!(!server.is_running_file("qwen2.5-3b-instruct-q4_k_m.gguf"));
    }

    #[test]
    fn vision_models_get_a_minimum_context_window() {
        assert_eq!(VISION_MIN_CONTEXT, 8_192);
        assert_eq!(effective_context_size(4096, false), 4096);
        assert_eq!(effective_context_size(4096, true), 8_192);
        assert_eq!(effective_context_size(8192, true), 8_192);
        assert_eq!(effective_context_size(16384, true), 16384);
        // Out-of-range values keep being clamped like before.
        assert_eq!(effective_context_size(0, false), 1024);
        assert_eq!(effective_context_size(0, true), 8_192);
        assert_eq!(effective_context_size(999_999, true), 32_768);
    }

    #[test]
    fn server_arguments_include_mmproj_only_for_vision_models() {
        let binary = Path::new("C:\\engine\\llama-server.exe");
        let model = Path::new("C:\\models\\Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf");
        let mmproj = Path::new("C:\\models\\mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf");

        let text = build_server_command(binary, model, None, 18000, 8192, 4, 0);
        let text_args: Vec<String> = text
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        assert!(!text_args.iter().any(|arg| arg == "--mmproj"));
        assert!(text_args.contains(&"-m".to_string()));
        assert!(text_args.contains(&model.to_string_lossy().to_string()));
        assert!(text_args.contains(&"--no-webui".to_string()));
        // Memory guards: one slot, small prefill batches, no warmup.
        assert!(text_args.contains(&"-np".to_string()));
        assert!(text_args.contains(&"1".to_string()));
        assert!(text_args.contains(&"-b".to_string()));
        assert!(text_args.contains(&"512".to_string()));
        assert!(text_args.contains(&"-ub".to_string()));
        assert!(text_args.contains(&"256".to_string()));
        assert!(text_args.contains(&"--no-warmup".to_string()));

        let vision = build_server_command(binary, model, Some(mmproj), 18000, 8192, 4, 0);
        let vision_args: Vec<String> = vision
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        let mmproj_index = vision_args
            .iter()
            .position(|arg| arg == "--mmproj")
            .expect("vision command must pass --mmproj");
        assert_eq!(
            vision_args.get(mmproj_index + 1).map(String::as_str),
            Some(mmproj.to_string_lossy().as_ref())
        );
        // The weights flag stays first and the projector comes after it.
        assert_eq!(vision_args.first().map(String::as_str), Some("-m"));
    }

    #[test]
    fn text_requests_reuse_a_vision_server_but_vision_requires_the_projector() {
        let server = LocalServer::new();
        let model = "Qwen3.5-2B-Q4_K_M.gguf";
        let projector = "mmproj-Qwen3.5-2B-F16.gguf";
        mark_ready(&server, model, Some(projector), 18082);
        // A text request never restarts a server that already loaded the projector.
        assert!(server.is_running_for(model, false));
        assert!(server.is_running_for(model, true));
        // A text-only server cannot serve vision without a restart.
        mark_ready(&server, model, None, 18082);
        assert!(server.is_running_for(model, false));
        assert!(!server.is_running_for(model, true));
        // A different model always forces a restart.
        assert!(!server.is_running_for("Qwen3.5-0.8B-Q4_K_M.gguf", false));
    }

    #[test]
    fn same_binary_ignores_case_and_unc_prefix() {
        assert!(same_binary(
            Path::new(r"\\?\E:\DATA\engine\llama-server.exe"),
            Path::new(r"e:\data\engine\llama-server.exe")
        ));
        assert!(same_binary(
            Path::new("E:/data/engine/llama-server.exe"),
            Path::new(r"E:\data\engine\llama-server.exe")
        ));
        assert!(!same_binary(Path::new(""), Path::new("x")));
        assert!(!same_binary(
            Path::new(r"E:\other\llama-server.exe"),
            Path::new(r"E:\data\engine\llama-server.exe")
        ));
    }

    #[test]
    fn cleanup_stale_server_ignores_missing_or_invalid_pid_file() {
        let temp = tempfile::tempdir().unwrap();
        let paths = crate::paths::AppPaths {
            data_dir: temp.path().to_path_buf(),
            settings_file: temp.path().join("settings.json"),
            models_dir: temp.path().join("models"),
            engine_dir: temp.path().join("engine"),
            logs_dir: temp.path().join("logs"),
            cache_dir: temp.path().join("cache"),
        };
        let logger = Logger::new(&paths.logs_dir, "test");
        assert_eq!(cleanup_stale_server(&paths, &logger), None);
        std::fs::write(paths.data_dir.join(PID_FILE_NAME), "not-a-pid").unwrap();
        assert_eq!(cleanup_stale_server(&paths, &logger), None);
        assert!(!paths.data_dir.join(PID_FILE_NAME).exists());
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
        assert!(snapshot.mmproj_file.is_empty());
    }
}
