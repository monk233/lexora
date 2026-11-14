# R2 P0+P1 前端构建链与共享层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Lexora 建立 React + TypeScript + Tailwind 构建链（`frontend/`，7 个入口），并迁移共享层（i18n、markdown、tauri-api、事件 hook、流式 guard），使 7 个窗口可加载空壳 React 页面、构建链与打包链路可用、共享层测试全绿。

**Architecture:** 新建 `frontend/` 作为 Vite root（多页 7 入口），产物输出 `frontend/dist` 并成为 Tauri `frontendDist`；基础组件来自 shadcn 源码（`components/ui`），Rare UI 仅在需要时按 subpath 引入；共享层由现有 `web/shared/*` 机械迁移为 ESM + 类型声明，业务逻辑（重复检测、markdown）以纯函数形式保留并等价迁移测试。

**Tech Stack:** Vite、React 18.3、TypeScript 5、Tailwind CSS 3.4、shadcn/ui、@rare-ui/core 0.1.1（精确锁定）、Vitest + @testing-library/react + jsdom、@tauri-apps/cli 2.12.4。

**范围说明：** 本计划只覆盖 spec（[2026-11-14-r2-rare-ui-design.md](../specs/2026-11-14-r2-rare-ui-design.md)）§8 的 **P0 骨架 + P1 共享层**。P2–P6（各窗口重写）在 P1 通过后按窗口另行出计划，每份计划单独产出可验证交付物。

## Global Constraints

- React / ReactDOM：`18.3.x`；TypeScript：`5.x`；Vite：最新稳定，由 `package-lock.json` 锁定。
- Tailwind CSS：`3.4.x`，禁止 Tailwind 4。
- `@rare-ui/core`：**精确 `0.1.1`**（`package.json` 中不带 `^`/`~`）。
- `lucide-react`：精确锁定版本；`@tauri-apps/cli`：保持 `2.12.4`。
- 7 个入口文件名固定不变：`index.html`、`picker.html`、`capture.html`、`longshot.html`、`longshot-bar.html`、`pin.html`、`quicktranslate.html`；query 参数语义不变。
- 禁止根入口引入 Rare UI：只允许 `import ... from "@rare-ui/core/charts" | "/video" | "/datepicker" | "/carousel" | "/styles.css"`（0.1.1 的 `exports` 只暴露这 5 个子路径 + 根入口；基础组件在根入口，按规则不引入）。
- 生产 CSP 保持 `script-src 'self'`；各 HTML 不再写 `<meta>` CSP。
- 不改 Rust 业务逻辑与命令契约；设置 schema 保持 `11`；版本号保持 `0.4.3`。
- 每个任务以一次 `git commit` 结束，提交信息使用英文 conventional commit。
- 测试先行：每个实现步骤前先写失败测试。

## File Structure

```
frontend/
  index.html  picker.html  capture.html  longshot.html
  longshot-bar.html  pin.html  quicktranslate.html     # 7 入口
  vite.config.ts          # 多页构建、@ 别名、5173 端口
  vitest.config.ts        # jsdom 环境，src/**/*.test.ts(x)
  tsconfig.json           # allowJs（过渡期）、jsx react-jsx、@ 路径
  tailwind.config.ts      # darkMode class、shadcn 色板、Rare preset 探测
  postcss.config.cjs
  components.json         # shadcn CLI 配置
  src/
    entries/settings.tsx  picker.tsx  capture.tsx  longshot.tsx
    entries/longshot-bar.tsx  pin.tsx  quicktranslate.tsx
    windows/SettingsWindow.tsx  PickerWindow.tsx  CaptureWindow.tsx
    windows/LongshotWindow.tsx  LongshotBarWindow.tsx  PinWindow.tsx
    windows/QuickTranslateWindow.tsx
    components/ui/        # shadcn 生成的组件
    components/rare/      # Rare UI 包装与 token 映射
    hooks/useTauriEvent.ts  hooks/useStream.ts
    lib/tauri-api.js      # 由 web/shared/tauri-api.js 机械迁移（allowJs）
    lib/tauri-api.d.ts    # pickerAPI/settingsAPI/quickAPI/subscribe 类型
    lib/i18n/messages.zh.ts  messages.en.ts  index.tsx（Provider/useT）
    lib/markdown.ts
    lib/stream-guard.ts
    lib/constants.ts
    styles/globals.css    # @tailwind 指令 + token 变量 + dark
scripts/migrate-messages.mjs   # messages.js → .ts 数据生成
```

---

### Task 1: 建立 frontend 构建骨架与依赖

**Files:**
- Create: `frontend/vite.config.ts`、`frontend/vitest.config.ts`、`frontend/tsconfig.json`、`frontend/tailwind.config.ts`、`frontend/postcss.config.cjs`
- Modify: `package.json`（scripts + devDependencies）、`.gitignore`

**Interfaces:**
- Produces: `npm run dev:web`（5173）、`npm run build:web`（输出 `frontend/dist`）、`npm run test:web`（Vitest）；`@/` 别名指向 `frontend/src`。

- [ ] **Step 1: 安装依赖并锁版本**

```bash
npm install --save-dev vite @vitejs/plugin-react typescript tailwindcss@3.4 autoprefixer postcss vitest jsdom @testing-library/react @testing-library/jest-dom @types/react@18 @types/react-dom@18
npm install react@18.3 react-dom@18.3 tailwindcss-animate class-variance-authority clsx tailwind-merge lucide-react
npm install --save-exact @rare-ui/core@0.1.1
```

Expected: `package.json` 中 `@rare-ui/core` 为 `"0.1.1"`（无 `^`），`react` 为 `18.3.x`。

- [ ] **Step 2: 写 `frontend/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));
const entries = ["index", "picker", "capture", "longshot", "longshot-bar", "pin", "quicktranslate"];

export default defineConfig({
  root,
  plugins: [react()],
  resolve: { alias: { "@": resolve(root, "src") } },
  server: { port: 5173, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome110",
    rollupOptions: {
      input: Object.fromEntries(entries.map((name) => [name, resolve(root, `${name}.html`)])),
    },
  },
});
```

