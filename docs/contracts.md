# LingoPick 工程契约（Tauri v2 版）

本文件是并行开发期间的唯一接口契约。**实现必须与本文一致**；需要调整先通知 Lead 改本文件，再改代码。Electron 版设计稿（设置页字段、picke r行为）仍适用，技术栈已切换为 **Tauri v2 + Rust + 原生 HTML/CSS/JS**。

## 1. 目标与决策

把 `enterprise-ai-translator` 的划词工具抽取为独立开源 Windows 免安装应用 **LingoPick**：

- 完整保留划词体验：拖动选词自动弹出工具栏；翻译（流式）、总结、解释、朗读、复制；结果面板（固定/关闭/目标语言/重试）；菜单（本应用禁用、设置、禁用工具、关闭）；快捷键；应用黑名单；技能配置/排序；紧凑模式；多屏 DPI 定位；面板按内容缩放。
- 双模式翻译：**在线**（任意 OpenAI 兼容 `/v1/chat/completions`，含 Ollama/LM Studio）与**本地**（内置 llama.cpp 引擎 = 按需下载，自管理 `llama-server.exe` + 用户下载/导入 GGUF）。
- 系统托盘后台运行、单实例、可选开机自启；关闭设置窗口进托盘。
- 免安装：`tauri build --no-bundle` 产出的单 exe（约 5–10MB）+ 可下载引擎/模型；发布 zip。
- 无 Python / WebView2 安装包依赖（Win10 现代版本自带）。
- 原 enterprise-ai-translator 仓库保持不动。

已验证（见 `docs/spike-report.md`）：Rust 原生 UIA 取词在 Notepad/Chrome/Edge/Word 成功，5–30ms 热路径；150% DPI 下物理/逻辑坐标换算已确认。

## 2. 目录与归属（写作用域）

```
lingopick/
├─ package.json                 [Lead]   @tauri-apps/cli
├─ src-tauri/
│  ├─ Cargo.toml                [Lead]   依赖；需新增依赖先找 Lead
│  ├─ build.rs tauri.conf.json  [T4]     T4 可调整窗口/打包配置
│  ├─ capabilities/default.json [T4]
│  ├─ icons/                    [Lead]
│  └─ src/
│     ├─ main.rs                [T4]     生命周期、插件、窗口事件、setup
│     ├─ commands.rs            [T4]     全部 #[tauri::command]
│     ├─ commands_state.rs?     [T4]     可拆分，StatePayload 结构体
│     ├─ windows.rs             [T4]     picker/settings 窗口几何与显隐
│     ├─ tray.rs                [T4]     托盘菜单
│     ├─ state.rs               [T4]     AppState（Lead 已给骨架，可改）
│     ├─ paths.rs               [Lead]   数据目录解析
│     ├─ logger.rs              [Lead]   滚动日志 + 脱敏
│     ├─ settings.rs            [Lead]   Settings 结构/归一化/持久化
│     ├─ win32.rs               [Lead]   光标/工作区/DPI FFI
│     ├─ engine.rs (+ engine/…) [T1]     翻译引擎公开接口 + 内部实现
│     └─ selection.rs(+selection/…)[T2]  全局钩子 + UIA 取词 + 触发
├─ web/                         [T3]     静态前端（无打包器）
│  ├─ index.html settings.css settings.js
│  ├─ picker.html picker.css picker.js
│  └─ shared/{constants.js,lang.js,tauri-api.js}
├─ scripts/                     [T4]     fetch-llama.ps1 / build-portable.ps1（make_icons.py 归 Lead）
├─ .github/workflows/           [T4]     ci.yml / release.yml
├─ docs/                         [Lead]   契约、spike 报告、架构、用户/构建文档
├─ assets/                       [Lead]
└─ README.md LICENSE CHANGELOG.md CONTRIBUTING.md SECURITY.md [Lead]
```

- 只改自己名下文件；跨文件需求发消息给 Lead。
- 不引入前端框架/打包器；前端为原生 HTML/CSS/JS。
- 新增 Rust 依赖先找 Lead（Cargo.toml 由 Lead 维护）。
- 编译并行期：`cargo check` 可能因他人未完成文件报错，只处理自己文件的错误，其余忽略并在汇报中注明。

## 3. 数据目录（已实现 `paths.rs`）

