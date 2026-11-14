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
