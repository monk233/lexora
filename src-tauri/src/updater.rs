//! Self-update: check the latest GitHub release, download the portable
//! `Lexora-*-win-x64.exe` asset and let a hidden PowerShell helper replace
//! the running executable after the app exits.
//!
//! Flow (`install_update`):
//!
//! 1. `check_update` reads `releases/latest` and selects the Windows asset;
//! 2. the new exe is streamed next to the current one as
//!    `<exe-stem>-update-<version>.exe` (`update-progress` events drive the UI);
//! 3. the download is validated (size and `MZ` header);
//! 4. a UTF-8 (BOM) PowerShell script is written to `%TEMP%`; it waits for the
//!    current pid, swaps `<exe>` -> `<exe>.old` and `<new>` -> `<exe>`, starts
//!    the new exe with `--show`, deletes both the backup and itself, and on any
//!    failure restores `<exe>.old` and writes `update-error.log`;
//! 5. the app emits `ready` and exits after ~1.2 s so the helper can take over.
//!
//! `LEXORA_UPDATE_API` is a test-only override: it may point at plain http and
//! relaxes the https-only rule for the downloaded asset URL.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::state::AppState;
use tauri::{Emitter, Manager};

/// GitHub repository that publishes portable Lexora releases.
pub const UPDATE_REPO: &str = "monk233/lexora";
/// Default GitHub API endpoint for the latest release.
pub const DEFAULT_UPDATE_API: &str = "https://api.github.com/repos/monk233/lexora/releases/latest";
/// Test-only environment override for the release API (may be plain http).
pub const ENV_UPDATE_API: &str = "LEXORA_UPDATE_API";

const USER_AGENT: &str = concat!("Lexora/", env!("CARGO_PKG_VERSION"));
/// GitHub API metadata request timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Asset download only bounds the connection phase (large exe over slow links).
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// UI progress is throttled; the final event is always emitted.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
/// Release notes are free text and are shown in a scrollable panel.
const NOTES_MAX_CHARS: usize = 4_000;
/// A portable Lexora exe is always well above 1 MB; small files are not exes.
const MIN_UPDATE_BYTES: u64 = 1_000_000;
/// Event pushed to the settings window while downloading.
const PROGRESS_EVENT: &str = "update-progress";
const UPDATE_AVAILABLE_EVENT: &str = "update-available";
/// Give the frontend time to render `ready` before the process exits.
const START_DELAY: Duration = Duration::from_millis(1_200);
/// Product-level automatic update polling interval.
const AUTO_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const AUTO_CHECK_INITIAL_DELAY: Duration = Duration::from_secs(2);
const NOTIFIED_VERSION_FILE: &str = "update-notified-version";

/// Result of an update check, exposed to the About page.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub asset_name: String,
    pub asset_url: String,
    pub notes: String,
    pub published_at: String,
    pub size_bytes: u64,
}

/// Actionable updater error: `message` is the headline, `hint` the next step.
#[derive(Debug, Clone)]
pub struct UpdateError {
    pub message: String,
    pub hint: String,
}

impl UpdateError {
    pub fn new(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            hint: hint.into(),
        }
    }
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for UpdateError {}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Strips a leading `v` / `V` from a release tag (`v0.2.0` -> `0.2.0`).
fn normalize_tag(tag: &str) -> String {
    let trimmed = tag.trim();
    trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed)
        .to_string()
}

/// Parses `x.y.z` (any number of dot-separated numeric segments) into numbers.
/// A leading `v` is allowed; prerelease/build suffixes (`-beta.1`, `+sha`) are
/// ignored. Invalid versions return `None`.
fn parse_version(value: &str) -> Option<Vec<u64>> {
    let normalized = normalize_tag(value);
    let core = normalized
        .split(|character| character == '-' || character == '+')
        .next()
        .unwrap_or("");
    if core.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for part in core.split('.') {
        if part.is_empty() || !part.chars().all(|character| character.is_ascii_digit()) {
            return None;
        }
        parts.push(part.parse::<u64>().ok()?);
    }
    Some(parts)
}

