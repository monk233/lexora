# R1 多语言与本地语言输出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 界面支持中英双语，首次启动按系统区域/时区自动选择本地语言，并让 AI 默认以本地语言输出（翻译目标 auto、解释/总结/词条/追问的语言）。

**Architecture:** Rust 侧新增 `locale` 模块负责系统区域与时区检测，`app.language`（`system|zh|en`）持久化到 settings schema v9；`StatePayload.app` 暴露有效语言。前端新增无构建的 `web/shared/i18n.js` 与 `messages.{zh,en}.js` 语言包，通过 `data-i18n` 与 `LP.t()` 迁移各窗口文案；页面在 `get_state` 返回后调用 `LP.i18n.setLocale()`。AI 侧把固定中文的输出语言改为 `{answer}` 占位符，由设置中的有效语言决定；`auto` 目标语言改为「本地语言优先」。

**Tech Stack:** Tauri v2（Rust）、无构建静态 HTML/CSS/JS、`windows` crate 0.62（`Win32_Globalization`、`Win32_System_Time`）、`node:test` 前端测试、`cargo test`。

## Global Constraints

- 首批支持语言：简体中文 `zh` 与英文 `en`。繁体中文、日语等不在 R1 范围；`zh-Hant` 等区域先回退到 `zh`。
- 设置字段固定为 `app.language`，取值仅允许 `"system" | "zh" | "en"`；默认 `"system"`。
- settings schema 从 8 升到 **9**；迁移只补默认字段，清空或改写历史用户数据一律禁止。
- 提示词模板保持英文（模型遵循更稳定），但输出语言必须由 `{answer}` 占位符驱动；`{target}` / `{language}` 的既有语义不变。
- 前端不得引入构建步骤与 CDN：语言资源作为普通 `<script>` 加载，随 Tauri 资源打包。
- 所有用户可见文案必须来自语言包；代码注释、日志、正则与 `data-*` 键名可保留中文。
- 默认语言回退顺序：用户选择 → 系统区域 → 时区映射 → `en`。
- 不在本计划内：Rare UI、历史记录、快速聊天、网页翻译。
- 每个任务结束必须通过该任务列出的测试命令；提交信息使用 conventional commits（`feat:` / `test:` / `docs:`）。

## File Structure

新增：

- `src-tauri/src/locale.rs` — 系统区域/时区检测、语言映射、有效语言解析（纯函数 + 系统探测）。
- `web/shared/i18n.js` — i18n 框架：`LP.t`、`LP.i18n.init/setLocale/applyStatic`、首屏占位处理。
- `web/shared/messages.zh.js` — 简体中文字符串表（挂在 `LP.messages.zh`）。
- `web/shared/messages.en.js` — 英文字符串表（挂在 `LP.messages.en`）。
- `web/i18n.test.cjs` — i18n 框架与语言包的 node 测试。
- `docs/superpowers/plans/2026-10-29-r1-localization.md` — 本计划。

修改：

- `src-tauri/Cargo.toml` — 增加 `windows` features。
- `src-tauri/src/main.rs` — `mod locale;` 与启动日志。
- `src-tauri/src/settings.rs` — `AppSettings.language`、schema 9、`effective_language()`、测试。
- `src-tauri/src/commands.rs` — `AppInfo.locale` / `language_setting`。
- `src-tauri/src/engine/prompts.rs` — `{answer}` 模板、`answer_language` 参数、suggestion 语言、auto 目标。
- `src-tauri/src/engine.rs` — 提示词/目标语言调用点。
- `src-tauri/src/capture.rs` — 截图翻译目标与提示词调用点。
- `web/shared/lang.js` — 前端 `resolveTargetLang` 的本地语言优先逻辑。
- `web/shared/tauri-api.js` — mock `app.locale`、`settings.app.language`。
- `web/index.html`、`web/settings.js` — 设置页 i18n 与语言下拉。
- `web/picker.html`、`web/picker.js` — 工具栏/面板 i18n。
- `web/capture.html`、`web/capture.js`、`web/longshot.html`、`web/longshot.js`、`web/longshot-bar.html`、`web/longshot-bar.js`、`web/pin.html`、`web/pin.js` — 其余窗口 i18n。
- 现有测试：`src-tauri/src/settings.rs`、`prompts.rs`、`engine.rs` 内测试；`web/shared/tauri-api.test.cjs`、`web/settings-local.test.cjs`、`web/settings-startup.test.cjs`、`web/picker-followup.test.cjs`、`web/picker-repetition.test.cjs`。
- 文档：`docs/contracts.md`、`docs/user-guide.md`、`docs/architecture.md`、`CHANGELOG.md`、`ROADMAP.md`。

---

### Task 1: 系统语言与时区检测模块

**Files:**
- Create: `src-tauri/src/locale.rs`
- Modify: `src-tauri/Cargo.toml:35-57`（windows features）
- Modify: `src-tauri/src/main.rs:34-60`（`mod locale;`）
- Test: `src-tauri/src/locale.rs`（内联 `#[cfg(test)]`）

**Interfaces:**
- Produces: `pub const SUPPORTED_LANGUAGES: [&str; 2]`、`pub fn normalize_language(raw: &str) -> Option<&'static str>`、`pub fn resolve_language(region: Option<&str>, timezone: Option<&str>) -> &'static str`、`pub fn detect_language() -> &'static str`、`pub fn system_region() -> Option<String>`、`pub fn system_timezone_key() -> Option<String>`。

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/locale.rs` 末尾加入：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_languages_cover_zh_and_en() {
        assert_eq!(SUPPORTED_LANGUAGES, ["zh", "en"]);
    }

    #[test]
    fn normalize_language_accepts_aliases_and_rejects_unknown() {
        for value in ["zh", "zh-CN", " zh-hans ", "zh-SG", "ZH-HANT"] {
            assert_eq!(normalize_language(value), Some("zh"), "{value}");
        }
        for value in ["en", "en-US", "EN-GB"] {
            assert_eq!(normalize_language(value), Some("en"), "{value}");
        }
        assert_eq!(normalize_language("ja-JP"), None);
        assert_eq!(normalize_language(""), None);
    }

    #[test]
    fn region_wins_over_timezone_and_unknown_falls_back_to_english() {
        assert_eq!(resolve_language(Some("zh-Hant-TW"), Some("Tokyo Standard Time")), "zh");
        assert_eq!(resolve_language(Some("en-GB"), Some("China Standard Time")), "en");
        assert_eq!(resolve_language(None, Some("China Standard Time")), "zh");
        assert_eq!(resolve_language(None, Some("Pacific Standard Time")), "en");
        assert_eq!(resolve_language(None, None), "en");
        assert_eq!(resolve_language(Some("ja-JP"), Some("Tokyo Standard Time")), "en");
    }

    #[test]
    fn system_probes_are_safe() {
        let language = detect_language();
        assert!(SUPPORTED_LANGUAGES.contains(&language));
        let _ = system_region();
        let _ = system_timezone_key();
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test locale::` （目录 `src-tauri`）
Expected: 编译失败，`locale` 模块或函数不存在。

