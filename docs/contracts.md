# Lexora 工程契约（Tauri v2 版）

本文件是并行开发期间的唯一接口契约。**实现必须与本文一致**；需要调整先通知 Lead 改本文件，再改代码。Electron 版设计稿（设置页字段、picke r行为）仍适用，技术栈已切换为 **Tauri v2 + Rust + 原生 HTML/CSS/JS**。

## 1. 目标与决策

把 `enterprise-ai-translator` 的划词工具抽取为独立开源 Windows 免安装应用 **Lexora**：

- 完整保留划词体验：拖动选词、双击/多击选词自动弹出工具栏；翻译（流式）、总结、解释、朗读、复制；结果面板（固定/关闭/目标语言/重试，头部可拖动窗口）；菜单（本应用禁用、设置、禁用工具）；应用黑名单；技能配置/拖拽排序/提示词编辑；紧凑模式；多屏 DPI 定位；面板按内容缩放。全局快捷键已移除。
- 双模式翻译：**在线**（任意 OpenAI 兼容 `/v1/chat/completions`，含 Ollama/LM Studio）与**本地**（内置 llama.cpp 引擎 = 按需下载，自管理 `llama-server.exe` + 用户下载/导入 GGUF）。
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
- 结构：`settings.json`、`models/*.gguf`、`engine/llama-server.exe`、`logs/main.log`、`logs/llama.log`、`cache/*.part`。

## 4. 设置 Schema（已实现 `settings.rs`，camelCase JSON）

```jsonc
{
  "version": 4,                              // v1→v2 补 polish/search；v2→v3 补 screenshot；v3→v4 补 capture；保留 custom
  "picker": {
    "enabled": true,
    "skills": ["translate","summarize","explain","polish","read","copy","screenshot","search","custom-mvmei8cru1n5"],
    "compact": false,
    "defaultTargetLang": "auto",          // auto + Hy-MT2 支持的 38 种语言（zh/en/zh-hant/yue/ja/…/ug）；auto 显示为「自动识别」
    "blacklist": [],                      // 进程名，可含 .exe
    "maxChars": 5000,
    "searchEngine": "google",             // google | baidu | bing（搜索技能）
    "panelMode": "auto",                  // auto = 无滚动条、窗口随内容变高；scroll = 固定窗口、面板内滚动
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
    "local": { "contextSize": 4096, "threads": 0, "gpuLayers": 0, "autoStart": true, "keepRunning": false }
  },
  "app": { "closeToTray": true, "startAtLogin": false, "theme": "system" },
  "capture": {
    "regionShortcut": "Win+Shift+X"       // 截图快捷键（可改）；规范格式见 §10.3，非法值回退默认
  }
}
```

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
| `picker-data` | picker | `{text, programName, config:{skills,customSkills,compact,defaultTargetLang,searchEngine}}` |
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
  "catalog": [ {"id":"hy-mt2-1.8b","name":"腾讯混元 Hy-MT2 1.8B（翻译模型）","description":"...","filename":"...",
                "sizeBytes":1117320736,"license":"Apache-2.0","languages":"多语言","recommended":true,"installed":false,"vision":false} ],
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
  - 不再有「选择模型」配置：引擎按功能自动选择已安装模型。`translate` 优先 Hy-MT2（未安装则回退 Qwen/任意已装 GGUF）；`summarize`/`explain` 优先 Qwen2.5 3B（未安装则回退 Hy-MT2/任意已装 GGUF）。
  - 「启动」由后端选择翻译优先模型并加载；「停止」后 `local_desired=false`，后续翻译/总结请求**绝不自动启动**引擎，只返回「本地模型未启动」错误提示。运行中若功能需要另一个模型，会停止当前 llama-server 并加载目标模型（日志记录 switching），期间请求等待。
