# LingoPick · 划词翻译

> 选中即翻译：在任意 Windows 应用里划选文字，LingoPick 会在鼠标旁弹出一个小工具栏，支持**翻译、总结、解释、朗读、复制**。
>
> 在线可用任意 OpenAI 兼容 API，离线可用本地 llama.cpp + GGUF 模型；免安装、托盘后台运行、约 10MB 的轻量单 exe。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4)](docs/user-guide.md)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24c5b9)](https://tauri.app)
[![CI](https://github.com/monk233/lingopick/actions/workflows/ci.yml/badge.svg)](https://github.com/monk233/lingopick/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/monk233/lingopick?label=release)](https://github.com/monk233/lingopick/releases)

<!-- 截图：发布前替换为真实截图 -->
![划词翻译](docs/images/picker.png)
![设置页](docs/images/settings.png)

## 特性

- **完整划词体验**：拖动选词自动弹出工具栏；流式翻译（目标语言可切换）；总结；解释；系统语音朗读；复制；结果面板可固定到桌面；按内容自适应大小；多显示器 DPI 适配。
- **两种翻译引擎**
  - 在线：任意 OpenAI 兼容接口（DeepSeek / OpenAI / Moonshot / 智谱 / Ollama / LM Studio / 自建服务），支持测试连接与模型列表。
  - 离线：应用内一键下载 llama.cpp 引擎，配合 Qwen2.5 GGUF 模型完全本地推理，断网可用。
- **轻量免安装**：单个 exe（约 9MB），下载后双击即用，不需要管理员权限，默认不写注册表（仅在你主动开启「开机自启」时写入一条启动项）；引擎与模型按需下载，数据默认保存在 exe 同级 `data/`。
- **后台常驻**：双击启动后静默驻留系统托盘，不弹窗、不占任务栏；关闭设置窗口回到托盘、单实例、可选开机自启；全局快捷键 `Ctrl+Shift+D` 也可唤起。
- **可配置**：启用/禁用、快捷键、技能显示与排序、紧凑模式、应用黑名单（在微信/IDE 等不想触发的应用里禁用）、开机自启。
- **隐私**：默认不收集任何数据；只有使用在线模式时，选中的文本才会发送到你配置的服务地址。

## 快速开始

### 1. 下载与启动

从 [Releases](https://github.com/monk233/lingopick/releases) 下载 `LingoPick-<version>-win-x64.exe`，放到任意可写目录后双击运行。

- 双击后**静默启动**：不弹窗口，直接在系统托盘后台运行。右键托盘图标（或双击托盘图标）打开设置完成配置。
- 支持 Windows 10/11（需要系统自带 WebView2 Runtime，新版 Windows 默认已安装）。

### 2. 配置翻译服务

**在线（推荐新手）**：设置 → 翻译服务 → 选择「在线 API」→ 选预设（如 DeepSeek）→ 填入自己的 API Key → 保存后点「测试连接」。

**离线（推荐隐私/断网场景）**：设置 → 翻译服务 → 选择「本地模型」→ 先「下载引擎」（llama.cpp，约 23MB）→ 再下载/导入 GGUF 模型（推荐 Qwen2.5 1.5B Instruct，约 1.1GB）→ 启动本地模型。

### 3. 使用

在浏览器、Word、PDF 阅读器、微信等任意应用中**拖动选中一段文字**，鼠标旁会出现工具栏：

| 技能 | 说明 |
| --- | --- |
| 翻译 | 流式翻译为默认目标语言（自动中英互译，可在结果面板切换） |
| 总结 | 用简体中文提炼要点 |
| 解释 | 用简体中文解释含义与背景 |
| 朗读 | 用 Windows 系统语音朗读 |
| 复制 | 复制选中文本 |

也可用 `Ctrl+Shift+D` 对当前选区直接唤起。点击「⋯」菜单可临时在某个应用中禁用、打开设置或禁用划词工具。

## 常见问题

- **在某个应用里不弹工具栏？** 部分应用（如部分 PDF 阅读器、游戏、提权运行的程序）未暴露可读取的选区，可在「⋯ → 在此应用中禁用」加入黑名单。管理员权限运行的应用通常无法取词，这是 Windows UIPI 的限制。
- **离线模式很慢/占内存？** 本地模型推理速度取决于 CPU；7B 以下小模型在普通笔记本上可用，更大模型需要更强硬件。
- **端口被占用/服务连不上？** 在线模式请确认服务地址以 `/v1` 结尾（如 `http://127.0.0.1:11434/v1`），并允许本程序访问该地址。
- **数据放在哪？** 默认 `<程序目录>/data`；不可写时回退 `%APPDATA%\LingoPick`。可在「关于」中打开目录。

## 从源码构建

环境：Windows 10/11 x64、Node.js ≥ 20、Rust stable、Visual Studio Build Tools（C++ 桌面开发）、WebView2 Runtime。

```powershell
npm install
npx tauri build --no-bundle     # 产出 src-tauri/target/release/lingopick.exe
.\scripts\build-portable.ps1    # 产出 dist/LingoPick-<version>-win-x64.exe
```

开发调试：

```powershell
npx tauri dev
# 或直接构建并运行：
npx tauri build --debug --no-bundle
.\src-tauri\target\debug\lingopick.exe --show
```

更多细节见 [构建文档](docs/building.md) 与 [架构说明](docs/architecture.md)。

## 技术栈

Tauri v2 + Rust（窗口/托盘/全局输入钩子/Windows UI Automation 取词）+ 原生 HTML/CSS/JS（WebView2 渲染）+ llama.cpp（离线推理）。

特别感谢以下开源项目：

- [Tauri](https://tauri.app)（MIT/Apache-2.0）
- [selection-hook](https://github.com/0xfullex/selection-hook)（MIT，本项目的取词思路与兼容性处理参考了它）
- [llama.cpp](https://github.com/ggml-org/llama.cpp)（MIT）
- [Qwen2.5](https://huggingface.co/Qwen) GGUF 模型（Apache-2.0）
- [rdev](https://github.com/Narsil/rdev)（MIT）

## 参与贡献

欢迎提交 Issue / PR，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE) © 2026 LingoPick contributors

---

## English

**LingoPick** is a lightweight, portable Windows selection translator built with Tauri v2. Select text anywhere, and a small floating toolbar appears next to the cursor with **translate / summarize / explain / read aloud / copy** actions.

- Online mode works with any OpenAI-compatible endpoint; offline mode runs locally with llama.cpp + GGUF models (downloaded on demand).
- Single portable exe (~10MB), system tray, optional start-at-login, global hotkey `Ctrl+Shift+D`.
- Source-level docs: [architecture](docs/architecture.md) · [building](docs/building.md) · [contract](docs/contracts.md).

Build from source on Windows with Node.js ≥ 20, Rust, and VS Build Tools:

```powershell
npm install
npx tauri build --no-bundle
```
