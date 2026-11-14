# R2 设计：以 React 构建链重写工具面板（shadcn/ui 为主，Rare UI 为辅）

- 日期：2026-11-14
- 分支：`feature/r2-rare-ui`（基于 `master` f2a118c，代码版本 0.4.3）
- 状态：设计待评审
- 依据：[ROADMAP](../../../ROADMAP.md) R2、[contracts](../../contracts.md)、[building](../../building.md)

## 1. 目标

把当前分散在 `web/` 下的 7 个手写静态页面重写为单一 React 应用：引入 Vite + React + TypeScript + Tailwind 构建链，以 shadcn/ui 作为基础组件体系、Rare UI 仅在缺少对应组件时按 subpath 补充，建立统一的 token 与组件层，重做设置页、划词工具栏、结果面板、截图 overlay、长截图、钉图与快捷翻译窗口的视觉与交互。

验收以 [ROADMAP](../../../ROADMAP.md) R2 为准，补充项见 §9。

## 2. 现状（探测事实）

| 项 | 事实 |
| --- | --- |
| 前端形态 | 7 个 HTML 入口、8 个窗口 label，零构建，`web/` 直接作为 Tauri `frontendDist` |
| 代码量 | JS 约 25,300 行（含 `web/shared/`）；CSS 约 6,000 行；HTML 7 个 |
| 最大文件 | `web/settings.js` 4,894 行、`web/capture.js` 4,171 行、`web/picker.js` 3,359 行、`web/capture-annotate.js` 2,122 行 |
| token 现状 | 6 个 CSS 文件各自定义 `--surface/--border/--text/--primary` 等变量，值不一致（`#e2e8f0` 与 `#e5e7eb`、radius 7/9/10/12），深色规则也各自重复 |
| IPC 面 | `web/shared/tauri-api.js` 封装约 90 个 `invoke` 命令与事件订阅，暴露 `pickerAPI` / `quickAPI` 等服务对象 |
| 事件契约 | [contracts](../../contracts.md) §5.3、§10、§11 等已定义 `translate-event`、`picker-data`、`picker-image`、`capture-armed`、`longshot-progress`、`pin-close`、`quick-locale` 等 |
| 前端测试 | 11 个 `.test.cjs`（`web/` 与 `web/shared/`，约 3,700 行），依赖 `vm` 执行源码或正则抽取函数体，React 化后全部失效，需等价迁移 |
| 现有 CSS 变量 | 已有可复用的色板与语义变量，R2 只做归一，不从零设计 |
| CSP | `script-src 'self'`，无 `unsafe-inline`；每个 HTML 另有 `<meta>` CSP |
| Tauri 全局 | `withGlobalTauri: true`，前端使用 `window.__TAURI__` |

### 2.1 窗口与入口映射

| 窗口 label | 入口 | 创建方 |
| --- | --- | --- |
| `settings` | `index.html` | `src-tauri/tauri.conf.json` |
| `picker` | `picker.html` | `tauri.conf.json` |
| `picker-toolbar` | `picker.html?surface=toolbar` | `tauri.conf.json` |
| `quicktranslate` | `quicktranslate.html` | `tauri.conf.json` |
| `capture` | `capture.html?monitor=&lang=` | `src-tauri/src/windows.rs` |
| `longshot` | `longshot.html?lang=` | `src-tauri/src/longshot.rs` |
| `longshot-bar` | `longshot-bar.html?lang=` | `src-tauri/src/longshot.rs` |
| `pin` | `pin.html?id=&lang=` | `src-tauri/src/pin.rs` |

**约束：文件名与 query 参数保持不变**，Rust 侧零改动。

## 3. 决策记录

