# 贡献指南

感谢参与 Lexora！本项目是 Tauri v2 + Rust 的小工具，前端由 `frontend/` 的 React + Vite 构建产物加载（旧 `web/` 原生前端保留为遗留参考实现），代码保持简洁、可读、可直接构建。

## 开发环境

见 [docs/building.md](docs/building.md)。提交前请确保：

```powershell
npm install
cd src-tauri
cargo test
cargo check
npx tauri build --debug --no-bundle
```

## 代码规范

- Rust：`cargo fmt` 格式化；模块职责见 [docs/architecture.md](docs/architecture.md) 与 [docs/contracts.md](docs/contracts.md)。
- 前端：应用实际加载 `frontend/` 的 React 18 + Vite 构建产物（R2 进行中，窗口内容仍为占位骨架，P2–P5 迁移）；`web/` 原生 HTML/CSS/JS 仅作为遗留参考实现保留，不引入框架或打包器，其中的 `web/shared/tauri-api.js` 仅服务该遗留实现。
- 用户可见文案用中文（设置/错误提示），代码注释用英文。
- 新增依赖需在 PR 中说明理由，保持体积与安全可控。
- 不提交模型、引擎二进制、`data/`、`target/`。

## 提交信息

沿用 Conventional Commits：

```
feat(picker): support custom target languages
fix(engine): handle SSE chunks split inside UTF-8 sequences
docs: update portable build guide
```

## 提 Issue

请附上：

- Windows 版本、显示缩放比例、应用版本（设置 → 关于）
- 复现步骤
- 相关日志：`data/logs/main.log`、`data/logs/llama.log`（注意先删除 API Key）
- 涉及取词时，说明目标应用名称与版本

## 提 PR

1. Fork 仓库并从 `main` 切分支。
2. 保持改动聚焦，一个 PR 解决一个问题。
3. 更新相关文档（README / docs）。
4. 通过 CI（`.github/workflows/ci.yml`）。

## 许可

提交的代码默认以 [MIT](LICENSE) 许可发布。
