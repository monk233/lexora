//! Screenshot capture core: monitor grabbing (`xcap`), reusable hidden overlay
//! windows, on-device OCR (`native-ocr`) / vision-model transcription, screenshot
//! panel skills streamed into the picker result panel and the configurable global
//! screenshot hotkey.
//!
//! Flow (contract §10.1): [`CaptureService::start`] keeps the settings window
//! and the picker open and lets them appear in the frozen image; the overlay
//! windows are **not** excluded from screen capture, so system screenshot tools
//! and recorders can see the Lexora capture UI (contract §11.11.1) — long
//! screenshots hide the overlay before grabbing frames instead. The capture
//! reuses the overlay webviews of the previous capture, grabs every monitor and
//! pre-encodes each one as a **JPEG data URL** on blocking worker threads
//! before arming the overlays. While the overlay is active
//! [`crate::selection::SelectionService::set_capture_active`] keeps ordinary
//! input from dismissing the picker (contract §10.1), and a second screenshot
//! trigger is rejected until the current one ends (contract §11.11.2).
//! Arming emits `capture-armed {index}`; the page resets itself, fetches the
//! cached data URL via `capture_monitor_info`, paints it and calls
//! `capture_ready`, which shows that overlay window (already transparent, no
//! black/white flash). As a safety net the shell shows every overlay whose
//! renderer still has not reported readiness 2.5 s after `start`.
//!
//! Panel skills (`capture_skill`): crop the region from the session, copy the
//! image to the system clipboard, remember it as [`LastCapture`], hide the
//! overlays (they stay alive for the next capture), show the picker at the
//! bottom-right corner of the selection and stream the transcription /
//! translation / vision result to the picker through the same `translate-event`
//! channel the text skills use (contract §10.3/§10.5). Text extraction prefers
//! the vision model, streams the transcription into the panel and falls back to
//! Windows OCR (contract §10.8).
//!
//! The region hotkey (default `Win+Shift+X`) lives on its own Windows message
//! thread so it can be re-registered at runtime (`capture_set_hotkey`, contract
//! §10.4) without restarting the app.
//!
//! Round 9 (contract §11) adds the annotation layer composited on export
//! (`capture_copy`/`capture_skill`/`capture_pin`) and the scrolling long
//! screenshot (`capture_longshot`), which stitches overlapping frames and hands
//! the result to the pin module.
//!
//! Round 22 (contract §11.14) adds the manual-scroll long screenshot in
//! [`crate::longshot`]; it reuses this module's stitcher helpers
//! ([`Stitched`], [`find_overlap`], [`frames_identical`]) while the user scrolls
//! the target application themselves. The old automatic `capture_longshot` is
//! deprecated but kept for debugging.
//!
//! Round 23 adds cross-monitor selections: the capture page keeps its selection
//! in global virtual-screen coordinates ([`GlobalRect`]), `capture_layout`
//! reports the physical monitor layout ([`LayoutSnapshot`]), and
//! [`CaptureService::crop_global`] stitches the frozen monitor images into one
//! crop, black where no monitor covers the virtual screen.

use std::collections::HashSet;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use futures_util::StreamExt;
use image::{DynamicImage, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::engine::{EngineError, EngineService};
use crate::logger::Logger;
use crate::selection::{picker_config_with_engine, PickerPayload};
use crate::settings::{
    normalize_shortcut, parse_shortcut, Settings, Shortcut, ShortcutKey, DEFAULT_REGION_SHORTCUT,
};
use crate::state::{lock, AppState, TranslateTask};
use crate::windows::CaptureGeometry;

/// Fallback: show every overlay this long after `start` when the renderer never
/// called `capture_ready` (contract §10.1).
const OVERLAY_FALLBACK_DELAY: Duration = Duration::from_millis(2_500);
/// JPEG quality of the overlay display image (contract §10.1). Crop/vision
/// requests keep using the original lossless RGBA pixels.
const DISPLAY_JPEG_QUALITY: u8 = 85;
/// Upper bound for a cross-monitor crop in physical pixels: four 4K monitors
/// are ~33 M pixels, so this only rejects a bogus renderer-provided rect before
/// it allocates gigabytes.
const MAX_GLOBAL_CROP_PIXELS: u64 = 64_000_000;
/// Event carrying one screenshot result panel (`picker-image`, contract §10.5).
const EVENT_PICKER_IMAGE: &str = "picker-image";
/// Event carrying the streamed chunks of a screenshot skill (contract §10.3).
const EVENT_TRANSLATE: &str = "translate-event";
/// Rust → `capture-<index>`: a fresh screenshot session is ready for that
/// monitor; a reused page resets itself and fetches the new display image.
pub const EVENT_CAPTURE_ARMED: &str = "capture-armed";
/// Rust → `capture-<index>` while a long screenshot is stitched (contract §11.4).
const EVENT_LONGSHOT_PROGRESS: &str = "capture-longshot-progress";
/// Rust → `capture-<index>` when a long screenshot finished or failed (§11.4).
const EVENT_LONGSHOT_DONE: &str = "capture-longshot-done";
/// Long screenshot: hard limits and scroll pacing (contract §11.6).
const LONGSHOT_MAX_FRAMES: u32 = 30;
const LONGSHOT_MAX_HEIGHT: u32 = 30_000;
/// Memory guard: a very wide selection would exhaust memory long before the
/// 30 000-row cap, so the stitched image also stops at this pixel budget
/// (reported as `max-height`).
const LONGSHOT_MAX_PIXELS: u64 = 64_000_000;
const LONGSHOT_SCROLL_NOTCHES: i32 = 3;
const LONGSHOT_SCROLL_SETTLE: Duration = Duration::from_millis(80);
const LONGSHOT_FRAME_DELAY: Duration = Duration::from_millis(400);
/// Extra wait before retaking a frame that looked identical (smooth scrolling).
const LONGSHOT_SAME_FRAME_RETRY_DELAY: Duration = Duration::from_millis(450);
/// Smallest row overlap considered by the stitcher, as a share of the frame
/// height. Small values let fast scrolling (a large step per frame) still match
/// — the manual long screenshot grabs ~35 frames/s, so a fast flick only moves
/// a few dozen rows between frames (contract §11.14.1).
const LONGSHOT_MIN_OVERLAP_RATIO: f64 = 0.03;
const LONGSHOT_MAX_OVERLAP_RATIO: f64 = 0.90;
const LONGSHOT_ROW_DIFF_THRESHOLD: f64 = 8.0;
const LONGSHOT_SAME_FRAME_THRESHOLD: f64 = 3.0;
/// Maximum mean absolute RGB difference allowed for an overlap candidate. A
/// smooth-scrolled frame can be offset by a fraction of a pixel, and web pages
/// may animate/re-render while scrolling, so text edges differ while the overall
/// image matches; the mean stays far below this bar for a real overlap and far
/// above it for unrelated content. Erring on the tolerant side matters: a
/// rejected frame is content that never gets stitched.
const LONGSHOT_OVERLAP_MAX_MEAN_DIFF: f64 = 7.0;
/// Monotonic part of generated request ids.
static REQUEST_SEQ: AtomicU64 = AtomicU64::new(0);

// Windows virtual-key / modifier values used by the screenshot hotkey. They are
// plain numbers so the mapping stays a pure, unit-testable function.
const MOD_ALT_RAW: u32 = 0x0001;
const MOD_CONTROL_RAW: u32 = 0x0002;
const MOD_SHIFT_RAW: u32 = 0x0004;
const MOD_WIN_RAW: u32 = 0x0008;
const MOD_NOREPEAT_RAW: u32 = 0x4000;
const HOTKEY_ID: i32 = 0x4c58; // 'LX'
/// `WM_APP + 1`: posted to the hotkey thread to re-register the shortcut.
const HOTKEY_RELOAD_MESSAGE: u32 = 0x8001;

/// Thread id of the hotkey message loop (0 = not running yet).
static HOTKEY_THREAD_ID: AtomicU32 = AtomicU32::new(0);
/// Shortcut currently registered by the hotkey thread (used for rollback).
static CURRENT_HOTKEY: Mutex<Option<Shortcut>> = Mutex::new(None);
/// Pending re-registration request handed from a command to the hotkey thread.
static PENDING_HOTKEY: Mutex<Option<HotkeyRequest>> = Mutex::new(None);

/// A physical-pixel rectangle on the selected monitor, sent by the capture page.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A physical-pixel rectangle in virtual-screen coordinates, spanning any
/// monitors. The capture page sends this for a cross-monitor selection; the
/// legacy [`HitRect`] is relative to one captured monitor and keeps working
/// for single-monitor selections (contract §10.3).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GlobalRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Physical geometry of one captured monitor; part of [`LayoutSnapshot`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    pub index: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Monitor layout of the active capture session: one entry per captured monitor
/// plus the bounding box of the whole virtual screen. `capture_layout` sends
/// this to the capture page so a selection can be kept in global physical
/// coordinates while the per-monitor overlays paint it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSnapshot {
    pub monitors: Vec<MonitorSnapshot>,
    pub bounds: GlobalRect,
}

/// First frame + physical geometry of a manual-scroll long screenshot
/// (contract §11.14). The background stitcher captures the same monitor region
/// while the user scrolls the target application.
pub(crate) struct LongshotSeed {
    pub(crate) first_frame: RgbaImage,
    pub(crate) origin_x: i32,
    pub(crate) origin_y: i32,
    pub(crate) monitor_width: u32,
    pub(crate) monitor_height: u32,
    /// `(left, top, width, height)` inside the captured monitor image.
    pub(crate) crop: (u32, u32, u32, u32),
}

/// Optional preset chosen when the screenshot was started from a picker skill.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PresetInfo {
    skill_id: String,
    label: String,
}

/// One captured monitor. `display_url` is the pre-encoded JPEG painted by the
/// overlay; `image` keeps the original lossless RGBA pixels used for cropping
/// and vision requests (contract §10.1).
struct Shot {
    index: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    image: RgbaImage,
    display_url: String,
}

/// Screenshot in progress: one image per monitor plus the optional preset.
struct Session {
    shots: Vec<Shot>,
    preset: Option<PresetInfo>,
}

/// Panel skill a screenshot result panel can run (contract §10.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SkillAction {
    Ocr,
    Translate,
    Explain,
    Custom,
}

impl SkillAction {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "ocr" => Some(SkillAction::Ocr),
            "translate" => Some(SkillAction::Translate),
            "explain" => Some(SkillAction::Explain),
            "custom" => Some(SkillAction::Custom),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            SkillAction::Ocr => "ocr",
            SkillAction::Translate => "translate",
            SkillAction::Explain => "explain",
            SkillAction::Custom => "custom",
        }
    }

    /// `true` for actions that send the cropped image to a vision model.
    fn is_vision(self) -> bool {
        matches!(self, SkillAction::Explain | SkillAction::Custom)
    }
}

/// Resolved metadata of a skill request: label shown in the result panel plus
/// the system prompt used by vision actions.
struct SkillMeta {
    label: String,
    skill_id: String,
    system_prompt: String,
    /// Screenshot dictionary prompt; only the translate action routes candidate
    /// words to it (`picker.capturePrompts.wordLookup`).
    word_lookup_prompt: String,
}

/// Last screenshot kept for retry / follow-up (contract §10.3).
#[derive(Clone)]
struct LastCapture {
    image: RgbaImage,
    data_url: String,
    action: SkillAction,
    skill_id: String,
    target_lang: String,
    label: String,
    /// OCR cache: a successful translation reuses it for follow-up questions.
    ocr_text: Option<String>,
}

/// One validated screenshot action ready to stream into the picker panel.
pub struct CaptureJob {
    request_id: String,
    action: SkillAction,
    image: RgbaImage,
    data_url: String,
    target_lang: String,
    /// Rendered vision prompt (explain/custom); empty for OCR/translate.
    system_prompt: String,
    /// Candidate-word dictionary prompt for the translate action.
    word_lookup_prompt: String,
    /// Cached OCR text reused by `translate` (and its follow-up questions).
    ocr_text: Option<String>,
    /// Whether the cropped image reached the system clipboard.
    clipboard: bool,
}

impl CaptureJob {
    /// Whether the cropped screenshot reached the system clipboard.
    pub fn clipboard(&self) -> bool {
        self.clipboard
    }
}

/// One follow-up question about the last screenshot.
pub struct FollowupJob {
    request_id: String,
    image: RgbaImage,
    data_url: String,
    action: SkillAction,
    ocr_text: Option<String>,
    question: String,
    previous_answer: String,
    history: Vec<(String, String)>,
}

/// Screenshot state stored in [`AppState`].
pub struct CaptureService {
    session: Mutex<Option<Session>>,
    last: Mutex<Option<LastCapture>>,
    /// Physical monitor layout the overlay windows were created for. An
    /// identical layout reuses the loaded webviews; a different one destroys
    /// and recreates them (contract §10.1).
    layout: Mutex<Option<Vec<CaptureGeometry>>>,
    /// Bumped on every session change so a stale 2.5 s fallback show is a no-op.
    epoch: AtomicU64,
    /// Monitors whose overlay renderer reported `capture_ready` for the current
    /// session. Readiness is tracked per monitor so the 2.5 s fallback only
    /// shows the overlays whose renderer never painted: a single healthy
    /// renderer must not mask another overlay that never became ready.
    ready_monitors: Mutex<HashSet<u32>>,
    /// Guards against two overlapping `start` calls (e.g. the hotkey pressed
    /// again while the first screenshot is still being encoded).
    starting: AtomicBool,
    /// Guards against two overlapping long-screenshot runs; while set, a new
    /// screenshot start is rejected too.
    longshot_running: AtomicBool,
}