- [ ] **Step 3: 写 `frontend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowJs": true,
    "checkJs": false,
    "isolatedModules": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "vitest/globals"],
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 4: 写 `frontend/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": resolve(root, "src") } },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
```

- [ ] **Step 5: 写 `frontend/tailwind.config.ts` 与 `frontend/postcss.config.cjs`**

```ts
import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  content: ["./index.html", "./*.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        card: { DEFAULT: "hsl(var(--card) / <alpha-value>)", foreground: "hsl(var(--card-foreground) / <alpha-value>)" },
        popover: { DEFAULT: "hsl(var(--popover) / <alpha-value>)", foreground: "hsl(var(--popover-foreground) / <alpha-value>)" },
        primary: { DEFAULT: "hsl(var(--primary) / <alpha-value>)", foreground: "hsl(var(--primary-foreground) / <alpha-value>)" },
        secondary: { DEFAULT: "hsl(var(--secondary) / <alpha-value>)", foreground: "hsl(var(--secondary-foreground) / <alpha-value>)" },
        muted: { DEFAULT: "hsl(var(--muted) / <alpha-value>)", foreground: "hsl(var(--muted-foreground) / <alpha-value>)" },
        accent: { DEFAULT: "hsl(var(--accent) / <alpha-value>)", foreground: "hsl(var(--accent-foreground) / <alpha-value>)" },
        destructive: { DEFAULT: "hsl(var(--destructive) / <alpha-value>)", foreground: "hsl(var(--destructive-foreground) / <alpha-value>)" },
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
      },
      borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" },
      fontFamily: {
        ui: ['"Segoe UI"', '"Microsoft YaHei UI"', '"Microsoft YaHei"', "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [animate],
};

export default config;
```

```cjs
/* frontend/postcss.config.cjs */
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 6: 更新 `package.json` scripts**

```json
{
  "scripts": {
    "dev:web": "vite --config frontend/vite.config.ts",
    "build:web": "tsc --noEmit -p frontend/tsconfig.json && vite build --config frontend/vite.config.ts",
    "test:web": "vitest run --config frontend/vitest.config.ts",
    "preview:web": "vite preview --config frontend/vite.config.ts"
  }
}
```

- [ ] **Step 7: `.gitignore` 追加 `frontend/dist/`**

- [ ] **Step 8: 验证**
Run: `npm run build:web`
Expected: 预期失败（Task 2 才创建 HTML 与 `src/`）：`tsc` 报 `No inputs were found in config file` 或 Vite 报入口 HTML 缺失。关键是**失败原因必须是缺文件，而不是配置语法或依赖解析错误**；若出现 `Cannot find module`/JSON 解析错误，先修配置再进入下一任务。

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json .gitignore frontend/
git commit -m "build(web): scaffold vite react typescript frontend workspace"
```

---

### Task 2: 创建 7 个多页入口与 React 挂载

**Files:**
- Create: `frontend/index.html`、`picker.html`、`capture.html`、`longshot.html`、`longshot-bar.html`、`pin.html`、`quicktranslate.html`
- Create: `frontend/src/entries/{settings,picker,capture,longshot,longshot-bar,pin,quicktranslate}.tsx`
- Create: `frontend/src/windows/*.tsx`（7 个窗口组件，本任务仅渲染标题占位）
- Test: `frontend/src/entries/picker.test.tsx`

**Interfaces:**
- Produces: 每个窗口组件签名 `({ surface? }: { surface?: "panel" | "toolbar" })`（picker）与无参组件（其余）；`/#root` 挂载点。

- [ ] **Step 1: 写失败测试 `frontend/src/entries/picker.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { PickerWindow } from "../windows/PickerWindow";

describe("PickerWindow", () => {
  test("renders panel surface by default", () => {
    render(<PickerWindow surface="panel" />);
    expect(screen.getByTestId("surface")).toHaveTextContent("panel");
  });

  test("renders toolbar surface when asked", () => {
    render(<PickerWindow surface="toolbar" />);
    expect(screen.getByTestId("surface")).toHaveTextContent("toolbar");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**
Run: `npm run test:web -- picker`
Expected: FAIL，`Cannot find module '../windows/PickerWindow'`

- [ ] **Step 3: 写 7 个 HTML 入口**

以 `frontend/index.html` 为模板（其余仅改 `src` 与 `lang`）：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Lexora</title>
    <link rel="icon" href="data:," />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/entries/settings.tsx"></script>
  </body>
</html>
```

其余 6 个文件把 `src/entries/settings.tsx` 换成各自入口：

| 文件 | script |
| --- | --- |
| `picker.html` | `/src/entries/picker.tsx` |
| `capture.html` | `/src/entries/capture.tsx` |
| `longshot.html` | `/src/entries/longshot.tsx` |
| `longshot-bar.html` | `/src/entries/longshot-bar.tsx` |
| `pin.html` | `/src/entries/pin.tsx` |
| `quicktranslate.html` | `/src/entries/quicktranslate.tsx` |

- [ ] **Step 4: 写 7 个窗口组件（本任务为占位真实现）**

```tsx
/* frontend/src/windows/PickerWindow.tsx */
export type PickerSurface = "panel" | "toolbar";

export function PickerWindow({ surface = "panel" }: { surface?: PickerSurface }) {
  return (
    <div data-testid="surface" className="h-full w-full bg-background text-foreground">
      {surface}
    </div>
  );
}
```

其余窗口同构，例如：

```tsx
/* frontend/src/windows/SettingsWindow.tsx */
export function SettingsWindow() {
  return <div data-testid="window" className="h-full w-full bg-background text-foreground">settings</div>;
}
```

`CaptureWindow`、`LongshotWindow`、`LongshotBarWindow`、`PinWindow`、`QuickTranslateWindow` 与 `SettingsWindow` 同构，仅文本改为窗口名。

- [ ] **Step 5: 写 7 个入口 bootstrap**

```tsx
/* frontend/src/entries/settings.tsx */
import { createRoot } from "react-dom/client";
import { SettingsWindow } from "../windows/SettingsWindow";
import "../styles/globals.css";

createRoot(document.getElementById("root")!).render(<SettingsWindow />);
```

`picker.tsx` 需要按 query 分派：

```tsx
/* frontend/src/entries/picker.tsx */
import { createRoot } from "react-dom/client";
import { PickerWindow, type PickerSurface } from "../windows/PickerWindow";
import "../styles/globals.css";

const surface: PickerSurface =
  new URLSearchParams(location.search).get("surface") === "toolbar" ? "toolbar" : "panel";

createRoot(document.getElementById("root")!).render(<PickerWindow surface={surface} />);
```

其余入口按同样结构挂载对应窗口组件。

- [ ] **Step 6: 写 `frontend/src/styles/globals.css`（token 单一真源）**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --background: 220 20% 97%;
  --foreground: 221 39% 11%;
  --card: 0 0% 100%;
  --card-foreground: 221 39% 11%;
  --popover: 0 0% 100%;
  --popover-foreground: 221 39% 11%;
  --primary: 243 75% 59%;
  --primary-foreground: 0 0% 100%;
  --secondary: 220 14% 96%;
  --secondary-foreground: 221 39% 11%;
  --muted: 220 14% 96%;
  --muted-foreground: 220 9% 46%;
  --accent: 226 100% 97%;
  --accent-foreground: 243 75% 59%;
  --destructive: 0 72% 51%;
  --destructive-foreground: 0 0% 100%;
  --border: 220 13% 91%;
  --input: 220 13% 91%;
  --ring: 243 75% 59%;
  --radius: 12px;
}

html.dark {
  --background: 220 17% 7%;
  --foreground: 220 14% 91%;
  --card: 222 18% 11%;
  --card-foreground: 220 14% 91%;
  --popover: 222 18% 11%;
  --popover-foreground: 220 14% 91%;
  --primary: 234 89% 74%;
  --primary-foreground: 225 22% 7%;
  --secondary: 220 9% 18%;
  --secondary-foreground: 220 14% 91%;
  --muted: 220 9% 18%;
  --muted-foreground: 220 12% 65%;
  --accent: 243 47% 20%;
  --accent-foreground: 234 89% 74%;
  --destructive: 0 91% 71%;
  --destructive-foreground: 225 22% 7%;
  --border: 220 9% 18%;
  --input: 220 9% 18%;
  --ring: 234 89% 74%;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
}

body {
  font-family: theme("fontFamily.ui");
  -webkit-font-smoothing: antialiased;
}
```

- [ ] **Step 7: 运行测试与构建**
Run: `npm run test:web` && `npm run build:web`
Expected: 测试 PASS；`frontend/dist/` 出现 7 个 HTML 与 `assets/*.js|css`。

- [ ] **Step 8: Commit**

```bash
git add frontend/
git commit -m "feat(web): add seven html entries and react mount points"
```

---

### Task 3: 初始化 shadcn 并生成首批基础组件

**Files:**
- Create: `frontend/components.json`
- Create: `frontend/src/lib/utils.ts`
- Create: `frontend/src/components/ui/button.tsx`、`input.tsx`、`label.tsx`、`switch.tsx`、`select.tsx`、`tooltip.tsx`、`toast.tsx`
- Test: `frontend/src/components/ui/button.test.tsx`

**Interfaces:**
- Produces: `cn(...inputs: ClassValue[]): string`；shadcn 组件按官方签名（`Button` 支持 `variant`/`size`/`asChild`）。

- [ ] **Step 1: 写失败测试 `frontend/src/components/ui/button.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Button } from "./button";

test("renders children with primary styling", () => {
  render(<Button>确定</Button>);
  const button = screen.getByRole("button", { name: "确定" });
  expect(button.className).toContain("bg-primary");
});

test("supports outline variant", () => {
  render(<Button variant="outline">取消</Button>);
  expect(screen.getByRole("button", { name: "取消" }).className).toContain("border");
});
```

- [ ] **Step 2: 运行确认失败**
Run: `npm run test:web -- button`
Expected: FAIL，找不到 `./button`

- [ ] **Step 3: 写 `frontend/src/lib/utils.ts`**

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 4: 尝试 shadcn CLI（失败则走 Step 5 手工路径）**

```bash
cd frontend
npx shadcn@latest init -d --base-color slate
npx shadcn@latest add button input label switch select tooltip toast
cd ..
```

判定：若 CLI 因 Tailwind 4 假设而改写 `frontend/tailwind.config.ts` 或生成 `@import "tailwindcss"` 样式，**放弃 CLI 产物并回退**：

```bash
git restore frontend/
git clean -fd frontend/components.json frontend/src/components frontend/src/lib/utils.ts
```

然后执行 Step 5。

- [ ] **Step 5: 手工落盘 components.json 与首批组件**

先安装 `Button` 需要的 Radix 基础包：

```bash
npm install @radix-ui/react-slot @radix-ui/react-label @radix-ui/react-switch @radix-ui/react-select @radix-ui/react-tooltip @radix-ui/react-toast
```**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/styles/globals.css",
    "baseColor": "slate",
    "cssVariables": true
  },
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui" }
}
```

`button.tsx`（shadcn new-york 标准实现，可逐字使用）：

```tsx
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: { default: "h-9 px-4 py-2", sm: "h-8 px-3 text-xs", lg: "h-10 px-8", icon: "h-9 w-9" },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
```

其余组件（`input`、`label`、`switch`、`select`、`tooltip`、`toast`）用 `npx shadcn@latest add <name> --path frontend/src/components/ui` 单组件生成；若仍失败，从 shadcn 官方仓库复制对应 `new-york` 源码，保留其 `@radix-ui/*` 依赖并加入 `package.json`。

- [ ] **Step 6: 运行测试**
Run: `npm run test:web -- button`
Expected: PASS（2 tests）

- [ ] **Step 7: 增加 Rare UI 禁用根入口的 lint 校验**

```json
/* package.json 增加 */
"scripts": { "lint:imports": "node scripts/check-rare-imports.mjs" }
```

```js
/* scripts/check-rare-imports.mjs */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = "frontend/src";
const offenders = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(entry) && /from\s+["']@rare-ui\/core["']/.test(readFileSync(full, "utf8"))) {
      offenders.push(full);
    }
  }
}
walk(root);
if (offenders.length) {
  console.error("Rare UI root import is forbidden; use subpaths:\n" + offenders.join("\n"));
  process.exit(1);
}
console.log("rare-ui import check passed");
```

Run: `npm run lint:imports`
Expected: `rare-ui import check passed`

- [ ] **Step 8: 验证 Rare UI 依赖不会静默膨胀**

```powershell
npm ls @radix-ui/react-dialog @radix-ui/react-slot
Get-ChildItem node_modules\@rare-ui\core\dist -File | Measure-Object Length -Sum
```

Expected: 每个 Radix 包只有一个版本（无 `deduped` 冲突警告）；记录 `@rare-ui/core` 的 `dist` 体积供 Task 5 基线参考。**不要在此任务中 import 根入口做冒烟**——规则禁止，且当前功能不需要 Rare UI 基础组件。

- [ ] **Step 9: Commit**

```bash
git add package.json frontend/ scripts/check-rare-imports.mjs
git commit -m "feat(web): add shadcn primitives and rare-ui import guard"
```

---

### Task 4: 切换 Tauri 配置并验证打包

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Test: 无单测；以 `npx tauri build --debug --no-bundle` 为验收

**Interfaces:**
- Consumes: `frontend/dist`（Task 2 产物）
- Produces: `tauri dev` 走 5173；`tauri build` 先跑 `npm run build:web`。

- [ ] **Step 1: 修改 `build` 段**

```json
"build": {
  "frontendDist": "../frontend/dist",
  "devUrl": "http://localhost:5173",
  "beforeDevCommand": "npm run dev:web",
  "beforeBuildCommand": "npm run build:web"
}
```

- [ ] **Step 2: 确认各 HTML 已无 `<meta http-equiv="Content-Security-Policy">`**

Run: `Select-String -Path frontend\*.html -Pattern 'Content-Security-Policy'`
Expected: 无匹配（CSP 只由 `app.security.csp` 注入）。

- [ ] **Step 3: 构建并启动冒烟**

```bash
npm run build:web
npx tauri build --debug --no-bundle
Start-Process .\src-tauri\target\debug\lexora.exe -ArgumentList "--show"
```

Expected: 设置窗口显示空白 `settings` 占位页，无 CSP 报错（devtools console 无 `Refused to execute`）。

- [ ] **Step 4: 验证 dev 模式**

```bash
npx tauri dev
```

Expected: 窗口加载 `http://localhost:5173`，修改 `SettingsWindow.tsx` 文案后热更新生效。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "build(tauri): point frontendDist at the vite build output"
```

---

### Task 5: 记录体积与冷启动基线

**Files:**
- Create: `docs/r2-baseline.md`

**Interfaces:**
- Produces: 基线数字（exe 大小、`frontend/dist` 大小、冷启动秒数），P6 验收对比用。

- [ ] **Step 1: 采集基线**

```powershell
$exe = "src-tauri\target\release\lexora.exe"
Get-Item $exe | Select-Object Length
Get-ChildItem frontend\dist -Recurse -File | Measure-Object Length -Sum
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Process .\src-tauri\target\release\lexora.exe -ArgumentList "--show"
# 目视设置窗口完全可交互时停止秒表
```

- [ ] **Step 2: 由采集命令直接生成 `docs/r2-baseline.md`（不手填，避免占位符残留）**

```powershell
$exe = "src-tauri\target\release\lexora.exe"
$exeBytes = (Get-Item $exe).Length
$distBytes = (Get-ChildItem frontend\dist -Recurse -File | Measure-Object Length -Sum).Sum
@(
  "# R2 基线（P0）",
  "",
  "- 采集时间：$((Get-Date).ToString('yyyy-MM-dd HH:mm'))",
  "- release exe：$exeBytes B",
  "- frontend/dist 合计：$distBytes B",
  "- 冷启动到设置页可交互：<手动计时结果> ms",
  "- 对比基准：R1 合并后的 0.4.2 构建 12,773,888 B"
) | Set-Content -Encoding UTF8 docs/r2-baseline.md
```

计时值用人工秒表实测后，用 `-replace` 更新该行：

```powershell
(Get-Content docs/r2-baseline.md -Raw) -replace '<手动计时结果>', '1200' | Set-Content -Encoding UTF8 docs/r2-baseline.md
```

- [ ] **Step 3: Commit**

```bash
git add docs/r2-baseline.md
git commit -m "docs(r2): record p0 bundle and cold start baseline"
```

---

### Task 6: 更新 CI 与 release 工作流

**Files:**
- Modify: `.github/workflows/ci.yml`、`.github/workflows/release.yml`

**Interfaces:**
- Consumes: `npm run build:web`、`npm run test:web`、`npm run lint:imports`

- [ ] **Step 1: ci.yml 在 Cargo test 之前插入前端步骤**

```yaml
      - name: Build web frontend
        run: npm run build:web

      - name: Test web frontend
        run: npm run test:web

      - name: Check rare-ui imports
        run: npm run lint:imports