/// `true` when `latest` is strictly newer than `current`.
///
/// Segments are compared numerically (`1.0.10 > 1.0.9`) and missing segments
/// count as zero (`2.0` == `2.0.0`). Unparseable versions are never "newer".
pub fn version_is_newer(latest: &str, current: &str) -> bool {
    let (Some(latest), Some(current)) = (parse_version(latest), parse_version(current)) else {
        return false;
    };
    let segments = latest.len().max(current.len());
    for index in 0..segments {
        let left = latest.get(index).copied().unwrap_or(0);
        let right = current.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}

/// Selected release asset metadata.
#[derive(Debug, Clone, PartialEq)]
struct ReleaseAsset {
    name: String,
    url: String,
    size: u64,
}

/// Manual download hint that includes the repository URL.
fn releases_hint() -> String {
    format!("请稍后重试，或到 https://github.com/{UPDATE_REPO}/releases 页面手动下载。")
}

/// First asset that looks like the portable Windows build:
/// `Lexora-*.exe` whose name contains `win-x64`.
fn release_asset(assets: Option<&Value>) -> Option<ReleaseAsset> {
    for asset in assets?.as_array()? {
        let name = asset
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if !name.starts_with("Lexora-") || !name.contains("win-x64") || !name.ends_with(".exe") {
            continue;
        }
        let url = asset
            .get("browser_download_url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if url.is_empty() {
            continue;
        }
        let size = asset.get("size").and_then(Value::as_u64).unwrap_or(0);
        return Some(ReleaseAsset {
            name: name.to_string(),
            url: url.to_string(),
            size,
        });
    }
    None
}

/// Parses a GitHub `releases/latest` JSON body into [`UpdateInfo`].
fn parse_release(release: &Value, current_version: &str) -> Result<UpdateInfo, UpdateError> {
    let tag = release
        .get("tag_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if tag.is_empty() {
        return Err(UpdateError::new(
            "检查更新失败：更新信息缺少版本号。",
            "请稍后重试，或到 GitHub Releases 页面手动检查。",
        ));
    }
    let latest_version = normalize_tag(tag);
    let has_update = version_is_newer(&latest_version, current_version);
    let notes: String = release
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .take(NOTES_MAX_CHARS)
        .collect();
    let published_at = release
        .get("published_at")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    // Only a newer version needs a downloadable asset. Older releases may have
    // been published before the portable exe naming existed, so a plain
    // "already up to date" answer must not fail because of their assets.
    let asset = if has_update {
        Some(release_asset(release.get("assets")).ok_or_else(|| {
            UpdateError::new("最新版本没有可用的 Windows 安装包。", releases_hint())
        })?)
    } else {
        None
    };
    Ok(UpdateInfo {
        current_version: current_version.trim().to_string(),
        latest_version: latest_version.clone(),
        has_update,
        asset_name: asset.as_ref().map(|a| a.name.clone()).unwrap_or_default(),
        asset_url: asset.as_ref().map(|a| a.url.clone()).unwrap_or_default(),
        notes,
        published_at,
        size_bytes: asset.as_ref().map(|a| a.size).unwrap_or(0),
    })
}

/// Validates the release API URL: https unless the test override allows http.
fn validate_api_url(url: &str, allow_http: bool) -> Result<String, UpdateError> {
    let lowered = url.trim().to_ascii_lowercase();
    if lowered.starts_with("https://") || (allow_http && lowered.starts_with("http://")) {
        Ok(url.trim().to_string())
    } else {
        Err(UpdateError::new(
            "更新服务地址无效。",
            "请使用 https 地址；仅测试时可通过 LEXORA_UPDATE_API 指向本地 http 服务。",
        ))
    }
}

/// Resolves the release endpoint, applying the `LEXORA_UPDATE_API` override.
fn resolve_endpoint(override_value: Option<&str>) -> Result<String, UpdateError> {
    match override_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(url) => validate_api_url(url, true),
        None => validate_api_url(DEFAULT_UPDATE_API, false),
    }
}

/// Reads `LEXORA_UPDATE_API` and resolves the endpoint.
fn update_endpoint() -> Result<String, UpdateError> {
    let value = std::env::var(ENV_UPDATE_API).ok();
    resolve_endpoint(value.as_deref())
}

/// `true` when the test override is active (relaxes the https-only asset rule).
fn update_override_active() -> bool {
    std::env::var(ENV_UPDATE_API)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

/// The downloaded asset must be https unless the test override is active.
fn validate_asset_url(url: &str, allow_http: bool) -> Result<(), UpdateError> {
    let lowered = url.trim().to_ascii_lowercase();
    if lowered.starts_with("https://") || (allow_http && lowered.starts_with("http://")) {
        Ok(())
    } else {
        Err(UpdateError::new("更新包地址无效。", releases_hint()))
    }
}

/// One-decimal download percentage; `0.0` when the server sends no length.
fn progress_percent(received: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    let value = ((received as f64 / total as f64) * 100.0).clamp(0.0, 100.0);
    (value * 10.0).round() / 10.0
}

/// File name used for the downloaded exe: `<exe-stem>-update-<version>.exe`.
fn update_file_name(exe_path: &Path, latest_version: &str) -> String {
    let stem = exe_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("lexora");
    format!(
        "{stem}-update-{}.exe",
        sanitize_file_version(latest_version)
    )
}

/// Keeps a version string usable inside a Windows file name.
fn sanitize_file_version(value: &str) -> String {
    let sanitized: String = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "latest".to_string()
    } else {
        sanitized
    }
}

/// Probes `directory` by creating and removing a small temp file.
fn ensure_dir_writable(directory: &Path) -> Result<(), UpdateError> {
    let probe = directory.join(format!(".lexora-write-test-{}", std::process::id()));
    match std::fs::write(&probe, b"lexora") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(error) => Err(UpdateError::new(
            "当前程序目录不可写。",
            format!("请把程序放到可写目录（如用户目录）后重试，或以管理员身份运行（{error}）。"),
        )),
    }
}