impl CaptureService {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
            last: Mutex::new(None),
            layout: Mutex::new(None),
            epoch: AtomicU64::new(0),
            ready_monitors: Mutex::new(HashSet::new()),
            starting: AtomicBool::new(false),
            longshot_running: AtomicBool::new(false),
        }
    }

    /// Records that the overlay of monitor `index` painted its screenshot and is
    /// about to be shown.
    pub fn mark_ready(&self, index: u32) {
        lock(&self.ready_monitors).insert(index);
    }

    /// `true` while a screenshot session exists: the overlays are armed/shown
    /// (or about to be) and the user has not finished or cancelled yet. A new
    /// screenshot trigger is rejected instead of replacing the frozen frame
    /// (contract §11.11.2, QQ behavior).
    pub fn is_active(&self) -> bool {
        lock(&self.session).is_some()
    }

    /// Crops the selected region of the active session and returns it together
    /// with the monitor geometry: the first frame of a manual-scroll long
    /// screenshot (contract §11.14). The capture overlay stays untouched; the
    /// caller hides it before the user starts scrolling.
    pub fn longshot_seed(&self, index: u32, rect: &HitRect) -> Result<LongshotSeed, EngineError> {
        let guard = lock(&self.session);
        let Some(session) = guard.as_ref() else {
            return Err(not_ready_error());
        };
        let shot = session
            .shots
            .iter()
            .find(|shot| shot.index == index)
            .ok_or_else(|| missing_monitor_error(index))?;
        let (left, top, width, height) = clamp_rect(&shot.image, rect)
            .ok_or_else(|| EngineError::new("选区无效。", "请重新框选一个有效的区域后再试。"))?;
        let first_frame =
            image::imageops::crop_imm(&shot.image, left, top, width, height).to_image();
        Ok(LongshotSeed {
            first_frame,
            origin_x: shot.x,
            origin_y: shot.y,
            monitor_width: shot.width,
            monitor_height: shot.height,
            crop: (left, top, width, height),
        })
    }

    /// Prepares one screenshot: keeps the settings/picker windows open **and
    /// inside the frozen image** (user request), reuses the overlay webviews
    /// when the monitor layout is unchanged, grabs every monitor, pre-encodes
    /// the display images in parallel and arms the overlays. Returns the number
    /// of monitors.
    ///
    /// A second call while the first one is still preparing is rejected: the
    /// hotkey may be pressed twice because the overlay only appears once the
    /// renderer painted the screenshot.
    pub async fn start(
        &self,
        app: &AppHandle,
        state: &AppState,
        preset_skill_id: Option<String>,
    ) -> Result<usize, EngineError> {
        if self.longshot_running.load(Ordering::SeqCst) {
            state
                .log
                .warn("screenshot capture ignored: a long screenshot is running");
            return Err(EngineError::new(
                "长截图正在进行中。",
                "请等待当前长截图结束后再截图。",
            ));
        }
        // Single-screenshot guard (contract §11.11.2): while an overlay session
        // exists, a second trigger from the hotkey / picker / command is
        // rejected. The active session and the shown overlay stay untouched.
        if self.is_active() {
            state
                .log
                .warn("screenshot capture ignored: a capture is already active");
            return Err(capture_already_active_error());
        }
        if self.starting.swap(true, Ordering::SeqCst) {
            state
                .log
                .warn("screenshot capture ignored: another capture is being prepared");
            return Err(EngineError::new(
                "截图正在进行中。",
                "请稍候片刻，等截图界面出现后再试。",
            ));
        }
        // Reset the flag even when the preparation panics, otherwise every
        // later screenshot would be rejected.
        let _guard = StartGuard(&self.starting);
        // The picker/settings stay open while the user frames the screenshot;
        // the global input hook must not dismiss them until the flow ends
        // (contract §10.1).
        state.selection.set_capture_active(true);
        let mut flow = CaptureFlowGuard {
            service: self,
            app,
            armed: false,
        };
        let result = self.prepare_capture(app, state, preset_skill_id).await;
        // A prepared overlay keeps the gate until `close` / `skill` / `copy`;
        // an error (or panic) releases it right away.
        flow.armed = result.is_ok();
        result
    }

    /// Body of [`CaptureService::start`]: the part that can fail. On success the
    /// capture stays active until `close` / `skill` / `copy`.
    async fn prepare_capture(
        &self,
        app: &AppHandle,
        state: &AppState,
        preset_skill_id: Option<String>,
    ) -> Result<usize, EngineError> {
        let started = Instant::now();

        // A new capture always replaces the previous session and retry image.
        // Clearing the session *before* the overlay webviews are armed is what
        // keeps a reused page from painting the previous screenshot.
        self.clear_session();
        *lock(&self.last) = None;

        // Keep the settings/picker windows open **and let them appear in the
        // frozen screenshot** (user request): nothing is hidden or excluded.
        // Only a stale overlay from the previous capture is hidden first so the
        // next round starts from a clean renderer.
        crate::windows::hide_capture_windows(app);

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

        // Enumerate monitors, make sure one hidden overlay exists per monitor
        // (its webview starts loading in the background), then grab the screen.
        // `xcap::Monitor` is not `Send`, so this block has no await points.
        let (layout, created, reused, overlay_ms, capture_ms, raw) = {
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

            let overlay_started = Instant::now();
            let layout: Vec<CaptureGeometry> = monitors
                .iter()
                .enumerate()
                .map(|(index, monitor)| CaptureGeometry {
                    index: index as u32,
                    x: monitor.x().unwrap_or(0),
                    y: monitor.y().unwrap_or(0),
                    width: monitor.width().unwrap_or(0),
                    height: monitor.height().unwrap_or(0),
                })
                .collect();
            let (created, reused) = self.ensure_overlay_windows(app, &layout)?;
            let overlay_ms = overlay_started.elapsed().as_millis();

            let capture_started = Instant::now();
            let mut raw = Vec::with_capacity(monitors.len());
            for (index, monitor) in monitors.iter().enumerate() {
                let image = monitor.capture_image().map_err(|error| {
                    EngineError::new(
                        "截取屏幕失败。",
                        format!("请确认没有其他程序独占屏幕后重试（{error}）。"),
                    )
                })?;
                let mut geometry = layout[index];
                // Some drivers do not report the size; the grabbed bitmap is
                // the authoritative physical size then.
                if geometry.width == 0 {
                    geometry.width = image.width();
                }
                if geometry.height == 0 {
                    geometry.height = image.height();
                }
                raw.push((geometry, image));
            }
            let capture_ms = capture_started.elapsed().as_millis();
            (layout, created, reused, overlay_ms, capture_ms, raw)
        };

        let overlay_mode = if created == 0 {
            "reuse"
        } else if reused == 0 {
            "create"
        } else {
            "mixed"
        };
        state.log.info(&format!(
            "screenshot capture: monitors={} overlay={overlay_mode} created={created} \
             reused={reused} overlay_ms={overlay_ms}",
            layout.len()
        ));

        // Pre-encode the display JPEGs on parallel blocking workers (contract
        // §10.1: JPEG is several times faster than PNG for IPC + webview decode).
        let encode_started = Instant::now();
        let mut handles = Vec::with_capacity(raw.len());
        for (geometry, image) in raw {
            handles.push(tauri::async_runtime::spawn_blocking(move || {
                let display_url = jpeg_data_url(&image)?;
                Ok::<Shot, EngineError>(Shot {
                    index: geometry.index,
                    x: geometry.x,
                    y: geometry.y,
                    width: geometry.width,
                    height: geometry.height,
                    image,
                    display_url,
                })
            }));
        }
        let mut shots = Vec::with_capacity(handles.len());
        for handle in handles {
            let encoded = handle.await.map_err(|error| {
                EngineError::new(
                    "编码截图失败。",
                    format!("后台编码任务异常，请重试（{error}）。"),
                )
            })?;
            shots.push(encoded?);
        }
        let encode_ms = encode_started.elapsed().as_millis();

        let count = shots.len();
        let display_kb = shots
            .iter()
            .map(|shot| shot.display_url.len())
            .sum::<usize>()
            / 1024;
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        // Session first, arm second: an armed renderer polls immediately.
        lock(&self.ready_monitors).clear();
        *lock(&self.session) = Some(Session { shots, preset });
        for geometry in &layout {
            let _ = app.emit_to(
                geometry.label(),
                EVENT_CAPTURE_ARMED,
                json!({ "index": geometry.index }),
            );
        }

        // Safety net: if a renderer never reports `capture_ready` (crashed
        // webview, script error, …) its overlay is shown anyway. Readiness is
        // tracked **per monitor**, so a healthy renderer never suppresses the
        // fallback of another overlay that never painted (a shared flag here
        // used to leave the primary overlay invisible forever when only the
        // secondary renderer reported ready).
        let fallback_app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(OVERLAY_FALLBACK_DELAY).await;
            let Some(state) = fallback_app.try_state::<Arc<AppState>>() else {
                return;
            };
            if state.capture.epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            let missing = {
                let guard = lock(&state.capture.session);
                let Some(session) = guard.as_ref() else {
                    return;
                };
                let ready = lock(&state.capture.ready_monitors);
                missing_ready_monitors(&session.shots, &ready)
            };
            if missing.is_empty() {
                return;
            }
            state.log.warn(&format!(
                "screenshot overlay fallback: capture_ready missing for monitors {missing:?}, \
                 showing those overlays"
            ));
            for index in missing {
                crate::windows::show_capture_window(&fallback_app, index);
            }
        });

        let total_ms = started.elapsed().as_millis();
        state.log.info(&format!(
            "screenshot capture ready: monitors={count} overlay={overlay_mode} \
             capture_ms={capture_ms} encode_ms={encode_ms} total_ms={total_ms} display_kb={display_kb}"
        ));
        Ok(count)
    }

    /// Forgets the current session and invalidates a pending fallback show. The
    /// overlay windows are left untouched (hidden and reusable, contract §10.1).
    fn clear_session(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        *lock(&self.session) = None;
    }

    /// Makes sure one hidden overlay window exists per monitor. When the layout
    /// is unchanged the already loaded webviews are reused; otherwise every
    /// overlay is destroyed and created again (contract §10.1). Returns the
    /// number of created and reused windows. On failure all overlays are
    /// destroyed so the next capture starts from a clean state.
    fn ensure_overlay_windows(
        &self,
        app: &AppHandle,
        layout: &[CaptureGeometry],
    ) -> Result<(usize, usize), EngineError> {
        let previous = lock(&self.layout).clone();
        let reuse = previous
            .as_deref()
            .is_some_and(|previous| crate::windows::layout_matches(previous, layout));
        if !reuse {
            crate::windows::destroy_capture_windows(app);
            *lock(&self.layout) = None;
        }
        let mut created = 0usize;
        let mut reused = 0usize;
        for geometry in layout {
            let exists = reuse && app.get_webview_window(&geometry.label()).is_some();
            if exists {
                reused += 1;
                continue;
            }
            if let Err(error) = crate::windows::create_capture_window(app, *geometry) {
                crate::windows::destroy_capture_windows(app);
                *lock(&self.layout) = None;
                return Err(EngineError::new(
                    "无法创建截图窗口。",
                    format!("请重试或重启程序（{error}）。"),
                ));
            }
            created += 1;
        }
        *lock(&self.layout) = Some(layout.to_vec());
        Ok((created, reused))
    }

    /// JPEG data URL + original physical monitor geometry (+ preset) for the
    /// capture page of `index`: `x`/`y` are the monitor origin in virtual-screen
    /// physical pixels, `width`/`height` its physical size. The data URL is the
    /// one pre-encoded by [`CaptureService::start`]; the JPEG is display-only
    /// (contract §10.3).
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
        let preset = session
            .preset
            .as_ref()
            .map(|preset| serde_json::to_value(preset).unwrap_or(Value::Null))
            .unwrap_or(Value::Null);
        Ok(json!({
            "index": index,
            "x": shot.x,
            "y": shot.y,
            "width": shot.width,
            "height": shot.height,
            "dataUrl": shot.display_url,
            "preset": preset,
        }))
    }

    /// Physical monitor layout + virtual-screen bounds of the active capture
    /// session. `None` when no session is armed: the capture page then reports
    /// "not ready" and waits for the next screenshot.
    pub fn layout_snapshot(&self) -> Option<LayoutSnapshot> {
        let guard = lock(&self.session);
        let session = guard.as_ref()?;
        let monitors: Vec<MonitorSnapshot> = session
            .shots
            .iter()
            .map(|shot| MonitorSnapshot {
                index: shot.index,
                x: shot.x,
                y: shot.y,
                width: shot.width,
                height: shot.height,
            })
            .collect();
        let bounds = layout_bounds(&monitors)?;
        Some(LayoutSnapshot { monitors, bounds })
    }

    /// Crops the selected region of the session image. The image is shared with
    /// the retry/follow-up data, so the annotation layer is only composited into
    /// the returned copy (contract §11.4).
    pub fn crop_region(
        &self,
        index: u32,
        rect: &HitRect,
        annotations: Option<String>,
    ) -> Result<RgbaImage, EngineError> {
        let mut image = {
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
        composite_annotations(&mut image, annotations)?;
        Ok(image)
    }

    /// Crops a cross-monitor selection: the output is `rect.width`×`rect.height`
    /// physical pixels, filled black and stitched from every captured monitor
    /// that intersects the rect (contract §10.3). Virtual-screen gaps without a
    /// monitor stay black, exactly like the frozen screenshot.
    pub fn crop_global(&self, rect: &GlobalRect) -> Result<RgbaImage, EngineError> {
        let guard = lock(&self.session);
        let Some(session) = guard.as_ref() else {
            return Err(not_ready_error());
        };
        stitch_global(&session.shots, rect)
    }

    /// Physical screen origin (top-left) of a selection: the global rect when the
    /// selection spans monitors, otherwise the monitor origin plus the rect
    /// offset. Used to place the pin window where the screenshot was taken.
    pub fn selection_origin(
        &self,
        index: u32,
        rect: &HitRect,
        global_rect: Option<&GlobalRect>,
    ) -> Result<(i32, i32), EngineError> {
        if let Some(global) = global_rect {
            return Ok((global.x, global.y));
        }
        let guard = lock(&self.session);
        let Some(session) = guard.as_ref() else {
            return Err(not_ready_error());
        };
        let shot = session
            .shots
            .iter()
            .find(|shot| shot.index == index)
            .ok_or_else(|| missing_monitor_error(index))?;
        Ok((
            shot.x + rect.x.round() as i32,
            shot.y + rect.y.round() as i32,
        ))
    }

    /// Crops the selection for export: a `global_rect` takes the cross-monitor
    /// stitcher, otherwise the legacy single-monitor `index` + [`HitRect`] path
    /// is used. The annotation layer is composited over the crop either way
    /// (contract §11.4).
    pub fn crop_selection(
        &self,
        index: u32,
        rect: &HitRect,
        annotations: Option<String>,
        global_rect: Option<&GlobalRect>,
    ) -> Result<RgbaImage, EngineError> {
        match global_rect {
            Some(global) => {
                let mut image = self.crop_global(global)?;
                composite_annotations(&mut image, annotations)?;
                Ok(image)
            }
            None => self.crop_region(index, rect, annotations),
        }
    }

    /// Copies the cropped selection to the clipboard (with the annotation layer
    /// composited), then hides the capture UI (the overlay windows stay reusable
    /// for the next capture). A `global_rect` copies a cross-monitor selection
    /// stitched by [`CaptureService::crop_global`].
    pub fn copy(
        &self,
        app: &AppHandle,
        index: u32,
        rect: &HitRect,
        annotations: Option<String>,
        global_rect: Option<&GlobalRect>,
    ) -> Result<(), EngineError> {
        let cropped = self.crop_selection(index, rect, annotations, global_rect)?;
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

    /// Runs a panel skill on the selected region and switches to the picker
    /// result panel (contract §10.3, steps 1–6). A `global_rect` runs the skill
    /// on a cross-monitor selection; otherwise the legacy single-monitor path is
    /// kept. All validation happens before any side effect, so an invalid
    /// request leaves the overlays untouched.
    pub fn skill(
        &self,
        app: &AppHandle,
        index: u32,
        rect: &HitRect,
        action: &str,
        skill_id: Option<String>,
        target_lang: Option<String>,
        request_id: Option<String>,
        annotations: Option<String>,
        global_rect: Option<&GlobalRect>,
    ) -> Result<CaptureJob, EngineError> {
        let settings = settings_of(app)?;
        let action = parse_skill_action(action)?;
        let requested_skill = trimmed(skill_id);
        let requested_target =
            trimmed(target_lang).unwrap_or_else(|| settings.picker.default_target_lang.clone());
        // Validates the custom skill (enabled kind=image) and renders the prompt.
        let meta = resolve_skill_meta(
            &settings,
            action,
            requested_skill.as_deref(),
            &requested_target,
        )?;

        // 1. Crop the selection from the captured monitor(s). A cross-monitor
        //    selection is stitched in virtual-screen coordinates; the legacy
        //    index + HitRect path crops one monitor and keeps its anchor there.
        let (image, data_url, anchor, scale) = if let Some(global) = global_rect {
            let mut image = self.crop_global(global)?;
            // The annotation layer is rasterized on the fly; clipboard and the
            // AI request always use the composited image (contract §11.4).
            composite_annotations(&mut image, annotations)?;
            let data_url = png_data_url(&image)?;
            let anchor = global_anchor(global);
            let scale = crate::win32::monitor_scale_factor(anchor.0, anchor.1);
            (image, data_url, anchor, scale)
        } else {
            let guard = lock(&self.session);
            let Some(session) = guard.as_ref() else {
                return Err(not_ready_error());
            };
            let shot = session
                .shots
                .iter()
                .find(|shot| shot.index == index)
                .ok_or_else(|| missing_monitor_error(index))?;
            let (left, top, width, height) = clamp_rect(&shot.image, rect).ok_or_else(|| {
                EngineError::new("选区无效。", "请重新框选一个有效的区域后再试。")
            })?;
            let mut image =
                image::imageops::crop_imm(&shot.image, left, top, width, height).to_image();
            // The annotation layer is rasterized on the fly; clipboard and the
            // AI request always use the composited image (contract §11.4).
            composite_annotations(&mut image, annotations)?;
            let data_url = png_data_url(&image)?;
            let (image_width, image_height) = shot.image.dimensions();
            let anchor = anchor_bottom_right(
                shot.x,
                shot.y,
                image_width,
                image_height,
                left,
                top,
                width,
                height,
            );
            // The selection may end exactly on a monitor edge; use the centre of
            // the captured monitor so the DPI factor is always the right one.
            let scale = crate::win32::monitor_scale_factor(
                shot.x + shot.width as i32 / 2,
                shot.y + shot.height as i32 / 2,
            );
            (image, data_url, anchor, scale)
        };

        // 2-5. Clipboard, retry state, picker panel and streaming job.
        self.finish_skill_job(
            app,
            &settings,
            image,
            data_url,
            action,
            meta,
            requested_target,
            request_id,
            anchor,
            scale,
            true,
            "screenshot skill",
        )
    }

    /// Runs a panel skill on an external image (a pinned screenshot opened in
    /// the pin editor): there is no capture session, so the caller passes the
    /// image, the annotation layer and the picker anchor. Everything else
    /// (clipboard copy, retry state, picker panel, streaming job) is shared with
    /// the screenshot flow.
    #[allow(clippy::too_many_arguments)]
    pub fn skill_image(
        &self,
        app: &AppHandle,
        image: RgbaImage,
        annotations: Option<String>,
        action: &str,
        skill_id: Option<String>,
        target_lang: Option<String>,
        request_id: Option<String>,
        anchor: (i32, i32),
        scale: f64,
    ) -> Result<CaptureJob, EngineError> {
        let settings = settings_of(app)?;
        let action = parse_skill_action(action)?;
        let requested_skill = trimmed(skill_id);
        let requested_target =
            trimmed(target_lang).unwrap_or_else(|| settings.picker.default_target_lang.clone());
        let meta = resolve_skill_meta(
            &settings,
            action,
            requested_skill.as_deref(),
            &requested_target,
        )?;
        let mut image = image;
        composite_annotations(&mut image, annotations)?;
        let data_url = png_data_url(&image)?;
        self.finish_skill_job(
            app,
            &settings,
            image,
            data_url,
            action,
            meta,
            requested_target,
            request_id,
            anchor,
            scale,
            false,
            "pin skill",
        )
    }

    /// Shared tail of `skill` / `skill_image`: image clipboard, retry state,
    /// overlay closing (screenshot flow only), picker panel + streaming event.
    #[allow(clippy::too_many_arguments)]
    fn finish_skill_job(
        &self,
        app: &AppHandle,
        settings: &Settings,
        image: RgbaImage,
        data_url: String,
        action: SkillAction,
        meta: SkillMeta,
        target_lang: String,
        request_id: Option<String>,
        anchor: (i32, i32),
        scale: f64,
        hide_overlays: bool,
        log_label: &str,
    ) -> Result<CaptureJob, EngineError> {
        let engine = engine_of(app)?;
        // Image clipboard; a failure only flips the flag, the flow continues.
        let clipboard = write_clipboard_image(app, &image);

        // Remember the capture for retry / follow-up.
        *lock(&self.last) = Some(LastCapture {
            image: image.clone(),
            data_url: data_url.clone(),
            action,
            skill_id: meta.skill_id.clone(),
            target_lang: target_lang.clone(),
            label: meta.label.clone(),
            ocr_text: None,
        });

        // Screenshots hide the (reusable) overlays; the pin editor keeps its
        // window on screen.
        if hide_overlays {
            self.close(app);
        }
        let payload = PickerPayload {
            text: String::new(),
            program_name: "截图".to_string(),
            anchor_x: anchor.0,
            anchor_y: anchor.1,
            scale_factor: scale,
            config: picker_config_with_engine(settings, &engine),
        };
        if !crate::windows::show_picker(app, &payload) {
            return Err(EngineError::new(
                "无法显示结果面板。",
                "请重试；若问题持续请重启程序。",
            ));
        }

        // Tell the picker which panel to open and what is streaming into it.
        let request_id = normalize_request_id(request_id);
        let hint = if clipboard {
            "图片已复制到剪贴板"
        } else {
            "图片复制到剪贴板失败，但不影响识别与翻译"
        };
        let _ = app.emit_to(
            crate::windows::PICKER_LABEL,
            EVENT_PICKER_IMAGE,
            json!({
                "requestId": request_id,
                "action": action.as_str(),
                "skillId": meta.skill_id,
                "label": meta.label,
                "targetLang": target_lang,
                "clipboard": clipboard,
                "hint": hint,
            }),
        );

        log_of(app).map(|log| {
            log.info(&format!(
                "{log_label}: action={} label={} clipboard={} chars={}x{} request={request_id}",
                action.as_str(),
                meta.label,
                clipboard,
                image.width(),
                image.height()
            ))
        });

        Ok(CaptureJob {
            request_id,
            action,
            image,
            data_url,
            target_lang,
            system_prompt: meta.system_prompt,
            word_lookup_prompt: meta.word_lookup_prompt,
            ocr_text: None,
            clipboard,
        })
    }

    /// Builds (and re-validates) the job that repeats the last screenshot
    /// action; `ocr`/`translate` re-run OCR as required by contract §10.3. A
    /// screenshot translation may switch its target language (`targetLang`):
    /// the new value is stored on [`LastCapture`] so retries/follow-ups keep it.
    pub fn retry(
        &self,
        app: &AppHandle,
        request_id: String,
        target_lang: Option<String>,
    ) -> Result<CaptureJob, EngineError> {
        let settings = settings_of(app)?;
        let mut last = lock(&self.last).clone().ok_or_else(|| {
            EngineError::new("没有可重试的截图。", "请重新截图（快捷键）后再试一次。")
        })?;
        let updated_target = retry_target_lang(last.action, &last.target_lang, target_lang);
        if updated_target != last.target_lang {
            last.target_lang = updated_target.clone();
            if let Some(current) = lock(&self.last).as_mut() {
                current.target_lang = updated_target;
            }
        }
        let skill_id = if last.skill_id.is_empty() {
            None
        } else {
            Some(last.skill_id.as_str())
        };
        let meta = resolve_skill_meta(&settings, last.action, skill_id, &last.target_lang)?;
        // A retry always recognizes the text again (the previous OCR may have
        // been a transient failure) and drops the cache.
        if let Some(current) = lock(&self.last).as_mut() {
            current.ocr_text = None;
        }
        log_of(app).map(|log| {
            log.info(&format!(
                "screenshot retry: action={} label={} target={} request={request_id}",
                last.action.as_str(),
                last.label,
                last.target_lang
            ))
        });
        Ok(CaptureJob {
            request_id,
            action: last.action,
            image: last.image,
            data_url: last.data_url,
            target_lang: last.target_lang,
            system_prompt: meta.system_prompt,
            word_lookup_prompt: meta.word_lookup_prompt,
            ocr_text: None,
            clipboard: false,
        })
    }

    /// Builds a follow-up job for the last screenshot. Vision actions keep the
    /// image, OCR/translate actions keep (or lazily compute) the OCR text.
    pub fn followup(
        &self,
        request_id: String,
        question: String,
        previous_answer: String,
        history: Vec<(String, String)>,
    ) -> Result<FollowupJob, EngineError> {
        let last = lock(&self.last).clone().ok_or_else(|| {
            EngineError::new("没有可追问的截图。", "请重新截图（快捷键）后再试一次。")
        })?;
        Ok(FollowupJob {
            request_id,
            image: last.image,
            data_url: last.data_url,
            action: last.action,
            ocr_text: last.ocr_text,
            question,
            previous_answer,
            history,
        })
    }

    /// Caches OCR text for the capture it belongs to (the last capture may have
    /// been replaced by a newer screenshot while the stream was running).
    fn cache_ocr_text(&self, data_url: &str, text: &str) {
        if let Some(last) = lock(&self.last).as_mut() {
            if last.data_url == data_url && last.ocr_text.is_none() {
                last.ocr_text = Some(text.to_string());
            }
        }
    }

    /// Ends the capture flow: releases the input gate that kept the
    /// picker/settings open (contract §10.1).
    fn finish_capture(&self, app: &AppHandle) {
        if let Some(state) = app_state(app) {
            state.selection.set_capture_active(false);
        }
    }

    /// Hides every overlay window (they stay alive and are reused by the next
    /// capture, contract §10.1), forgets the session and ends the capture input
    /// gate. The last capture stays available for retry / follow-up
    /// (contract §10.3).
    pub fn close(&self, app: &AppHandle) {
        self.clear_session();
        crate::windows::hide_capture_windows(app);
        self.finish_capture(app);
    }

    /// **Deprecated** (contract §11.14): this is the old *automatic* scroll long
    /// screenshot; the UI now uses the manual-scroll preview commands in
    /// [`crate::longshot`]. Kept for compatibility/debugging, no UI calls it.
    ///
    /// Runs a scrolling long screenshot of the selected region (contract §11.6).
    ///
    /// The current session crop is the first frame; the capture overlay is
    /// hidden so the synthetic wheel input reaches the application below, then
    /// frames are grabbed and stitched by their overlapping rows. On success the
    /// PNG goes to the clipboard and into a new pin window. Emits
    /// `capture-longshot-progress` per stitched frame and `capture-longshot-done`
    /// at the end. On failure the overlays are shown again so the renderer can
    /// report the error and the selection stays usable.
    pub async fn longshot(
        &self,
        app: &AppHandle,
        index: u32,
        rect: &HitRect,
    ) -> Result<Value, EngineError> {
        if self.longshot_running.swap(true, Ordering::SeqCst) {
            return Err(EngineError::new(
                "长截图正在进行中。",
                "请等待当前长截图结束后再试。",
            ));
        }
        let _guard = LongshotGuard(&self.longshot_running);
        let label = format!("{}{index}", crate::windows::CAPTURE_PREFIX);

        let request = {
            let guard = lock(&self.session);
            let Some(session) = guard.as_ref() else {
                return Err(not_ready_error());
            };
            let shot = session
                .shots
                .iter()
                .find(|shot| shot.index == index)
                .ok_or_else(|| missing_monitor_error(index))?;
            let (left, top, width, height) = clamp_rect(&shot.image, rect).ok_or_else(|| {
                EngineError::new("选区无效。", "请重新框选一个有效的区域后再试。")
            })?;
            let first_frame =
                image::imageops::crop_imm(&shot.image, left, top, width, height).to_image();
            LongshotRequest {
                index,
                origin_x: shot.x,
                origin_y: shot.y,
                monitor_width: shot.width,
                monitor_height: shot.height,
                crop: (left, top, width, height),
                first_frame,
            }
        };
        let first_height = request.first_frame.height();
        // Where the selection was on screen: the stitched pin keeps that place.
        let pin_origin = (
            request.origin_x + request.crop.0 as i32,
            request.origin_y + request.crop.1 as i32,
        );

        // The wheel input must reach the application below the overlay, and the
        // overlay must never be part of a frame (contract §11.6).
        crate::windows::hide_capture_windows(app);
        tokio::time::sleep(Duration::from_millis(80)).await;

        let cursor_before = crate::win32::cursor_physical();
        if let Some(log) = log_of(app) {
            log.info(&format!(
                "longshot: start index={index} crop={}x{} at ({},{})",
                request.crop.2, request.crop.3, request.crop.0, request.crop.1
            ));
        }

        let worker_app = app.clone();
        let joined = tauri::async_runtime::spawn_blocking(move || {
            run_longshot(worker_app, request, cursor_before)
        })
        .await;
        let captured = match joined {
            Ok(result) => result,
            Err(error) => {
                let error = EngineError::new(
                    "长截图失败。",
                    format!("后台拼接任务异常，请重试（{error}）。"),
                );
                self.fail_longshot(
                    app,
                    &label,
                    0,
                    first_height,
                    LongshotStop::NoOverlap,
                    &error,
                );
                return Err(error);
            }
        };

        match captured {
            Ok(captured) => {
                let LongshotCapture {
                    image,
                    frames,
                    stop,
                } = captured;
                let (width, height) = image.dimensions();
                if height <= first_height {
                    let error = EngineError::new(
                        "没有可拼接的新内容。",
                        "所选区域没有随滚轮滚动（应用可能不响应滚轮，或已经滚动到边界）。",
                    );
                    self.fail_longshot(app, &label, frames, height, stop, &error);
                    return Err(error);
                }
                let clipboard = write_clipboard_image(app, &image);
                let pin = match crate::pin::create_pin(app, image, Some(pin_origin)) {
                    Ok(pin) => pin,
                    Err(error) => {
                        self.fail_longshot(app, &label, frames, height, stop, &error);
                        return Err(error);
                    }
                };
                let (pin_id, _, _) = pin;
                if let Some(log) = log_of(app) {
                    log.info(&format!(
                        "longshot: frames={frames} height={height} stop={}",
                        stop.as_str()
                    ));
                    if !clipboard {
                        log.warn("longshot: clipboard write failed, pin still created");
                    }
                }
                let _ = app.emit_to(
                    label.as_str(),
                    EVENT_LONGSHOT_DONE,
                    json!({
                        "ok": true,
                        "width": width,
                        "height": height,
                        "pinId": pin_id,
                        "frames": frames,
                    }),
                );
                // The capture is finished: hide the overlays, drop the session
                // and release the input gate.
                self.close(app);
                Ok(json!({
                    "ok": true,
                    "width": width,
                    "height": height,
                    "pinId": pin_id,
                    "frames": frames,
                }))
            }
            Err(error) => {
                self.fail_longshot(
                    app,
                    &label,
                    0,
                    first_height,
                    LongshotStop::NoOverlap,
                    &error,
                );
                Err(error)
            }
        }
    }

    /// Reports a failed long screenshot: logs the stop reason, emits
    /// `capture-longshot-done {ok:false}` and shows the overlays again so the
    /// renderer can display the error and the user can retry (contract §11.6).
    fn fail_longshot(
        &self,
        app: &AppHandle,
        label: &str,
        frames: u32,
        height: u32,
        stop: LongshotStop,
        error: &EngineError,
    ) {
        if let Some(log) = log_of(app) {
            log.warn(&format!(
                "longshot: frames={frames} height={height} stop={} error={}",
                stop.as_str(),
                error.message
            ));
        }
        // Show the overlay again **before** the renderer handles the failure, so
        // its error toast and toolbar are actually visible (contract §11.6).
        crate::windows::show_all_capture_windows(app);
        let _ = app.emit_to(
            label,
            EVENT_LONGSHOT_DONE,
            json!({ "ok": false, "error": error.message, "hint": error.hint }),
        );
    }
}

impl Default for CaptureService {
    fn default() -> Self {
        Self::new()
    }
}

/// Target language to use for a retried screenshot action: only `translate`
/// accepts a new target (`targetLang` on `capture_retry`), every other action
/// keeps the stored one (contract §10.3).
fn retry_target_lang(action: SkillAction, current: &str, requested: Option<String>) -> String {
    if action == SkillAction::Translate {
        if let Some(target) = trimmed(requested) {
            return target;
        }
    }
    current.to_string()
}

// ---------------------------------------------------------------------------
// Long screenshot (contract §11.6)
// ---------------------------------------------------------------------------

/// Why the long-screenshot loop stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LongshotStop {
    /// No reliable row overlap between the stitched image and the new frame.
    NoOverlap,
    /// The application did not scroll (frame identical to the previous one).
    SameFrame,
    /// The stitched image reached the height cap.
    MaxHeight,
    /// The frame cap was reached.
    MaxFrames,
}