- [ ] **Step 3: 实现模块**

`src-tauri/src/locale.rs`：

```rust
//! UI language detection: Windows region first, timezone as a secondary hint.
//!
//! The result is one of [`SUPPORTED_LANGUAGES`]. Unknown regions fall back to
//! the timezone mapping and finally to English, which keeps the UI usable on
//! unsupported locales without half-translated strings.

#[cfg(windows)]
use windows::Win32::Globalization::GetUserDefaultLocaleName;
#[cfg(windows)]
use windows::Win32::System::Time::{
    GetDynamicTimeZoneInformation, DYNAMIC_TIME_ZONE_INFORMATION,
};

/// Languages shipped with the first localization release.
pub const SUPPORTED_LANGUAGES: [&str; 2] = ["zh", "en"];

/// Normalizes a BCP-47-ish tag (`zh-CN`, `en-US`, …) to a supported language.
pub fn normalize_language(raw: &str) -> Option<&'static str> {
    let value = raw.trim().to_ascii_lowercase();
    if value.starts_with("zh") {
        Some("zh")
    } else if value.starts_with("en") {
        Some("en")
    } else {
        None
    }
}

fn language_from_region(region: &str) -> Option<&'static str> {
    normalize_language(region)
}

fn language_from_timezone(key: &str) -> Option<&'static str> {
    match key.trim().to_ascii_lowercase().as_str() {
        "china standard time"
        | "taipei standard time"
        | "hong kong standard time"
        | "singapore standard time" => Some("zh"),
        "gmt standard time"
        | "utc"
        | "w. europe standard time"
        | "eastern standard time"
        | "central standard time"
        | "mountain standard time"
        | "pacific standard time"
        | "tokyo standard time"
        | "korea standard time" => Some("en"),
        _ => None,
    }
}

/// Region wins over timezone; both unknown -> English.
pub fn resolve_language(region: Option<&str>, timezone: Option<&str>) -> &'static str {
    region
        .and_then(language_from_region)
        .or_else(|| timezone.and_then(language_from_timezone))
        .unwrap_or("en")
}

/// Current Windows user locale, e.g. `zh-CN` / `en-US`; `None` when unavailable.
pub fn system_region() -> Option<String> {
    #[cfg(windows)]
    {
        let mut buffer = [0u16; 85];
        let length = unsafe { GetUserDefaultLocaleName(&mut buffer) };
        if length > 0 {
            let text = String::from_utf16_lossy(&buffer[..(length as usize - 1).min(buffer.len())]);
            let text = text.trim().to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Windows time-zone key name, e.g. `China Standard Time`.
pub fn system_timezone_key() -> Option<String> {
    #[cfg(windows)]
    {
        let mut info = DYNAMIC_TIME_ZONE_INFORMATION::default();
        let result = unsafe { GetDynamicTimeZoneInformation(&mut info) };
        // 0 = unknown, 1 = standard, 2 = daylight; the key name is still valid.
        let _ = result;
        let name = &info.TimeZoneKeyName;
        let length = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        if length == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&name[..length]))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Detected UI language for the `system` setting.
pub fn detect_language() -> &'static str {
    resolve_language(system_region().as_deref(), system_timezone_key().as_deref())
}
```

`src-tauri/Cargo.toml` 的 `windows` features 追加：

```toml
  "Win32_Globalization",
  "Win32_System_Time",
```

`src-tauri/src/main.rs` 模块声明区追加：

```rust
mod locale;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test locale::`
Expected: PASS（4 个测试）。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/locale.rs src-tauri/src/main.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: detect the system UI language from region and timezone"
```

---

### Task 2: settings schema v9 与 `app.language`

**Files:**
- Modify: `src-tauri/src/settings.rs:15`（`SETTINGS_VERSION`）、`:346-352`（`AppSettings`）、`:438-450`（default）、`:689-710`（normalize）
- Test: `src-tauri/src/settings.rs`（内联测试）

**Interfaces:**
- Consumes: `crate::locale::{normalize_language, detect_language, SUPPORTED_LANGUAGES}`。
- Produces: `AppSettings.language: String`；`Settings::effective_language() -> &'static str`（`"zh"` 或 `"en"`）；序列化字段 `app.language`。

- [ ] **Step 1: 写失败测试**

在 `settings.rs` 的 `mod tests` 内加入：

```rust
    #[test]
    fn app_language_defaults_to_system_and_normalizes() {
        let settings = Settings::default().normalize();
        assert_eq!(settings.app.language, "system");
        assert!(crate::locale::SUPPORTED_LANGUAGES.contains(&settings.effective_language()));

        for (raw, expected) in [
            ("zh", "zh"),
            (" zh-CN ", "zh"),
            ("en-US", "en"),
            ("EN", "en"),
            ("system", "system"),
            ("nonsense", "system"),
            ("", "system"),
        ] {
            let mut candidate = Settings::default();
            candidate.app.language = raw.into();
            let normalized = candidate.normalize();
            assert_eq!(normalized.app.language, expected, "{raw}");
        }
        let value = serde_json::to_value(Settings::default().normalize()).unwrap();
        assert_eq!(value["app"]["language"], "system");
    }

    #[test]
    fn schema_nine_adds_app_language_without_touching_history() {
        let legacy: Settings = serde_json::from_value(json!({
            "version": 8,
            "picker": { "prompts": { "translate": "Keep me." } }
        }))
        .unwrap();
        let migrated = legacy.normalize();
        assert_eq!(migrated.version, 9);
        assert_eq!(migrated.app.language, "system");
        assert_eq!(migrated.picker.prompts.translate, "Keep me.");
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test settings::tests::app_language settings::tests::schema_nine`
Expected: FAIL（字段/方法不存在）。

- [ ] **Step 3: 实现字段与归一化**

`SETTINGS_VERSION` 改为：

```rust
pub const SETTINGS_VERSION: u32 = 9;
```