| 决策 | 结论 | 理由 |
| --- | --- | --- |
| 是否引入构建链 | 引入 Vite + React + TypeScript + Tailwind | R2 要求统一组件层与设计 token；手写 DOM 维护成本已过高 |
| 组件体系 | **shadcn/ui 为主，Rare UI 按 subpath 补缺** | shadcn 源码可控、按需引入；Rare UI 0.1.1 处于早期且 7 个月未更新，仅用于其独有复合组件 |
| Rare UI 引入方式 | npm 精确锁定 `0.1.1`，不 vendor 源码 | 按维护者要求以依赖方式锁定；MIT 许可下后续可转为 vendor |
| React 版本 | 18.3.x | 两个组件体系的 peer 均为 `>=18`；18.3 与 Radix / Tailwind 3 生态最稳定 |
| Tailwind | 3.4.x | Rare UI 预设基于 Tailwind 3 |
| 全量 vs 渐进 | 全量重写（一次性 React 化） | 避免长期双套实现；但仍按 §8 分阶段提交与验证 |
| Rust 入口 | 文件名与 query 不变 | 避免改 Rust 窗口创建代码 |
| CSP | 移除各 HTML 的 `<meta>` CSP，生产 CSP 由 `tauri.conf.json` 注入，开发走 `devUrl` | `vite dev` 的 HMR 内联脚本与原 CSP 冲突 |
| 测试 | 旧 `.test.cjs` 等价迁移到 Vitest + Testing Library | 现有测试依赖源码文本抽取，React 后不可沿用 |

## 4. 架构与目录

```
frontend/                      # 新建 Vite root；迁移完成后删除 web/
  index.html                   # settings
  picker.html                  # picker / picker-toolbar
  capture.html
  longshot.html
  longshot-bar.html
  pin.html
  quicktranslate.html
  vite.config.ts
  tsconfig.json
  tailwind.config.ts
  components.json              # shadcn CLI 配置
  src/
    entries/                   # 每个入口的 bootstrap（挂载 React 根）
    windows/                   # 各窗口根组件
    components/ui/             # shadcn 生成并受控的组件（唯一基础组件来源）
    components/rare/           # Rare UI 组件的包装与 token 映射
    components/                # 业务组件（结果面板、工具栏、标注面板等）
    hooks/                     # useTauriEvent / useSettingsForm / useStream 等
    lib/                       # tauri-api.ts、markdown.ts、i18n.tsx、stream-guard.ts、constants.ts
    styles/                    # tokens.css、globals.css、窗口级样式
  dist/                        # 构建产物（gitignore）
```

Tauri 配置变化：

- `build.frontendDist`: `"../web"` → `"../frontend/dist"`
- 新增 `build.beforeDevCommand`（`npm run dev:web`）、`build.beforeBuildCommand`（`npm run build:web`）、`build.devUrl`（`http://localhost:5173`）
- 保留 `withGlobalTauri: true`

### 4.1 依赖版本

| 依赖 | 版本策略 |
| --- | --- |
| react / react-dom | 18.3.x |
| typescript | 5.x |
| vite | 最新稳定，`package-lock.json` 锁定 |
| tailwindcss | 3.4.x |
| @rare-ui/core | 精确 `0.1.1` |
| lucide-react | 精确锁定，两个组件体系共用 |
| shadcn CLI（开发期） | 最新，仅用于生成源码，不进运行时依赖 |
| class-variance-authority / clsx / tailwind-merge / tailwindcss-animate | 最新稳定 |
| vitest / @testing-library/react / jsdom | 最新稳定 |
| @tauri-apps/cli | 保持 2.12.4 |

## 5. 数据流与状态层

```
组件（声明式）
  → hooks
  → lib/tauri-api.ts（保留现有 ~90 个命令封装与事件订阅，仅补类型）
  → Tauri IPC / event
  → Rust（settings.json 为唯一真源）
```

- 禁止组件内直接 `invoke`；全部经服务层。
- 不引入 Redux / Zustand：窗口内状态用 `useReducer` / `useState` + Context；跨窗口状态由 Rust 持有。
- 自动保存沿用现有语义：本地 draft → 500ms debounce（blur/Enter 立即 flush）→ `update_settings` → save-status 状态机（idle/saving/saved/error）。

### 5.1 逐窗口状态形态

