# 架构说明

Lexora 是 Windows 桌面划词翻译工具，使用 Tauri v2 构建：Rust 负责系统集成与翻译，WebView2 渲染 UI，发布为免安装单 exe。

## 进程与线程

```
lexora.exe
├─ 主线程 / Tauri runtime
│   ├─ settings 窗口（WebView2，index.html）
│   ├─ picker 结果面板窗口（WebView2，透明置顶，picker.html）\n│   ├─ picker-toolbar 临时划词工具栏窗口（WebView2，透明置顶）
│   ├─ capture-<n> 截图 overlay 窗口（每显示器一个，隐藏复用，capture.html）
│   ├─ longshot 长截图预览窗口（手动滚动时显示，longshot.html）
│   ├─ pin-<id> 钉图窗口（置顶无边框，pin.html）
│   ├─ 托盘菜单
│   ├─ Tauri 命令（翻译、设置、模型下载、窗口控制、截图/长截图/pin）
│   └─ 异步任务：reqwest 流式翻译、llama-server 启停、下载
├─ 输入钩子线程（rdev）
│   └─ 鼠标拖动/多击/外部点击判断 → channel
├─ 截图快捷键线程（RegisterHotKey 消息循环）
│   └─ 全局快捷键 → start_capture（单实例截图守卫）
├─ 长截图抓帧线程（每次会话一个，阻塞线程内使用 xcap）
│   └─ 定时抓选区 → 行/列重叠检测 → 双向拼接 → 预览窗口
├─ 取词线程（每次请求一个，可抛弃）
│   └─ Windows UI Automation(COM) 读取选中文本，1.5s 看门狗
└─ llama-server.exe（本地模式，子进程）
```

## 模块

| 模块 | 职责 |
| --- | --- |
| `main.rs` | Tauri Builder、插件、窗口事件、生命周期、退出清理 |
| `commands.rs` | 全部 `invoke` 命令；组装 `StatePayload` 广播前端 |
| `windows.rs` | picker 面板、临时工具栏、settings 与 capture overlay 的几何、显示/隐藏和 pending payload |
| `capture.rs` | 截图会话：热点单实例守卫、xcap 抓屏、overlay 复用、裁切/标注合成、剪贴板、技能分发、长截图 seed/拼接算法 |
| `longshot.rs` | 手动滚动长截图：预览窗口、后台抓帧线程、双向（行/列）拼接、方向切换、完成/取消 |
| `pin.rs` | 钉在桌面窗口：图片 registry、DPI 适配尺寸、置顶窗口、拖动/复制/关闭 |
| `updater.rs` | 检查 GitHub Release、下载并替换 exe、助手脚本重启（自更新） |
| `tray.rs` | 托盘图标与菜单（显示设置、启用划词、本地引擎启停、退出） |
| `state.rs` | `AppState`：paths、logger、settings store、engine、selection、翻译任务句柄 |
| `settings.rs` | 设置 schema、归一化、原子持久化（`settings.json`） |
| `paths.rs` | 便携数据目录解析（exe 同级 `data/` 优先，回退 `%APPDATA%`） |
| `logger.rs` | 10MB 滚动文件日志，保留一个历史分卷，API Key 脱敏 |
| `win32.rs` | Win32 FFI：光标、显示器工作区、DPI、透明窗口/捕获排除、焦点移交、DWM 过渡禁用 |
| `selection.rs` | `rdev` 全局钩子、拖选/多击判定、触发取词、外部点击与键盘操作隐藏 |
| `selection/uia.rs` | 原生 UI Automation COM 取词（`CUIAutomation8` + 超时 + 重试） |
| `engine.rs` | 引擎门面：在线/本地路由、状态、模型/引擎下载 |
| `engine/openai.rs` | OpenAI 兼容 `/chat/completions` SSE 流式客户端 |
| `engine/llama.rs` | `llama-server.exe` 子进程管理（端口、健康检查、日志、退出清理） |
| `engine/models.rs` | GGUF 模型扫描、下载、导入、删除、引擎 zip 安装 |
| `engine/prompts.rs` | 翻译/总结/解释/OCR/图片提示词与错误文案 |

## 截图 / 标注 / 长截图数据流

