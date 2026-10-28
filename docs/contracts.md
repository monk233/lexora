# Lexora 工程契约（Tauri v2 版）

本文件是并行开发期间的唯一接口契约。**实现必须与本文一致**；需要调整先通知 Lead 改本文件，再改代码。Electron 版设计稿（设置页字段、picke r行为）仍适用，技术栈已切换为 **Tauri v2 + Rust + 原生 HTML/CSS/JS**。

## 1. 目标与决策

把 `enterprise-ai-translator` 的划词工具抽取为独立开源 Windows 免安装应用 **Lexora**：

- 完整保留划词体验：拖动选词、双击/多击选词自动弹出工具栏；翻译（流式）、总结、解释、朗读、复制；结果面板（固定/关闭/目标语言/重试，头部可拖动窗口）；菜单（本应用禁用、设置、禁用工具）；应用黑名单；技能配置/拖拽排序/提示词编辑；紧凑模式；多屏 DPI 定位；面板按内容缩放。全局快捷键已移除。
- 双模式翻译：**在线**（任意 OpenAI 兼容 `/v1/chat/completions`，含 Ollama/LM Studio、OpenCode Go）与**本地**（内置 llama.cpp 引擎 = 按需下载，自管理 `llama-server.exe` + 用户下载/导入 GGUF）。
- 系统托盘后台运行、单实例、可选开机自启；关闭设置窗口进托盘。
- 免安装：`tauri build --no-bundle` 产出的单 exe（约 5–10MB）+ 可下载引擎/模型；发布资产直接是 exe（不再打 zip）。
- 无 Python / WebView2 安装包依赖（Win10 现代版本自带）。
- 原 enterprise-ai-translator 仓库保持不动。

已验证（见 `docs/spike-report.md`）：Rust 原生 UIA 取词在 Notepad/Chrome/Edge/Word 成功，5–30ms 热路径；150% DPI 下物理/逻辑坐标换算已确认。

## 2. 目录与归属（写作用域）

```
lexora/
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
│  └─ shared/{constants.js,skill-icons.js,lang.js,markdown.js,tauri-api.js}
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

- `LEXORA_DATA_DIR` 环境变量 > debug 模式 `<repo>/data` > `<exe目录>/data`（可写时） > `%APPDATA%\Lexora`。
- `LEXORA_MODEL_DIR` / `LEXORA_LLAMA_DIR` 覆盖模型/引擎目录。
- 结构：`settings.json`、`models/*.gguf`、`engine/llama-server.exe`、`logs/main.log`、`logs/model.log`、`logs/llama.log`、`cache/*.part`。

## 4. 设置 Schema（已实现 `settings.rs`，camelCase JSON）

```jsonc
{
  "version": 7,                              // v1→v2 补 polish/search；v2→v3 补 screenshot；v3→v4 补 capture；v4→v5 补 captureSkills/capturePrompts；v5→v6 把本地工具（pin/形状/箭头/画笔/文字/序号/马赛克/长截图）纳入 captureSkills 并移除 copy；保留 custom；v6→v7 增加 provider.local.selectedModel，旧配置迁移为空选择
  "picker": {
    "enabled": true,
    "skills": ["translate","summarize","explain","read","copy","search"],
    "compact": true,
    "defaultTargetLang": "auto",          // auto + 38 种翻译目标语言（zh/en/zh-hant/yue/ja/…/ug）；auto 显示为「自动识别」
    "blacklist": [],                      // 进程名，可含 .exe
    "maxChars": 5000,
    "searchEngine": "google",             // google | baidu | bing（搜索技能）
    "panelMode": "auto",                  // auto = 无滚动条、窗口随内容变高；scroll = 固定窗口、面板内滚动
    "captureSkills": ["pin","shape","arrow","pen","text","mosaic","ocr","translate","explain"], // 截图工具条有序条目（放在工具条上的全部按钮，可任意开关/排序）：本地工具 pin/shape/arrow/pen/text/number/mosaic/longshot + AI/动作 ocr/translate/explain + 已启用自定义图片技能 id（custom-*）；copy 不再是工具条条目（确认=复制并退出）；显式 [] = 只保留撤销/重做/取消/确认
    "capturePrompts": {                    // 截图「翻译」「解释图片」的系统提示词覆写；空=系统默认
      "translate": "",                     // 支持 {target} / {language}
      "explain": ""
    }
    "panelPinned": false,                 // 记住「钉住到桌面」偏好：后续结果面板默认钉住
    "prompts": {                          // 空字符串 = 使用系统默认提示词
      "translate": "",
      "summarize": "",
      "explain": "",
      "polish": ""
    },
    "customSkills": [                     // 用户自定义技能；prompt 必填
      {
        "id": "custom-mvmei8cru1n5",       // ^custom-[a-z0-9_-]{1,40}$，全局唯一
        "label": "提取关键词",              // <=20 字符
        "icon": "sparkles",                // 任意 Lucide key（^[a-z0-9-]{1,40}$，200 个可选）或旧 12 别名
        "kind": "text",                    // text | image；图片技能在截图中执行
        "prompt": "请从用户选中的文本中提取 5 个关键词：{text}"  // <=4000；支持 {text}/{target}/{language}/{program}/{app}
      }
    ]
  },
  "provider": {
    "mode": "online",                     // online | local
    "online": { "preset": "deepseek", "baseUrl": "https://api.deepseek.com/v1", "apiKey": "", "model": "deepseek-chat",
                "timeoutMs": 60000, "temperature": 0.2, "maxTokens": 1024 },
    "local": { "selectedModel": "", "contextSize": 4096, "threads": 0, "gpuLayers": 0, "autoStart": true, "keepRunning": false }
  },
  "app": { "closeToTray": true, "startAtLogin": true, "theme": "system" },
  "capture": {
    "regionShortcut": "Win+Shift+X"       // 截图快捷键（可改）；规范格式见 §10.3，非法值回退默认
  }
}
```

本地模型选择字段：`settings.provider.local.selectedModel`（序列化路径为 `provider.local.selectedModel`）保存唯一本地模型选择；默认空字符串，v6→v7 迁移不自动填入模型。硬件检测只提供推荐标签和理由，不自动选择。

新配置和恢复默认采用上述开关与内置技能默认值（自定义技能仍保留定义与启用状态）；已保存的显式选择及顺序不变。旧配置缺失 skills/captureSkills 时沿用历史完整技能集合，缺失 compact/startAtLogin 时仍为 false；历史版本迁移保持原策略，不因新默认重新开启已关闭技能。

规则：归一化永不失败；非法值回退默认。运行时环境变量覆盖：`LEXORA_API_KEY`（覆盖 apiKey）、`LEXORA_LLAMA_URL`（引擎下载地址覆盖）、`LEXORA_UPDATE_API`（自更新 Release API 覆盖，仅测试用；覆盖时允许本地 http）。

## 5. 前端 ↔ Rust 契约（T3/T4 共同遵守）

前端通过 `window.__TAURI__.core.invoke(command, args)` 与 `window.__TAURI__.event.listen(event, cb)`（`withGlobalTauri: true`）。命令名 snake_case，参数 camelCase，返回统一 `{ok,...}` 或抛出错误字符串由 Tauri 包装（前端 `try/catch` 取 `String(error)`）。

### 5.1 设置窗口命令

| command | args | 返回 |
| --- | --- | --- |
| `get_state` | — | `StatePayload` |
| `update_settings` | `{patch: object}` | `{state: StatePayload}`（失败 reject 字符串） |
| `reset_settings` | — | `{state}`（保留自定义技能定义与启用状态；其余恢复默认） |
| `test_online` | `{baseUrl, apiKey, model, timeoutMs}` | `TestResult` |
| `list_online_models` | `{baseUrl, apiKey}` | `{models: string[]}` |
| `download_engine` | — | `{ok}`（进度走 `download-progress` 事件） |
| `download_model` | `{id: string}` | `{ok, error?}` |
| `cancel_download` | `{id?: string}` | `{ok}`（id 为模型 id 或 `engine`；省略则取消全部） |
| `import_model` | — | `{ok, model?, error?}`（Rust 弹原生文件对话框） |
| `remove_model` | `{file: string}` | `{ok, error?}` |
| `start_local` / `stop_local` | — | `{ok, error?, hint?}` |
| `open_dir` | `{which: "data"|"models"|"logs"|"engine"}` | `{ok}` |
| `open_external` | `{url: string}` | `{ok}`（仅 https） |
| `set_start_at_login` | `{enabled: boolean}` | `{ok, error?}` |
| `quit_app` | — | — |
| `check_update` | — | `{ok, currentVersion, latestVersion, hasUpdate, assetName, assetUrl, notes, publishedAt, sizeBytes, error?, hint?}` |
| `install_update` | — | `{ok, version, error?, hint?}`（下载并替换当前 exe，约 1s 后应用退出并由助手脚本重启新版本） |

### 5.2 划词窗口命令

| command | args | 返回 |
| --- | --- | --- |
| `picker_ready` | — | `{ok}`（renderer 初始化完成；Rust 若有待展示数据则补发 `picker-data`） |
| `picker_close` | — | `{ok}` |
| `picker_pin` | `{pinned: boolean, remember?: boolean}` | `{ok, pinned}`（remember=true 时持久化 picker.panelPinned） |
| `picker_panel_state` | `{open: boolean}` | `{ok}`（面板打开时键盘/右键不再隐藏；点击外部未钉住仍隐藏） |
| `picker_activate` | `{active: boolean}` | `{ok}`（按需让 picker 可获取键盘焦点，用于继续提问输入） |
| `picker_resize` | `{width, height}` | `{x,y,width,height} \| null`（Rust 已应用 bounds 后返回逻辑像素） |
| `picker_drag_panel` | `{dx, dy}` | `{ok, x?, y?}`（逻辑像素 delta 移动窗口，面板标题栏拖动） |
| `picker_copy` | `{text: string}` | `{ok}` |
| `picker_open_settings` | — | `{ok}` |
| `picker_translate` | `{requestId, text, targetLang}` | `{ok, error?, hint?}`（随后 `translate-event` 流） |
| `picker_custom_skill` | `{requestId, skillId, text, programName}` | `{ok, error?, hint?}`（随后 `translate-event` 流；target 取设置默认目标语言） |
| `picker_polish` | `{requestId, text}` | `{ok, error?, hint?}`（随后 `translate-event` 流；内置润色技能） |
| `picker_abort_translate` | `{requestId}` | `{ok}` |
| `picker_assist` | `{requestId, action: "summarize"|"explain", text}` | `{ok, error?, hint?}`（随后 `translate-event` 流；总结/解释不再一次性返回） |
| `start_capture` | `{presetSkillId?: string}` | `{ok, monitors?, error?, hint?}`（隐藏 picker/设置，抓取所有显示器并创建 capture-* overlay） |
| `capture_monitor_info` | `{index: number}` | `{ok, dataUrl, width, height, index, preset?: {skillId,label}}`（PNG data URL，物理像素） |
| `capture_ready` | `{index: number}` | `{ok}`（overlay 已绘制截图后显示窗口；见 §10.1） |
| `capture_copy` | `{index, rect: {x,y,width,height}}` | `{ok, error?, hint?}`（crop→图片剪贴板→关闭 overlay） |
| `capture_skill` | `{requestId, index, rect, action: "ocr"|"translate"|"explain"|"custom", skillId?, targetLang?}` | `{ok, clipboard, error?, hint?}`（关闭 overlay→图片入剪贴板→picker 面板流式；见 §10.3） |
| `capture_retry` | `{requestId}` | `{ok, error?, hint?}`（用上一次截图重跑；`translate-event` 流） |
| `capture_followup` | `{requestId, question, previousAnswer, history}` | `{ok, error?, hint?}`（截图面板继续提问；`translate-event` 流） |
| `capture_close` | — | `{ok}`（销毁所有 capture-* overlay） |
| `capture_set_hotkey` | `{shortcut: string}` | `{ok, shortcut, error?, hint?}`（截图快捷键热更新；见 §10.4） |
| `generate_followups` | `{requestId, skill, source, initialAnswer, history:[{question,answer}]}` | `{ok:true, requestId, suggestions:string[]}`（独立非流式建议，最多 3 条；不可用、取消、失败或输出无效时为空列表） |
| `cancel_followups` | `{requestId}` | `{ok:true}` 或 `{ok:false,error}`（仅取消对应建议任务并等待其退出，最长等待 10 秒） |
| `picker_followup` | `{requestId, text, previousAnswer, question, history: [{question,answer}]}` | `{ok, error?, hint?}`（随后 `translate-event` 流；面板继续提问） |
| `picker_status` | — | `{mode, ready, configured, providerLabel, localState, hint}` |
| `picker_disable_in_app` | `{programName}` | `{ok, error?}` |
| `picker_disable_tool` | — | `{ok, error?}` |

### 5.3 事件（Rust → 前端）

| event | 目标 | payload |
| --- | --- | --- |
| `state-changed` | settings | `StatePayload` |
| `download-progress` | settings | `DownloadProgress`（可并发多个：engine 与各模型独立） |
| `update-progress` | settings | `{status:"downloading"\|"ready", received, total, percent}` |
| `toast` | settings | `{type:"success"|"error"|"info", message}` |
| `picker-data` | picker | `{text, programName, config:{skills,customSkills,compact,defaultTargetLang,searchEngine,suggestionsAvailable:boolean}}` |
| `picker-image` | picker | `{requestId, action, skillId, label, targetLang, clipboard, hint?}`（截图技能转结果面板；见 §10.5） |
| `capture-armed` | capture-* | `{index}`（overlay 窗口复用：新截图已就绪，页面重新初始化并拉取截图；见 §10.1） |
| `picker-hidden` | picker | `{}` |
| `translate-event` | picker | `{requestId, type:"chunk"|"error"|"done", text?, message?}` |

### 5.4 StatePayload

```jsonc
{
  "app": { "name":"Lexora", "version":"0.1.0", "platform":"windows", "packaged":true, "portable":false,
           "dataDir":"...", "modelsDir":"...", "logsDir":"...",
           "repoUrl":"https://github.com/monk233/lexora", "license":"MIT" },
  "settings": { /* §4 */ },
  "engine": {
    "mode":"online", "ready":true, "hint":"", "providerLabel":"在线 · deepseek-chat",
    "onlineConfigured":true,
    "localState":"stopped",           // stopped|starting|ready|error
    "localModelFile":"", "localModelName":"", "localError":"", "engineAvailable":false
  },
  "models": [ {"file":"qwen2.5-1.5b-instruct-q4_k_m.gguf","name":"qwen2.5-1.5b-instruct-q4_k_m",
               "path":"...","sizeBytes":1117320736,"modifiedAt":1760000000000,"catalogId":"qwen2.5-1.5b"} ],
  "catalog": [ {"id":"qwen3.5-2b-q3-k-m","name":"Qwen3.5 2B Q3_K_M（翻译 / 通用 / 视觉）","description":"...","filename":"...",
                "sizeBytes":1117320736,"license":"Apache-2.0","languages":"多语言","recommended":true,"installed":false,"vision":true} ],
  "downloads": [],   // 正在进行的下载（可多个）
  "picker": {"visible":false,"pinned":false},
  "loginItem": {"supported":true,"enabled":false},
  "promptDefaults": {                       // 系统默认提示词，供设置页 textarea 预填
    "translate": "You are a professional translation engine. Translate the user's text into {target}. ...",
    "summarize": "You are a concise Chinese writing assistant. ...",
    "explain": "You are a knowledge assistant. ..."
  }
}
```

`DownloadProgress`：`{kind:"engine"|"model", id, filename, received, total, percent, status:"downloading"|"verifying"|"failed"|"cancelled", error}`；同一时间可存在多个条目（不同模型并发下载，engine 也独立）。

### 5.5 PickerData.config

`{"skills":["translate","summarize","explain","polish","read","copy","search","custom-xxx"],"customSkills":[{"id":"custom-xxx","label":"提取关键词","icon":"sparkles"}],"compact":false,"defaultTargetLang":"auto","searchEngine":"google"}`。customSkills 只下发已启用技能的元数据（不含 prompt）。

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
  pub async fn assist_stream(&self, action:&str, text:&str)
      -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError>;
  pub async fn followup_stream(&self, text:&str, previous:&str, question:&str, history:&[(String, String)])
      -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError>;
  pub async fn custom_stream(&self, skill_id:&str, text:&str, target_lang:&str, program:&str)
      -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError>;
  pub async fn polish_stream(&self, text:&str)
      -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError>;
  pub async fn test_online(&self, base_url:&str, api_key:&str, model:&str, timeout_ms:u64) -> TestResult;
  pub async fn list_online_models(&self, base_url:&str, api_key:&str) -> Result<Vec<String>, EngineError>;
  pub fn installed_models(&self) -> Vec<ModelInfo>;
  pub fn catalog(&self) -> Vec<CatalogEntry>;
  pub fn download_state(&self) -> Vec<DownloadProgress>;
  pub async fn download_model(&self, app: tauri::AppHandle, id:&str) -> Result<ModelInfo, EngineError>;
  pub async fn install_engine(&self, app: tauri::AppHandle) -> Result<(), EngineError>;
  pub fn cancel_download(&self, id: Option<&str>);
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
- 本地：
  - `LocalRole::Translate` / `General` / `Vision` 共用 `settings.provider.local.selectedModel` 的手动选择。未选择时返回明确提示；缺少文件时提示安装对应模型，不回退到旧 Qwen2.5 或其他已安装 GGUF。
  - 用户手动选择唯一本地模型并持久化；硬件检测仅显示推荐标签和理由，不替用户选择。切换选择后需重启本地引擎。
  - 「停止」后 `local_desired=false`，后续请求**绝不自动启动**引擎，只返回「本地模型未启动」错误提示。所有本地 AI 任务复用用户手动选择的同一 Qwen3.5，不再按翻译与通用角色切换模型。
- 运行状态记忆：用户点「启动」成功后持久化 provider.local.keepRunning=true；点「停止」置 false；应用退出只停 llama-server，不改 keepRunning。下次启动若为 true 且引擎/模型已安装，后台自动恢复引擎（日志 `restoring local engine`）并通过 state-changed 刷新设置页与托盘。
  - 未安装引擎 → 错误提示「下载 llama.cpp 引擎」；未安装模型 → 「下载/导入 GGUF」；启动前选空闲端口（TcpListener 127.0.0.1:0），`llama-server.exe -m <model> --host 127.0.0.1 --port <p> -c <ctxSize> -t <threads> -ngl <gpuLayers> --no-webui`，轮询 `/health` 最长 90s，stderr 写 `logs/llama.log`；进程退出/应用退出要清理；服务就绪后复用在线客户端逻辑。
- 提示词（系统默认值为英文，用户可在设置里逐个技能自定义，空字符串表示用默认）：
  - 翻译 system：`You are a professional translation engine. Translate the user's text into {target}. Output only the translation, without explanations, quotes, or the source text.`；`{target}`/`{language}` 替换为英文语言名（38 种翻译目标语言，如 Simplified Chinese / Traditional Chinese / Portuguese / Uyghur），自定义提示词若不含占位符则在末尾追加 `Target language: <name>.`。
  - 总结 system：`You are a concise Chinese writing assistant. Summarize the user's text in Simplified Chinese and list the key points accurately, without adding anything that is not in the source.`
  - 解释 system：`You are a knowledge assistant. Explain the user's text in Simplified Chinese, covering its meaning, background and key concepts, with short examples when helpful.`
  - 文本截断：翻译取前 `picker.maxChars`；总结/解释取前 8000 字符；自定义提示词归一化后最多 4000 字符。
  - 自定义技能：从 `picker.customSkills` 按 id 查找（不存在/未启用返回明确错误），`prompts::render_custom_prompt` 把 `{text}`（选中文本）、`{target}`/`{language}`（目标语言英文名）、`{program}`/`{app}`（当前应用名，空为「未知应用」）替换进提示词；未知 `{...}` 原样保留；system 为渲染后的提示词，user 为选中文本；本地模型角色使用 General；流式事件与翻译一致。
  - 内置润色：`prompts::polish_messages(text, custom)` 优先使用 `picker.prompts.polish`，空则用 `DEFAULT_POLISH_PROMPT`（英文）；截断 `picker.maxChars`；General 角色；流式事件与翻译一致。