`AppSettings`：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub close_to_tray: bool,
    #[serde(default)]
    pub start_at_login: bool,
    pub theme: String,
    /// UI language: "system" (detect at startup), or a supported code (`zh`/`en`).
    pub language: String,
}
```

`impl Default for AppSettings` 增加 `language: "system".to_string(),`。

`Settings::normalize` 的主题归一化之后加入：

```rust
        self.app.language = match self.app.language.trim().to_ascii_lowercase().as_str() {
            "zh" | "zh-cn" => "zh".to_string(),
            "en" | "en-us" | "en-gb" => "en".to_string(),
            _ => "system".to_string(),
        };
```

`impl Settings` 增加：

```rust
    /// Effective UI language (`zh`/`en`) for the current `app.language` value.
    pub fn effective_language(&self) -> &'static str {
        match self.app.language.as_str() {
            "zh" => "zh",
            "en" => "en",
            _ => crate::locale::detect_language(),
        }
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test settings::`
Expected: PASS（含新测试；原有 41 个测试应全部通过）。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/settings.rs
git commit -m "feat: persist the UI language setting (schema v9)"
```

---

### Task 3: State payload 暴露语言

**Files:**
- Modify: `src-tauri/src/commands.rs:34-43`（`AppInfo`）、`:82-119`（`build_state`）
- Modify: `web/shared/tauri-api.js:340-360`（mock `app`）、`:354-370`（mock `settings.app`）
- Test: `src-tauri/src/commands.rs`（无 app 的纯逻辑测试不适用；改由前端 `tauri-api.test.cjs` 覆盖）

**Interfaces:**
- Consumes: `Settings::effective_language()`、`settings.app.language`。
- Produces: `AppInfo.locale: String`（有效语言 `zh`/`en`）、`AppInfo.languageSetting: String`（`system|zh|en`）；前端 `state.app.locale` 与 `state.app.languageSetting`。

- [ ] **Step 1: 写失败前端测试**

在 `web/shared/tauri-api.test.cjs` 的 `checkSettingsMerge` 内，`getState` 断言后追加：

```javascript
  assert.equal(result.state.app.locale, "zh");
  assert.equal(result.state.app.languageSetting, "system");
  result = await api.updateSettings({ app: { language: "en" } });
  assert.equal(result.state.settings.app.language, "en");
  assert.equal(result.state.app.languageSetting, "en");
  assert.equal(result.state.app.locale, "en");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node web/shared/tauri-api.test.cjs`
Expected: FAIL（`app.locale` 为 undefined）。

- [ ] **Step 3: 实现后端字段与 mock**

`commands.rs` 的 `AppInfo` 增加：

```rust
    /// Effective UI language after resolving `settings.app.language`.
    pub locale: String,
    /// Raw language setting (`system` / `zh` / `en`) for the settings page.
    pub language_setting: String,
```

`build_state` 的 `AppInfo` 初始化增加：

```rust
            locale: settings.effective_language().to_string(),
            language_setting: settings.app.language.clone(),
```

`web/shared/tauri-api.js` 的 mock `settings.app` 增加：

```javascript
        app: {
          closeToTray: true,
          startAtLogin: false,
          theme: "system",
          language: "system",
        },
```

mock `app`（两处：初始 state 与 `getState` 构建）增加：

```javascript
        locale: mockStore.settings.app.language === "system" ? "zh" : mockStore.settings.app.language,
        languageSetting: mockStore.settings.app.language,
```

并更新 mock 的 normalize：`app.language` 仅保留 `["system", "zh", "en"]`（见 `mockNormalizeSettings` 中 `settings.app = {...}` 段）：

```javascript
    var appLanguage = String((settings.app && settings.app.language) || "").trim().toLowerCase();
    settings.app = {
      closeToTray: settings.app.closeToTray !== false,
      startAtLogin: settings.app.startAtLogin === true,
      theme: settings.app.theme === "light" || settings.app.theme === "dark" ? settings.app.theme : "system",
      language: appLanguage === "zh" || appLanguage === "en" ? appLanguage : "system",
    };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node web/shared/tauri-api.test.cjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands.rs web/shared/tauri-api.js web/shared/tauri-api.test.cjs
git commit -m "feat: expose the effective UI language in the state payload"
```

---

### Task 4: i18n 框架与语言包骨架

**Files:**
- Create: `web/shared/i18n.js`、`web/shared/messages.zh.js`、`web/shared/messages.en.js`
- Create: `web/i18n.test.cjs`
- Modify: `web/index.html:572-576`（脚本顺序）

**Interfaces:**
- Produces: `LP.messages.zh` / `LP.messages.en`（扁平点号 key 的对象）；`LP.t(key, params?) -> string`；`LP.i18n.init(locale)`；`LP.i18n.setLocale(locale) -> boolean`；`LP.i18n.currentLocale() -> "zh"|"en"`；`LP.i18n.applyStatic(root?)`；`LP.i18n.ready() -> Promise<void>`（初版为 resolve）。
- DOM 约定：`data-i18n`（textContent）、`data-i18n-title`、`data-i18n-aria-label`、`data-i18n-placeholder`、`data-i18n-html`（innerHTML，仅用于含内联标签的文案）。

- [ ] **Step 1: 写失败测试**

`web/i18n.test.cjs`：

```javascript
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function loadI18n() {
  const context = vm.createContext({ window: {}, console });
  for (const file of ["messages.zh.js", "messages.en.js", "i18n.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "shared", file), "utf8"), context);
  }
  return context.window.LP;
}

test("t() resolves the current locale, falls back to en, then to the key", () => {
  const LP = loadI18n();
  LP.i18n.init("zh");
  assert.equal(LP.t("common.ok"), "确定");
  LP.i18n.setLocale("en");
  assert.equal(LP.t("common.ok"), "OK");
  assert.equal(LP.t("missing.key"), "missing.key");
});

test("t() interpolates named parameters", () => {
  const LP = loadI18n();
  LP.i18n.init("en");
  assert.equal(LP.t("settings.modelHint", { model: "Qwen3.5" }), "All local AI tasks share Qwen3.5");
});

test("setLocale returns whether the locale changed and normalizes unknown values", () => {
  const LP = loadI18n();
  LP.i18n.init("zh");
  assert.equal(LP.i18n.setLocale("zh"), false);
  assert.equal(LP.i18n.setLocale("en"), true);
  assert.equal(LP.i18n.setLocale("jp"), false);
  assert.equal(LP.i18n.currentLocale(), "en");
});

test("applyStatic translates text, title, aria-label and placeholder", () => {
  const LP = loadI18n();
  LP.i18n.init("en");
  const attributes = { "data-i18n": "common.ok", "data-i18n-title": "common.cancel", "data-i18n-aria-label": "common.cancel", "data-i18n-placeholder": "common.search" };
  function makeNode(attrs) {
    const state = {};
    return {
      attrs,
      textContent: "",
      innerHTML: "",
      setAttribute(name, value) { state[name] = value; },
      getAttribute(name) { return this.attrs[name] === undefined ? null : this.attrs[name]; },
      removeAttribute(name) { delete this.attrs[name]; },
    };
  }
  const textNode = makeNode(attributes);
  const root = {
    querySelectorAll(selector) { return [textNode]; },
    getAttribute() { return null; },
    removeAttribute() {},
  };
  LP.i18n.applyStatic(root);
  assert.equal(textNode.textContent, "OK");
  assert.equal(textNode.getAttribute("title"), "Cancel");
  assert.equal(textNode.getAttribute("aria-label"), "Cancel");
  assert.equal(textNode.getAttribute("placeholder"), "Search");
});

test("language packs have the same keys", () => {
  const LP = loadI18n();
  assert.deepEqual(Object.keys(LP.messages.zh).sort(), Object.keys(LP.messages.en).sort());
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node web/i18n.test.cjs`
Expected: FAIL（文件不存在）。

