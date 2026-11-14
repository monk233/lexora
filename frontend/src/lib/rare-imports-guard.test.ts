import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findRareImportViolations } from "../../../scripts/check-rare-imports.mjs";

// Built at runtime on purpose: writing the bare specifier here would make this
// very file trip the guard it tests.
const RARE_UI = ["@rare-ui", "core"].join("/");
const rareUi = (subpath?: string): string => (subpath === undefined ? RARE_UI : `${RARE_UI}/${subpath}`);

const tempDirs: string[] = [];

function makeProject(files: Record<string, string>): string {
  const rootDir = mkdtempSync(join(tmpdir(), "rare-imports-guard-"));
  tempDirs.push(rootDir);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(rootDir, ...relativePath.split("/"));
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }
  return rootDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("reports a root import", () => {
  const rootDir = makeProject({
    "frontend/src/app.ts": `import { Button } from "${rareUi()}";\n\nexport const x = Button;\n`,
  });

  expect(findRareImportViolations(rootDir)).toEqual([
    { file: "frontend/src/app.ts", line: 1, specifier: RARE_UI },
  ]);
});

test("reports a single-quoted root import", () => {
  const rootDir = makeProject({
    "frontend/src/app.tsx": `import { Button } from '${rareUi()}';\n`,
  });

  expect(findRareImportViolations(rootDir)).toHaveLength(1);
});

test("reports a side-effect import", () => {
  const rootDir = makeProject({
    "frontend/src/main.ts": `import "${rareUi()}";\n`,
  });

  const violations = findRareImportViolations(rootDir);
  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatchObject({ line: 1, specifier: RARE_UI });
});

test("reports a dynamic import", () => {
  const rootDir = makeProject({
    "frontend/src/lazy.ts": `export async function load() {\n  return await import("${rareUi()}");\n}\n`,
  });

  const violations = findRareImportViolations(rootDir);
  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatchObject({ line: 2, specifier: RARE_UI });
});

test("reports require()", () => {
  const rootDir = makeProject({
    "frontend/src/legacy.cjs": `module.exports = require("${rareUi()}");\n`,
  });

  expect(findRareImportViolations(rootDir)).toHaveLength(1);
});

test("reports a non-whitelisted subpath", () => {
  const rootDir = makeProject({
    "frontend/src/button.ts": `import { Button } from "${rareUi("button")}";\n`,
  });

  expect(findRareImportViolations(rootDir)).toEqual([
    { file: "frontend/src/button.ts", line: 1, specifier: rareUi("button") },
  ]);
});

test("reports a non-whitelisted nested subpath", () => {
  const rootDir = makeProject({
    "frontend/src/charts.ts": `import { Chart } from "${rareUi("charts/internal")}";\n`,
  });

  expect(findRareImportViolations(rootDir)).toHaveLength(1);
});

test("allows the whitelisted subpaths", () => {
  const subpaths = ["charts", "video", "datepicker", "carousel", "styles.css"];
  const source = subpaths.map((subpath) => `import "${rareUi(subpath)}";`).join("\n");
  const rootDir = makeProject({ "frontend/src/allowed.ts": `${source}\n` });

  expect(findRareImportViolations(rootDir)).toEqual([]);
});

test("allows clean code", () => {
  const rootDir = makeProject({
    "frontend/src/app.ts": `import { cn } from "@/lib/utils";\nimport { Button } from "./components/ui/button";\n\nexport const x = cn(Button);\n`,
  });

  expect(findRareImportViolations(rootDir)).toEqual([]);
});

test("scans frontend config files", () => {
  const rootDir = makeProject({
    "frontend/vite.config.ts": `import react from "@vitejs/plugin-react";\nimport { theme } from "${rareUi()}";\n`,
    "frontend/src/app.ts": `export const ok = true;\n`,
  });

  expect(findRareImportViolations(rootDir)).toEqual([
    { file: "frontend/vite.config.ts", line: 2, specifier: RARE_UI },
  ]);
});