- `LINGOPICK_DATA_DIR` 环境变量 > debug 模式 `<repo>/data` > `<exe目录>/data`（可写时） > `%APPDATA%\LingoPick`。
- `LINGOPICK_MODEL_DIR` / `LINGOPICK_LLAMA_DIR` 覆盖模型/引擎目录。
- 结构：`settings.json`、`models/*.gguf`、`engine/llama-server.exe`、`logs/main.log`、`logs/llama.log`、`cache/*.part`。

## 4. 设置 Schema（已实现 `settings.rs`，camelCase JSON）

```jsonc
{
  "version": 1,
  "picker": {
    "enabled": true,
    "shortcut": "Ctrl+Shift+D",          // 仅支持 Ctrl/Shift/Alt + A-Z/0-9/F1-F12
    "skills": ["translate","summarize","explain","read","copy"],
    "compact": false,
    "defaultTargetLang": "auto",          // auto|zh|en|ja|de|fr|es|ru|ko
    "blacklist": [],                      // 进程名，可含 .exe
    "maxChars": 5000
  },
  "provider": {
    "mode": "online",                     // online | local
    "online": { "preset": "deepseek", "baseUrl": "https://api.deepseek.com/v1", "apiKey": "", "model": "deepseek-chat",
                "timeoutMs": 60000, "temperature": 0.2, "maxTokens": 1024 },
    "local": { "modelFile": "", "contextSize": 4096, "threads": 0, "gpuLayers": 0, "autoStart": true }
  },
  "app": { "closeToTray": true, "startAtLogin": false, "theme": "system", "firstRunDone": false }
}
```

规则：归一化永不失败；非法值回退默认。运行时环境变量覆盖：`LINGOPICK_API_KEY`（覆盖 apiKey）、`LINGOPICK_LLAMA_URL`（引擎下载地址覆盖）。

## 5. 前端 ↔ Rust 契约（T3/T4 共同遵守）

前端通过 `window.__TAURI__.core.invoke(command, args)` 与 `window.__TAURI__.event.listen(event, cb)`（`withGlobalTauri: true`）。命令名 snake_case，参数 camelCase，返回统一 `{ok,...}` 或抛出错误字符串由 Tauri 包装（前端 `try/catch` 取 `String(error)`）。

### 5.1 设置窗口命令

| command | args | 返回 |
| --- | --- | --- |
| `get_state` | — | `StatePayload` |
| `update_settings` | `{patch: object}` | `{state: StatePayload}`（失败 reject 字符串） |
| `reset_settings` | — | `{state}` |
| `test_online` | `{baseUrl, apiKey, model, timeoutMs}` | `TestResult` |
| `list_online_models` | `{baseUrl, apiKey}` | `{models: string[]}` |
| `download_engine` | — | `{ok}`（进度走 `download-progress` 事件） |
| `download_model` | `{id: string}` | `{ok, error?}` |
| `cancel_download` | — | `{ok}` |
| `import_model` | — | `{ok, model?, error?}`（Rust 弹原生文件对话框） |
| `remove_model` | `{file: string}` | `{ok, error?}` |
| `start_local` / `stop_local` | — | `{ok, error?, hint?}` |
| `open_dir` | `{which: "data"|"models"|"logs"|"engine"}` | `{ok}` |
| `open_external` | `{url: string}` | `{ok}`（仅 https） |
| `set_start_at_login` | `{enabled: boolean}` | `{ok, error?}` |
| `quit_app` | — | — |

### 5.2 划词窗口命令

| command | args | 返回 |
| --- | --- | --- |
| `picker_ready` | — | `{ok}`（renderer 初始化完成；Rust 若有待展示数据则补发 `picker-data`） |
| `picker_close` | — | `{ok}` |
| `picker_pin` | `{pinned: boolean}` | `{pinned: boolean}` |
| `picker_resize` | `{width, height}` | `{x,y,width,height} \| null`（Rust 已应用 bounds 后返回逻辑像素） |
| `picker_copy` | `{text: string}` | `{ok}` |
| `picker_open_settings` | — | `{ok}` |
| `picker_translate` | `{requestId, text, targetLang}` | `{ok, error?, hint?}`（随后 `translate-event` 流） |
| `picker_abort_translate` | `{requestId}` | `{ok}` |
| `picker_assist` | `{action: "summarize"|"explain", text}` | `{ok, text?, error?, hint?}` |
| `picker_status` | — | `{mode, ready, configured, providerLabel, localState, hint}` |
| `picker_disable_in_app` | `{programName}` | `{ok, error?}` |
| `picker_disable_tool` | — | `{ok, error?}` |