- 引擎下载：默认 URL `https://github.com/ggml-org/llama.cpp/releases/download/b11851/llama-b11851-bin-win-cpu-x64.zip`（23.1MB，已验证存在），可用 `LEXORA_LLAMA_URL` 覆盖；下载到 cache，zip 解压后把包含 `llama-server.exe` 的目录内容平铺到 `engine/`；进度事件 `app.emit("download-progress", ...)`。失败文案给出手动放置说明（解压到 engine 目录）。
- 模型目录（仅六种 Qwen3.5，均使用 ModelScope）：
  | 模型 | 量化 | 能力 | 配套文件 |
  | --- | --- | --- | --- |
  | Qwen3.5 0.8B | Q4_K_M / Q3_K_M | 翻译 / 通用 / 视觉，手动选择 | 对应 mmproj-F16 |
  | Qwen3.5 2B | Q4_K_M / Q3_K_M | 翻译 / 通用 / 视觉，手动选择 | 对应 mmproj-F16 |
  | Qwen3.5 4B | Q4_K_M / Q3_K_M | 翻译 / 通用 / 视觉，手动选择 | 对应 mmproj-F16 |
  - Qwen3.5：`https://www.modelscope.cn/models/unsloth/Qwen3.5-{0.8B|2B|4B}-GGUF/resolve/master/<file>`；每个仓库的远程投影器名均为 `mmproj-F16.gguf`，本地按规格使用唯一名称，避免互相覆盖。
  - 许可证均 Apache-2.0；空下载 URL 跳过。Qwen3.5 的 `installed` 要求主文件和对应投影器都存在；主模型完成后继续下载投影器。
  - 本地模型迁移兼容：旧 Hy-MT2 和 Qwen2.5 文件不自动删除，仅作为「其他本地模型」显示并支持手动删除，不再提供内置下载、自动选择或推荐。所有本地 AI 任务使用 `provider.local.selectedModel` 手动选择的 Qwen3.5；未选择时本地 AI 不可用，追问建议与入口静默隐藏。
- 模型调用日志：`logs/model.log` 每次请求记录 call id、操作、provider、model、输入规模、开始、完成/失败/取消、耗时、分块数与输出字符数；不记录提示词或模型正文。`main.log`、`model.log`、`llama.log` 使用应用日志器，单文件写入达到 10MB 时滚动为 `.1`，只保留当前文件与一个最近分卷，更早分卷自动删除。
- SSE 空结果：若收到 `[DONE]`/EOF 但从未产生可见正文，必须返回错误，不能作为成功流结束。检测到仅 `reasoning_content`/`reasoning` 时提示推理模型可能耗尽最大输出 token；普通在线空响应提示重试、提高 token 或更换模型。单测覆盖 SSE 解析、空结果、URL 归一化、错误映射与 catalog 完整性。

### 6.2 `selection.rs`（T2，可拆 `selection/*.rs`）

```rust
pub struct PickerPayload { text, program_name, anchor_x, anchor_y, scale_factor, config: serde_json::Value } // camelCase
pub struct SelectionService {
  pub fn new(settings: Arc<SettingsStore>, logger: Logger) -> Self;
  pub fn start(&self, app: tauri::AppHandle);                 // 启动 rdev 钩子线程
  pub fn apply_settings(&self, settings: &Settings);          // 热更新
  pub fn set_picker_visible(&self, visible: bool);
  pub fn set_panel_pinned(&self, pinned: bool);
  pub fn last_selection(&self) -> Option<PickerPayload>;
  pub fn is_panel_pinned(&self) -> bool;
}
```

实现要求：
- `rdev::listen` 专用线程；回调只做状态判断 + channel send（<300ms）。全局快捷键已移除，触发方式只有鼠标：
  - 抬起位移 ≥6 物理像素：拖动选词，触发 `TriggerSource::Mouse`；
  - 抬起位移 <6 物理像素：按多击处理（与上次释放同点 ±6px 且间隔 ≤ `GetDoubleClickTime()` 时计数 +1），计数 ≥2 时触发 `TriggerSource::Click`，即双击/三击选词也能弹出工具栏；单次点击绝不触发 UIA。
  - 同文本 400ms 去重；捕获进行中不重复触发。
- 忽略：`picker.enabled=false`、自身进程（`std::process::id()` 对应 exe 名 `lexora.exe`）、黑名单进程（大小写/.exe 容错）、空文本、写剪贴板回退关闭（不做回退）。
- UIA 取词（移植 spike 代码，见 `E:\document\workspace\AIProjects\lingopick-spike\src\main.rs`）：`CoInitializeEx(MTA)` + `CoCreateInstance(CLSID_CUIAutomation8)` + `IUIAutomation2::SetConnectionTimeout(1500)/SetTransactionTimeout(1000)`；`GetFocusedElement` → TextPattern → `GetSelection` → `GetText(8192)`；失败重试 2 次（间隔 150ms）；无 TextPattern 时用 `ElementFromPoint(mouse)` 向上找最多 6 层；**每次取词在独立线程执行，recv_timeout(1500ms) 看门狗，超时放弃该线程（不 join）并返回失败**。
- 锚点：鼠标物理坐标（释放点）；`scale_factor` 用 `win32::monitor_scale_factor(anchor_x, anchor_y)`；`config` 来自 settings 的 skills/compact/defaultTargetLang；随后调用 `crate::windows::show_picker(&app, &payload)`，并更新 `last_selection`。
- 外部点击隐藏：picker 可见且未固定时，全局左键按下若在 picker 窗口外 → `windows::hide_picker(&app)`；picker 内点击不隐藏。
- 不打断用户操作：picker 是 **非激活窗口**（`focusable: false`，`WS_EX_NOACTIVATE`），显示时不抢前台焦点，因此 Delete / Ctrl+C / Ctrl+X 等按键仍作用于用户原来的应用。未固定时，收到任意键盘输入、右键/中键 → `ActionRequest::DismissOnInput`，由动作线程自动隐藏工具栏；面板已固定时保持显示。**鼠标滚轮/触摸板滚动不隐藏工具栏**：滚轮事件照常送达光标下窗口（面板内滚动长内容，host 应用滚动页面），工具栏与功能面板保持显示。
- 隐藏时 `picker_hidden` 由 windows/main 层处理；本模块只负责判定。

### 6.3 `windows.rs` / `tray.rs` / `commands.rs` / `state.rs` / `main.rs`（T4）

- `windows::show_settings(app)`：显示/聚焦 settings（最小化还原）。
- `windows::show_picker(app, payload) -> bool`：按物理锚点 + 该显示器 scale 计算逻辑坐标，初始 440×56，`x = anchor/scale - 40`（限制工作区）、`y = anchor/scale + 12`，下方放不下翻到上方；clamp 到工作区；`show`（**不调用 `set_focus`**，picker 窗口配置 `focusable: false`）；`app.emit_to("picker","picker-data", payload)`；记录最近 payload 供 `picker_ready` 补发。
- `windows::resize_picker(app, w, h) -> Option<bounds>`：不再有 200–780×40–620 人工限制；非法/非正尺寸回退基础尺寸，合法值 1..=100000，位置 clamp 到**虚拟桌面**（所有显示器）内，面板可跨屏；设置 LogicalSize/Position 后返回最终 bounds。
- `windows::move_picker_by(app, dx, dy) -> Option<(f64, f64)>`：按逻辑像素 delta 移动 picker 窗口（结果面板标题栏拖动），clamp 到**虚拟桌面**（所有显示器）内，可自由拖到任意显示器，返回新的逻辑左上角坐标。
- `windows::hide_picker(app)`：隐藏 + 清空 pinned + emit `picker-hidden`。
- `is_picker_visible` / `picker_scale_factor`。
- tray 菜单：显示设置、启用划词（勾选，更新 settings）、本地引擎状态（未启动可「启动本地模型」）、退出。
- 主窗口（settings）关闭：`app.closeToTray=true` 则隐藏，否则退出（关闭事件在 main.rs 处理）。
- `picker` 窗口：blur 时若未 pinned 则隐藏；close 请求一律 prevent。
- 静默启动：双击 exe、开机自启都只在托盘挂载，不打开任何窗口；仅 `--show` 参数显式显示设置窗口。
- 应用退出：停 llama-server、停钩子、注销托盘。
- 单实例：第二次启动保持静默（不打开窗口）；第二次启动带 `--show` 时才显示设置窗口。
- 开机自启：`tauri-plugin-autostart`；portable（`PORTABLE_EXECUTABLE_DIR`）时 `supported=false`。
- 命令实现 §5.1/5.2；`update_settings` 后广播 `state-changed`、热更新 selection、刷新托盘。
- 翻译流：`picker_translate` 中 abort 旧任务，`spawn` 任务消费 `engine.translate_stream`，逐块 `emit_to("picker","translate-event", {requestId,type:"chunk",text})`，结束 `done`，错误 `error+message`；`picker_abort_translate` abort。
- 下载进度：把 `app.emit("download-progress", progress)` 传进 engine（engine 的 download 接口已收 AppHandle）。

### 6.4 `updater.rs`（自更新，Windows）

