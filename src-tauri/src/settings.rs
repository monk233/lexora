//! User settings: schema, defaults, normalization and JSON persistence.
//!
//! The on-disk file is ``<data>/settings.json``. Unknown keys are dropped and
//! every value is clamped, so a hand-edited or corrupted file can never put the
//! app into an invalid state.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// Version of the on-disk settings schema. Bumped whenever defaults or fields
/// change so [`Settings::normalize`] can migrate an older file in place.
pub const SETTINGS_VERSION: u32 = 4;
/// Default global shortcut that starts a region screenshot.
pub const DEFAULT_REGION_SHORTCUT: &str = "Win+Shift+X";
/// Built-in picker skills, in their canonical toolbar order.
pub const SKILLS: [&str; 8] = [
    "translate",
    "summarize",
    "explain",
    "polish",
    "read",
    "copy",
    "screenshot",
    "search",
];
/// Icon used when a custom skill has an unknown or empty icon. Valid icon keys
/// match `^[a-z0-9-]{1,40}$`; the picker maps a key it has no artwork for back
/// to this default.
pub const CUSTOM_SKILL_DEFAULT_ICON: &str = "sparkles";
/// Search engines accepted by `picker.searchEngine`; the picker's search
/// skill opens the search URL of the configured engine.
pub const SEARCH_ENGINES: [&str; 3] = ["google", "baidu", "bing"];
/// Engine used when `picker.searchEngine` is unknown or empty.
pub const DEFAULT_SEARCH_ENGINE: &str = "google";
/// Panel sizing modes accepted by `picker.panelMode`: `auto` grows the window
/// with the content (default, historical behavior), `scroll` keeps a fixed
/// window and scrolls the panel body instead.
pub const PANEL_MODES: [&str; 2] = ["auto", "scroll"];
/// Default panel sizing mode: grow with the content.
pub fn default_panel_mode() -> String {
    "auto".to_string()
}
/// Built-in actions of the screenshot toolbar, in their canonical order. They
/// are configured independently from the picker skills: `picker.captureSkills`
/// holds the enabled subset in toolbar order.
pub const CAPTURE_SKILLS: [&str; 4] = ["copy", "ocr", "translate", "explain"];
/// Default screenshot toolbar actions (all of them, canonical order).
pub fn default_capture_skills() -> Vec<String> {
    CAPTURE_SKILLS
        .iter()
        .map(|skill| skill.to_string())
        .collect()
}
/// Input kinds accepted by `picker.customSkills[].kind`: `text` runs the custom
/// skill on the selected text, `image` runs it on a screenshot region.
pub const CUSTOM_SKILL_KINDS: [&str; 2] = ["text", "image"];
/// Kind used when a custom skill's `kind` is empty or unknown.
pub fn default_custom_skill_kind() -> String {
    "text".to_string()
}
/// Label used when a custom skill has an empty label.
const CUSTOM_SKILL_DEFAULT_LABEL: &str = "自定义技能";
/// Hard cap so a corrupted settings file cannot bloat the picker forever.
const CUSTOM_SKILL_MAX: usize = 20;
/// Labels are short button captions; ids must stay stable for the UI.
const CUSTOM_SKILL_LABEL_MAX_CHARS: usize = 20;
const CUSTOM_SKILL_ID_MAX_CHARS: usize = 40;
const CUSTOM_SKILL_ICON_MAX_CHARS: usize = 40;
/// Languages supported by the Hy-MT2 translation model (33 languages plus
/// Chinese variants and minority languages). `auto` asks the shell to resolve
/// the target from the source text.
pub const TARGET_LANGS: [&str; 39] = [
    "auto", "zh", "en", "zh-hant", "yue", "ja", "ko", "fr", "de", "es", "pt", "ru", "ar", "it",
    "nl", "pl", "tr", "th", "vi", "id", "ms", "tl", "hi", "bn", "ta", "te", "mr", "gu", "ur", "fa",
    "he", "uk", "cs", "km", "my", "bo", "kk", "mn", "ug",
];
pub const MAX_SELECTION_CHARS: u32 = 5000;
/// Maximum length of a single custom prompt (characters, not bytes).
const PROMPT_MAX_CHARS: usize = 4_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    pub picker: PickerSettings,
    pub provider: ProviderSettings,
    pub app: AppSettings,
    /// Region-screenshot preferences (`v4`).
    #[serde(default)]
    pub capture: CaptureSettings,
}

/// Screenshot settings. `region_shortcut` is stored in canonical form (see
/// [`normalize_shortcut`]) so the hotkey thread can parse it without surprises.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct CaptureSettings {
    pub region_shortcut: String,
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            region_shortcut: DEFAULT_REGION_SHORTCUT.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PickerSettings {
    pub enabled: bool,
    pub skills: Vec<String>,
    pub compact: bool,
    pub default_target_lang: String,
    pub blacklist: Vec<String>,
    pub max_chars: u32,
    /// One of [`SEARCH_ENGINES`]; used by the built-in `search` skill.
    pub search_engine: String,
    /// Remembered "pin panel" preference, restored when the picker opens.
    #[serde(default)]
    pub panel_pinned: bool,
    /// Panel sizing mode; one of [`PANEL_MODES`].
    #[serde(default = "default_panel_mode")]
    pub panel_mode: String,
    /// Built-in screenshot toolbar actions (order = toolbar order); a subset of
    /// [`CAPTURE_SKILLS`]. The screenshot skill itself is part of `skills`; these
    /// are the actions shown inside the capture overlay.
    #[serde(default = "default_capture_skills")]
    pub capture_skills: Vec<String>,
    #[serde(default)]
    pub prompts: PromptSettings,
    #[serde(default)]
    pub custom_skills: Vec<CustomSkill>,
}

/// A user-defined picker skill: the user picks an icon and a short label and
/// writes the prompt that is sent to the model. The prompt is required; custom
/// skills with an empty prompt are dropped during normalization.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct CustomSkill {
    /// Stable id generated by the UI, matching `^custom-[a-z0-9_-]{1,40}$`.
    pub id: String,
    /// Button caption, visible in the picker toolbar.
    pub label: String,
    /// Icon key matching `^[a-z0-9-]{1,40}$`; unknown keys fall back to
    /// [`CUSTOM_SKILL_DEFAULT_ICON`].
    pub icon: String,
    /// Input kind, one of [`CUSTOM_SKILL_KINDS`]: `text` acts on the selected
    /// text, `image` acts on a screenshot region. Defaults to `text`.
    #[serde(default = "default_custom_skill_kind")]
    pub kind: String,
    /// Model instruction; supports `{text}` `{target}` `{language}`
    /// `{program}` `{app}` placeholders.
    pub prompt: String,
}

impl Default for CustomSkill {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            icon: CUSTOM_SKILL_DEFAULT_ICON.to_string(),
            kind: default_custom_skill_kind(),
            prompt: String::new(),
        }
    }
}

