# 快捷翻译面板（Quick Translate）—— 功能契约

> 状态：实现中。本文件是三层实现（Rust shell / quicktranslate 渲染端 / 设置页）的接口来源。
> 与现有约定一致的风格：中文用户文案、英文代码注释、`camelCase` IPC 字段。

## 1. 目标

- 全局快捷键 `Alt+Space`（默认，可改）呼出独立翻译窗口；再次按下或 `Esc` 隐藏。
- 参考截图布局：顶部语言选择（自动识别 → 目标语言、交换、历史），左侧原文输入、右侧流式译文，底部字数/快捷键提示/翻译按钮/耗时。
- 自动识别源语言并翻译到选定目标语言；支持现有全部目标语言（`TARGET_LANGS` 去掉 `auto`，共 38 种）。
- 译文流式输出、Markdown 渲染；可自定义提示词（设置页，空 = 内置默认）。
- 翻译历史最多 500 条：搜索、单条删除、清空全部；点击历史回填面板。
- 面板可 Pin（置顶常驻桌面），Pin 偏好持久化。

## 2. 窗口

- Tauri label：`quicktranslate`；页面：`web/quicktranslate.html`。
- `tauri.conf.json` 新增窗口（无边框透明浮层，尺寸由渲染端控制）：
  - title `Lexora 快捷翻译`，url `quicktranslate.html`
  - width 900，height 640，minWidth 640，minHeight 420
  - resizable false，decorations false，transparent true，shadow false，visible false，center true
  - skipTaskbar false，focus true，dragDropEnabled false
- 窗口形态：透明窗口 + 白色圆角卡片（6px 透明 padding 留给阴影），顶栏空白区域可拖动窗口（`quick_drag_panel`）；渲染端按内容自适应高度并调用 `quick_resize(900, height)`，高度 clamp 到 `[420, min(760, 屏幕可用高度-80)]`；两栏内容超出时内部滚动且滚动条隐藏（同 picker auto 面板）。
- 显隐：
  - 热键 = toggle：窗口隐藏 → 显示 + `set_focus`，并 `emit_to("quicktranslate", "quick-show", {})`；已显示 → 隐藏。
  - `Esc`（前端）与顶栏关闭按钮 = 隐藏，不退出应用；失焦**不**隐藏。
  - 隐藏时中止进行中的流（`abort_translate`）。
- **Tauri capabilities**：`src-tauri/capabilities/default.json` 的 `windows` 必须包含 `quicktranslate`（需要 `core:event:default` 才能监听 `translate-event` / `quick-show`；缺失时命令仍会执行但渲染端永远收不到流事件，表现为面板一直停在「正在翻译…」）。
- Pin：`always_on_top` 切换；Pin 状态写入 `quick.pinned`，下次呼出恢复。

## 3. 设置字段（settings schema 9）

```json
"quick": {
  "enabled": true,
  "hotkey": "Alt+Space",
  "targetLang": "zh",
  "prompt": "",
  "pinned": false
}
```

- `SETTINGS_VERSION` 8 → 9；迁移仅需 `#[serde(default)]`（新增字段默认值）。
- `normalize()`：
  - `hotkey`：`normalize_shortcut` 归一化；非法值回退 `Alt+Space`。
  - `targetLang`：必须 ∈ `TARGET_LANGS` 且 ≠ `auto`，否则 `zh`。
  - `prompt`：trim + 截断 4000 字符（复用 `PROMPT_MAX_CHARS`）。
  - `enabled`/`pinned`：bool。
- 设置页保存走现有 `update_settings`；`quick.hotkey` 或 `quick.enabled` 变化时同步热键注册（`sync_quick_hotkey`，模式同 `sync_capture_hotkey`；失败只写日志）。
- `settings.rs` 单测：默认值、归一化（非法 hotkey/lang/prompt 截断）、旧 schema 迁移保留其它字段。

## 4. Tauri 命令

