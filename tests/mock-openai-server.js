#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible mock server used by the end-to-end checks.
 *
 *   node tests/mock-openai-server.js [port]
 *
 * Endpoints:
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream:true -> SSE, stream:false -> JSON)
 *
 * Auth: any non-empty API key is accepted, except the literal "bad-key" which
 * returns 401 to let the error path be tested.
 */

const http = require("node:http");

const port = Number(process.argv[2] || 8770);

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function streamChat(response, prompt) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const answer = `[MOCK] 这是翻译结果：${prompt.slice(0, 40)}`;
  const chunks = [];
  for (let index = 0; index < answer.length; index += 3) {
    chunks.push(answer.slice(index, index + 3));
  }
  let index = 0;
  const timer = setInterval(() => {
    if (index >= chunks.length) {
      clearInterval(timer);
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    const payload = {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      model: "mock-qwen",
      choices: [{ index: 0, delta: { content: chunks[index] }, finish_reason: null }],
    };
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
    index += 1;
  }, 15);
  response.on("close", () => clearInterval(timer));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const authorization = String(request.headers.authorization || "");

  if (request.method === "GET" && url.pathname === "/v1/models") {
    if (authorization.includes("bad-key")) {
      sendJson(response, 401, { error: { message: "invalid api key" } });
      return;
    }
    sendJson(response, 200, {
      object: "list",
      data: [{ id: "mock-qwen", object: "model" }],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      if (authorization.includes("bad-key")) {
        sendJson(response, 401, { error: { message: "invalid api key" } });
        return;
      }
      let payload = {};
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        payload = {};
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const lastUser = messages.filter((message) => message.role === "user").pop();
      const prompt = String((lastUser && lastUser.content) || "");
      if (payload.stream === true) {
        streamChat(response, prompt);
        return;
      }
      sendJson(response, 200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: "mock-qwen",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `[MOCK] 这是翻译结果：${prompt.slice(0, 40)}` },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    });
    return;
  }

  sendJson(response, 404, { error: { message: "not found" } });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-openai listening on http://127.0.0.1:${port}/v1`);
});