/// Checks a downloaded file: larger than 1 MB and starting with the `MZ` DOS
/// signature every Windows executable carries.
fn verify_downloaded_exe(path: &Path) -> Result<(), UpdateError> {
    let metadata = std::fs::metadata(path)
        .map_err(|_| UpdateError::new("下载的更新包无效。", releases_hint()))?;
    if metadata.len() <= MIN_UPDATE_BYTES {
        return Err(UpdateError::new(
            "下载的更新包无效。",
            format!(
                "文件大小异常（{} 字节），请稍后重试或手动下载。",
                metadata.len()
            ),
        ));
    }
    let mut header = [0u8; 2];
    let mut file = std::fs::File::open(path)
        .map_err(|_| UpdateError::new("下载的更新包无效。", releases_hint()))?;
    file.read_exact(&mut header)
        .map_err(|_| UpdateError::new("下载的更新包无效。", releases_hint()))?;
    if &header != b"MZ" {
        return Err(UpdateError::new(
            "下载的更新包无效。",
            "下载内容不是可执行文件，请稍后重试或到 GitHub Releases 页面手动下载。",
        ));
    }
    Ok(())
}

/// Single-quotes a PowerShell literal; `'` becomes `''` per PowerShell rules.
fn ps_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// PowerShell helper template. A UTF-8 BOM is prepended when the script is
/// written to disk, see [`write_update_script`].
const SCRIPT_TEMPLATE: &str = r#"$ErrorActionPreference = 'Stop'
$target = @TARGET@
$old = @OLD@
$new = @NEW@
$log = @LOG@
try {
    $process = Get-Process -Id @PID@ -ErrorAction SilentlyContinue
    if ($null -ne $process) {
        Wait-Process -Id @PID@ -Timeout 60 -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $old) {
        Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
    }
    Move-Item -LiteralPath $target -Destination $old -Force
    Move-Item -LiteralPath $new -Destination $target -Force
    Start-Process -FilePath $target -ArgumentList '--show'
    if (Test-Path -LiteralPath $old) {
        Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
    }
}
catch {
    $message = $_.Exception.Message
    try {
        if (Test-Path -LiteralPath $old) {
            Move-Item -LiteralPath $old -Destination $target -Force
        }
        if (Test-Path -LiteralPath $target) {
            Start-Process -FilePath $target -ArgumentList '--show'
        }
    } catch { }
    Set-Content -LiteralPath $log -Value $message -Encoding UTF8 -ErrorAction SilentlyContinue
}
finally {
    if (Test-Path -LiteralPath $new) {
        Remove-Item -LiteralPath $new -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
"#;

/// Builds the PowerShell update helper. Paths are single-quoted so Chinese
/// characters and spaces survive; `@PID@` waits for the current process.
fn build_update_script(exe_path: &Path, download_path: &Path, pid: u32) -> String {
    let target = ps_single_quote(&exe_path.to_string_lossy());
    let old = ps_single_quote(&format!("{}.old", exe_path.to_string_lossy()));
    let new = ps_single_quote(&download_path.to_string_lossy());
    let log = ps_single_quote(
        &exe_path
            .with_file_name("update-error.log")
            .to_string_lossy(),
    );
    SCRIPT_TEMPLATE
        .replace("@TARGET@", &target)
        .replace("@OLD@", &old)
        .replace("@NEW@", &new)
        .replace("@LOG@", &log)
        .replace("@PID@", &pid.to_string())
}

/// Writes the script to `%TEMP%` as UTF-8 with BOM (Windows PowerShell 5.1
/// needs the BOM to decode non-ASCII paths correctly).
fn write_update_script(exe_path: &Path, download_path: &Path) -> Result<PathBuf, UpdateError> {
    let script_path =
        std::env::temp_dir().join(format!("lexora-update-{}.ps1", std::process::id()));
    let contents = build_update_script(exe_path, download_path, std::process::id());
    let mut bytes = Vec::with_capacity(contents.len() + 3);
    bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    bytes.extend_from_slice(contents.as_bytes());
    std::fs::write(&script_path, bytes).map_err(|error| {
        UpdateError::new(
            "无法创建更新脚本。",
            format!("请确认临时目录可写后重试（{error}）。"),
        )
    })?;
    Ok(script_path)
}

/// Network error hint that stays actionable in Chinese.
fn network_hint(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "连接更新服务超时，请检查网络后重试。".to_string()
    } else {
        "请检查网络连接（代理、防火墙）后重试，或手动下载。".to_string()
    }
}

/// Emits one `update-progress` event to the settings window. `ready` always
/// reports 100% even when the server did not announce a content length.
fn emit_progress(app: &tauri::AppHandle, status: &str, received: u64, total: u64) {
    let percent = if status == "ready" {
        100.0
    } else {
        progress_percent(received, total)
    };
    let _ = app.emit_to(
        crate::windows::SETTINGS_LABEL,
        PROGRESS_EVENT,
        json!({
            "status": status,
            "received": received,
            "total": total,
            "percent": percent,
        }),
    );
}

/// Starts the hidden PowerShell helper. `CREATE_NO_WINDOW` hides the console;
/// do NOT combine it with `DETACHED_PROCESS`: on some Windows/PowerShell builds
/// that combination makes the helper exit immediately, leaving the staged exe
/// in place without swapping it.
#[cfg(windows)]
fn spawn_update_helper(script: &Path) -> Result<(), UpdateError> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut command = std::process::Command::new("powershell");
    command
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-File")
        .arg(script);
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn().map(|_| ()).map_err(|error| {
        UpdateError::new(
            "无法启动更新助手。",
            format!("请重启程序后重试，或到 GitHub Releases 页面手动下载（{error}）。"),
        )
    })
}