| 窗口 | 现实现 | React 方案 |
| --- | --- | --- |
| picker / toolbar | 3,359 行命令式 DOM | 单个 `useReducer` 状态机：`idle → toolbar → panel → streaming → pinned` |
| settings | 4,894 行命令式 + 自动保存 | 表单 draft + `useSettingsForm`，Rare UI / shadcn 受控组件 |
| quicktranslate | 1,865 行 | `useStream` + `useReducer` + 历史列表 |
| capture / annotate | 4,171 + 2,122 行 canvas | canvas 编辑逻辑保留为 `lib/annotation-editor.ts`，React 只渲染工具栏/面板/提示层，经 ref 命令接口驱动 |
| longshot / bar / pin | 1,000+ 行 | 事件驱动 UI，窗口尺寸仍由 Rust 决定 |

### 5.2 流式输出

`useStream(requestId)` 统一处理 `chunk / target / error / done`；跨 chunk 重复检测抽为纯函数 `lib/stream-guard.ts`，现有 `picker-repetition` 测试等价迁移。

### 5.3 窗口间事件

`useTauriEvent(name, handler, { target })` 强制指定 target；沿用 [contracts](../../contracts.md) §10.1 结论：capture overlay 监听必须固定到自身 label，禁止 `Any`。

## 6. 样式与 token

- **唯一 token 源**：`frontend/src/styles/tokens.css`，采用 shadcn 变量约定（`--background`、`--foreground`、`--card`、`--popover`、`--primary`、`--secondary`、`--muted`、`--accent`、`--destructive`、`--border`、`--input`、`--ring`），映射现有 Lexora 色值（主色 `#4f46e5`、浅色背景 `#f6f7f9`、深色背景 `#0f1115` 等）。
- 深色模式统一 `html.dark` class（两个组件体系一致），由设置驱动，不再依赖 `prefers-color-scheme`。
- Rare UI 组件放在 `components/rare/` 包装内做变量映射，不引入第二套全局 token。
- Tailwind preflight 会重置样式：逐窗口验证透明背景（picker / pin / quicktranslate / capture）不被破坏。
- 中文/英文文案长度差异需要重新校验溢出与截断（R1 已提出，R2 一并处理）。

### 6.1 组件分工

**Rare UI 0.1.1 的实际入口限制（已核实 `package.json#exports`）**：只暴露 `.`、`./styles.css`、`./charts`、`./video`、`./datepicker`、`./carousel` 六个入口；**基础组件（Button、Switch、Select、Dialog 等）只能从根入口引入**，会连带整个包与全部 Radix 依赖。因此“禁止根入口引入”这条规则等价于“Rare UI 不用于基础组件”。

| 类别 | 采用 |
| --- | --- |
| Button、Input、Select、Switch、Checkbox、Radio、Tabs、Tooltip、Dialog、Popover、DropdownMenu、ScrollArea、Slider、Progress、Toast、Label、Separator、Avatar | shadcn（源码入库） |
| charts、carousel、datepicker、video | Rare UI 按 subpath，**仅当确实需要时**引入（当前功能清单尚未出现这四类需求） |
| 图标 | `lucide-react` |
| 动效 | Rare UI 自带 `motion`；shadcn 侧用 Tailwind 动画类 |

补充说明：按现有功能清单（设置页、划词面板、截图标注、长截图、钉图、快捷翻译），**当前没有图表/轮播/日期选择/视频需求**，Rare UI 在本项目中的实际使用面可能为零。保留其依赖与锁定是按既定决策，但不得为了“用上 Rare UI”而把基础组件从根入口引入。禁止同一功能同时存在两套实现。

## 7. CSP 与开发模式

- 生产：bundle 为外链 JS，`tauri.conf.json` 的严格 CSP 继续生效。
- 开发：移除各 HTML 的 `<meta>` CSP；`tauri dev` 走 `devUrl`，HMR 正常。
- 保留 `withGlobalTauri: true`，`tauri-api` 继续使用 `window.__TAURI__`。

## 8. 实施阶段