- 运行状态记忆：用户点「启动」成功后持久化 provider.local.keepRunning=true；点「停止」置 false；应用退出只停 llama-server，不改 keepRunning。下次启动若为 true 且引擎/模型已安装，后台自动恢复引擎（日志 estoring local engine）并通过 state-changed 刷新设置页与托盘。
  - 未安装引擎 → 错误提示「下载 llama.cpp 引擎」；未安装模型 → 「下载/导入 GGUF」；启动前选空闲端口（TcpListener 127.0.0.1:0），`llama-server.exe -m <model> --host 127.0.0.1 --port <p> -c <ctxSize> -t <threads> -ngl <gpuLayers> --no-webui`，轮询 `/health` 最长 90s，stderr 写 `logs/llama.log`；进程退出/应用退出要清理；服务就绪后复用在线客户端逻辑。
- 提示词（系统默认值为英文，用户可在设置里逐个技能自定义，空字符串表示用默认）：
  - 翻译 system：`You are a professional translation engine. Translate the user's text into {target}. Output only the translation, without explanations, quotes, or the source text.`；`{target}`/`{language}` 替换为英文语言名（38 种 Hy-MT2 语言，如 Simplified Chinese / Traditional Chinese / Portuguese / Uyghur），自定义提示词若不含占位符则在末尾追加 `Target language: <name>.`。
  - 总结 system：`You are a concise Chinese writing assistant. Summarize the user's text in Simplified Chinese and list the key points accurately, without adding anything that is not in the source.`
  - 解释 system：`You are a knowledge assistant. Explain the user's text in Simplified Chinese, covering its meaning, background and key concepts, with short examples when helpful.`
  - 文本截断：翻译取前 `picker.maxChars`；总结/解释取前 8000 字符；自定义提示词归一化后最多 4000 字符。
  - 自定义技能：从 `picker.customSkills` 按 id 查找（不存在/未启用返回明确错误），`prompts::render_custom_prompt` 把 `{text}`（选中文本）、`{target}`/`{language}`（目标语言英文名）、`{program}`/`{app}`（当前应用名，空为「未知应用」）替换进提示词；未知 `{...}` 原样保留；system 为渲染后的提示词，user 为选中文本；本地模型角色使用 General；流式事件与翻译一致。
  - 内置润色：`prompts::polish_messages(text, custom)` 优先使用 `picker.prompts.polish`，空则用 `DEFAULT_POLISH_PROMPT`（英文）；截断 `picker.maxChars`；General 角色；流式事件与翻译一致。
- 引擎下载：默认 URL `https://github.com/ggml-org/llama.cpp/releases/download/b11851/llama-b11851-bin-win-cpu-x64.zip`（23.1MB，已验证存在），可用 `LEXORA_LLAMA_URL` 覆盖；下载到 cache，zip 解压后把包含 `llama-server.exe` 的目录内容平铺到 `engine/`；进度事件 `app.emit("download-progress", ...)`。失败文案给出手动放置说明（解压到 engine 目录）。
- 模型目录（两个模型，已验证 URL）：
  | id | 名称 | 文件 | 大小 | 说明 |
  | --- | --- | --- | --- | --- |
  | `hy-mt2-1.8b` | 腾讯混元 Hy-MT2 1.8B（翻译模型） | Hy-MT2-1.8B-Q4_K_M.gguf | 1,133,080,448 | 翻译专用，仅 ModelScope |
  | `qwen2.5-3b` | Qwen2.5 3B（通用模型） | qwen2.5-3b-instruct-q4_k_m.gguf | 2,104,932,768 | 通用：翻译/总结/解释 |
  - Hy-MT2：`https://www.modelscope.cn/models/liaowenbin/Hy-MT2-1.8B-Q4_K_M-GGUF/resolve/master/Hy-MT2-1.8B-Q4_K_M.gguf`（无 HF 镜像，`hf_url` 为空时跳过）。
  - Qwen2.5 3B：ModelScope（优先）`https://www.modelscope.cn/models/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/master/qwen2.5-3b-instruct-q4_k_m.gguf`；HF（回退）`https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf`。
  - 下载按 `modelscope_url` → `hf_url` 顺序尝试（ModelScope 优先），空 URL 跳过；许可证均 Apache-2.0；`installed` = models 目录中存在同名文件。