#[cfg(not(windows))]
fn spawn_update_helper(_script: &Path) -> Result<(), UpdateError> {
    Err(UpdateError::new(
        "当前平台不支持自动更新。",
        releases_hint(),
    ))
}

// ---------------------------------------------------------------------------
// Network operations
// ---------------------------------------------------------------------------

/// Fetches the latest release and turns it into [`UpdateInfo`].
pub async fn check_update() -> Result<UpdateInfo, UpdateError> {
    let endpoint = update_endpoint()?;
    // The test override points at a loopback mock; proxies must not intercept it.
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(REQUEST_TIMEOUT);
    if update_override_active() {
        builder = builder.no_proxy();
    }
    let client = builder.build().map_err(|error| {
        UpdateError::new(
            "无法初始化更新检查。",
            format!("请重启程序后重试（{error}）。"),
        )
    })?;
    let response = client
        .get(&endpoint)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| {
            UpdateError::new("检查更新失败：无法连接更新服务。", network_hint(&error))
        })?;
    let status = response.status();
    if !status.is_success() {
        let hint = match status.as_u16() {
            404 => "仓库还没有发布任何 Release，或发布已被删除。".to_string(),
            403 | 429 => format!(
                "GitHub API 请求受限或过于频繁，请稍后重试。{}",
                releases_hint()
            ),
            _ => releases_hint(),
        };
        return Err(UpdateError::new(
            format!("检查更新失败：更新服务返回 {status}。"),
            hint,
        ));
    }
    let release: Value = response.json().await.map_err(|error| {
        UpdateError::new(
            "检查更新失败：更新信息无法解析。",
            format!("请稍后重试（{error}）。"),
        )
    })?;
    parse_release(&release, env!("CARGO_PKG_VERSION"))
}

fn record_notification_success(
    sent: Result<(), String>,
    record: impl FnOnce(),
) -> Result<(), String> {
    sent?;
    record();
    Ok(())
}

/// Sends one native notification per latest version, persisted across restarts.
pub fn notify_update_once(app: &tauri::AppHandle, version: &str) -> Result<bool, UpdateError> {
    let version = normalize_tag(version);
    if parse_version(&version).is_none() {
        return Err(UpdateError::new(
            "系统通知失败：版本号无效。",
            "请打开设置页手动检查更新。",
        ));
    }
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return Err(UpdateError::new(
            "系统通知失败：应用状态不可用。",
            "请重启 Lexora 后重试。",
        ));
    };
    let marker = state.paths.data_dir.join(NOTIFIED_VERSION_FILE);
    if std::fs::read_to_string(&marker)
        .ok()
        .map(|value| normalize_tag(&value))
        .as_deref()
        == Some(version.as_str())
    {
        return Ok(false);
    }
    record_notification_success(
        crate::notification::show_update_available(app, &version),
        || {
            if let Err(error) = std::fs::create_dir_all(&state.paths.data_dir)
                .and_then(|_| std::fs::write(&marker, format!("{version}\n")))
            {
                state.log.warn(&format!(
                    "could not persist notified update version v{version}: {error}"
                ));
            }
        },
    )
    .map_err(|error| {
        UpdateError::new(
            "系统通知发送失败。",
            format!("请打开设置页手动检查更新（{error}）。"),
        )
    })?;
    state
        .log
        .info(&format!("system notification shown for update v{version}"));
    Ok(true)
}

fn serialized_update_payload(info: &UpdateInfo) -> Value {
    match serde_json::to_value(info) {
        Ok(mut value) => {
            if let Some(object) = value.as_object_mut() {
                object.insert("ok".to_string(), json!(true));
            }
            value
        }
        Err(_) => json!({}),
    }
}

async fn run_automatic_update_check(app: &tauri::AppHandle) {
    match check_update().await {
        Ok(info) if info.has_update => {
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                state.log.info(&format!(
                    "automatic update check found v{}",
                    info.latest_version
                ));
            }
            if let Err(error) = notify_update_once(app, &info.latest_version) {
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    state.log.warn(&format!(
                        "automatic update notification failed: {}",
                        error.message
                    ));
                }
            }
            let _ = app.emit_to(
                crate::windows::SETTINGS_LABEL,
                UPDATE_AVAILABLE_EVENT,
                serialized_update_payload(&info),
            );
        }
        Ok(info) => {
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                state.log.info(&format!(
                    "automatic update check: current version v{} is latest",
                    info.latest_version
                ));
            }
        }
        Err(error) => {
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                state
                    .log
                    .warn(&format!("automatic update check failed: {}", error.message));
            }
        }
    }
}

