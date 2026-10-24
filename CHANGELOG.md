# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/) 与 [Keep a Changelog](https://keepachangelog.com/) 风格。

## [Unreleased]

### Added

- 划词工具栏：翻译（流式）、总结、解释、朗读、复制；结果面板固定/目标语言/重试；更多菜单（本应用禁用、设置、禁用工具、关闭）。
- 全局拖动选词与 `Ctrl+Shift+D` 快捷键触发；多显示器 DPI 适配；外部点击自动隐藏。
- 在线翻译：任意 OpenAI 兼容接口，预设 DeepSeek / OpenAI / Moonshot / 智谱 / Ollama / LM Studio / 自定义，支持测试连接与模型列表。
- 离线翻译：内置 llama.cpp 引擎下载器 + Qwen2.5 GGUF 模型目录（0.5B / 1.5B / 3B），支持导入本地 GGUF。
- 设置页：翻译服务、划词行为、应用与启动、关于，自动保存与实时状态。
- 系统托盘后台运行、单实例、可选开机自启、便携数据目录。
- 免安装构建脚本与 GitHub Actions CI/Release。
