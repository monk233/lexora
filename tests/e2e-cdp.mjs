#!/usr/bin/env node
/**
 * End-to-end check through the WebView2 DevTools protocol.
 *
 * Prerequisites:
 *   - `npx tauri build --debug --no-bundle` produced src-tauri/target/debug/lingopick.exe
 *   - `node tests/mock-openai-server.js 8770` is already running
 *
 * The script starts LingoPick with a temporary data directory whose settings
 * point at the mock OpenAI server, then uses CDP `Runtime.evaluate` to invoke the
 * real Tauri commands (`test_online`, `picker_translate`, `picker_assist`) and
 * asserts on the results. It never touches the user's real data directory.
 *
 *   node tests/e2e-cdp.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.env.LINGOPICK_E2E_EXE || path.join(root, "src-tauri", "target", "debug", "lingopick.exe");
const dataDir = mkdtempSync(path.join(tmpdir(), "lingopick-e2e-"));
const debugPort = 9333;

mkdirSync(path.join(dataDir, "logs"), { recursive: true });
mkdirSync(path.join(dataDir, "models"), { recursive: true });
writeFileSync(
  path.join(dataDir, "settings.json"),
  JSON.stringify(
    {
      version: 1,
      picker: { enabled: true, shortcut: "Ctrl+Shift+D", skills: ["translate", "summarize", "explain", "read", "copy"], compact: false, defaultTargetLang: "auto", blacklist: [], maxChars: 5000 },
      provider: {
        mode: "online",
        online: { preset: "custom", baseUrl: "http://127.0.0.1:8770/v1", apiKey: "test-key", model: "mock-qwen", timeoutMs: 20000, temperature: 0.2, maxTokens: 512 },
        local: { modelFile: "", contextSize: 4096, threads: 0, gpuLayers: 0, autoStart: false },
      },
      app: { closeToTray: true, startAtLogin: false, theme: "light", firstRunDone: true },
    },
    null,
    2
  )
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function waitForTargets() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
      const usable = targets.filter((target) => target.webSocketDebuggerUrl);
      if (usable.length >= 2) return usable;
    } catch {
      // app not ready yet
    }
    await delay(250);
  }
  throw new Error("WebView2 DevTools targets not found");
}

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || "CDP error"));
        else resolve(message.result);
      }
    });
  }

  async evaluate(expression) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    const result = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
        })
      );
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "evaluation failed");
    }
    return result.result.value;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // ignore
    }
  }
}

async function main() {
  const app = spawn(exe, ["--show"], {
    cwd: root,
    env: {
      ...process.env,
      LINGOPICK_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  const failures = [];
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    if (!ok) failures.push(`${name}: ${detail}`);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail || ""}`);
  };

  let clients = [];
  try {
    const targets = await waitForTargets();
    const settingsTarget = targets.find((target) => !target.url.includes("picker.html"));
    const pickerTarget = targets.find((target) => target.url.includes("picker.html"));
    check("webview targets", Boolean(settingsTarget && pickerTarget), `count=${targets.length}`);

    const settings = new CdpClient(settingsTarget.webSocketDebuggerUrl);
    const picker = new CdpClient(pickerTarget.webSocketDebuggerUrl);
    clients = [settings, picker];

    const state = await settings.evaluate("window.__TAURI__.core.invoke('get_state')");
    check("get_state", state && state.app && state.settings, `version=${state && state.app && state.app.version}`);

    const test = await settings.evaluate(
      "window.__TAURI__.core.invoke('test_online', {baseUrl:'http://127.0.0.1:8770/v1', apiKey:'test-key', model:'mock-qwen', timeoutMs:20000})"
    );
    check("test_online", test && test.ok === true, `latency=${test && test.latencyMs}ms models=${test && (test.models || []).join(",")}`);

    const badKey = await settings.evaluate(
      "window.__TAURI__.core.invoke('test_online', {baseUrl:'http://127.0.0.1:8770/v1', apiKey:'bad-key', model:'mock-qwen', timeoutMs:5000}).then(r => r, e => ({error: String(e)}))"
    );
    check("test_online rejects bad key", Boolean(badKey && (badKey.error || badKey.ok === false)), JSON.stringify(badKey).slice(0, 120));

    const streaming = await picker.evaluate(`(async () => {
      const { core, event } = window.__TAURI__;
      const requestId = 'e2e-' + Date.now();
      let text = '';
      let chunkCount = 0;
      let failure = '';
      const done = new Promise((resolve) => {
        const unlisten = event.listen('translate-event', (e) => {
          const payload = e.payload || {};
          if (payload.requestId !== requestId) return;
          if (payload.type === 'chunk') { text += payload.text || ''; chunkCount += 1; }
          if (payload.type === 'error') { failure = payload.message || 'unknown'; unlisten(); resolve(); }
          if (payload.type === 'done') { unlisten(); resolve(); }
        });
      });
      const start = await core.invoke('picker_translate', { requestId, text: 'Hello world, this is a test.', targetLang: 'zh' });
      if (!start || start.ok !== true) return { ok: false, error: (start && start.error) || 'start failed' };
      await Promise.race([done, new Promise((r) => setTimeout(r, 15000))]);
      return { ok: !failure && text.length > 0, text, chunkCount, failure };
    })()`);
    check("picker_translate streaming", streaming && streaming.ok === true, `chunks=${streaming && streaming.chunkCount} text=${String(streaming && streaming.text).slice(0, 40)}`);

    const assist = await picker.evaluate(
      "window.__TAURI__.core.invoke('picker_assist', {action:'summarize', text:'LingoPick is a portable selection translator for Windows.'})"
    );
    check("picker_assist", assist && assist.ok === true && typeof assist.text === "string", `text=${String(assist && assist.text).slice(0, 40)}`);
  } catch (error) {
    check("e2e harness", false, error.message);
  } finally {
    for (const client of clients) client.close();
    try {
      app.kill();
    } catch {
      // ignore
    }
    await delay(500);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log("\n=== E2E SUMMARY ===");
  console.log(`${results.filter((item) => item.ok).length}/${results.length} checks passed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