/// Starts the process-level update poller. This must not depend on a visible
/// settings webview because Lexora normally starts hidden in the tray.
pub fn start_automatic_update_checker(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(AUTO_CHECK_INITIAL_DELAY).await;
        loop {
            run_automatic_update_check(&app).await;
            tokio::time::sleep(AUTO_CHECK_INTERVAL).await;
        }
    });
}
/// Downloads the new exe next to the current one, streaming progress to the UI.
async fn download_update(
    app: &tauri::AppHandle,
    info: &UpdateInfo,
    destination: &Path,
) -> Result<(), UpdateError> {
    // The test override points at a loopback mock; proxies must not intercept it.
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(DOWNLOAD_CONNECT_TIMEOUT);
    if update_override_active() {
        builder = builder.no_proxy();
    }
    let client = builder.build().map_err(|error| {
        UpdateError::new(
            "无法初始化更新下载。",
            format!("请重启程序后重试（{error}）。"),
        )
    })?;
    let mut response = client
        .get(&info.asset_url)
        .send()
        .await
        .map_err(|error| UpdateError::new("下载更新包失败。", network_hint(&error)))?;
    let status = response.status();
    if !status.is_success() {
        return Err(UpdateError::new(
            format!("下载更新包失败：更新服务返回 {status}。"),
            releases_hint(),
        ));
    }
    let total = response.content_length().unwrap_or(info.size_bytes);
    let mut file = std::fs::File::create(destination).map_err(|error| {
        UpdateError::new(
            "无法创建更新文件。",
            format!("请确认程序目录可写后重试（{error}）。"),
        )
    })?;
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();
    emit_progress(app, "downloading", 0, total);
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|error| UpdateError::new("下载更新包中断。", network_hint(&error)))?;
        let Some(chunk) = chunk else {
            break;
        };
        file.write_all(&chunk).map_err(|error| {
            UpdateError::new(
                "写入更新文件失败。",
                format!("请确认程序目录可写后重试（{error}）。"),
            )
        })?;
        received = received.saturating_add(chunk.len() as u64);
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            emit_progress(app, "downloading", received, total);
        }
    }
    file.flush().map_err(|error| {
        UpdateError::new(
            "写入更新文件失败。",
            format!("请确认程序目录可写后重试（{error}）。"),
        )
    })?;
    drop(file);
    emit_progress(app, "downloading", received, total);
    Ok(())
}

/// Checks, downloads and schedules the exe replacement.
///
/// Returns as soon as the helper is running; the app exits after
/// [`START_DELAY`] so the script can swap the portable exe and restart it.
pub async fn install_update(app: &tauri::AppHandle) -> Result<UpdateInfo, UpdateError> {
    let info = check_update().await?;
    if !info.has_update {
        return Err(UpdateError::new(
            "当前已是最新版本。",
            format!("已安装 {}，无需更新。", info.current_version),
        ));
    }
    validate_asset_url(&info.asset_url, update_override_active())?;

    let exe_path = std::env::current_exe().map_err(|error| {
        UpdateError::new(
            "无法定位当前程序文件。",
            format!("请把程序放到可写目录后重试（{error}）。"),
        )
    })?;
    let exe_dir = exe_path
        .parent()
        .filter(|directory| directory.is_dir())
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            UpdateError::new(
                "无法定位当前程序目录。",
                "请把程序放到可写目录后重试，或以管理员身份运行。",
            )
        })?;
    ensure_dir_writable(&exe_dir)?;

    let download_path = exe_dir.join(update_file_name(&exe_path, &info.latest_version));
    if let Err(error) = download_update(app, &info, &download_path).await {
        let _ = std::fs::remove_file(&download_path);
        return Err(error);
    }
    if let Err(error) = verify_downloaded_exe(&download_path) {
        let _ = std::fs::remove_file(&download_path);
        return Err(error);
    }

    let script_path = match write_update_script(&exe_path, &download_path) {
        Ok(path) => path,
        Err(error) => {
            let _ = std::fs::remove_file(&download_path);
            return Err(error);
        }
    };
    if let Err(error) = spawn_update_helper(&script_path) {
        let _ = std::fs::remove_file(&download_path);
        let _ = std::fs::remove_file(&script_path);
        return Err(error);
    }

    // The helper is waiting for this pid: tell the UI, then exit.
    let size = info.size_bytes;
    emit_progress(app, "ready", size, size);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(START_DELAY).await;
        handle.exit(0);
    });
    Ok(info)
}

#[cfg(test)]
mod tests {
    #[test]
    fn notification_failure_does_not_record_version_and_can_retry() {
        let recorded = std::cell::Cell::new(false);
        let failed =
            super::record_notification_success(Err("toast failed".into()), || recorded.set(true));
        assert_eq!(failed, Err("toast failed".into()));
        assert!(!recorded.get());
        super::record_notification_success(Ok(()), || recorded.set(true)).unwrap();
        assert!(recorded.get());
    }

    use super::*;

    fn release_json(assets: Value) -> Value {
        json!({
            "tag_name": "v0.2.0",
            "body": "  Lexora 0.2.0 release notes.\n\n- fixed things  ",
            "published_at": "2026-10-24T12:00:00Z",
            "assets": assets,
        })
    }

