# 跨应用读取选中文本：Windows UIA 方案调研（Tauri v2 + Rust）

> 目标：用 Rust 复刻 Electron 版 selection-hook（MIT）基于 UI Automation TextPattern 的取词能力，默认不启用剪贴板回退。结论先行：主路径 `uiautomation 0.25.1` + **专用 MTA 工作线程 + channel**；超时与选区矩形 crate 未封装，直接下探 `windows 0.62` 的 `IUIAutomation2` / `IUIAutomationTextRange`；回退做成可选开关，默认关闭。调研时间 2026-10，凡标「待实测」者需在目标机器人工验证。

## 1. 依赖与最小可编译示例
```toml
[target.'cfg(windows)'.dependencies]
# 默认 features = control + input，control 会带出 pattern，TextPattern 已够用；要进程名/截图再加 "process"/"screenshot"
uiautomation = "0.25.1"
# windows 必须与 uiautomation 依赖的 0.62.2 一致，否则 IUIAutomation 类型不互通
windows = { version = "0.62", features = [
  "Win32_UI_Accessibility", "Win32_System_Com", "Win32_System_DataExchange", "Win32_System_Memory",
  "Win32_UI_Input_KeyboardAndMouse", "Win32_UI_WindowsAndMessaging", "Win32_Foundation",
] }
rdev = "0.5.3"
```

关键 API 事实（已核对 0.25.1 源码）：

- `UIAutomation::new()` 内部 `CoInitializeEx(None, COINIT_MULTITHREADED)`；当前线程若已是 STA（Tauri 主线程通常是）会返回 `RPC_E_CHANGED_MODE`，绕过初始化用 `new_direct()`。
- `UIAutomation` / `UIElement` / `UITextPattern` / `UITextRange` 均 `!Send + !Sync`，不能放进 `Arc<Mutex<_>>` 共享。
- 实际签名：`get_pattern<T: UIPattern + TryFrom<IUnknown, Error = Error>>(&self) -> Result<T>`；`get_selection() -> Result<Vec<UITextRange>>`；`get_text(max_length: i32)`（-1 为全部）。根模块只 re-export `UIAutomation`/`UIElement`/`UITreeWalker`/`UIMatcher`，pattern 要写全路径。

```rust
use uiautomation::UIAutomation;
use uiautomation::patterns::UITextPattern;
pub struct Selection {
    pub text: String,
    pub rects: Vec<(i32, i32, i32, i32)>, // (left, top, right, bottom)，屏幕物理像素
    pub pid: u32,
}
/// 只允许在专用 MTA 线程调用（见 §2）。
pub fn read_selection(automation: &UIAutomation, mouse_x: i32, mouse_y: i32) -> Option<Selection> {
    let walker = automation.create_tree_walker().ok()?;
    // 焦点一般已落在目标上；取不到时用鼠标点命中测试
    let mut element = automation.get_focused_element()
        .or_else(|_| automation.element_from_point(uiautomation::types::Point::new(mouse_x, mouse_y))).ok()?;
    // 焦点元素可能是不带选区的外层容器（如 Chrome 的 tabindex 容器），最多向上找 6 层
    for _ in 0..6 {
        if let Ok(pattern) = element.get_pattern::<UITextPattern>() {
            if let Ok(ranges) = pattern.get_selection() {
                let text = ranges.iter().filter_map(|r| r.get_text(-1).ok()).collect::<Vec<_>>().join("\n");
                if !text.trim().is_empty() {              // 未选中时多为退化 caret range，返回空串
                    let rects = ranges.last().map(bounding_rects).unwrap_or_default();
                    return Some(Selection { text, rects, pid: element.get_process_id().unwrap_or(0) });
                }
            }
        }
        match walker.get_parent(&element) { Ok(parent) => element = parent, Err(_) => break }
    }
    None
}
```

`bounding_rects` 见 §4。建议鼠标抬起后延迟 20–30ms 再读，失败重试 1–2 次：部分应用在 `WM_LBUTTONUP` 处理完之前选区尚未提交（待实测）。

## 2. 跨进程卡死、超时与线程模型
必须专用线程，而且这个线程要**可抛弃**。

- `ConnectionTimeout`（首次跨进程连接）与 `TransactionTimeout`（单次调用）只是 COM 侧等待上限；provider 自身不返回时客户端仍可能永久阻塞（微软 UIA 线程模型文档与 selection-hook WINDOWS.md 都这么说）。
- 所以正确做法不是「设个超时」，而是「请求-响应 + 看门狗」：1.5s 未回包即判该线程中毒，`detach`（连卡死的 COM 调用一起泄漏），另起新线程，**绝不能 join**。每请求新建线程也能绕开卡死，但每次 `CoCreateInstance` 要几毫秒，高频取词不如常驻线程 + 超时重建。
- 工作线程不跑 async、不做剪贴板（OLE 剪贴板需 STA，与 MTA 冲突），剪贴板另开线程。