所有命令返回 `serde_json::Value`，失败用 `{ok:false,error,hint?}`（参考 picker 命令）。

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `quick_ready` | 无 | `{ok, quick:{enabled,hotkey,targetLang,prompt,pinned}, promptDefault}` | 渲染端启动/显示时刷新配置；`promptDefault` 为内置默认英文提示词（含 `{target}` 占位符） |
| `quick_open` | 无 | `{ok}` | 显示 + 聚焦（设置页/测试用，热键内部也走同一逻辑） |
| `quick_hide` | 无 | `{ok}` | 隐藏窗口；前端 Esc / 关闭后调用 |
| `quick_resize` | `width,height`（逻辑像素） | `{ok,width,height}` | 渲染端自适应尺寸；宽 clamp `[640,1600]`、高 clamp `[420, min(760, 屏幕工作区高度-80)]`，位置 clamp 到虚拟屏幕 |
| `quick_drag_panel` | `dx,dy`（逻辑像素增量） | `{ok}` | 顶栏拖动窗口；位置 clamp 到虚拟屏幕 |
| `quick_pin` | `pinned:bool` | `{ok,pinned}` | 切换置顶并持久化 `quick.pinned` |
| `quick_set_hotkey` | `shortcut:string` | `{ok,shortcut}` / `{ok:false,error,hint}` | 归一化 → 重注册 → 持久化 `quick.hotkey`；失败回滚旧快捷键 |
| `quick_set_target_lang` | `targetLang:string` | `{ok,targetLang}` | 记忆目标语言（写 `quick.targetLang`） |
| `quick_translate` | `requestId,text,targetLang` | `{ok}` / `{ok:false,error,hint}` | 启动流式翻译；先 abort 旧请求。文本 trim 后空 → 错误；超过 20000 字符 → 后端截断到 20000 |
| `quick_abort_translate` | `requestId` | `{ok}` | 中止当前流（复用 `translate_task`） |
| `quick_history_list` | 无 | `{ok,entries:[...]}` | 最新在前 |
| `quick_history_delete` | `id:string` | `{ok}` | 删除单条 |
| `quick_history_clear` | 无 | `{ok}` | 清空 |
| `quick_copy` | `text:string` | `{ok}` / `{ok:false,error}` | 复制到剪贴板 |
| `quick_open_settings` | 无 | `{ok}` | 打开设置窗口 |

返回形状补充（实现细节）：

- `quick_open`：`quick.enabled=false` 时返回 `{ok:false,error,hint}` 且不显示窗口。
- `quick_pin`：窗口不可用 `{ok:false,pinned:false,error}`；置顶已生效但落盘失败 `{ok:false,pinned,error}`。
- `quick_set_hotkey`：成功 `{ok:true,shortcut}`；已生效但落盘失败 `{ok:true,shortcut,hint}`；注册失败 `{ok:false,shortcut,error,hint}`（`shortcut` 为仍在生效的旧值，旧值不落盘）；`enabled=false` 时只归一化并持久化、不注册，下次启用生效。
- 启动时热键注册失败（被其他程序占用）只写 `main.log` WARN，不阻塞启动；面板可在设置页改键恢复。

### 事件（`emit_to("quicktranslate", ...)`）

- `translate-event`：与 picker 相同的形状
  - `{requestId, type:"chunk", text}`
  - `{requestId, type:"done", elapsedMs}`（`elapsedMs` 为本轮耗时，毫秒，整数）
  - `{requestId, type:"error", message, hint}`
- `quick-show`：`{}`，窗口被显示时发送；前端收到后聚焦输入框并刷新配置。
- 设置变更（`quick.pinned`/`targetLang` 等）不需要推送事件。

### 提示词

- `engine/prompts.rs` 新增 `DEFAULT_QUICK_TRANSLATE_PROMPT`（英文，要求：把用户文本翻译成 `{target}`，只输出译文、保留 Markdown/代码结构；自动识别源语言）。
- `default_prompts()` 暴露 `quickTranslate`（供设置页展示/重置）。
- 新增 `EngineService::quick_translate_stream(text, target_lang, custom_prompt)`：
  - 空 `custom_prompt` 用默认提示词；否则用用户提示词。
  - 支持 `{target}` 占位符（目标语言英文名称替换，与现有 `resolve_text_prompt` 的目标语言渲染一致）。
  - **不做**单词/词条自动切换（快捷面板行为固定、可预测）。
  - 文本截断到 20000 字符；日志 action 用 `quick_translate`。

## 5. 翻译历史

- 文件：`<data>/quick-history.json`（新建 `quicktranslate.rs` 内 `HistoryStore`，`Mutex` + 原子写，损坏文件按空处理并备份 `.broken`）。
- 结构：

```json
{ "version": 1, "entries": [
  { "id": "20261102-101530-abc123", "source": "原文", "target": "译文",
    "sourceLang": "en", "targetLang": "zh", "createdAt": 1762040130000,
    "elapsedMs": 842 }
] }
```