```

- [ ] **Step 2: release.yml 同样插入（`npx tauri build` 前）**

- [ ] **Step 3: 本地等价验证**

```bash
npm ci
npm run lint:imports
npm run test:web
npm run build:web
```

Expected: 全部 exit 0。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: build and test the web frontend before tauri builds"
```

---

### Task 7: 迁移 i18n 消息数据

**Files:**
- Create: `scripts/migrate-messages.mjs`
- Create: `frontend/src/lib/i18n/messages.zh.ts`、`messages.en.ts`
- Test: `frontend/src/lib/i18n/messages.test.ts`

**Interfaces:**
- Produces: `messages: Record<string, string>`（zh/en 各一份），key 集合一致。

- [ ] **Step 1: 写失败测试**

```ts
import { expect, test } from "vitest";
import { messages as zh } from "./messages.zh";
import { messages as en } from "./messages.en";

test("zh and en expose the same keys", () => {
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
});

test("known key resolves both languages", () => {
  expect(zh["common.ok"]).toBe("确定");
  expect(en["common.ok"]).toBe("OK");
});
```

- [ ] **Step 2: 运行确认失败**
Run: `npm run test:web -- messages`
Expected: FAIL，找不到 `./messages.zh`

- [ ] **Step 3: 写并运行迁移脚本**

