#!/usr/bin/env node
/**
 * Tiny CDP helper for manual/e2e checks.
 *
 *   node tests/cdp-eval.mjs <port> <target-url-substring> <expression>
 *
 * Prints the JSON encoded evaluation result. The expression is evaluated with
 * `awaitPromise` and `returnByValue` so it can await Tauri commands.
 */

const [port, targetMatch, expression] = process.argv.slice(2);
if (!port || !targetMatch || !expression) {
  console.error("usage: node tests/cdp-eval.mjs <port> <target-url-substring> <expression>");
  process.exit(2);
}

async function main() {
  const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await listResponse.json();
  const pattern = new RegExp(targetMatch);
  const target = targets.find((item) => pattern.test(item.url));
  if (!target) {
    throw new Error(`target ${targetMatch} not found (${targets.map((item) => item.url).join(", ")})`);
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const response = await new Promise((resolve, reject) => {
    const id = 1;
    const timer = setTimeout(() => reject(new Error("CDP timeout")), 120000);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id === id) {
        clearTimeout(timer);
        resolve(message);
      }
    });
    socket.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      })
    );
  });
  socket.close();
  if (response.error) {
    throw new Error(response.error.message || "CDP error");
  }
  if (response.result.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.text || "evaluation failed");
  }
  console.log(JSON.stringify(response.result.result.value));
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
});