- 默认查询 `https://api.github.com/repos/monk233/lexora/releases/latest`（`User-Agent: Lexora/<版本>`，30s 超时）；测试可用环境变量 `LEXORA_UPDATE_API` 覆盖为本地 mock（覆盖时允许 http，仅本地测试使用）。应用启动 2 秒后由 Rust 后台静默检查一次，之后每 6 小时复查；发现较新版本时通过 Tauri notification 插件弹 Windows 系统通知，并把版本号写入数据目录 `update-notified-version` 去重。后台检查结果通过 `update-available` 推送设置页。自动检查失败不打断用户，手动检查仍显示错误。Release 正文按安全 Markdown 渲染，HTML 先转义，外链沿用 `open_external`。
- `UpdateInfo { currentVersion, latestVersion, hasUpdate, assetName, assetUrl, notes, publishedAt, sizeBytes }`（camelCase 序列化）；`version_is_newer` 按数字段比较，忽略 `v` 前缀与 prerelease/build。
- 资产选择：Release assets 中名称以 `Lexora-` 开头、含 `win-x64`、以 `.exe` 结尾的第一个；无资产时报错。
- `install_update`：重新 check → 校验 https（覆盖模式除外）→ 校验当前 exe 目录可写 → 流式下载到同目录临时文件（emit `update-progress`）→ 校验 MZ 头与大小 >1MB → 生成 `%TEMP%\lexora-update-*.ps1`（UTF-8 BOM，等待当前 pid 退出、把当前 exe 改名 `.old`、移动新 exe 到原路径、`Start-Process ... --show`，失败回滚并写 `update-error.log`）→ 隐藏窗口 spawn PowerShell → emit `ready` → 约 1.2s 后 `app.exit(0)`。
- 仅替换 exe，不动 exe 同级 `data/`；路径含空格/中文由脚本单引号转义处理。

### 6.5 脚本/CI（T4）

- `scripts/fetch-llama.ps1`：下载/解压引擎到 `src-tauri/../data/engine`（dev 用）或指定目录；支持 `-FromDir <已有llama.cpp目录>`；SHA 不校验但校验 zip 大小/解压后存在 llama-server.exe。
- `scripts/build-portable.ps1`：`npx tauri build --no-bundle` → 取 `src-tauri/target/release/lexora.exe`；复制为 `dist/Lexora-<version>-win-x64.exe`（单个 exe，不压缩、不打 zip；支持 `-SkipBuild`）。
- `scripts/release-notes.ps1`：从 `CHANGELOG.md` 对应版本小节生成排版化 Release 正文（缺失时退化为按 conventional-commit 分组的 git 提交列表）；`-OutputPath` 写出 Markdown。
- `.github/workflows/ci.yml`：仅 master/main 的 push 触发（PR 与非 master 推送不跑）；windows-latest，setup node 22 + Rust stable，`npm ci`（无 lock 则 npm install），`cargo test`，`tauri build --no-bundle`（不下载大模型）。
- `release.yml`：tag `v*` 触发；校验 tag 与 `tauri.conf.json` 版本一致，构建单 exe、生成 release notes、上传 exe 到 GitHub Release。

## 7. 前端规范（T3）

### 7.1 picker（复刻现有 UI）
- 从 `enterprise-ai-translator/electron/picker.html|picker.css|picker.js` 复制并改造：保留白主题工具栏、图标+文字、更多菜单、结果面板（标题/固定/关闭/语言选择）、loading 原文、流式译文、面板脚（朗读/复制/重试）、错误面板、toast、Escape 层级、面板固定、内容自适应。
- 更多菜单只保留「在此应用中禁用」「划词设置…」「禁用划词工具」三项；不显示翻译服务状态块，也没有「关闭」项。
- 技能过多溢出时，溢出技能按顺序列在菜单顶部（技能项），其后用一条分隔线与「在此应用中禁用 / 划词设置… / 禁用划词工具」配置项隔开；菜单高度超出时可滚动。
- 工具栏宽度上限：普通模式 560px、compact 420px；超出宽度的技能收进更多菜单，避免窗口被屏幕边缘裁切。
- API 层换成 `web/shared/tauri-api.js`：
  - 实现 `window.pickerAPI`：`ready/onData/onHidden/close/pin/resize/dragPanel/copy/openSettings/translate/abortTranslate/onTranslateEvent/assist/customSkill/status/disableInApp/disableTool` 映射到 §5.2 命令与 §5.3 事件（`listen` 返回 unlisten）。
  - 翻译：`invoke("picker_translate", {requestId,text,targetLang})` 返回错误时展示错误面板；`translate-event` 处理 chunk/error/done。
  - 自定义技能：`invoke("picker_custom_skill", {requestId,skillId,text,programName})`，与翻译共用 `translate-event` 流与结果面板（Markdown、重试、复制、朗读）；面板标题为技能名，目标语言控件隐藏。工具栏技能按钮图标来自 `LP.skillIconSvg`（内置技能用 `LP.SKILL_MAP[id].icon`，自定义用 icon），未知元数据回退 label=id/icon=sparkles。
  - 内置润色：`invoke("picker_polish", {requestId,text})`，与翻译共用流/面板（标题「润色」，语言控件隐藏）。
  - 内置搜索：读取 config.searchEngine，按 `LP.SEARCH_ENGINE_MAP[value].url + encodeURIComponent(text)` 生成 URL，`invoke("open_external", {url})` 后用系统浏览器打开并 `picker_close` 隐藏工具栏；无文本 toast 提示。
  - 结果区渲染 Markdown（安全子集，HTML 先转义）：标题、粗体/斜体/删除线、行内代码、代码块、有序/无序列表、引用、分隔线、表格、http(s) 链接（链接点击经 `open_external` 打开，不在 webview 内导航）；流式输出按 rAF 合并重渲染，用户向上翻阅时不强制滚到底部。
  - 朗读：仅用 `window.speechSynthesis`（Windows 系统语音）；无语音时提示「系统未安装可用的语音包：Windows 设置 → 时间和语言 → 语音」。朗读中再次点击是「停止朗读」，必须静默恢复按钮态，不提示失败（忽略 `interrupted`/`canceled` 错误）。
  - 结果面板可通过标题栏空白处拖动整个工具窗口（`picker_drag_panel`，每次 mousemove 发送屏幕坐标差值的逻辑像素 delta）；按钮/语言下拉区域不触发拖动。
- 结果面板右下角提供缩放手柄：拖动调用 `picker_resize`（无最大限制；最小窗口 360×240，窗口位置 clamp 到虚拟桌面，可跨屏），尺寸写入 localStorage `lexora.panelSize`，下次打开沿用；手动调整后 `.panel` 填满窗口、内容自适应不再覆盖用户尺寸；双击手柄恢复自动大小。
- 面板模式（picker.panelMode）：`auto`（默认）固定宽度与滚动模式最小宽度一致，为 360px；窗口随内容自动变高，最大高度为 `min(当前屏幕可用高度-80px, 760px)`，隐藏缩放手柄；resize 合并为最多每 100ms 一次，且同一面板流式期间高度只增不减，避免闪烁；达到限高后 panel-body 隐藏滚动条并随流式内容自动滚到底部，用户向上滚动时暂停跟随，接近底部后恢复；`scroll` 使用固定窗口大小、可见滚动条，可拖拽缩放并记忆尺寸（不小于 360×240）。
- 面板粘滞与多表面：结果面板打开时后端 panel_open=true。面板已钉住时，新划词由一个独立临时 `picker-toolbar` 窗口显示，只更新暂存选区，不隐藏或中止面板；点击翻译、总结、解释、润色或文本自定义技能时才替换面板，朗读、复制、搜索、截图入口不立即替换，截图结果真正生成时才替换。面板未钉住时，新划词立即隐藏旧面板并显示新选区的工具栏。任意时刻最多一个结果面板。
- 工具栏胶囊在鼠标滚轮/触摸板滚动时自动隐藏；结果面板打开时 wheel 事件不隐藏面板。关闭结果面板时直接隐藏整个 picker（不再回退显示工具栏胶囊）。
- 面板尺寸与窗口一致：自动尺寸按可见 panel 高度计算，窗口底部不再有透明隐藏区；toast 显示在面板顶部覆盖，不额外占位。
- 继续提问/建议区为绝对定位的悬浮层，覆盖在面板正文底部、不占用布局高度；输入行与 chips 独立浮起；panel-body 动态留出底部 padding，保证末尾内容可滚动阅读。
- 所有 AI 文字/图片技能成功结果下方支持「继续提问」及最多 3 个模型动态生成的建议 chip，不使用固定预设；文字提交调用 `picker_followup`，图片调用 `capture_followup`，同一面板追加多轮流式问答（沿用 Markdown/复制/朗读/错误重试）。`picker_followup` / `capture_followup` 的 `previousAnswer` 始终传初始回答，`history` 传此前成功的问答轮次；初始回答独立保存，每轮成功后仅追加一组 `{question,answer}`，失败或重试不重复追加历史。
- `generate_followups` 根据 `skill`、原文 `source`、初始回答 `initialAnswer` 与多轮 `history` 生成建议。普通多轮追问保留最近 10 轮、单段最多 4000 字符、总文本预算 20000 字符；建议生成另用以下精简预算。图片建议使用文字上下文，图片追问仍携带原图。
- 动态追问时序：主回答收到首个非空 chunk 后启动建议预取；每次最多 3 条。主回答或本轮追问完成时，已有预取结果立即展示，否则最多等待 3000 ms；超时取消并静默丢弃迟到结果，不显示固定建议。该截止仅限制前端等待时间，不保证实机模型能在 3 秒内成功生成建议。多轮追问继续保留原文、初始回答与历史；建议生成另用精简上下文（原文和初始回答各最多 800 字符，最近 6 轮每段最多 500 字符，总计最多 3000 字符，输出最多 80 tokens），普通多轮追问预算保持不变。
- 在线建议使用已配置的在线模型；本地仅使用手动选择且完整安装的 Qwen3.5 本地模型。`picker-data.config.suggestionsAvailable` 在线按 API 配置判断，本地按所选模型与安装完整性判断；截图入口同样提供该字段。仅当字段严格为 `true` 时展示建议区与追问入口，否则静默隐藏、无提示、不调用建议模型。建议生成失败、取消或解析失败返回空列表，前端不显示错误。
- 建议 `requestId` 独立于主回答流，`cancel_followups` 取消对应任务；新 AI 请求等待旧建议取消。关闭、隐藏、换任务或切换语言使旧建议失效；迟到回包须同时通过会话、请求版本及轮次检查。同轮缓存建议，每轮成功回答后失效并刷新。
- 单个单词按源语言处理：英文单词输出英语 IPA + 释义/用法；中文词语输出拼音 + 释义/用法（不输出英语音标）；其他语言只做普通翻译，不附加词典信息。词典释义语言跟随目标语言；解释技能固定中文释义。追问建议与其他 AI 技能一致，由模型动态生成，点击即发送 follow-up。
  - 目标语言下拉从 `LP.LANGUAGES`（38 种翻译目标语言）动态生成，不再硬编码 option。
  - 菜单「划词设置…」→ `invoke("picker_open_settings")`；「在此应用中禁用」「禁用划词工具」→ 对应命令。
- 初始尺寸 440×56，白色卡片边缘透明；`picker_ready` 在 DOM 就绪后调用一次。
- 截图结果面板（`picker-image`，见 §10.5）：复用文字技能面板的全部结构与功能（标题/钉住/关闭、语言控件仅 translate、Markdown 流式、朗读/复制/重试、继续提问、resize grip），不新增截图专用面板；OCR 动作以纯文本渲染。

### 7.2 设置页（新建，简洁好用）
- 单窗口、原生标题栏、单页五张卡片（无侧栏/标签页）：**翻译服务**、**划词行为**、**快捷键**、**应用与启动**、**关于**。
- 翻译服务：
  - 分段控件「在线 API / 本地模型」立即保存 mode。
  - 在线：预设下拉（DeepSeek/OpenAI/Moonshot/智谱/OpenCode Go/Ollama/LM Studio/自定义）、服务地址、API Key（password + 显示切换）、模型名下拉（[拉取模型] 通过 `list_online_models` 拉取 `/models`，并保留「自定义模型…」手填兜底）、[测试连接]（显示延迟/模型列表/错误）、状态徽标。切换预设必须清空上一个服务商的 API Key / 模型名与模型缓存，且**不再自动填充模型名**；已知预设只填服务地址。OpenCode Go 预设（`provider.online.preset = "opencode-go"`）额外保存 `modelsBaseUrl = https://opencode.ai/inference/go/v1`（其 `/models` 与 `/chat/completions` 路径不同），发往该预设的所有请求自动附带 `x-opencode-session: lexora-<16位hex>` 请求头（进程内稳定，用于路由与 prompt caching）；客户端 `User-Agent` 固定为 `Lexora/<版本>`。`modelsBaseUrl` 为空时回退 `baseUrl`。
  - 本地：引擎下载、进度/取消与状态；已安装模型列表；唯一本地模型手动选择并保存；硬件推荐标签和理由；模型目录仅提供六种 Qwen3.5，支持并行下载及分别取消，视觉投影器随主模型下载；[导入 GGUF]、[启动]/[停止]、错误提示。未选择时所有本地 AI 任务不可用，不自动替选；切换选择需重启本地引擎。所有本地 AI 任务共用所选 Qwen3.5。停止后请求不自动启动；应用重启按 keepRunning 恢复运行状态。
- 划词行为：启用开关、紧凑模式开关（紧跟启用开关、右对齐）、面板模式（紧跟紧凑模式：滚动/自适应，保存 `picker.panelMode`）、技能开关 + 拖拽排序（无上下箭头）…（其余同前）。**技能按「文字技能 / 图片技能」两个 Tab 分类展示（第四轮修正）：文字技能 Tab = 内置文字技能 + 「截图」入口技能 + 自定义文字技能；图片技能 Tab = 单一列表（截图工具条全部有序条目：钉在桌面 / 形状 / 箭头 / 画笔 / 文字 / 序号 / 马赛克 / 提取文字 / 翻译 / 解释图片 / 长截图 + 自定义图片技能，顺序与开关保存 `picker.captureSkills`，可全部关闭；“翻译/解释图片”可编辑系统提示词 `picker.capturePrompts`，其余条目无提示词按钮；不再有「复制」条目）；文字技能 Tab 的「截图」行不带「图片」徽标**；两个分类各自独立开关与排序，Tab 内拖动只重排该分类并保留另一分类相对顺序）、每行显示技能图标（内置用 `LP.SKILL_MAP[id].icon`，自定义用自定义图标）、技能提示词编辑（行内展开 textarea，默认填充系统默认英文提示词，支持重置默认；translate 支持 `{target}` 占位符；支持 translate/summarize/explain/polish）、自定义技能管理（[添加技能] 打开内联表单：**图标选择器默认紧凑显示当前图标预览 +「更换图标」，点击展开 200 个 Lucide 图标 + 名称搜索过滤**；名称 ≤20、提示词必填 ≤4000、变量提示 `{text}/{target}/{language}/{program}/{app}`；支持编辑、删除二次确认）、搜索配置（搜索行「配置」按钮展开 Google/百度/Bing，保存 `picker.searchEngine`）、默认目标语言（auto 显示「自动识别」，共 38 种语言）、黑名单 chip 输入（回车添加/可删除）。截图快捷键可配置（见 §10.4）。恢复默认设置保留自定义技能与已下载模型/引擎。「开机自启」「关闭窗口后驻留托盘」两个开关行与划词开关一致：标签/开关垂直居中、开关靠右。
- 快捷键（第二轮反馈起独立成卡片，不再放在「划词行为」内）：卡片头「快捷键」+ 说明「配置 Lexora 的全局快捷键。」；内含「截图快捷键」录制器——显示当前组合（如「Win + Shift + X」），点击后提示「请按下新的快捷键…（Esc 取消）」，按下「修饰键 + 主键」即调用 `capture_set_hotkey` 保存并立即生效；Esc 取消；冲突时内联提示并保留旧值；「恢复默认」还原 `Win+Shift+X`；保存 `capture.regionShortcut`。
- 应用与启动：开机自启（portable 不支持时置灰说明）、关闭窗口后驻留托盘、打开数据/模型/日志/引擎目录、退出程序。
- 关于：版本、Tauri/Rust 版本、MIT、GitHub 链接、引擎与模型状态。
- 关于 → 检查更新：按钮调用 `check_update`；有新版本时展示版本号/更新说明（截断）/大小/发布时间，并提供「下载并更新」「稍后」；下载中显示进度条（`update-progress`），完成后提示「应用即将重启」；失败展示可操作错误与 hint。更新过程替换当前 exe 并自动重启（`--show` 打开设置）。
- 交互：改动即自动保存（文本 500ms 防抖），顶部短暂「已保存」；错误内联不弹模态；下载进度实时更新。
- 视觉：系统字体栈 `Segoe UI`/`Microsoft YaHei UI`；背景 `#f6f7f9`，卡片白 + 1px `#e5e7eb` 边框 + 12px 圆角；主色 `#4f46e5`；支持 `prefers-color-scheme: dark`；控件高 32–36px；不用渐变/大阴影。
- 安全：HTML 带 CSP（`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'`），无内联脚本；外链经 `open_external`。