/// Per-skill prompt overrides. An empty string means "use the system default";
/// the defaults are exposed to the UI through `StatePayload::prompt_defaults`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PromptSettings {
    pub translate: String,
    pub summarize: String,
    pub explain: String,
    pub polish: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderSettings {
    pub mode: String,
    pub online: OnlineSettings,
    pub local: LocalSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct OnlineSettings {
    pub preset: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub timeout_ms: u64,
    pub temperature: f64,
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct LocalSettings {
    pub context_size: u32,
    pub threads: u32,
    pub gpu_layers: u32,
    /// Legacy field kept for backwards-compatible settings files (no longer
    /// drives anything; the "remember last run" behavior uses `keep_running`).
    pub auto_start: bool,
    /// True while the local engine was started by the user. Persisted so the
    /// next app launch can restore the engine instead of asking the user to
    /// press 启动 again. Cleared by an explicit 停止 (but not by app exit).
    pub keep_running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub close_to_tray: bool,
    pub start_at_login: bool,
    pub theme: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            picker: PickerSettings::default(),
            provider: ProviderSettings::default(),
            app: AppSettings::default(),
            capture: CaptureSettings::default(),
        }
    }
}

impl Default for PickerSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            skills: SKILLS.iter().map(|skill| skill.to_string()).collect(),
            compact: false,
            default_target_lang: "auto".to_string(),
            blacklist: Vec::new(),
            max_chars: MAX_SELECTION_CHARS,
            search_engine: DEFAULT_SEARCH_ENGINE.to_string(),
            panel_pinned: false,
            panel_mode: default_panel_mode(),
            capture_skills: default_capture_skills(),
            prompts: PromptSettings::default(),
            custom_skills: Vec::new(),
        }
    }
}

impl Default for PromptSettings {
    fn default() -> Self {
        Self {
            translate: String::new(),
            summarize: String::new(),
            explain: String::new(),
            polish: String::new(),
        }
    }
}

impl Default for ProviderSettings {
    fn default() -> Self {
        Self {
            mode: "online".to_string(),
            online: OnlineSettings::default(),
            local: LocalSettings::default(),
        }
    }
}

impl Default for OnlineSettings {
    fn default() -> Self {
        Self {
            preset: "deepseek".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            api_key: String::new(),
            model: "deepseek-chat".to_string(),
            timeout_ms: 60_000,
            temperature: 0.2,
            max_tokens: 1024,
        }
    }
}

impl Default for LocalSettings {
    fn default() -> Self {
        Self {
            context_size: 4096,
            threads: 0,
            gpu_layers: 0,
            auto_start: true,
            keep_running: false,
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            start_at_login: false,
            theme: "system".to_string(),
        }
    }
}

impl Settings {
    pub fn is_local_mode(&self) -> bool {
        self.provider.mode == "local"
    }

    pub fn online_configured(&self) -> bool {
        !self.provider.online.base_url.trim().is_empty()
            && !self.provider.online.model.trim().is_empty()
    }

    /// Clamps every field into a sane range and drops unknown skills/languages.
    pub fn normalize(mut self) -> Self {
        // Migrate older files before validating. Version 1 shipped only the
        // original built-in skills; version 2 adds `polish` and `search`;
        // version 3 adds `screenshot`. New entries are appended after the
        // existing entries so enabled custom ids keep their original position
        // in the toolbar.
        if self.version < SETTINGS_VERSION {
            let mut existing: Vec<String> = self
                .picker
                .skills
                .iter()
                .map(|skill| skill.trim().to_ascii_lowercase())
                .collect();
            let mut new_skills: Vec<&str> = Vec::new();
            if self.version < 2 {
                new_skills.extend(["polish", "search"]);
            }
            if self.version < 3 {
                new_skills.push("screenshot");
            }
            for skill in new_skills {
                if !existing.iter().any(|current| current == skill) {
                    existing.push(skill.to_string());
                    self.picker.skills.push(skill.to_string());
                }
            }
        }

        // Custom skills are validated first: `picker.skills` may reference one
        // of their ids, and only validated ids may stay enabled.
        let mut custom_skills: Vec<CustomSkill> = Vec::new();
        for skill in &self.picker.custom_skills {
            if custom_skills.len() >= CUSTOM_SKILL_MAX {
                break;
            }
            let id = skill.id.trim().to_ascii_lowercase();
            if !is_valid_custom_skill_id(&id) || custom_skills.iter().any(|item| item.id == id) {
                continue;
            }
            let prompt = truncate(&skill.prompt, PROMPT_MAX_CHARS);
            // The prompt is what makes the skill useful: drop empty ones.
            if prompt.is_empty() {
                continue;
            }
            let mut label = truncate(&skill.label, CUSTOM_SKILL_LABEL_MAX_CHARS);
            if label.is_empty() {
                label = CUSTOM_SKILL_DEFAULT_LABEL.to_string();
            }
            let icon = {
                let icon = skill.icon.trim().to_ascii_lowercase();
                if is_valid_custom_skill_icon(&icon) {
                    icon
                } else {
                    CUSTOM_SKILL_DEFAULT_ICON.to_string()
                }
            };
            let kind = {
                let kind = skill.kind.trim().to_ascii_lowercase();
                if CUSTOM_SKILL_KINDS.contains(&kind.as_str()) {
                    kind
                } else {
                    default_custom_skill_kind()
                }
            };
            custom_skills.push(CustomSkill {
                id,
                label,
                icon,
                kind,
                prompt,
            });
        }
        self.picker.custom_skills = custom_skills;

        let mut skills: Vec<String> = Vec::new();
        for skill in &self.picker.skills {
            let skill = skill.trim().to_ascii_lowercase();
            let is_custom = self
                .picker
                .custom_skills
                .iter()
                .any(|custom| custom.id == skill);
            if (SKILLS.contains(&skill.as_str()) || is_custom) && !skills.contains(&skill) {
                skills.push(skill);
            }
        }
        self.picker.skills = if skills.is_empty() {
            SKILLS.iter().map(|skill| skill.to_string()).collect()
        } else {
            skills
        };
        self.picker.default_target_lang = {
            let value = self.picker.default_target_lang.to_ascii_lowercase();
            if TARGET_LANGS.contains(&value.as_str()) {
                value
            } else {
                "auto".to_string()
            }
        };
        let mut blacklist: Vec<String> = Vec::new();
        for entry in &self.picker.blacklist {
            let entry = truncate(entry, 120);
            if entry.is_empty() {
                continue;
            }
            if !blacklist
                .iter()
                .any(|existing| normalize_app_name(existing) == normalize_app_name(&entry))
            {
                blacklist.push(entry);
            }
            if blacklist.len() >= 200 {
                break;
            }
        }
        self.picker.blacklist = blacklist;
        self.picker.max_chars = self.picker.max_chars.clamp(100, 20_000);
        self.picker.search_engine = {
            let value = self.picker.search_engine.trim().to_ascii_lowercase();
            if SEARCH_ENGINES.contains(&value.as_str()) {
                value
            } else {
                DEFAULT_SEARCH_ENGINE.to_string()
            }
        };
        self.picker.panel_mode = {
            let value = self.picker.panel_mode.trim().to_ascii_lowercase();
            if PANEL_MODES.contains(&value.as_str()) {
                value
            } else {
                default_panel_mode()
            }
        };
        // Screenshot toolbar actions: drop unknown/duplicate ids, keep the
        // configured order. An explicit empty list means "no action buttons"
        // (the overlay then only offers 确认 / 取消); a settings file that never
        // had the field still gets the defaults through serde.
        let mut capture_skills: Vec<String> = Vec::new();
        for skill in &self.picker.capture_skills {
            let skill = skill.trim().to_ascii_lowercase();
            if CAPTURE_SKILLS.contains(&skill.as_str()) && !capture_skills.contains(&skill) {
                capture_skills.push(skill);
            }
        }
        self.picker.capture_skills = capture_skills;
        // Custom prompts are user-editable text: trim and cap them so a pasted
        // document cannot bloat settings.json or every request.
        self.picker.prompts.translate = truncate(&self.picker.prompts.translate, PROMPT_MAX_CHARS);
        self.picker.prompts.summarize = truncate(&self.picker.prompts.summarize, PROMPT_MAX_CHARS);
        self.picker.prompts.explain = truncate(&self.picker.prompts.explain, PROMPT_MAX_CHARS);
        self.picker.prompts.polish = truncate(&self.picker.prompts.polish, PROMPT_MAX_CHARS);

        self.provider.mode = if self.provider.mode == "local" {
            "local".to_string()
        } else {
            "online".to_string()
        };
        self.provider.online.base_url = truncate(&self.provider.online.base_url, 500);
        self.provider.online.api_key = truncate(&self.provider.online.api_key, 1000);
        self.provider.online.model = truncate(&self.provider.online.model, 200);
        self.provider.online.preset = truncate(&self.provider.online.preset, 40);
        if self.provider.online.preset.is_empty() {
            self.provider.online.preset = "custom".to_string();
        }
        self.provider.online.timeout_ms = self.provider.online.timeout_ms.clamp(5_000, 300_000);
        self.provider.online.temperature = self.provider.online.temperature.clamp(0.0, 1.0);
        self.provider.online.max_tokens = self.provider.online.max_tokens.clamp(64, 8192);

        self.provider.local.context_size = self.provider.local.context_size.clamp(1024, 32_768);
        self.provider.local.threads = self.provider.local.threads.min(128);
        self.provider.local.gpu_layers = self.provider.local.gpu_layers.min(200);

        if !["system", "light", "dark"].contains(&self.app.theme.as_str()) {
            self.app.theme = "system".to_string();
        }
        // Screenshot shortcut: any unsupported/empty value falls back to the
        // default so a hand-edited file can never leave the hotkey thread with
        // an unparseable combination.
        self.capture.region_shortcut = normalize_shortcut(&self.capture.region_shortcut);
        self.version = SETTINGS_VERSION;
        self
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

/// `true` for the stable ids the picker UI generates: the `custom-` prefix plus
/// 1–40 characters from `[a-z0-9_-]`. `Settings::normalize` trims and
/// lower-cases the id before validating it.
pub fn is_valid_custom_skill_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("custom-") else {
        return false;
    };
    let count = rest.chars().count();
    count >= 1
        && count <= CUSTOM_SKILL_ID_MAX_CHARS
        && rest.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '_' | '-')
        })
}

