# 构建与发布

## 环境

| 依赖 | 说明 |
| --- | --- |
| Windows 10/11 x64 | 目标平台 |
| Node.js ≥ 20 | Tauri CLI 与脚本 |
| Rust stable（1.77+） | `rustup` 安装，默认 `x86_64-pc-windows-msvc` |
| Visual Studio Build Tools | 勾选「使用 C++ 的桌面开发」 |
| WebView2 Runtime | Win11/新版 Win10 自带；老系统需单独安装 |

## 本地开发

```powershell
npm install
npx tauri dev
```

`tauri dev` 会读取 `web/` 静态前端（无 dev server）。调试运行：

```powershell
npx tauri build --debug --no-bundle
.\src-tauri\target\debug\lexora.exe --show
```

数据目录（开发模式）：`<repo>/data`；日志在 `data/logs/main.log`。

### 本地联调离线翻译（不下载大模型）

如果本机已有 llama.cpp 与 GGUF（例如从旧项目复制），可直接复用：

```powershell
$env:LEXORA_LLAMA_DIR = "E:\path\to\llama"       # 含 llama-server.exe
$env:LEXORA_MODEL_DIR = "E:\path\to\models"      # 含 *.gguf
.\src-tauri\target\debug\lexora.exe --show
```

然后在设置中选择本地模式、选择模型并启动。也可用 `scripts/fetch-llama.ps1 -FromDir <目录>` 复制现成引擎。

## 构建发布包（免安装单文件）

```powershell
.\scripts\build-portable.ps1
```

产物：`dist\Lexora-<version>-win-x64.exe`（release 单文件，约 5–10MB）。

- 不再打包 zip：发布资产就是这一个 exe，用户下载后双击即用。
- 数据写入 exe 同级 `data/`（settings.json、models、engine、logs、cache）。
- 引擎与 GGUF 模型由应用内按需下载，因此无法塞进单文件 exe。

也可以只构建不复制：

```powershell
npx tauri build --no-bundle
# → src-tauri\target\release\lexora.exe
```

`scripts/build-portable.ps1` 支持 `-SkipBuild` 复用已有 `target\release` 产物。

## 引擎与模型下载

- 引擎：首次在设置页点「下载引擎」，从 llama.cpp GitHub Releases 下载 `llama-b11851-bin-win-cpu-x64.zip`（约 23MB）并解压到数据目录。
- 模型：设置页内置 Qwen2.5 GGUF 目录（ModelScope 优先，Hugging Face 回退），也可「导入 GGUF」选择本地文件。
- 完全离线环境：把 `llama-server.exe` 及其 DLL 手动放到 `<data>/engine/`，GGUF 放到 `<data>/models/`，再在设置页选择模型即可。

## 测试

```powershell
cd src-tauri
cargo test
```

单元测试覆盖设置归一化、SSE 解析、错误映射、模型目录常量、日志脱敏等纯逻辑，不联网。

## 发布流程（维护者）

1. 更新 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 中的版本号。
2. 在 `CHANGELOG.md` 中把 `[Unreleased]` 内容整理成 `## [<version>] - YYYY-MM-DD` 小节（Keep a Changelog 风格）。Release 正文由这个小节生成；如果没有该小节，会退化为按 conventional-commit 类型分组的提交列表。
3. 提交后打 tag：`git tag v<version> && git push origin v<version>`。tag 必须与 `tauri.conf.json` 的版本一致，否则 Release workflow 会直接失败。
4. GitHub Actions（`.github/workflows/release.yml`）自动构建单 exe、生成 release notes 并上传到 Release。

本地可以先预览 release 正文：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-notes.ps1 -Version <version>
```

## 常见问题

- **`tauri build` 报找不到 web 资源**：确认仓库根目录存在 `web/index.html`、`web/picker.html`，且 `tauri.conf.json` 的 `build.frontendDist` 为 `"../web"`。
- **首次编译很慢**：Tauri/Rust 依赖首次编译需数分钟，后续增量构建很快。
- **Rust crate 下载慢**：可配置国内 crates.io 镜像（rsproxy），见 `docs/contracts.md` 环境说明。
- **Windows 构建要求合法 .ico**：图标由 `scripts/make_icons.py` 生成（需要 Pillow），仓库已内置生成结果。