## 8. 验收


- 自动更新：mock Release（新版本 + exe 资产）下「检查更新」显示新版本信息；「下载并更新」下载到同目录临时文件、替换当前 exe 并自动重启新版本；当前版本目录不可写、下载无效、无 win-x64 资产时给出可操作错误。
- `cargo test`（设置、SSE、catalog、日志脱敏等纯函数）通过。
- `cargo check` 无错误；`npx tauri build --debug --no-bundle` 产出 exe。
- 启动 exe：静默启动、托盘出现、不弹窗口；`--show` 才显示设置；拖选/双击/多击选词在某应用触发 picker；picker 菜单/面板/固定可用（菜单不含服务状态与关闭项）；全局快捷键已移除。
- picker 不干扰操作：弹出后前台窗口仍是原应用，Delete/Ctrl+C/Ctrl+X 正常生效；未固定时按任意键、右键自动隐藏工具栏，但鼠标滚轮/触摸板滚动**不会**隐藏；结果面板可用标题栏拖动窗口位置；面板内长内容可滚动阅读；朗读中再次点击为停止且不报错。
- Markdown：翻译/总结/解释结果按 Markdown 渲染（标题、列表、代码块、引用、表格、链接等），HTTPS 链接通过 `open_external` 打开；HTML 注入被转义。
- AI 输出统一流式：翻译、总结、解释、润色、自定义技能都通过 `translate-event` 增量渲染（不是等完整结果后一次性显示）。
- 自定义技能：设置页新增/编辑/删除后，picker 工具栏立即出现对应按钮（图标+名称），点击后流式返回、面板标题为技能名；提示词变量在后端替换；空提示词/非法 id 被后端归一化丢弃；未启用技能被点击时返回明确错误；图标可从 200 个 Lucide 图标中选择（旧 12 key 兼容）。
- 内置润色：工具栏「润色」流式返回 Markdown，默认英文提示词；设置页可编辑/重置；本地走 General 模型。
- 内置搜索：工具栏「搜索」按 `picker.searchEngine` 打开系统浏览器搜索选中文本（Google/百度/Bing，URL 编码正确）；设置页可切换引擎。
- 设置迁移/重置：version 1 旧配置升级后自动补上润色与搜索且保留 custom 技能；`reset_settings` 后自定义技能定义与启用状态仍在。
- 设置页：在线模型可按 `/models` 拉取并下拉选择；切换服务商预设会清空上一预设的 Key/模型且不自动填模型名；技能可拖拽排序（设置窗口 `dragDropEnabled: false` 保证 Windows 上 HTML5 拖拽可用）；技能列表显示图标；自定义技能可增删改；技能提示词可编辑与重置（默认英文）；默认目标语言显示「自动识别」；不再有文字技能全局快捷键；本地模型支持手动选择。
- 本地模型目录仅提供 Qwen3.5 0.8B / 2B / 4B（各有 Q4_K_M / Q3_K_M），均从 ModelScope 下载；翻译、通用与视觉共用手动选择，硬件推荐不替选。
- 提示词生效：自定义提示词保存后，下一次翻译/总结/解释请求使用自定义 system prompt；空值回退系统默认。
- 在线模式：填 mock/真实 OpenAI 兼容服务后「测试连接」成功；picker 翻译流式显示。
- 本地模式：安装引擎 + 下载完整 Qwen3.5、手动选择后启动成功，翻译流式返回；总结/解释可用；未选择时明确提示，切换选择后重启生效。
- 截图（§10）：快捷键开图无黑屏 loading；选区内拖动可平移、手柄可缩放；工具条与划词工具条同为白色主题；点击提取文字/翻译/解释图片/图片技能后截图关闭、图片入剪贴板、picker 结果面板流式输出且具备朗读/复制/重试/继续提问；本地安装完整并手动选择 Qwen3.5 后可解释图片；设置页可录制截图快捷键并立即生效、冲突时提示。
- 截图第二轮（§10.7/§10.8）：连续截图复用 overlay 窗口、无重建延迟与闪烁；提取文字默认走视觉模型（日志路径可见），视觉不可用才回退 Windows OCR；设置页快捷键为独立卡片；全屏选区内拖拽直接开始新框选。
- 构建 release：`scripts/build-portable.ps1` 产出单个 `dist/Lexora-<version>-win-x64.exe`；双击运行后静默驻留托盘，数据写入 exe 同级 data/；Release 正文由 `scripts/release-notes.ps1` 生成排版化 changelog。


## 10. 截图（v0.2.3 第三轮反馈，权威契约）

历史轮次：v0.2.1 无黑屏/白色工具条/面板化/本地视觉/可配置快捷键；v0.2.2 复用+透明+JPEG 性能、全屏拖拽语义、快捷键独立卡片、VL 文字提取。
本轮（第三轮反馈）：截图不再关闭设置/工具面板窗口；设置页图片技能与文字技能分 Tab；提取文字恢复流式输出；图片翻译可切换目标语言并修正源/目标语言显示。

### 10.1 快速启动、无闪烁（overlay 复用 + 透明窗口 + 并行预编码）
目标：把「按快捷键 → overlay 可见」压到 ~300ms 级别，且任何一帧都不出现黑白闪烁。

- **overlay 窗口复用**：`capture-<index>` 窗口第一次截图时创建，之后 `capture_close`/技能执行**只隐藏不销毁**；下次 `start_capture` 若显示器数量与几何一致则直接复用（webview 常驻 = 省掉冷启动/窗口创建）。显示器布局变化（数量/坐标/尺寸）时才销毁重建。
- **窗口透明**：`create_capture_window` 使用 `transparent(true)` + 透明背景色 + `shadow(false)`、`visible(false)`；页面 body/根容器背景透明，只在 `<img>` 与遮罩层上绘制。避免 `show()` 首帧白底/黑底闪烁。
- **不隐藏自身窗口、且拍进截图（第五轮修正）**：截图期间设置窗口与划词工具面板保持打开，**并会被包含在冻结截图里**（用户明确要求；不做窗口排除、不隐藏）。唯一在此之前执行的是隐藏上一轮遗留的 overlay 窗口。
- **输入抑制**：截图进行中 `SelectionService::set_capture_active(true)`；此状态下 picker 的 blur-hide 与全局钩子的 dismiss/outside-click 一律忽略，避免截图过程把工具面板/面板关掉。`capture_close`/`capture_skill`/`capture_copy` 结束时置回 false。
- **并行预编码**：`start_capture` 先清 Session 并确保 overlay 已创建（webview 在后台开始加载），随后 `xcap` 抓取所有显示器，`spawn_blocking` 并行把每块屏编码为 **JPEG data URL（质量约 85）** 存入 `Session`。JPEG 替代 PNG：编码、IPC、webview 解码均快数倍，overlay 只用于显示；裁切/OCR/视觉请求始终从内存里的原始 `RgbaImage` 取像素，无损。
- **arm 事件**：抓屏完成、`Session` 就绪后，Rust 向每个 overlay 窗口 emit `capture-armed {index}`；页面收到后重新初始化（重置选区/面板/错误状态）并拉取 `capture_monitor_info`。页面首次加载时同样主动拉取（配合 8–10s 轮询直到 Session 就绪）。页面身份**只取自身 URL 的 `monitor`**：监听器必须把 target 固定到当前窗口（`{ kind: "WebviewWindow", label }`），且不得用事件 payload 覆盖自己的 index——Tauri 的默认 `Any` 监听也会收到发给其他 overlay label 的 `emit_to` 事件。
- `<img>.onload` 后计算尺寸、渲染 UI，并调用 **`capture_ready(index)`**；Rust 收到后 `show()` 对应 overlay（index 0 同时 `set_focus`）。
- 兜底：Rust 在 `start` 后 2500ms 只 `show()` 尚未 `capture_ready` 的 overlay（`ready_monitors` 按显示器记录；单个健康 overlay 不会掩盖另一个未就绪的显示器）。
- overlay 页面**不显示**任何全屏 loading；仅当图片加载失败时显示白色错误条（重试/关闭）。抓屏期间窗口保持隐藏，因此没有黑屏过程。
- 隐藏的 overlay 窗口不参与合成，因此抓屏不会把上一张截图/工具条拍进去；被 `WDA_EXCLUDEFROMCAPTURE` 排除的自身窗口也不会被拍进去。

### 10.2 overlay 交互（QQ 式选择阶段 + 编辑阶段）
- **全局物理选区**：选区以虚拟桌面**物理坐标**（`state.selection`）为准，因此可以跨多个显示器框选，也可以在编辑阶段跨显示器移动/缩放。每个 overlay 只渲染与本屏相交的片段（遮罩镂空、四条边只画真正落在本屏的边、8 个手柄只显示落在本屏的），所有 overlay 通过 `capture-selection-state` 广播同步（`{phase, rect, owner}`，28ms 节流）。工具栏/尺寸标签/hint 只出现在选区右下角所在显示器（owner）。
- **选择阶段（进入截图后的默认状态）**：无选区、无工具栏；整屏暗遮罩，鼠标所在窗口自动吸附高亮（`capture_hover_at` 按 z-order 取顶层窗口，优先 DWM 扩展边框；排除本进程/桌面/任务栏/工具窗/最小化/cloaked/空标题/过小窗口）。鼠标可自由跨显示器移动：每个 overlay 只高亮与本屏相交的部分，物理坐标用 `capture_monitor_info` 的显示器原点换算到本屏 CSS；鼠标离开本屏（`mouseout`）时清除本屏吸附。
- **QQ 取色放大镜**：选择/编辑阶段鼠标旁跟随一个组件——上方 15×15 物理像素放大（最近邻 + 网格 + 中心高亮框），下方显示物理坐标 `(x, y)`、色值 `#RRGGBB` 与「按 C 复制色号」；`C` 通过 `capture_copy_text` 写入剪贴板并提示「已复制」。键盘焦点只落在一个 overlay 上，而鼠标可以停在另一台显示器，因此 `C` 由焦点页通过 `capture-copy-color` 广播给所有 overlay，只有**当前显示放大镜**的页面执行复制（无需先点击那块屏幕）。靠近屏幕边缘自动翻转/夹紧，鼠标在工具栏/颜色面板/标注工具激活时隐藏。
- **确认选区**：单击 = 选中吸附窗口（整个窗口矩形，可跨屏），单击空白桌面/任务栏 = 当前显示器全屏；两者都会显示工具栏并进入编辑阶段。拖动超过 4 CSS px = 自由框选（预览框 + 尺寸标签，可跨屏），松开后显示工具栏；全局坐标按 `capture_layout` 的虚拟屏 bounds clamp。
- **编辑阶段**：选区按全局裁切，跨屏时由 Rust `crop_global` 逐显示器拼接（未覆盖的屏幕间隙填黑）；标注与长截图只支持单显示器，**跨屏选区时这两类按钮自动禁用**（标注工具 disabled，长截图提示不支持）。
- **选区内拖动平移**：`mousedown` 落在本屏可见片段内（工具条/手柄除外）→ move 模式；`mousemove` 用全局坐标平移矩形、尺寸不变、clamp 到虚拟屏 bounds；松开后广播最终矩形并按右下角重新选 owner。
- **全屏选区例外**：当本屏片段已经铺满整个视口（没有平移空间）时，选区内 `mousedown` 直接进入「重画」模式（按下即开始新的框选）。
- 选区外 `mousedown` 拖动 = 重画；8 手柄 resize；最小 8×8 物理像素；Esc/取消关闭；右键菜单阻止默认。
- **跨屏互斥**：任一 overlay 开始新选择时广播 `capture-selection-state {phase:"selecting", rect:null}`，其他 overlay 丢弃自己的选区与标注、回到选择阶段。
- hint：选择阶段「点击窗口选择 · 拖动框选 · Esc 取消」；编辑阶段「拖动选区移动 · 拖动边角调整 · Esc 取消」，3.2s 后淡出。
- 紧凑模式（`picker.compact`）同样作用于截图工具条：只显示图标、隐藏文字标签。
- 工具条样式与 `picker.css` 的 `.toolbar` 完全一致（白色卡片）：白底 `#fff`、1px `#e2e8f0`、圆角 12px、按钮高 32、字号 12.5、文字 `#475569`、hover `#f1f5f9`、主色 `#4f46e5`、取消按钮红色 `#dc2626`；阴影收敛（参考 picker `--shadow-float`）。尺寸标签/hint/toast 同样白色主题。
- 工具条条目：**可配置按钮全部按设置 `picker.captureSkills` 顺序渲染**——本地工具（钉在桌面/形状/箭头/画笔/文字/序号/马赛克/长截图）、AI 动作（提取文字/翻译/解释图片）与**已启用的自定义图片技能**（custom-*，图标/名称来自技能定义，点击=以 `action:"custom"` 执行该技能）；preset 图片技能（若有）显示在最前且不重复。撤销/重做/取消/确认固定显示（确认在最右，绿色）：确认 = 裁切图写入剪贴板并退出截图（`capture_copy`），取消 = 直接退出。所有可配置条目都可关闭，此时只显示撤销/重做/取消/确认。
  - 「复制」→ `capture_copy`：裁切图写系统图片剪贴板并关闭全部 overlay（不打开面板）。
  - 「提取文字」「翻译」「解释图片」、preset 图片技能 → `capture_skill`（见 10.3）；Rust 关闭 overlay 并打开 picker 结果面板，**不允许出现截图框选与面板同时显示**。