```rust
pub enum Req { Read { x: i32, y: i32, reply: std::sync::mpsc::SyncSender<Option<Selection>> } }
pub fn spawn_uia_thread() -> std::sync::mpsc::Sender<Req> {
    let (tx, rx) = std::sync::mpsc::channel::<Req>();
    std::thread::spawn(move || {
        let Ok(automation) = UIAutomation::new() else { return };
        let _ = set_timeouts(&automation);
        while let Ok(Req::Read { x, y, reply }) = rx.recv() {
            let _ = reply.send(read_selection(&automation, x, y));
        }
    });
    tx
}
```

```rust
use windows::core::Interface;
use windows::Win32::UI::Accessibility::{IUIAutomation, IUIAutomation2};
/// 两个超时都在 IUIAutomation2 上，crate 未封装，需 cast 后直调。
pub fn set_timeouts(automation: &UIAutomation) -> windows::core::Result<()> {
    let base: &IUIAutomation = automation.as_ref();
    let uia2: IUIAutomation2 = base.cast()?;
    unsafe {
        uia2.SetConnectionTimeout(2_000)?;  // ms
        uia2.SetTransactionTimeout(3_000)?; // ms，别太小，Office 首次调用慢
    }
    Ok(())
}
```

补充：同进程取词（在我们的 WebView 内选中）最危险，微软明确说在自身 UI 线程上调用 UIA 可能极慢甚至挂起，这类情况直接跳过。

## 3. 各应用覆盖与特殊处理

| 应用 | UIA TextPattern | 说明 | 需要回退 |
|---|---|---|---|
| Chrome / Edge | 多数可用（待实测） | Chromium 检测到 UIA 客户端后按需开启 renderer accessibility；`--disable-renderer-accessibility` 启动、纯 canvas、内置 PDF 查看器会让 TextPattern 为空 | 是（兜底） |
| Word | 可用（整段粒度） | 文档控件支持 TextPattern；未选中时返回退化 range（空串），必须判空；跨页大选区耗时可观（待实测） | 否 |
| Excel | 基本不可用 | 网格只暴露 Grid/Table/Value pattern，单元格文本没有 TextPattern 选区 | 是 |
| Windows 11 记事本 | 待实测 | WinUI3 + RichEdit，理论上有 TextPattern | 视情况 |
| Firefox | 待实测 | 主路径是 IAccessible2，UIA 支持不完整且随版本变化 | 很可能需要 |
| Electron（VS Code / 微信） | VS Code 可用（待实测）；微信通常失败 | Monaco 在 accessibility 开启后能读；微信聊天区为自绘 UI | 微信需要 |
| PDF（Acrobat / SumatraPDF） | Acrobat 通常无 TextPattern（待实测） | 自定义光标 + Ctrl+C 后先写纯文本再覆盖富文本 | 是，且需专项配置 |

- `--force-renderer-accessibility` 只能在**启动时**加，工具无法给用户已开的浏览器补加；当排障文档，不要当默认依赖。
- selection-hook 的 `setFineTunedList` 就是给 PDF 这类应用准备的：`EXCLUDE_CLIPBOARD_CURSOR_DETECT`（Acrobat/CAJViewer 的自定义光标会被 I 型光标检测误判成非文本）、`INCLUDE_CLIPBOARD_DELAY_READ`（Acrobat 多次写剪贴板，读早会拿到半截）。覆盖顺序照抄：UIA → IAccessible → 剪贴板；Rust 首版可先做 UIA + 剪贴板，IAccessible 后补。

## 4. 取词位置：选区矩形与锚点
`UITextRange` 没有封装矩形接口，必须直调 COM。UIA 返回 `SAFEARRAY(R8)`，每 4 个 double 一组 `[left, top, width, height]`，单位是**屏幕物理像素**（UIA 永远给物理像素，与进程 DPI 感知无关）。