- 单测：SSE 解析、URL 归一化、错误映射、catalog 完整性、模型文件名/大小常量；不联网（用 mock 服务的需标 ignored 或用本地 axum? 不允许新增依赖，直接单测纯函数）。

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
- `windows::resize_picker(app, w, h) -> Option<bounds>`：不再有 200–780×40–620 人工限制；非法/非正尺寸回退基础尺寸，合法值 1..=100000，位置仍 clamp 到工作区内；设置 LogicalSize/Position 后返回最终 bounds。
- `windows::move_picker_by(app, dx, dy) -> Option<(f64, f64)>`：按逻辑像素 delta 移动 picker 窗口（结果面板标题栏拖动），clamp 到工作区，返回新的逻辑左上角坐标。
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

- 默认查询 `https://api.github.com/repos/monk233/lexora/releases/latest`（`User-Agent: Lexora/<版本>`，30s 超时）；测试可用环境变量 `LEXORA_UPDATE_API` 覆盖为本地 mock（覆盖时允许 http，仅本地测试使用）。
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
- 结果面板右下角提供缩放手柄：拖动调用 `picker_resize`（无最大限制；最小窗口 360×240，窗口位置仍 clamp 到工作区），尺寸写入 localStorage `lexora.panelSize`，下次打开沿用；手动调整后 `.panel` 填满窗口、内容自适应不再覆盖用户尺寸；双击手柄恢复自动大小。
- 面板模式（picker.panelMode）：`auto`（默认）无滚动条、窗口随内容自动变高、隐藏缩放手柄；`scroll` 使用固定窗口高度、panel-body 内部滚动，可拖拽缩放并记忆尺寸（不小于 360×240）。
- 面板粘滞：结果面板打开时后端 panel_open=true，键盘/右键/滚轮不会隐藏；未钉住时点击面板外区域仍隐藏（钉住则保持）。点击继续提问输入框时按需激活 picker 窗口以获取键盘焦点，关闭面板后恢复非激活。
- 工具栏胶囊在鼠标滚轮/触摸板滚动时自动隐藏；结果面板打开时 wheel 事件不隐藏面板。关闭结果面板时直接隐藏整个 picker（不再回退显示工具栏胶囊）。
- 面板尺寸与窗口一致：自动尺寸按可见 panel 高度计算，窗口底部不再有透明隐藏区；toast 显示在面板顶部覆盖，不额外占位。
- 继续提问/建议区为绝对定位的悬浮层，覆盖在面板正文底部、不占用布局高度；输入行与 chips 独立浮起；panel-body 动态留出底部 padding，保证末尾内容可滚动阅读。
- 翻译/总结/解释/润色/自定义技能成功结果下方显示「继续提问」输入框；提交后调用 `picker_followup`，在同一面板内追加多轮流式问答（沿用 Markdown/复制/朗读/错误重试）。
- 单个单词按源语言处理：英文单词输出英语 IPA + 释义/用法；中文词语输出拼音 + 释义/用法（不输出英语音标）；其他语言只做普通翻译，不附加词典信息。词典释义语言跟随目标语言；解释技能固定中文释义。英文单词结果完成后显示 3 个建议追问 chip（造句/近义词区别/常见搭配），点击即发送 follow-up。
  - 目标语言下拉从 `LP.LANGUAGES`（38 种 Hy-MT2 支持语言）动态生成，不再硬编码 option。
  - 菜单「划词设置…」→ `invoke("picker_open_settings")`；「在此应用中禁用」「禁用划词工具」→ 对应命令。
- 初始尺寸 440×56，白色卡片边缘透明；`picker_ready` 在 DOM 就绪后调用一次。
- 截图结果面板（`picker-image`，见 §10.5）：复用文字技能面板的全部结构与功能（标题/钉住/关闭、语言控件仅 translate、Markdown 流式、朗读/复制/重试、继续提问、resize grip），不新增截图专用面板；OCR 动作以纯文本渲染。