impl LongshotStop {
    fn as_str(self) -> &'static str {
        match self {
            LongshotStop::NoOverlap => "no-overlap",
            LongshotStop::SameFrame => "same-frame",
            LongshotStop::MaxHeight => "max-height",
            LongshotStop::MaxFrames => "max-frames",
        }
    }
}

/// What the stitching loop should do with a freshly captured frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LongshotDecision {
    Continue,
    Stop(LongshotStop),
}

/// First frame plus the monitor/crop geometry the blocking worker needs.
struct LongshotRequest {
    index: u32,
    origin_x: i32,
    origin_y: i32,
    monitor_width: u32,
    monitor_height: u32,
    crop: (u32, u32, u32, u32),
    first_frame: RgbaImage,
}

/// Result of the blocking stitching worker.
struct LongshotCapture {
    image: RgbaImage,
    frames: u32,
    stop: LongshotStop,
}

/// Vertically growing RGBA buffer used while stitching: appending a frame only
/// copies its new rows, instead of cloning the whole stitched image every time.
pub(crate) struct Stitched {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

impl Stitched {
    pub(crate) fn from_image(image: &RgbaImage) -> Self {
        let (width, height) = image.dimensions();
        Self {
            width,
            height,
            data: image.as_raw().clone(),
        }
    }

    pub(crate) fn width(&self) -> u32 {
        self.width
    }

    pub(crate) fn height(&self) -> u32 {
        self.height
    }

    /// Appends the rows of `image` starting at `skip_rows` (the overlapping top
    /// part is not duplicated). Frames of a different width are ignored so the
    /// buffer can never become inconsistent.
    pub(crate) fn push_rows(&mut self, image: &RgbaImage, skip_rows: u32) {
        let width = self.width;
        if width == 0 || image.width() < width {
            return;
        }
        let source = image.as_raw();
        let source_width = image.width() as usize;
        let row_bytes = width as usize * 4;
        for y in skip_rows..image.height() {
            let start = y as usize * source_width * 4;
            self.data
                .extend_from_slice(&source[start..start + row_bytes]);
        }
        self.height = (self.data.len() / (width as usize * 4)) as u32;
    }

    /// Prepends the rows of `image` *above* the current content: its bottom
    /// `overlap` rows duplicate the top of the stitched image, the rest is
    /// inserted before it (manual long screenshot scrolled upwards, §11.14.1).
    pub(crate) fn prepend_rows(&mut self, image: &RgbaImage, overlap: u32) {
        let width = self.width;
        if width == 0 || image.width() < width {
            return;
        }
        let new_rows = image.height().saturating_sub(overlap);
        if new_rows == 0 {
            return;
        }
        let source = image.as_raw();
        let source_width = image.width() as usize;
        let row_bytes = width as usize * 4;
        let mut prefix = Vec::with_capacity(self.data.len() + new_rows as usize * row_bytes);
        for y in 0..new_rows {
            let start = y as usize * source_width * 4;
            prefix.extend_from_slice(&source[start..start + row_bytes]);
        }
        prefix.extend_from_slice(&self.data);
        self.data = prefix;
        self.height = (self.data.len() / (width as usize * 4)) as u32;
    }

    /// Copy of the stitched image (keeps the buffer usable for more frames).
    pub(crate) fn to_image(&self) -> RgbaImage {
        RgbaImage::from_raw(self.width.max(1), self.height.max(1), self.data.clone())
            .unwrap_or_else(|| RgbaImage::new(self.width.max(1), self.height.max(1)))
    }

    /// Nearest-neighbour downscale by `scale` (< 1.0). Frames are never enlarged.
    pub(crate) fn scaled_by(&self, scale: f64) -> RgbaImage {
        let (width, height) = (self.width.max(1), self.height.max(1));
        if !scale.is_finite() || scale <= 0.0 {
            return self.to_image();
        }
        if scale >= 1.0 {
            return self.to_image();
        }
        let out_width = ((width as f64 * scale).round() as u32).max(1);
        let out_height = ((height as f64 * scale).round() as u32).max(1);
        let mut out = RgbaImage::new(out_width, out_height);
        let out_data = out.as_mut();
        for y in 0..out_height {
            let source_y = ((y as u64 * height as u64) / out_height as u64) as usize;
            for x in 0..out_width {
                let source_x = ((x as u64 * width as u64) / out_width as u64) as usize;
                let source_offset = (source_y * width as usize + source_x) * 4;
                let target_offset = (y as usize * out_width as usize + x as usize) * 4;
                out_data[target_offset..target_offset + 4]
                    .copy_from_slice(&self.data[source_offset..source_offset + 4]);
            }
        }
        out
    }

    /// Nearest-neighbour resize to exactly `out_width`×`out_height` (used for the
    /// long-screenshot preview, whose window keeps a fixed content box while the
    /// stitched image grows: the encoded preview therefore never gets bigger).
    pub(crate) fn resized_to(&self, out_width: u32, out_height: u32) -> RgbaImage {
        let (width, height) = (self.width.max(1), self.height.max(1));
        let out_width = out_width.max(1);
        let out_height = out_height.max(1);
        let mut out = RgbaImage::new(out_width, out_height);
        let out_data = out.as_mut();
        for y in 0..out_height {
            let source_y = ((y as u64 * height as u64) / out_height as u64) as usize;
            for x in 0..out_width {
                let source_x = ((x as u64 * width as u64) / out_width as u64) as usize;
                let source_offset = (source_y * width as usize + source_x) * 4;
                let target_offset = (y as usize * out_width as usize + x as usize) * 4;
                out_data[target_offset..target_offset + 4]
                    .copy_from_slice(&self.data[source_offset..source_offset + 4]);
            }
        }
        out
    }