```
快捷键 / 托盘 / picker「截图」
  → invoke("start_capture")（已在截图则拒绝：单实例守卫，contract §11.11.2）
  → capture.rs：xcap 抓屏（RGBA）→ 缓存 session → JPEG data URL
  → emit "capture-armed" → capture.html 读取 capture_monitor_info 绘制冻结截图
  → capture_ready：显示 overlay（透明窗口，隐藏期间已准备好像素，无黑屏/闪屏）
  → 用户框选 → capture-annotate.js 在透明 canvas 上画标注（本地、可撤销）
  → 复制/确认/图片技能/pin：
      - renderToPng(selection) 生成透明标注层（物理像素尺寸）
      - Rust 裁切原始 RGBA + alpha 合成标注层 → 剪贴板 / AI / pin
```

- **标注**：`web/capture-annotate.js` 纯前端 canvas 引擎（形状/箭头/画笔/文字/序号/马赛克，选中/移动/缩放/旋转/删除，撤销重做，选区裁剪，吸色）。导出只含已提交标注。
- **overlay 可见性**：overlay 与其他 Lexora 窗口不做捕获排除，系统截图/录屏可拍到截图界面；截图窗口禁用 DWM 过渡，退出时单帧隐藏不闪烁。
- **长截图（手动滚动，contract §11.14）**：
  1. 点击「长截图」→ `longshot_start`：overlay 保持可见并设鼠标穿透；页面进入 live 模式（隐藏冻结图/手柄，保留选框与遮罩，选区内显示目标应用实时画面）。
  2. 后台线程约 8fps 抓选区（四周内缩 2 CSS px 避免选框入镜），与已拼接图同时尝试向后追加 / 向前插入（竖向行采样，横向旋转 90° 复用）；无重叠标记 stalled。
  3. 每次拼接 emit `longshot-progress {width,height,frames,revision,stalled}`；预览窗口按 revision 节流拉 `longshot_preview`（PNG 约 720 宽，缓存），双缓冲淡入显示。
  4. 完成 → 全分辨率图写剪贴板 + `pin::create_pin`；取消 → 恢复 overlay 交互/UI。全程不自动滚动。
- **钉在桌面**：`pin-<id>` 置顶无边框窗口，图片内存 registry；尺寸按 DPI 适配工作区（普通图等比缩放无滚动条，长图保持可读宽度窗口内滚动）。

## 取词数据流

1. 用户拖动选中文本，或双击/三击选中单词/段落。
2. `rdev` 钩子判断「位移 ≥ 6px 的左键抬起」或多击（同一位置、间隔 ≤ 双击时间），向取词通道投递请求（回调内只做轻量判断）。
3. 过滤：功能开关、自身进程、黑名单、同文本 400ms 去重。
4. 独立线程创建 UIA COM 客户端（连接/事务超时 1.5s/1s），读取焦点元素的 TextPattern 选区；失败重试 2 次；主线程 `recv_timeout(1.5s)` 看门狗，超时放弃。
5. 得到文本 + 鼠标物理坐标 + 显示器 scale。无面板或面板未固定时调用 `windows::show_picker` 在主 picker 中显示新工具栏并替换旧面板；已固定面板时调用 `windows::show_toolbar`，在独立 `picker-toolbar` 窗口中显示，不中止旧请求。
6. 点击翻译、总结、解释、润色或文本自定义技能时，临时工具栏才调用 `picker_toolbar_run_skill` 替换旧面板；朗读、复制、搜索、截图入口不会立即替换面板。截图结果生成时才替换。点击外部只隐藏临时工具栏，未固定面板在普通外部单击后延迟隐藏，划词动作会取消该隐藏。

## 翻译数据流

```
picker.js → invoke("picker_translate", {requestId,text,targetLang})
          → commands.rs 中止旧任务、spawn 任务
          → engine.translate_stream()（在线：reqwest SSE；本地：确保 llama-server ready 后同样走 SSE）\n          → model.log 记录调用开始与完成/失败/取消、耗时、分块和输出字符数
          → 每块 emit_to("picker","translate-event", {requestId,type:"chunk",text})
          → renderer 增量显示；错误 type:"error" 显示错误面板
```

总结/解释：`picker_assist` 非流式等待完整结果。文本长度：翻译取 `picker.maxChars`（默认 5000），总结/解释取 8000 字符。

## 动态追问

所有 AI 文字/图片技能通过 `generate_followups` 独立生成最多 3 条建议，不使用固定预设。多轮追问保留原文、独立初始回答及有序历史；普通追问保留最近 10 轮，单段最多 4000 字符、总文本预算 20000 字符。图片追问继续携带原图，建议使用精简文字上下文。