- [ ] **Step 3: 实现框架与骨架语言包**

`web/shared/messages.zh.js`：

```javascript
/* Simplified Chinese UI strings. Keys are dot-separated and must stay in sync
 * with messages.en.js (web/i18n.test.cjs enforces it). */
(function () {
  "use strict";
  var LP = (window.LP = window.LP || {});
  LP.messages = LP.messages || {};
  LP.messages.zh = {
    "common.ok": "确定",
    "common.cancel": "取消",
    "common.search": "搜索",
    "common.reset": "重置为默认",
    "common.language": "界面语言",
    "common.followSystem": "跟随系统",
    "settings.modelHint": "所有本地 AI 任务共用 {model}",
  };
})();
```

`web/shared/messages.en.js`：

```javascript
/* English UI strings. Keep the key set identical to messages.zh.js. */
(function () {
  "use strict";
  var LP = (window.LP = window.LP || {});
  LP.messages = LP.messages || {};
  LP.messages.en = {
    "common.ok": "OK",
    "common.cancel": "Cancel",
    "common.search": "Search",
    "common.reset": "Reset to default",
    "common.language": "Language",
    "common.followSystem": "Follow system",
    "settings.modelHint": "All local AI tasks share {model}",
  };
})();
```

`web/shared/i18n.js`：

```javascript
/* Minimal no-build i18n for all Lexora windows.
 *
 * Load after shared/constants.js and the message packs, before the page script.
 * The page calls LP.i18n.init(locale) once the backend state is available; an
 * initial value is guessed from <html lang> / navigator.language to avoid a
 * flash of the wrong language on already-open windows.
 */
(function () {
  "use strict";

  var LP = (window.LP = window.LP || {});
  var supported = ["zh", "en"];
  var current = "en";
  var initialized = false;

  function normalize(value) {
    var raw = String(value == null ? "" : value).trim().toLowerCase();
    if (raw.indexOf("zh") === 0) {
      return "zh";
    }
    if (raw.indexOf("en") === 0) {
      return "en";
    }
    return "";
  }

  function pack(locale) {
    return LP.messages && LP.messages[locale] ? LP.messages[locale] : {};
  }

  function interpolate(text, params) {
    if (!params) {
      return text;
    }
    return text.replace(/\{([a-zA-Z0-9_]+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }

  LP.t = function (key, params) {
    var text = pack(current)[key];
    if (text === undefined) {
      text = pack("en")[key];
    }
    if (text === undefined) {
      return String(key);
    }
    return interpolate(String(text), params);
  };

  function applyElement(node) {
    if (!node || !node.getAttribute) {
      return;
    }
    var key = node.getAttribute("data-i18n");
    if (key) {
      node.textContent = LP.t(key);
    }
    var htmlKey = node.getAttribute("data-i18n-html");
    if (htmlKey) {
      node.innerHTML = LP.t(htmlKey);
    }
    ["title", "aria-label", "placeholder"].forEach(function (attribute) {
      var attributeKey = node.getAttribute("data-i18n-" + attribute);
      if (attributeKey) {
        node.setAttribute(attribute, LP.t(attributeKey));
      }
    });
  }

  LP.i18n = {
    currentLocale: function () {
      return current;
    },

    init: function (locale) {
      var next = normalize(locale) || "en";
      current = next;
      initialized = true;
      document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
      LP.i18n.applyStatic(document);
    },

    setLocale: function (locale) {
      var next = normalize(locale);
      if (!next || next === current) {
        return false;
      }
      current = next;
      if (initialized) {
        LP.i18n.init(next);
      }
      return true;
    },

    applyStatic: function (root) {
      var scope = root || document;
      if (!scope.querySelectorAll) {
        return;
      }
      Array.prototype.forEach.call(scope.querySelectorAll("[data-i18n], [data-i18n-html]"), applyElement);
      Array.prototype.forEach.call(
        scope.querySelectorAll("[data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]"),
        applyElement
      );
    },
  };

  /* Guess before the backend responds: <html lang> wins over navigator. */
  var guessed = normalize(document.documentElement.lang) || normalize(navigator.language) || "en";
  current = supported.indexOf(guessed) >= 0 ? guessed : "en";
})();
```

`web/index.html` 脚本区改为：

```html
  <script src="shared/constants.js"></script>
  <script src="shared/messages.zh.js"></script>
  <script src="shared/messages.en.js"></script>
  <script src="shared/i18n.js"></script>
  <script src="shared/skill-icons.js"></script>
  <script src="shared/markdown.js"></script>
  <script src="shared/tauri-api.js"></script>
  <script src="settings.js"></script>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node web/i18n.test.cjs`
Expected: PASS（5 个测试）。

- [ ] **Step 5: 提交**

```bash
git add web/shared/i18n.js web/shared/messages.zh.js web/shared/messages.en.js web/i18n.test.cjs web/index.html
git commit -m "feat: add the no-build i18n runtime and language packs"
```

---

### Task 5: 设置页语言选择与静态文案

**Files:**
- Modify: `web/index.html`（`data-i18n` 属性、语言下拉、脚本顺序）
- Modify: `web/settings.js`（`applyState` 设置 locale、语言下拉渲染与保存）
- Modify: `web/shared/messages.zh.js`、`web/shared/messages.en.js`（新增 key）
- Test: `web/settings-local.test.cjs`（状态 mock 增加 `app`）、`web/settings-startup.test.cjs`