/// `true` for icon keys: 1–40 characters from `[a-z0-9-]`. The picker maps an
/// unknown-but-valid key to its default artwork, so users are not limited to
/// the built-in icon set.
pub fn is_valid_custom_skill_icon(icon: &str) -> bool {
    let count = icon.chars().count();
    count >= 1
        && count <= CUSTOM_SKILL_ICON_MAX_CHARS
        && icon.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

fn normalize_app_name(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .trim_end_matches(".exe")
        .to_string()
}

// ---------------------------------------------------------------------------
// Screenshot shortcut (v4)
// ---------------------------------------------------------------------------

/// Modifier flags of a screenshot shortcut.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ShortcutModifiers {
    pub win: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

/// Main key of a screenshot shortcut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutKey {
    /// A–Z (stored upper case).
    Letter(char),
    /// 0–9.
    Digit(u8),
    /// F1–F24.
    Function(u8),
    /// PrintScreen, Space, Tab, Enter, Esc, Backspace, Insert, Delete, Home,
    /// End, PageUp, PageDown, Up, Down, Left, Right.
    Named(&'static str),
}

impl ShortcutKey {
    /// Canonical display name, e.g. `X`, `7`, `F5`, `PrintScreen`.
    pub fn label(self) -> String {
        match self {
            ShortcutKey::Letter(value) => value.to_string(),
            ShortcutKey::Digit(value) => value.to_string(),
            ShortcutKey::Function(value) => format!("F{value}"),
            ShortcutKey::Named(name) => name.to_string(),
        }
    }
}

/// Parsed screenshot shortcut: at least one modifier plus exactly one main key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shortcut {
    pub modifiers: ShortcutModifiers,
    pub key: ShortcutKey,
}

impl Shortcut {
    /// Canonical form used by settings and the hotkey thread, e.g.
    /// `Win+Shift+X` or `Ctrl+Alt+P`.
    pub fn label(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if self.modifiers.win {
            parts.push("Win".to_string());
        }
        if self.modifiers.ctrl {
            parts.push("Ctrl".to_string());
        }
        if self.modifiers.alt {
            parts.push("Alt".to_string());
        }
        if self.modifiers.shift {
            parts.push("Shift".to_string());
        }
        parts.push(self.key.label());
        parts.join("+")
    }
}

/// Parses a user/renderer supplied shortcut. Returns `None` for anything that
/// is not "at least one modifier + exactly one supported main key".
pub fn parse_shortcut(raw: &str) -> Option<Shortcut> {
    if raw.trim().is_empty() {
        return None;
    }
    let mut modifiers = ShortcutModifiers::default();
    let mut key: Option<ShortcutKey> = None;
    for part in raw.split('+') {
        let token = part.trim().to_ascii_lowercase();
        if token.is_empty() {
            return None;
        }
        match token.as_str() {
            "win" | "windows" | "meta" | "super" | "cmd" => {
                modifiers.win = true;
                continue;
            }
            "ctrl" | "control" => {
                modifiers.ctrl = true;
                continue;
            }
            "alt" | "option" => {
                modifiers.alt = true;
                continue;
            }
            "shift" => {
                modifiers.shift = true;
                continue;
            }
            _ => {}
        }
        if key.is_some() {
            return None;
        }
        key = Some(parse_shortcut_key(&token)?);
    }
    let has_modifier = modifiers.win || modifiers.ctrl || modifiers.alt || modifiers.shift;
    if !has_modifier {
        return None;
    }
    Some(Shortcut {
        modifiers,
        key: key?,
    })
}

fn parse_shortcut_key(token: &str) -> Option<ShortcutKey> {
    let chars: Vec<char> = token.chars().collect();
    if chars.len() == 1 {
        let character = chars[0];
        if character.is_ascii_alphabetic() {
            return Some(ShortcutKey::Letter(character.to_ascii_uppercase()));
        }
        if character.is_ascii_digit() {
            return Some(ShortcutKey::Digit(character as u8 - b'0'));
        }
        return None;
    }
    if let Some(rest) = token.strip_prefix('f') {
        if let Ok(number) = rest.parse::<u8>() {
            if (1..=24).contains(&number) {
                return Some(ShortcutKey::Function(number));
            }
        }
    }
    named_shortcut_key(token).map(ShortcutKey::Named)
}