```rust
use uiautomation::patterns::UITextRange;
use uiautomation::variants::SafeArray;
use windows::Win32::UI::Accessibility::IUIAutomationTextRange;
pub fn bounding_rects(range: &UITextRange) -> Vec<(i32, i32, i32, i32)> {
    let raw: &IUIAutomationTextRange = range.as_ref();
    let Ok(ptr) = (unsafe { raw.GetBoundingRectangles() }) else { return Vec::new() };
    if ptr.is_null() { return Vec::new() }
    let arr = SafeArray::from(ptr); // 接管所有权，Drop 时 SafeArrayDestroy
    let v: Vec<f64> = match (&arr).try_into() { Ok(v) => v, Err(_) => return Vec::new() };
    v.chunks_exact(4).map(|c| (c[0] as i32, c[1] as i32, (c[0] + c[2]) as i32, (c[1] + c[3]) as i32)).collect()
}
```

- `startTop` = 第一个矩形左上；`endBottom` = 最后一个（段落）矩形右下；`mousePosStart` / `mousePosEnd` 是按下/抬起时的鼠标点。
- `posLevel`（源码 index.d.ts）：`NONE=0` 无坐标；`MOUSE_SINGLE=1` 只有抬起点；`MOUSE_DUAL=2` 按下+抬起两点；`SEL_FULL=3` 完整选区矩形；`SEL_DETAILED=4` 更细的逐行矩形。
- 选锚点：`rects` 非空用 `rects.last()` 的 `(right, bottom)`（即 `endBottom`），弹窗贴最后一行右下方；为空则退 `posLevel=2` 的 `mousePosEnd`；多 selection ranges 取**最后一个** range，与原库 `end*` 语义一致。
- 弹窗用 `MonitorFromPoint` + `GetMonitorInfoW` 夹进工作区（多屏左侧 x 为负）；Tauri 窗口坐标是逻辑像素，这里全是物理像素，需除以 `GetDpiForWindow/96`。

## 5. 剪贴板回退（可选，默认关闭）
除非产品接受剪贴板被临时占用，否则保持 `enable_clipboard = false`。要做就按下面做：

1. 保存并恢复：`EnumClipboardFormats` 遍历，`GetClipboardData` + `GlobalLock`/`GlobalSize` 复制字节；`CF_BITMAP`/`CF_PALETTE`/`CF_METAFILEPICT`/`CF_ENHMETAFILE`/`CF_OWNERDISPLAY` 等非 HGLOBAL 格式跳过（不可恢复，需在 UI 说明）；恢复用 `EmptyClipboard` + 逐格式 `SetClipboardData`。
2. 发键：优先 `Ctrl+Insert`（终端/编辑器更安全），不生效再 `Ctrl+C`；`SendInput` 一次投 4 个 `INPUT`（Ctrl↓ vk↓ vk↑ Ctrl↑），抬起时 `KEYBDINPUT.dwFlags` 置 `KEYEVENTF_KEYUP`。
3. 等变化：记录 `GetClipboardSequenceNumber()`，10ms 轮询至变化，总预算 300–400ms；`OpenClipboard` 失败重试 5 次 × 5ms。
4. 不该回退：前台窗口类名为 `ConsoleWindowClass`、`CASCADIA_HOSTING_WINDOW_CLASS`、`mintty`、`PuTTY`；前台进程是自己；前台窗口属于提权进程（低权限 `SendInput` 被 UIPI 拦，注定失败）。

```rust
use std::sync::atomic::{AtomicBool, Ordering}; use std::time::{Duration, Instant};
static INJECTING: AtomicBool = AtomicBool::new(false);

pub fn copy_selection(timeout_ms: u64) -> Option<String> {
    let seq0 = unsafe { GetClipboardSequenceNumber() };
    INJECTING.store(true, Ordering::SeqCst);
    send_ctrl_key(VK_INSERT);                        // 不生效再补一次 VK_C
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline && unsafe { GetClipboardSequenceNumber() } == seq0 {
        std::thread::sleep(Duration::from_millis(10));
    }
    INJECTING.store(false, Ordering::SeqCst);
    if unsafe { GetClipboardSequenceNumber() } == seq0 { return None }
    read_clipboard_text()                            // OpenClipboard 重试 + CF_UNICODETEXT
}
```

风险：恢复会覆盖用户在事务期间自己复制的数据（selection-hook 文档承认这是「restore-first」的代价）；锁剪贴板的进程会让恢复失败；终端里误发 `Ctrl+C` 会中断正在跑的程序；提权窗口连钩子都收不到。