| 阶段 | 内容 | 交付物 |
| --- | --- | --- |
| P0 骨架 | 建 `frontend/`；Vite + React + TS + Tailwind 3.4 + shadcn init + Rare UI 锁定；7 个空壳入口；npm scripts；`tauri.conf.json` 切换；CI 更新；Rare UI / shadcn 冒烟组件 | 可打包的空壳应用；产物与 exe 体积、冷启动基线 |
| P1 共享层 | `tauri-api.ts`、`i18n` Provider、`markdown`、`stream-guard`、hooks、`tokens.css` | 服务层与纯逻辑测试全绿 |
| P2 settings | 全部设置项对等；自动保存状态机；表单/Toast | settings 可替代旧页 |
| P3 picker + toolbar | 状态机重写；非激活浮层、拖拽、尺寸自适应、流式、停止/重试 | 划词主链路可用 |
| P4 quicktranslate + pin | 流式翻译、历史、钉图缩放/拖拽 | 0.4.2 功能对等 |
| P5 capture + annotate + longshot + bar | canvas 逻辑保留，外壳 React 化；长截图事件驱动 | 截图链路可用 |
| P6 收尾 | 删除 `web/`；清理 meta CSP；i18n 无残留；体积/DPI 验收；文档更新；CI 全绿 | 可合并状态 |

P2 与 P5 相对独立，可在 P1 完成后并行；工具链与共享层是硬前置。

## 9. 验收

ROADMAP R2 原文：

1. 所有窗口统一同一套 token 与组件，深浅色主题一致。
2. 150% DPI 下无模糊与错位。
3. 工具栏与面板交互不回退：拖拽排序、调整大小、钉住、追问、快捷键、停止/重试/朗读/复制。
4. 包体预算：单文件 exe 增幅 ≤ 2 MB（P0 实测基线，P6 卡线）。

补充：

5. 逐窗口功能对等清单核对通过。
6. 透明窗口、非激活浮层、置顶、`Esc` 关闭、窗口间事件行为不变。
7. i18n：zh/en 切换即时生效，界面无残留硬编码中文；AI 输出语言规则沿用 R1 契约。
8. 离线可用、无 CDN、生产 CSP 保持 `script-src 'self'`。
9. 测试：Vitest 全绿；`cargo test` 全绿；CI 与 Release 流程可通过。
10. 冷启动与打包时间不回退（以 P0 基线对比）。

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| Rare UI 0.1.1 集成问题（API 缺失、样式冲突） | P0 先用冒烟组件验证；出问题退化为 shadcn 自建，不阻塞主线 |
| 包体超出 2 MB 预算 | 只允许 subpath 引入；P0 建立 bundle 体积基线并在 CI 加门禁 |
| 透明窗 / 非激活浮层被 preflight 破坏 | 每窗口迁移后立即 CDP 截图冒烟，不集中到最后 |
| 命令式逻辑中的隐式状态丢失 | 逐窗口行为验收清单（拖拽、尺寸自适应、picker 非激活） |
| 复杂逻辑重写引入回归 | 重复检测等抽纯函数并等价迁移现有测试 |
| Radix 版本冲突 | `npm ls` 校验单一版本，必要时 `overrides` |
| 阶段周期内 `master` 前进 | 定期 `merge origin/master`；新旧前端物理隔离，冲突面限于 `tauri.conf.json`、`package.json`、CI 与文档 |

## 11. 非目标

- 不改 Rust 业务逻辑与命令契约（仅窗口 URL 保持不变）。
- 不改设置 schema（仍为 11）。
- 不引入云服务、遥测、CDN。
- 不做 R3 历史记录、R4 聊天、R5 浏览器扩展。
- 不在本设计内确定发布版本号（R2 完成后另行决定，建议 SemVer 0.5.0）。

## 12. 文档与配置需要同步更新

- `docs/building.md`：构建命令、产物路径、依赖说明、CI 步骤。
- `docs/contracts.md`：前端结构、入口映射、测试策略变化。
- `docs/architecture.md`：前端架构章节。
- `README.md`：开发与构建说明。
- `ROADMAP.md`：R2 状态与实施范围。
- `CHANGELOG.md`：`[Unreleased]` 增加 R2 条目。
- `.github/workflows/ci.yml`、`release.yml`：增加前端构建与测试步骤。