动态追问时序：主回答收到首个非空 chunk 后启动建议预取；每次最多 3 条。主回答或本轮追问完成时，已有预取结果立即展示，否则最多等待 3000 ms；超时取消并静默丢弃迟到结果，不显示固定建议。该截止仅限制前端等待时间，不保证实机模型能在 3 秒内成功生成建议。多轮追问继续保留原文、初始回答与历史；建议生成另用精简上下文（原文和初始回答各最多 800 字符，最近 6 轮每段最多 500 字符，总计最多 3000 字符，输出最多 80 tokens），普通多轮追问预算保持不变。

在线使用当前配置的在线模型；本地严格使用用户手动选择且完整安装的 Qwen3.5 本地模型。后端通过 picker payload 的 `config.suggestionsAvailable` 提供能力状态；不可用时前端静默隐藏建议区与追问入口，不发起建议调用。建议生成失败或输出无效时返回空列表，不影响主结果。

建议任务以 `requestId` 登记，通过 `cancel_followups` 取消；新 AI 请求等待旧建议任务取消，避免模型切换干扰。关闭、隐藏或切换会话使前端版本失效，迟到回包同时校验会话、请求版本与轮次，不覆盖新结果；同轮建议缓存，成功回答后刷新。

## 离线模型与引擎

- 引擎：llama.cpp 官方 `win-cpu-x64` 发布包（约 23MB），解压到 `<data>/engine/`。
- 模型：GGUF 放在 `<data>/models/`；仅内置 Qwen3.5 0.8B / 2B / 4B 的 Q4_K_M、Q3_K_M 六种翻译 / 通用 / 视觉选项，均从 ModelScope 下载（Apache-2.0），也支持手动导入 GGUF。Qwen3.5 各档搭配对应的 `mmproj-F16.gguf`，本地按模型规格区分投影器文件名，避免不同规格互相覆盖。
- 选模：翻译、通用文本和视觉任务共用用户手动选择的唯一 Qwen3.5 模型，持久化到 `settings.provider.local.selectedModel`（settings schema v9，JSON 中为 `provider.local.selectedModel`）。未选择时返回明确提示，不自动替选；CPU、内存和显存检测只用于推荐标签及理由。推荐梯度以内存与线程为主、显存可升档：显存 ≥10GB 且内存 ≥16GB、线程 ≥8，或内存 ≥32GB 且线程 ≥12 时为 4B Q4；内存 ≥24GB 且线程 ≥8 为 4B Q3；内存 ≥16GB 按线程为 2B Q4/Q3；内存 ≥8GB、线程 ≥6 为 0.8B Q4；其余为 0.8B Q3。内置引擎为 CPU 版，显存不影响实际推理速度。切换选择后需重启本地引擎。旧 Qwen2.5 文件保留，不再参与内置自动选择。
- 启动参数：`llama-server.exe -m <model> --host 127.0.0.1 --port <free> -c <ctx> -t <threads> -ngl <gpuLayers> -np 1 -b 512 -ub 256 --no-warmup --no-webui`，视觉请求追加 `--mmproj <path>`（`-c` 至少 8192）。应用同一时刻只跑一个流，因此只用 1 个 server slot；512/256 的批大小与 `--no-warmup` 用来压低常驻内存与启动峰值。实测 0.8B Q4 在 `-c 4096` 下私有内存约 0.9GB（原默认参数约 1.4GB），2B 约 1.7GB（原约 2.2GB）。
- 内存按需加载：启动与文字/翻译任务不加载视觉投影器（省 0.2–0.7GB），首次截图视觉任务时重启并追加 `--mmproj`；之后文字请求复用该 server，不反复重启。投影器缺失时文字任务可用，视觉任务给出补下载提示。
- 空闲自动停止与孤儿清理：无请求满 10 分钟（固定值，不提供配置；请求开始与每个流式分块都会刷新空闲计时）时停止 llama-server，保留 `keepRunning` 与「启动」记忆，下次请求或点「启动」重新加载。子进程绑定 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object，应用崩溃即由系统回收；PID 写入 `<data>/llama-server.pid`，下次启动只在进程镜像等于本应用 `engine/llama-server.exe` 时终止残留进程。所有停止/失败路径都 kill + wait 并删除 PID 文件。
- 模型切换：`provider.local.selectedModel` 改变后，运行/加载中的引擎由后台自动 restart 加载新模型（保留 keepRunning），设置页立即刷新状态；空闲停止或未启动时只清除已捕获选择，下次请求用新模型加载。
- 健康检查 `/health`，最长等待 90s；进程日志写 `logs/llama.log`；应用退出时停止子进程。