### 7.2 设置页（新建，简洁好用）
- 单窗口、原生标题栏、单页五张卡片（无侧栏/标签页）：**翻译服务**、**划词行为**、**快捷键**、**应用与启动**、**关于**。
- 翻译服务：
  - 分段控件「在线 API / 本地模型」立即保存 mode。
  - 在线：预设下拉（DeepSeek/OpenAI/Moonshot/智谱/Ollama/LM Studio/自定义）、服务地址、API Key（password + 显示切换）、模型名下拉（[拉取模型] 通过 `list_online_models` 拉取 `/models`，并保留「自定义模型…」手填兜底）、[测试连接]（显示延迟/模型列表/错误）、状态徽标。切换预设必须清空上一个服务商的 API Key / 模型名与模型缓存，且**不再自动填充模型名**；已知预设只填服务地址。
  - 本地：引擎状态（未安装→[下载引擎]，显示进度/取消；已安装→版本状态）、已安装模型列表（显示名称、大小、角色徽标：翻译模型/通用模型/**视觉模型**/自定义模型；不再有模型下拉选择）、[下载模型]（弹目录列表：名称/大小/量化/协议/下载按钮+各自进度；多个模型可同时下载、可分别取消；不显示「推荐」标签；视觉模型显示「视觉」徽标，下载时先主模型后投影器）、[导入 GGUF]、[启动]/[停止]、当前状态徽标与错误提示。运行状态不再显示当前模型名；状态 badge 与启动/停止按钮靠该行最右并与左侧标签垂直居中。启动时后端自动选择模型；停止后翻译/总结不会自动启动；应用重启会恢复上次运行状态（keepRunning）。本地模式图片理解使用 Qwen2.5-VL 3B（含 mmproj）。
- 划词行为：启用开关、紧凑模式开关（紧跟启用开关、右对齐）、面板模式（紧跟紧凑模式：滚动/自适应，保存 `picker.panelMode`）、技能开关 + 拖拽排序（无上下箭头）…（其余同前）、每行显示技能图标（内置用 `LP.SKILL_MAP[id].icon`，自定义用自定义图标）、技能提示词编辑（行内展开 textarea，默认填充系统默认英文提示词，支持重置默认；translate 支持 `{target}` 占位符；支持 translate/summarize/explain/polish）、自定义技能管理（[添加技能] 打开内联表单：**图标选择器默认紧凑显示当前图标预览 +「更换图标」，点击展开 200 个 Lucide 图标 + 名称搜索过滤**；名称 ≤20、提示词必填 ≤4000、变量提示 `{text}/{target}/{language}/{program}/{app}`；支持编辑、删除二次确认）、搜索配置（搜索行「配置」按钮展开 Google/百度/Bing，保存 `picker.searchEngine`）、默认目标语言（auto 显示「自动识别」，共 38 种语言）、黑名单 chip 输入（回车添加/可删除）。截图快捷键可配置（见 §10.4）。恢复默认设置保留自定义技能与已下载模型/引擎。「开机自启」「关闭窗口后驻留托盘」两个开关行与划词开关一致：标签/开关垂直居中、开关靠右。
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
- 设置页：在线模型可按 `/models` 拉取并下拉选择；切换服务商预设会清空上一预设的 Key/模型且不自动填模型名；技能可拖拽排序（设置窗口 `dragDropEnabled: false` 保证 Windows 上 HTML5 拖拽可用）；技能列表显示图标；自定义技能可增删改；技能提示词可编辑与重置（默认英文）；默认目标语言显示「自动识别」；不再有快捷键与本地模型下拉。
- 本地模型目录提供 3 个模型：Hy-MT2 1.8B（翻译模型，ModelScope）、Qwen2.5 3B（通用模型）、Qwen2.5-VL 3B（视觉模型，主文件 + mmproj 投影器）；无需手动选择，启动后按功能自动使用对应模型（切换模型会重新加载）。
- 提示词生效：自定义提示词保存后，下一次翻译/总结/解释请求使用自定义 system prompt；空值回退系统默认。
- 在线模式：填 mock/真实 OpenAI 兼容服务后「测试连接」成功；picker 翻译流式显示。
- 本地模式：安装引擎 + 下载/导入 Qwen2.5 GGUF 后启动成功，翻译流式返回；总结/解释可用。
- 截图（§10）：快捷键开图无黑屏 loading；选区内拖动可平移、手柄可缩放；工具条与划词工具条同为白色主题；点击提取文字/翻译/解释图片/图片技能后截图关闭、图片入剪贴板、picker 结果面板流式输出且具备朗读/复制/重试/继续提问；本地安装 Qwen2.5-VL 3B 后可解释图片；设置页可录制截图快捷键并立即生效、冲突时提示。
- 截图第二轮（§10.7/§10.8）：连续截图复用 overlay 窗口、无重建延迟与闪烁；提取文字默认走视觉模型（日志路径可见），视觉不可用才回退 Windows OCR；设置页快捷键为独立卡片；全屏选区内拖拽直接开始新框选。
- 构建 release：`scripts/build-portable.ps1` 产出单个 `dist/Lexora-<version>-win-x64.exe`；双击运行后静默驻留托盘，数据写入 exe 同级 data/；Release 正文由 `scripts/release-notes.ps1` 生成排版化 changelog。


