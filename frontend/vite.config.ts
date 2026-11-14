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