```js
/* scripts/migrate-messages.mjs */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const outDir = "frontend/src/lib/i18n";
mkdirSync(outDir, { recursive: true });

for (const locale of ["zh", "en"]) {
  const source = readFileSync(`web/shared/messages.${locale}.js`, "utf8");
  const marker = `LP.messages.${locale} = `;
  const bodyStart = source.indexOf("{", source.indexOf(marker));
  /* Object literal closes with "\n  };" at column 2 before the IIFE epilogue. */
  const bodyEnd = source.indexOf("\n  }", bodyStart);
  if (bodyStart < 0 || bodyEnd < bodyStart) throw new Error(`cannot find message body for ${locale}`);
  const body = source.slice(bodyStart, bodyEnd + 4);
  const out = `/* Generated from web/shared/messages.${locale}.js by scripts/migrate-messages.mjs. */\nexport const messages: Record<string, string> = ${body};\n`;
  writeFileSync(`${outDir}/messages.${locale}.ts`, out);
  console.log(`wrote ${outDir}/messages.${locale}.ts`);
}
```

Run: `node scripts/migrate-messages.mjs`
Expected: 输出两行 `wrote ...`

- [ ] **Step 4: 运行测试**
Run: `npm run test:web -- messages`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-messages.mjs frontend/src/lib/i18n/
git commit -m "feat(i18n): migrate message packs to typed es modules"
```

---

### Task 8: 实现 I18nProvider 与 useT

**Files:**
- Create: `frontend/src/lib/i18n/index.tsx`
- Test: `frontend/src/lib/i18n/i18n.test.tsx`

**Interfaces:**
- Produces:
  - `type Locale = "zh" | "en"`
  - `normalizeLocale(value: unknown): Locale`
  - `translate(locale: Locale, key: string, params?: Record<string, string | number>): string`
  - `I18nProvider({ initialLocale, children })`
  - `useT(): { t, locale, setLocale }`
  - `applyStaticToDom(root: ParentNode, t: (key: string) => string): void`（为非 React 内容保留，行为对齐现 `LP.i18n.applyStatic`）
- 语义必须与 `web/shared/i18n.js` 一致：当前语言 → en → 原样 key；插值 `{name}` 保留未知占位。

- [ ] **Step 1: 写失败测试**

```tsx
import { renderHook, act } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { I18nProvider, applyStaticToDom, normalizeLocale, translate, useT } from "./index";
import type { ReactNode } from "react";