## 10. 截图（v0.2.2 性能与无闪烁重做，权威契约）

本轮（第二轮反馈）改造：截图调用延迟与屏幕闪烁、默认全屏时拖拽语义、截图快捷键独立设置模块、图片提取文字改用视觉模型（VL）而非 Windows OCR。

### 10.1 快速启动、无闪烁（overlay 复用 + 透明窗口 + 并行预编码）
目标：把「按快捷键 → overlay 可见」压到 ~300ms 级别，且任何一帧都不出现黑白闪烁。

- **overlay 窗口复用**：`capture-<index>` 窗口第一次截图时创建，之后 `capture_close`/技能执行**只隐藏不销毁**；下次 `start_capture` 若显示器数量与几何一致则直接复用（webview 常驻 = 省掉冷启动/窗口创建）。显示器布局变化（数量/坐标/尺寸）时才销毁重建。
- **窗口透明**：`create_capture_window` 使用 `transparent(true)` + 透明背景色 + `shadow(false)`、`visible(false)`；页面 body/根容器背景透明，只在 `<img>` 与遮罩层上绘制。避免 `show()` 首帧白底/黑底闪烁。
- **并行预编码**：`start_capture` 先隐藏自身窗口并确保 overlay 已创建（webview 在后台开始加载），随后 `xcap` 抓取所有显示器，`spawn_blocking` 并行把每块屏编码为 **JPEG data URL（质量约 85）** 存入 `Session`。JPEG 替代 PNG：编码、IPC、webview 解码均快数倍，overlay 只用于显示；裁切/OCR/视觉请求始终从内存里的原始 `RgbaImage` 取像素，无损。
- **arm 事件**：抓屏完成、`Session` 就绪后，Rust 向每个 overlay 窗口 emit `capture-armed {index}`；页面收到后重新初始化（重置选区/面板/错误状态）并拉取 `capture_monitor_info`。页面首次加载时同样主动拉取（配合 8–10s 轮询直到 Session 就绪）。
- `<img>.onload` 后计算尺寸、渲染 UI，并调用 **`capture_ready(index)`**；Rust 收到后 `show()` 对应 overlay（index 0 同时 `set_focus`）。
- 兜底：Rust 在 `start` 后 2500ms 调 `show_all_capture_windows`（前端异常也能看到 overlay）。
- overlay 页面**不显示**任何全屏 loading；仅当图片加载失败时显示白色错误条（重试/关闭）。抓屏期间窗口保持隐藏，因此没有黑屏过程。
- 隐藏的 overlay 窗口不参与合成，因此抓屏不会把上一张截图/工具条拍进去。