    fn windows_asset(name: &str, url: &str, size: u64) -> Value {
        json!({
            "name": name,
            "browser_download_url": url,
            "size": size,
        })
    }

    #[test]
    fn version_comparison_is_numeric_and_strict() {
        assert!(version_is_newer("1.0.10", "1.0.9"));
        assert!(version_is_newer("2.0", "1.9.9"));
        assert!(version_is_newer("1.2.0", "1.1.99"));
        assert!(!version_is_newer("v1.2.0", "1.2.0"));
        assert!(!version_is_newer("1.2.0", "v1.2.0"));
        assert!(!version_is_newer("1.0.9", "1.0.10"));
        // Numeric, not lexicographic: 1.10.0 is newer than 1.2.0.
        assert!(version_is_newer("1.10.0", "1.2.0"));
        assert!(!version_is_newer("1.2.0", "1.10.0"));
        assert!(!version_is_newer("2.0.0", "2.0"));
        assert!(!version_is_newer("2.0", "2.0.0"));
        // 2.0 == 2.0.0 (missing segments count as zero).
        assert!(version_is_newer("2.0.1", "2.0"));
        assert!(!version_is_newer("2.0", "2.0.1"));
    }

    #[test]
    fn version_parser_accepts_prefixes_and_ignores_suffixes() {
        assert_eq!(parse_version("v1.2.3"), Some(vec![1, 2, 3]));
        assert_eq!(parse_version("V1.2.3"), Some(vec![1, 2, 3]));
        assert_eq!(parse_version(" 1.2.3 "), Some(vec![1, 2, 3]));
        assert_eq!(parse_version("1.2.3-beta.1"), Some(vec![1, 2, 3]));
        assert_eq!(parse_version("1.2.3+build.7"), Some(vec![1, 2, 3]));
        assert_eq!(parse_version("2"), Some(vec![2]));
        for invalid in ["", "v", "abc", "1.x.0", "1..2", "1.2.3.4.5.6.7.8.9.x"] {
            assert_eq!(parse_version(invalid), None, "should reject {invalid:?}");
        }
    }

    #[test]
    fn invalid_versions_are_never_newer() {
        for (latest, current) in [
            ("", "1.0.0"),
            ("1.0.0", ""),
            ("abc", "1.0.0"),
            ("1.0.0", "abc"),
            ("1.x", "1.0.0"),
            ("v", "1.0.0"),
        ] {
            assert!(
                !version_is_newer(latest, current),
                "{latest:?} vs {current:?}"
            );
        }
    }

    #[test]
    fn parse_release_selects_the_windows_exe_asset() {
        let release = release_json(json!([
            windows_asset(
                "Lexora-0.2.0-win-x64.zip",
                "https://example.com/bundle.zip",
                5_000_000
            ),
            windows_asset("notes.txt", "https://example.com/notes.txt", 100),
            windows_asset(
                "Lexora-0.2.0-win-x64.exe",
                "https://github.com/monk233/lexora/releases/download/v0.2.0/Lexora-0.2.0-win-x64.exe",
                9_500_000
            ),
            windows_asset(
                "Lexora-0.2.0-win-arm64.exe",
                "https://example.com/arm.exe",
                9_400_000
            ),
        ]));
        let info = parse_release(&release, "0.1.0").unwrap();
        assert_eq!(info.current_version, "0.1.0");
        assert_eq!(info.latest_version, "0.2.0");
        assert!(info.has_update);
        assert_eq!(info.asset_name, "Lexora-0.2.0-win-x64.exe");
        assert!(info.asset_url.ends_with("Lexora-0.2.0-win-x64.exe"));
        assert_eq!(info.size_bytes, 9_500_000);
        assert_eq!(info.published_at, "2026-10-24T12:00:00Z");
        assert_eq!(info.notes, "Lexora 0.2.0 release notes.\n\n- fixed things");
    }

    #[test]
    fn parse_release_reports_same_or_older_versions() {
        let release = release_json(json!([windows_asset(
            "Lexora-0.2.0-win-x64.exe",
            "https://example.com/Lexora-0.2.0-win-x64.exe",
            9_500_000
        )]));
        assert!(!parse_release(&release, "0.2.0").unwrap().has_update);
        assert!(!parse_release(&release, "0.3.0").unwrap().has_update);
        assert!(parse_release(&release, "0.1.9").unwrap().has_update);
    }

    #[test]
    fn parse_release_already_latest_tolerates_missing_asset() {
        // The historical v0.1.0 release only has a zip asset; being up to date
        // must still report "no update" instead of an asset error.
        let release = json!({
            "tag_name": "v0.1.0",
            "body": "",
            "published_at": "2026-10-24T12:00:00Z",
            "assets": [windows_asset(
                "LingoPick-0.1.0-win-x64.zip",
                "https://example.com/LingoPick-0.1.0-win-x64.zip",
                5_000_000
            )],
        });
        let info = parse_release(&release, "0.1.0").unwrap();
        assert!(!info.has_update);
        assert_eq!(info.asset_name, "");
        assert_eq!(info.asset_url, "");
        assert_eq!(info.size_bytes, 0);

        let no_assets = json!({
            "tag_name": "v0.1.0",
            "body": "",
            "published_at": "2026-10-24T12:00:00Z",
            "assets": [],
        });
        let info = parse_release(&no_assets, "0.1.0").unwrap();
        assert!(!info.has_update);
    }