本地模型迁移兼容：旧 Hy-MT2 和 Qwen2.5 文件不自动删除，仅作为「其他本地模型」显示并支持手动删除，不再提供内置下载、自动选择或推荐。所有本地 AI 任务使用 `provider.local.selectedModel` 手动选择的 Qwen3.5；未选择时本地 AI 不可用，追问建议与入口静默隐藏。

## 设置与便携

`settings.json` 与模型/引擎都放在数据目录（默认 exe 同级 `data/`），解压到 U 盘或任意目录都能独立使用。数据目录不可写时回退 `%APPDATA%\Lexora`。

## 安全与隐私

- 除「在线模式请求你配置的服务」与「下载引擎/模型」外不发起网络请求。
- API Key 只保存在本地 `settings.json`；日志写入前做脱敏。
- 前端为本地静态资源，无 CDN；窗口禁止导航到外部页面；外链仅经系统浏览器打开 https。
- `picker` 以透明置顶窗口运行，不注入其他进程；取词只读取 Windows 无障碍 API 暴露的选区。

## 已知限制

- 提权（管理员）运行的应用无法取词（Windows UIPI）；截图/长截图同样会被 UIPI 限制。
- 依赖目标应用提供 UI Automation TextPattern；Excel、部分 PDF/微信等应用不支持。
- 长截图依赖用户手动滚动目标应用：视频/动画、固定悬浮层、管理员窗口可能导致 stalled 或拼接错位；横向需目标内容支持左右滚动。
- 标注的文字/序号缩放按字号等比调整；极端单轴缩放时包围盒与实际字宽可能略有差异。
- 混合 DPI 多屏等场景见 `docs/spike-report.md` 的遗留风险。


## 提示词、读音与生成边界（schema 8）

`engine/prompts.rs` 的 `resolve_text_prompt()` 统一解析文本翻译/解释的提示词来源、模式和版本，日志直接使用解析结果。翻译使用两套提示词、由算法按输入形态自动切换：`picker.prompts.translate` 处理普通翻译，`picker.prompts.wordLookup` 处理被 `single_word_kind()` 判定为单个词或短语的输入（空值各自回退内置默认）。解释技能同样对候选词使用单词提示词（目标语言固定为简体中文），其余走 `picker.prompts.explain`。没有单词查询模式字段，也没有离线读音模块。`default_prompts()` 暴露 translate/wordLookup/summarize/explain/polish 及截图动作默认提示词。

候选判定保守且不验证拼写：ASCII 1–40 字母（可含撇号/连字符）的单词，或 1–4 个汉字且不含常见句子标记的短词；带空格、标点、URL、下划线、camelCase 代码标识及更长文本走普通任务。普通翻译提示词要求整段译入目标语言、只输出译文并保留 Markdown/代码结构；单词提示词要求 Markdown 词条（词头、读音、词性、至多 3 个义项、可选例句），释义使用目标语言，音标与拼音由模型生成，可能不准确；疑似错拼不得编造释义或读音。解释先给核心含义，最多 3 个必要要点，通常 150–250 字；总结 3–5 点，润色只给结果，图片解释聚焦关键可见信息，OCR 只逐字转录。长度是提示词目标，并非字符级硬截断。

`engine.rs` 对本地和在线调用统一计算有效输出预算：默认解释/图片解释 512、总结 768 tokens，均与用户配置上限取较小值；翻译（含单词/短语）、润色、自定义提示词、自由追问、OCR 沿用用户上限，不修改持久化配置。日志增加 `effective_max_tokens`、模式、来源和提示词版本，不记录提示词或回答正文。

循环保护在 `web/picker.js` 累计流式正文后执行，因而支持跨 chunk 检测。连续重复段落/列表项至少 3 次，或尾部周期重复至少 4 次时中止；周期扫描尾部窗口约 4096 字符、周期最长 1024 字符。翻译（含单词/短语）与其他 AI 技能都受保护；翻译/润色允许原文已有的合法重复。行内代码、代码围栏、缩进代码、表格、引用不参与检测，OCR 豁免。命中时保留首份内容并取消后端请求，前端标记 `finishReason: repetition`、`partial: true`，显示“检测到重复输出，已停止”，过滤迟到事件。这是前端启发式保护，并非 Rust 全链路新增的结束原因协议，也不保证识别全部循环。自动化测试验证预算和检测规则，不能证明真实模型的释义、读音或生成质量。