    pub(crate) fn into_image(self) -> RgbaImage {
        let width = self.width.max(1);
        let height = self.height.max(1);
        RgbaImage::from_raw(width, height, self.data)
            .unwrap_or_else(|| RgbaImage::new(width, height))
    }
}

fn stitched_pixel(stitched: &Stitched, x: u32, y: u32) -> [u8; 4] {
    let offset = (y as usize * stitched.width as usize + x as usize) * 4;
    [
        stitched.data[offset],
        stitched.data[offset + 1],
        stitched.data[offset + 2],
        stitched.data[offset + 3],
    ]
}

/// Finds the best row overlap between the bottom of `stitched` and the top of
/// `next` (candidate range 3%–90% of the frame height). A two-stage scan keeps
/// the per-frame cost low at ~25 frames/s: a sparse score is computed for EVERY
/// candidate (so the real overlap can never fall between grid points), the
/// plausible ones are refined at full precision, and repeated-looking content
/// (lines of text can match several offsets almost equally well) is disambiguated
/// by the previous frame's overlap — scrolling is continuous, so the candidate
/// closest to the last step wins. Returns `None` when no candidate matches
/// closely enough (contract §11.6/§11.14.1).
pub(crate) fn find_overlap(
    stitched: &Stitched,
    next: &RgbaImage,
    expected: Option<u32>,
) -> Option<u32> {
    let width = stitched.width.min(next.width());
    let next_height = next.height();
    if width == 0 || next_height < 2 || stitched.height() < 2 {
        return None;
    }
    let min_overlap = ((next_height as f64 * LONGSHOT_MIN_OVERLAP_RATIO).ceil() as u32).max(1);
    let max_overlap = ((next_height as f64 * LONGSHOT_MAX_OVERLAP_RATIO).floor() as u32)
        .min(stitched.height())
        .min(next_height.saturating_sub(1));
    if max_overlap < min_overlap {
        return None;
    }
    let coarse = |overlap: u32| coarse_overlap_difference(stitched, next, overlap, width);
    let exact = |overlap: u32| overlap_mean_difference(stitched, next, overlap, width);
    scan_overlap(min_overlap, max_overlap, expected, coarse, exact)
}

/// Prepending candidate search (bottom of `next` against the top of `stitched`).
pub(crate) fn find_overlap_prepend(
    stitched: &Stitched,
    next: &RgbaImage,
    expected: Option<u32>,
) -> Option<u32> {
    let width = stitched.width.min(next.width());
    let next_height = next.height();
    if width == 0 || next_height < 2 || stitched.height() < 2 {
        return None;
    }
    let min_overlap = ((next_height as f64 * LONGSHOT_MIN_OVERLAP_RATIO).ceil() as u32).max(1);
    let max_overlap = ((next_height as f64 * LONGSHOT_MAX_OVERLAP_RATIO).floor() as u32)
        .min(stitched.height())
        .min(next_height.saturating_sub(1));
    if max_overlap < min_overlap {
        return None;
    }
    let coarse = |overlap: u32| coarse_prepend_difference(stitched, next, overlap, width);
    let exact = |overlap: u32| prepend_mean_difference(stitched, next, overlap, width);
    scan_overlap(min_overlap, max_overlap, expected, coarse, exact)
}

/// Two-stage overlap scan shared by both directions.
///
/// 1. A sparse score is evaluated for **every** candidate in `[low, high]`, so
///    no grid can miss the true overlap.
/// 2. The best candidates are refined with the dense score.
/// 3. Among the nearly-equal best candidates the one closest to `expected` (the
///    previous frame's step) wins — this is what keeps repeated text lines from
///    stitching at the wrong offset while the user scrolls fast.
fn scan_overlap<C, E>(
    low: u32,
    high: u32,
    expected: Option<u32>,
    coarse_score: C,
    exact_score: E,
) -> Option<u32>
where
    C: Fn(u32) -> f64,
    E: Fn(u32) -> f64,
{
    if high < low {
        return None;
    }
    // The sparse score samples far fewer pixels; a real overlap still scores
    // near zero on clean content, so a loose bar keeps it in the shortlist.
    let coarse_limit = LONGSHOT_OVERLAP_MAX_MEAN_DIFF * 2.0;
    let mut shortlist: Vec<(f64, u32)> = Vec::new();
    for overlap in low..=high {
        let difference = coarse_score(overlap);
        if difference <= coarse_limit {
            shortlist.push((difference, overlap));
        }
    }
    if shortlist.is_empty() {
        return None;
    }
    shortlist.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    shortlist.truncate(24);
    let mut refined: Vec<(f64, u32)> = Vec::new();
    for (_, center) in shortlist {
        let refine_low = center.saturating_sub(1).max(low);
        let refine_high = center.saturating_add(1).min(high);
        for overlap in refine_low..=refine_high {
            let difference = exact_score(overlap);
            if difference <= LONGSHOT_OVERLAP_MAX_MEAN_DIFF {
                refined.push((difference, overlap));
            }
        }
    }
    if refined.is_empty() {
        return None;
    }
    refined.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let best_difference = refined[0].0;
    /* Ambiguous (self-similar) content: several offsets fit almost equally. */
    let mut candidates: Vec<(f64, u32)> = refined
        .into_iter()
        .filter(|(difference, _)| *difference <= best_difference + 0.75)
        .collect();
    if candidates.is_empty() {
        return None;
    }
    if let Some(expected) = expected.filter(|value| (low..=high).contains(value)) {
        if candidates.len() > 1 {
            candidates.sort_by(|left, right| {
                left.1
                    .abs_diff(expected)
                    .cmp(&right.1.abs_diff(expected))
                    .then_with(|| {
                        left.0
                            .partial_cmp(&right.0)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
            });
            return Some(candidates[0].1);
        }
    }
    candidates.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.1.cmp(&left.1))
    });
    Some(candidates[0].1)
}

/// Horizontal sample window used by the overlap scorers: skips ~4% on each side
/// so a scrollbar slider, window border or CSS shadow inside the selection does
/// not swamp the match score while the page scrolls.
fn overlap_sample_x(width: u32) -> (u32, u32) {
    let margin = (width / 25).max(1);
    let start = margin.min(width.saturating_sub(1));
    let end = width.saturating_sub(margin).max(start + 1).min(width);
    (start, end)
}

/// Sparse version of [`overlap_mean_difference`] used for the coarse pass.
fn coarse_overlap_difference(
    stitched: &Stitched,
    next: &RgbaImage,
    overlap: u32,
    width: u32,
) -> f64 {
    let (x_start, x_end) = overlap_sample_x(width);
    let step_x = ((x_end - x_start) / 16).max(1);
    let sample_rows = overlap.clamp(1, 16);
    let row_step = (overlap / sample_rows).max(1);
    let start_y = stitched.height() - overlap;
    let mut total_difference = 0u64;
    let mut samples = 0u64;
    let mut row = 0;
    while row < overlap {
        let stitched_y = start_y + row;
        let mut x = x_start;
        while x < x_end {
            let above = stitched_pixel(stitched, x, stitched_y);
            let below = next.get_pixel(x, row);
            for channel in 0..3 {
                total_difference +=
                    (above[channel] as i16 - below[channel] as i16).unsigned_abs() as u64;
            }
            samples += 3;
            x += step_x;
        }
        row += row_step;
    }
    if samples == 0 {
        return f64::MAX;
    }
    total_difference as f64 / samples as f64
}

/// Mean absolute RGB difference between the bottom `overlap` rows of `stitched`
/// and the top `overlap` rows of `next`. A dense sample (up to 96 rows × 96
/// columns) keeps text-like repeated content from matching wrongly, while the
/// mean (instead of a hard per-pixel count) tolerates the fractional-pixel
/// offsets produced by smooth scrolling.
fn overlap_mean_difference(stitched: &Stitched, next: &RgbaImage, overlap: u32, width: u32) -> f64 {
    let (x_start, x_end) = overlap_sample_x(width);
    let step_x = ((x_end - x_start) / 96).max(1);
    let sample_rows = overlap.clamp(1, 96);
    let row_step = (overlap / sample_rows).max(1);
    let start_y = stitched.height() - overlap;
    let mut total_difference = 0u64;
    let mut samples = 0u64;
    let mut row = 0;
    while row < overlap {
        let stitched_y = start_y + row;
        let mut x = x_start;
        while x < x_end {
            let above = stitched_pixel(stitched, x, stitched_y);
            let below = next.get_pixel(x, row);
            for channel in 0..3 {
                total_difference +=
                    (above[channel] as i16 - below[channel] as i16).unsigned_abs() as u64;
            }
            samples += 3;
            x += step_x;
        }
        row += row_step;
    }
    if samples == 0 {
        return f64::MAX;
    }
    total_difference as f64 / samples as f64
}

/// Sparse version of [`prepend_mean_difference`] used for the coarse pass.
fn coarse_prepend_difference(
    stitched: &Stitched,
    next: &RgbaImage,
    overlap: u32,
    width: u32,
) -> f64 {
    let (x_start, x_end) = overlap_sample_x(width);
    let step_x = ((x_end - x_start) / 16).max(1);
    let sample_rows = overlap.clamp(1, 16);
    let row_step = (overlap / sample_rows).max(1);
    let start_y = next.height().saturating_sub(overlap);
    let mut total_difference = 0u64;
    let mut samples = 0u64;
    let mut row = 0;
    while row < overlap {
        let stitched_y = row;
        let next_y = start_y + row;
        let mut x = x_start;
        while x < x_end {
            let above = stitched_pixel(stitched, x, stitched_y);
            let below = next.get_pixel(x, next_y);
            for channel in 0..3 {
                total_difference +=
                    (above[channel] as i16 - below[channel] as i16).unsigned_abs() as u64;
            }
            samples += 3;
            x += step_x;
        }
        row += row_step;
    }
    if samples == 0 {
        return f64::MAX;
    }
    total_difference as f64 / samples as f64
}

/// Mean absolute RGB difference between the top `overlap` rows of `stitched` and
/// the bottom `overlap` rows of `next` (prepend direction).
fn prepend_mean_difference(stitched: &Stitched, next: &RgbaImage, overlap: u32, width: u32) -> f64 {
    let (x_start, x_end) = overlap_sample_x(width);
    let step_x = ((x_end - x_start) / 96).max(1);
    let sample_rows = overlap.clamp(1, 96);
    let row_step = (overlap / sample_rows).max(1);
    let start_y = next.height().saturating_sub(overlap);
    let mut total_difference = 0u64;
    let mut samples = 0u64;
    let mut row = 0;
    while row < overlap {
        let stitched_y = row;
        let next_y = start_y + row;
        let mut x = x_start;
        while x < x_end {
            let above = stitched_pixel(stitched, x, stitched_y);
            let below = next.get_pixel(x, next_y);
            for channel in 0..3 {
                total_difference +=
                    (above[channel] as i16 - below[channel] as i16).unsigned_abs() as u64;
            }
            samples += 3;
            x += step_x;
        }
        row += row_step;
    }
    if samples == 0 {
        return f64::MAX;
    }
    total_difference as f64 / samples as f64
}

/// Sampled comparison of two equally sized frames: `true` when the application
/// did not scroll between them (stop `same-frame`).
pub(crate) fn frames_identical(first: &RgbaImage, second: &RgbaImage) -> bool {
    if first.dimensions() != second.dimensions() {
        return false;
    }
    let (width, height) = first.dimensions();
    if width == 0 || height == 0 {
        return true;
    }
    let step_x = (width / 32).max(1);
    let step_y = (height / 32).max(1);
    let mut total_difference = 0u64;
    let mut samples = 0u64;
    let mut y = 0;
    while y < height {
        let mut x = 0;
        while x < width {
            let first_pixel = first.get_pixel(x, y);
            let second_pixel = second.get_pixel(x, y);
            for channel in 0..3 {
                total_difference += (first_pixel[channel] as i16 - second_pixel[channel] as i16)
                    .unsigned_abs() as u64;
            }
            samples += 3;
            x += step_x;
        }
        y += step_y;
    }
    if samples == 0 {
        return true;
    }
    (total_difference as f64 / samples as f64) <= LONGSHOT_SAME_FRAME_THRESHOLD
}

/// Decides whether the loop stops after a frame: identical frame / no reliable
/// overlap dominate, then the height, pixel-budget and frame caps (contract
/// §11.6).
fn longshot_decision(
    width: u32,
    frame: u32,
    same_frame: bool,
    overlap: Option<u32>,
    projected_height: u32,
) -> LongshotDecision {
    if same_frame {
        return LongshotDecision::Stop(LongshotStop::SameFrame);
    }
    if !matches!(overlap, Some(rows) if rows > 0) {
        return LongshotDecision::Stop(LongshotStop::NoOverlap);
    }
    let exceeds_height = projected_height > LONGSHOT_MAX_HEIGHT
        || (width as u64).saturating_mul(projected_height as u64) > LONGSHOT_MAX_PIXELS;
    if exceeds_height {
        return LongshotDecision::Stop(LongshotStop::MaxHeight);
    }
    if frame >= LONGSHOT_MAX_FRAMES {
        return LongshotDecision::Stop(LongshotStop::MaxFrames);
    }
    LongshotDecision::Continue
}

/// Blocking worker of [`CaptureService::longshot`]: scrolls, grabs and stitches
/// frames. `xcap::Monitor` is not `Send`, which is why this runs entirely inside
/// one `spawn_blocking` call.
fn run_longshot(
    app: AppHandle,
    request: LongshotRequest,
    cursor_before: (i32, i32),
) -> Result<LongshotCapture, EngineError> {
    let LongshotRequest {
        index,
        origin_x,
        origin_y,
        monitor_width,
        monitor_height,
        crop,
        first_frame,
    } = request;
    let (left, top, width, height) = crop;
    let label = format!("{}{index}", crate::windows::CAPTURE_PREFIX);
    let center = (
        origin_x + (left + width / 2) as i32,
        origin_y + (top + height / 2) as i32,
    );
    let capture_rect = HitRect {
        x: left as f64,
        y: top as f64,
        width: width as f64,
        height: height as f64,
    };
    let monitors = xcap::Monitor::all().map_err(|error| {
        EngineError::new(
            "长截图失败。",
            format!("无法枚举显示器，请重试（{error}）。"),
        )
    })?;
    let monitor = monitors
        .iter()
        .find(|monitor| {
            monitor.x().unwrap_or(i32::MIN) == origin_x
                && monitor.y().unwrap_or(i32::MIN) == origin_y
                && monitor.width().unwrap_or(0) == monitor_width
                && monitor.height().unwrap_or(0) == monitor_height
        })
        .or_else(|| monitors.first())
        .ok_or_else(|| EngineError::new("长截图失败。", "未检测到显示器。"))?;

    let mut stitched = Stitched::from_image(&first_frame);
    let mut previous = first_frame;
    let mut frames = 1u32;
    // Previous accepted scroll overlap; consecutive frames scroll by the same
    // amount, so it narrows (and disambiguates) the overlap search.
    let mut expected_overlap: Option<u32> = None;
    let stop;

    // Put the cursor back where the user left it, even when a capture fails.
    struct CursorRestore {
        position: (i32, i32),
    }
    impl Drop for CursorRestore {
        fn drop(&mut self) {
            crate::win32::set_cursor_position(self.position.0, self.position.1);
        }
    }
    let _cursor_restore = CursorRestore {
        position: cursor_before,
    };

    // Wheel input is delivered to the focused window unless "scroll inactive
    // windows when hovering" is enabled. Focus the application below the
    // (hidden) overlay once, before the first scroll, so the scroll always lands
    // there instead of on a stale foreground window.
    crate::win32::set_cursor_position(center.0, center.1);
    std::thread::sleep(LONGSHOT_SCROLL_SETTLE);
    crate::win32::focus_window_at(center.0, center.1);

    loop {
        if frames >= LONGSHOT_MAX_FRAMES {
            stop = LongshotStop::MaxFrames;
            break;
        }
        crate::win32::set_cursor_position(center.0, center.1);
        std::thread::sleep(LONGSHOT_SCROLL_SETTLE);
        if !crate::win32::scroll_wheel_notches(LONGSHOT_SCROLL_NOTCHES) {
            if let Some(log) = log_of(&app) {
                log.warn("longshot: SendInput wheel event was rejected");
            }
        }
        std::thread::sleep(LONGSHOT_FRAME_DELAY);
        let captured = monitor.capture_image().map_err(|error| {
            EngineError::new("长截图失败。", format!("抓取屏幕失败，请重试（{error}）。"))
        })?;
        let Some((cl, ct, cw, ch)) = clamp_rect(&captured, &capture_rect) else {
            return Err(EngineError::new("长截图失败。", "选区在滚动后变得无效。"));
        };
        let mut next = image::imageops::crop_imm(&captured, cl, ct, cw, ch).to_image();
        frames += 1;
        let mut same = frames_identical(&previous, &next);
        // Smooth-scrolling applications may still be animating after the frame
        // delay: retake once before deciding that nothing scrolled.
        if same && frames < LONGSHOT_MAX_FRAMES {
            std::thread::sleep(LONGSHOT_SAME_FRAME_RETRY_DELAY);
            if let Ok(retaken) = monitor.capture_image() {
                if let Some((rl, rt, rw, rh)) = clamp_rect(&retaken, &capture_rect) {
                    let retaken = image::imageops::crop_imm(&retaken, rl, rt, rw, rh).to_image();
                    if !frames_identical(&previous, &retaken) {
                        next = retaken;
                        same = false;
                    }
                }
            }
        }
        let mut overlap = if same {
            None
        } else {
            find_overlap(&stitched, &next, expected_overlap)
        };
        // A mid-animation frame can scroll by a non-integral amount and miss the
        // overlap search; wait for the animation to settle and look again.
        if !same && overlap.is_none() {
            std::thread::sleep(LONGSHOT_SAME_FRAME_RETRY_DELAY);
            if let Ok(settled) = monitor.capture_image() {
                if let Some((rl, rt, rw, rh)) = clamp_rect(&settled, &capture_rect) {
                    let settled = image::imageops::crop_imm(&settled, rl, rt, rw, rh).to_image();
                    if !frames_identical(&previous, &settled) {
                        next = settled;
                        overlap = find_overlap(&stitched, &next, expected_overlap);
                    }
                }
            }
        }
        if let Some(log) = log_of(&app) {
            log.info(&format!(
                "longshot frame={frames} same={same} overlap={overlap:?} height={} expected={expected_overlap:?}",
                stitched.height()
            ));
        }
        if overlap.is_none() && std::env::var_os("LEXORA_LONGSHOT_DEBUG").is_some() {
            let dir = std::env::temp_dir().join("lexora-longshot-debug");
            let _ = std::fs::create_dir_all(&dir);
            let _ = previous.save(dir.join(format!("frame-{frames}-prev.png")));
            let _ = next.save(dir.join(format!("frame-{frames}-next.png")));
        }
        let added_rows = overlap
            .map(|rows| next.height().saturating_sub(rows))
            .unwrap_or(0);
        let projected_height = stitched.height().saturating_add(added_rows);
        match longshot_decision(stitched.width, frames, same, overlap, projected_height) {
            LongshotDecision::Stop(reason) => {
                stop = reason;
                break;
            }
            LongshotDecision::Continue => {
                stitched.push_rows(&next, overlap.unwrap_or(0));
                previous = next;
                expected_overlap = overlap;
                let _ = app.emit_to(
                    label.as_str(),
                    EVENT_LONGSHOT_PROGRESS,
                    json!({ "frame": frames, "height": stitched.height() }),
                );
            }
        }
    }

    Ok(LongshotCapture {
        image: stitched.into_image(),
        frames,
        stop,
    })
}

/// Resets [`CaptureService::longshot_running`] on drop, including on panic.
struct LongshotGuard<'a>(&'a AtomicBool);

impl Drop for LongshotGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Resets [`CaptureService::starting`] on drop, including on panic.
struct StartGuard<'a>(&'a AtomicBool);

impl Drop for StartGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Releases the capture input gate when the preparation did not produce an
/// overlay (`armed == false`), including on panic, so the picker/settings can be
/// dismissed again and a fallback-hidden settings window is restored.
struct CaptureFlowGuard<'a> {
    service: &'a CaptureService,
    app: &'a AppHandle,
    armed: bool,
}

impl Drop for CaptureFlowGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            self.service.finish_capture(self.app);
        }
    }
}

/// Entry point used by the commands and by the hotkey worker.
pub async fn start_capture(
    app: &AppHandle,
    state: &AppState,
    preset_skill_id: Option<String>,
) -> Result<usize, EngineError> {
    state.capture.start(app, state, preset_skill_id).await
}

