# R2 基线（P0）

- 采集时间：2026-11-14 12:37（Asia/Hong_Kong）
- 采集时 HEAD：`7e9b7e8`（`build(tauri): point frontendDist at the vite build output`）。本文档由紧接着的下一个提交（`docs(r2): record p0 bundle and cold start baseline`）引入，采集后 HEAD 会再前进一格，所以这里的 `7e9b7e8` 只是**采集时刻**的 HEAD，不是本文档所在的提交。
- 构建命令：npx tauri build --no-bundle（release profile；`beforeBuildCommand` = `npm run build:web` → import 白名单 → `tsc --noEmit` → `vite build`，全部通过）
- 产物：`src-tauri\target\release\lexora.exe`（0.4.3），SHA-256 A5E8F9A2CDC62587C485A7A2E669FF1428492AC210F9CBE2E1953887727CEAC5（**仅本机本次构建的观测值**，不具可复现性，见"产物可复现性"）

## 体积

| 指标 | 数值 |
| --- | --- |
| release exe | 12,526,080 B（11.95 MiB） |
| 对比 0.4.2 release exe | 12,773,888 B → 变化 -247,808 B（-1.94%） |
| `frontend/dist` 合计 | 16 个文件 / 167,175 B（163.3 KiB；7 个 HTML + 9 个 assets） |
| 其中 `frontend/dist/assets` | 9 个文件 / 163,592 B |

对比口径：12,773,888 B 是**迁移前既有的 0.4.2 便携版构建产物**的 exe 长度（在该产物上直接实测），**不是**用本次同一套 `npx tauri build --no-bundle` 流程重建出来的结果。两侧构建方式/工具链并不完全相同，因此该差额只作数量级参考，不作为严格同口径的回归结论。

体积采集命令（可直接复跑）：

```powershell
$exe = 'src-tauri\target\release\lexora.exe'
(Get-Item $exe).Length                                                          # 12,526,080
(Get-ChildItem frontend\dist -Recurse -File | Measure-Object Length -Sum)       # Count=16  Sum=167,175
(Get-ChildItem frontend\dist\assets -Recurse -File | Measure-Object Length -Sum) # Count=9   Sum=163,592
Get-FileHash $exe -Algorithm SHA256                                             # 仅本机本次构建观测值
```

Vite 产物中最大的两项：`assets/globals-*.js` 140.45 kB（gzip 45.59 kB）、`assets/globals-*.css` 21.12 kB（gzip 4.57 kB）；共 33 modules transformed，无 rare-ui 相关 chunk。

### 产物可复现性：SHA-256 不可作一致性判据

两次官方配置的 release 构建之间夹了一次临时 identifier 构建（见"冷启动测量环境说明"），但正式配置的两次构建产物**字节长度完全相同（12,526,080 B）而 SHA-256 不同**（`A664C16F…` → `A5E8F9A2…`，推测来自链接期元数据 / 构建路径差异），即 release 产物**不是字节可复现**的；该结论不受中间那次临时构建影响（它只改 `identifier`，产物字节数同为 12,526,080 B）。由此：

- 本文记录的 SHA-256 只是"本机本次构建的观测值"，不是可复现的构建指纹；
- **P6 不得把 SHA-256 相等当作一致性判据**（SHA-256 不可作一致性判据）；要判断构建一致性，请改比 exe 字节大小（应仍在 12,526,080 B 量级）与同方法下的冷启动数值。

## 冷启动（到设置页 DOM 挂载完成，非"可交互"）

口径：本节终点是**设置页 DOM 挂载完成**——设置页 target 的 `#root` 已有子节点且 `document.readyState === "complete"`。它**不等于 first paint**（首帧绘制可能在其后一个轮询周期内才发生），**更不等于 interactive**（用户可点击）。所以 486 ms 只能读作"DOM 挂载完成"，不要当作"设置页可交互时间"引用。

CDP 量化实测，n=3：**中位数 486 ms**（min 482 ms / max 498 ms，均指到上述 DOM 挂载条件）。

| # | CDP 端口开始监听 | webview target 出现 | 设置页 DOM 挂载完成 |
| --- | --- | --- | --- |
| 1 | 329 ms | 379 ms | 486 ms |
| 2 | 326 ms | 372 ms | 482 ms |
| 3 | 310 ms | 405 ms | 498 ms |

### 测量方法（可复现）

启动与隔离，缺一不可：

