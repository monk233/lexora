/* Rare UI import guard: only whitelisted subpaths may be imported.
 *
 * The root entrypoint (@rare-ui/core) pulls the whole 8.26 MB bundle into the
 * build, so it is forbidden; only the subpaths listed below are allowed.
 * Runs as part of `npm run build:web` (before tsc) and via `npm run lint:imports`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RARE_UI_PACKAGE = "@rare-ui/core";
export const ALLOWED_RARE_UI_SUBPATHS = ["charts", "video", "datepicker", "carousel", "styles.css"];

const SCAN_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const EXTRA_FILES = [
  "frontend/vite.config.ts",
  "frontend/tailwind.config.ts",
  "frontend/postcss.config.cjs",
  "frontend/vitest.config.ts",
];

// A specifier is the package, optionally followed by `/segment` parts.
const SPECIFIER = String.raw`["'](@rare-ui\/core(?:\/[A-Za-z0-9._-]+)*)["']`;
const IMPORT_PATTERNS = [
  String.raw`\bfrom\s*` + SPECIFIER, // import { x } from "..."; export * from "..."
  String.raw`\bimport\s*` + SPECIFIER, // side-effect import
  String.raw`\bimport\s*\(\s*` + SPECIFIER, // dynamic import
  String.raw`\brequire\s*\(\s*` + SPECIFIER, // CommonJS require
].map((pattern) => new RegExp(pattern, "g"));

function toPosixPath(path) {
  return path.split(sep).join("/");
}

function collectSourceFiles(rootDir, files) {
  for (const entry of readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, files);
    else if (entry.isFile() && SCAN_EXTENSIONS.test(entry.name)) files.push(full);
  }
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function isAllowedSpecifier(specifier) {
  if (specifier === RARE_UI_PACKAGE) return false;
  if (!specifier.startsWith(`${RARE_UI_PACKAGE}/`)) return false;
  const subpath = specifier.slice(RARE_UI_PACKAGE.length + 1);
  return ALLOWED_RARE_UI_SUBPATHS.includes(subpath);
}

/**
 * Find every `@rare-ui/core` import that is not an exactly whitelisted subpath.
 *
 * @param {string} rootDir repository root (the directory containing `frontend/`)
 * @returns {{ file: string, line: number, specifier: string }[]} violations, `file` relative to `rootDir`
 */
export function findRareImportViolations(rootDir) {
  const absoluteRoot = resolve(rootDir);
  const sourcesDir = join(absoluteRoot, "frontend", "src");
  const files = [];
  if (existsSync(sourcesDir)) collectSourceFiles(sourcesDir, files);
  for (const extraFile of EXTRA_FILES) {
    const absoluteFile = join(absoluteRoot, ...extraFile.split("/"));
    if (existsSync(absoluteFile) && statSync(absoluteFile).isFile()) files.push(absoluteFile);
  }

  const violations = [];
  const seen = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const specifier = match[1];
        if (isAllowedSpecifier(specifier)) continue;
        const line = lineOf(text, match.index);
        const key = `${file}:${line}:${specifier}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({ file: toPosixPath(relative(absoluteRoot, file)), line, specifier });
      }
    }
  }
  return violations;
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  const rootDir = fileURLToPath(new URL("..", import.meta.url));
  const violations = findRareImportViolations(rootDir);
  if (violations.length > 0) {
    const allowed = ALLOWED_RARE_UI_SUBPATHS.map((subpath) => `${RARE_UI_PACKAGE}/${subpath}`).join(", ");
    console.error(`Rare UI root import is forbidden. Import a whitelisted subpath instead: ${allowed}`);
    for (const { file, line, specifier } of violations) {
      console.error(`  ${file}:${line}  ${specifier}`);
    }
    process.exit(1);
  }
  console.log("rare-ui import check passed");
}
