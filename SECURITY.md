# 安全策略

## 报告安全问题

如果你发现安全漏洞，请不要公开提交 Issue，通过 GitHub Security Advisories（仓库 → Security → Report a vulnerability）或私下联系维护者。我们会在确认后尽快修复并在 Release Notes 中致谢。

## 设计中的安全边界

- **本地优先**：程序不内置遥测、分析或自动更新检查。仅以下情况产生网络请求：
  1. 用户配置并使用在线翻译服务（选中文本会发送到该服务）；
  2. 用户在设置页主动下载 llama.cpp 引擎或 GGUF 模型。
- **API Key**：以明文保存在本机 `settings.json`，仅用于向用户配置的服务认证；日志写入前会脱敏（`sk-...`、`Bearer ...`、`apiKey` 字段）。
- **前端**：只加载本地静态资源；禁止页面导航到外部站点；外部链接仅通过系统浏览器打开且限制为 `https`。
- **取词**：只读取 Windows UI Automation 暴露的无障碍选区信息，不注入其它进程、不模拟按键、不读取剪贴板（因此不会破坏剪贴板内容）。
- **提权边界**：以管理员权限运行的目标应用无法被普通权限的 LingoPick 读取，这是 Windows UIPI 的预期限制。

## 支持范围

- Windows 10/11 x64
- WebView2 Runtime（系统自带或可安装）

## 依赖与模型

- llama.cpp：MIT
- Qwen2.5 GGUF 默认模型：Apache-2.0
- 依赖清单见 `src-tauri/Cargo.toml` 与 `package.json`；发布前会关注 `cargo audit` / `npm audit` 结果。