// ---------------------------------------------------------------------------
// Streaming into the picker result panel
// ---------------------------------------------------------------------------

/// Starts the background stream of a screenshot skill (contract §10.3 step 7).
/// Only one stream may run at a time; it is registered on `translate_task` so
/// `picker_abort_translate` and picker close can abort it.
pub fn spawn_capture_job(app: AppHandle, state: Arc<AppState>, job: CaptureJob) {
    state.abort_translate();
    let task_app = app.clone();
    let task_state = state.clone();
    let request_id = job.request_id.clone();
    let task_request_id = request_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        if let Err(error) = run_capture_job(task_app.clone(), task_state, job).await {
            emit_error(&task_app, &task_request_id, &error);
        }
    });
    *lock(&state.translate_task) = Some(TranslateTask { request_id, handle });
}

/// Starts a follow-up question stream for the last screenshot.
pub fn spawn_followup_job(app: AppHandle, state: Arc<AppState>, job: FollowupJob) {
    state.abort_translate();
    let task_app = app.clone();
    let task_state = state.clone();
    let request_id = job.request_id.clone();
    let task_request_id = request_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        if let Err(error) = run_followup_job(task_app.clone(), task_state, job).await {
            emit_error(&task_app, &task_request_id, &error);
        }
    });
    *lock(&state.translate_task) = Some(TranslateTask { request_id, handle });
}

/// Streamed model response (text and vision providers share the same shape).
type TextStream = futures_util::stream::BoxStream<'static, Result<String, EngineError>>;

async fn run_capture_job(
    app: AppHandle,
    state: Arc<AppState>,
    job: CaptureJob,
) -> Result<(), EngineError> {
    let request_id = job.request_id.clone();
    match job.action {
        // Transcription is streamed chunk by chunk (contract §10.3): the vision
        // model is preferred, Windows OCR is the fallback when no text can be
        // produced by it (unavailable, failure before the first chunk, or an
        // empty transcription).
        SkillAction::Ocr => {
            let engine = engine_of(&app)?;
            let mut streamed = false;
            let (text, source) = if engine.can_use_vision() {
                match stream_vision_transcription(&app, &request_id, &engine, &job.data_url).await?
                {
                    Some(text) => {
                        streamed = true;
                        (text, "vision")
                    }
                    None => (recognize_text(&job.image).await?, "windows-ocr"),
                }
            } else {
                (recognize_text(&job.image).await?, "windows-ocr")
            };
            state.capture.cache_ocr_text(&job.data_url, &text);
            log_ocr_source(&app, source, &text);
            // The vision path already emitted its chunks; the Windows OCR
            // fallback is emitted as one full chunk.
            if !streamed {
                emit_chunk(&app, &request_id, &text);
            }
            emit_done(&app, &request_id);
            Ok(())
        }
        // Transcription (cached when available) → text translation stream. The
        // resolved target language is reported before the stream starts so the
        // picker shows the real target instead of the `auto` placeholder.
        SkillAction::Translate => {
            let (text, source) = match job.ocr_text.clone() {
                Some(cached) => (cached, "cache"),
                None => transcribe_screenshot(&app, &state, &job.image, &job.data_url).await?,
            };
            log_ocr_source(&app, source, &text);
            let target = crate::engine::resolve_target_lang(&job.target_lang, &text);
            emit_target_lang(&app, &request_id, &target);
            if let Some(log) = log_of(&app) {
                log.info(&format!(
                    "screenshot translate: target={target} chars={}",
                    text.chars().count()
                ));
            }
            let engine = engine_of(&app)?;
            let mut stream = engine
                .translate_stream_with_prompt(
                    &text,
                    &target,
                    &job.system_prompt,
                    &job.word_lookup_prompt,
                )
                .await?;
            stream_chunks(&app, &request_id, &mut stream).await?;
            emit_done(&app, &request_id);
            Ok(())
        }
        // Image → vision model with the rendered instruction.
        SkillAction::Explain | SkillAction::Custom => {
            let engine = engine_of(&app)?;
            let mut stream = engine
                .vision_stream(&job.data_url, &job.system_prompt)
                .await?;
            stream_chunks(&app, &request_id, &mut stream).await?;
            emit_done(&app, &request_id);
            Ok(())
        }
    }
}

async fn run_followup_job(
    app: AppHandle,
    state: Arc<AppState>,
    job: FollowupJob,
) -> Result<(), EngineError> {
    let request_id = job.request_id.clone();
    let engine = engine_of(&app)?;
    let mut stream = if job.action.is_vision() {
        engine
            .vision_followup_stream(
                &job.data_url,
                &job.previous_answer,
                &job.question,
                &job.history,
            )
            .await?
    } else {
        let text = match job.ocr_text.clone() {
            Some(cached) => cached,
            None => {
                let (text, source) =
                    transcribe_screenshot(&app, &state, &job.image, &job.data_url).await?;
                log_ocr_source(&app, source, &text);
                text
            }
        };
        engine
            .followup_stream(&text, &job.previous_answer, &job.question, &job.history)
            .await?
    };
    stream_chunks(&app, &request_id, &mut stream).await?;
    emit_done(&app, &request_id);
    Ok(())
}

/// Recognizes the text of a screenshot. The vision model is preferred (contract
/// §10.8, either the configured online vision endpoint or local Qwen2.5-VL);
/// Windows OCR is used when vision is not available **or when the vision request
/// fails** (e.g. a text-only online model, a 4xx, or no text returned), so the
/// extraction skill keeps working. A successful transcription is cached on
/// [`LastCapture`] for retry / follow-up. Returns the text plus the path that
/// produced it (`"vision"` / `"windows-ocr"`).
async fn transcribe_screenshot(
    app: &AppHandle,
    state: &Arc<AppState>,
    image: &RgbaImage,
    data_url: &str,
) -> Result<(String, &'static str), EngineError> {
    let engine = engine_of(app)?;
    let mut vision_error: Option<EngineError> = None;
    if engine.can_use_vision() {
        let attempt = match engine
            .vision_stream(data_url, crate::engine::DEFAULT_OCR_PROMPT)
            .await
        {
            Ok(mut stream) => collect_stream(&mut stream)
                .await
                .map(|text| text.trim().to_string()),
            Err(error) => Err(error),
        };
        match attempt {
            Ok(text) if !text.is_empty() => {
                state.capture.cache_ocr_text(data_url, &text);
                return Ok((text, "vision"));
            }
            Ok(_) => vision_error = Some(no_text_error()),
            Err(error) => vision_error = Some(error),
        }
        if let Some(log) = log_of(app) {
            let error = vision_error.as_ref().expect("vision error was just set");
            log.warn(&format!(
                "screenshot vision OCR failed, falling back to Windows OCR: {} / {}",
                error.message, error.hint
            ));
        }
    }
    match recognize_text(image).await {
        Ok(text) => {
            state.capture.cache_ocr_text(data_url, &text);
            Ok((text, "windows-ocr"))
        }
        Err(ocr_error) => {
            // Both paths failed: report the vision error (usually the more
            // actionable one, e.g. "configure a vision model") plus the OCR
            // hint when there is one.
            match vision_error {
                Some(vision_error) => Err(EngineError::new(
                    vision_error.message,
                    format!(
                        "{} 系统 OCR 回退同样失败：{}",
                        vision_error.hint, ocr_error.message
                    ),
                )),
                None => Err(ocr_error),
            }
        }
    }
}

/// Streams the vision-model transcription of a screenshot and returns the
/// accumulated text (contract §10.3 `ocr`): every chunk is emitted to the result
/// panel as it arrives, so the text panel fills in progressively.
///
/// Returns `Ok(None)` when the model produced nothing usable — the request
/// failed before the first chunk or the transcription came back empty — and the
/// caller then falls back to Windows OCR. A failure **after** at least one chunk
/// is returned as `Err` so the already visible partial text is kept and the
/// panel shows the error instead of silently replacing it.
async fn stream_vision_transcription(
    app: &AppHandle,
    request_id: &str,
    engine: &EngineService,
    data_url: &str,
) -> Result<Option<String>, EngineError> {
    let mut stream = match engine
        .vision_stream(data_url, crate::engine::DEFAULT_OCR_PROMPT)
        .await
    {
        Ok(stream) => stream,
        Err(error) => {
            if let Some(log) = log_of(app) {
                log.warn(&format!(
                    "screenshot vision OCR failed before any output, falling back to Windows OCR: \
                     {} / {}",
                    error.message, error.hint
                ));
            }
            return Ok(None);
        }
    };
    let mut raw = String::new();
    let mut emitted = false;
    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => {
                if chunk.is_empty() {
                    continue;
                }
                raw.push_str(&chunk);
                emit_chunk(app, request_id, &chunk);
                emitted = true;
            }
            Err(error) => {
                if emitted {
                    // Keep the partial transcription visible; the stream ended
                    // with an error, which the panel shows on top of it.
                    return Err(error);
                }
                if let Some(log) = log_of(app) {
                    log.warn(&format!(
                        "screenshot vision OCR failed before any output, falling back to Windows \
                         OCR: {} / {}",
                        error.message, error.hint
                    ));
                }
                return Ok(None);
            }
        }
    }
    if raw.trim().is_empty() {
        if let Some(log) = log_of(app) {
            log.warn("screenshot vision OCR returned no text, falling back to Windows OCR");
        }
        return Ok(None);
    }
    Ok(Some(raw))
}

/// Collects a streamed model response into one string. Translation/follow-up
/// need the complete text before the next step, unlike OCR which is streamed
/// straight into the panel (contract §10.3).
async fn collect_stream(stream: &mut TextStream) -> Result<String, EngineError> {
    let mut text = String::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => text.push_str(&chunk),
            Err(error) => return Err(error),
        }
    }
    Ok(text)
}

/// Logs which path produced the screenshot text (`vision` / `windows-ocr` /
/// `cache`) so the contract-required source is visible in the log (§10.8).
fn log_ocr_source(app: &AppHandle, source: &str, text: &str) {
    if let Some(log) = log_of(app) {
        log.info(&format!(
            "screenshot ocr source={source} chars={}",
            text.chars().count()
        ));
    }
}

async fn stream_chunks(
    app: &AppHandle,
    request_id: &str,
    stream: &mut TextStream,
) -> Result<(), EngineError> {
    while let Some(item) = stream.next().await {
        match item {
            Ok(chunk) => {
                if chunk.is_empty() {
                    continue;
                }
                emit_chunk(app, request_id, &chunk);
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn emit_translate_event(app: &AppHandle, payload: Value) {
    let _ = app.emit_to(crate::windows::PICKER_LABEL, EVENT_TRANSLATE, payload);
}

fn emit_chunk(app: &AppHandle, request_id: &str, text: &str) {
    emit_translate_event(
        app,
        json!({ "requestId": request_id, "type": "chunk", "text": text }),
    );
}

/// Reports the target language the shell resolved for a screenshot translation
/// (`auto` is resolved from the recognized text), so the picker can display the
/// real target instead of the placeholder (contract §10.5).
fn emit_target_lang(app: &AppHandle, request_id: &str, target_lang: &str) {
    emit_translate_event(app, target_event_payload(request_id, target_lang));
}

/// Payload of the `translate-event {type:"target"}` event (contract §10.5).
fn target_event_payload(request_id: &str, target_lang: &str) -> Value {
    json!({
        "requestId": request_id,
        "type": "target",
        "targetLang": target_lang,
    })
}

fn emit_done(app: &AppHandle, request_id: &str) {
    emit_translate_event(app, json!({ "requestId": request_id, "type": "done" }));
}

fn emit_error(app: &AppHandle, request_id: &str, error: &EngineError) {
    emit_translate_event(
        app,
        json!({
            "requestId": request_id,
            "type": "error",
            "message": error.message,
            "hint": error.hint,
        }),
    );
}

// ---------------------------------------------------------------------------
// Skill metadata / image helpers
// ---------------------------------------------------------------------------

/// Resolves the label, custom skill id and vision system prompt for an action.
/// Custom skills must exist, be `kind=image` and be enabled (contract §10.3).
/// Parses the renderer action string into a known skill action.
fn parse_skill_action(action: &str) -> Result<SkillAction, EngineError> {
    SkillAction::parse(action).ok_or_else(|| {
        EngineError::new(
            "不支持的截图操作。",
            "支持提取文字（ocr）、翻译（translate）、解释图片（explain）或图片技能（custom）。",
        )
    })
}

fn resolve_skill_meta(
    settings: &Settings,
    action: SkillAction,
    skill_id: Option<&str>,
    target_lang: &str,
) -> Result<SkillMeta, EngineError> {
    match action {
        SkillAction::Ocr => Ok(SkillMeta {
            label: "提取文字".to_string(),
            skill_id: String::new(),
            system_prompt: String::new(),
            word_lookup_prompt: String::new(),
        }),
        SkillAction::Translate => Ok(SkillMeta {
            label: "翻译".to_string(),
            skill_id: String::new(),
            // Screenshot-specific translate prompt (`picker.capturePrompts`).
            system_prompt: settings.picker.capture_prompts.translate.clone(),
            word_lookup_prompt: settings.picker.capture_prompts.word_lookup.clone(),
        }),
        SkillAction::Explain => {
            let custom = settings.picker.capture_prompts.explain.trim();
            let answer_language = crate::engine::language_name(settings.effective_language());
            Ok(SkillMeta {
                label: "解释图片".to_string(),
                skill_id: String::new(),
                system_prompt: if custom.is_empty() {
                    crate::engine::render_answer_language(
                        crate::engine::DEFAULT_EXPLAIN_IMAGE_PROMPT,
                        &answer_language,
                    )
                } else {
                    crate::engine::answer_language_prompt(custom, &answer_language)
                },
                word_lookup_prompt: String::new(),
            })
        }
        SkillAction::Custom => {
            let Some(skill_id) = skill_id.map(str::trim).filter(|id| !id.is_empty()) else {
                return Err(EngineError::new(
                    "缺少图片技能标识。",
                    "请选择要使用的图片技能后重试。",
                ));
            };
            let Some(skill) = image_skill(settings, skill_id) else {
                return Err(EngineError::new(
                    "技能不存在（可能已被删除）",
                    "请在设置 → 图片技能中重新添加该技能。",
                ));
            };
            if !settings
                .picker
                .capture_skills
                .iter()
                .any(|id| id == &skill.id)
            {
                return Err(EngineError::new(
                    "技能未启用",
                    "请在设置 → 图片技能中启用该技能。",
                ));
            }
            let target = crate::engine::resolve_target_lang(target_lang, "");
            Ok(SkillMeta {
                label: skill.label.clone(),
                skill_id: skill.id.clone(),
                system_prompt: crate::engine::render_image_prompt(&skill.prompt, &target),
                word_lookup_prompt: String::new(),
            })
        }
    }
}

/// Finds a custom skill that acts on images.
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

/// Writes an RGBA bitmap to the system image clipboard; returns whether it
/// worked (the screenshot flow continues either way, contract §10.3).
pub(crate) fn write_clipboard_image(app: &AppHandle, image: &RgbaImage) -> bool {
    let (width, height) = image.dimensions();
    let clipboard_image = tauri::image::Image::new_owned(image.clone().into_raw(), width, height);
    match app.clipboard().write_image(&clipboard_image) {
        Ok(()) => true,
        Err(error) => {
            if let Some(log) = log_of(app) {
                log.warn(&format!("screenshot clipboard write failed: {error}"));
            }
            false
        }
    }
}

/// Runs the OS OCR engine on an RGBA bitmap (blocking work on a worker thread).
/// Only used as the fallback when no vision model is available (contract §10.8).
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
            "请重新框选含文字的区域；缺语言包可在 Windows 设置中安装 OCR 组件。",
        ));
    }
    Ok(text)
}

/// Error returned when the vision model transcribed an image without any text.
fn no_text_error() -> EngineError {
    EngineError::new("没有识别到文字。", "请重新框选包含文字的区域后再试一次。")
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
pub(crate) fn clamp_rect(image: &RgbaImage, rect: &HitRect) -> Option<(u32, u32, u32, u32)> {
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

/// Bounding box of every captured monitor, in virtual-screen physical pixels.
fn layout_bounds(monitors: &[MonitorSnapshot]) -> Option<GlobalRect> {
    let mut iter = monitors.iter();
    let first = iter.next()?;
    let mut left = i64::from(first.x);
    let mut top = i64::from(first.y);
    let mut right = left + i64::from(first.width);
    let mut bottom = top + i64::from(first.height);
    for monitor in iter {
        let monitor_left = i64::from(monitor.x);
        let monitor_top = i64::from(monitor.y);
        left = left.min(monitor_left);
        top = top.min(monitor_top);
        right = right.max(monitor_left + i64::from(monitor.width));
        bottom = bottom.max(monitor_top + i64::from(monitor.height));
    }
    Some(GlobalRect {
        x: i32::try_from(left).unwrap_or(i32::MIN),
        y: i32::try_from(top).unwrap_or(i32::MIN),
        width: u32::try_from((right - left).max(0)).unwrap_or(u32::MAX),
        height: u32::try_from((bottom - top).max(0)).unwrap_or(u32::MAX),
    })
}

/// Physical screen point used to anchor the picker after a cross-monitor
/// selection: the last pixel of the selection (bottom-right corner, inclusive).
fn global_anchor(rect: &GlobalRect) -> (i32, i32) {
    let last_x = i64::from(rect.x) + i64::from(rect.width) - 1;
    let last_y = i64::from(rect.y) + i64::from(rect.height) - 1;
    let clamp = |value: i64| value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
    (clamp(last_x), clamp(last_y))
}

/// Stitches a renderer-provided virtual-screen rect out of the captured monitor
/// images. Pixels not covered by any monitor stay black, so the result looks
/// like the frozen screenshot (contract §10.3).
fn stitch_global(shots: &[Shot], rect: &GlobalRect) -> Result<RgbaImage, EngineError> {
    let pixels = u64::from(rect.width) * u64::from(rect.height);
    if pixels == 0 {
        return Err(invalid_global_rect_error());
    }
    if pixels > MAX_GLOBAL_CROP_PIXELS {
        return Err(global_rect_too_large_error());
    }
    let selection = (
        i64::from(rect.x),
        i64::from(rect.y),
        rect.width,
        rect.height,
    );
    let mut output = RgbaImage::from_pixel(rect.width, rect.height, image::Rgba([0, 0, 0, 255]));
    for shot in shots {
        // The grabbed bitmap owns the pixel area; the image size is authoritative
        // for the source crop (the monitor geometry only provides the origin).
        let monitor = (
            i64::from(shot.x),
            i64::from(shot.y),
            shot.image.width(),
            shot.image.height(),
        );
        let Some((left, top, width, height)) = intersect_rects(selection, monitor) else {
            continue;
        };
        let source = image::imageops::crop_imm(
            &shot.image,
            (left - i64::from(shot.x)) as u32,
            (top - i64::from(shot.y)) as u32,
            width,
            height,
        )
        .to_image();
        image::imageops::replace(
            &mut output,
            &source,
            left - i64::from(rect.x),
            top - i64::from(rect.y),
        );
    }
    Ok(output)
}

/// Intersection of two physical-pixel rectangles in virtual-screen coordinates,
/// `None` when they do not overlap. Coordinates are `i64` so renderer-provided
/// extremes cannot overflow.
fn intersect_rects(
    a: (i64, i64, u32, u32),
    b: (i64, i64, u32, u32),
) -> Option<(i64, i64, u32, u32)> {
    let left = a.0.max(b.0);
    let top = a.1.max(b.1);
    let right = (a.0 + i64::from(a.2)).min(b.0 + i64::from(b.2));
    let bottom = (a.1 + i64::from(a.3)).min(b.1 + i64::from(b.3));
    if right <= left || bottom <= top {
        return None;
    }
    Some((
        left,
        top,
        u32::try_from(right - left).ok()?,
        u32::try_from(bottom - top).ok()?,
    ))
}

/// Physical screen position of the bottom-right corner of a clamped selection.
/// Kept one pixel inside the captured monitor: a selection ending exactly on a
/// monitor edge must not resolve to the neighbouring monitor's work area.
fn anchor_bottom_right(
    origin_x: i32,
    origin_y: i32,
    image_width: u32,
    image_height: u32,
    left: u32,
    top: u32,
    width: u32,
    height: u32,
) -> (i32, i32) {
    let max_x = image_width.saturating_sub(1);
    let max_y = image_height.saturating_sub(1);
    (
        origin_x + (left + width).min(max_x) as i32,
        origin_y + (top + height).min(max_y) as i32,
    )
}

/// Encodes the image as PNG bytes.
fn png_bytes(image: &RgbaImage) -> Result<Vec<u8>, EngineError> {
    let mut cursor = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.clone())
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|error| {
            EngineError::new("编码截图失败。", format!("请重试或更换区域（{error}）。"))
        })?;
    Ok(cursor.into_inner())
}