    #[test]
    fn parse_release_requires_a_windows_asset() {
        let release = release_json(json!([windows_asset(
            "Lexora-0.2.0-win-x64.zip",
            "https://example.com/bundle.zip",
            5_000_000
        )]));
        let error = parse_release(&release, "0.1.0").unwrap_err();
        assert!(
            error.message.contains("最新版本没有可用的 Windows 安装包"),
            "message: {}",
            error.message
        );
        assert!(error.hint.contains("releases"), "hint: {}", error.hint);
    }

    #[test]
    fn parse_release_rejects_missing_or_invalid_data() {
        let error = parse_release(&json!({"assets": []}), "0.1.0").unwrap_err();
        assert!(
            error.message.contains("版本号"),
            "message: {}",
            error.message
        );
        // A response without an assets array behaves like "no asset".
        let error = parse_release(&json!({"tag_name": "v0.2.0"}), "0.1.0").unwrap_err();
        assert!(error.message.contains("Windows 安装包"));
        // Completely wrong JSON yields a readable error instead of a panic.
        let error = parse_release(&json!("nope"), "0.1.0").unwrap_err();
        assert!(error.message.contains("版本号"));
    }

    #[test]
    fn parse_release_truncates_notes_to_4000_chars() {
        let notes = "说".repeat(NOTES_MAX_CHARS + 500);
        let release = json!({
            "tag_name": "v0.2.0",
            "body": notes,
            "assets": [windows_asset(
                "Lexora-0.2.0-win-x64.exe",
                "https://example.com/update.exe",
                1
            )],
        });
        let info = parse_release(&release, "0.1.0").unwrap();
        assert_eq!(info.notes.chars().count(), NOTES_MAX_CHARS);
    }

    #[test]
    fn endpoint_defaults_to_https_github_and_override_allows_http() {
        assert_eq!(resolve_endpoint(None).unwrap(), DEFAULT_UPDATE_API);
        assert_eq!(
            resolve_endpoint(Some("http://127.0.0.1:8765/release")).unwrap(),
            "http://127.0.0.1:8765/release"
        );
        // An empty override is ignored.
        assert_eq!(resolve_endpoint(Some("   ")).unwrap(), DEFAULT_UPDATE_API);
        assert!(resolve_endpoint(Some("ftp://example.com/release")).is_err());
        assert!(resolve_endpoint(Some("file:///tmp/release.json")).is_err());
    }

    #[test]
    fn update_endpoint_reads_the_environment_override() {
        // This is the only test that touches the variable, so it is safe to
        // set and clear it around the call.
        std::env::set_var(ENV_UPDATE_API, "http://127.0.0.1:8765/release");
        let overridden = update_endpoint().unwrap();
        assert!(update_override_active());
        std::env::remove_var(ENV_UPDATE_API);
        assert_eq!(overridden, "http://127.0.0.1:8765/release");
        assert!(!update_override_active());
        assert_eq!(update_endpoint().unwrap(), DEFAULT_UPDATE_API);
    }

    #[test]
    fn asset_url_requires_https_without_the_test_override() {
        assert!(validate_asset_url("https://example.com/Lexora.exe", false).is_ok());
        assert!(validate_asset_url("http://127.0.0.1/update.exe", false).is_err());
        assert!(validate_asset_url("http://127.0.0.1/update.exe", true).is_ok());
        assert!(validate_asset_url("ftp://example.com/update.exe", true).is_err());
    }

    #[test]
    fn update_file_name_uses_exe_stem_and_sanitized_version() {
        let exe = PathBuf::from(r"C:\Users\测试 用户\Downloads\lexora.exe");
        assert_eq!(update_file_name(&exe, "0.2.0"), "lexora-update-0.2.0.exe");
        assert_eq!(
            update_file_name(Path::new("/tmp/lexora.exe"), "v0.2.0"),
            "lexora-update-v0.2.0.exe"
        );
        // Path separators never reach the file name.
        assert_eq!(
            update_file_name(Path::new("lexora.exe"), "1/2"),
            "lexora-update-1_2.exe"
        );
        assert_eq!(
            update_file_name(Path::new("lexora.exe"), "  "),
            "lexora-update-latest.exe"
        );
    }

    #[test]
    fn progress_percent_handles_unknown_lengths_and_rounds() {
        assert_eq!(progress_percent(0, 0), 0.0);
        assert_eq!(progress_percent(50, 100), 50.0);
        assert_eq!(progress_percent(1, 3), 33.3);
        assert_eq!(progress_percent(100, 100), 100.0);
        assert_eq!(progress_percent(200, 100), 100.0);
    }