### 5.3 事件（Rust → 前端）

| event | 目标 | payload |
| --- | --- | --- |
| `state-changed` | settings | `StatePayload` |
| `download-progress` | settings | `DownloadProgress` |
| `toast` | settings | `{type:"success"|"error"|"info", message}` |
| `picker-data` | picker | `{text, programName, config:{skills,compact,defaultTargetLang}}` |
| `picker-hidden` | picker | `{}` |
| `translate-event` | picker | `{requestId, type:"chunk"|"error"|"done", text?, message?}` |

### 5.4 StatePayload

```jsonc
{
  "app": { "name":"LingoPick", "version":"0.1.0", "platform":"windows", "packaged":true, "portable":false,
           "dataDir":"...", "modelsDir":"...", "logsDir":"...",
           "repoUrl":"https://github.com/monk233/lingopick", "license":"MIT" },
  "settings": { /* §4 */ },
  "engine": {
    "mode":"online", "ready":true, "hint":"", "providerLabel":"在线 · deepseek-chat",
    "onlineConfigured":true,
    "localState":"stopped",           // stopped|starting|ready|error
    "localModelFile":"", "localModelName":"", "localError":"", "engineAvailable":false
  },
  "models": [ {"file":"qwen2.5-1.5b-instruct-q4_k_m.gguf","name":"qwen2.5-1.5b-instruct-q4_k_m",
               "path":"...","sizeBytes":1117320736,"modifiedAt":1760000000000,"catalogId":"qwen2.5-1.5b"} ],
  "catalog": [ {"id":"qwen2.5-1.5b","name":"Qwen2.5 1.5B Instruct","description":"...","filename":"...",
                "sizeBytes":1117320736,"license":"Apache-2.0","languages":"多语言","recommended":true,"installed":false} ],
  "download": null,   // 或 DownloadProgress
  "picker": {"visible":false,"pinned":false},
  "loginItem": {"supported":true,"enabled":false}
}
```

`DownloadProgress`：`{kind:"engine"|"model", id, filename, received, total, percent, status:"downloading"|"verifying"|"failed"|"cancelled", error}`。

### 5.5 PickerData.config

`{"skills":["translate","summarize","explain","read","copy"],"compact":false,"defaultTargetLang":"auto"}`。

## 6. Rust 模块接口（已存骨架，按此实现）

### 6.1 `engine.rs`（T1，唯一公开接口；内部可拆 `engine/*.rs`）

```rust
pub struct EngineError { pub message: String, pub hint: String }
pub struct EngineStatus { mode, ready, hint, provider_label, online_configured,
                          local_state, local_model_file, local_model_name, local_error, engine_available }
pub struct TestResult { ok, latency_ms, models, model, error, hint }
pub struct ModelInfo { file, name, path, size_bytes, modified_at, catalog_id }        // camelCase 序列化
pub struct CatalogEntry { id, name, description, filename, size_bytes, license, languages, recommended, installed }
pub struct DownloadProgress { kind, id, filename, received, total, percent, status, error }

impl EngineService {
  pub fn new(paths: AppPaths, settings: Arc<SettingsStore>, logger: Logger) -> Self;
  pub fn status(&self) -> EngineStatus;
  pub async fn translate_stream(&self, text:&str, target_lang:&str)
      -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError>;
  pub async fn assist(&self, action:&str, text:&str) -> Result<String, EngineError>;
  pub async fn test_online(&self, base_url:&str, api_key:&str, model:&str, timeout_ms:u64) -> TestResult;
  pub async fn list_online_models(&self, base_url:&str, api_key:&str) -> Result<Vec<String>, EngineError>;
  pub fn installed_models(&self) -> Vec<ModelInfo>;
  pub fn catalog(&self) -> Vec<CatalogEntry>;
  pub fn download_state(&self) -> Option<DownloadProgress>;
  pub async fn download_model(&self, app: tauri::AppHandle, id:&str) -> Result<ModelInfo, EngineError>;
  pub async fn install_engine(&self, app: tauri::AppHandle) -> Result<(), EngineError>;
  pub fn cancel_download(&self);
  pub fn engine_installed(&self) -> bool;
  pub async fn start_local(&self) -> Result<(), EngineError>;
  pub async fn stop_local(&self) -> Result<(), EngineError>;
  pub async fn import_model(&self, path: PathBuf) -> Result<ModelInfo, EngineError>;
  pub fn remove_model(&self, file:&str) -> Result<(), EngineError>;
  pub fn models_dir(&self) -> &Path;
  pub fn engine_dir(&self) -> &Path;
}
```