function wrapper(initialLocale: "zh" | "en") {
  return ({ children }: { children: ReactNode }) => (
    <I18nProvider initialLocale={initialLocale}>{children}</I18nProvider>
  );
}

test("normalizeLocale maps prefixes and falls back to en", () => {
  expect(normalizeLocale("zh-CN")).toBe("zh");
  expect(normalizeLocale("en-US")).toBe("en");
  expect(normalizeLocale("ja")).toBe("en");
});

test("translate falls back to en then to the key", () => {
  expect(translate("en", "common.ok")).toBe("OK");
  expect(translate("zh", "missing.key")).toBe("missing.key");
});

test("translate interpolates params", () => {
  expect(translate("en", "capture.colorWithValue", { color: "#fff" })).toBe("Color #fff");
});

test("translate keeps unknown placeholders", () => {
  expect(translate("en", "capture.colorWithValue", {})).toBe("Color {color}");
});

test("applyStaticToDom translates data-i18n nodes", () => {
  const root = document.createElement("div");
  root.innerHTML = '<span data-i18n="common.ok"></span>';
  applyStaticToDom(root, (key) => translate("zh", key));
  expect(root.querySelector("span")?.textContent).toBe("确定");
});

test("useT switches locale on setLocale", () => {
  const { result } = renderHook(() => useT(), { wrapper: wrapper("zh") });
  expect(result.current.locale).toBe("zh");
  act(() => result.current.setLocale("en"));
  expect(result.current.locale).toBe("en");
});
```

- [ ] **Step 2: 运行确认失败**
Run: `npm run test:web -- i18n`
Expected: FAIL，找不到 `./index`

- [ ] **Step 3: 实现 `frontend/src/lib/i18n/index.tsx`**

```tsx
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";import { messages as zh } from "./messages.zh";
import { messages as en } from "./messages.en";

export type Locale = "zh" | "en";
export type TParams = Record<string, string | number>;

const packs: Record<Locale, Record<string, string>> = { zh, en };

export function normalizeLocale(value: unknown): Locale {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw.startsWith("zh")) return "zh";
  return "en";
}