    #[test]
    fn downloaded_exe_validation_checks_size_and_mz_header() {
        let dir = tempfile::TempDir::new().unwrap();

        let small = dir.path().join("small.exe");
        std::fs::write(&small, b"MZ").unwrap();
        let error = verify_downloaded_exe(&small).unwrap_err();
        assert!(error.message.contains("无效"), "message: {}", error.message);

        let mut not_mz = vec![b'N'; 2];
        not_mz.resize(MIN_UPDATE_BYTES as usize + 10, b'0');
        let not_mz_path = dir.path().join("not-mz.exe");
        std::fs::write(&not_mz_path, &not_mz).unwrap();
        assert!(verify_downloaded_exe(&not_mz_path).is_err());

        let mut valid = vec![b'M', b'Z'];
        valid.resize(MIN_UPDATE_BYTES as usize + 10, b'0');
        let valid_path = dir.path().join("valid.exe");
        std::fs::write(&valid_path, &valid).unwrap();
        assert!(verify_downloaded_exe(&valid_path).is_ok());

        assert!(verify_downloaded_exe(&dir.path().join("missing.exe")).is_err());
    }

    #[test]
    fn powershell_quotes_are_escaped() {
        assert_eq!(ps_single_quote("C:\\lexora.exe"), "'C:\\lexora.exe'");
        assert_eq!(
            ps_single_quote("C:\\it's\\lexora.exe"),
            "'C:\\it''s\\lexora.exe'"
        );
    }

    #[test]
    fn update_script_waits_for_pid_and_has_a_rollback() {
        let exe = PathBuf::from(r"C:\Program Files\Lexora\lexora.exe");
        let new = PathBuf::from(r"C:\Program Files\Lexora\lexora-update-0.2.0.exe");
        let script = build_update_script(&exe, &new, 4321);

        assert!(script.contains("Wait-Process -Id 4321 -Timeout 60"));
        assert!(script.contains("Get-Process -Id 4321"));
        assert!(script.contains(r"$target = 'C:\Program Files\Lexora\lexora.exe'"));
        assert!(script.contains(r"$old = 'C:\Program Files\Lexora\lexora.exe.old'"));
        assert!(script.contains(r"$new = 'C:\Program Files\Lexora\lexora-update-0.2.0.exe'"));
        assert!(script.contains(r"$log = 'C:\Program Files\Lexora\update-error.log'"));
        assert!(script.contains("Move-Item -LiteralPath $target -Destination $old"));
        assert!(script.contains("Move-Item -LiteralPath $new -Destination $target"));
        assert!(script.contains("Start-Process -FilePath $target -ArgumentList '--show'"));
        // Rollback: move the backup back and start the old exe.
        assert!(script.contains("Move-Item -LiteralPath $old -Destination $target -Force"));
        assert!(script.contains("Set-Content -LiteralPath $log"));
        // The helper deletes itself once done.
        assert!(script.contains("Remove-Item -LiteralPath $PSCommandPath"));
    }

    #[test]
    fn update_script_quotes_chinese_paths() {
        let exe = PathBuf::from(r"D:\我的程序\lexora.exe");
        let script = build_update_script(&exe, Path::new(r"D:\我的程序\new.exe"), 1);
        assert!(script.contains(r"'D:\我的程序\lexora.exe'"));
        assert!(script.contains(r"'D:\我的程序\update-error.log'"));
    }

    /// Optional smoke test (not run by default): runs the generated PowerShell
    /// against a real shell and swaps two throwaway executable copies.
    ///
    /// ```text
    /// cargo test manual_update_script_swap -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "manual smoke test: spawns powershell and swaps throwaway exe copies"]
    fn manual_update_script_swap() {
        use std::process::Command;

        let dir = tempfile::TempDir::new().unwrap();
        let target = dir.path().join("lexora.exe");
        let new = dir.path().join("lexora-update-0.2.0.exe");
        // Start-Process needs real executables; two different System32 tools
        // make the swap observable through the file size.
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        let system32 = PathBuf::from(system_root).join("System32");
        std::fs::copy(system32.join("where.exe"), &target).unwrap();
        let new_bytes = std::fs::read(system32.join("whoami.exe")).unwrap();
        std::fs::write(&new, &new_bytes).unwrap();
        let expected_len = new_bytes.len() as u64;
        assert_ne!(expected_len, std::fs::metadata(&target).unwrap().len());

        // A dead pid lets Wait-Process return immediately.
        let mut child = Command::new("cmd").args(["/c", "exit"]).spawn().unwrap();
        let dead_pid = child.id();
        let _ = child.wait();

        let body = build_update_script(&target, &new, dead_pid);
        let script = dir.path().join("update.ps1");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(body.as_bytes());
        std::fs::write(&script, bytes).unwrap();

        let status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-File",
            ])
            .arg(&script)
            .status()
            .expect("powershell should be available");
        assert!(status.success(), "script exit status: {status}");
        assert!(target.is_file(), "target exe missing after the swap");
        assert_eq!(
            std::fs::metadata(&target).unwrap().len(),
            expected_len,
            "the new binary must replace the old one"
        );
        assert!(!new.exists(), "downloaded file must be moved");
        assert!(
            !dir.path().join("lexora.exe.old").exists(),
            "backup must be removed"
        );
        assert!(!script.exists(), "the helper must delete itself");
        assert!(
            !dir.path().join("update-error.log").exists(),
            "unexpected rollback log"
        );
    }
}