### 10.3 命令契约（替换旧 `capture_ocr` / `capture_ai`）
| command | args | 返回 |
| --- | --- | --- |
| `start_capture` | `{presetSkillId?}` | `{ok, monitors, error?, hint?}` |
| `capture_monitor_info` | `{index}` | `{ok, dataUrl, width, height, x, y, index, preset?, error?, hint?}`（dataUrl 为 JPEG；width/height 为物理像素原始尺寸；x/y 为显示器物理原点，供窗口吸附坐标换算） |
| `capture_hover_at` | `{x, y}` | `{ok, rect: {x, y, width, height} \| null}` — 物理坐标下最顶层可吸附窗口（QQ 选择阶段）；无截图会话时 rect 恒为 null |
| `capture_cursor` | — | `{ok, x, y, active}` — 物理光标位置 + 当前是否有截图会话 |
| `capture_layout` | — | `{ok, monitors:[{index,x,y,width,height}], bounds:{x,y,width,height}}` — 物理显示器布局（跨屏选区 clamp/owner 判定）；无会话时 `ok:false` |
| `capture_copy_text` | `{text}` | `{ok, error?, hint?}` — 写文本剪贴板（放大镜「C」复制色号） |
| `capture_ready` | `{index}` | `{ok}` — overlay 图片已绘制，显示窗口 |
| `capture_copy` | `{index, rect, annotations?, globalRect?}` | `{ok, error?, hint?}` — 裁切图入剪贴板并隐藏 overlay；`globalRect`（物理虚拟屏矩形）存在时跨屏拼接裁切 |
| `capture_skill` | `{requestId, index, rect, action, skillId?, targetLang?, annotations?, globalRect?}` | `{ok, clipboard, error?, hint?}` |
| `capture_pin` | `{index, rect, annotations?, globalRect?}` | `{ok, id, width, height, error?, hint?}` — `globalRect` 时钉跨屏拼接图 |
| `capture_retry` | `{requestId, targetLang?}` | `{ok, error?, hint?}` — 用上一张截图重跑当前动作；`targetLang` 仅对 translate 生效（切换目标语言） |
| `capture_followup` | `{requestId, question, previousAnswer, history:[{question,answer}]}` | `{ok, error?, hint?}` |
| `capture_close` | — | `{ok}` — 隐藏 overlay 窗口（保留复用）+ 清空 Session + 结束 capture_active |
| `capture_set_hotkey` | `{shortcut}` | `{ok, shortcut, error?, hint?}` — 见 10.4 |

- 事件：`capture-armed {index}`（Rust → capture-*）在每次 `start_capture` 抓屏完成后发送，用于复用窗口的重新初始化（见 10.1）。
- `action`：`"ocr" | "translate" | "explain" | "custom"`；`custom` 必须是已启用的 `kind=image` 自定义技能，否则同步返回明确错误。
- `capture_skill` 行为（顺序固定）：
  1. 从 Session 裁切矩形（无效则错误）；
  2. 把裁切图写入系统图片剪贴板（失败时 `clipboard=false`，流程继续）；
  3. 保存 `LastCapture { image, action, skillId, targetLang, label, ocrText:None }` 供重试/追问；
  4. `windows::hide_capture_windows`（隐藏复用）；`windows::show_picker` 以**选区右下角的物理坐标**为锚点显示 picker（`text=""`、`programName="截图"`、config 同划词 picker）；设置/工具面板不隐藏（见 10.1）；
  5. emit `picker-image`（见 10.5）；
  6. 立即返回 `{ok:true, clipboard}`；
  7. 后台流式任务（注册到 `state.translate_task`，遵循 picker 的「同时只有一个流」与 abort 逻辑）：
     - `ocr`：**视觉模型转写并流式输出**——`engine.vision_stream(data_url, DEFAULT_OCR_PROMPT)` 的 chunk 原样逐块 emit（不再收集后一次性输出），结束后 `done` 并把全文缓存到 LastCapture.ocrText；视觉不可用、或首个 chunk 之前失败/输出为空 → 回退 Windows OCR（单 chunk 全文 + done）；
     - `translate`：先用视觉模型转写（收集完整文本，缓存到 LastCapture.ocrText；不可用/失败回退 Windows OCR）→ `resolve_target_lang` 得到实际目标语言 → 先 emit `translate-event {type:"target", targetLang}`（picker 用它显示真实目标语言）→ `engine.translate_stream(text, target)` 流式；
     - `explain`：`engine.vision_stream(image_data_url, DEFAULT_EXPLAIN_IMAGE_PROMPT)`；
     - `custom`：`engine.vision_stream(data_url, render_image_prompt(skill.prompt, target))`；
     - 事件统一为 **`translate-event`**（`{requestId, type:"chunk"|"target"|"error"|"done", text?, targetLang?, message?, hint?}`）发往 picker 窗口。
- 「视觉可用」判定 = `EngineService::can_use_vision()`：在线模式要求已配置服务地址与模型；本地模式要求手动选择的 Qwen3.5（主文件 + 对应 mmproj-F16）已安装（未启动时请求会得到「本地模型未启动」错误，由面板展示）。
- `capture_retry`：先 `state.abort_translate()`；若传入 `targetLang` 且动作为 translate，先更新 LastCapture.targetLang 再重跑；其余按 LastCapture 重跑同一动作（ocr/translate 重新提取；explain/custom 重新发送图片），事件同上，requestId 用调用参数。
- `capture_followup`：explain/custom 用新增的 `engine.vision_followup_stream(image_data_url, previous_answer, question, history)`（system 解释提示 + 图片 + 初始回答 + 多轮历史 + 新问题）；ocr/translate 用 `engine.followup_stream(ocrText, previous_answer, question, history)`；事件同上。
- `capture_close` 不清 `LastCapture`（重试/追问仍可用），下一次 `start_capture` 或 `new capture` 时覆盖释放。

### 10.4 快捷键（可配置）
- 设置字段 `capture.regionShortcut`，默认 `"Win+Shift+X"`；`SETTINGS_VERSION = 4`。
- 规范格式：修饰键按固定顺序 `Win`、`Ctrl`、`Alt`、`Shift`，后接主键，用 `+` 连接，例如 `"Win+Shift+X"`、`"Ctrl+Alt+P"`。主键取值：`A`–`Z`、`0`–`9`、`F1`–`F24`、`PrintScreen`、`Space`、`Tab`、`Enter`、`Esc`、`Backspace`、`Insert`、`Delete`、`Home`、`End`、`PageUp`、`PageDown`、`Up`、`Down`、`Left`、`Right`。至少一个修饰键；非法值归一化回默认。
- `settings.rs` 提供 `pub const DEFAULT_REGION_SHORTCUT: &str` 与 `pub fn normalize_shortcut(raw: &str) -> String`（带单元测试）。
- `capture_set_hotkey(shortcut)`：normalize → 与当前相同直接 `ok`；否则通知热键线程 `UnregisterHotKey` + `RegisterHotKey`（带 `MOD_NOREPEAT`），失败则恢复旧快捷键并返回 `{ok:false, error:"快捷键注册失败（可能已被其他程序占用）", hint:"请换一个组合键后重试"}`；成功后 `settings.update_json({"capture":{"regionShortcut":...}})` 并 broadcast `state-changed`，返回规范化字符串。
- 设置页配置入口：独立「快捷键」卡片（不再放在「划词行为」卡片内），见 §7.2。
- 热键线程：`WM_APP+1` 自定义消息触发重注册（`PostThreadMessageW`），结果通过 mpsc 回传；启动时按设置注册（失败仅记日志，不影响应用启动）。通用 `update_settings`/`reset_settings` 修改了 `capture.regionShortcut` 时也会同步重注册。

### 10.5 事件 `picker-image`（Rust → picker）
```jsonc
{
  "requestId": "capture-...",   // 与后续 translate-event 的 requestId 相同
  "action": "ocr | translate | explain | custom",
  "skillId": "",                 // custom 时为技能 id
  "label": "提取文字 | 翻译 | 解释图片 | <自定义技能名>",
  "targetLang": "auto",          // translate 的目标语言（其他动作忽略）
  "clipboard": true,              // 图片是否已写入剪贴板
  "hint": "截图已复制到剪贴板"      // 可空
}
```
- picker 收到后：关闭菜单/重置旧面板 → `openPanel(label)`；按 action：
  - `ocr`：纯文本面板（loading 文案「正在识别文字…」；**流式逐块追加纯文本**，支持朗读/复制/重试/追问）；
  - `translate`：翻译面板（**目标语言控件可用**，源语言固定显示「自动识别」）；收到 `translate-event {type:"target"}` 后把控件显示更新为实际解析出的目标语言；用户切换目标语言 → 新 requestId + `capture_retry{targetLang}` 重新翻译；
  - `explain`/`custom`：AI 面板（隐藏语言控件；流式 Markdown）。
- 请求进行中仍有 loading；chunk 增量渲染；error 显示可操作错误 + 重试；done 后显示「继续提问」输入区；
- 「重试」→ 新 requestId + `capture_retry`（translate 带当前目标语言）；「追问」→ `capture_followup`；关闭面板/切换技能 → abort（`picker_abort_translate` 复用 `translate_task` 机制）。
- 面板完全复用文字技能面板（`panel-head` 标题/语言/钉住/关闭、`panel-body` Markdown、`panel-foot` 朗读/复制/重试、follow-up 浮层、resize grip），不新增截图专用面板样式。
- `picker-data` 仍会先到（`text=""`），picker 必须兼容空 text：不报错、工具栏可渲染，随后被 `picker-image` 切到面板。
- `translate-event` 的 `type` 扩展为 `"chunk" | "target" | "error" | "done"`；`target` 携带 `targetLang`（语言代码），仅图片翻译会发。

### 10.6 本地视觉（item 5）
- 本地视觉与通用任务共用用户手动选择的 Qwen3.5（0.8B / 2B / 4B，各有 Q4_K_M / Q3_K_M），不再自动选择 Qwen2.5-VL。模型及对应 mmproj-F16 从 ModelScope 下载。
- 投影器远程文件名为 `mmproj-F16.gguf`，本地文件名按规格唯一，下载路径与本地文件名须分别处理；同规格的两种量化可共用对应投影器。
- `ModelSpec` 提供 `vision` 与 `mmproj` 信息；`CatalogEntry` 标记视觉能力；`scan_models` 过滤 `mmproj-*.gguf`（不当作独立模型）；`installed` 要求主文件与对应投影器都存在。
- 下载：主模型完成后继续下载 mmproj（同一个模型 id；进度事件先主文件后投影器，`filename` 字段区分；任一失败整体失败并清理临时文件）。
- `LocalRole` 增加 `Vision`；`model_for_role(Vision)` 只使用手动选择且「主文件 + 对应 mmproj 都存在」的 Qwen3.5；`llama.rs::ensure_model` 增加 `mmproj: Option<&str>` 参数，启动参数追加 `--mmproj <path>`，视觉模型 `-c` 至少 8192；模型或投影器变化时重启进程。
- `EngineService::vision_stream`：本地未选择 Qwen3.5 模型时明确提示去设置选择；文件不完整时提示下载所选 Qwen3.5 及对应投影器，不自动替选；在线模式保持原逻辑。
- 本地模式「翻译」不再被拒绝（OCR + 文本翻译）；`capture.rs` 删除「本地模式一律报错」。

### 10.7 性能与无闪烁验收（第二轮）
- 同一显示器连续截图时使用已创建的 overlay 窗口（日志可见 reuse），不再每次重建 webview。
- 「按快捷键 → overlay 可见」在 150% DPI 单屏机器上目标 ≤ 400ms（原实现约 700ms）；编码使用 JPEG（日志/代码可见），裁切图像素仍来自原始 RGBA。
- 窗口透明 + 隐藏期间不显示：出现瞬间即为截图画面，无白闪/黑闪；隐藏的 overlay 不会被拍进新截图。
- 桌面内容为动态视频/硬件合成窗口时，抓屏结果不应出现大块纯黑（若偶发，允许重抓一次，见实现说明）。

### 10.8 文字提取改用视觉模型（第二轮）
- 「提取文字」不再直接使用 Windows OCR：优先 `engine.vision_stream(data_url, DEFAULT_OCR_PROMPT)` 转写（在线视觉模型 / 本地手动选择的 Qwen3.5），结果以纯文本面板显示（朗读/复制/重试/追问不变）。
- 视觉不可用（在线未配置且本地无 VL 模型）**或视觉请求失败/未返回文本**时回退 Windows OCR，保证功能仍可用；日志注明走了哪条路径与回退原因。
- 「翻译」同样优先用视觉模型转写后再翻译（缓存转写文本供重试/追问），视觉不可用时回退 Windows OCR + 文本翻译。
- 新增 `DEFAULT_OCR_PROMPT`（engine/prompts.rs，英文，要求逐字转写、保留换行、不翻译/不总结/不加代码围栏），由 `engine.rs` 重新导出；`EngineService::can_use_vision()` 判定视觉可用性。

### 10.9 验收（本轮）
- 快捷键按下后不再出现黑屏 loading；overlay 出现时已是截图画面。
- 选区内按住拖动可平移；手柄可缩放；尺寸标签同步。
- 工具条为白色主题，与划词工具条一致。
- 点击「提取文字/翻译/解释图片/自定义图片技能」后：截图 overlay 立即关闭、图片在剪贴板、picker 弹出结果面板流式输出；无「面板 + 框选」同屏。
- 结果面板具备朗读/复制/重试/流式/继续提问；错误有可操作提示。
- 在线视觉模型可解释图片；本地安装完整并手动选择 Qwen3.5 后可本地解释图片；本地模式下翻译截图文字可用。
- 设置页可录制并保存新的截图快捷键，立即生效；冲突时提示且保留旧快捷键。
- 第三轮（§10.1/§10.3/§10.5）：截图期间设置窗口与划词工具面板保持打开、不被拍进截图；设置页工具栏技能分「文字/图片」Tab 且各自独立开关排序；提取文字流式输出；图片翻译可切换目标语言，且面板显示的目标语言与实际一致。
- 第四轮（§10.1/§10.2）：从工具面板点击「截图」后工具面板不再自行关闭，截图结束后保持可见；截图工具条按钮顺序/启用由设置 `picker.captureSkills` 控制；设置页「截图」入口技能归入文字技能分类，图片技能分类改为「复制/提取文字/翻译/解释图片」+ 自定义图片技能；隐藏截图窗口不再触发 2.5s 兜底（WebView2 后台节流被禁用）。
- 第五轮（§10.1/§10.2）：设置窗口与划词工具面板会出现在冻结截图里（不再排除、不隐藏）；文字技能 Tab 的「截图」行不再显示「图片」徽标；截图工具条可关闭全部 4 个动作，此时仅显示「确认 / 取消」，确认 = 复制图片并退出截图、取消 = 直接退出。
- 第六轮（§4/§7.2/§10.2）：截图工具条条目由 `picker.captureSkills` 统一有序管理（内置动作 + 自定义图片技能，自定义图片技能不再出现在文字工具栏）；图片技能 Tab 为单一列表、不区分自带/自定义；紧凑模式对截图工具条生效；「翻译」「解释图片」支持编辑系统提示词（`picker.capturePrompts`）；工具条末尾为「取消」「确认」，确认绿色且最右。
- 第七轮（§4/§7.2/§11.2/§11.5）：钉在桌面普通图片不再出现滚动条（长图才可在窗口内滚动，滚动条复用项目样式）；移除「清除标注」按钮；形状/箭头/画笔/文字/序号/马赛克/长截图/钉在桌面 全部纳入「图片技能」分类（可开关、拖动排序，toolbar 按 captureSkills 渲染）；「复制」从图片技能分类移除（确认=复制并退出仍保留）。
- `cargo test` 通过（新增 normalize_shortcut / catalog / 参数构造单测）；`cargo check` 无错误；`node --check` 全部通过。