### 10.2 overlay 交互
- 默认全屏选区 + 暗遮罩；选区 1.5px 主色 `#4f46e5`，8 个白色手柄，尺寸标签为白色 pill。
- **选区内拖动平移**：`mousedown` 落在选区内（工具条/手柄除外）→ move 模式；`mousemove` 平移矩形、尺寸不变、clamp 到屏幕内；鼠标在选区内时 `cursor: move`；松开后工具条重新布局。
- **全屏选区例外**：当选区已经铺满整个视口（没有平移空间）时，选区内 `mousedown` 直接进入「重画」模式（按下即开始新的框选），避免「拖了但什么都不动」的错觉。
- 选区外 `mousedown` 拖动 = 重画；8 手柄 resize；最小 8×8；Esc/取消关闭；右键菜单阻止默认。
- hint：「拖动选区移动 · 拖动边角调整 · Esc 取消」，3.2s 后淡出。
- 工具条样式与 `picker.css` 的 `.toolbar` 完全一致（白色卡片）：白底 `#fff`、1px `#e2e8f0`、圆角 12px、按钮高 32、字号 12.5、文字 `#475569`、hover `#f1f5f9`、主色 `#4f46e5`、取消按钮红色 `#dc2626`；阴影收敛（参考 picker `--shadow-float`）。尺寸标签/hint/toast 同样白色主题。
- 工具条按钮：preset 图片技能（有 preset 时显示在最前）、复制、提取文字、翻译、解释图片、取消。
  - 「复制」→ `capture_copy`：裁切图写系统图片剪贴板并关闭全部 overlay（不打开面板）。
  - 「提取文字」「翻译」「解释图片」、preset 图片技能 → `capture_skill`（见 10.3）；Rust 关闭 overlay 并打开 picker 结果面板，**不允许出现截图框选与面板同时显示**。

### 10.3 命令契约（替换旧 `capture_ocr` / `capture_ai`）
| command | args | 返回 |
| --- | --- | --- |
| `start_capture` | `{presetSkillId?}` | `{ok, monitors, error?, hint?}` |
| `capture_monitor_info` | `{index}` | `{ok, dataUrl, width, height, index, preset?, error?, hint?}`（dataUrl 为 JPEG；width/height 为物理像素原始尺寸） |
| `capture_ready` | `{index}` | `{ok}` — overlay 图片已绘制，显示窗口 |
| `capture_copy` | `{index, rect}` | `{ok, error?, hint?}` — 裁切图入剪贴板并隐藏 overlay |
| `capture_skill` | `{requestId, index, rect, action, skillId?, targetLang?}` | `{ok, clipboard, error?, hint?}` |
| `capture_retry` | `{requestId}` | `{ok, error?, hint?}` — 用上一张截图重跑当前动作 |
| `capture_followup` | `{requestId, question, previousAnswer, history:[{question,answer}]}` | `{ok, error?, hint?}` |
| `capture_close` | — | `{ok}` — 隐藏 overlay 窗口（保留复用）+ 清空 Session |
| `capture_set_hotkey` | `{shortcut}` | `{ok, shortcut, error?, hint?}` — 见 10.4 |

