# LingoPick 的 Tauri v2（Windows / WebView2）实现要点与风险报告
> 调研时间：2026-10-24。本次只做文档与源码核对，未运行构建；标为「待实测」的条目必须在目标机器上验证。
> 目标：全局取词后在鼠标位置弹出透明置顶小窗，调用在线 OpenAI 兼容接口或本地 llama-server，托盘后台运行，便携分发。
- 透明、无边框、置顶、隐藏任务栏、不可缩放的小窗可用 `WebviewWindowBuilder` 一次配置；Windows 不需要 `macos-private-api`。
- `shadow` 在 Windows 无边框窗口上默认造成 1px 白边，透明小窗必须显式设为 `false`。
- 坐标全程使用物理像素，直接传 `PhysicalPosition`；只有传 `LogicalPosition` 时才除以缩放比。
- 不建议使用 `set_ignore_cursor_events`：小窗需要接收点击，且高频切换该状态与透明合成异常有关。
- token 流和下载进度使用 `Channel`；`emit` 只用于低频状态事件。所有 HTTP 请求放在 Rust，前端 CSP 只放行 IPC。
- 免安装单 exe 可行，但 WebView2 Runtime 是系统依赖，`--no-bundle` 不会复制 `bundle.resources`。

## 1. 透明无边框置顶窗口
```rust
use tauri::{webview::NewWindowResponse, WebviewUrl, WebviewWindowBuilder};
let popup = WebviewWindowBuilder::new(app, "popup", WebviewUrl::App("popup.html".into()))
    .inner_size(420.0, 260.0).transparent(true).decorations(false)
    .always_on_top(true).skip_taskbar(true).shadow(false) // 默认 true 会留 1px 白边
    .resizable(false).focused(false).visible(false)
    .background_color(tauri::window::Color(0, 0, 0, 0))
    .on_navigation(|u| u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost")
        || (cfg!(debug_assertions) && u.host_str() == Some("localhost")))
    .on_new_window(|_, _| NewWindowResponse::Deny).build()?;
```
- 选项语义见 [`WebviewWindowBuilder`](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindowBuilder.html)；`shadow` 在 Windows 的 1px 白边见[方法文档](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindowBuilder.html#method.shadow)。页面必须同时写 `html, body { margin:0; background:transparent; overflow:hidden; }`，否则窗口透明也会显示实心底色。
- Windows 透明窗口不需要额外 Cargo feature，`macos-private-api` 只影响 macOS；托盘需给 `tauri` 打开 `tray-icon` feature，见[系统托盘文档](https://v2.tauri.app/learn/system-tray/)。
- 已知问题：长生命周期透明窗可能逐渐变黑（Win10 [#15947](https://github.com/tauri-apps/tauri/issues/15947)、Win11 [#16341](https://github.com/tauri-apps/tauri/issues/16341)）；创建或 `show()` 可能白闪（[#14515](https://github.com/tauri-apps/tauri/issues/14515)、[#15490](https://github.com/tauri-apps/tauri/issues/15490)）；拖动/焦点变化可能出现幽灵标题栏（[#14764](https://github.com/tauri-apps/tauri/issues/14764)）。这些是 WebView2/DWM 合成层问题，不是配置写错。
- 2.12.5 的 `no_redirection_bitmap(true)`（[PR #15410](https://github.com/tauri-apps/tauri/pull/15410)）可减少透明窗首次白闪；它设置 `WS_EX_NOREDIRECTIONBITMAP`，可能影响透明合成，建议先关、出现白闪再开。不要默认加 `--disable-gpu`，它只用于诊断驱动相关黑块。
- `set_ignore_cursor_events` 只在“整窗要点击穿透”时需要（它没有逐像素/区域开关）；本工具整体可交互，不需要。若使用，不要随鼠标移动高频切换，[#15947](https://github.com/tauri-apps/tauri/issues/15947) 的合成竞争正与频繁切换该状态有关。
- `show()` 不保证激活，也可能反过来抢焦点；要严格不激活，用 Win32 `ShowWindow(hwnd, SW_SHOWNOACTIVATE)`（[微软文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-showwindow)）并测试 `set_focusable(false)`。需要键盘输入时再 `set_focus()`，但 Windows 前台锁会让它偶尔失效，见[#8361](https://github.com/tauri-apps/tauri/issues/8361)、[#7519](https://github.com/tauri-apps/tauri/issues/7519)；弹出阶段至少保持 `focused(false)`。
- 不要依赖 `WindowEvent::Focused(false)` 做失焦隐藏：小窗从未获得焦点时不会产生该事件；点击自身按钮也可能触发失焦。更稳的是全局鼠标钩子判断点击是否落在小窗矩形外，或短延时关闭。事件定义见 [`WindowEvent`](https://docs.rs/tauri/2.12.5/tauri/enum.WindowEvent.html)。
- 显示、隐藏、定位全部由 Rust 完成时不需要前端窗口权限；只有前端调用 `getCurrentWindow().show()` 之类才需要 ACL，例如 `core:window:allow-show`、`allow-hide`、`allow-set-position`、`allow-set-size`、`allow-set-focus`、`allow-set-always-on-top`，见[能力文档](https://v2.tauri.app/security/capabilities/)。

## 2. 多显示器与 DPI
- UIA 的 `GetBoundingRectangles` 和低级鼠标钩子返回屏幕物理像素；Tauri 的 [`Monitor`](https://docs.rs/tauri/2.12.5/tauri/window/struct.Monitor.html) 的 `position()`、`size()`、`work_area()` 也是物理像素，`scale_factor()` 才是换算比。跨屏 clamp 用已排除任务栏的 `work_area`，不要用 `size()`。
- [`Window::set_position`](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindow.html#method.set_position) 接收 `Position`，物理与逻辑是两种明确类型。上游是物理像素就直接传 `PhysicalPosition::new(x,y)`，不要除缩放比；只有传 `LogicalPosition` 时才需要 `x / scale_factor`。现有 [`research-uia.md`](./research-uia.md) 中“除一下再 set_position”应限定为后者。
- 不要依赖 `monitor_from_point` 选屏，它存在始终返回 `None` 的未修复报告[#14559](https://github.com/tauri-apps/tauri/issues/14559)。用 `available_monitors()` 加矩形包含判断，找不到时退回最近显示器或主显示器。
```rust
fn place(w: &WebviewWindow, p: PhysicalPosition<i32>, l: LogicalSize<f64>) -> Result<(), String> {
    let ms = w.available_monitors().map_err(|e| e.to_string())?;
    let m = ms.iter().find(|m| { let (o, s) = (m.position(), m.size());
        p.x >= o.x && p.y >= o.y && p.x < o.x + s.width as i32 && p.y < o.y + s.height as i32
    }).or_else(|| ms.first()).ok_or("no monitor")?;
    let (sf, a) = (m.scale_factor(), m.work_area());
    let (bw, bh) = ((l.width * sf).round() as i32, (l.height * sf).round() as i32);
    let (r, b) = (a.position.x + a.size.width as i32, a.position.y + a.size.height as i32);
    let x = (p.x + 12).min(r - bw).max(a.position.x);
    let y = if p.y + 20 + bh <= b { p.y + 20 } else { p.y - bh - 12 };
    w.set_position(PhysicalPosition::new(x, y.clamp(a.position.y, (b - bh).max(a.position.y)))).map_err(|e| e.to_string())?;
    w.set_size(PhysicalSize::new(bw as u32, bh as u32)).map_err(|e| e.to_string())?;
    Ok(())
}
```
- `set_size` 只把请求投递到窗口事件循环，返回成功不等于 resize 完成，也没有 Promise 式回调。正确顺序是隐藏窗口 → 设置位置/尺寸 → 等待 `WindowEvent::Resized` 或 `ScaleFactorChanged` 且 `inner_size()` 达到目标 → 再 `show()`。监听器在启动时只注册一次，用 200–300ms 超时兜底；只等两个 `requestAnimationFrame` 只能保证页面绘制，不能保证宿主窗口尺寸提交，过短等待会造成菜单裁剪和残影。相关伪影讨论见[#13270](https://github.com/tauri-apps/tauri/issues/13270)。
- 进程必须保持 PerMonitorV2 DPI 感知；Tauri 默认满足。自行添加 manifest 或调用 `SetProcessDpiAwareness` 时不要改成 System DPI Aware，否则 UIA/钩子坐标会被系统虚拟化，表现为高缩放屏偏移，见[微软 High DPI 文档](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)。跨屏移动还会触发 `ScaleFactorChanged`，窗口物理尺寸可能被系统再次调整，需在 `Moved`/`ScaleFactorChanged` 后校正；此条**待实测**。

## 3. 全局快捷键
```rust
let key = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyT);
let h = key.clone();
app.handle().plugin(tauri_plugin_global_shortcut::Builder::new()
    .with_handler(move |app, s, e| {
        if s == &h && e.state() == ShortcutState::Pressed { crate::toggle_popup(app); }
    }).build())?;
if let Err(err) = app.global_shortcut().register(key) { /* 设置页提示冲突，保留旧键 */ }
```
- 官方用法与权限项见[全局快捷键插件](https://v2.tauri.app/plugin/global-shortcut/)；前端调用需 `global-shortcut:allow-register`、`allow-unregister`、`allow-is-registered`。
- `register` 在快捷键非法、已被本实例注册、或被系统/其他程序占用时返回错误，不要 `unwrap`；设置页必须提示“快捷键不可用，请换一个”。底层 `RegisterHotKey` 冲突见 [`GlobalHotKeyManager`](https://docs.rs/global-hotkey/0.9.0/global_hotkey/struct.GlobalHotKeyManager.html)。修改时先注册新键成功再注销旧键，新键失败则保留旧键。
- 快捷键在应用窗口聚焦时同样触发；设置页录制快捷键或输入框聚焦时应跳过，否则会吞掉用户输入。游戏、反作弊、独占全屏程序可能收不到全局快捷键，见[#14770](https://github.com/tauri-apps/tauri/issues/14770)，这是平台限制。

## 4. 托盘、单实例与开机自启
```rust
let auto = CheckMenuItem::with_id(app, "auto", "开机启动", true, is_on, None::<&str>)?;
let menu = Menu::with_items(app, &[&auto, &MenuItem::with_id(app, "open", "打开", true, None::<&str>)?,
    &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?])?;
TrayIconBuilder::with_id("tray").icon(app.default_window_icon().unwrap().clone()).menu(&menu)
    .show_menu_on_left_click(false).on_menu_event(|app, e| match e.id.as_ref() { "open" => { let _ = crate::open(app); },
        "auto" => { let _ = crate::auto(app); }, "quit" => app.exit(0), _ => {} })
    .on_tray_icon_event(|t, e| if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = e {
        let _ = crate::open(t.app_handle()); }).build(app)?;
```
- `tauri` 需启用 `tray-icon` feature；`show_menu_on_left_click` 与 `DoubleClick`（仅 Windows）见[系统托盘文档](https://v2.tauri.app/learn/system-tray/)和 [`TrayIconBuilder`](https://docs.rs/tauri/2.12.5/tauri/tray/struct.TrayIconBuilder.html)。`build` 的返回值不必长期持有，Tauri 资源表会保留托盘；只有动态换图标时才保存句柄。
- 勾选菜单不要依赖系统自动翻转；点击后重新读取 `autolaunch().is_enabled()`，再 `set_checked()` 同步 UI。单实例插件必须在所有其他插件之前注册；Windows 用命名互斥体和 `WM_COPYDATA`，第二个实例转交参数后退出，见[单实例插件](https://v2.tauri.app/plugin/single-instance/)。便携版即使在不同目录，只要 `identifier` 相同也会被判为同一应用。
- 自启使用 `tauri-plugin-autostart`，通过 `current_exe()` 写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（无权限写 HKLM 时回退当前用户），见[自启插件](https://v2.tauri.app/plugin/autostart/)和 [`auto-launch` 源码](https://docs.rs/crate/auto-launch/0.6.0/source/src/windows.rs)。
- 便携版关键缺陷：`auto-launch 0.6.0` 写入的值是 `"{exe_path} {args}"`，路径没有引号。exe 路径含空格时，启动项解析可能失败，**待实测**；稳妥做法是含空格时自行用 `winreg` 写带引号的 `"C:\...\LingoPick.exe" --autostart`，或创建带引号目标的 `.lnk`。自启参数建议带 `--autostart`，直接启动到托盘；移动目录后旧值会失效，设置页应提供“重新启用”并可选清理。
- 免安装不等于完全绿色：Tauri 在 Windows 默认把 WebView2 数据目录设为应用本地数据目录。要真正便携，需用 [`data_directory`](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindowBuilder.html#method.data_directory) 指定 exe 同目录的数据文件夹，并测试只读目录场景。

## 5. 前后端通信与 token 流
- 官方明确指出事件系统不适合低延迟、高吞吐场景，流式数据应使用 `Channel`，见[从 Rust 调用前端](https://v2.tauri.app/develop/calling-frontend/)。`emit` 是全局广播，`emit_to` 才是指定窗口；事件负载是 JSON 字符串。
- 流式命令应保持到流结束再返回，`Channel` 随命令参数传入、命令返回或取消后释放。不要用全局 Channel 跨翻译复用，否则取消后的旧 token 会串到新请求。把网络请求放在 Rust，前端只 `invoke`：API Key 不进入 WebView，CSP 不需要放行外部域名。
```rust
use {futures_util::StreamExt, tauri::ipc::Channel};
#[tauri::command]
async fn translate_stream(prompt: String, on_event: Channel<serde_json::Value>) -> Result<(), String> {
    let resp = reqwest::Client::new().post("http://127.0.0.1:18080/v1/chat/completions")
        .json(&serde_json::json!({"model":"local","stream":true,"messages":[{"role":"user","content":prompt}]}))
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("HTTP {}", resp.status())); }
    let mut body = resp.bytes_stream(); let mut buf = Vec::<u8>::new();
    while let Some(chunk) = body.next().await {
        buf.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?.trim();
            let Some(data) = line.strip_prefix("data:") else { continue };
            if data.trim() == "[DONE]" { on_event.send(serde_json::json!({"type":"done"})).ok(); return Ok(()); }
            if let Some(t) = serde_json::from_str::<serde_json::Value>(data.trim()).ok()
                .and_then(|v| v["choices"][0]["delta"]["content"].as_str().map(str::to_owned)) {
                on_event.send(serde_json::json!({"type":"delta","text":t})).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}
```
前端：`const c = new Channel(); c.onmessage = e => { if (e.type === "delta") out.textContent += e.text; }; await invoke("translate_stream", { prompt, onEvent: c });`；`withGlobalTauri` 时 `invoke`/`Channel` 从 `window.__TAURI__.core` 取，生产也可用 `@tauri-apps/api` 的 import。
- 解析 SSE 必须按字节累积、按换行切分后再做 UTF-8 解码。直接对每个网络分片做 `String::from_utf8_lossy` 会把被截断的中文多字节字符替换成乱码；上面的写法避免了这个问题。
- 事件监听要保存 `unlisten` 并在关闭时调用，不要每次显示弹窗都 `listen` 一次；`const unlisten = await listen(...); window.addEventListener("beforeunload", () => unlisten(), { once: true });`。事件文档见[事件系统](https://v2.tauri.app/develop/calling-rust/#event-system)。无框架页面可用 `withGlobalTauri`，也可保留 Vite 仅作打包器并 `import { invoke, Channel } from "@tauri-apps/api/core"`；后者对 CSP 更友好。弹窗隐藏时继续接收流可以，但 DOM 写入应合并，避免重新显示时瞬间刷出大段内容。

## 6. WebView2 能力与安全边界
- `window.speechSynthesis` 在 WebView2 中存在，但 `getVoices()` 通常只返回系统 SAPI 桌面语音，拿不到 Edge 的 Natural/Online 语音；WebView2 反馈中 Win32 宿主只有 3 个中文语音，UWP 宿主甚至为 0，见[WebView2 #2660](https://github.com/MicrosoftEdge/WebView2Feedback/issues/2660)、[#3091](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3091)、[#3155](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3155)。可用语音列表和音质**待实测**。
- 语音列表异步填充，首次调用可能为空；应监听 `voiceschanged` 并做超时兜底。不要在无用户手势的弹窗显示阶段自动朗读，Chromium 自动播放策略可能拦截。音质要求高时改用 Windows SAPI 或在线 TTS，不要赌 WebView2 的在线语音。
- `navigator.clipboard.writeText` 依赖安全上下文、文档焦点和用户手势；小窗以 `focused(false)` 弹出时自动复制很可能失败。Tauri 剪贴板插件走系统剪贴板，不依赖 WebView 焦点，见[剪贴板插件](https://v2.tauri.app/plugin/clipboard/)。权限加 `clipboard-manager:allow-write-text`，读取加 `allow-read-text`；Rust 侧 `read_text` 不应放在主线程。
- CSP 在 `app.security.csp` 配置，Tauri 会在编译期给本地脚本/样式追加 nonce 或 hash。示例：`"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ipc: http://ipc.localhost"`；`http://ipc.localhost` 是 Windows 上 Tauri IPC 需要的源，见[CSP 文档](https://v2.tauri.app/security/csp/)。不要把 `connect-src` 放成 `https:` 通配，也不要让前端直连用户自定义 API 地址，否则 CSP 形同虚设，API Key 也会暴露。
- 禁止外部导航要同时做两件事：`on_navigation` 只允许 `tauri://localhost`、`http://tauri.localhost`（Windows 生产）和开发期 `localhost`；`on_new_window` 返回 `NewWindowResponse::Deny` 阻止 `window.open`。CSP 不能替代导航白名单，API 见[`on_navigation`](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindowBuilder.html#method.on_navigation) 与 [`on_new_window`](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindowBuilder.html#method.on_new_window)。需要打开帮助链接时用 `tauri-plugin-opener` 并限制 URL scope，不要放开 WebView 自身导航。

## 7. 启动 llama-server 与下载引擎
```rust
#[cfg(windows)] use std::os::windows::process::CommandExt;
#[cfg(windows)] const CREATE_NO_WINDOW: u32 = 0x0800_0000;
let mut child = std::process::Command::new(&server).arg("-m").arg(&model)
    .args(["--host", "127.0.0.1", "--port", "18080", "-c", "4096"])
    .creation_flags(CREATE_NO_WINDOW).spawn()?;
```
- `CREATE_NO_WINDOW` 用于不弹控制台窗口，微软定义见[Process Creation Flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)。llama.cpp 的 `llama-server.exe` 依赖同目录 DLL，下载 zip 后必须整目录解压，不能只复制单个 exe。
- 启动后轮询 `GET /health`：加载中返回 503，就绪返回 200 `{"status":"ok"}`，见[llama.cpp server 文档](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)。轮询要有单次请求超时和 30–60 秒总超时；OpenAI 兼容路径是 `/v1/chat/completions`。
- 必须把子进程放进 Windows Job Object 并设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，否则应用崩溃或被任务管理器结束后 llama-server 可能残留；`Child::kill()` 不能保证清理其子进程，API 见[CreateJobObjectW](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw)。Tauri 2.12.5 使用 `windows 0.62`，应用侧补同版本依赖才能直接使用 `hwnd()` 等类型。
- 下载用 `.part` 临时文件 + `Range: bytes={已下载字节数}-` 续传；只有 206 才追加，200 表示不支持 Range，必须清空重下。取消用 `CancellationToken` 或 `AtomicBool`，每写一个 chunk 检查一次，取消后保留 `.part`。进度用 `Channel<DownloadProgress>` 发送，不要用 `emit` 高频广播。完成后先流式计算 SHA-256，再解压；校验失败删除 `.part`，不要覆盖已安装版本。
- 解压必须用 `entry.enclosed_name()` 防目录穿越，并限制总解压大小防 zip bomb；先解压到版本化临时目录，成功后原子切换：
```rust
let mut archive = zip::ZipArchive::new(std::fs::File::open(&zip_path)?)?;
for i in 0..archive.len() {
    let mut e = archive.by_index(i)?;
    let Some(rel) = e.enclosed_name() else { continue };
    let out = install_dir.join(rel); std::fs::create_dir_all(out.parent().unwrap_or(&install_dir))?;
    std::io::copy(&mut e, &mut std::fs::File::create(out)?)?;
}
```
- 下载源以官方 [GitHub Releases](https://github.com/ggml-org/llama.cpp/releases) 为主，固定 tag、资产名和 SHA-256，不追 `latest`；发布清单写死 URL、哈希和版本。国内加速优先自建对象存储/CDN（Cloudflare R2、阿里云 OSS 等），第三方 GitHub 代理的可用性、隐私与 Range 支持都**待实测**，不能作为唯一源。模型可从 Hugging Face / ModelScope 获取，注意许可证且不要内置进安装包。
- 更新采用“双目录 + 指针”：新版本完整下载校验后再切换，失败保留旧版本。llama.cpp 资产名和发布结构可能变化，解析 GitHub API 时按 `win`、`x64`、`avx2`/`cpu` 等特征筛选并做兜底，不要硬编码单一文件名。

## 8. 打包、免安装与 CI
- Windows 官方产物是 MSI（WiX）和 NSIS `-setup.exe`；MSI 需要 VBSCRIPT 可选功能，NSIS 更适合普通分发，见[Windows Installer](https://v2.tauri.app/distribute/windows-installer/)。
- 免安装 zip：`npm run tauri build -- --no-bundle`，取 `src-tauri/target/release/<Cargo bin 名>.exe` 再压缩。无 `bundle.resources` 时单 exe 即可运行，因为前端资源已嵌入；`--no-bundle` 只跳过打包步骤，见[CLI build 选项](https://v2.tauri.app/reference/cli/#build)。
- `bundle.resources` 不会因 `--no-bundle` 自动复制到 exe 旁。Windows 的 `resource_dir()` 解析为 exe 所在目录，见[`resource_dir`](https://docs.rs/tauri/2.12.5/tauri/path/struct.PathResolver.html#method.resource_dir)；zip 脚本必须显式复制资源，或改用 `include_bytes!`/`rust-embed` 编进二进制。读取方式见[嵌入附加文件](https://v2.tauri.app/develop/resources/)。
- WebView2 是系统依赖，不随 exe 分发。Windows 10 2018 年 4 月后和 Windows 11 通常自带；更老或精简系统需要 Evergreen Runtime。安装包可用 `downloadBootstrapper`、`embedBootstrapper`、`offlineInstaller`、`fixedRuntime` 或 `skip`，体积见[WebView2 安装选项](https://v2.tauri.app/distribute/windows-installer/#webview2-installation-options)。便携 zip 不能自动安装，启动失败时应提示并给出微软下载地址。
- 体积没有官方“空项目 exe 数字”，Tauri 只给优化建议，见[App Size](https://v2.tauri.app/concept/size/)。本次未构建，**空项目 release exe 大小待实测**；经验上约 5–10MB，不要按 Electron 的 200MB 级体积估算，实际以 `Get-Item .\src-tauri\target\release\LingoPick.exe | Select Length` 记录并在 CI 保存。优化可用 `lto = true`、`codegen-units = 1`、`opt-level = "s"`、`strip = true`、`panic = "abort"`，并开启 `build.removeUnusedCommands`。
- GitHub Actions 用 `Swatinem/rust-cache@v2` 缓存 `~/.cargo` 与 `src-tauri/target`，`workspaces: './src-tauri -> target'`，`cache-on-failure: true`；官方工作流见[GitHub 流水线](https://v2.tauri.app/distribute/pipelines/github/)。只做 zip 时把最后一步换成 `npm run tauri build -- --no-bundle` 加 `actions/upload-artifact`；未签名便携 exe 会触发 SmartScreen，正式分发应做代码签名。
```yaml
- uses: actions/checkout@v7
- uses: actions/setup-node@v6
  with: { node-version: lts/*, cache: npm }
- uses: dtolnay/rust-toolchain@stable
- uses: swatinem/rust-cache@v2
  with: { workspaces: './src-tauri -> target', cache-on-failure: true }
- run: npm ci
- uses: tauri-apps/tauri-action@v1
```

## 9. 已知风险清单（按严重度）

| 严重度 | 风险 | 处置 |
|---|---|---|
| 高 | 透明窗偶发全黑/透明区变黑，长时间运行、显示器变化或切换 cursor events 后出现；[#15947](https://github.com/tauri-apps/tauri/issues/15947)、[#16341](https://github.com/tauri-apps/tauri/issues/16341) | 不做高频 cursor events 切换；监听显示器变化；出现黑块时隐藏/显示或重建窗口；只能缓解 |
| 高 | 小窗无法可靠抢到前台，`set_focus()` 受 Windows 前台锁影响；[#8361](https://github.com/tauri-apps/tauri/issues/8361) | 弹出时 `focused(false)`，不强行抢焦点；需要输入时让用户点击；不依赖 `Focused` 事件关闭 |
| 高 | 提权应用中的选区/输入无法被普通权限进程读取或模拟（UIPI） | 检测前台进程是否提权并提示；不要为取词默认要求管理员权限 |
| 高 | 便携版自启值路径未加引号，含空格路径可能启动失败；[auto-launch 源码](https://docs.rs/crate/auto-launch/0.6.0/source/src/windows.rs) | 含空格时自行写带引号的 Run 值或启动快捷方式；或限制安装路径 |
| 中 | 透明窗创建/`show()` 白闪；[#14515](https://github.com/tauri-apps/tauri/issues/14515)、[#15490](https://github.com/tauri-apps/tauri/issues/15490) | 预创建隐藏窗口；试 `no_redirection_bitmap(true)`；不要每次重建窗口 |
| 中 | 多显示器/DPI 位置偏移；[#14559](https://github.com/tauri-apps/tauri/issues/14559)、[#10263](https://github.com/tauri-apps/tauri/issues/10263) | 全物理坐标；手动选屏；按目标屏缩放比换算；跨屏后重新校正 |
| 中 | 置顶窗仍可能被任务栏、独占全屏游戏、UAC 安全桌面盖住；[#9987](https://github.com/tauri-apps/tauri/issues/9987) | clamp 到工作区；不要承诺覆盖全屏游戏；提示用户切换窗口模式 |
| 中 | 快速 resize 时菜单裁剪、残影或闪烁；[#13270](https://github.com/tauri-apps/tauri/issues/13270) | 流式输出不要逐 token resize；固定宽高/滚动；隐藏后 resize，等 `Resized` 再显示 |
| 中 | 全局快捷键被占用或游戏不响应；[#14770](https://github.com/tauri-apps/tauri/issues/14770) | 注册失败提示并保留旧键；提供备用快捷键 |
| 中 | 目标机器缺少 WebView2 Runtime，便携 exe 无法启动 | 启动时捕获错误并提示安装 Evergreen Runtime；zip 可附 bootstrapper |
| 低 | 托盘单击恢复窗口时可能落在其他窗口后面；[#14795](https://github.com/tauri-apps/tauri/issues/14795) | 双击打开设置，打开后 `show()` + `set_focus()`，接受平台差异 |

## 10. 版本与依赖建议

| 组件 | 建议版本 |
|---|---|
| `tauri` / `tauri-build` | `2.12.5` / `2.7.4`（Rust ≥1.90；启用 `tray-icon`） |
| `@tauri-apps/cli` / `@tauri-apps/api` | `2.12.4` / `2.12.4` |
| 插件：global-shortcut / single-instance / autostart / clipboard | `2.4.1` / `2.5.4` / `2.7.0` / `2.5.0` |
| `windows` | `0.62`（与 Tauri 的 `HWND` 一致；按需启用 JobObjects、Threading、Foundation） |
- 版本号来自 [crates.io tauri](https://crates.io/crates/tauri)、[npm @tauri-apps/cli](https://www.npmjs.com/package/@tauri-apps/cli) 与各插件 crates.io 页面；提交 `Cargo.lock` 和 `package-lock.json`，避免 CI 与本地拿到不同补丁版本。`tauri` 用 `"2.12.5"` 精确锁定，插件以 lockfile 为准；`@tauri-apps/cli 2.12.4` 与 `tauri 2.12.5` 补丁号不同，若 `tauri build` 报版本不匹配，优先统一版本，不要盲目加 `--ignore-version-mismatches`。透明窗口本身不需要 `windows` 依赖，也不需要 `macos-private-api`；只有调用 Job Object、`HWND` 等 Win32 API 时才加 `windows`。

## 11. 必须实机验证的条目
- [ ] Win10/Win11 + WebView2 144.x：透明窗首次显示、重复 `show()`、长时间运行、切换显示器后的黑底/白闪/残影；`no_redirection_bitmap(true)` 是否改善且无副作用。
- [ ] 100%/150%/200% 双屏（含左侧负坐标）：UIA 矩形、鼠标钩子坐标、`place` 的落点与 clamp 是否一致；跨屏后窗口尺寸是否被系统二次调整。
- [ ] `set_size` 后等待 `Resized` 的 200–300ms 是否足够；快速连续弹出是否仍裁剪菜单。
- [ ] `speechSynthesis.getVoices()` 实际返回哪些中文语音、`voiceschanged` 触发时机，以及无用户手势时是否允许朗读。
- [ ] 便携版放在含空格/中文路径下，自启 Run 值能否启动、移动目录后的旧值行为，以及无 WebView2 Runtime 的干净 Win10 上的失败提示。
- [ ] 空项目 release exe、本项目 release exe、NSIS 安装包与 zip 的实际体积；国内 GitHub 代理/对象存储对大文件 Range 是否返回 206，断点续传和 SHA-256 校验是否完整。
