# 架构说明

LingoPick 是一个 Windows 桌面划词翻译工具，使用 Tauri v2 构建：Rust 负责系统集成与翻译，WebView2 渲染 UI，发布为免安装单 exe。

## 进程与线程

```
lingopick.exe
├─ 主线程 / Tauri runtime
│   ├─ settings 窗口（WebView2，index.html）
│   ├─ picker 窗口（WebView2，透明置顶，picker.html）
│   ├─ 托盘菜单
│   ├─ Tauri 命令（翻译、设置、模型下载、窗口控制）
│   └─ 异步任务：reqwest 流式翻译、llama-server 启停、下载
├─ 输入钩子线程（rdev）
│   └─ 鼠标拖动/多击/外部点击判断 → channel
├─ 取词线程（每次请求一个，可抛弃）
│   └─ Windows UI Automation(COM) 读取选中文本，1.5s 看门狗
└─ llama-server.exe（本地模式，子进程）
```

## 模块

| 模块 | 职责 |
| --- | --- |
| `main.rs` | Tauri Builder、插件、窗口事件、生命周期、退出清理 |
| `commands.rs` | 全部 `invoke` 命令；组装 `StatePayload` 广播前端 |
| `windows.rs` | picker/settings 窗口几何（物理坐标 clamp）、显示/隐藏、pending payload |
| `tray.rs` | 托盘图标与菜单（显示设置、启用划词、本地引擎启停、退出） |
| `state.rs` | `AppState`：paths、logger、settings store、engine、selection、翻译任务句柄 |
| `settings.rs` | 设置 schema、归一化、原子持久化（`settings.json`） |
| `paths.rs` | 便携数据目录解析（exe 同级 `data/` 优先，回退 `%APPDATA%`） |
| `logger.rs` | 滚动文件日志，API Key 脱敏 |
| `win32.rs` | Win32 FFI：光标、显示器工作区、DPI |
| `selection.rs` | `rdev` 全局钩子、拖选/多击判定、触发取词、外部点击与键盘操作隐藏 |
| `selection/uia.rs` | 原生 UI Automation COM 取词（`CUIAutomation8` + 超时 + 重试） |
| `engine.rs` | 引擎门面：在线/本地路由、状态、模型/引擎下载 |
| `engine/openai.rs` | OpenAI 兼容 `/chat/completions` SSE 流式客户端 |
| `engine/llama.rs` | `llama-server.exe` 子进程管理（端口、健康检查、日志、退出清理） |
| `engine/models.rs` | GGUF 模型扫描、下载、导入、删除、引擎 zip 安装 |
| `engine/prompts.rs` | 翻译/总结/解释提示词与错误文案 |

## 取词数据流

1. 用户拖动选中文本，或双击/三击选中单词/段落。
2. `rdev` 钩子判断「位移 ≥ 6px 的左键抬起」或多击（同一位置、间隔 ≤ 双击时间），向取词通道投递请求（回调内只做轻量判断）。
3. 过滤：功能开关、自身进程、黑名单、同文本 400ms 去重。
4. 独立线程创建 UIA COM 客户端（连接/事务超时 1.5s/1s），读取焦点元素的 TextPattern 选区；失败重试 2 次；主线程 `recv_timeout(1.5s)` 看门狗，超时放弃。
5. 得到文本 + 鼠标物理坐标 + 显示器 scale，调用 `windows::show_picker`：用 `PhysicalPosition` 定位并 clamp 到工作区，展示 picker 窗口，推送 `picker-data` 事件。
6. 点击「更多」可临时禁用当前应用/工具、打开设置或关闭；点击外部自动隐藏（面板固定时除外）。鼠标滚轮/触摸板滚动不会隐藏工具栏，长结果可在面板内滚动阅读；结果按 Markdown 渲染（`web/shared/markdown.js`，HTML 先转义，链接经 `open_external` 打开）。

## 翻译数据流

```
picker.js → invoke("picker_translate", {requestId,text,targetLang})
          → commands.rs 中止旧任务、spawn 任务
          → engine.translate_stream()（在线：reqwest SSE；本地：确保 llama-server ready 后同样走 SSE）
          → 每块 emit_to("picker","translate-event", {requestId,type:"chunk",text})
          → renderer 增量显示；错误 type:"error" 显示错误面板
```

总结/解释：`picker_assist` 非流式等待完整结果。文本长度：翻译取 `picker.maxChars`（默认 5000），总结/解释取 8000 字符。

## 离线模型与引擎

- 引擎：llama.cpp 官方 `win-cpu-x64` 发布包（约 23MB），解压到 `<data>/engine/`。
- 模型：GGUF 放在 `<data>/models/`，内置 Qwen2.5 0.5B/1.5B/3B Instruct Q4_K_M 下载目录（Apache-2.0），也支持手动导入任意 GGUF。
- 启动参数：`llama-server.exe -m <model> --host 127.0.0.1 --port <free> -c <ctx> -t <threads> -ngl <gpuLayers> --no-webui`。
- 健康检查 `/health`，最长等待 90s；进程日志写 `logs/llama.log`；应用退出时停止子进程。

## 设置与便携

`settings.json` 与模型/引擎都放在数据目录（默认 exe 同级 `data/`），因此解压到 U 盘或任意目录都能独立使用。数据目录不可写时回退 `%APPDATA%\LingoPick`。

## 安全与隐私

- 除「在线模式请求你配置的服务」与「下载引擎/模型」外不发起网络请求。
- API Key 只保存在本地 `settings.json`；日志写入前做脱敏。
- 前端为本地静态资源，无 CDN；窗口禁止导航到外部页面；外链仅经系统浏览器打开 https。
- `picker` 以透明置顶窗口运行，不注入其他进程；取词只读取 Windows 无障碍 API 暴露的选区。

## 已知限制

- 提权（管理员）运行的应用无法取词（Windows UIPI）。
- 依赖目标应用提供 UI Automation TextPattern；Excel、部分 PDF/微信等应用不支持。
- 混合 DPI 多屏等场景见 `docs/spike-report.md` 的遗留风险。