- 上限 500（常量 `MAX_HISTORY = 500`），最新的在最前；写入时裁剪。
- 写入时机：`quick_translate` 流正常 `done`（取消/失败不写）；source/target 完整保存（source 可 20000 字符），`elapsedMs` 为本次流耗时。
- `sourceLang`：`detect_source_lang(text)` 启发式（返回 `TARGET_LANGS` 内代码）：
  - 汉字（无假名）→ `zh`；含假名 → `ja`；谚文 → `ko`；
  - 西里尔 → `ru`；阿拉伯 → `ar`；泰文 → `th`；天城文 → `hi`；希伯来 → `he`；
  - 其余有拉丁字母 → `en`；空 → `en`。
  - 单独函数 + Rust 单测（不依赖 I/O）。
- 历史条目 `id`：`<yyyymmdd-hhmmss>-<6 位随机 hex>`。

## 6. 前端 `web/quicktranslate.html|css|js`

### 布局（参考截图，沿用项目视觉）

- 外层 `.qt-win`：透明 padding 6px；`.qt-shell` 白色圆角卡片（border + 轻阴影），flex column 填满窗口。
- 顶部工具栏（同时是窗口拖动条）：`语言` 标签 + 只读「自动识别」+ `→` + 目标语言 `<select>`（38 种，默认 `quick.targetLang`）+ 交换按钮；右侧 Pin 图标按钮 + 「历史」按钮（图标 + 文字）+ 关闭 ×（`quick_hide`）。空白区域可拖动窗口，按钮/下拉不触发拖动。
- 主体两栏（`.qt-body`，grid `1fr 1fr`，gap 16，min 宽度 640 时仍两栏）：
  - 左卡片「原文」：右上 `0 / 20000 字符` + `清空`；`textarea`（maxlength 20000）；底部左「支持 38 种语言，最多 20000 字符」，右「Ctrl+Enter」提示 + 主按钮「翻译」。
  - 右卡片「译文」：右上 `0 字符` + 朗读图标按钮 + 复制图标按钮（均 `title` 提供名称）；结果区（流式 Markdown，复用 `shared/markdown.js` 的 `LP.renderMarkdown`）；底部「耗时 —」（单位为秒，如 `耗时 1.1 秒`）。
  - 两栏内容超出时内部滚动，滚动条隐藏（`scrollbar-width:none` + `::-webkit-scrollbar` 0），流式期间译文自动滚到底。
- 窗口高度随内容自适应（`quick_resize`），超过上限后内部滚动；窗口宽度固定 900。
- 历史浮层：居中/右侧抽屉，白卡 + 阴影；标题「翻译历史」+ 关闭 ×；搜索框（占位「搜索原文或译文…」，前端过滤）；列表项：`2026/11/02 10:15 · 英语 → 中文`、原文摘要（1 行省略）、译文摘要（1 行省略）、hover 右侧删除按钮；底部「清空历史」（二次确认：按钮变「确认清空」）。空态提示「暂无翻译历史」。
- toast 提示（复制成功、无输入、错误等）。
- 视觉沿用 `settings.css` 的变量与卡片风格（背景 `#f6f7f9`、白卡、12px 圆角、主色 `#4f46e5`、danger `#dc2626`、字体 `Segoe UI`/`Microsoft YaHei UI`）。不引入框架/打包器。

### 行为

- `quick_ready` 获取配置 → 初始化目标语言/Pin/提示词；订阅 `translate-event` / `quick-show`。
- 点「翻译」或 `Ctrl+Enter`：空输入 toast；启动流式；按钮变「停止」（点击调用 `quick_abort_translate(requestId)`）；流式期间禁用再次翻译。
- chunk 追加渲染（rAF 合并，参考 picker 的 `renderTranslationDraft` 思路）；done：写回按钮、显示 `耗时 1.1 秒`、刷新历史缓存、保持输入焦点；error：显示错误提示 + 可重试。
- 内容/流式变化时按节流（~120ms）计算并上报窗口高度（`quick_resize`），窗口高度只随内容增长/回落到内容高度并受上下限约束。
- 朗读：朗读译文纯文本（`LP.markdownToPlain`），`speechSynthesis`（Windows 系统语音），朗读中再次点击为「停止朗读」且静默恢复；无语音提示「系统未安装可用的语音包：Windows 设置 → 时间和语言 → 语音」；新翻译/清空/隐藏时停止朗读。
- 复制译文：复制图标按钮（`quick_copy`），无内容时禁用。
- 目标语言变化：`quick_set_target_lang` 记忆。
- 「交换」：将目标语言设为检测到的源语言（用同样的启发式检测前端口径），若译文非空则原文 ↔ 译文互换并清空译文；无译文时只切目标语言并 toast。
- 复制译文：`quick_copy`。
- Pin：`quick_pin`，按钮 active 态；启动时按 `quick.pinned` 显示。
- 历史：打开时 `quick_history_list`；搜索前端过滤；单条删除 `quick_history_delete`；清空二次确认后 `quick_history_clear`；点击条目回填原文/译文/目标语言并关闭浮层。
- `Esc`：历史浮层打开 → 关闭浮层；否则 `quick_hide`。
- 窗口隐藏时（`quick-show` 之前）不需要重置内容；再次显示保留上次内容。

