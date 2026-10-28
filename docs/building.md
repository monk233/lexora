# 构建与发布

## 环境

| 依赖 | 说明 |
| --- | --- |
| Windows 10/11 x64 | 目标平台（验证：Windows 11 26100，3840×2160 @150% DPI） |
| Node.js ≥ 20 | Tauri CLI 与前端脚本（验证：v26） |
| Rust stable（1.80+） | `rustup` 安装，默认 `x86_64-pc-windows-msvc`（验证：1.97） |
| Visual Studio Build Tools | 勾选「使用 C++ 的桌面开发」（MSVC + Windows SDK） |
| WebView2 Runtime | Win11 / 新版 Win10 自带；老系统需单独安装 |
| Python 3（可选） | 仅图标生成 `scripts/make_icons.py` 需要（Pillow） |

## 本地开发

```powershell
npm install
npx tauri dev
```

`tauri dev` 直接读取 `web/` 静态前端（无 dev server），修改后刷新窗口即可看到效果；Rust 改动会触发重编译。

调试运行（不打包）：

```powershell
npx tauri build --debug --no-bundle
.\src-tauri\target\debug\lexora.exe --show
```

数据目录（开发模式）：`<repo>/data`；日志：`data/logs/main.log`（本地引擎日志 `data/logs/llama.log`）。

### 本地联调离线翻译（不下载大模型）

本机已有 llama.cpp 与 GGUF 时可直接复用：

```powershell
$env:LEXORA_LLAMA_DIR = "E:\path\to\llama"       # 含 llama-server.exe
$env:LEXORA_MODEL_DIR = "E:\path\to\models"      # 含 *.gguf / mmproj-*.gguf
.\src-tauri\target\debug\lexora.exe --show
```

然后在设置中选择本地模式并启动。也可用 `scripts/fetch-llama.ps1 -FromDir <目录>` 复制现成引擎。

## 构建发布包（免安装单文件）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-portable.ps1
```

产物：`dist\Lexora-<version>-win-x64.exe`（release 单文件，当前约 10–11 MB）。

- 不再打包 zip：发布资产就是这个 exe，下载后双击即用。
- 数据写入 exe 同级 `data/`（settings.json、models、engine、logs、cache）。
- 引擎与 GGUF 模型由应用内按需下载，不塞进单文件 exe。

只构建不复制：

```powershell
npx tauri build --no-bundle
# → src-tauri\target\release\lexora.exe
```

`scripts/build-portable.ps1` 支持 `-SkipBuild` 复用已有 `target\release` 产物。

> **重要**：release exe 正在运行时文件会被占用，重新构建会报 `failed to remove file ...lexora.exe (os error 5)`。构建前先退出正在运行的 Lexora（托盘 → 退出，或 `Stop-Process -Name lexora`），并确认没有遗留的 `llama-server` 子进程。

## 测试

```powershell
cd src-tauri
cargo fmt --check          # 格式检查
cargo test                 # 单元测试（当前 242 passed / 2 ignored）
cargo check --all-targets  # 编译检查
```

单元测试覆盖设置归一化与迁移（v6）、SSE 解析、错误映射、模型目录、截图快捷键盘映射、标注几何/裁剪/变换、长截图双向拼接与尺寸上限、pin 显示尺寸等纯逻辑，不联网、不依赖桌面。

前端 JS 语法检查（无构建步骤，发布前建议执行）：

```powershell
node --check web/capture.js
node --check web/capture-annotate.js
node --check web/longshot.js
node --check web/pin.js
node --check web/settings.js
node --check web/picker.js
node --check web/shared/tauri-api.js
```

### 自动化冒烟（WebView2 CDP）

桌面特性（截图 overlay、标注、pin、长截图）可用 WebView2 远程调试做端到端验证：

```powershell
$env:LEXORA_DATA_DIR = "$env:TEMP\lexora-test"          # 隔离数据，避免污染正式配置
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9420"
.\src-tauri\target\release\lexora.exe
# 然后通过 http://127.0.0.1:9420/json/list 连接页面（settings / capture / pin / longshot）
```

`tests/` 下有 `cdp-eval.mjs` / `cdp-screenshot.mjs` 等小工具；截图 overlay 页可通过 `Runtime.evaluate` 调用 `window.__TAURI__.core.invoke('start_capture')`、`window.__captureEditor` 等测试钩子。真实鼠标滚动、系统截图/录屏可见性必须人工验证。

## 发布流程（维护者）

1. 同步版本号：`package.json`、`package-lock.json`（根与根包）、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`（仅 `lexora` 包）、`src-tauri/tauri.conf.json` 六个版本字段保持一致（当前 `0.4.0`）。
2. 在 `CHANGELOG.md` 中把 `## [Unreleased]` 整理为 `## [<version>] - YYYY-MM-DD` 小节（Keep a Changelog 风格）。Release 正文由该小节生成；缺少时退化为按 conventional-commit 类型分组的提交列表。
3. 更新文档：`docs/user-guide.md`（用户功能）、`docs/building.md`（构建变化）、`docs/contracts.md`（行为契约有改动时）。
4. 本地构建并冒烟：`cargo fmt --check && cargo test`、`node --check`、`scripts/build-portable.ps1`，启动新 exe 手动验证关键流程。
5. 提交后打 tag 并推送：
   ```powershell
   git tag v<version>
   git push origin master v<version>
   ```
   tag 必须与 `tauri.conf.json` 的版本一致，否则 Release workflow 直接失败。
6. GitHub Actions（`.github/workflows/release.yml`）自动构建单 exe、生成 release notes 并上传到 Release。

本地预览 release 正文：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-notes.ps1 -Version <version>
```

## 常见问题

- **`tauri build` 报找不到 web 资源**：确认仓库根目录存在 `web/index.html`、`web/picker.html`、`web/capture.html`、`web/longshot.html`、`web/pin.html`，且 `tauri.conf.json` 的 `build.frontendDist` 为 `"../web"`。
- **构建失败 `failed to remove ...lexora.exe (os error 5)`**：旧 exe 仍在运行，先退出 Lexora / 结束残留 `llama-server`。
- **WebView2 远程调试端口没起来**：必须在启动 exe 前设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`（进程环境变量），启动后设置无效。
- **首次编译慢**：Tauri/Rust 依赖首次编译需数分钟，后续增量构建很快。
- **Rust crate 下载慢**：可配置国内 crates.io 镜像（rsproxy），见 `docs/contracts.md` 环境说明。
- **Windows 构建要求合法 .ico**：图标由 `scripts/make_icons.py` 生成（需要 Pillow），仓库已内置生成结果。
- **`data/` 数据目录**：便携版是 exe 同级 `data/`；开发/调试可用 `LEXORA_DATA_DIR` 指向临时目录做隔离测试。