实现要求：
- 在线：`{baseUrl}/chat/completions`，`stream:true`，SSE `data:` 行解析 `choices[0].delta.content`；非 SSE 响应按 JSON 兜底；超时/取消（abort）支持；错误映射中文 `message+hint`（401/404/429/5xx/网络/超时）。
- 本地：未安装引擎 → 错误提示「下载 llama.cpp 引擎」；未选模型 → 「下载/导入 GGUF」；启动前选空闲端口（TcpListener 127.0.0.1:0），`llama-server.exe -m <model> --host 127.0.0.1 --port <p> -c <ctxSize> -t <threads> -ngl <gpuLayers> --no-webui`，轮询 `/health` 最长 90s，stderr 写 `logs/llama.log`；进程退出/应用退出要清理；服务就绪后复用在线客户端逻辑。
- 提示词：
  - 翻译 system：`你是一名专业的翻译引擎。请把用户提供的文本翻译为目标语言：{target}。只输出译文本身，不要解释、不要加引号、不要输出原文。`
  - 总结 system：`你是一名中文写作助手。请用简体中文总结用户提供的文本，输出简洁、准确的要点，不要添加与原文无关的内容。`
  - 解释 system：`你是一名知识助手。请用简体中文解释用户提供的文本，讲清含义、背景和关键概念，必要时举例说明。`
  - 文本截断：翻译取前 `picker.maxChars`；总结/解释取前 8000 字符。
- 引擎下载：默认 URL `https://github.com/ggml-org/llama.cpp/releases/download/b11851/llama-b11851-bin-win-cpu-x64.zip`（23.1MB，已验证存在），可用 `LINGOPICK_LLAMA_URL` 覆盖；下载到 cache，zip 解压后把包含 `llama-server.exe` 的目录内容平铺到 `engine/`；进度事件 `app.emit("download-progress", ...)`。失败文案给出手动放置说明（解压到 engine 目录）。
- 模型目录（已验证 URL）：
  | id | 文件 | 大小 | 说明 |
  | --- | --- | --- | --- |
  | `qwen2.5-0.5b` | qwen2.5-0.5b-instruct-q4_k_m.gguf | 491,400,032 | 轻量（低配机器） |
  | `qwen2.5-1.5b` | qwen2.5-1.5b-instruct-q4_k_m.gguf | 1,117,320,736 | 推荐 |
  | `qwen2.5-3b` | qwen2.5-3b-instruct-q4_k_m.gguf | 2,104,932,768 | 质量优先 |
  - HF：`https://huggingface.co/Qwen/Qwen2.5-<X>B-Instruct-GGUF/resolve/main/<file>`；ModelScope：`https://modelscope.cn/models/Qwen/Qwen2.5-<X>B-Instruct-GGUF/resolve/master/<file>`。
  - 许可证均 Apache-2.0；`installed` = models 目录中存在同名文件。
- 单测：SSE 解析、URL 归一化、错误映射、catalog 完整性、模型文件名/大小常量；不联网（用 mock 服务的需标 ignored 或用本地 axum? 不允许新增依赖，直接单测纯函数）。

### 6.2 `selection.rs`（T2，可拆 `selection/*.rs`）

```rust
pub struct PickerPayload { text, program_name, anchor_x, anchor_y, scale_factor, config: serde_json::Value } // camelCase
pub struct SelectionService {
  pub fn new(settings: Arc<SettingsStore>, logger: Logger) -> Self;
  pub fn start(&self, app: tauri::AppHandle);                 // 启动 rdev 钩子线程
  pub fn apply_settings(&self, settings: &Settings);          // 热更新
  pub fn trigger_from_hotkey(&self);                          // 快捷键路径
  pub fn set_picker_visible(&self, visible: bool);
  pub fn set_panel_pinned(&self, pinned: bool);
  pub fn last_selection(&self) -> Option<PickerPayload>;
  pub fn is_panel_pinned(&self) -> bool;
}
```