### `shared/tauri-api.js`

- 新增 `window.quickAPI`：`live`、`ready/open/hide/pin/setHotkey/setTargetLang/translate/abortTranslate/onTranslateEvent/onShow/historyList/historyDelete/historyClear/copy/openSettings/resize/dragPanel`。
- mock 模式（浏览器预览）必须可用：
  - `mockStore.settings.quick` 默认值（enabled true、hotkey `Alt+Space`、targetLang `zh`、prompt 空、pinned false）；
  - `quick_translate` 走现有 mock 流并按 chunk/done/error 发 `translate-event`；done 写内存历史（≤500）；
  - 历史/删除/清空/Pin/快捷键/目标语言命令均实现并在 `get_state` 的 settings 中体现；
  - 保留 `window.__mockQuick*` 测试钩子（可选）。

## 7. 设置页

卡片顺序：`翻译服务` → `划词行为` → `快捷翻译` → `快捷键` → `应用与启动` → `关于`。

「快捷翻译」卡片（位于「快捷键」卡片**上面**）：

- 卡片头：`快捷翻译` + 说明「按快捷键呼出翻译面板，再次按下隐藏。」
- 启用开关：`quick.enabled`；关闭时热键不注册、面板不显示。
- 自定义提示词：textarea（默认显示默认英文提示词，来自 `state.promptDefaults.quickTranslate`）；
  - 支持 `{target}` 占位符；保存 `quick.prompt`（防抖，重置为默认 = 存空串并回填默认）；提示「留空或与默认一致时使用内置提示词」。
- 历史记录：说明「最多保留 500 条」；危险按钮「清空历史」（二次确认）→ `quick_history_clear`；无需列表。

「快捷键」卡片（统一放所有全局快捷键；说明「配置 Lexora 的全局快捷键。」）：

- 截图快捷键行（既有）。
- **呼出快捷翻译**行：按钮显示当前组合（默认 `Alt + Space`），点击进入录制（复用截图快捷键的录制交互：按键组合保存、`Esc` 取消、冲突/非法提示并保留旧值）；「恢复默认」。
  - 保存调用 `quick_set_hotkey`；成功 toast，失败在行内提示（`inline-error`）。

`web/settings-local.test.cjs` 增加/更新断言（新卡片元素、字段读取、保存 patch 形状），保持现有测试通过。

## 8. 验收（本地构建后）

1. `Alt+Space` 在任意前台应用呼出无边框面板；再按隐藏；`Esc` 与顶栏 × 隐藏；顶栏拖动可移动窗口；窗口高度随内容自适应（有上限，超出内部滚动且无可见滚动条）。
2. 输入英文/中文 → 右侧流式译文；按钮进行中为「停止」且可中止；完成后显示「耗时 x.x 秒」；复制/朗读为图标按钮，悬浮显示名称。
3. 译文可朗读（再次点击停止）；无语音包时提示。
4. 目标语言 38 种可选；自动识别源语言并翻译；目标语言重启后记忆。
5. Pin 后窗口置顶；重启应用后 Pin 状态恢复；取消 Pin 恢复普通窗口。
6. 历史：自动记录，最多 500；搜索、单条删除、清空；点击回填。
7. 设置页：卡片顺序为「翻译服务/划词行为/快捷翻译/快捷键/应用与启动/关于」；呼出快捷键在「快捷键」卡片内录制（含冲突提示）、自定义提示词生效/重置、清空历史。
8. 关闭启用开关后热键不响应；重新开启立即生效。
9. `cargo test` 与相关 `node --test web/*.test.cjs` 通过。