/// Canonical name of a named main key (aliases are accepted on input).
fn named_shortcut_key(token: &str) -> Option<&'static str> {
    let canonical = match token {
        "printscreen" | "print" | "prtsc" => "PrintScreen",
        "space" | "spacebar" => "Space",
        "tab" => "Tab",
        "enter" | "return" => "Enter",
        "esc" | "escape" => "Esc",
        "backspace" => "Backspace",
        "insert" | "ins" => "Insert",
        "delete" | "del" => "Delete",
        "home" => "Home",
        "end" => "End",
        "pageup" | "pgup" => "PageUp",
        "pagedown" | "pgdn" => "PageDown",
        "up" | "arrowup" => "Up",
        "down" | "arrowdown" => "Down",
        "left" | "arrowleft" => "Left",
        "right" | "arrowright" => "Right",
        _ => return None,
    };
    Some(canonical)
}

/// Normalizes a shortcut string; invalid values fall back to
/// [`DEFAULT_REGION_SHORTCUT`] so persistence and hotkey registration always
/// work with a canonical, parseable value.
pub fn normalize_shortcut(raw: &str) -> String {
    parse_shortcut(raw)
        .map(|shortcut| shortcut.label())
        .unwrap_or_else(|| DEFAULT_REGION_SHORTCUT.to_string())
}

/// Thread-safe settings holder with atomic persistence.
#[derive(Clone)]
pub struct SettingsStore {
    file: Arc<PathBuf>,
    inner: Arc<RwLock<Settings>>,
}

impl SettingsStore {
    pub fn load(file: PathBuf) -> Self {
        let settings = load_settings(&file).normalize();
        let store = Self {
            file: Arc::new(file),
            inner: Arc::new(RwLock::new(settings)),
        };
        let _ = store.persist(&store.get());
        store
    }

    pub fn get(&self) -> Settings {
        self.inner
            .read()
            .map(|settings| settings.clone())
            .unwrap_or_default()
    }

    pub fn file(&self) -> &Path {
        self.file.as_path()
    }

    /// Applies a partial JSON patch (camelCase keys) and persists the result.
    pub fn update_json(&self, patch: Value) -> Result<Settings, String> {
        if !patch.is_object() {
            return Err("设置补丁必须是 JSON 对象".to_string());
        }
        let current = serde_json::to_value(self.get()).map_err(|error| error.to_string())?;
        let mut merged = current;
        merge_value(&mut merged, &patch);
        let next: Settings =
            serde_json::from_value(merged).map_err(|error| format!("设置格式无效：{error}"))?;
        let next = next.normalize();
        self.persist(&next)?;
        if let Ok(mut guard) = self.inner.write() {
            *guard = next.clone();
        }
        Ok(next)
    }

    /// Restores every setting to its default **except** custom skill
    /// definitions: a reset must not silently delete a user's own skills or
    /// disable the ones they had enabled. Previously enabled custom ids are
    /// re-appended after the built-in defaults.
    pub fn reset(&self) -> Settings {
        let old = self.get();
        let mut next = Settings::default().normalize();
        next.picker.custom_skills = old.picker.custom_skills;
        for skill in &old.picker.skills {
            let id = skill.trim().to_ascii_lowercase();
            let is_known_custom = next
                .picker
                .custom_skills
                .iter()
                .any(|custom| custom.id == id);
            if is_known_custom && !next.picker.skills.contains(&id) {
                next.picker.skills.push(id);
            }
        }
        let _ = self.persist(&next);
        if let Ok(mut guard) = self.inner.write() {
            *guard = next.clone();
        }
        next
    }

    pub fn replace(&self, settings: Settings) {
        let next = settings.normalize();
        let _ = self.persist(&next);
        if let Ok(mut guard) = self.inner.write() {
            *guard = next;
        }
    }

    fn persist(&self, settings: &Settings) -> Result<(), String> {
        let json = serde_json::to_string_pretty(settings)
            .map_err(|error| format!("序列化设置失败：{error}"))?;
        let tmp = self.file.with_extension("json.tmp");
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建设置目录失败：{error}"))?;
        }
        fs::write(&tmp, json).map_err(|error| format!("写入设置失败：{error}"))?;
        fs::rename(&tmp, self.file.as_path()).map_err(|error| format!("保存设置失败：{error}"))
    }
}

fn load_settings(file: &Path) -> Settings {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(_) => return Settings::default(),
    };
    match serde_json::from_str::<Settings>(&text) {
        Ok(settings) => settings,
        Err(error) => {
            // Keep the broken file for debugging, then fall back to defaults.
            let _ = fs::rename(file, file.with_extension("json.broken"));
            eprintln!("settings.json 解析失败，已重置：{error}");
            Settings::default()
        }
    }
}