/// `data:image/png;base64,...` URL of a cropped region, sent to the vision
/// model and to the pinned-window renderer (lossless, contract §10.1/§10.6).
pub(crate) fn png_data_url(image: &RgbaImage) -> Result<String, EngineError> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(png_bytes(image)?);
    Ok(format!("data:image/png;base64,{encoded}"))
}

/// `data:image/jpeg;base64,...` URL for the long-screenshot preview: JPEG
/// encoding is several times cheaper than PNG for a window-sized image and keeps
/// the per-frame IPC payload small (the preview refreshes ~10x/s).
pub(crate) fn preview_jpeg_data_url(image: &RgbaImage, quality: u8) -> Result<String, EngineError> {
    use std::io::Cursor;
    let mut cursor = Cursor::new(Vec::new());
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality.clamp(1, 100));
    encoder.encode_image(image).map_err(|error| {
        EngineError::new(
            "编码长截图预览失败。",
            format!("请重试；若问题持续请重启程序（{error}）。"),
        )
    })?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(cursor.into_inner());
    Ok(format!("data:image/jpeg;base64,{encoded}"))
}

/// Error for a renderer-provided annotation layer that cannot be decoded.
fn annotation_error() -> EngineError {
    EngineError::new(
        "标注图层无效。",
        "请撤销标注后重试，或直接复制未标注的截图。",
    )
}

/// Decodes a `data:image/png;base64,...` annotation layer into RGBA pixels.
fn decode_annotations(annotations: &str) -> Result<RgbaImage, EngineError> {
    let (_, encoded) = annotations
        .split_once(";base64,")
        .ok_or_else(annotation_error)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| annotation_error())?;
    image::load_from_memory(&bytes)
        .map(|decoded| decoded.into_rgba8())
        .map_err(|_| annotation_error())
}

/// Alpha-composites the (transparent) annotation layer returned by
/// `CaptureAnnotate.renderToPng` over `image`; a layer of a different size is
/// scaled to the crop first (contract §11.4). Empty/absent annotations are a
/// no-op.
/// Public wrapper of the annotation compositor for the pin editor
/// (`pin_export_annotations`): composites a renderer PNG layer into the image.
pub fn compose_annotations(
    image: &mut RgbaImage,
    annotations: Option<String>,
) -> Result<(), EngineError> {
    composite_annotations(image, annotations)
}

fn composite_annotations(
    image: &mut RgbaImage,
    annotations: Option<String>,
) -> Result<(), EngineError> {
    let Some(annotations) = trimmed(annotations) else {
        return Ok(());
    };
    let layer = decode_annotations(&annotations)?;
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Ok(());
    }
    let layer = if layer.dimensions() == (width, height) {
        layer
    } else {
        image::imageops::resize(&layer, width, height, image::imageops::FilterType::Triangle)
    };
    for (x, y, source) in layer.enumerate_pixels() {
        let alpha = source[3] as u32;
        if alpha == 0 {
            continue;
        }
        let destination = image.get_pixel_mut(x, y);
        if alpha == 255 {
            *destination = *source;
            continue;
        }
        let inverse = 255 - alpha;
        for channel in 0..3 {
            destination[channel] = ((source[channel] as u32 * alpha
                + destination[channel] as u32 * inverse)
                / 255) as u8;
        }
        // The screenshot crop is opaque; keep the composited result opaque.
        destination[3] = 255;
    }
    Ok(())
}

/// Encodes a captured monitor as a JPEG data URL painted by the overlay `<img>`
/// (contract §10.1). JPEG is several times cheaper than PNG for encoding, IPC
/// and webview decoding; the original RGBA pixels are kept separately for
/// cropping and vision requests, so nothing lossy reaches the model.
fn jpeg_data_url(image: &RgbaImage) -> Result<String, EngineError> {
    let mut cursor = Cursor::new(Vec::new());
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, DISPLAY_JPEG_QUALITY);
    encoder.encode_image(image).map_err(|error| {
        EngineError::new(
            "编码截图失败。",
            format!("请重试；若问题持续请重启程序（{error}）。"),
        )
    })?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(cursor.into_inner());
    Ok(format!("data:image/jpeg;base64,{encoded}"))
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Monitor indices whose overlay renderer has not reported `capture_ready` for
/// `shots` yet. The 2.5 s fallback shows exactly these overlays: a renderer that
/// did paint is never re-shown/refocused, and a missing signal on one monitor is
/// not masked by the first monitor that reported ready (contract §10.1).
fn missing_ready_monitors(shots: &[Shot], ready: &HashSet<u32>) -> Vec<u32> {
    shots
        .iter()
        .map(|shot| shot.index)
        .filter(|index| !ready.contains(index))
        .collect()
}

fn not_ready_error() -> EngineError {
    EngineError::new(
        "截图尚未准备好。",
        "请稍候片刻再试，或重新发起截图（快捷键）。",
    )
}

/// Error for a renderer-provided global rect that covers no pixel.
fn invalid_global_rect_error() -> EngineError {
    EngineError::new("选区无效。", "请重新框选一个有效的区域后再试。")
}

/// Error for a renderer-provided global rect that would exhaust memory.
fn global_rect_too_large_error() -> EngineError {
    EngineError::new("选区过大。", "请缩小选区后再试。")
}

/// Error returned when a screenshot is triggered while another one is still
/// active (contract §11.11.2). Kept as a function so the exact wording is
/// unit-testable.
fn capture_already_active_error() -> EngineError {
    EngineError::new(
        "已经在截图了。",
        "请先完成当前截图（或按 Esc 取消）后再试。",
    )
}

fn missing_monitor_error(index: u32) -> EngineError {
    EngineError::new(
        format!("找不到第 {} 块屏幕。", index + 1),
        "请重新发起截图后重试。",
    )
}

fn settings_of(app: &AppHandle) -> Result<Settings, EngineError> {
    app.try_state::<Arc<AppState>>()
        .map(|state| state.settings.get())
        .ok_or_else(not_ready_error)
}

fn engine_of(app: &AppHandle) -> Result<Arc<EngineService>, EngineError> {
    app.try_state::<Arc<AppState>>()
        .map(|state| state.engine.clone())
        .ok_or_else(not_ready_error)
}

fn log_of(app: &AppHandle) -> Option<Logger> {
    app.try_state::<Arc<AppState>>()
        .map(|state| state.log.clone())
}

/// Shared application state (used by the capture-active input gate).
fn app_state(app: &AppHandle) -> Option<tauri::State<'_, Arc<AppState>>> {
    app.try_state::<Arc<AppState>>()
}

fn normalize_request_id(request_id: Option<String>) -> String {
    trimmed(request_id).unwrap_or_else(next_request_id)
}

fn next_request_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let sequence = REQUEST_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("capture-{millis}-{sequence}")
}

// ---------------------------------------------------------------------------
// Screenshot hotkey (contract §10.4)
// ---------------------------------------------------------------------------

/// Result of `capture_set_hotkey`, mapped to the contract's JSON by the command.
pub enum SetHotkeyOutcome {
    Applied {
        shortcut: String,
        /// Set when the shortcut works but persisting it failed.
        warning: Option<String>,
    },
    Failed {
        /// Shortcut still in effect (the previous one).
        shortcut: String,
        error: String,
        hint: String,
    },
}

/// A re-registration request handed to the hotkey thread. The reply channel
/// returns the registration result (`Err` carries message + hint).
struct HotkeyRequest {
    shortcut: Shortcut,
    reply: mpsc::Sender<Result<(), EngineError>>,
}

/// Outcome of planning a shortcut update from settings + renderer input.
#[derive(Debug, PartialEq, Eq)]
enum HotkeyUpdate {
    Unchanged(Shortcut),
    Change {
        previous: Option<Shortcut>,
        requested: Shortcut,
    },
}

/// Plans a hotkey update: identical shortcut → no-op; anything else → change.
/// Invalid renderer input normalizes to the default shortcut (contract §10.4).
fn plan_hotkey_update(current: &str, requested: &str) -> HotkeyUpdate {
    let normalized = normalize_shortcut(requested);
    let requested = parse_shortcut(&normalized).unwrap_or_else(default_shortcut);
    match parse_shortcut(current) {
        Some(current) if current == requested => HotkeyUpdate::Unchanged(current),
        _ => HotkeyUpdate::Change {
            previous: parse_shortcut(current),
            requested,
        },
    }
}

fn default_shortcut() -> Shortcut {
    parse_shortcut(DEFAULT_REGION_SHORTCUT).expect("the default shortcut must parse")
}

/// Native `(modifier flags, virtual key)` pair for `RegisterHotKey`. Includes
/// `MOD_NOREPEAT` so holding the keys down fires the screenshot exactly once.
fn native_hotkey(shortcut: Shortcut) -> (u32, u32) {
    let mut modifiers = MOD_NOREPEAT_RAW;
    if shortcut.modifiers.alt {
        modifiers |= MOD_ALT_RAW;
    }
    if shortcut.modifiers.ctrl {
        modifiers |= MOD_CONTROL_RAW;
    }
    if shortcut.modifiers.shift {
        modifiers |= MOD_SHIFT_RAW;
    }
    if shortcut.modifiers.win {
        modifiers |= MOD_WIN_RAW;
    }
    (modifiers, virtual_key(shortcut.key))
}

fn virtual_key(key: ShortcutKey) -> u32 {
    match key {
        ShortcutKey::Letter(letter) => letter as u32,
        ShortcutKey::Digit(digit) => u32::from(b'0') + u32::from(digit),
        // VK_F1 (0x70) … VK_F24 (0x87).
        ShortcutKey::Function(number) => 0x70 + u32::from(number) - 1,
        // VK_SNAPSHOT
        ShortcutKey::Named("PrintScreen") => 0x2C,
        // VK_SPACE
        ShortcutKey::Named("Space") => 0x20,
        // VK_TAB
        ShortcutKey::Named("Tab") => 0x09,
        // VK_RETURN
        ShortcutKey::Named("Enter") => 0x0D,
        // VK_ESCAPE
        ShortcutKey::Named("Esc") => 0x1B,
        // VK_BACK
        ShortcutKey::Named("Backspace") => 0x08,
        // VK_INSERT
        ShortcutKey::Named("Insert") => 0x2D,
        // VK_DELETE
        ShortcutKey::Named("Delete") => 0x2E,
        // VK_HOME
        ShortcutKey::Named("Home") => 0x24,
        // VK_END
        ShortcutKey::Named("End") => 0x23,
        // VK_PRIOR (Page Up)
        ShortcutKey::Named("PageUp") => 0x21,
        // VK_NEXT (Page Down)
        ShortcutKey::Named("PageDown") => 0x22,
        // VK_UP
        ShortcutKey::Named("Up") => 0x26,
        // VK_DOWN
        ShortcutKey::Named("Down") => 0x28,
        // VK_LEFT
        ShortcutKey::Named("Left") => 0x25,
        // VK_RIGHT
        ShortcutKey::Named("Right") => 0x27,
        // The settings parser only produces the keys above; keep the compiler
        // happy without panicking at runtime.
        ShortcutKey::Named(_) => 0,
    }
}

/// Registers `new` after unregistering the old shortcut; when registration
/// fails the previous shortcut is restored so the app never loses its hotkey.
fn swap_hotkey<U, R>(
    unregister: U,
    previous: Option<Shortcut>,
    new: Shortcut,
    mut register: R,
) -> Result<(), EngineError>
where
    U: FnOnce(),
    R: FnMut(Shortcut) -> bool,
{
    unregister();
    if register(new) {
        return Ok(());
    }
    if let Some(previous) = previous {
        let _ = register(previous);
    }
    Err(EngineError::new(
        "快捷键注册失败（可能已被其他程序占用）",
        "请换一个组合键后重试",
    ))
}

/// Applies `capture_set_hotkey`: normalize → no-op when unchanged → re-register
/// on the hotkey thread → persist + broadcast `state-changed` (contract §10.4).
pub fn set_hotkey(app: &AppHandle, raw: &str) -> SetHotkeyOutcome {
    let state = app.try_state::<Arc<AppState>>();
    let settings_shortcut = state
        .as_ref()
        .map(|state| state.settings.get().capture.region_shortcut.clone())
        .unwrap_or_else(|| DEFAULT_REGION_SHORTCUT.to_string());
    // Compare against the shortcut that is actually registered, not the
    // persisted one: after a failed startup registration the two differ, and
    // re-saving the same shortcut must retry the registration (an empty value
    // forces a change, i.e. "no hotkey is registered right now").
    let current = (*lock(&CURRENT_HOTKEY))
        .map(|shortcut| shortcut.label())
        .unwrap_or_default();
    match plan_hotkey_update(&current, raw) {
        HotkeyUpdate::Unchanged(shortcut) => SetHotkeyOutcome::Applied {
            shortcut: shortcut.label(),
            warning: None,
        },
        HotkeyUpdate::Change { requested, .. } => {
            if let Err(error) = request_hotkey_change(requested) {
                return SetHotkeyOutcome::Failed {
                    shortcut: if current.is_empty() {
                        normalize_shortcut(&settings_shortcut)
                    } else {
                        current
                    },
                    error: error.message,
                    hint: error.hint,
                };
            }
            let shortcut = requested.label();
            let Some(state) = state else {
                return SetHotkeyOutcome::Applied {
                    shortcut,
                    warning: Some("快捷键已生效，但应用状态不可用，未能保存设置。".to_string()),
                };
            };
            match state
                .settings
                .update_json(json!({ "capture": { "regionShortcut": shortcut.clone() } }))
            {
                Ok(_) => {
                    if let Some(log) = log_of(app) {
                        log.info(&format!("screenshot hotkey updated to {shortcut}"));
                    }
                    crate::commands::broadcast_state(app, &state);
                    SetHotkeyOutcome::Applied {
                        shortcut,
                        warning: None,
                    }
                }
                Err(error) => {
                    if let Some(log) = log_of(app) {
                        log.warn(&format!(
                            "screenshot hotkey {shortcut} applied but not persisted: {error}"
                        ));
                    }
                    SetHotkeyOutcome::Applied {
                        shortcut,
                        warning: Some(format!("快捷键已生效，但保存设置失败：{error}")),
                    }
                }
            }
        }
    }
}

/// Asks the hotkey thread to re-register `shortcut` and waits (bounded) for the
/// result. Returns the thread's message + hint on failure.
fn request_hotkey_change(shortcut: Shortcut) -> Result<(), EngineError> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW;

    let thread_id = HOTKEY_THREAD_ID.load(Ordering::SeqCst);
    if thread_id == 0 {
        return Err(EngineError::new(
            "截图快捷键服务尚未就绪。",
            "请重启程序后重试。",
        ));
    }
    let (sender, receiver) = mpsc::channel();
    *lock(&PENDING_HOTKEY) = Some(HotkeyRequest {
        shortcut,
        reply: sender,
    });
    let posted =
        unsafe { PostThreadMessageW(thread_id, HOTKEY_RELOAD_MESSAGE, WPARAM(0), LPARAM(0)) };
    if posted.is_err() {
        *lock(&PENDING_HOTKEY) = None;
        return Err(EngineError::new(
            "无法通知快捷键服务。",
            "请重试；若仍失败请重启程序。",
        ));
    }
    match receiver.recv_timeout(Duration::from_millis(1_500)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(_) => {
            *lock(&PENDING_HOTKEY) = None;
            Err(EngineError::new(
                "快捷键更新超时。",
                "请重试；若仍失败请重启程序。",
            ))
        }
    }
}