## 6. 全局鼠标/键盘钩子：rdev 0.5.3
- `rdev::listen(callback)` 阻塞且**没有停止 API**，只能放专用线程随进程存活；要支持热重启得改用 `SetWindowsHookExW(WH_MOUSE_LL/WH_KEYBOARD_LL)` 自己写。
- 回调在装钩子的线程执行；超过 `LowLevelHooksTimeout`（默认 300ms）系统会静默摘钩。**回调里只做 channel send**，UIA 全丢给 §2 的工作线程。
- 不区分注入事件（rdev 不暴露 `LLKHF_INJECTED`/`LLMHF_INJECTED`），自己的 `SendInput` 会回灌键盘回调 → 用 `INJECTING: AtomicBool` 门闩，置位期间忽略。
- 组合键（Ctrl+Shift+D）必须用 `Key::ControlLeft/ShiftLeft/KeyD` 自行维护按下状态，不能依赖 `Event.name`（受键盘布局影响）；侧键/多媒体键落到 `Button::Unknown(u8)`，不保证有值。
- 坐标：`MouseMove { x, y }` 是物理像素，`ButtonRelease` 不带坐标，需缓存最近一次 `MouseMove`；进程必须是 PerMonitorV2（Tauri 默认满足，别被 manifest 覆盖），否则坐标会被 DPI 虚拟化。
- UIPI：非提权进程收不到提权窗口的输入事件（WINDOWS.md 明确写了）。「管理员运行的应用取不到词」是预期行为；跨权限只能用 `uiAccess="true"` manifest + 代码签名 + 装到 `Program Files`，或做焦点变化降级提示。

## 7. 替代方案对比

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| `uiautomation 0.25.1` | API 顺手、pattern 封装全、上手快 | 无超时/无矩形、`!Send`、windows 版本耦合 | **推荐做首版** |
| 直接 `windows` crate 写 COM | 全权控制超时、缓存、事件、`CoEnableCallCancellation` | 300–500 行样板，SAFEARRAY/引用计数易错 | 长期演进方向 |
| PowerShell/.NET `UIAutomationClient` | 零编译，适合排障 | 每次起进程 200–500ms，需序列化 | 只做诊断工具 |
| 移植 selection-hook C++ 核心 | 已有 IAccessible、剪贴板事务、按应用微调 | 大工程，N-API 耦合需改 C ABI | 追求完全对齐时再考虑（MIT 允许） |

推荐：首版 `uiautomation` + 少量原生 COM 补丁，把 UIA 访问收敛到一个 trait 后面，将来换手写 COM 不影响上层。

## 8. 关键待实测清单
- [ ] Chrome / Edge 默认启动下文本框与网页正文真拖选是否都有 TextPattern（与 `Ctrl+A` 对比）；加 `--disable-renderer-accessibility` 后是否完全失效。
- [ ] Word：普通段落、表格单元格、跨页选区的成功率与耗时；空选区是否返回空串。
- [ ] Excel 确认 TextPattern 完全不可用，评估是否值得做 `ValuePattern` 兜底。
- [ ] Windows 11 记事本（WinUI3）与旧版记事本分别验证。
- [ ] Firefox 当前稳定版 UIA 是否可用，不可用则记录版本号。
- [ ] VS Code（`editor.accessibilitySupport` 三态）与微信 4.x 聊天区。
- [ ] Adobe Acrobat / SumatraPDF 是否需要两张 fine-tuned 名单。
- [ ] 冷启动/热路径延迟：鼠标抬起 → 拿到文本的 P50/P95（目标 < 150ms）。
- [ ] 多屏 + 150%/200% 缩放：矩形与鼠标点是否同为物理像素、弹窗是否偏移。
- [ ] 管理员运行的目标应用：钩子是否收不到事件，UIA 读取是否同样被 UIPI 拦截（待实测）。
- [ ] 长文本（>10k 字）`get_text(-1)` 的耗时与截断策略。

## 参考
- [uiautomation 0.25.1（docs.rs）](https://docs.rs/uiautomation/0.25.1/uiautomation/) ｜ [源码](https://github.com/leexgone/uiautomation-rs)
- [selection-hook](https://github.com/0xfullex/selection-hook) ｜ [Windows 细节：回退、UIPI、fine-tuned 名单](https://github.com/0xfullex/selection-hook/blob/main/docs/WINDOWS.md) ｜ [index.d.ts（PositionLevel / SelectionMethod）](https://cdn.jsdelivr.net/npm/selection-hook@2.0.1/index.d.ts)
- [UI Automation Threading Issues（微软）](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)
- [IUIAutomation2::SetConnectionTimeout](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-setconnectiontimeout)
- [IUIAutomationTextRange::GetBoundingRectangles](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationtextrange-getboundingrectangles)
- [rdev 0.5.3（docs.rs）](https://docs.rs/rdev/0.5.3/rdev/)