**Interfaces:**
- Consumes: `state.app.locale`、`state.app.languageSetting`、`LP.i18n`。
- Produces: 设置页「应用与启动」卡片中的 `#app-language` 下拉；保存调用 `save({ app: { language: value } })`。

- [ ] **Step 1: 写失败测试**

在 `web/settings-startup.test.cjs` 的 state mock 中加入 `app: { locale: "zh", languageSetting: "system" }`，并新增断言（若测试只检查启动流程，改为在 `settings-local.test.cjs` 的 harness 中加入）：

```javascript
test("language select renders the saved value and saves changes", () => {
  const h = savingHarness();
  h.context.state.settings.app = { language: "system" };
  h.nodes["app-language"] = element("select", "");
  h.context.renderAppLanguage();
  assert.equal(h.nodes["app-language"].value, "system");
  h.context.saveAppLanguage("en");
  assert.deepEqual(h.saves.at(-1).patch, { app: { language: "en" } });
});
```

`savingHarness` 需注册 `renderAppLanguage`：在 `for (const name of [...])` 列表中加入该函数名，并在 harness 的 `nodes` 初始化列表中加入 `"app-language"`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node web/settings-local.test.cjs`
Expected: FAIL（`renderAppLanguage` 未定义）。

- [ ] **Step 3: 实现下拉与静态文案**

`web/index.html`「应用与启动」卡片开头加入（全部标注 `data-i18n`）：

```html
        <div class="field">
          <div class="field-label">
            <label class="field-name" for="app-language" data-i18n="settings.language.title">界面语言</label>
            <p class="field-hint" data-i18n="settings.language.hint">切换后立即生效；「跟随系统」会按 Windows 区域与时区自动选择。</p>
          </div>
          <div class="field-control">
            <select class="select" id="app-language">
              <option value="system" data-i18n="common.followSystem">跟随系统</option>
              <option value="zh">简体中文</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>
```

`web/settings.js` 增加：

```javascript
  /* ---- App language ---------------------------------------------------- */

  function renderAppLanguage() {
    var app = (state.settings && state.settings.app) || {};
    var select = byId("app-language");
    if (!select || select === document.activeElement) {
      return;
    }
    var value = ["system", "zh", "en"].indexOf(String(app.language || "")) >= 0
      ? String(app.language)
      : "system";
    if (select.value !== value) {
      select.value = value;
    }
  }

  function saveAppLanguage(value) {
    var next = ["system", "zh", "en"].indexOf(String(value)) >= 0 ? String(value) : "system";
    save({ app: { language: next } });
  }
```

在 `renderAppSettings`（`renderAll` 调用的应用设置渲染函数；若不存在则在 `renderAll` 内）调用 `renderAppLanguage()`；在事件绑定区加入：

```javascript
    byId("app-language").addEventListener("change", function (event) {
      saveAppLanguage(event.target.value);
    });
```

`applyState` 开头（`LP.i18n` 初始化处）加入：

```javascript
    if (window.LP && LP.i18n) {
      LP.i18n.init(state.app && state.app.locale);
    }
```

与 `handleStateChanged` 中：

```javascript
    if (window.LP && LP.i18n && state.app) {
      if (LP.i18n.setLocale(state.app.locale)) {
        renderAll();
      }
    }
```

将本任务涉及的区域文案（页面标题、品牌、五张卡片标题与描述、开关与按钮）替换为 `data-i18n`，语言包新增对应 key `settings.language.title/hint` 等。验收命令：

```powershell
Select-String -Path web/index.html -Pattern 'data-i18n' | Measure-Object
Select-String -Path web/index.html -Pattern '>[^<]*[\u4e00-\u9fff][^<]*<' | Measure-Object
```

第二条仅允许出现在 `<title>` 与注释中（迁移完成后数量为 0）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node web/settings-local.test.cjs; node web/settings-startup.test.cjs; node web/i18n.test.cjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add web/index.html web/settings.js web/settings-local.test.cjs web/shared/messages.zh.js web/shared/messages.en.js
git commit -m "feat: add the UI language picker and translate the settings page shell"
```

---

### Task 6: 设置页动态文案迁移

**Files:**
- Modify: `web/settings.js`（全部用户可见字符串）
- Modify: `web/shared/messages.zh.js`、`web/shared/messages.en.js`
- Test: `web/settings-local.test.cjs`、`web/settings-startup.test.cjs`（断言改为 key 或文案存在性）

**Interfaces:**
- Consumes: `LP.t`。
- Produces: 无新公开接口；`settings.*` 命名空间 key 全部落地。

- [ ] **Step 1: 写失败测试**

在 `web/i18n.test.cjs` 追加覆盖率测试：

```javascript
test("every settings.js literal lookup exists in both packs", () => {
  const LP = loadI18n();
  const source = fs.readFileSync(path.join(__dirname, "settings.js"), "utf8");
  const keys = Array.from(source.matchAll(/LP\.t\("([^"]+)"/g)).map((match) => match[1]);
  assert.ok(keys.length > 100, "expected the settings page to use LP.t");
  for (const key of new Set(keys)) {
    assert.ok(LP.messages.zh[key] !== undefined, `missing zh key ${key}`);
    assert.ok(LP.messages.en[key] !== undefined, `missing en key ${key}`);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node web/i18n.test.cjs`
Expected: FAIL（无 `LP.t` 调用）。

- [ ] **Step 3: 迁移字符串**

在 `web/settings.js` 内按区域替换，示例（每个替换都保持原逻辑）：

```javascript
// before
toast("已重置为默认提示词", "success");
// after
toast(LP.t("settings.toast.promptReset"), "success");
```

```javascript
// before
var label = "未启动";
// after
var label = LP.t("settings.engine.state.stopped");
```

必须覆盖：连接状态/本地模型卡片、划词行为、工具栏技能、截图、快捷键、应用与启动、关于、历史（若存在）、所有 `toast()`、`showInlineError()` 调用与动态拼接文案（用 `LP.t("key", { name: value })`）。新增 key 同步写入两个语言包。

验收：

```powershell
# 用户可见中文在 settings.js 中应为 0（注释/正则/data-* 白名单除外）
Select-String -Path web/settings.js -Pattern '"[^"]*[\u4e00-\u9fff][^"]*"' |
  Where-Object { $_.Line -notmatch '^\s*//|/\*|\*/' } | Measure-Object
```

结果必须为 0；若为少量例外（如 `"zh"` 映射），在计划执行记录中列明原因。

- [ ] **Step 4: 运行测试确认通过**