- 事件：`capture-armed {index}`（Rust → capture-*）在每次 `start_capture` 抓屏完成后发送，用于复用窗口的重新初始化（见 10.1）。
- `action`：`"ocr" | "translate" | "explain" | "custom"`；`custom` 必须是已启用的 `kind=image` 自定义技能，否则同步返回明确错误。
- `capture_skill` 行为（顺序固定）：
  1. 从 Session 裁切矩形（无效则错误）；
  2. 把裁切图写入系统图片剪贴板（失败时 `clipboard=false`，流程继续）；
  3. 保存 `LastCapture { image, action, skillId, targetLang, label, ocrText:None }` 供重试/追问；
  4. `windows::hide_capture_windows`（隐藏复用）；`windows::show_picker` 以**选区右下角的物理坐标**为锚点显示 picker（`text=""`、`programName="截图"`、config 同划词 picker）；
  5. emit `picker-image`（见 10.5）；
  6. 立即返回 `{ok:true, clipboard}`；
  7. 后台流式任务（注册到 `state.translate_task`，遵循 picker 的「同时只有一个流」与 abort 逻辑）：
     - `ocr`：**视觉模型转写**（`engine.vision_stream(data_url, DEFAULT_OCR_PROMPT)`，收集完整文本）→ 一个 `chunk`（全文）→ `done`；视觉不可用时回退 Windows OCR；
     - `translate`：优先视觉模型转写（结果缓存到 LastCapture.ocrText），视觉不可用时回退 Windows OCR → `engine.translate_stream(text, target)`；
     - `explain`：`engine.vision_stream(image_data_url, DEFAULT_EXPLAIN_IMAGE_PROMPT)`；
     - `custom`：`engine.vision_stream(data_url, render_image_prompt(skill.prompt, target))`；
     - 事件统一为 **`translate-event`**（`{requestId, type:"chunk"|"error"|"done", text?, message?, hint?}`）发往 picker 窗口。
- 「视觉可用」判定 = `EngineService::can_use_vision()`：在线模式要求已配置服务地址与模型；本地模式要求 Qwen2.5-VL 3B（主文件 + mmproj）已安装（未启动时请求会得到「本地模型未启动」错误，由面板展示）。
- `capture_retry`：先 `state.abort_translate()`；按 LastCapture 重跑同一动作（ocr/translate 重新 OCR；explain/custom 重新发送图片），事件同上，requestId 用调用参数。
- `capture_followup`：explain/custom 用新增的 `engine.vision_followup_stream(image_data_url, previous_answer, question, history)`（system 解释提示 + 图片 + 上一轮答案 + 历史 + 新问题）；ocr/translate 用 `engine.followup_stream(ocrText, previous_answer, question, history)`；事件同上。
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
  - `ocr`：纯文本面板（loading 文案「正在识别文字…」；完成后 `<pre>` 渲染并支持朗读/复制/重试/追问）；
  - `translate`：翻译面板（显示目标语言控件；流式 Markdown）；
  - `explain`/`custom`：AI 面板（隐藏语言控件；流式 Markdown）。
- 请求进行中仍有 loading；chunk 增量渲染；error 显示可操作错误 + 重试；done 后显示「继续提问」输入区；
- 「重试」→ 新 requestId + `capture_retry`；「追问」→ `capture_followup`；关闭面板/切换技能 → abort（`picker_abort_translate` 复用 `translate_task` 机制）。
- 面板完全复用文字技能面板（`panel-head` 标题/语言/钉住/关闭、`panel-body` Markdown、`panel-foot` 朗读/复制/重试、follow-up 浮层、resize grip），不新增截图专用面板样式。
- `picker-data` 仍会先到（`text=""`），picker 必须兼容空 text：不报错、工具栏可渲染，随后被 `picker-image` 切到面板。

### 10.6 本地视觉（item 5）
- 原因：目录里的 `qwen2.5-3b` 是 **Qwen2.5-3B-Instruct（纯文本）**，不具备视觉能力；视觉需要 Qwen2.5-VL 系列 + 视觉投影器（mmproj）。
- 新增本地模型 `qwen2.5-vl-3b`（视觉模型，ModelScope 优先 / HF 兜底）：
  | id | 名称 | 文件 | 大小 |
  | --- | --- | --- | --- |
  | `qwen2.5-vl-3b` | Qwen2.5-VL 3B（视觉模型） | `Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf` | 1,929,901,056 |
  | 同上 | 视觉投影器 | `mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf` | 844,757,728 |
  - ModelScope：`https://www.modelscope.cn/models/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/master/<file>`
  - HF：`https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/<file>`
