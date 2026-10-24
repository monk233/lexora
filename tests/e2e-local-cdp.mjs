#!/usr/bin/env node
/**
 * Local-mode end-to-end check through the WebView2 DevTools protocol.
 *
 * Requires a llama.cpp engine and at least one GGUF model in the model dir, e.g.:
 *
 *   $env:LEXORA_LLAMA_DIR = "E:\...\enterprise-ai-translator\vendor\llama"
 *   $env:LEXORA_MODEL_DIR = "E:\...\enterprise-ai-translator\models"
 *   node tests/e2e-local-cdp.mjs
 *
 * The app is started with a temporary data directory; it never touches the real
 * user settings. The check drives the real Tauri commands: start_local,
 * picker_translate (streaming), picker_assist, stop_local.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(root, "src-tauri", "target", "debug", "lexora.exe");
const engineDir = process.env.LEXORA_LLAMA_DIR || "";
const modelDir = process.env.LEXORA_MODEL_DIR || "";
const debugPort = 9334;

if (!engineDir || !modelDir) {
  console.error("Set LEXORA_LLAMA_DIR and LEXORA_MODEL_DIR first.");
  process.exit(2);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "lexora-e2e-local-"));
mkdirSync(path.join(dataDir, "logs"), { recursive: true });
writeFileSync(
  path.join(dataDir, "settings.json"),
  JSON.stringify(
    {
      version: 1,
      picker: { enabled: true, skills: ["translate", "summarize", "explain", "read", "copy"], compact: false, defaultTargetLang: "auto", blacklist: [], maxChars: 5000 },
      provider: {
        mode: "local",
        online: { preset: "custom", baseUrl: "", apiKey: "", model: "", timeoutMs: 60000, temperature: 0.2, maxTokens: 512 },
        local: { contextSize: 4096, threads: 0, gpuLayers: 0, autoStart: false },
      },
      app: { closeToTray: true, startAtLogin: false, theme: "light" },
    },
    null,
    2
  )
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTargets() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      if (targets.length >= 2) return targets;
    } catch {
      // not ready
    }
    await delay(300);
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

  async evaluate(expression, timeoutMs = 120000) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP evaluate timed out"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
        })
      );
    }).then((result) => {
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "evaluation failed");
      }
      return result.result.value;
    });
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
      LEXORA_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail || ""}`);
  };

  let clients = [];
  try {
    const targets = await waitForTargets();
    const settingsTarget = targets.find((target) => !target.url.includes("picker.html"));
    const pickerTarget = targets.find((target) => target.url.includes("picker.html"));
    const settings = new CdpClient(settingsTarget.webSocketDebuggerUrl);
    const picker = new CdpClient(pickerTarget.webSocketDebuggerUrl);
    clients = [settings, picker];

    const started = await settings.evaluate(
      "window.__TAURI__.core.invoke('start_local').then(r => r, e => ({ok:false, error:String(e)}))"
    );
    check("start_local", started && started.ok === true, JSON.stringify(started).slice(0, 160));

    let state = null;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      state = await settings.evaluate("window.__TAURI__.core.invoke('get_state')");
      if (state && state.engine && state.engine.localState === "ready") break;
      await delay(1000);
    }
    check(
      "local engine ready",
      state && state.engine.localState === "ready",
      `state=${state && state.engine && state.engine.localState} model=${state && state.engine && state.engine.localModelFile}`
    );

    const translation = await picker.evaluate(`(async () => {
      const { core, event } = window.__TAURI__;
      const requestId = 'e2e-local-' + Date.now();
      let text = '';
      let chunks = 0;
      let failure = '';
      const finished = new Promise((resolve) => {
        const unlisten = event.listen('translate-event', (e) => {
          const payload = e.payload || {};
          if (payload.requestId !== requestId) return;
          if (payload.type === 'chunk') { text += payload.text || ''; chunks += 1; }
          if (payload.type === 'error') { failure = payload.message || 'error'; unlisten(); resolve(); }
          if (payload.type === 'done') { unlisten(); resolve(); }
        });
      });
      const start = await core.invoke('picker_translate', { requestId, text: 'The catheter shall be inserted under sterile conditions.', targetLang: 'zh' });
      if (!start || start.ok !== true) return { ok: false, error: (start && start.error) || 'start failed' };
      await Promise.race([finished, new Promise((r) => setTimeout(r, 120000))]);
      return { ok: !failure && text.length > 0 && !text.includes('[MOCK]'), text, chunks, failure };
    })()`, 150000);
    check("local streaming translation", translation && translation.ok === true, `chunks=${translation && translation.chunks} text=${String(translation && translation.text).slice(0, 60)}`);

    const assist = await picker.evaluate(`(async () => {
      const { core, event } = window.__TAURI__;
      const requestId = 'e2e-local-assist-' + Date.now();
      let text = '';
      let chunks = 0;
      let failure = '';
      const finished = new Promise((resolve) => {
        const unlisten = event.listen('translate-event', (e) => {
          const payload = e.payload || {};
          if (payload.requestId !== requestId) return;
          if (payload.type === 'chunk') { text += payload.text || ''; chunks += 1; }
          if (payload.type === 'error') { failure = payload.message || 'error'; unlisten(); resolve(); }
          if (payload.type === 'done') { unlisten(); resolve(); }
        });
      });
      const start = await core.invoke('picker_assist', { requestId, action: 'summarize', text: 'Lexora is a portable selection translator for Windows. It supports online and offline models.' });
      if (!start || start.ok !== true) return { ok: false, error: (start && start.error) || 'start failed' };
      await Promise.race([finished, new Promise((r) => setTimeout(r, 120000))]);
      return { ok: !failure && text.length > 0 && !text.includes('[MOCK]'), text, chunks, failure };
    })()`, 150000);
    check("local assist streaming", assist && assist.ok === true, `chunks=${assist && assist.chunks} text=${String(assist && assist.text).slice(0, 60)}`);
    const stopped = await settings.evaluate("window.__TAURI__.core.invoke('stop_local').then(r => r, e => ({ok:false, error:String(e)}))");
    check("stop_local", stopped && stopped.ok === true, JSON.stringify(stopped).slice(0, 120));
  } catch (error) {
    check("local e2e harness", false, error.message);
  } finally {
    for (const client of clients) client.close();
    try {
      app.kill();
    } catch {
      // ignore
    }
    await delay(800);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n=== LOCAL E2E SUMMARY ===\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