## 11. 截图标注与基础工具（v0.3，权威契约）

参考 QQ 截图的基础工具：形状、箭头、画笔、文本/序号、马赛克、长截图、钉在桌面、撤回/重做。**全部为本地操作，不涉及 AI**。标注在截图 overlay 内完成，导出时把标注栅格化进图片（复制/确认/图片技能/钉在桌面都带标注）。

### 11.1 工具清单
| tool id | 名称 | 行为 | 可调属性 |
| --- | --- | --- | --- |
| `shape` | 形状 | 拖动绘制：矩形/椭圆/直线（形状子模式 `rect`/`ellipse`/`line`）；矩形/椭圆支持描边/填充两种模式，直线仅描边 | 颜色、粗细 1–20、填充模式 |
| `arrow` | 箭头 | 拖动绘制带箭头的直线 | 颜色、粗细 1–20 |
| `pen` | 画笔 | 按住自由绘制折线路径 | 颜色、粗细 1–20 |
| `text` | 文本 | 单击定位输入文字（textarea 浮层），Enter 或点击别处确认、Esc 取消 | 颜色、字号 12–72、粗体、文字背景色（可关闭） |
| `number` | 序号 | 单击放置自动递增的数字（圆形底色） | 序号颜色/底色、字号、粗体 |
| `mosaic` | 马赛克 | 按住涂抹像素化区域（块大小可调） | 块大小 2–30 |
| `longshot` | 长截图 | 见 11.6（按钮，不是绘制工具） | — |
| `pin` | 钉在桌面 | 见 11.5（按钮） | — |

- 撤回/重做：至少 50 步；`Ctrl+Z` / `Ctrl+Y`（文本输入中不拦截）。
- 默认属性：颜色 `#ef4444`、粗细 4、填充模式 `outline`、字号 24、非粗体、文字背景关闭、马赛克块 8。
- 颜色面板固定 8 个色块：`#ef4444 #f59e0b #84cc16 #3b82f6 #ffffff #6b7280 #111827` + 自定义取色器（`input[type=color]`）。

### 11.2 工具条 / 属性栏 DOM 契约（`web/capture.html`）
工具条仍是 `#capture-bar`，children 顺序（从左到右）：
0. 工具条可配置按钮全部由 `picker.captureSkills` 决定顺序与显隐（pin、标注工具、ocr/translate/explain、longshot、custom-*）；`undo/redo/cancel/confirm` 固定显示。以下为默认顺序：
1. `#capture-pin`（钉在桌面，`data-action="pin"`，label「钉在桌面」）
2. `.capture-bar-sep`
3. 标注工具按钮组（`data-tool`）：`shape`（含 `data-shape-mode` 下拉：矩形/椭圆/直线）、`arrow`、`pen`、`text`、`number`、`mosaic`；class `tool-btn capture-tool`；当前激活的工具加 `.is-active`。
4. `.capture-bar-sep`
5. 现有 `picker.captureSkills` 动作按钮（copy/ocr/translate/explain/custom，动态渲染，保持顺序/显隐/compact 逻辑）。
6. `#capture-longshot`（`data-action="longshot"`，label「长截图」）
7. `.capture-bar-sep`
8. `#capture-undo`（`data-action="undo"`）与 `#capture-redo`（`data-action="redo"`），disabled 由 JS 控制。
9. `.capture-bar-sep`
10. `data-action="cancel"`（取消，红）
11. `data-action="confirm"`（确认，绿色，最右，复制并退出）

属性栏 `#capture-palette`（位于工具条**上方**，默认 `hidden`；放不下时放工具条下方）：
- `#palette-colors`：8 个 `.palette-color[data-color]` 按钮 + `#palette-color-input`（type=color）+ `#palette-color-value`（当前色文字，可选）。
- `#palette-width`（range 1–20）+ `#palette-width-value`。
- `#palette-fill`（形状专用 segmented）：`[data-fill="outline"]` 描边 / `[data-fill="fill"]` 填充；形状模式为 line 时隐藏。
- `#palette-font-size`（range 12–72）+ `#palette-font-size-value`；`#palette-bold`（文本/序号开关按钮）；`#palette-text-bg`（文本背景色按钮组，含「无背景」，data-bg-color=""）。
- `#palette-mosaic-size`（range 2–30）+ `#palette-mosaic-size-value`。
- 控件显隐由当前工具决定；属性栏与工具条同为白色主题、圆角 12、1px `#e2e8f0` 边框。**不提供「清除标注」按钮**（撤回/重做即可；切截图时自动清空）。
- 紧凑模式（`picker.compact`）只影响工具条按钮 label；属性栏不受影响。
- 工具激活时 `body.annotating`；画布 `#capture-annotations` 位于截图 `<img>` 之上、遮罩之下，透明、覆盖整个视口。

### 11.3 标注引擎模块 `web/capture-annotate.js`（新文件）
```js
var editor = window.CaptureAnnotate.create({
  canvas: HTMLCanvasElement,          // 全屏透明 canvas（#capture-annotations）
  image: HTMLImageElement,            // 截图 <img>（用于马赛克取样）
  getSelection: function () {},       // 返回 CSS 选区 {x,y,width,height} 或 null
  onHistoryChange: function (state) {} // {canUndo, canRedo, hasAnnotations}
});
editor.setTool(idOrNull)   // "shape"|"arrow"|"pen"|"text"|"number"|"mosaic"|null（null=选区模式）
editor.getTool()
editor.setOption(key, value) // key: color|width|shapeMode("rect"|"ellipse"|"line")|fill("outline"|"fill")|fontSize|bold|textBg|mosaicSize
editor.getOptions()
editor.setShapeMode(mode)  // 便捷方法，等同 setOption("shapeMode", mode)
editor.undo(); editor.redo(); editor.canUndo(); editor.canRedo(); editor.clear();
editor.hasAnnotations() -> bool
editor.renderToPng(rectCss) -> string|null
```
- `renderToPng`：返回 data URL；画布尺寸 = `round(rect.width * scaleX) × round(rect.height * scaleY)`，`scaleX = image.naturalWidth / viewportWidth`（Y 同理）；内容为**透明背景 + 已绘制标注**（马赛克从 `image` 取样）；无标注返回 `null`。前端调用方保证只导出选区内的标注（按选区裁剪）。
- 工具激活时 canvas 接管 pointer 事件，选区拖拽/缩放暂停；工具按钮/palette 点击不进入绘制。
- 尺寸/位置使用 CSS 像素；HiDPI 画布 backing store = CSS × devicePixelRatio，绘制清晰。
- 标注与选区独立：移动/缩放选区不改变已有标注位置。
- 文本输入：在点击位置浮出 textarea（白底、与主题一致），Enter 提交（Shift+Enter 换行）、Esc 取消、blur 提交。

### 11.4 导出与命令扩展
- 前端在「复制/确认/图片技能/钉在桌面」前调用 `renderToPng(selection)`；无标注传空值。
- `capture_copy {index, rect, annotations?}`：Rust 裁切原图 → 若 `annotations` 存在，解码 PNG 并 alpha 合成（尺寸不一致时缩放到裁切尺寸）→ 写剪贴板 → 关闭 overlay。
- `capture_skill {requestId, index, rect, action, skillId?, targetLang?, annotations?}`：同上合成后的图片用于剪贴板与 AI（OCR/转写/视觉均使用合成图）。
- `capture_pin {index, rect, annotations?} -> {ok, id, width, height, error?, hint?}`：合成 → 存入内存 registry（可多个）→ 创建 pin 窗口（见 11.5）。
- `capture_longshot {index, rect} -> {ok, width, height, pinId?, frames?, error?, hint?}`：见 11.6。长截图忽略标注（v1 文档注明）。
- pin 命令：`pin_ready {id} -> {ok, dataUrl, width, height, scrollable, zoom, minZoom, maxZoom, error?}`（`scrollable` = 图片高于窗口、需窗口内滚动，用于 pin.js 精确控制滚动条，普通图片为 false；`zoom` 为当前滚轮缩放，1.0 = 原图 1:1 物理像素）、`pin_drag {id, dx, dy} -> {ok}`、`pin_zoom {id, zoom} -> {ok, zoom, minZoom, maxZoom, width, height, scrollable, error?, hint?}`（滚轮缩放：**左上角为锚点**，最小 15%，**放大无产品上限**，仅受系统窗口尺寸上限约束）、`pin_skill {id, requestId, action, skillId?, targetLang?, annotations?} -> {ok, clipboard, error?, hint?}`（对钉图运行图片技能，结果流入 picker 面板）、`pin_export_annotations {id, annotations?, apply} -> {ok, clipboard, width, height, dataUrl?, error?, hint?}`（合成标注写剪贴板；`apply=true` 同时替换钉图并返回新 PNG）、`pin_copy {id} -> {ok, error?, hint?}`、`pin_close {id} -> {ok}`。
- 事件（Rust → capture-*）：`capture-longshot-progress {frame, height}`、`capture-longshot-done {ok, width, height, pinId?, error?}`；Rust → pin-*：`pin-close {id}`。

### 11.5 钉在桌面
- 每个 pin 一个窗口 label `pin-<id>`：无边框、透明、always on top、skip_taskbar、resizable=false、visible=false（先建后显示）。宽度 = 图片物理宽度 / DPI，最大不超过工作区宽 70%；高度 = min(图片逻辑高度, 工作区高 70%)——超长图（长截图）保持可读宽度、窗口内容可滚动，不整体缩成细条。**位置 = 截图选区左上角**（单显示器用 `monitor 原点 + rect`，跨显示器用 `globalRect` 原点；自动滚动长截图用 `origin + crop`，手动长截图用 `geometry.selection_screen`），clamp 到该点所在显示器工作区；`create_pin(anchor=None)` 才退化为光标居中（内部兜底）。这样点「钉在桌面」后图片停在原选区位置，不会跟着截图工具栏（选区下方）的光标往下跳。
- 普通图片（高度未超出窗口）**不显示滚动条**：`body` 默认 `overflow: hidden`，仅当图片实际高度大于窗口时由 `pin.js` 加 `is-scrollable` 类启用滚动；滚动条复用项目现有样式（8px、透明轨道、圆角 999 的 `--border-strong` 滑块，hover `--text-faint`）。
- `pin.html`（新文件）：加载后调用 `pinAPI.ready(id)` 取图并显示；鼠标按住任意位置拖动窗口（`pin_drag` 增量，位置 clamp 到虚拟桌面，可拖到任意显示器）；**鼠标滚轮缩放**（`pin_zoom`，每格约 10%，最小 15%、放大无产品上限——以**图片左上角**为锚点，底部短暂显示百分比；长图高度仍受工作区 70% 上限并用滚动条浏览，滚轮留给缩放）；双击关闭；Esc 关闭；悬停右上角显示三个**图标按钮**「编辑」「复制」「关闭」——该操作区的**背景完全透明**（无卡片/边框/阴影，白色图标加阴影以便在任意图片上辨认）；右键菜单含「复制」「关闭」。
- **钉图编辑模式**：点击「编辑」图标进入——图片上方叠加标注画布（复用 `capture-annotate.js`），出现**与截图工具栏同一组件设计**的白色卡片工具栏（图标 + 文字、32px 按钮、分隔线）：形状（点击即激活工具，属性栏提供矩形/圆形/直线子模式）、箭头、画笔、文字、序号、马赛克、撤回（Ctrl+Z）/重做（Ctrl+Y）、提取文字/翻译/解释图片（`pin_skill`，结果流入 picker 面板）、**已启用的自定义图片技能**（与截图工具栏同序）、取消（红色图标）、确认（绿色图标 + 文字）。**点击已激活的工具再次点击即退出该工具**（与截图工具栏一致）。
  - **标注属性栏（palette）与截图完全一致**：激活任一绘图工具后，工具栏下方出现截图同款属性栏（同一 DOM 结构 + 同一套 CSS + 同一套交互，直接复用 `capture-palette` / `palette-*` 类名与 id）：形状工具 = 形状子模式（矩形/圆形/直线）+ 描边/填充 + 粗细滑块 + 颜色；箭头/画笔 = 粗细 + 颜色；文字 = 字号 + 粗体 + 文字背景 + 颜色；序号 = 字号 + 粗体 + 颜色；马赛克 = 块大小。颜色按钮打开同一套 10 色预设下拉 + 「自定义」HSV/色相/RGB/预览面板 + **吸管**（在钉图上取色，`editor.sampleColor`，与截图取色同交互）。属性栏左对齐工具栏、位于工具栏下方（`PALETTE_GAP=8`），工具切换时组显隐与截图规则相同（直线隐藏填充、马赛克隐藏颜色），值/激活态实时同步。
  - **单行靠左**：工具栏与截图工具栏一致——**固定一行、靠左排列、永不换行**。进入编辑时 Rust `pin_edit_window {id, editing, toolbarHeight, toolbarWidth}` 同时做三件事：① 把钉图窗口加高一条透明条（优先在图片下方；下方空间不足时在图片上方，并返回 `topPadding` 让渲染端把图片下移）；② 把窗口**加宽到单行工具栏/属性栏的最大宽度**（向右扩，工作区右边不够时整体左移并返回 `leftPadding`，渲染端用 padding-left 保持图片屏幕位置不变；返回 `clamped` 表示工作区宽度受限，渲染端退化为紧凑图标模式后重试一次）；③ 按属性栏是否显示动态加高/缩回透明条，工具栏随之上移，让属性栏始终位于工具栏正下方（与截图布局一致）。图片在编辑期间保持进入前的 CSS 尺寸（`--pin-image-width`），只有透明区域变多。工具栏 `left = leftPadding + 8px`，对齐图片左边缘。长图（窗口内滚动）没有垂直外置条（`toolbarHeight=0`），属性栏浮在图片上，但仍会加宽窗口以保持单行。
  - **紧凑模式**：`picker.compact` 下工具栏只显示图标（隐藏文字标签），高度/宽度随之变化时重新测量并调整外置条尺寸；工作区确实放不下时自动退化为紧凑模式（仅本次编辑）。属性栏不受 compact 影响（与截图一致）。
  - 取消按钮图标红色、确认按钮图标/文字绿色（与截图工具栏一致）。编辑期间禁止窗口拖动、滚轮缩放、右键菜单与双击关闭；**Esc 顺序与截图一致：吸管 → 自定义颜色面板 → 预设颜色下拉 → 取消当前工具 → 退出编辑并丢弃标注**。退出编辑恢复原窗口几何后才撤销图片固定宽度/padding，避免图片闪烁拉伸。
