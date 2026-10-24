#!/usr/bin/env node
/**
 * Captures a screenshot of a WebView2 window through CDP.
 *
 *   node tests/cdp-screenshot.mjs <port> <target-url-substring> <output.png>
 */

import { writeFileSync } from "node:fs";

const [port, targetMatch, output, theme] = process.argv.slice(2);
if (!port || !targetMatch || !output) {
  console.error("usage: node tests/cdp-screenshot.mjs <port> <target> <output.png>");
  process.exit(2);
}

async function main() {
  const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await listResponse.json();
  const pattern = new RegExp(targetMatch);
  const target = targets.find((item) => pattern.test(item.url));
  if (!target) {
    throw new Error(`target ${targetMatch} not found`);
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30000);
      const listener = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        clearTimeout(timer);
        socket.removeEventListener("message", listener);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      };
      socket.addEventListener("message", listener);
      socket.send(JSON.stringify({ id, method, params }));
    });

  if (theme) {
    await call("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: theme },
        { name: "prefers-reduced-motion", value: "reduce" },
      ],
    });
  }
  // Make sure the page has painted before capturing.
  await call("Runtime.evaluate", { expression: "new Promise(r => requestAnimationFrame(() => setTimeout(r, 120)))", awaitPromise: true });
  const result = await call("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true });
  writeFileSync(output, Buffer.from(result.data, "base64"));
  socket.close();
  console.log(`screenshot saved: ${output}`);
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
});