Run: `node web/i18n.test.cjs; node web/settings-local.test.cjs; node web/settings-startup.test.cjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add web/settings.js web/shared/messages.zh.js web/shared/messages.en.js web/i18n.test.cjs
git commit -m "feat: localize the settings page strings"
```

---

### Task 7: picker 窗口文案

**Files:**
- Modify: `web/picker.html`（脚本加载 + `data-i18n`）
- Modify: `web/picker.js`（全部用户可见字符串 + `LP.i18n` 初始化）
- Modify: `web/shared/constants.js`（技能标签改为语言包 key）
- Modify: `web/shared/messages.zh.js`、`web/shared/messages.en.js`
- Test: `web/picker-followup.test.cjs`、`web/picker-repetition.test.cjs`、`web/i18n.test.cjs`

**Interfaces:**
- Consumes: `LP.i18n`、state payload `app.locale`（picker 通过 `API.onData` 的 payload 读取）。
- Produces: `LP.skillLabel(id)`（语言包技能名）。`LP.resolveTargetLang` 行为不变：`auto` 目标只由源文本决定（中文→English、其他→Chinese），界面语言不参与，原因见 Global Constraints 的取舍说明。

- [ ] **Step 1: 写失败测试**

在 `web/i18n.test.cjs` 追加：

```javascript
test("auto target stays language-complementary regardless of UI language", () => {
  const LP = loadI18n();
  const context = vm.createContext({ window: LP, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "shared", "lang.js"), "utf8"), context);
  LP.i18n.init("zh");
  assert.equal(LP.resolveTargetLang("hello world", "auto"), "zh");
  assert.equal(LP.resolveTargetLang("这是中文", "auto"), "en");
  LP.i18n.init("en");
  assert.equal(LP.resolveTargetLang("这是中文", "auto"), "en");
  assert.equal(LP.resolveTargetLang("hello world", "auto"), "zh");
  assert.equal(LP.resolveTargetLang("hello", "ja"), "ja");
});

test("skill labels come from the active language pack", () => {
  const LP = loadI18n();
  LP.i18n.init("en");
  assert.equal(typeof LP.skillLabel, "function");
  assert.equal(LP.skillLabel("translate"), "Translate");
  LP.i18n.init("zh");
  assert.equal(LP.skillLabel("translate"), "翻译");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node web/i18n.test.cjs`
Expected: FAIL（`LP.skillLabel` 未定义；auto 回归测试应已通过）。

- [ ] **Step 3: 实现 picker i18n 与 lang.js**

`web/picker.html` 脚本区改为：

```html
  <script src="shared/constants.js"></script>
  <script src="shared/messages.zh.js"></script>
  <script src="shared/messages.en.js"></script>
  <script src="shared/i18n.js"></script>
  <script src="shared/skill-icons.js"></script>
  <script src="shared/lang.js"></script>
  <script src="shared/markdown.js"></script>
  <script src="shared/tauri-api.js"></script>
  <script src="picker.js"></script>
```

`web/shared/lang.js` **不修改**：译文自动目标保持语言互补（中文→英文、其他→中文）。界面语言只影响界面文案与 AI 解释类输出，避免英文界面把英文原文翻成英文。Step 1 的回归测试锁定该行为。

`web/picker.js`：
- 在 `API.onData`（已有回调）里初始化语言：`if (window.LP && LP.i18n) { LP.i18n.init(data.app && data.app.locale); }`。若 payload 无 `app.locale`，`LP.i18n` 会用 `<html lang>` / `navigator.language` 猜测，state 到达后纠正。
- 将工具栏技能名、面板标题、按钮、toast、错误提示、追问占位符等替换为 `LP.t("picker.*")`，key 同步写入语言包。
- `LP.SKILLS` 的 `label` 保持原字段以兼容旧代码，但所有渲染处改用 `LP.skillLabel(id)`（见下）。

`web/shared/constants.js` 增加：

```javascript
  LP.skillLabel = function (id) {
    return LP.t ? LP.t("skill." + id) : id;
  };
```