function interpolate(text: string, params?: TParams): string {
  if (!params) return text;
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

export function translate(locale: Locale, key: string, params?: TParams): string {
  const pack = packs[locale] ?? packs.en;
  const text = Object.prototype.hasOwnProperty.call(pack, key) ? pack[key] : packs.en[key];
  if (text === undefined) return String(key);
  return interpolate(String(text), params);
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: TParams) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(normalizeLocale(initialLocale));
  const setLocale = useCallback((next: Locale) => setLocaleState(normalizeLocale(next)), []);
  const t = useCallback((key: string, params?: TParams) => translate(locale, key, params), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  if (typeof document !== "undefined") {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useT must be used inside I18nProvider");
  return value;
}

/* For non-React content (markdown output, imperative panels). Mirrors
 * LP.i18n.applyStatic from web/shared/i18n.js: text, title, aria-label and
 * placeholder are all translated in place. */
export function applyStaticToDom(root: ParentNode, t: (key: string) => string): void {
  root.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (key) node.textContent = t(key);
  });
  root
    .querySelectorAll("[data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]")
    .forEach((node) => {
      if (!(node instanceof Element)) return;
      const titleKey = node.getAttribute("data-i18n-title");
      if (titleKey) node.setAttribute("title", t(titleKey));
      const ariaKey = node.getAttribute("data-i18n-aria-label");
      if (ariaKey) node.setAttribute("aria-label", t(ariaKey));
      const placeholderKey = node.getAttribute("data-i18n-placeholder");
      if (placeholderKey) node.setAttribute("placeholder", t(placeholderKey));
    });
}
```

- [ ] **Step 4: 运行测试**
Run: `npm run test:web -- i18n`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/i18n/
git commit -m "feat(i18n): add react provider and useT hook"
```

---

### Task 9: 迁移 markdown 渲染为 ESM 模块

**Files:**
- Create: `frontend/src/lib/markdown.ts`
- Test: `frontend/src/lib/markdown.test.ts`

**Interfaces:**
- Produces: `renderMarkdown(text: string): string`、`markdownToPlain(text: string): string`，行为与 `LP.renderMarkdown` / `LP.markdownToPlain` 完全一致（先转义 HTML、仅允许 http(s) 链接）。

- [ ] **Step 1: 写失败测试**

```ts
import { expect, test } from "vitest";
import { markdownToPlain, renderMarkdown } from "./markdown";

test("escapes raw html", () => {
  expect(renderMarkdown("<img src=x onerror=alert(1)>")).not.toContain("<img");
});

test("renders bold and inline code", () => {
  const html = renderMarkdown("**bold** and `code`");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<code>code</code>");
});

test("rejects javascript links", () => {
  expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("href=\"javascript:");
});

test("plain text strips markdown", () => {
  expect(markdownToPlain("**bold**")).toBe("bold");
});
```

- [ ] **Step 2: 运行确认失败**
Run: `npm run test:web -- markdown`
Expected: FAIL，找不到 `./markdown`

- [ ] **Step 3: 迁移实现**

把 `web/shared/markdown.js` 的 IIFE 改为 ESM：删除外层 `(function () { ... })();`、删除 `var LP = ...` 行、把 `LP.renderMarkdown = f` 改为 `export function renderMarkdown`、`LP.markdownToPlain = f` 改为 `export function markdownToPlain`，函数体**逐字保留**。

