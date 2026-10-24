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

pub const SKILLS: [&str; 5] = ["translate", "summarize", "explain", "read", "copy"];
pub const TARGET_LANGS: [&str; 9] = ["auto", "zh", "en", "ja", "de", "fr", "es", "ru", "ko"];
pub const DEFAULT_SHORTCUT: &str = "Ctrl+Shift+D";
pub const MAX_SELECTION_CHARS: u32 = 5000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    pub picker: PickerSettings,
    pub provider: ProviderSettings,
    pub app: AppSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PickerSettings {
    pub enabled: bool,
    pub shortcut: String,
    pub skills: Vec<String>,
    pub compact: bool,
    pub default_target_lang: String,
    pub blacklist: Vec<String>,
    pub max_chars: u32,
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
    pub model_file: String,
    pub context_size: u32,
    pub threads: u32,
    pub gpu_layers: u32,
    pub auto_start: bool,
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
            version: 1,
            picker: PickerSettings::default(),
            provider: ProviderSettings::default(),
            app: AppSettings::default(),
        }
    }
}

impl Default for PickerSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            shortcut: DEFAULT_SHORTCUT.to_string(),
            skills: SKILLS.iter().map(|skill| skill.to_string()).collect(),
            compact: false,
            default_target_lang: "auto".to_string(),
            blacklist: Vec::new(),
            max_chars: MAX_SELECTION_CHARS,
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
            model_file: String::new(),
            context_size: 4096,
            threads: 0,
            gpu_layers: 0,
            auto_start: true,
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
        self.version = 1;

        self.picker.shortcut = truncate(&self.picker.shortcut, 120);
        if self.picker.shortcut.trim().is_empty() {
            self.picker.shortcut = DEFAULT_SHORTCUT.to_string();
        }
        self.picker.shortcut = self.picker.shortcut.replace("CommandOrControl", "Ctrl");
        let mut skills: Vec<String> = Vec::new();
        for skill in &self.picker.skills {
            let skill = skill.trim().to_ascii_lowercase();
            if SKILLS.contains(&skill.as_str()) && !skills.contains(&skill) {
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

        self.provider.local.model_file =
            truncate(&self.provider.local.model_file, 260).replace(['\\', '/'], "");
        self.provider.local.context_size = self.provider.local.context_size.clamp(1024, 32_768);
        self.provider.local.threads = self.provider.local.threads.min(128);
        self.provider.local.gpu_layers = self.provider.local.gpu_layers.min(200);

        if !["system", "light", "dark"].contains(&self.app.theme.as_str()) {
            self.app.theme = "system".to_string();
        }
        self
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

fn normalize_app_name(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .trim_end_matches(".exe")
        .to_string()
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

    pub fn reset(&self) -> Settings {
        let next = Settings::default().normalize();
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
    fn defaults_are_normalized() {
        let settings = Settings::default().normalize();
        assert_eq!(settings.picker.skills.len(), 5);
        assert_eq!(settings.provider.mode, "online");
        assert!(settings.app.close_to_tray);
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
}
