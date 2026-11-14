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