- `window.pinAPI = { ready(id), drag(id,dx,dy), copy(id), close(id) }`（tauri-api.js 提供 + mock）。
- 关闭 pin 不退出截图流程（截图 overlay 已关闭）。

### 11.6 长截图（v1）
- 前置：已有选区；点击「长截图」后 capture overlay 隐藏（必须释放焦点/让滚轮到达下层应用，且 overlay 不进入帧），前端仍接收进度事件但窗口不可见。
- ~~capture 窗口自身需 `WDA_EXCLUDEFROMCAPTURE` 排除~~（第十二轮起作废：overlay 不排除，见 §11.11.1；长截图抓帧前隐藏 overlay）。
- Rust 流程：取 session 首帧裁切选区 → 循环最多 30 帧：光标移到选区中心 → SendInput 滚轮向下（3 格）→ 150ms → `xcap` 抓同显示器 → 裁切区域 → 在已拼接图底部 10%–90% 范围内按行像素差找最佳重叠（阈值内）→ 拼接新增行；停止条件：无重叠 / 与上帧相同 / 超过 30000px 高 / 30 帧。
- 结束：合成 PNG 写剪贴板 + 创建 pin 窗口展示（超长图窗口内滚动）+ emit `capture-longshot-done`；capture 前端收到 done 后关闭 overlay。失败：先重新显示 overlay，再 emit done{ok:false,error}（前端 toast，选区可继续操作）。
- 日志：`longshot: frames=N height=H stop=no-overlap|same-frame|max-height|max-frames`，每帧另有 `longshot frame=N same=... overlap=... height=...`。重叠判定用稠密采样平均差异（容忍平滑滚动的亚像素偏移）。
- v1 限制：只向下滚动；依赖目标应用响应滚轮（UIPI/管理员窗口、视频/动画内容、固定悬浮窗会失败或错位）；忽略标注图层。

### 11.7 撤回/重做与键盘
- `Ctrl+Z` 撤回、`Ctrl+Y`/`Ctrl+Shift+Z` 重做；工具激活时 `Esc` 优先取消当前绘制，其次退出工具，最后取消截图。
- 工具切换保留已绘制标注；清除全部可另设（palette 提供「清除标注」按钮 `#palette-clear`，需二次确认或直接清除+可撤销）。

### 11.8 验收
- 形状（矩形/椭圆/直线 × 描边/填充）、箭头、画笔、文本（含背景色/粗体/字号）、序号（递增）、马赛克均可绘制，颜色/粗细可调；标注后复制/确认/图片技能/钉在桌面导出的图片包含标注（像素级合成、位置正确）。
- 撤回/重做按钮与 Ctrl+Z/Ctrl+Y 生效，按钮禁用态正确。
- 钉在桌面：可拖动、双击/Esc 关闭、复制/关闭按钮可用；大图按比例适配屏幕。
- 长截图：自动滚动并拼接，结果生成 pin 窗口 + 复制到剪贴板；停止条件与日志正确。
- 不破坏既有：选区移动/缩放、复制/提取文字/翻译/解释图片/自定义图片技能、紧凑模式、确认/取消、overlay 复用与性能。
- `cargo test` 通过；`cargo check` 无错误；`node --check` 全部通过。

## 11.10 第十一轮修订：工具子菜单、形状布局与颜色面板（权威）

参考 QQ 截图的操作手感，对 §11.2/§11.3 做如下**覆盖性**修订。

### 11.10.1 弹出层方向
- 点击标注工具（shape/arrow/pen/text/number/mosaic）后，属性栏 `#capture-palette` 默认出现在 `#capture-bar` **下方**（水平对齐工具条），当下方可用高度 < 属性栏高度 + 8px 时自动改为上方。
- 属性栏内的弹层（颜色面板 `#palette-color-popover`、自定义颜色面板 `#palette-custom-color`）默认从触发按钮**向下**展开；下方空间不足时向上展开。弹层定位需 clamp 在视口内。
- 任何弹层点击外部关闭；Esc 优先关闭最上层弹层，再退工具，最后取消截图。

### 11.10.2 形状工具布局（`capture.html` / `capture.css`）
- 删除 `select#capture-shape-mode`，改为形状子菜单按钮组 `#palette-shapes`（位于属性栏最左）：
  `button[data-shape="rect"]` 矩形、`button[data-shape="circle"]` 圆形、`button[data-shape="line"]` 直线；当前模式 `.is-active`。
- **椭圆统一改名「圆形」**：内部 shapeMode 值用 `rect|circle|line`（`ellipse` 仅作为旧值别名兼容，不再展示）。
- 直线（line）是独立可见的形状项；选择 line 时隐藏「填充」组。
- 形状属性栏顺序（QQ 风格）：`[矩形|圆形|直线] | [颜色按钮] [粗细] | [填充]`；箭头/画笔顺序：`[颜色按钮] [粗细]`；文字：`[颜色按钮] [字号] [粗体] [文字背景]`；序号：`[颜色按钮] [字号] [粗体]`；马赛克：`[块大小]`。

### 11.10.3 颜色面板（QQ 风格，所有绘图工具共用）
- 颜色按钮 `#palette-color-button`：显示当前颜色色块 `#palette-color-swatch` + 下拉箭头；点击展开 `#palette-color-popover`（默认向下、空间不足向上）。
- 预设色块：10 个 `button.palette-color[data-color]`（QQ 常用色：`#f44336 #ff9800 #ffeb3b #8bc34a #00bcd4 #2196f3 #9c27b0 #ffffff #9e9e9e #000000`），当前色带选中描边。
- 自定义颜色入口 `#palette-color-custom`（彩虹色块）：点击展开自定义颜色面板 `#palette-custom-color`（默认向上/向下自适应，与 popover 同方向策略）：
  - `#palette-hsv`：HSV 饱和度/明度渐变取色区（尺寸约 180×130，白色到纯色到黑），内部光标 `#palette-hsv-cursor`；
  - `#palette-hue`：色相滑条（0–360，彩虹渐变），滑块 `#palette-hue-thumb`；
  - RGB 数字输入 `#palette-rgb-r` / `#palette-rgb-g` / `#palette-rgb-b`（0–255，改动实时生效）；
  - 预览色块 `#palette-custom-preview`；
  - 吸色器按钮 `#palette-eyedropper`；
  - 支持拖动取色区/色相条实时更新颜色，Esc/点击外部关闭。
- **吸色器**：点击 `#palette-eyedropper` 进入吸色模式：`body.picking-color`、光标 crosshair、所有工具暂停绘制；点击截图任意位置用冻结截图取样（`CaptureAnnotate.sampleColor(x, y)`，返回 `#rrggbb`）并应用到当前工具颜色；Esc/右键取消吸色。
- 颜色/面板状态在工具切换间保留（与现有 options 一致）；「无颜色」不适用。

### 11.10.4 交互与验收
- 属性栏与弹层均为白色主题（沿用现有样式 token），圆角 12、边框 `#e2e8f0`、阴影轻量；紧凑模式仍只影响工具条 label。
- 验收：点击形状→属性栏在工具条下方，含矩形/圆形/直线三个按钮；切换三者绘图正确（圆形画圆/椭圆，直线无填充组）；颜色按钮展开面板在下方（底部空间不足时翻到上方）；面板含 10 预设色 + 自定义入口；自定义面板含 HSV 区/色相条/RGB 输入/吸色器；吸色器点截图可取到该像素颜色并应用；所有绘图工具都有颜色按钮且拖动宽度即时生效；console 无错误。
## 11.11 第十二轮修订：截图界面可见性、重复触发与实时预览（权威）

### 11.11.1 截图界面不再对其它截图/录屏隐藏
- capture overlay 窗口**不得**设置 `WDA_EXCLUDEFROMCAPTURE`（或任何捕获排除）：系统截图、第三方截图工具与录屏软件应能正常拍到 Lexora 的截图界面（用户明确要求）。
- 长截图在抓帧前隐藏 overlay（`hide_capture_windows`）即可，不依赖捕获排除。
- 设置窗口、picker 面板继续不排除（第五轮语义不变）。

### 11.11.2 单实例截图守卫（QQ 行为）
- 已有截图会话（overlay 已 armed/显示中，未 close/copy/skill 结束）时再次触发截图（热键 / picker「截图」按钮 / 命令 `start_capture`）必须被拒绝：
  - `start_capture` 返回错误：message「已经在截图了。」hint「请先完成当前截图（或按 Esc 取消）后再试。」；
  - 不重置/替换当前 session，不隐藏当前 overlay，不重新抓屏；
  - 日志记录 `screenshot capture ignored: a capture is already active`。
- 长截图运行中仍按 §11.6 拒绝并提示。

### 11.11.3 标注拖动实时预览
- 形状（矩形/圆形/直线）、箭头、画笔：鼠标按下后拖动过程中**实时绘制**当前图形（pointermove 时更新画布），松开鼠标才把该图形提交为一步可撤销的标注；`pointercancel` / 绘制中 Esc 丢弃未提交图形。
- 导出（`renderToPng`）与截图动作只包含已提交标注，不含拖动中的草稿。
- 马赛克保持实时涂抹；文字/序号仍为点击即提交。

### 11.11.4 验收
- 用系统截图（Win+Shift+S）或录屏工具时能看到 Lexora 截图界面；
- 截图界面已显示时再次按截图快捷键/点截图按钮：不重新抓屏、不重置界面，给出已存在的提示；
- 形状/箭头/画笔拖动时图形实时跟随，松开后 undo 一步可撤掉整个图形；导出不含草稿。
### 11.10.5 第十三轮修订：形状属性栏布局与实心填充
- 形状属性栏顺序：`[矩形|圆形|直线]` → `[描边|填充]` → `[粗细]` → `[颜色按钮]`（**颜色在选择器最后**）；删除描边/填充前的「填充」文字说明。
- 形状按钮、描边/填充按钮、颜色按钮保持同一视觉高度（约 32px），同一行垂直居中对齐。颜色按钮为 `46×32` 横向按钮：左侧 20×20 色块、右侧 10×10 下拉箭头，两者垂直居中且中间留 5px（参考 QQ 布局，第十四轮修订）。
- 其它绘图工具属性栏也把颜色控件放最后：arrow/pen = 粗细 → 颜色；text = 字号 → 粗体 → 文字背景 → 颜色；number = 字号 → 粗体 → 颜色；mosaic 无颜色。
- 填充模式（`fill="fill"`）的矩形/圆形必须**实心填充且不透明度 100%**（alpha=1.0）；描边仍按当前颜色/宽度。拖动预览、已提交标注、`renderToPng` 导出三处一致；描边模式内部保持透明。
### 11.10.6 第十五轮修订：QQ 风格箭头
- 箭头（`arrow`）绘制改为 QQ 截图样式：**实心三角形箭头 + 锥形尾巴**。
  - 尾部从起点附近的近零宽度线性张宽到箭头底部的窄颈；
  - 头部为实心三角形，底边明显宽于尾颈（形成两侧倒钩/barbs），尖端即拖动终点；尾颈（靠近三角处的尾部宽度）约为头部底边的 1/2（第十六轮加宽，避免尾锥过细）；
  - 头部长度随线宽缩放（宽度越大头部越大），但不超过箭头总长的一半；全部使用当前颜色实心填充，无描边。
- 拖动实时预览、已提交标注、`renderToPng` 导出共用同一绘制函数，三者形状必须一致。
### 11.11.5 第十七轮修订：标注不得超出框选范围
- 所有标注（形状/箭头/画笔/文本/序号/马赛克）只能出现在选区矩形内：
  - 渲染时对画布做选区裁剪，选区外的像素保持透明（不受已有标注影响）；
  - 拖拽起点必须在选区内，拖拽过程中指针可移出选区但图形坐标被 clamp 在选区边界（QQ 行为）；
  - 文本/序号点击在选区外时不产生标注；
  - 选区移动/缩放后已有标注按选区裁剪显示；
  - 导出（renderToPng）本来就按选区裁切，行为不变。
- 选区为空（尚未框选）时不启用裁剪（保持旧行为）。
## 11.12 第十八轮修订：标注选中、移动、形变与旋转（权威）
- 所有标注类型（rect/circle/line/arrow/pen/text/number）都可**点击选中**并支持**移动 / 缩放（形变）/ 旋转**。
- 数据结构：每个标注新增 `rotation`（弧度，默认 0）；缩放直接改写几何字段，旋转渲染时应用。
- 命中测试：考虑线宽/文字 bounding box/画笔路径附近容差；有旋转时先把点反旋到未旋转坐标再判定。
- 选中 UI（画布上绘制，不参与导出、不受选区裁剪）：
  - 虚线/主色边框包围盒 + 8 个缩放柄（四角 + 四边中点）+ 1 个旋转柄（上边中点上方约 24px，圆形箭头图标）。
  - 拖动内部 = 移动；拖动角柄 = 自由缩放；拖动边柄 = 单轴缩放；拖动旋转柄 = 绕包围盒中心旋转（Shift 吸附 15°可选）。
  - 点击空白 = 取消选中，并恢复原有选区拖拽/移动/缩放行为。