/// Registers a screenshot hotkey on a dedicated Windows message thread. The
/// thread also handles `WM_APP+1` re-registration requests triggered by
/// `capture_set_hotkey`, so changing the shortcut never restarts the app.
pub fn start_hotkey_listener(app: AppHandle) {
    let thread_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("lexora-capture-hotkey".to_string())
        .spawn(move || {
            use windows::Win32::System::Threading::GetCurrentThreadId;
            use windows::Win32::UI::Input::KeyboardAndMouse::UnregisterHotKey;
            use windows::Win32::UI::WindowsAndMessaging::{
                GetMessageW, PeekMessageW, MSG, PM_NOREMOVE, WM_HOTKEY,
            };

            fn register(shortcut: Shortcut) -> windows::core::Result<()> {
                use windows::Win32::UI::Input::KeyboardAndMouse::{
                    RegisterHotKey, HOT_KEY_MODIFIERS,
                };
                let (modifiers, virtual_key) = native_hotkey(shortcut);
                unsafe {
                    RegisterHotKey(None, HOTKEY_ID, HOT_KEY_MODIFIERS(modifiers), virtual_key)
                }
            }

            let thread_id = unsafe { GetCurrentThreadId() };
            // Create the thread's message queue before registering the hotkey or
            // publishing the thread id: `PostThreadMessageW` (used by
            // `capture_set_hotkey`) only works once the queue exists.
            let mut queue_message = MSG::default();
            unsafe {
                let _ = PeekMessageW(&mut queue_message, None, 0, 0, PM_NOREMOVE);
            }

            // Startup registration follows the persisted setting; a failure is
            // only logged so a conflicting shortcut never blocks the app.
            let initial = thread_app
                .try_state::<Arc<AppState>>()
                .map(|state| state.settings.get().capture.region_shortcut.clone())
                .and_then(|value| parse_shortcut(&value))
                .unwrap_or_else(default_shortcut);
            match register(initial) {
                Ok(()) => {
                    *lock(&CURRENT_HOTKEY) = Some(initial);
                    if let Some(log) = log_of(&thread_app) {
                        log.info(&format!(
                            "screenshot hotkey registered: {}",
                            initial.label()
                        ));
                    }
                }
                Err(error) => {
                    *lock(&CURRENT_HOTKEY) = None;
                    if let Some(log) = log_of(&thread_app) {
                        log.warn(&format!(
                            "screenshot hotkey {} registration failed: {error:?}",
                            initial.label()
                        ));
                    }
                }
            }
            HOTKEY_THREAD_ID.store(thread_id, Ordering::SeqCst);

            loop {
                let mut message = MSG::default();
                let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
                if result.0 <= 0 {
                    break;
                }
                if message.message == HOTKEY_RELOAD_MESSAGE {
                    let Some(request) = lock(&PENDING_HOTKEY).take() else {
                        continue;
                    };
                    let previous = *lock(&CURRENT_HOTKEY);
                    let outcome = swap_hotkey(
                        || unsafe {
                            let _ = UnregisterHotKey(None, HOTKEY_ID);
                        },
                        previous,
                        request.shortcut,
                        |shortcut| register(shortcut).is_ok(),
                    );
                    match outcome {
                        Ok(()) => {
                            *lock(&CURRENT_HOTKEY) = Some(request.shortcut);
                            if let Some(log) = log_of(&thread_app) {
                                log.info(&format!(
                                    "screenshot hotkey registered: {}",
                                    request.shortcut.label()
                                ));
                            }
                            let _ = request.reply.send(Ok(()));
                        }
                        Err(error) => {
                            if let Some(log) = log_of(&thread_app) {
                                log.warn(&format!(
                                    "screenshot hotkey {} rejected: {}",
                                    request.shortcut.label(),
                                    error.message
                                ));
                            }
                            let _ = request.reply.send(Err(error));
                        }
                    }
                    continue;
                }
                if message.message != WM_HOTKEY {
                    continue;
                }
                if message.wParam.0 as i32 != HOTKEY_ID {
                    continue;
                }
                let app = thread_app.clone();
                tauri::async_runtime::spawn(async move {
                    let Some(state) = app.try_state::<Arc<AppState>>() else {
                        return;
                    };
                    let state = state.inner().clone();
                    state
                        .log
                        .info("screenshot hotkey pressed: starting capture");
                    if let Err(error) = start_capture(&app, &state, None).await {
                        state.log.warn(&format!(
                            "hotkey screenshot failed: {} / {}",
                            error.message, error.hint
                        ));
                    }
                });
            }

            unsafe {
                let _ = UnregisterHotKey(None, HOTKEY_ID);
            }
            *lock(&CURRENT_HOTKEY) = None;
            HOTKEY_THREAD_ID.store(0, Ordering::SeqCst);
        });
    if let Err(error) = spawned {
        let logger = log_of(&app);
        if let Some(logger) = logger {
            logger.warn(&format!(
                "could not start screenshot hotkey thread: {error}"
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::CustomSkill;
    use image::Rgba;

    #[test]
    fn screenshot_picker_config_uses_runtime_engine_capabilities() {
        let source = include_str!("capture.rs");
        let shared_tail = source
            .split_once("fn finish_skill_job(")
            .expect("shared screenshot and pinned-image skill entry point")
            .1
            .split_once("// Tell the picker which panel to open")
            .expect("picker payload before streaming event")
            .0;
        assert!(shared_tail.contains("let engine = engine_of(app)?;"));
        assert!(shared_tail.contains("config: picker_config_with_engine(settings, &engine)"));
        assert!(!shared_tail.contains("config: picker_config(settings)"));
    }

    fn pixel_image() -> RgbaImage {
        RgbaImage::from_fn(10, 10, |x, y| Rgba([x as u8, y as u8, 0, 255]))
    }

    fn test_shot() -> Shot {
        Shot {
            index: 0,
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            image: pixel_image(),
            display_url: "data:image/jpeg;base64,AA==".to_string(),
        }
    }

    /// Shot with a solid colour, used to tell monitors apart when stitching.
    fn solid_shot(index: u32, x: i32, y: i32, width: u32, height: u32, color: [u8; 4]) -> Shot {
        Shot {
            index,
            x,
            y,
            width,
            height,
            image: RgbaImage::from_pixel(width, height, Rgba(color)),
            display_url: "data:image/jpeg;base64,AA==".to_string(),
        }
    }

    fn service_with_shots(shots: Vec<Shot>) -> CaptureService {
        let service = CaptureService::new();
        *lock(&service.session) = Some(Session {
            shots,
            preset: None,
        });
        service
    }

    #[test]
    fn capture_session_marks_the_service_as_active() {
        // Contract §11.11.2: a session means the overlays are armed/shown, so a
        // second screenshot trigger must be rejected until it ends.
        let service = CaptureService::new();
        assert!(!service.is_active());

        *lock(&service.session) = Some(Session {
            shots: vec![test_shot()],
            preset: None,
        });
        assert!(service.is_active());

        // close/copy/skill clear the session and allow a new screenshot again.
        service.clear_session();
        assert!(!service.is_active());
    }

    #[test]
    fn fallback_covers_only_monitors_without_a_ready_signal() {
        let mut second = test_shot();
        second.index = 1;
        let shots = vec![test_shot(), second];
        // Nothing reported readiness yet: both overlays get the fallback show.
        assert_eq!(missing_ready_monitors(&shots, &HashSet::new()), vec![0, 1]);
        // A healthy secondary renderer must not hide the missing primary one.
        assert_eq!(missing_ready_monitors(&shots, &HashSet::from([1])), vec![0]);
        // Every renderer painted: a healthy capture gets no extra show.
        assert!(missing_ready_monitors(&shots, &HashSet::from([0, 1])).is_empty());
    }

    #[test]
    fn already_active_error_matches_the_contract_wording() {
        let error = capture_already_active_error();
        assert_eq!(error.message, "已经在截图了。");
        assert_eq!(error.hint, "请先完成当前截图（或按 Esc 取消）后再试。");
    }

    #[test]
    fn longshot_seed_crops_the_selection_and_keeps_the_monitor_geometry() {
        // Contract §11.14: `longshot_start` seeds the manual stitcher with the
        // session crop plus the physical monitor geometry.
        let service = CaptureService::new();
        let mut shot = test_shot();
        shot.x = 100;
        shot.y = 50;
        *lock(&service.session) = Some(Session {
            shots: vec![shot],
            preset: None,
        });
        let seed = service
            .longshot_seed(
                0,
                &HitRect {
                    x: 2.0,
                    y: 1.0,
                    width: 4.0,
                    height: 5.0,
                },
            )
            .unwrap();
        assert_eq!(seed.crop, (2, 1, 4, 5));
        assert_eq!(seed.origin_x, 100);
        assert_eq!(seed.origin_y, 50);
        assert_eq!(seed.monitor_width, 10);
        assert_eq!(seed.monitor_height, 10);
        assert_eq!(seed.first_frame.dimensions(), (4, 5));
        // Invalid rects are rejected like every other crop.
        assert!(service
            .longshot_seed(
                0,
                &HitRect {
                    x: 100.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                }
            )
            .is_err());
        // No session → not ready.
        service.clear_session();
        assert!(service.longshot_seed(0, &HitRect::default()).is_err());
    }

    #[test]
    fn stitched_scaled_preview_keeps_the_aspect_ratio() {
        let image = RgbaImage::from_fn(400, 200, |x, y| Rgba([x as u8, y as u8, 0, 255]));
        let stitched = Stitched::from_image(&image);
        // 0.25 scale → 100×50.
        let scaled = stitched.scaled_by(0.25);
        assert_eq!(scaled.dimensions(), (100, 50));
        // Already small enough / scale 1: untouched copy.
        let full = stitched.scaled_by(1.0);
        assert_eq!(full.dimensions(), (400, 200));
        assert_eq!(full.as_raw(), image.as_raw());
        // Invalid scales fall back to the full image instead of panicking.
        assert_eq!(stitched.scaled_by(f64::NAN).dimensions(), (400, 200));
        assert_eq!(stitched.scaled_by(0.0).dimensions(), (400, 200));
    }

    fn image_skill_settings() -> Settings {
        let mut settings = Settings::default();
        settings.picker.custom_skills = vec![
            CustomSkill {
                id: "custom-text".to_string(),
                label: "文字技能".to_string(),
                icon: "star".to_string(),
                kind: "text".to_string(),
                prompt: "Explain {text}".to_string(),
            },
            CustomSkill {
                id: "custom-image".to_string(),
                label: "图片技能".to_string(),
                icon: "wand".to_string(),
                kind: "image".to_string(),
                prompt: "Extract {text} in {target}".to_string(),
            },
        ];
        settings.picker.skills = vec!["custom-text".to_string()];
        // Custom image skills are enabled through the screenshot toolbar list.
        settings.picker.capture_skills = vec!["custom-image".to_string()];
        settings
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
    fn crop_global_stitches_a_selection_across_two_monitors() {
        // Two 10x10 monitors side by side: a 10 px selection starting in the
        // middle takes 5 px from each one (half-open rects).
        let service = service_with_shots(vec![
            solid_shot(0, 0, 0, 10, 10, [255, 0, 0, 255]),
            solid_shot(1, 10, 0, 10, 10, [0, 255, 0, 255]),
        ]);
        let image = service
            .crop_global(&GlobalRect {
                x: 5,
                y: 0,
                width: 10,
                height: 3,
            })
            .unwrap();
        assert_eq!(image.dimensions(), (10, 3));
        for x in 0..5 {
            assert_eq!(*image.get_pixel(x, 1), Rgba([255, 0, 0, 255]), "x={x}");
        }
        for x in 5..10 {
            assert_eq!(*image.get_pixel(x, 1), Rgba([0, 255, 0, 255]), "x={x}");
        }
        assert_eq!(*image.get_pixel(4, 0), Rgba([255, 0, 0, 255]));
        assert_eq!(*image.get_pixel(5, 0), Rgba([0, 255, 0, 255]));
    }

    #[test]
    fn crop_global_clamps_to_monitor_bounds_and_fills_gaps_black() {
        // An L-shaped desk layout: the 10 px virtual gap between the monitors
        // has no captured pixels and must stay black like a real screenshot.
        let service = service_with_shots(vec![
            solid_shot(0, 0, 0, 10, 10, [10, 20, 30, 255]),
            solid_shot(1, 20, 0, 10, 10, [40, 50, 60, 255]),
        ]);
        let image = service
            .crop_global(&GlobalRect {
                x: -5,
                y: 2,
                width: 40,
                height: 4,
            })
            .unwrap();
        assert_eq!(image.dimensions(), (40, 4));
        // Before the virtual screen (global x < 0).
        assert_eq!(*image.get_pixel(4, 0), Rgba([0, 0, 0, 255]));
        // First monitor: global x 0..10 → output x 5..15.
        assert_eq!(*image.get_pixel(5, 0), Rgba([10, 20, 30, 255]));
        assert_eq!(*image.get_pixel(14, 3), Rgba([10, 20, 30, 255]));
        // Uncovered gap: global x 10..20 → output x 15..25.
        assert_eq!(*image.get_pixel(15, 0), Rgba([0, 0, 0, 255]));
        assert_eq!(*image.get_pixel(24, 3), Rgba([0, 0, 0, 255]));
        // Second monitor: global x 20..30 → output x 25..35.
        assert_eq!(*image.get_pixel(25, 0), Rgba([40, 50, 60, 255]));
        assert_eq!(*image.get_pixel(34, 3), Rgba([40, 50, 60, 255]));
        // Selection extends past the last monitor: black again.
        assert_eq!(*image.get_pixel(35, 0), Rgba([0, 0, 0, 255]));
        assert_eq!(*image.get_pixel(39, 3), Rgba([0, 0, 0, 255]));
    }

    #[test]
    fn crop_global_requires_a_session_and_rejects_invalid_rects() {
        let rect = GlobalRect {
            x: 0,
            y: 0,
            width: 4,
            height: 4,
        };
        // No session → the usual "not ready" wording.
        let error = CaptureService::new().crop_global(&rect).unwrap_err();
        assert_eq!(error.message, "截图尚未准备好。");

        let service = service_with_shots(vec![test_shot()]);
        let empty = GlobalRect {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
        assert_eq!(
            service.crop_global(&empty).unwrap_err().message,
            "选区无效。"
        );
        let zero_height = GlobalRect {
            x: 0,
            y: 0,
            width: 4,
            height: 0,
        };
        assert!(service.crop_global(&zero_height).is_err());
        // A bogus renderer rect is rejected before it allocates gigabytes.
        let huge = GlobalRect {
            x: 0,
            y: 0,
            width: 20_000,
            height: 20_000,
        };
        assert_eq!(
            service.crop_global(&huge).unwrap_err().message,
            "选区过大。"
        );
    }

    #[test]
    fn monitor_rects_only_intersect_when_they_overlap() {
        assert_eq!(
            intersect_rects((0, 0, 10, 10), (5, 5, 10, 10)),
            Some((5, 5, 5, 5))
        );
        // Touching edges do not overlap (half-open rects).
        assert_eq!(intersect_rects((0, 0, 10, 10), (10, 0, 10, 10)), None);
        assert_eq!(intersect_rects((-20, -10, 20, 10), (0, 0, 10, 10)), None);
    }

    #[test]
    fn layout_snapshot_reports_monitor_geometry_and_bounds() {
        let service = service_with_shots(vec![
            solid_shot(0, 0, 0, 10, 10, [0, 0, 0, 255]),
            solid_shot(1, 10, 0, 10, 10, [0, 0, 0, 255]),
        ]);
        let snapshot = service.layout_snapshot().unwrap();
        assert_eq!(snapshot.monitors.len(), 2);
        assert_eq!(snapshot.monitors[0].index, 0);
        assert_eq!(snapshot.monitors[1].x, 10);
        assert_eq!(
            snapshot.bounds,
            GlobalRect {
                x: 0,
                y: 0,
                width: 20,
                height: 10,
            }
        );

        // A monitor above/left of the primary one produces a negative origin.
        let service = service_with_shots(vec![
            solid_shot(0, -20, -10, 20, 10, [0, 0, 0, 255]),
            solid_shot(1, 0, 0, 10, 10, [0, 0, 0, 255]),
        ]);
        let snapshot = service.layout_snapshot().unwrap();
        assert_eq!(
            snapshot.bounds,
            GlobalRect {
                x: -20,
                y: -10,
                width: 30,
                height: 20,
            }
        );

        // No session → the capture page must wait for the next screenshot.
        assert!(CaptureService::new().layout_snapshot().is_none());
    }

    #[test]
    fn crop_selection_keeps_both_paths_and_composites_annotations() {
        let service = service_with_shots(vec![test_shot()]);
        // Legacy single-monitor path is unchanged.
        let legacy = service
            .crop_selection(
                0,
                &HitRect {
                    x: 2.0,
                    y: 3.0,
                    width: 4.0,
                    height: 5.0,
                },
                None,
                None,
            )
            .unwrap();
        assert_eq!(legacy.dimensions(), (4, 5));
        assert_eq!(*legacy.get_pixel(0, 0), *pixel_image().get_pixel(2, 3));

        // Global path: the annotation layer is the selection-sized layer.
        let mut layer = RgbaImage::new(6, 4);
        *layer.get_pixel_mut(0, 0) = Rgba([255, 0, 0, 255]);
        let global = service
            .crop_selection(
                0,
                &HitRect::default(),
                Some(annotation_data_url(&layer)),
                Some(&GlobalRect {
                    x: 0,
                    y: 0,
                    width: 6,
                    height: 4,
                }),
            )
            .unwrap();
        assert_eq!(global.dimensions(), (6, 4));
        assert_eq!(*global.get_pixel(0, 0), Rgba([255, 0, 0, 255]));
        assert_eq!(*global.get_pixel(5, 3), *pixel_image().get_pixel(5, 3));
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
    fn jpeg_data_url_is_a_decodable_jpeg_at_the_original_size() {
        let image = pixel_image();
        let url = jpeg_data_url(&image).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"));
        let encoded = url
            .strip_prefix("data:image/jpeg;base64,")
            .expect("JPEG data URL prefix");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        // JPEG SOI (FFD8) ... EOI (FFD9) markers.
        assert_eq!(&bytes[..2], b"\xff\xd8");
        assert_eq!(&bytes[bytes.len() - 2..], b"\xff\xd9");
        // The display image keeps the physical pixel size of the screenshot.
        let decoded = image::load_from_memory(&bytes)
            .expect("decode JPEG")
            .into_rgba8();
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
        let settings = image_skill_settings();
        assert!(image_skill(&settings, "custom-text").is_none());
        assert_eq!(
            image_skill(&settings, "custom-image").map(|skill| skill.label.as_str()),
            Some("图片技能")
        );
        assert!(image_skill(&settings, "custom-missing").is_none());
    }

    #[test]
    fn target_event_payload_matches_the_contract_shape() {
        let payload = target_event_payload("capture-1", "en");
        assert_eq!(payload["requestId"], "capture-1");
        assert_eq!(payload["type"], "target");
        assert_eq!(payload["targetLang"], "en");
        // Nothing else leaks into the event.
        assert_eq!(payload.as_object().map(|object| object.len()), Some(3));
    }

    #[test]
    fn retry_target_language_only_updates_translations() {
        // A screenshot translation may switch its target language.
        assert_eq!(
            retry_target_lang(SkillAction::Translate, "auto", Some("en".to_string())),
            "en"
        );
        // Missing/blank values keep the stored target.
        assert_eq!(retry_target_lang(SkillAction::Translate, "zh", None), "zh");
        assert_eq!(
            retry_target_lang(SkillAction::Translate, "zh", Some("   ".to_string())),
            "zh"
        );
        // Every other action ignores a renderer-provided target.
        assert_eq!(
            retry_target_lang(SkillAction::Ocr, "auto", Some("en".to_string())),
            "auto"
        );
        assert_eq!(
            retry_target_lang(SkillAction::Explain, "auto", Some("ja".to_string())),
            "auto"
        );
    }

    #[test]
    fn capture_prompts_override_the_builtin_action_prompts() {
        let mut settings = Settings::default();
        // Pin the local language so the answer-language rendering is deterministic.
        settings.app.language = "en".to_string();
        settings.picker.capture_prompts.translate = "Translate into {target}.".to_string();
        settings.picker.capture_prompts.word_lookup = "Word {target}.".to_string();
        settings.picker.capture_prompts.explain = "Describe the UI text.".to_string();
        let translate =
            resolve_skill_meta(&settings, SkillAction::Translate, None, "auto").unwrap();
        assert_eq!(translate.system_prompt, "Translate into {target}.");
        assert_eq!(translate.word_lookup_prompt, "Word {target}.");
        let explain = resolve_skill_meta(&settings, SkillAction::Explain, None, "auto").unwrap();
        assert_eq!(
            explain.system_prompt,
            "Describe the UI text.\n\nAnswer language: English."
        );
        assert!(explain.word_lookup_prompt.is_empty());

        // A custom explain prompt with `{answer}` is substituted without suffix.
        settings.picker.capture_prompts.explain = "Describe the UI text in {answer}.".to_string();
        let explain = resolve_skill_meta(&settings, SkillAction::Explain, None, "auto").unwrap();
        assert_eq!(explain.system_prompt, "Describe the UI text in English.");

        // Empty overrides fall back to the built-in default, rendered with the
        // local answer language (the engine still treats it as the default
        // prompt for budgeting).
        let mut defaults = Settings::default();
        defaults.app.language = "en".to_string();
        let explain = resolve_skill_meta(&defaults, SkillAction::Explain, None, "auto").unwrap();
        assert_eq!(
            explain.system_prompt,
            crate::engine::render_answer_language(
                crate::engine::DEFAULT_EXPLAIN_IMAGE_PROMPT,
                "English"
            )
        );
        assert!(explain
            .system_prompt
            .contains("Explain the image in English"));
        assert!(!explain.system_prompt.contains("{answer}"));
        let translate =
            resolve_skill_meta(&defaults, SkillAction::Translate, None, "auto").unwrap();
        assert!(translate.system_prompt.is_empty());
        assert!(translate.word_lookup_prompt.is_empty());
        let ocr = resolve_skill_meta(&defaults, SkillAction::Ocr, None, "auto").unwrap();
        assert!(ocr.word_lookup_prompt.is_empty());
    }

    #[test]
    fn skill_actions_parse_the_contract_values() {
        assert_eq!(SkillAction::parse("ocr"), Some(SkillAction::Ocr));
        assert_eq!(
            SkillAction::parse("  Translate "),
            Some(SkillAction::Translate)
        );
        assert_eq!(SkillAction::parse("EXPLAIN"), Some(SkillAction::Explain));
        assert_eq!(SkillAction::parse("custom"), Some(SkillAction::Custom));
        assert_eq!(SkillAction::parse("ai"), None);
        assert_eq!(SkillAction::parse(""), None);
        assert!(!SkillAction::Ocr.is_vision());
        assert!(!SkillAction::Translate.is_vision());
        assert!(SkillAction::Explain.is_vision());
        assert!(SkillAction::Custom.is_vision());
    }

    #[test]
    fn skill_meta_validates_custom_image_skills() {
        let settings = image_skill_settings();
        let target = "auto";
        // Built-in actions need no skill id.
        assert_eq!(
            resolve_skill_meta(&settings, SkillAction::Ocr, None, target)
                .unwrap()
                .label,
            "提取文字"
        );
        assert_eq!(
            resolve_skill_meta(&settings, SkillAction::Translate, None, target)
                .unwrap()
                .label,
            "翻译"
        );
        let explain = resolve_skill_meta(&settings, SkillAction::Explain, None, target).unwrap();
        assert_eq!(explain.label, "解释图片");
        assert!(!explain.system_prompt.is_empty());
        // Image skills render `{text}` / `{target}` for the vision model.
        let custom =
            resolve_skill_meta(&settings, SkillAction::Custom, Some("custom-image"), target)
                .unwrap();
        assert_eq!(custom.label, "图片技能");
        assert_eq!(custom.skill_id, "custom-image");
        assert!(!custom.system_prompt.contains("{text}"));
        assert!(!custom.system_prompt.contains("{target}"));
        // Missing / text / disabled skills are rejected.
        assert!(resolve_skill_meta(&settings, SkillAction::Custom, None, target).is_err());
        assert!(
            resolve_skill_meta(&settings, SkillAction::Custom, Some("custom-text"), target)
                .is_err()
        );
        let mut disabled = settings;
        disabled.picker.capture_skills = vec!["translate".to_string()];
        assert!(
            resolve_skill_meta(&disabled, SkillAction::Custom, Some("custom-image"), target)
                .is_err()
        );
    }

    #[test]
    fn selection_anchor_is_the_bottom_right_corner() {
        // Normal selection: exclusive bottom-right corner in physical pixels.
        assert_eq!(
            anchor_bottom_right(1920, -1080, 1920, 1080, 10, 20, 30, 40),
            (1960, -1020)
        );
        // A selection touching the monitor edge stays one pixel inside, so the
        // picker uses the captured monitor's work area and DPI.
        assert_eq!(anchor_bottom_right(0, 0, 100, 80, 90, 70, 10, 10), (99, 79));
        assert_eq!(anchor_bottom_right(0, 0, 1, 1, 0, 0, 1, 1), (0, 0));
        assert_eq!(
            anchor_bottom_right(-1920, 0, 1920, 1080, 1919, 0, 1, 1),
            (-1, 1)
        );
    }

    #[test]
    fn native_hotkey_maps_modifiers_and_virtual_keys() {
        let hotkey = |text: &str| native_hotkey(parse_shortcut(text).unwrap());
        assert_eq!(
            hotkey("Win+Shift+X"),
            (MOD_WIN_RAW | MOD_SHIFT_RAW | MOD_NOREPEAT_RAW, 0x58)
        );
        assert_eq!(
            hotkey("Ctrl+Alt+P"),
            (MOD_CONTROL_RAW | MOD_ALT_RAW | MOD_NOREPEAT_RAW, 0x50)
        );
        // MOD_NOREPEAT is always present.
        assert_eq!(hotkey("Alt+1").0 & MOD_NOREPEAT_RAW, MOD_NOREPEAT_RAW);
        // Letters / digits.
        assert_eq!(hotkey("Ctrl+Q").1, u32::from(b'Q'));
        assert_eq!(hotkey("Win+0").1, u32::from(b'0'));
        assert_eq!(hotkey("Win+9").1, u32::from(b'9'));
        // Function keys: VK_F1 = 0x70 … VK_F24 = 0x87.
        assert_eq!(hotkey("Ctrl+F1").1, 0x70);
        assert_eq!(hotkey("Ctrl+F12").1, 0x7B);
        assert_eq!(hotkey("Ctrl+F24").1, 0x87);
        // Named keys.
        for (text, expected) in [
            ("Ctrl+PrintScreen", 0x2C),
            ("Ctrl+Space", 0x20),
            ("Ctrl+Tab", 0x09),
            ("Ctrl+Enter", 0x0D),
            ("Ctrl+Esc", 0x1B),
            ("Ctrl+Backspace", 0x08),
            ("Ctrl+Insert", 0x2D),
            ("Ctrl+Delete", 0x2E),
            ("Ctrl+Home", 0x24),
            ("Ctrl+End", 0x23),
            ("Ctrl+PageUp", 0x21),
            ("Ctrl+PageDown", 0x22),
            ("Ctrl+Up", 0x26),
            ("Ctrl+Down", 0x28),
            ("Ctrl+Left", 0x25),
            ("Ctrl+Right", 0x27),
        ] {
            assert_eq!(hotkey(text).1, expected, "text={text}");
        }
    }

    #[test]
    fn hotkey_plan_detects_unchanged_and_changed_shortcuts() {
        let default = default_shortcut();
        assert_eq!(
            plan_hotkey_update("Win+Shift+X", "win+shift+x"),
            HotkeyUpdate::Unchanged(default)
        );
        // An invalid renderer value normalizes to the default shortcut.
        assert_eq!(
            plan_hotkey_update("Win+Shift+X", "not a shortcut"),
            HotkeyUpdate::Unchanged(default)
        );
        match plan_hotkey_update("Win+Shift+X", "ctrl+alt+p") {
            HotkeyUpdate::Change {
                previous,
                requested,
            } => {
                assert_eq!(previous, Some(default));
                assert_eq!(requested, parse_shortcut("Ctrl+Alt+P").unwrap());
                assert_eq!(requested.label(), "Ctrl+Alt+P");
            }
            other => panic!("expected a change, got {other:?}"),
        }
        // An unparsable persisted value has nothing to roll back to.
        match plan_hotkey_update("", "Ctrl+Alt+P") {
            HotkeyUpdate::Change { previous, .. } => assert!(previous.is_none()),
            other => panic!("expected a change, got {other:?}"),
        }
    }

    #[test]
    fn failed_hotkey_registration_restores_the_previous_shortcut() {
        let previous = parse_shortcut("Win+Shift+X").unwrap();
        let requested = parse_shortcut("Ctrl+Alt+P").unwrap();

        // Only the old shortcut is free: the requested one fails and the old
        // one is registered again so the app keeps its screenshot hotkey.
        let mut attempts = Vec::new();
        let result = swap_hotkey(
            || {},
            Some(previous),
            requested,
            |shortcut| {
                attempts.push(shortcut);
                shortcut == previous
            },
        );
        assert!(result.is_err());
        assert_eq!(attempts, vec![requested, previous]);
        let error = result.unwrap_err();
        assert!(error.message.contains("快捷键注册失败"));
        assert_eq!(error.hint, "请换一个组合键后重试");

        // Without a previous shortcut there is nothing to restore.
        let mut attempts = Vec::new();
        assert!(swap_hotkey(
            || {},
            None,
            requested,
            |shortcut| {
                attempts.push(shortcut);
                false
            }
        )
        .is_err());
        assert_eq!(attempts, vec![requested]);

        // A successful registration never touches the old shortcut.
        let mut attempts = Vec::new();
        swap_hotkey(
            || {},
            Some(previous),
            requested,
            |shortcut| {
                attempts.push(shortcut);
                true
            },
        )
        .unwrap();
        assert_eq!(attempts, vec![requested]);

        // The old shortcut is unregistered before the new one is registered.
        let order = std::cell::RefCell::new(Vec::new());
        swap_hotkey(
            || order.borrow_mut().push("unregister"),
            None,
            requested,
            |_| {
                order.borrow_mut().push("register");
                true
            },
        )
        .unwrap();
        assert_eq!(order.into_inner(), vec!["unregister", "register"]);
    }

    // -- annotation compositing (contract §11.4) ---------------------------

    fn annotation_data_url(layer: &RgbaImage) -> String {
        png_data_url(layer).expect("encode annotation layer")
    }

    #[test]
    fn annotations_are_alpha_composited_at_crop_size() {
        let mut base = RgbaImage::from_pixel(4, 3, Rgba([0, 0, 0, 255]));
        let mut layer = RgbaImage::new(4, 3);
        *layer.get_pixel_mut(0, 0) = Rgba([255, 0, 0, 255]);
        *layer.get_pixel_mut(1, 0) = Rgba([0, 255, 0, 128]);

        composite_annotations(&mut base, Some(annotation_data_url(&layer))).unwrap();

        // Fully opaque annotation pixel replaces the screenshot pixel.
        assert_eq!(*base.get_pixel(0, 0), Rgba([255, 0, 0, 255]));
        // 50% alpha blends over the black crop and stays opaque.
        let blended = *base.get_pixel(1, 0);
        assert!(
            (126..=129).contains(&blended[1]),
            "channel={} pixel={blended:?}",
            blended[1]
        );
        assert_eq!(blended[0], 0);
        assert_eq!(blended[3], 255);
        // Transparent annotation pixels leave the screenshot untouched.
        assert_eq!(*base.get_pixel(2, 0), Rgba([0, 0, 0, 255]));
        assert_eq!(*base.get_pixel(3, 2), Rgba([0, 0, 0, 255]));
    }

    #[test]
    fn annotations_are_scaled_to_the_crop_size() {
        let mut base = RgbaImage::from_pixel(4, 2, Rgba([0, 0, 0, 255]));
        let layer = RgbaImage::from_pixel(1, 1, Rgba([255, 255, 255, 255]));
        composite_annotations(&mut base, Some(annotation_data_url(&layer))).unwrap();
        for pixel in base.pixels() {
            assert_eq!(*pixel, Rgba([255, 255, 255, 255]));
        }
    }

    #[test]
    fn annotations_are_optional_and_invalid_layers_are_rejected() {
        let original = pixel_image();
        let mut unchanged = original.clone();
        composite_annotations(&mut unchanged, None).unwrap();
        composite_annotations(&mut unchanged, Some("   ".to_string())).unwrap();
        assert_eq!(unchanged, original);

        let mut image = original;
        assert!(composite_annotations(&mut image, Some("not-a-data-url".to_string())).is_err());
        assert!(
            composite_annotations(&mut image, Some("data:image/png;base64,AAAA".to_string()))
                .is_err()
        );
    }

    // -- long screenshot stitching (contract §11.6) ------------------------

    /// Deterministic noise so rows differ and overlap detection is meaningful.
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

    fn crop_rows(canvas: &RgbaImage, y: u32, height: u32) -> RgbaImage {
        image::imageops::crop_imm(canvas, 0, y, canvas.width(), height).to_image()
    }

    #[test]
    fn longshot_overlap_is_detected_and_stitched() {
        let canvas = noise_image(12, 200, 7);
        let first = crop_rows(&canvas, 0, 40);
        let next = crop_rows(&canvas, 25, 40);
        let mut stitched = Stitched::from_image(&first);

        let overlap = find_overlap(&stitched, &next, None).expect("overlap must be detected");
        assert_eq!(overlap, 15);
        assert_eq!(
            longshot_decision(12, 2, false, Some(overlap), stitched.height() + 25),
            LongshotDecision::Continue
        );

        stitched.push_rows(&next, overlap);
        assert_eq!(stitched.height(), 65);
        let image = stitched.into_image();
        assert_eq!(image.dimensions(), (12, 65));
        // The first frame stays intact and every row is one continuous capture.
        for y in 0..65 {
            assert_eq!(
                *image.get_pixel(0, y),
                *canvas.get_pixel(0, y),
                "row {y} mismatched"
            );
        }
    }

    #[test]
    fn longshot_without_overlap_is_rejected() {
        let first = noise_image(12, 40, 7);
        let unrelated = noise_image(12, 40, 99);
        let stitched = Stitched::from_image(&first);
        assert_eq!(find_overlap(&stitched, &unrelated, None), None);
        assert_eq!(
            longshot_decision(12, 2, false, None, 80),
            LongshotDecision::Stop(LongshotStop::NoOverlap)
        );
        // Degenerate overlaps count as "no overlap" as well.
        assert_eq!(
            longshot_decision(12, 2, false, Some(0), 80),
            LongshotDecision::Stop(LongshotStop::NoOverlap)
        );
    }

    #[test]
    fn longshot_stop_conditions_are_decided_in_order() {
        assert_eq!(
            longshot_decision(1000, 2, true, None, 100),
            LongshotDecision::Stop(LongshotStop::SameFrame)
        );
        // An identical frame dominates even when an overlap was computed.
        assert_eq!(
            longshot_decision(1000, 2, true, Some(10), 100),
            LongshotDecision::Stop(LongshotStop::SameFrame)
        );
        assert_eq!(
            longshot_decision(1000, 2, false, None, 1000),
            LongshotDecision::Stop(LongshotStop::NoOverlap)
        );
        assert_eq!(
            longshot_decision(1000, 2, false, Some(50), LONGSHOT_MAX_HEIGHT + 1),
            LongshotDecision::Stop(LongshotStop::MaxHeight)
        );
        // A very wide image hits the memory budget before the row cap.
        assert_eq!(
            longshot_decision(3840, 2, false, Some(50), 20_000),
            LongshotDecision::Stop(LongshotStop::MaxHeight)
        );
        assert_eq!(
            longshot_decision(1000, LONGSHOT_MAX_FRAMES, false, Some(50), 5000),
            LongshotDecision::Stop(LongshotStop::MaxFrames)
        );
        assert_eq!(
            longshot_decision(1000, 2, false, Some(50), 5000),
            LongshotDecision::Continue
        );
        // Stop reasons map to the contract's log tokens.
        for (reason, token) in [
            (LongshotStop::NoOverlap, "no-overlap"),
            (LongshotStop::SameFrame, "same-frame"),
            (LongshotStop::MaxHeight, "max-height"),
            (LongshotStop::MaxFrames, "max-frames"),
        ] {
            assert_eq!(reason.as_str(), token);
        }
    }

    #[test]
    fn longshot_identical_frames_are_detected() {
        let canvas = noise_image(64, 200, 3);
        let first = crop_rows(&canvas, 0, 80);
        assert!(frames_identical(&first, &first));
        let scrolled = crop_rows(&canvas, 1, 80);
        assert!(!frames_identical(&first, &scrolled));
    }
}