1. **9333 必须先空闲**：开跑前 `Get-NetTCPConnection -LocalPort 9333 -State Listen` 必须无监听（测量脚本每次启动前断言，端口被占则该次作废）。
2. CDP 端口由环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` 打开，端口写死 9333。
3. 数据隔离：`LEXORA_DATA_DIR=%TEMP%\lexora-r2-baseline`。脚本只对该目录做 `New-Item -Force`，**从不清理**，而应用每次运行都会往里写 settings / 日志，所以只有 run 1 是真正"无本地数据"的目录，run 2..N 会被前次运行写脏、不是真正的首次启动路径。该目录内始终无模型、无历史，对数值的影响可忽略，但不能把它当作"保证首次启动"的前提。
4. **exe 必须带 `--show` 启动**：`src-tauri/src/main.rs` 的 `wants_settings_window()` 只识别 `--show`。`tauri.conf.json` 声明了 4 个窗口且都没有 `create: false`（tauri-utils 默认 `create: true`），tauri 启动时会按配置创建这些窗口；`visible: false` 只影响显示与否，不影响窗口被创建。默认运行状态下 `settings` 窗口隐藏，带 `--show` 才显示它，这正是本次测量的条件。反向也成立：不带 `--show` 的隐藏窗口仍可能以 CDP target 出现（Task 4 的 dev 运行为 `force_show=false`，CDP 仍列出了设置页 `http://localhost:5174/` 以及 picker / toolbar / quicktranslate），所以不能靠"没有 target"来判断窗口是否存在；`--show` 的作用是固定测量条件、保证可复现。

停表判据（三条同时满足，且只认设置页那个 target）：

1. target 的 URL 是 `http://tauri.localhost/`——即 `index.html`，设置页入口；
2. `document.readyState === "complete"`；
3. `document.querySelector('#root').children.length >= 1`。

第 1 条不能退化成"任意页面 title 是 `Lexora`"：`picker` / `picker-toolbar` 窗口加载的 `picker.html` 与设置页共用同一个 `title=Lexora`，只按 title 判可能停在更早渲染的轻量 picker 页上，报出偏小的假数字。

采样与计时：

- 采样间隔：TCP 探测 25 ms；`GET http://127.0.0.1:9333/json/list` 40 ms（请求超时 400 ms）；`Runtime.evaluate` 40 ms
- 计时起点：`Process.Start` 之前（`Stopwatch` 紧邻进程创建），终点为轮询到满足上述条件的时间戳；数值包含进程启动 + WebView2 创建 + 页面加载 + DOM 挂载，粒度约 40 ms

### 冷启动测量环境说明

- 用户桌面上有一个正在运行的便携版 0.4.2（进程名 `Lexora-0.4.2-win-x64`），它持有 `tauri-plugin-single-instance` 的互斥体 `io.github.monk233.lexora-sim`；同一 identifier 的新构建启动后会立刻把参数转发给它并 `exit 0`，因此无法直接测冷启动。
- **正式配置的 exe 从未被实际运行**：它一启动就会把 `--show` 转发给用户实例并退出，本进程测不到任何阶段。为不打断用户实例，冷启动全部在**临时 identifier 覆盖**构建上测量（`%TEMP%\lexora-t5-identifier.json`，仅把 `identifier` 改为 `io.github.monk233.lexora.t5measure`，Rust 代码与前端产物同提交版一致）。测量完成后用正式配置重建 `target\release\lexora.exe`，并只做字节层面核对：正式 identifier `io.github.monk233.lexora` 出现 **1** 次、临时 identifier `io.github.monk233.lexora.t5measure` 出现 **0** 次，重建后字节数同为 12,526,080 B。即：体积 / SHA 对应正式 exe，冷启动数字对应临时 identifier 的等价构建。
- 机器状态：约 408 个进程、**单次采样 CPU 13%**（日志 `machine_cpu_load=13%`，只有一个采样点，不代表区间）、空闲物理内存 36,964 MB（约 36 GB）；除用户的 0.4.2 实例外还有 WeType、Clash Verge 等常驻 WebView2 应用，属于"温"启动环境（WebView2 运行时已在内存中），因此冷启动数值偏乐观。

## `@rare-ui/core` 0.1.1 体积说明

`@rare-ui/core@0.1.1` 的 dist 载荷为 **32 个文件 / 8,658,292 B（约 8.26 MiB）**。它不会整体进入产物：

- 构建期 `scripts/check-rare-imports.mjs` 只放行白名单子路径（`@rare-ui/core/styles.css` 等），越界 import 直接构建失败；
- Vite 只打包实际被 import 的模块。当前 `frontend/dist` 合计仅 167,175 B、33 modules、无任何 rare-ui chunk —— 说明现在**没有导入任何 rare-ui 组件**；
- 只有未来被真正 import 的 tree-shaken 子路径才会计入 bundle。P6 若启用 rare-ui 组件，需重新量测 `frontend/dist` 与 exe。

## 用途

P6 验收时以此表为对比基准：体积看 release exe 与 `frontend/dist` 合计（不看 SHA-256 是否相等），性能看同机同方法、同等温启动条件下的 CDP 冷启动中位数（到设置页 DOM 挂载完成，不是"可交互"）。