实现要求：
- `rdev::listen` 专用线程；回调只做状态判断 + channel send（<300ms）。键盘组合按 `settings.picker.shortcut` 解析（Ctrl/Shift/Alt + 字母/数字/F1-F12），鼠标左键按下记录起点，抬起位移 ≥6 物理像素才触发；同文本 400ms 去重；捕获进行中不重复触发。
- 忽略：`picker.enabled=false`、自身进程（`std::process::id()` 对应 exe 名 `lingopick.exe`）、黑名单进程（大小写/.exe 容错）、空文本、写剪贴板回退关闭（不做回退）。
- UIA 取词（移植 spike 代码，见 `E:\document\workspace\AIProjects\lingopick-spike\src\main.rs`）：`CoInitializeEx(MTA)` + `CoCreateInstance(CLSID_CUIAutomation8)` + `IUIAutomation2::SetConnectionTimeout(1500)/SetTransactionTimeout(1000)`；`GetFocusedElement` → TextPattern → `GetSelection` → `GetText(8192)`；失败重试 2 次（间隔 150ms）；无 TextPattern 时用 `ElementFromPoint(mouse)` 向上找最多 6 层；**每次取词在独立线程执行，recv_timeout(1500ms) 看门狗，超时放弃该线程（不 join）并返回失败**。
- 锚点：鼠标物理坐标（释放点）；`scale_factor` 用 `win32::monitor_scale_factor(anchor_x, anchor_y)`；`config` 来自 settings 的 skills/compact/defaultTargetLang；随后调用 `crate::windows::show_picker(&app, &payload)`，并更新 `last_selection`。
- 外部点击隐藏：picker 可见且未固定时，全局左键按下若在 picker 窗口外 → `windows::hide_picker(&app)`；picker 内点击不隐藏。
- 隐藏时 `picker_hidden` 由 windows/main 层处理；本模块只负责判定。

### 6.3 `windows.rs` / `tray.rs` / `commands.rs` / `state.rs` / `main.rs`（T4）

- `windows::show_settings(app)`：显示/聚焦 settings（最小化还原）。
- `windows::show_picker(app, payload) -> bool`：按物理锚点 + 该显示器 scale 计算逻辑坐标，初始 440×56，`x = anchor/scale - 40`（限制工作区）、`y = anchor/scale + 12`，下方放不下翻到上方；clamp 到工作区；`show` + `set_focus`；`app.emit_to("picker","picker-data", payload)`；记录最近 payload 供 `picker_ready` 补发。
- `windows::resize_picker(app, w, h) -> Option<bounds>`：clamp 宽度 200–780、高度 40–620，保持左上/工作区内；设置 LogicalSize/Position 后返回最终 bounds；菜单/面板依赖此语义避免裁剪。
- `windows::hide_picker(app)`：隐藏 + 清空 pinned + emit `picker-hidden`。
- `is_picker_visible` / `picker_scale_factor`。
- tray 菜单：显示设置、启用划词（勾选，更新 settings）、本地引擎状态（未启动可「启动本地模型」）、退出。
- 主窗口（settings）关闭：`app.closeToTray=true` 则隐藏，否则退出（关闭事件在 main.rs 处理）。
- `picker` 窗口：blur 时若未 pinned 则隐藏；close 请求一律 prevent。
- 首次运行打开设置窗口；`--show` 参数强制显示；其余启动进托盘。
- 应用退出：停 llama-server、停钩子、注销托盘。
- 单实例：第二次启动聚焦设置窗口。
- 开机自启：`tauri-plugin-autostart`；portable（`PORTABLE_EXECUTABLE_DIR`）时 `supported=false`。
- 命令实现 §5.1/5.2；`update_settings` 后广播 `state-changed`、热更新 selection、刷新托盘。
- 翻译流：`picker_translate` 中 abort 旧任务，`spawn` 任务消费 `engine.translate_stream`，逐块 `emit_to("picker","translate-event", {requestId,type:"chunk",text})`，结束 `done`，错误 `error+message`；`picker_abort_translate` abort。
- 下载进度：把 `app.emit("download-progress", progress)` 传进 engine（engine 的 download 接口已收 AppHandle）。

### 6.4 脚本/CI（T4）

- `scripts/fetch-llama.ps1`：下载/解压引擎到 `src-tauri/../data/engine`（dev 用）或指定目录；支持 `-FromDir <已有llama.cpp目录>`；SHA 不校验但校验 zip 大小/解压后存在 llama-server.exe。
- `scripts/build-portable.ps1`：`npx tauri build --no-bundle` → 取 `src-tauri/target/release/lingopick.exe`；可选 `-WithEngine` 把引擎 zip 一起放入包内；产出 `dist/LingoPick-<version>-win-x64.zip`（含 exe、README-PORTABLE.txt、可选 engine/）。
- `.github/workflows/ci.yml`：push/PR：windows-latest，setup node 22 + Rust stable，`npm ci`（无 lock 则 npm install），`cargo test`，`tauri build --no-bundle`（不下载大模型）。
- `release.yml`：tag `v*` 触发，构建并上传 zip 到 GitHub Release。