并把 `SKILLS` 中 `label` 值迁移为语言包 key `skill.translate` 等；`settings.js` 与 `picker.js` 中读取 `skill.label` 的地方改为 `LP.skillLabel(skill.id)`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node web/i18n.test.cjs; node web/picker-followup.test.cjs; node web/picker-repetition.test.cjs`
Expected: PASS（picker 测试的文案断言若依赖中文，更新为 `LP.t` 后的实际文案）。

- [ ] **Step 5: 提交**

```bash
git add web/picker.html web/picker.js web/shared/constants.js web/shared/messages.zh.js web/shared/messages.en.js web/i18n.test.cjs web/picker-followup.test.cjs web/picker-repetition.test.cjs
git commit -m "feat: localize the picker window"
```

---

### Task 8: 截图、长截图与钉图窗口文案

**Files:**
- Modify: `web/capture.html`、`web/capture.js`、`web/longshot.html`、`web/longshot.js`、`web/longshot-bar.html`、`web/longshot-bar.js`、`web/pin.html`、`web/pin.js`
- Modify: `web/shared/messages.zh.js`、`web/shared/messages.en.js`
- Modify: `src-tauri/src/selection.rs:565-586`（`picker_config` 增加 `locale`）
- Modify: `src-tauri/src/capture.rs`（截图 overlay 若通过事件传语言，则补充 `locale` 事件字段；若前端自行读取 state 则跳过）

**Interfaces:**
- Consumes: `LP.i18n`。
- Produces: `picker_config` 增加 `"locale": settings.effective_language()`，供 picker 初始化语言。

- [ ] **Step 1: 写失败测试**

在 `web/i18n.test.cjs` 追加：

```javascript
test("capture, longshot and pin pages load the i18n runtime", () => {
  for (const page of ["capture.html", "longshot.html", "longshot-bar.html", "pin.html"]) {
    const source = fs.readFileSync(path.join(__dirname, page), "utf8");
    assert.ok(source.includes('shared/i18n.js'), `${page} must load i18n.js`);
    assert.ok(source.includes('shared/messages.en.js'), `${page} must load the English pack`);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node web/i18n.test.cjs`
Expected: FAIL（页面未加载 i18n）。

- [ ] **Step 3: 实现**

- 四个页面加入语言包与 `i18n.js` 脚本（顺序同 Task 7），并在各自脚本初始化时调用 `LP.i18n.init(<locale>)`：locale 来源按优先级 `window.__LEXORA_LOCALE__`（若 Rust 注入）→ `LP.i18n.currentLocale()`。`selection.rs` 增加 `"locale": settings.effective_language(),`。
- `longshot-bar.js` / `pin.js` / `capture.js` 中全部用户可见中文替换为 `LP.t("capture.*")`、`LP.t("longshot.*")`、`LP.t("pin.*")`，key 写入两个语言包。
- `capture.js` 的标注工具标签（形状/箭头/画笔/文字/序号/马赛克/长截图/取消/确认/撤销/重做）改为 `LP.t("capture.tool.*")`；`pin.js` 的缩放/复制/关闭提示同理。

验收：

```powershell
Get-ChildItem web -Filter *.js | Select-String -Pattern '"[^"]*[\u4e00-\u9fff][^"]*"' |
  Where-Object { $_.Line -notmatch '^\s*//|/\*|\*/' } |
  Group-Object Filename | Select-Object Name,Count
```

仅允许 `shared/` 与测试文件出现中文（常量/映射除外，逐条说明）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node web/i18n.test.cjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add web/capture.html web/capture.js web/longshot.html web/longshot.js web/longshot-bar.html web/longshot-bar.js web/pin.html web/pin.js web/shared/messages.zh.js web/shared/messages.en.js src-tauri/src/selection.rs web/i18n.test.cjs
git commit -m "feat: localize the capture, longshot and pin windows"
```

---

### Task 9: AI 以本地语言输出

**Files:**
- Modify: `src-tauri/src/engine/prompts.rs`（默认提示词、`assist_messages`、`resolve_text_prompt`、`suggestion_messages`、`default_prompts`）
- Modify: `src-tauri/src/engine.rs`（`assist_stream`、`assist`、`suggestion_messages` 调用点；`translate_stream`/`translate_stream_with_prompt` 的提示词语言）
- Modify: `src-tauri/src/capture.rs`（截图解释与追问的语言参数）
- Modify: `src-tauri/src/settings.rs`（仅使用已有的 `effective_language()`，不新增字段）
- Test: `src-tauri/src/engine/prompts.rs`、`src-tauri/src/engine.rs`、`src-tauri/src/capture.rs` 内测试

**Interfaces:**
- Produces: `prompts::answer_language_name(code: &str) -> String`（复用 `language_name`）；`resolve_text_prompt(action, text, target_lang, custom_prompt, word_lookup_prompt, answer_language_code)`；`assist_messages(action, text, custom_prompt, answer_language_name)`；`suggestion_messages(skill, source, initial_answer, history, answer_language_name)`；默认模板含 `{answer}`。
- Consumes: `Settings::effective_language()`（`zh`/`en`）。
- **不修改** `resolve_target_lang`：译文自动目标保持语言互补（中文→英文、其他→中文），与界面语言无关。理由：避免英文界面把英文原文翻成英文；界面语言影响的是 AI 解释类输出。

- [ ] **Step 1: 写失败测试**

在 `prompts.rs::tests` 中追加：

```rust
    #[test]
    fn default_answer_language_comes_from_the_local_locale() {
        let (system, _) = assist_messages("explain", "text", "", "Simplified Chinese").unwrap();
        assert!(system.contains("Simplified Chinese"));
        let (system, _) = assist_messages("explain", "text", "", "English").unwrap();
        assert!(system.contains("English"));
        assert!(!system.contains("Simplified Chinese"));
        let (system, _) = assist_messages("summarize", "text", "", "English").unwrap();
        assert!(system.contains("English"));
        let (system, _) = translate_messages("hello", "ja", "");
        assert!(system.contains("Japanese"));

        let resolved = resolve_text_prompt("explain", "银行", "ja", "", "", "en").unwrap();
        assert_eq!(resolved.mode, "word_lookup");
        assert!(resolved.system.contains("English"));
        assert!(!resolved.system.contains("Simplified Chinese"));
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test engine::prompts`
Expected: FAIL（函数签名与模板不匹配）。

- [ ] **Step 3: 实现**

按以下规则修改：

1. 默认模板加入 `{answer}`（保留 `{target}`）：

```rust
pub const DEFAULT_SUMMARIZE_PROMPT: &str =
    "You are a concise writing assistant. Summarize the user's text in {answer} in 3-5 key points. Preserve the central meaning without adding unsupported facts or repeating points.";
pub const DEFAULT_EXPLAIN_PROMPT: &str =
    "You are a knowledge assistant. Explain the user's text in {answer}: start with one sentence stating the core meaning, add at most 3 necessary points and optionally one short example. Usually use 150-250 characters; simple content should be shorter. Avoid excessive background, repetition and unrelated detail.";
pub const DEFAULT_EXPLAIN_IMAGE_PROMPT: &str =
    "You are a vision assistant. Explain the image in {answer} using Markdown: one sentence for the main subject, at most 3 key points and optionally one short example. Usually use 150-250 characters; simple images need less. Distinguish visible facts from inference. Do not invent unreadable text or unseen details.";
```

2. `assist_messages` 签名与渲染：

```rust
pub fn assist_messages(
    action: &str,
    text: &str,
    custom_prompt: &str,
    answer_language: &str,
) -> Result<(String, String), EngineError> {
    // ... default selection unchanged ...
    let system = if custom_prompt.trim().is_empty() {
        default_prompt.replace("{answer}", answer_language)
    } else {
        let custom = custom_prompt.trim();
        if custom.contains("{answer}") {
            custom.replace("{answer}", answer_language)
        } else {
            format!("{custom}\n\nAnswer language: {answer_language}.")
        }
    };
    Ok((system, text.to_string()))
}
```

3. `resolve_text_prompt` 增加 `answer_language: &str` 参数；`word_lookup` 分支的 `target` 从固定 `"zh"` 改为 `answer_language`（通过 `language_name` 反查代码：新增 `answer_language_code()` 辅助，或直接传语言代码后在内部 `translate_messages(text, code, prompt)`）。实现采用代码参数 `answer_language_code: &str`（`zh`/`en`），内部 `language_name` 转换，避免调用方重复转换。

4. `resolve_target_lang` **保持不变**（签名与实现都不改）：`auto` 仍是中文源→英文、其他→中文。只有解释类输出（explain/summarize/词条/追问）跟随本地语言，译文目标不受界面语言影响。`web/shared/lang.js` 同样不改，Task 7 已加回归测试锁定。

5. `default_prompts()` 中 summarize/explain/captureExplain 返回含 `{answer}` 的模板；设置页展示时原样显示占位符（与 `{target}` 一致）。

6. `suggestion_messages` 增加 `answer_language` 参数：中文时保持现有约束（4-16 个中文字符），英文时改为：

```rust
    let system = if answer_language.eq_ignore_ascii_case("English") {
        format!(
            "Current skill: {}. Predict follow-up questions for the answer that is about to be generated. Output only a JSON string array without a fence; exactly 3 items, 3-10 English words each, ending with a question mark; specific, non-repeating and not about content already answered. Example: [\"What other uses exist?\", \"How does it differ from synonyms?\", \"Common collocations?\"]",
            truncate_chars(skill.trim(), 120)
        )
    } else {
        // existing Chinese prompt (unchanged)
    };
```

7. `engine.rs` 调用点：
   - `assist_stream` / `assist`：计算 `let answer_language = prompts::language_name(settings.effective_language());`，传给 `assist_messages` / `resolve_text_prompt`。
   - `translate_stream` / `translate_stream_with_prompt`：调用 `resolve_text_prompt` 时传入 `settings.effective_language()`（影响单词词条的说明语言；普通译文仍用自定义/默认翻译提示词与 `{target}`）。
   - `suggestion_messages` 调用处传 `answer_language`。
8. `capture.rs` 的 `resolve_text_prompt`（截图单词词条）与解释/追问路径同样传 `settings.effective_language()`；截图翻译的 `resolve_target_lang` 不传新参数（未改）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test engine::prompts; cargo test engine::tests; cargo test capture::`
Expected: PASS（更新受影响断言：默认提示词测试改为检查 `{answer}`；`language_name` 相关保持）。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/engine/prompts.rs src-tauri/src/engine.rs src-tauri/src/capture.rs src-tauri/src/settings.rs
git commit -m "feat: generate AI answers in the local language"
```

---

### Task 10: 文档、契约与全量验收

**Files:**
- Modify: `docs/contracts.md`（schema v9、`app.language`、`AppInfo.locale/languageSetting`、`{answer}` 占位符、auto 目标规则、i18n 约定）
- Modify: `docs/user-guide.md`（界面语言设置、首次启动语言检测、AI 语言行为）
- Modify: `docs/architecture.md`（locale 模块、i18n 运行方式、提示词语言）
- Modify: `CHANGELOG.md`（Unreleased：Added/Changed）
- Modify: `ROADMAP.md`（R1 状态改为「开发中」/子项说明）
- Test: 全量命令（见 Step 4）

- [ ] **Step 1: 更新文档**

`contracts.md` schema 版本改为 9，注释追加 `v8→v9 增加 app.language（system|zh|en）`；`app` 示例增加 `"language": "system"`；`AppInfo` 增加 `locale`/`languageSetting`；§6.1 提示词部分说明 `{answer}` 与自定义提示词无占位符时追加 `Answer language: <name>.` 的规则，并明确 `auto` 译文目标保持语言互补、不随界面语言变化。`user-guide.md` 在「本地模型」后新增「界面语言」小节。`CHANGELOG.md` 增加：

```markdown
### Added

- 界面多语言：首批简体中文与英文；首次启动按 Windows 区域与时区自动识别语言，设置 → 应用与启动可手动覆盖（settings schema 9 新增 `app.language`）。
- AI 默认以本地语言输出：解释、总结、图片解释、追问建议与词条释义使用本地语言；默认提示词用 `{answer}` 占位符，`auto` 目标语言规则保持与原文语言匹配。

### Changed

- 设置页、划词工具栏、结果面板、截图、长截图与钉图窗口的全部用户可见文案迁移到语言包；切换语言立即生效，无需重启。
```

`ROADMAP.md` R1 的状态列改为「开发中（feature/r1-localization）」。

- [ ] **Step 2: 提交文档**

```bash
git add docs/contracts.md docs/user-guide.md docs/architecture.md CHANGELOG.md ROADMAP.md
git commit -m "docs: describe localization, language detection and local-language answers"
```

- [ ] **Step 3: 全量静态检查**

```powershell
cd src-tauri
cargo fmt --check
cargo check --all-targets
cargo test settings:: engine::prompts engine::tests capture:: locale::
cd ..
node --check web/shared/i18n.js
node --check web/shared/lang.js
node --check web/settings.js
node --check web/picker.js
node --check web/capture.js
node --check web/tauri-api.js
node web/i18n.test.cjs
node web/shared/tauri-api.test.cjs
node web/settings-local.test.cjs
node web/settings-startup.test.cjs
node web/picker-followup.test.cjs
node web/picker-repetition.test.cjs
```

Expected: 全部通过。

- [ ] **Step 4: 构建与手动验收**

```powershell
npm run build
Stop-Process -Name lexora -Force -ErrorAction SilentlyContinue
Start-Process .\src-tauri\target\release\lexora.exe -ArgumentList "--show"
```

手动检查：
- 设置 → 应用与启动 → 界面语言：切换 English 后设置页、工具栏、面板、截图工具条文案立即变为英文；切回简体中文恢复。
- 首次启动（清空 `data/settings.json` 或临时 `LEXORA_DATA_DIR`）：在系统区域为中文/英文的机器上自动选择对应语言。
- 翻译 `auto` 目标：中文源→英语、英文源→中文。
- 解释与总结：英文界面输出英文，中文界面输出简体中文；词条释义语言一致。
- `data/settings.json` 中 `version` 为 9、`app.language` 保存正确；旧 v8 配置升级不丢提示词与技能。

- [ ] **Step 5: 提交最终验收记录**

```bash
git add -A
git commit -m "test: verify localization end to end"
```

---

## Self-Review

- **Spec coverage:** R1 路线图的三项（界面多语言、区域/时区自动识别、AI 本地语言输出）分别由 Task 4–8、Task 1、Task 9 覆盖；持久化与状态暴露在 Task 2–3；文档在 Task 10。
- **Placeholder scan:** 无 TBD/TODO；每个实现步骤含可执行代码或精确文件位置。
- **Type consistency:** `app.language` 取值 `system|zh|en` 贯穿 settings、state payload、前端下拉与语言包；`effective_language()` 返回 `'static str`；i18n 的 `setLocale` 返回 bool；`resolve_target_lang` 不改签名，统一在 Task 7/9 的回归测试中锁定旧行为。
- **已知取舍（记录在变更说明中）:** 提示词模板保持英文（模型遵循稳定），输出语言由 `{answer}` 驱动；首批不含繁体/日语，`zh-Hant` 回退到 `zh`；`auto` 目标规则保持与原文语言互为补集，不随界面语言切换（避免英文界面把英文原文翻成英文）。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-29-r1-localization.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 每个任务派发一个独立子代理，任务间由 Lead 审查，迭代快。
2. **Inline Execution** — 在当前会话按任务顺序执行，批量推进并在检查点暂停。

Which approach?