- [ ] **Step 4: 运行测试**
Run: `npm run test:web -- markdown`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/markdown.ts frontend/src/lib/markdown.test.ts
git commit -m "feat(web): port markdown renderer to an es module"
```

---

### Task 10: 迁移 tauri-api 服务层

**Files:**
- Create: `frontend/src/lib/tauri-api.js`（复制并机械改造）
- Create: `frontend/src/lib/tauri-api.d.ts`
- Test: `frontend/src/lib/tauri-api.test.ts`

**Interfaces:**
- Produces:
  - `pickerAPI`、`settingsAPI`、`quickAPI`（形状与现 `web/shared/tauri-api.js` 一致）
  - `subscribe(eventName: string, handler: (payload: unknown) => void, options?: unknown): () => void`
  - `currentWebviewTarget(): { target: { kind: "WebviewWindow"; label: string } } | undefined`
  - mock backend 在无 `window.__TAURI__` 时继续生效（浏览器预览能力保留）

- [ ] **Step 1: 写失败测试**

```ts
import { beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

test("exposes the three service objects even without tauri", async () => {
  const api = await import("./tauri-api.js");
  expect(typeof api.pickerAPI.translate).toBe("function");
  expect(typeof api.settingsAPI.getState).toBe("function");
  expect(typeof api.quickAPI.translate).toBe("function");
});

test("invoke failures resolve to an ok:false object instead of rejecting", async () => {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: { invoke: vi.fn().mockRejectedValue("boom") },
    event: { listen: vi.fn().mockResolvedValue(() => {}) },
  };
  const api = await import("./tauri-api.js");
  const result = await api.pickerAPI.status();
  expect(result.ok).toBe(false);
});
```

- [ ] **Step 2: 运行确认失败**
Run: `npm run test:web -- tauri-api`
Expected: FAIL，找不到 `./tauri-api.js`

- [ ] **Step 3: 机械迁移**

```bash
cp web/shared/tauri-api.js frontend/src/lib/tauri-api.js
```

在 `frontend/src/lib/tauri-api.js` 中执行以下改造（逐项）：

1. 删除首行 `(function () {` 与末行 `})();`（外层 IIFE），改为模块顶层代码。
2. 删除 `var LP = (window.LP = window.LP || {});`（如有）并改为 import：`import { translate } from "./i18n";`（若原文件用 `LP.t`）。
3. 把 `function subscribe(...)` 前加 `export`。
4. 把 `function currentWebviewTarget(...)` 前加 `export`。
5. 把 `window.pickerAPI = {...}` 改为 `export const pickerAPI = {...}`；`window.settingsAPI`、`window.quickAPI` 同理。
6. 文件末尾补 `export default { pickerAPI, settingsAPI, quickAPI, subscribe, currentWebviewTarget };`
7. 保留 mock backend 全部分支（`LIVE === false` 路径）。

- [ ] **Step 4: 写 `frontend/src/lib/tauri-api.d.ts`**

```ts
export interface ApiResult<T = unknown> {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export const pickerAPI: Record<string, (...args: unknown[]) => Promise<ApiResult>>;
export const settingsAPI: Record<string, (...args: unknown[]) => Promise<ApiResult>>;
export const quickAPI: Record<string, (...args: unknown[]) => Promise<ApiResult>>;

export function subscribe(
  eventName: string,
  handler: (payload: unknown) => void,
  options?: { target?: { kind: "WebviewWindow"; label: string } }
): () => void;

export function currentWebviewTarget():
  | { target: { kind: "WebviewWindow"; label: string } }
  | undefined;
```

- [ ] **Step 5: 运行测试**
Run: `npm run test:web -- tauri-api`
Expected: PASS（2 tests）

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/tauri-api.js frontend/src/lib/tauri-api.d.ts frontend/src/lib/tauri-api.test.ts
git commit -m "feat(web): port tauri api bridge to es module with typings"
```

---

### Task 11: 实现 useTauriEvent（强制窗口 target）

**Files:**
- Create: `frontend/src/hooks/useTauriEvent.ts`
- Test: `frontend/src/hooks/useTauriEvent.test.tsx`

**Interfaces:**
- Produces: `useTauriEvent<T>(eventName: string, handler: (payload: T) => void, label: string): void`
- 约束：必须携带 `{ target: { kind: "WebviewWindow", label } }`，禁止依赖默认 `Any`。

- [ ] **Step 1: 写失败测试**

```tsx
import { render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useTauriEvent } from "./useTauriEvent";

const subscribe = vi.fn().mockReturnValue(() => {});

vi.mock("../lib/tauri-api.js", () => ({
  subscribe: (...args: unknown[]) => subscribe(...args),
}));

function Probe() {
  useTauriEvent<{ value: number }>("demo-event", () => {}, "capture-0");
  return null;
}

test("subscribes with a pinned webview target", () => {
  render(<Probe />);
  expect(subscribe).toHaveBeenCalledWith(
    "demo-event",
    expect.any(Function),
    { target: { kind: "WebviewWindow", label: "capture-0" } }
  );
});
```

- [ ] **Step 2: 运行确认失败**
Run: `npm run test:web -- useTauriEvent`
Expected: FAIL，找不到 `./useTauriEvent`

- [ ] **Step 3: 实现**

```ts
import { useEffect, useRef } from "react";
import { subscribe } from "../lib/tauri-api.js";

export function useTauriEvent<T>(eventName: string, handler: (payload: T) => void, label: string): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const dispose = subscribe(
      eventName,
      (payload) => handlerRef.current(payload as T),
      { target: { kind: "WebviewWindow", label } }
    );
    return dispose;
  }, [eventName, label]);
}
```

- [ ] **Step 4: 运行测试**
Run: `npm run test:web -- useTauriEvent`
Expected: PASS（1 test）

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useTauriEvent.ts frontend/src/hooks/useTauriEvent.test.tsx
git commit -m "feat(web): add pinned-window tauri event hook"
```

---

### Task 12: 抽离流式重复检测 guard

**Files:**
- Create: `frontend/src/lib/stream-guard.ts`
- Test: `frontend/src/lib/stream-guard.test.ts`（等价迁移 `web/picker-repetition.test.cjs`）
- Modify: 无（窗口层 P3 再接入）

**Interfaces:**
- Produces:
  - `type GuardSource = "translate" | "polish" | "ocr" | "assist" | "other"`
  - `guardRepetition(text: string, request: { text?: string; finishReason?: string; partial?: boolean }, source: GuardSource): { text: string; finishReason?: string; partial?: boolean }`
  - 行为：连续重复段落/列表项 ≥3 次、周期重复 ≥4 次触发；翻译/润色参考原文合法重复；代码/表格/引用受保护；OCR 豁免；未触发时返回入参内容不变。

- [ ] **Step 1: 迁移现有测试为 Vitest（先失败）**

读取 `web/picker-repetition.test.cjs`，按其用例逐条改写为 `frontend/src/lib/stream-guard.test.ts`：把 `extract()` 源码抽取替换为 `import { guardRepetition } from "./stream-guard"`，断言保持原样（原文件每条 test 一一对应）。

- [ ] **Step 2: 运行确认失败**
Run: `npm run test:web -- stream-guard`
Expected: FAIL，找不到 `./stream-guard`

- [ ] **Step 3: 抽取实现**

从 `web/picker.js` 复制以下区间到 `stream-guard.ts`：`guardRepetition`（2192 行起）及其调用的全部纯函数（归一化、段落切分、周期检测、代码/表格/引用保护判断）。规则：

- 只保留不触碰 DOM / 全局 state 的纯函数。
- `stopRepeatedRequest`（约 2305 行）**不迁移**（依赖 abort 与 state），P3 在窗口层实现。
- 触发时返回 `{ ...request, text: 首份内容, finishReason: "repetition", partial: true }`，与现行为一致。
- 导出 `guardRepetition` 与 `type GuardSource`。

- [ ] **Step 4: 运行测试**
Run: `npm run test:web -- stream-guard`
Expected: PASS，用例数与 `web/picker-repetition.test.cjs` 相同

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/stream-guard.ts frontend/src/lib/stream-guard.test.ts
git commit -m "feat(web): extract stream repetition guard as pure module"
```

---

### Task 13: 实现 useStream

**Files:**
- Create: `frontend/src/hooks/useStream.ts`
- Test: `frontend/src/hooks/useStream.test.tsx`

**Interfaces:**
- Produces: `useStream<TState>({ requestId, eventName, label, initial, reduce })`
  - `eventName`：`"translate-event"` 或窗口事件名
  - 事件 payload 形态（沿用 contracts）：`{ requestId, type: "chunk" | "target" | "error" | "done", text?, targetLang?, message?, hint?, elapsedMs? }`
  - 返回 `{ state, status: "idle" | "streaming" | "done" | "error", start(), abort() }`
  - 约束：`done`/`error` 之后的迟到事件不得覆盖终态。

- [ ] **Step 1: 写失败测试**

```tsx
import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useStream } from "./useStream";

let handler: ((payload: unknown) => void) | undefined;
vi.mock("../lib/tauri-api.js", () => ({
  subscribe: (_name: string, fn: (payload: unknown) => void) => {
    handler = fn;
    return () => {};
  },
}));

interface Chunk { text: string; status: string }

test("accumulates chunks then reaches done", () => {
  const { result } = renderHook(() =>
    useStream<Chunk>({
      requestId: "r1",
      eventName: "translate-event",
      label: "picker",
      initial: { text: "", status: "idle" },
      reduce: (state, event) =>
        event.type === "chunk"
          ? { text: state.text + String((event as { text?: string }).text ?? ""), status: "streaming" }
          : state,
    })
  );
  act(() => handler?.({ requestId: "r1", type: "chunk", text: "你好" }));
  expect(result.current.state.text).toBe("你好");
  act(() => handler?.({ requestId: "r1", type: "done" }));
  expect(result.current.status).toBe("done");
});

test("ignores events after done", () => {
  const { result } = renderHook(() =>
    useStream<Chunk>({
      requestId: "r2",
      eventName: "translate-event",
      label: "picker",
      initial: { text: "", status: "idle" },
      reduce: (state, event) =>
        event.type === "chunk"
          ? { text: state.text + String((event as { text?: string }).text ?? ""), status: "streaming" }
          : state,
    })
  );
  act(() => handler?.({ requestId: "r2", type: "done" }));
  act(() => handler?.({ requestId: "r2", type: "chunk", text: "late" }));
  expect(result.current.state.text).toBe("");
});
```

- [ ] **Step 2: 运行确认失败**
Run: `npm run test:web -- useStream`
Expected: FAIL，找不到 `./useStream`

- [ ] **Step 3: 实现**

```ts
import { useCallback, useMemo, useState } from "react";
import { useTauriEvent } from "./useTauriEvent";

export type StreamEvent =
  | { requestId: string; type: "chunk"; text?: string }
  | { requestId: string; type: "target"; targetLang?: string }
  | { requestId: string; type: "error"; message?: string; hint?: string }
  | { requestId: string; type: "done"; elapsedMs?: number };

export type StreamStatus = "idle" | "streaming" | "done" | "error";

interface Options<TState> {
  requestId: string;
  eventName: string;
  label: string;
  initial: TState;
  reduce: (state: TState, event: StreamEvent) => TState;
}

export function useStream<TState>({ requestId, eventName, label, initial, reduce }: Options<TState>) {
  const [state, setState] = useState<TState>(initial);
  const [status, setStatus] = useState<StreamStatus>("idle");

  useTauriEvent<StreamEvent>(
    eventName,
    useCallback(
      (event: StreamEvent) => {
        if (!event || event.requestId !== requestId) return;
        if (status === "done" || status === "error") return;
        if (event.type === "done") setStatus("done");
        else if (event.type === "error") setStatus("error");
        else setStatus("streaming");
        setState((current) => reduce(current, event));
      },
      [requestId, status, reduce]
    ),
    label
  );

  const start = useCallback(() => setStatus("streaming"), []);
  const abort = useCallback(() => {
    setStatus("idle");
    setState(initial);
  }, [initial]);

  return useMemo(() => ({ state, status, start, abort }), [state, status, start, abort]);
}
```

- [ ] **Step 4: 运行测试**
Run: `npm run test:web -- useStream`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useStream.ts frontend/src/hooks/useStream.test.tsx
git commit -m "feat(web): add streaming event hook with terminal-state guard"
```

---

### Task 14: P1 收尾验证与文档

**Files:**
- Modify: `docs/building.md`（前端构建命令）、`docs/architecture.md`（前端架构段落）、`CHANGELOG.md`（`[Unreleased]` 增加 R2 P0/P1 条目）
- Test: 全量前端测试 + 构建 + 打包

**Interfaces:**
- Consumes: Task 1–13 全部产出。

- [ ] **Step 1: 跑全量验证**

```bash
npm run lint:imports
npm run test:web
npm run build:web
cd src-tauri && cargo test && cd ..
```

Expected: 全部通过；`frontend/dist` 含 7 个 HTML。

- [ ] **Step 2: 打包验证**

```bash
npx tauri build --debug --no-bundle
```

Expected: exe 产出，启动后 7 个窗口均能打开（settings 与 quicktranslate 从托盘/快捷键触发，capture 等通过现有入口触发）。

- [ ] **Step 3: 更新文档**

`docs/building.md` 的“本地开发”段增加：

```markdown
前端源码在 `frontend/`（Vite + React + TypeScript）：

```powershell
npm run dev:web      # 前端单独调试（http://localhost:5173）
npm run build:web    # 产物 frontend/dist，tauri build 前会自动执行
npm run test:web     # Vitest
npm run lint:imports # 禁止 Rare UI 根入口导入
```
```

`CHANGELOG.md` `[Unreleased]` 增加：

```markdown
### Changed

- 前端迁移到 React + Vite + TypeScript + Tailwind 构建链（R2 第一阶段：构建骨架与共享层），基础组件采用 shadcn/ui 源码，Rare UI 仅在缺少对应组件时按 subpath 引入。
```

- [ ] **Step 4: Commit**

```bash
git add docs CHANGELOG.md
git commit -m "docs(r2): document frontend build commands for p0/p1"
```

---

## 后续计划（不在本计划内）

- **Plan 2（P2）**：settings 窗口重写。
- **Plan 3（P3）**：picker / picker-toolbar 状态机重写。
- **Plan 4（P4）**：quicktranslate + pin。
- **Plan 5（P5）**：capture / annotate / longshot / longshot-bar。
- **Plan 6（P6）**：删除 `web/`、验收、文档定稿、体积与 DPI 对比基线。

每份计划沿用本结构的 Header、Global Constraints、File Structure、Task 步骤格式。
