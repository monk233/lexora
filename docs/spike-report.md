# Tauri v2 可行性 Spike 报告（取词 + UI）

日期：2026-10-24 · 环境：Windows 11 x64 · rustc 1.97.1 · VS2022 BuildTools · WebView2 155 · 物理 3840×2160 @150%（逻辑 2560×1440）

复现代码（独立目录，未纳入本仓库）：

- 取词 spike：`E:\document\workspace\AIProjects\lingopick-spike`（Rust CLI）
- UI spike：`E:\document\workspace\AIProjects\lingopick-tauri-spike`（Tauri v2 应用，含 REPORT.md、截图、测试脚本）

## 结论

**采用 Tauri v2。** 两个关键风险点都已实测通过：

1. **跨应用取词**：原生 Rust UI Automation 在 Notepad / Chrome / Edge / Word 全部成功，热路径 5–30ms；目标应用 UI 线程挂起时不会无限卡死（5s 内返回错误），配合看门狗可压到 1.5s 内。
2. **悬浮窗 UI**：Tauri v2 透明无边框圆角窗口渲染正常（逐像素验证无白边/残影）；快捷键呼出 10–26ms；4K@150% 坐标换算误差 0；resize 三帧截图哈希一致；托盘常驻/干净退出正常。
3. **朗读**：WebView2 `speechSynthesis` 可用，本机 6 个系统语音（默认 Microsoft Huihui zh-CN），无需额外 TTS 引擎。

## 一、取词能力

| 场景 | 结果 | 数据 |
| --- | --- | --- |
| Windows 11 新版 Notepad（WinUI） | 通过 | 140 字符，首次 60.5ms，热态 5–18ms，control_type=Document(50030) |
| Google Chrome（页面文本） | 通过 | 140 字符，首次 17.3ms，热态 5.9ms，无需启动参数 |
| Microsoft Edge | 通过 | 140 字符，首次 172.8ms（无障碍预热），热态 8.3ms |
| Microsoft Word（.txt 文档） | 通过 | 142 字符，首次 179.6ms，热态 32.4ms |
| 真实鼠标拖选触发（Notepad） | 通过 | 拖动 495 物理像素，选中 50 字符，取词 17.8ms |
| Explorer（无文本模式） | 快速失败 | 483ms 内返回「no text pattern」，无卡死 |
| 目标应用 UI 线程被挂起 | 可控失败 | 4974.7ms 后返回 `GetFocusedElement: 0x80131505`；旧实现同类场景曾卡 60s |
| 坐标 | 物理像素确认 | UIA/mouse hook 返回物理像素；150% 缩放下 rdev 坐标 ×1.5 与窗口物理坐标一致 |

关键技术结论：

1. **不要用 `uiautomation` crate 做主路径**（0.25.1）：强制 MTA、UIA 类型 `!Send + !Sync`、没有连接/事务超时、没有选区矩形接口。直接用 `windows` crate 原生 COM：`CoCreateInstance(CLSID_CUIAutomation8)` → cast `IUIAutomation2` → `SetConnectionTimeout(1500)` / `SetTransactionTimeout(1000)`。
2. **超时不是硬保证**：挂起 provider 仍耗 4.97s。生产实现必须加看门狗：每次取词独立线程 + `recv_timeout(1500ms)`，超时放弃线程，绝不 join。
3. **取词锚点**：精确定位用 `IUIAutomationTextRange::GetBoundingRectangles()`（SAFEARRAY(R8)，每 4 个 double `[left, top, width, height]`，物理像素），取最后一个 range 的 `(right, bottom)`；MVP 用鼠标物理坐标。
4. **键盘/鼠标钩子**：`rdev` 可用（无停止 API，用 AtomicBool 门控）；UIPI 下无法读取提权窗口。
5. **应用覆盖**：Chrome/Edge/Word/Notepad/多数 Chromium 应用可用；Excel 无 TextPattern；微信、多数 PDF 阅读器、Firefox 需无法取词（与原 Electron 版一致，原版同样关闭剪贴板回退）。
6. **Windows 11 Notepad 是 WinUI/UWP**：UIA 正常，但自动化测试需按窗口标题/进程名匹配，不能依赖启动器 PID。

## 二、悬浮窗 UI 能力

| 场景 | 结果 | 数据 |
| --- | --- | --- |
| 透明/圆角渲染 | 通过 | 纯色底窗像素验证：6/6 边距透底、5/5 卡片纯白；展开后 4/4 角仍透底，无白边 |
| 快捷键呼出延迟 | 通过 | Rust show 25.4ms（首次）/ 10–16ms（热态）；press→前端 rAF 26ms |
| DPI 换算 | 通过 | 4K@150%：Logical(95.33,918) → 物理(143,1377)，误差 0；560×120→840×180，520×360→780×540 |
| 展开 resize 重绘 | 通过 | 点击后 80ms/150ms/1s 三帧裁剪 SHA256 完全相同，无残影/旧画面 |
| 失焦隐藏 / Esc / 关闭按钮 | 通过 | 关闭按钮与 WM_CLOSE 被拦截，进程不退出 |
| 托盘 | 通过 | 托盘创建、菜单退出 `app.exit(0)` → `RUN_EVENT_EXIT` 干净退出；隐藏态内存约 31MB |
| WebView2 朗读 | 通过 | `speechSynthesis` 6 个语音，默认 Microsoft Huihui zh-CN local |

Tauri 实现要点（详见 `research-tauri.md`）：坐标优先直接传 `PhysicalPosition`；透明窗需 `transparent/decorations(false)/alwaysOnTop/skipTaskbar/shadow(false)`；`set_size` 无完成回调，需监听 `Resized` 或按 `inner_size` 复核；单实例插件必须第一个注册；`--no-bundle` 不复制 `bundle.resources`。

## 三、剩余风险

- 多显示器混合 DPI 未实测（clamp 按鼠标所在显示器实现，跨屏 scale_factor 更新需真机验证）。
- Win11 托盘图标默认收进溢出区，产品文档需引导用户拖出。
- 老版 Win10 可能缺 WebView2 Runtime（Win11/新版 Win10 自带），README 需说明。
- 首次对 Chrome 系取词有 17–180ms 无障碍预热，可在启动时做一次不可见预热（可选优化）。
- 本地 llama.cpp 推理速度取决于 CPU，小模型（1.5B 级）在普通笔记本可用。

## 四、最终技术方案

Tauri v2 + Rust：`windows` crate 原生 UIA 取词（看门狗）、`rdev` 全局钩子、`reqwest` 流式翻译、`llama-server.exe` 进程管理（按需下载）、系统托盘/透明窗；前端沿用现有 picker HTML/CSS/JS 并适配 Tauri IPC，设置页重做简洁版；发布免安装单 exe（约 5–10MB，引擎与 GGUF 模型按需下载/导入）。