fn merge_value(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(base_map), Value::Object(patch_map)) => {
            for (key, value) in patch_map {
                if let Some(existing) = base_map.get_mut(key) {
                    merge_value(existing, value);
                } else {
                    base_map.insert(key.clone(), value.clone());
                }
            }
        }
        (base_slot, patch_value) => *base_slot = patch_value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> (SettingsStore, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().unwrap();
        let store = SettingsStore::load(dir.path().join("settings.json"));
        (store, dir)
    }

    #[test]
    fn all_supported_target_languages_are_accepted() {
        let mut languages = Vec::new();
        for code in TARGET_LANGS {
            let mut settings = Settings::default();
            settings.picker.default_target_lang = code.to_string();
            let normalized = settings.normalize();
            assert_eq!(normalized.picker.default_target_lang, code);
            if code != "auto" {
                languages.push(code);
            }
        }
        // Hy-MT2 supports 38 translation languages (33 + Chinese variants and
        // minority languages); auto is the extra default option.
        assert_eq!(languages.len(), 38);
        assert!(TARGET_LANGS.contains(&"zh-hant"));
        assert!(TARGET_LANGS.contains(&"yue"));
        assert!(TARGET_LANGS.contains(&"ug"));
    }

    #[test]
    fn local_keep_running_defaults_false_and_roundtrips() {
        let settings = Settings::default().normalize();
        assert!(!settings.provider.local.keep_running);
        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value["provider"]["local"]["keepRunning"], false);
        let loaded: Settings = serde_json::from_value(value).unwrap();
        assert!(!loaded.provider.local.keep_running);
        let (store, _dir) = store();
        let updated = store
            .update_json(json!({"provider": {"local": {"keepRunning": true}}}))
            .unwrap();
        assert!(updated.provider.local.keep_running);
        assert!(store.get().provider.local.keep_running);
    }

    #[test]
    fn defaults_are_normalized() {
        let settings = Settings::default().normalize();
        assert_eq!(settings.version, SETTINGS_VERSION);
        assert_eq!(settings.version, 4);
        let expected: Vec<String> = SKILLS.iter().map(|skill| skill.to_string()).collect();
        assert_eq!(settings.picker.skills, expected);
        assert_eq!(settings.picker.skills.len(), 8);
        assert_eq!(settings.picker.search_engine, "google");
        assert!(!settings.picker.panel_pinned);
        assert_eq!(settings.picker.panel_mode, "auto");
        assert_eq!(settings.provider.mode, "online");
        assert!(settings.app.close_to_tray);
    }

    #[test]
    fn panel_mode_defaults_to_auto_and_normalizes_invalid_values() {
        let settings = Settings::default().normalize();
        assert_eq!(settings.picker.panel_mode, "auto");
        // camelCase serialization and JSON round-trip.
        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value["picker"]["panelMode"], "auto");
        let parsed: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.picker.panel_mode, "auto");
        assert_eq!(default_panel_mode(), "auto");

        for (input, expected) in [
            ("auto", "auto"),
            ("scroll", "scroll"),
            ("SCROLL", "scroll"),
            ("  auto  ", "auto"),
            ("fixed", "auto"),
            ("", "auto"),
        ] {
            let mut settings = Settings::default();
            settings.picker.panel_mode = input.to_string();
            assert_eq!(
                settings.normalize().picker.panel_mode,
                expected,
                "wrong mode for {input:?}"
            );
        }

        // Persisted through the settings patch path (camelCase key).
        let (store, dir) = store();
        let updated = store
            .update_json(json!({ "picker": { "panelMode": "scroll" } }))
            .unwrap();
        assert_eq!(updated.picker.panel_mode, "scroll");
        let reloaded = SettingsStore::load(dir.path().join("settings.json"));
        assert_eq!(reloaded.get().picker.panel_mode, "scroll");

        // Invalid persisted values fall back to auto on save/load.
        let invalid = store
            .update_json(json!({ "picker": { "panelMode": "hack" } }))
            .unwrap();
        assert_eq!(invalid.picker.panel_mode, "auto");
    }

    #[test]
    fn panel_pinned_defaults_false_and_roundtrips() {
        let settings = Settings::default().normalize();
        assert!(!settings.picker.panel_pinned);
        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value["picker"]["panelPinned"], false);
        let parsed: Settings = serde_json::from_value(value).unwrap();
        assert!(!parsed.picker.panel_pinned);

        // The pin preference is persisted through the normal settings patch path.
        let (store, dir) = store();
        let updated = store
            .update_json(json!({ "picker": { "panelPinned": true } }))
            .unwrap();
        assert!(updated.picker.panel_pinned);
        let reloaded = SettingsStore::load(dir.path().join("settings.json"));
        assert!(reloaded.get().picker.panel_pinned);

        let cleared = store
            .update_json(json!({ "picker": { "panelPinned": false } }))
            .unwrap();
        assert!(!cleared.picker.panel_pinned);
    }

    #[test]
    fn patch_merges_and_persists() {
        let (store, dir) = store();
        let updated = store
            .update_json(json!({
                "picker": { "enabled": false, "blacklist": ["WeChat", "wechat.exe"] },
                "provider": { "online": { "model": "gpt-4o-mini", "apiKey": "sk-test" } }
            }))
            .unwrap();
        assert!(!updated.picker.enabled);
        assert_eq!(updated.picker.blacklist.len(), 1);
        assert_eq!(updated.provider.online.model, "gpt-4o-mini");
        let reloaded = SettingsStore::load(dir.path().join("settings.json"));
        assert_eq!(reloaded.get().provider.online.api_key, "sk-test");
    }

    #[test]
    fn clamps_malformed_values() {
        let (store, _dir) = store();
        let updated = store
            .update_json(json!({
                "picker": { "skills": ["translate", "translate", "hack"], "maxChars": 999999 },
                "provider": { "mode": "nonsense", "online": { "timeoutMs": 1, "temperature": 7 } }
            }))
            .unwrap();
        assert_eq!(updated.picker.skills, vec!["translate".to_string()]);
        assert_eq!(updated.picker.max_chars, 20_000);
        assert_eq!(updated.provider.mode, "online");
        assert_eq!(updated.provider.online.timeout_ms, 5_000);
        assert_eq!(updated.provider.online.temperature, 1.0);
    }

    #[test]
    fn unknown_keys_are_dropped() {
        let (store, _dir) = store();
        let updated = store
            .update_json(json!({ "picker": { "unknown": true } }))
            .unwrap();
        assert!(!serde_json::to_value(updated)
            .unwrap()
            .get("picker")
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("unknown"));
    }

    #[test]
    fn prompt_overrides_default_to_empty() {
        let settings = Settings::default().normalize();
        assert_eq!(settings.picker.prompts, PromptSettings::default());
        let value = serde_json::to_value(settings).unwrap();
        assert_eq!(
            value["picker"]["prompts"],
            json!({ "translate": "", "summarize": "", "explain": "", "polish": "" })
        );
        assert_eq!(value["picker"]["searchEngine"], "google");
        assert_eq!(value["version"], SETTINGS_VERSION);
    }

    #[test]
    fn prompt_overrides_are_trimmed_and_truncated() {
        let (store, dir) = store();
        let too_long = "x".repeat(PROMPT_MAX_CHARS + 1);
        let updated = store
            .update_json(json!({
                "picker": {
                    "prompts": {
                        "translate": format!("  {too_long}  "),
                        "summarize": "  用一句话总结  ",
                        "explain": "",
                        "polish": "  润色得更自然  "
                    }
                }
            }))
            .unwrap();
        assert_eq!(
            updated.picker.prompts.translate.chars().count(),
            PROMPT_MAX_CHARS
        );
        assert!(!updated.picker.prompts.translate.starts_with(' '));
        assert_eq!(updated.picker.prompts.summarize, "用一句话总结");
        assert_eq!(updated.picker.prompts.explain, "");
        assert_eq!(updated.picker.prompts.polish, "润色得更自然");
        let reloaded = SettingsStore::load(dir.path().join("settings.json"));
        assert_eq!(
            reloaded.get().picker.prompts.translate.chars().count(),
            PROMPT_MAX_CHARS
        );
    }

    #[test]
    fn prompt_overrides_deserialize_from_json() {
        let settings: Settings = serde_json::from_str(
            r#"{
                "picker": {
                    "prompts": {
                        "translate": "Translate into {target}.",
                        "summarize": "Summarize briefly.",
                        "explain": "Explain simply."
                    }
                }
            }"#,
        )
        .unwrap();
        assert_eq!(
            settings.picker.prompts.translate,
            "Translate into {target}."
        );
        assert_eq!(settings.picker.prompts.summarize, "Summarize briefly.");
        assert_eq!(settings.picker.prompts.explain, "Explain simply.");
    }

    #[test]
    fn custom_skill_ids_follow_the_ui_contract() {
        for valid in [
            "custom-a",
            "custom-1",
            "custom-a_b-c",
            "custom-deepseek",
            "custom-0123456789abcdefghij",
        ] {
            assert!(is_valid_custom_skill_id(valid), "should accept {valid:?}");
        }
        let longest = format!("custom-{}", "a".repeat(CUSTOM_SKILL_ID_MAX_CHARS));
        assert!(is_valid_custom_skill_id(&longest));
        let too_long = format!("custom-{}", "a".repeat(CUSTOM_SKILL_ID_MAX_CHARS + 1));
        for invalid in [
            "",
            "custom-",
            "custom-a b",
            "custom-a.b",
            "custom-中文",
            "Custom-A",
            "skill-a",
            "custom_a",
            too_long.as_str(),
        ] {
            assert!(
                !is_valid_custom_skill_id(invalid),
                "should reject {invalid:?}"
            );
        }
    }

    #[test]
    fn custom_skills_are_normalized() {
        let long_label = "x".repeat(CUSTOM_SKILL_LABEL_MAX_CHARS + 5);
        let long_prompt = "p".repeat(PROMPT_MAX_CHARS + 10);
        let mut settings = Settings::default();
        settings.picker.custom_skills = vec![
            CustomSkill {
                id: "  CUSTOM-Test-1  ".to_string(),
                label: format!("  {long_label}  "),
                icon: "dragon".to_string(),
                kind: default_custom_skill_kind(),
                prompt: "  Translate {text} into {target}.  ".to_string(),
            },
            CustomSkill {
                id: "custom-empty-prompt".to_string(),
                label: "空提示词".to_string(),
                icon: "star".to_string(),
                kind: default_custom_skill_kind(),
                prompt: "   ".to_string(),
            },
            CustomSkill {
                id: "skill-invalid".to_string(),
                label: "非法".to_string(),
                icon: "star".to_string(),
                kind: default_custom_skill_kind(),
                prompt: "prompt".to_string(),
            },
            CustomSkill {
                id: "custom-test-1".to_string(),
                label: "重复".to_string(),
                icon: "star".to_string(),
                kind: default_custom_skill_kind(),
                prompt: "prompt".to_string(),
            },
            CustomSkill {
                id: "custom-defaults".to_string(),
                label: "   ".to_string(),
                icon: String::new(),
                kind: default_custom_skill_kind(),
                prompt: "  Some prompt  ".to_string(),
            },
            CustomSkill {
                id: "custom-long-prompt".to_string(),
                label: "长提示词".to_string(),
                icon: " WAND ".to_string(),
                kind: default_custom_skill_kind(),
                prompt: long_prompt,
            },
        ];

        let normalized = settings.normalize();
        let skills = &normalized.picker.custom_skills;
        assert_eq!(skills.len(), 3, "skills: {skills:?}");

        assert_eq!(skills[0].id, "custom-test-1");
        assert_eq!(
            skills[0].label.chars().count(),
            CUSTOM_SKILL_LABEL_MAX_CHARS
        );
        // Any key matching `^[a-z0-9-]{1,40}$` is kept, even outside the
        // built-in icon set.
        assert_eq!(skills[0].icon, "dragon");
        assert_eq!(skills[0].prompt, "Translate {text} into {target}.");

        assert_eq!(skills[1].id, "custom-defaults");
        assert_eq!(skills[1].label, CUSTOM_SKILL_DEFAULT_LABEL);
        assert_eq!(skills[1].icon, CUSTOM_SKILL_DEFAULT_ICON);
        assert_eq!(skills[1].prompt, "Some prompt");

        assert_eq!(skills[2].id, "custom-long-prompt");
        assert_eq!(skills[2].icon, "wand");
        assert_eq!(skills[2].prompt.chars().count(), PROMPT_MAX_CHARS);
        // Custom ids are not enabled by default; the built-in list is kept.
        assert_eq!(normalized.picker.skills.len(), SKILLS.len());
    }

    #[test]
    fn custom_skills_are_capped_at_twenty() {
        let mut settings = Settings::default();
        settings.picker.custom_skills = (0..25)
            .map(|index| CustomSkill {
                id: format!("custom-{index}"),
                label: format!("技能{index}"),
                icon: "star".to_string(),
                kind: default_custom_skill_kind(),
                prompt: "prompt".to_string(),
            })
            .collect();
        let normalized = settings.normalize();
        assert_eq!(normalized.picker.custom_skills.len(), CUSTOM_SKILL_MAX);
        assert_eq!(
            normalized.picker.custom_skills[0].id,
            format!("custom-{}", 0)
        );
    }

    #[test]
    fn picker_skills_keep_validated_custom_ids() {
        let (store, _dir) = store();
        let updated = store
            .update_json(json!({
                "picker": {
                    "skills": [
                        "translate",
                        "custom-abc",
                        "custom-abc",
                        "hack",
                        "custom-missing",
                        "CUSTOM-ABC"
                    ],
                    "customSkills": [{
                        "id": "custom-abc",
                        "label": "缩写",
                        "icon": "list",
                        "prompt": "Summarize: {text}"
                    }]
                }
            }))
            .unwrap();
        assert_eq!(
            updated.picker.skills,
            vec!["translate".to_string(), "custom-abc".to_string()]
        );
        assert_eq!(updated.picker.custom_skills.len(), 1);
        assert_eq!(updated.picker.custom_skills[0].id, "custom-abc");
    }

    #[test]
    fn disabled_custom_skills_stay_defined_but_not_enabled() {
        let (store, _dir) = store();
        let updated = store
            .update_json(json!({
                "picker": {
                    "skills": ["translate"],
                    "customSkills": [{
                        "id": "custom-code",
                        "label": "解释代码",
                        "icon": "code",
                        "prompt": "Explain this code: {text}"
                    }]
                }
            }))
            .unwrap();
        assert_eq!(updated.picker.skills, vec!["translate".to_string()]);
        assert_eq!(updated.picker.custom_skills.len(), 1);
        assert_eq!(updated.picker.custom_skills[0].icon, "code");
    }

    #[test]
    fn custom_skills_serialize_as_camel_case() {
        let mut settings = Settings::default();
        settings.picker.custom_skills = vec![CustomSkill {
            id: "custom-x".to_string(),
            label: "解释".to_string(),
            icon: "book".to_string(),
            kind: default_custom_skill_kind(),
            prompt: "{text}".to_string(),
        }];
        let value = serde_json::to_value(&settings).unwrap();
        let custom = &value["picker"]["customSkills"][0];
        assert_eq!(custom["id"], "custom-x");
        assert_eq!(custom["label"], "解释");
        assert_eq!(custom["icon"], "book");
        assert_eq!(custom["prompt"], "{text}");
        // camelCase round-trips through JSON.
        let parsed: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(parsed, settings);
    }

    #[test]
    fn custom_skills_deserialize_from_json() {
        let settings: Settings = serde_json::from_str(
            r#"{
                "picker": {
                    "customSkills": [{
                        "id": "custom-json",
                        "label": "JSON",
                        "icon": "lightbulb",
                        "prompt": "Explain {text}"
                    }]
                }
            }"#,
        )
        .unwrap();
        assert_eq!(settings.picker.custom_skills.len(), 1);
        assert_eq!(settings.picker.custom_skills[0].id, "custom-json");
        assert_eq!(settings.picker.custom_skills[0].icon, "lightbulb");
    }

    #[test]
    fn version_one_settings_migrate_on_load() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("settings.json");
        std::fs::write(
            &file,
            r#"{
                "version": 1,
                "picker": {
                    "skills": ["translate", "summarize", "explain", "read", "copy", "custom-abc"],
                    "customSkills": [{
                        "id": "custom-abc",
                        "label": "缩写",
                        "icon": "rocket",
                        "prompt": "Summarize: {text}"
                    }]
                }
            }"#,
        )
        .unwrap();

        let store = SettingsStore::load(file);
        let settings = store.get();
        assert_eq!(settings.version, SETTINGS_VERSION);
        // The new built-ins are appended after the old entries; the enabled
        // custom skill keeps its position and is not lost.
        assert_eq!(
            settings.picker.skills,
            vec![
                "translate",
                "summarize",
                "explain",
                "read",
                "copy",
                "custom-abc",
                "polish",
                "search",
                "screenshot"
            ]
        );
        assert_eq!(settings.picker.custom_skills.len(), 1);
        assert_eq!(settings.picker.custom_skills[0].icon, "rocket");
        // The migrated settings are persisted back to disk.
        let reloaded = SettingsStore::load(dir.path().join("settings.json"));
        assert_eq!(reloaded.get(), settings);
    }

    #[test]
    fn migration_skips_skills_that_already_exist() {
        let mut settings = Settings::default();
        settings.version = 1;
        settings.picker.skills = vec![
            "translate".to_string(),
            "polish".to_string(),
            "custom-x".to_string(),
        ];
        settings.picker.custom_skills = vec![CustomSkill {
            id: "custom-x".to_string(),
            label: "自定义".to_string(),
            icon: "star".to_string(),
            kind: default_custom_skill_kind(),
            prompt: "prompt".to_string(),
        }];

        let migrated = settings.normalize();
        assert_eq!(migrated.version, SETTINGS_VERSION);
        assert_eq!(
            migrated.picker.skills,
            vec!["translate", "polish", "custom-x", "search", "screenshot"]
        );
        // Idempotent: a second pass changes nothing.
        assert_eq!(migrated.clone().normalize(), migrated);
    }

    #[test]
    fn version_two_settings_gain_the_screenshot_skill() {
        let mut settings = Settings::default();
        settings.version = 2;
        settings.picker.skills = SKILLS
            .iter()
            .filter(|skill| **skill != "screenshot")
            .map(|skill| skill.to_string())
            .collect();

        let migrated = settings.normalize();
        assert_eq!(migrated.version, SETTINGS_VERSION);
        // Version 3 only appends the new built-in; settings that already list
        // it are left untouched (covered by the idempotency check below).
        let mut expected: Vec<String> = SKILLS
            .iter()
            .filter(|skill| **skill != "screenshot")
            .map(|skill| skill.to_string())
            .collect();
        expected.push("screenshot".to_string());
        assert_eq!(migrated.picker.skills, expected);
        assert_eq!(
            migrated
                .picker
                .skills
                .iter()
                .filter(|skill| *skill == "screenshot")
                .count(),
            1
        );
        // Idempotent: a second pass changes nothing.
        assert_eq!(migrated.clone().normalize(), migrated);
    }

    #[test]
    fn custom_skill_kind_defaults_to_text() {
        assert_eq!(CustomSkill::default().kind, "text");
        assert_eq!(default_custom_skill_kind(), "text");

        // Old settings.json files have no `kind`: they deserialize as `text`.
        let settings: Settings = serde_json::from_str(
            r#"{
                "picker": {
                    "customSkills": [{
                        "id": "custom-old",
                        "label": "旧技能",
                        "icon": "star",
                        "prompt": "Explain {text}"
                    }]
                }
            }"#,
        )
        .unwrap();
        assert_eq!(settings.picker.custom_skills[0].kind, "text");
    }

    #[test]
    fn custom_skill_kind_normalizes_to_text_or_image() {
        fn normalize_kind(kind: &str) -> String {
            let mut settings = Settings::default();
            settings.picker.custom_skills = vec![CustomSkill {
                id: "custom-kind".to_string(),
                label: "类型".to_string(),
                icon: "star".to_string(),
                kind: kind.to_string(),
                prompt: "prompt".to_string(),
            }];
            settings.normalize().picker.custom_skills[0].kind.clone()
        }

        assert_eq!(normalize_kind("text"), "text");
        assert_eq!(normalize_kind("image"), "image");
        assert_eq!(normalize_kind(" IMAGE "), "image");
        for invalid in ["", "   ", "video", "audio", "图片"] {
            assert_eq!(
                normalize_kind(invalid),
                "text",
                "wrong fallback for {invalid:?}"
            );
        }

        // camelCase serialization and JSON round-trip.
        let mut settings = Settings::default();
        settings.picker.custom_skills = vec![CustomSkill {
            id: "custom-image".to_string(),
            label: "截图解释".to_string(),
            icon: "scan-eye".to_string(),
            kind: "image".to_string(),
            prompt: "解释图片".to_string(),
        }];
        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value["picker"]["customSkills"][0]["kind"], "image");
        let parsed: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.picker.custom_skills[0].kind, "image");
    }

    #[test]
    fn search_engine_falls_back_to_google() {
        for (input, expected) in [
            ("google", "google"),
            ("baidu", "baidu"),
            ("BING", "bing"),
            ("duckduckgo", "google"),
            ("", "google"),
        ] {
            let mut settings = Settings::default();
            settings.picker.search_engine = input.to_string();
            assert_eq!(
                settings.normalize().picker.search_engine,
                expected,
                "wrong engine for {input:?}"
            );
        }
        let mut settings = Settings::default();
        settings.picker.search_engine = "baidu".to_string();
        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value["picker"]["searchEngine"], "baidu");
        let parsed: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.picker.search_engine, "baidu");
    }

    #[test]
    fn custom_skill_icons_follow_the_generic_rule() {
        fn normalize_icon(icon: &str) -> String {
            let mut settings = Settings::default();
            settings.picker.custom_skills = vec![CustomSkill {
                id: "custom-icon".to_string(),
                label: "图标".to_string(),
                icon: icon.to_string(),
                kind: default_custom_skill_kind(),
                prompt: "prompt".to_string(),
            }];
            settings.normalize().picker.custom_skills[0].icon.clone()
        }

        // Any key matching `^[a-z0-9-]{1,40}$` is kept, not only the 12
        // built-in icon names.
        assert_eq!(normalize_icon("rocket"), "rocket");
        assert_eq!(normalize_icon("badge-check"), "badge-check");
        assert_eq!(normalize_icon(" Rocket "), "rocket");
        let longest = "a".repeat(CUSTOM_SKILL_ICON_MAX_CHARS);
        assert_eq!(normalize_icon(&longest), longest);
        // Empty or invalid keys fall back to the default icon.
        for invalid in [
            "",
            "   ",
            "rocket_ship",
            "rocket ship",
            "图标",
            "Rocket.Ship",
        ] {
            assert_eq!(
                normalize_icon(invalid),
                CUSTOM_SKILL_DEFAULT_ICON,
                "wrong fallback for {invalid:?}"
            );
        }
        let too_long = "a".repeat(CUSTOM_SKILL_ICON_MAX_CHARS + 1);
        assert_eq!(normalize_icon(&too_long), CUSTOM_SKILL_DEFAULT_ICON);
    }

    #[test]
    fn reset_keeps_custom_skills_and_their_enabled_state() {
        let (store, dir) = store();
        store
            .update_json(json!({
                "picker": {
                    "skills": ["translate", "custom-keep"],
                    "customSkills": [
                        {
                            "id": "custom-keep",
                            "label": "保留技能",
                            "icon": "rocket",
                            "prompt": "Explain {text}"
                        },
                        {
                            "id": "custom-off",
                            "label": "未启用技能",
                            "icon": "star",
                            "prompt": "Summarize {text}"
                        }
                    ],
                    "compact": true,
                    "blacklist": ["WeChat"],
                    "searchEngine": "baidu",
                    "prompts": { "polish": "润色得更自然" }
                },
                "provider": { "online": { "model": "gpt-4o-mini" } }
            }))
            .unwrap();

        let reset = store.reset();
        assert_eq!(reset.version, SETTINGS_VERSION);
        // Custom skill definitions survive the reset...
        assert_eq!(reset.picker.custom_skills.len(), 2);
        assert_eq!(reset.picker.custom_skills[0].id, "custom-keep");
        assert_eq!(reset.picker.custom_skills[1].id, "custom-off");
        // ...and so does the enabled state, appended after the built-ins.
        let mut expected: Vec<String> = SKILLS.iter().map(|skill| skill.to_string()).collect();
        expected.push("custom-keep".to_string());
        assert_eq!(reset.picker.skills, expected);
        assert!(!reset.picker.skills.contains(&"custom-off".to_string()));
        // Everything else goes back to defaults.
        assert!(!reset.picker.compact);
        assert!(reset.picker.blacklist.is_empty());
        assert_eq!(reset.picker.search_engine, DEFAULT_SEARCH_ENGINE);
        assert_eq!(reset.picker.prompts.polish, "");
        assert_eq!(reset.provider.online.model, "deepseek-chat");
        // The reset state is persisted, not only kept in memory.
        let reloaded = SettingsStore::load(dir.path().join("settings.json"));
        assert_eq!(reloaded.get(), reset);
    }

    #[test]
    fn capture_shortcut_defaults_and_roundtrips() {
        let settings = Settings::default().normalize();
        assert_eq!(settings.capture.region_shortcut, DEFAULT_REGION_SHORTCUT);
        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value["capture"]["regionShortcut"], "Win+Shift+X");

        // Older files (without the capture block) load the default.
        let parsed: Settings = serde_json::from_value(json!({"version": 3})).unwrap();
        let normalized = parsed.normalize();
        assert_eq!(normalized.capture.region_shortcut, DEFAULT_REGION_SHORTCUT);

        // The patch path normalizes and persists the new shortcut.
        let (store, dir) = store();
        let updated = store
            .update_json(json!({ "capture": { "regionShortcut": "ctrl + alt + p" } }))
            .unwrap();
        assert_eq!(updated.capture.region_shortcut, "Ctrl+Alt+P");
        let reloaded = SettingsStore::load(dir.path().join("settings.json"));
        assert_eq!(reloaded.get().capture.region_shortcut, "Ctrl+Alt+P");
    }

    #[test]
    fn shortcut_normalization_accepts_supported_combinations() {
        assert_eq!(normalize_shortcut("win+shift+x"), "Win+Shift+X");
        assert_eq!(normalize_shortcut("WIN + SHIFT + X"), "Win+Shift+X");
        assert_eq!(normalize_shortcut("ctrl+alt+p"), "Ctrl+Alt+P");
        assert_eq!(normalize_shortcut("Ctrl+Ctrl+Q"), "Ctrl+Q");
        assert_eq!(
            normalize_shortcut("Shift+Alt+Control+Meta+A"),
            "Win+Ctrl+Alt+Shift+A"
        );
        assert_eq!(normalize_shortcut("Ctrl+Shift+F12"), "Ctrl+Shift+F12");
        assert_eq!(normalize_shortcut("Win+PrintScreen"), "Win+PrintScreen");
        assert_eq!(normalize_shortcut("Ctrl+Alt+Space"), "Ctrl+Alt+Space");
        assert_eq!(normalize_shortcut("alt+pageup"), "Alt+PageUp");
        assert_eq!(normalize_shortcut("win+1"), "Win+1");
        assert_eq!(
            parse_shortcut("Win+Shift+X").unwrap().key,
            ShortcutKey::Letter('X')
        );
        assert_eq!(
            parse_shortcut("Ctrl+F5").unwrap().key,
            ShortcutKey::Function(5)
        );
        assert_eq!(
            parse_shortcut("Ctrl+Delete").unwrap().key,
            ShortcutKey::Named("Delete")
        );
    }

    #[test]
    fn capture_skills_are_normalized_and_keep_their_order() {
        let settings = Settings::default().normalize();
        assert_eq!(
            settings.picker.capture_skills,
            vec![
                "copy".to_string(),
                "ocr".to_string(),
                "translate".to_string(),
                "explain".to_string()
            ]
        );

        let (store, dir) = store();
        let updated = store
            .update_json(json!({ "picker": { "captureSkills": ["explain", "ocr", "explain", "hack", "copy"] } }))
            .unwrap();
        assert_eq!(
            updated.picker.capture_skills,
            vec!["explain".to_string(), "ocr".to_string(), "copy".to_string()]
        );
        let reloaded = SettingsStore::load(dir.path().join("settings.json"));
        assert_eq!(
            reloaded.get().picker.capture_skills,
            vec!["explain".to_string(), "ocr".to_string(), "copy".to_string()]
        );

        // An explicit empty list disables every toolbar action (the overlay
        // still offers 确认 / 取消).
        let cleared = store
            .update_json(json!({ "picker": { "captureSkills": [] } }))
            .unwrap();
        assert!(cleared.picker.capture_skills.is_empty());

        // Older settings files (without the field) load the defaults.
        let parsed: Settings = serde_json::from_value(json!({ "version": 4 })).unwrap();
        assert_eq!(parsed.normalize().picker.capture_skills.len(), 4);
    }

    #[test]
    fn shortcut_normalization_rejects_invalid_combinations() {
        for raw in [
            "",
            "   ",
            "X",              // no modifier
            "Win",            // modifier only
            "Ctrl+Shift",     // modifier only
            "Ctrl+Shift+",    // empty token
            "Ctrl+Shift+Foo", // unsupported key
            "Ctrl+Shift+F25",
            "Ctrl+Shift+Alt+A+B", // two main keys
        ] {
            assert_eq!(
                normalize_shortcut(raw),
                DEFAULT_REGION_SHORTCUT,
                "raw={raw:?}"
            );
            assert!(parse_shortcut(raw).is_none(), "raw={raw:?}");
        }
    }
}