## 7. 前端规范（T3）

### 7.1 picker（复刻现有 UI）
- 从 `enterprise-ai-translator/electron/picker.html|picker.css|picker.js` 复制并改造：保留白主题工具栏、图标+文字、更多菜单、结果面板（标题/固定/关闭/语言选择）、loading 原文、流式译文、面板脚（朗读/复制/重试）、错误面板、toast、Escape 层级、面板固定、内容自适应。
- API 层换成 `web/shared/tauri-api.js`：
  - 实现 `window.pickerAPI`：`ready/onData/onHidden/close/pin/resize/copy/openSettings/translate/abortTranslate/onTranslateEvent/assist/status/disableInApp/disableTool` 映射到 §5.2 命令与 §5.3 事件（`listen` 返回 unlisten）。
  - 翻译：`invoke("picker_translate", {requestId,text,targetLang})` 返回错误时展示错误面板；`translate-event` 处理 chunk/error/done。
  - 朗读：仅用 `window.speechSynthesis`（Windows 系统语音）；无语音时提示「系统未安装可用的语音包：Windows 设置 → 时间和语言 → 语音」。
  - 菜单「划词设置…」→ `invoke("picker_open_settings")`；「在此应用中禁用」「禁用划词工具」→ 对应命令。
- 初始尺寸 440×56，白色卡片边缘透明；`picker_ready` 在 DOM 就绪后调用一次。

### 7.2 设置页（新建，简洁好用）
- 单窗口、原生标题栏、单页四张卡片（无侧栏/标签页）：**翻译服务**、**划词行为**、**应用与启动**、**关于**。
- 翻译服务：
  - 分段控件「在线 API / 本地模型」立即保存 mode。
  - 在线：预设下拉（DeepSeek/OpenAI/Moonshot/智谱/Ollama/LM Studio/自定义，切换填默认 baseUrl/model）、服务地址、API Key（password + 显示切换）、模型名、[测试连接]（显示延迟/模型列表/错误）、状态徽标。
  - 本地：引擎状态（未安装→[下载引擎]，显示进度/取消；已安装→版本状态）、模型下拉（已安装）、[下载模型]（弹目录列表：名称/大小/量化/协议/推荐标记/下载按钮+进度）、[导入 GGUF]、[启动]/[停止]、当前状态徽标与错误提示。
- 划词行为：启用开关、快捷键录制框（按下组合键显示 `Ctrl+Shift+D`，Esc 取消）、技能开关+顺序（上下移动）、紧凑模式、默认目标语言、黑名单 chip 输入（回车添加/可删除）。
- 应用与启动：开机自启（portable 不支持时置灰说明）、关闭窗口后驻留托盘、打开数据/模型/日志/引擎目录、退出程序。
- 关于：版本、Tauri/Rust 版本、MIT、GitHub 链接、引擎与模型状态。
- 交互：改动即自动保存（文本 500ms 防抖），顶部短暂「已保存」；错误内联不弹模态；下载进度实时更新。
- 视觉：系统字体栈 `Segoe UI`/`Microsoft YaHei UI`；背景 `#f6f7f9`，卡片白 + 1px `#e5e7eb` 边框 + 12px 圆角；主色 `#4f46e5`；支持 `prefers-color-scheme: dark`；控件高 32–36px；不用渐变/大阴影。
- 安全：HTML 带 CSP（`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'`），无内联脚本；外链经 `open_external`。

## 8. 验收

- `cargo test`（设置、SSE、catalog、日志脱敏等纯函数）通过。
- `cargo check` 无错误；`npx tauri build --debug --no-bundle` 产出 exe。
- 启动 exe：托盘出现；首次运行弹设置；快捷键/拖选在某应用触发 picker；picker 菜单/面板/固定/关闭可用。
- 在线模式：填 mock/真实 OpenAI 兼容服务后「测试连接」成功；picker 翻译流式显示。
- 本地模式：安装引擎 + 下载/导入 Qwen2.5 GGUF 后启动成功，翻译流式返回；总结/解释可用。
- 构建 release：`scripts/build-portable.ps1` 产出免安装 zip；解压运行，托盘后台运行，数据写入 exe 同级 data/。