- `ModelSpec` 增加 `vision: bool` 与 `mmproj: Option<MmprojSpec{filename,size_bytes,modelscope_url,hf_url}>`；`CatalogEntry` 增加 `vision: bool`；`scan_models` 过滤 `mmproj-*.gguf`（不当作独立模型）；`installed` = 主文件存在（VL 还要求 mmproj 存在）。
- 下载：主模型完成后继续下载 mmproj（同一个模型 id；进度事件先主文件后投影器，`filename` 字段区分；任一失败整体失败并清理临时文件）。
- `LocalRole` 增加 `Vision`；`model_for_role(Vision)` 只返回「主文件 + mmproj 都存在」的 VL 模型；`llama.rs::ensure_model` 增加 `mmproj: Option<&str>` 参数，启动参数追加 `--mmproj <path>`，视觉模型 `-c` 至少 8192；模型或投影器变化时重启进程。
- `EngineService::vision_stream`：本地模式不再报「本地不支持图片理解」；本地无 VL 模型时返回「本地视觉模型未安装」+ hint（去设置下载 Qwen2.5-VL 3B）；在线模式保持原逻辑。
- 本地模式「翻译」不再被拒绝（OCR + 文本翻译）；`capture.rs` 删除「本地模式一律报错」。

### 10.7 性能与无闪烁验收（第二轮）
- 同一显示器连续截图时使用已创建的 overlay 窗口（日志可见 reuse），不再每次重建 webview。
- 「按快捷键 → overlay 可见」在 150% DPI 单屏机器上目标 ≤ 400ms（原实现约 700ms）；编码使用 JPEG（日志/代码可见），裁切图像素仍来自原始 RGBA。
- 窗口透明 + 隐藏期间不显示：出现瞬间即为截图画面，无白闪/黑闪；隐藏的 overlay 不会被拍进新截图。
- 桌面内容为动态视频/硬件合成窗口时，抓屏结果不应出现大块纯黑（若偶发，允许重抓一次，见实现说明）。

### 10.8 文字提取改用视觉模型（第二轮）
- 「提取文字」不再直接使用 Windows OCR：优先 `engine.vision_stream(data_url, DEFAULT_OCR_PROMPT)` 转写（在线视觉模型 / 本地 Qwen2.5-VL 3B），结果以纯文本面板显示（朗读/复制/重试/追问不变）。
- 视觉不可用（在线未配置且本地无 VL 模型）**或视觉请求失败/未返回文本**时回退 Windows OCR，保证功能仍可用；日志注明走了哪条路径与回退原因。
- 「翻译」同样优先用视觉模型转写后再翻译（缓存转写文本供重试/追问），视觉不可用时回退 Windows OCR + 文本翻译。
- 新增 `DEFAULT_OCR_PROMPT`（engine/prompts.rs，英文，要求逐字转写、保留换行、不翻译/不总结/不加代码围栏），由 `engine.rs` 重新导出；`EngineService::can_use_vision()` 判定视觉可用性。

### 10.9 验收（本轮）
- 快捷键按下后不再出现黑屏 loading；overlay 出现时已是截图画面。
- 选区内按住拖动可平移；手柄可缩放；尺寸标签同步。
- 工具条为白色主题，与划词工具条一致。
- 点击「提取文字/翻译/解释图片/自定义图片技能」后：截图 overlay 立即关闭、图片在剪贴板、picker 弹出结果面板流式输出；无「面板 + 框选」同屏。
- 结果面板具备朗读/复制/重试/流式/继续提问；错误有可操作提示。
- 在线视觉模型可解释图片；本地安装 Qwen2.5-VL 3B 后可本地解释图片；本地模式下翻译截图文字可用。
- 设置页可录制并保存新的截图快捷键，立即生效；冲突时提示且保留旧快捷键。
- `cargo test` 通过（新增 normalize_shortcut / catalog / 参数构造单测）；`cargo check` 无错误；`node --check` 全部通过。