- 键盘：`Delete`/`Backspace` 删除选中标注；`Esc` 优先级：取消选中 → 关闭弹层 → 退出工具 → 取消截图。
- 工具激活时：绘制行为不变；**新绘制的标注不自动选中**（第十九轮修订）——之后点击已有标注即可重新选中并显示手柄（工具激活或未激活都支持；工具激活时点击已有标注=选中并拖动移动，空白处仍开始新绘制）；选中标注的手柄即使在工具激活时也可拖动；在选中标注内部拖动 = 移动该标注（不新建图形）。
- 缩放几何规则：rect/circle 改 x/y/w/h；line/arrow 缩放两端点；pen/mosaic 对点集按包围盒缩放；text/number 按包围盒缩放位置与字号（保持可读比例）。
- 所有变换（移动/缩放/旋转/删除）都提交为一步 undo；redo 正常。导出（renderToPng）与画布显示一致（含 rotation 后的几何）。
- 与 §11.11.5 裁剪的关系：标注本身仍裁剪到选区；选中手柄与边框可画在选区外且不裁剪。
### 11.12.1 第二十轮修订：文字框垂直居中与变换实时反馈
- 文字/序号标注的选中包围盒与文字块垂直居中：文字以「每行中线」为基线绘制，包围盒高度 = `lineHeight * 行数`（含背景 padding），文字在框内上下居中，不再顶部对齐留白。
- 变换（移动/缩放/旋转）拖动过程中，选中虚线框与 8+1 个手柄必须**实时跟随**（使用变换预览几何），不再等鼠标松开才更新；`getSelectedBounds`/`getSelectionHandles` 在拖动中返回预览几何。
### 11.13 第二十一轮修订：退出截图无闪烁
- capture overlay 与 picker/settings 窗口创建后设置 `DWMWA_TRANSITIONS_FORCEDISABLED`（禁用 DWM 打开/关闭过渡）。否则 hide 时透明 overlay 会淡出约 150ms，表现为退出截图时闪一下/抖动。
- 验收：屏幕录制 60fps 回放退出瞬间，overlay 应在**单帧内**消失（无多帧淡出），退出后画面稳定（除被捕获内容自身变化外）。
## 11.14 第二十二轮修订：QQ 式手动滚动长截图（权威）
- 交互流程：有选区时点击工具条「长截图」→ capture overlay 隐藏 → 在选区**侧边**（优先左侧，空间不足放右侧）出现长截图预览窗口；用户**手动滚动**目标应用，预览实时显示已拼接长图；预览窗口提供滚动方向（竖向/横向）、完成、取消。
- 全程**不再自动滚动**：不使用 SendInput 滚轮 / SetCursorPos 滚屏；目标应用由用户自己滚动。
- 预览窗口（新窗口 label `longshot`）：无边框、置顶、skip_taskbar、不抢前台焦点（WS_EX_NOACTIVATE；点击控件仍可用）；宽约 340–420 逻辑像素，高 ≤ 工作区 70%；垂直对齐选区顶部并 clamp 工作区。内容：方向 segmented（竖向/横向，默认竖向）＋ 完成/取消 ＋ 当前拼接图预览（等比缩放完整显示）＋ 尺寸/帧数/提示（如「请缓慢滚动页面以拼接长截图」，stalled 时提示滚动过快/方向不符）。
- 命令（在 tauri-api 中暴露为 `window.longshotAPI`）：
  - `longshot_start {index, rect} -> {ok,width,height,direction}`：隐藏 capture overlay、裁切首帧、启动后台抓帧循环、创建并显示预览窗口。
  - `longshot_state {} -> {ok,width,height,frames,direction,stalled,done}`。
  - `longshot_preview {} -> {ok,dataUrl,width,height}`：当前拼接图 PNG data URL（前端按需轮询，尺寸未变化可跳过）。
  - `longshot_direction {direction:"vertical"|"horizontal"} -> {ok}`：切换方向并以当前选区帧重置拼接。
  - `longshot_finish {} -> {ok,width,height,pinId?,error?,hint?}`：停止循环、写剪贴板、创建 pin 窗口（§11.5）、销毁预览窗口。
  - `longshot_cancel {} -> {ok}`：停止循环、销毁预览窗口、重新显示 capture overlay，并向 capture-* emit `longshot-cancelled`。
  - 事件：`longshot-progress {width,height,frames,stalled}` → longshot 窗口；`longshot-cancelled` → capture-*。
- 拼接规则：循环约 8fps 抓取选区帧；与当前拼接图相同则跳过；按方向寻找 10%–90% 范围内的最佳重叠（竖向=行采样、横向=列采样，容忍平滑滚动亚像素差异），追加不重复部分；无可靠重叠时不追加并标记 `stalled=true`（继续尝试后续帧）；方向切换重置。内存/尺寸上限：竖向高度 ≤ 30000，横向宽度 ≤ 40000，总像素 ≤ 64MP，超限停止追加并提示。
- 完成/取消兼容：完成后复制+钉图；取消恢复截图 overlay，用户可继续框选/标注/确认。旧自动滚动 `capture_longshot` 不再由 UI 调用（保留但标注 deprecated）。
- 验收：长页面选区→点长截图→预览窗口出现在选区侧边（左/右自适应）；手动缓慢竖向滚动时预览图持续增长且拼接无缺行/重复；切横向在宽内容上滚动可横向增长；完成→剪贴板+钉图；取消→回到截图 overlay；全程无自动滚动；console/日志无错误。

### 11.14.1 第二十三轮修订：长截图 1:1 参考设计（覆盖 §11.14）
- 进入长截图后**不再隐藏整个 capture overlay**：选区内显示目标应用的**实时画面**（隐藏冻结截图 `<img>`，保持窗口透明），选区边框/外侧暗色遮罩保持可见；选区外元素（工具条/属性栏/裁切手柄）隐藏，避免遮挡与误捕获；overlay 窗口设置 `ignore_cursor_events(true)`，让滚轮/点击穿透到目标应用（用户能自由上下/左右来回滚动）。
- 事件：Rust emit `longshot-started {index}` → capture-* 进入 live 模式（body class `is-longshot-live`，隐藏截图 img 与手柄）；`longshot-cancelled` → 退出 live 模式并恢复冻结截图/手柄/工具条（既有）。完成时关闭 capture 会话/overlay（既有）。
- 抓帧区域在选区基础上四周内缩约 2 CSS px（物理按 DPI 换算），避免把选区边框画进长图。
- **双向滚动**：竖向允许向下/向上来回滚动，横向允许向左/向右来回滚动。每帧与已拼接图同时尝试「向后追加」和「向前插入」（竖向=行；横向=列，沿用 90° 旋转复用），选择有效重叠的方向拼接；无有效重叠→stalled（提示滚动过快/方向不符），继续尝试。
- **平滑预览**：`longshot-progress {width,height,frames,revision,stalled}` 每次拼接后立即发送（带单调递增 revision）；前端收到后按 revision 拉取 `longshot_preview`（节流 ≤ 100ms）刷新，使用双缓冲/解码后切换 `<img>`，避免闪烁卡顿；`longshot_preview` 下采样到约 720px 宽（面板显示足够清晰），返回完整 width/height。
- 其余：方向切换（竖向/横向）仍重置拼接；完成→全分辨率图写剪贴板+pin；取消→停止、恢复 overlay 交互与 UI。全程无自动滚动。
- 验收：长截图时选区内可见应用实时内容与蓝色选框，滚轮可直接滚动目标应用（上下/左右来回均可）；侧边预览随滚动平滑增长（无卡顿/闪烁，≤100ms 级刷新）；抓帧不含选区边框；完成/取消行为正确。

### 11.14.2 第二十四轮修订：QQ 式控制栏 / 动态预览 / 高速拼接 / 完整展示（覆盖前两节）
- **控制栏独立窗口**（label `longshot-bar`，页面 `longshot-bar.html`）：进入长截图后它出现在**主截图选区正下方**（与截图工具栏同一位置，空间不足时上方，水平对齐并 clamp 工作区），内容为「选择方向 [竖向|横向] ｜ 第 N 帧 · 宽×高 ｜ 取消（红） 完成（绿）」。它必须是独立可点击窗口：capture overlay 在长截图期间整体 `ignore_cursor_events(true)`（滚轮要传给目标应用），overlay 上的按钮点不到。预览窗口顶部不再有任何控制项。
- **预览窗口重做**（label `longshot`，页面 `longshot.html`）：**不透明**无边框窗口（透明窗口每次 resize 都走 DWM alpha 合成，增长时会闪；改为不透明白底），窗口内只有拼接图（双缓冲切换、无淡入过渡），**没有任何状态胶囊 / 错误条 / 提示**。宽度固定 472 逻辑 px（加倍，内容清晰可读）；**高度随拼接图比例动态调整**（`preview_window_size_for`：内容高 = (宽-12)×图高/图宽 + 12，上限 = min(86% 工作区, 920)，且不超过选区顶部到工作区底部的空间）；Rust 在拼接后节流 resize（**变化 ≥6px 且间隔 ≥140ms** 才调 `set_size`，避免每帧 resize 造成闪烁）。窗口仍垂直对齐选区顶部、放选区侧边（左优先后右侧）。
- **预览 PNG 恒定额度**：`longshot_preview` 不再按固定宽度缩放整图，而是把拼接图**非等比缩放（`Stitched::resized_to`）到预览窗口的内容框物理像素尺寸**（≈690×≤1360），因此长图再长，单帧 PNG 尺寸/编码耗时/IPC 数据量也保持恒定。
- **高速/鲁棒拼接**：抓帧 ~25fps（40ms 间隔，抓完立即下一帧，抓取本身更慢时全速）；最小重叠从 10% 降到 **3%**（快速滚动时步长大也能匹配）；重叠搜索改为两阶段：对**每个**候选做稀疏评分（不漏真实值）→ 前 24 个候选做密集精确评分 → 在「几乎同样好」的候选里选**最接近上一帧步长（expected）**的那个（重复文本行不会拼错位置）。连续 3 帧无匹配才置 `stalled`（单帧撕裂静默跳过），不限制用户滚动速度。方向切换后下一帧以**当前屏幕内容**重新同步（`resync`），不再卡在最初首帧导致后续无法拼接。
- **完成后完整展示**：长截图钉图（§11.5 `pin_display_size`）优先「整图适配」：整个长图缩放到工作区高度 92% 内，宽度不窄于 120 逻辑 px 时直接完整显示（无滚动条）；更极端的细长图才保持可读宽度并在窗口内滚动（高度上限同样提高到 92%）。
- 验收：`tests/e2e-longshot.ps1` —— 控制栏出现在选区下方（x 对齐、y = 选区底 + 4~10）、预览窗口宽 472 且高度随滚动增长、无 stalled、方向切换后继续滚动仍能拼接、完成后 pin 无滚动条且图片高度 = 窗口高度（整图可见）。

### 11.14.3 第二十五轮修订：无白闪启动 + 自动滚动（ShareX 式）+ 抗干扰匹配
- **预览无白闪启动**：预览窗口创建时 `visible(false)`，开始长截图只显示控制栏；前端 `longshot.html` 在**首张预览图 decode 并切换后**调用 `longshot_preview_ready`，Rust 才 `show()` 预览窗口（show 后把焦点还给选区下的应用）。抓帧线程有 3 秒兜底：若前端异常未上报，也会自动显示预览。这样不会出现"开始长截图先闪一下白色预览窗"。
- **自动滚动模式**（控制栏新增「自动滚动」toggle，参考开源的 ShareX Scrolling Capture 思路）：开启后由 shell 自己滚动目标应用——每个周期把光标移到选区中心（`SetCursorPos`），发送滚轮 `SendInput`（竖向 `MOUSEEVENTF_WHEEL`、横向 `MOUSEEVENTF_HWHEEL`，每次 3 格，正数=向下/向右），等待 240ms 让页面渲染稳定后再抓帧拼接；因此每帧位移固定、无滚动动画期，重叠匹配几乎不会失败。连续 2 帧完全相同（页面到底）时自动退出自动滚动。手动滚动始终可用（可随时叠加/接管）。`longshot_state` 与 `longshot-progress` 增加 `autoscroll` 字段，控制栏按钮据此高亮；完成/取消/方向切换时自动滚动随会话复位。
- **抗干扰匹配**：重叠评分的横向采样跳过左右各约 4%（`overlap_sample_x`），避免选区里的滚动条滑块、窗口边框/阴影在滚动时污染差异值；重叠阈值从 3.0 放宽到 **7.0**（`LONGSHOT_OVERLAP_MAX_MEAN_DIFF`），容忍网页滚动中的抗锯齿/小动画/重渲染差异——被拒绝的一帧就是永远丢失的内容，宁可宽松再用 `expected` 步长消歧。
- 新增命令：`longshot_preview_ready {} -> {ok, shown}`、`longshot_autoscroll {enabled} -> {ok, autoscroll}`（`window.longshotAPI.previewReady()` / `.autoscroll(enabled)`）。
- 验收：e2e —— 点击「自动滚动」4 秒内 `frames` 从 1 涨到 6、`height` 564→1819 且 `autoscroll=true`；关闭后手动滚动继续拼接到 12 帧；完成后 pin 整图可见。

### 11.14.4 第二十六轮修订：选区同色边框预览 / 连续 WGC 抓帧 / 慢速且不夺鼠标的自动滚动 / Esc 取消（覆盖前三节）
- **预览外观与位置**：预览窗口为**全透明**窗口（无白底/白卡片），图片外只有一圈 **2px `#4f46e5` 边框（与截图选区边框同色同粗细）**。位置在**选区侧边靠下、与选区底部对齐**（右侧优先，右侧空间不足放左侧，最后 clamp 工作区）；窗口**高度固定**（≤选区高、≤min(62% 工作区, 760)），**宽度 = 高度 × 拼接图宽高比**（随长图变长而变窄，最小 90），图片填满窗口（`object-fit: fill`，无 letterbox）。窗口随每次拼接节流 resize（≥6px 且 ≥200ms），不再保留固定尺寸的透明大窗口。
- **预览编码**：预览用 **JPEG（质量 78）**，目标尺寸 = 窗口物理尺寸（窗口比例=图片比例），单帧通常 ~120KB（旧 PNG 可达 1MB+），解码/刷新更顺滑。
- **连续 WGC 抓帧（关键修复）**：不再每帧调用 `Monitor::capture_image()`（反复创建/销毁 GraphicsCaptureSession 在真实桌面会 stall/超时，导致预览永远停在第 1 帧）。改为长截图开始时建立**一个持续的 `video_recorder` WGC 会话**，屏幕变化时推帧，抓帧线程取最新帧裁剪拼接；会话不可用时回退到逐帧抓取。显示器改用 `Monitor::from_point(选区中心)` 选择（避免坐标匹配失败后错拿第 1 台显示器）；抓帧/裁剪失败只记日志、**永不停止抓帧线程**。
- **自动滚动调整**：速度放慢（每次 **2 格** + **520ms** 渲染稳定等待）；**不再移动鼠标**（用户可自由移动）；只有光标位于选区内时才发送滚轮——光标尚未进入选区时**等待**（点击控制栏后鼠标在选区外），进入后开始滚动，**移出选区即停止**；按钮文字在「自动滚动 ↔ 停止滚动」间切换（`aria-pressed` 同步）；到页底（连续 2 次无新帧）自动停止；手动滚动始终可用。
- **Esc 取消**：抓帧线程每轮用 `GetAsyncKeyState(VK_ESCAPE)` 轮询（低位标志保留按下事件，40~500ms 轮询不会漏），长截图期间按 **Esc 立即取消**并恢复截图 overlay（overlay 是 click-through，收不到键盘事件，必须全局轮询）。
- **长图钉图取整修复**：`create_pin` 的窗口高度改由"窗口宽 × 图片宽高比"推导（不再两侧独立取整），消除了整图适配时底部被裁 4~5px、误判出现滚动条的问题。
- 验收：`tests/e2e-longshot.ps1` —— 预览固定宽 560、蓝框 `rgb(79,70,229)`/2px、无任何提示 DOM；自动滚动 5 秒 `frames` 1→8 且按钮 `aria-pressed=true`/文字「停止滚动」；手动滚动继续到 19 帧；完成后 pin 图片高 = 窗口高且无滚动条；重建长截图后按 Esc 两个长截图窗口消失（`ESC_CANCEL_WORKED=True`）。
