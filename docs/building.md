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
.\src-tauri\target\debug\lingopick.exe --show
```

数据目录（开发模式）：`<repo>/data`；日志在 `data/logs/main.log`。

### 本地联调离线翻译（不下载大模型）

如果本机已有 llama.cpp 与 GGUF（例如从旧项目复制），可直接复用：

```powershell
$env:LINGOPICK_LLAMA_DIR = "E:\path\to\llama"       # 含 llama-server.exe
$env:LINGOPICK_MODEL_DIR = "E:\path\to\models"      # 含 *.gguf
.\src-tauri\target\debug\lingopick.exe --show
```

然后在设置中选择本地模式、选择模型并启动。也可用 `scripts/fetch-llama.ps1 -FromDir <目录>` 复制现成引擎。

## 构建发布包（免安装）

```powershell
.\scripts\build-portable.ps1
```

产物：`dist\LingoPick-<version>-win-x64.zip`，包含：

- `lingopick.exe`（release，约 5–10MB）
- `LingoPick-PORTABLE.txt`（便携版使用说明）
- 可选 `engine/`（`-WithEngine` 参数）

用户解压即用，数据写入 exe 同级 `data/`。

也可以只产 exe：

```powershell
npx tauri build --no-bundle
# → src-tauri\target\release\lingopick.exe
```

## 引擎与模型下载

- 引擎：首次在设置页点「下载引擎」，从 llama.cpp GitHub Releases 下载 `llama-b11851-bin-win-cpu-x64.zip`（约 23MB）并解压到数据目录。
- 模型：设置页内置 Qwen2.5 GGUF 目录（HF / ModelScope 双源），也可「导入 GGUF」选择本地文件。
- 完全离线环境：把 `llama-server.exe` 及其 DLL 手动放到 `<data>/engine/`，GGUF 放到 `<data>/models/`，再在设置页选择模型即可。

## 测试

```powershell
cd src-tauri
cargo test
```

单元测试覆盖设置归一化、SSE 解析、错误映射、模型目录常量、日志脱敏等纯逻辑，不联网。

## 发布流程（维护者）

1. 更新 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 中的版本号。
2. 更新 `CHANGELOG.md`。
3. 打 tag：`git tag v0.1.0 && git push origin v0.1.0`。
4. GitHub Actions（`.github/workflows/release.yml`）自动构建并上传 zip 到 Release。

## 常见问题

- **`tauri build` 报找不到 web 资源**：确认仓库根目录存在 `web/index.html`、`web/picker.html`，且 `tauri.conf.json` 的 `build.frontendDist` 为 `"../web"`。
- **首次编译很慢**：Tauri/Rust 依赖首次编译需数分钟，后续增量构建很快。
- **Rust crate 下载慢**：可配置国内 crates.io 镜像（rsproxy），见 `docs/contracts.md` 环境说明。
- **Windows 构建要求合法 .ico**：图标由 `scripts/make_icons.py` 生成（需要 Pillow），仓库已内置生成结果。
