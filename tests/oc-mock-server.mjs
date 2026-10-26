import fs from "node:fs";
import http from "node:http";

const port = Number(process.argv[2] || 8799);
const outFile = process.argv[3] || "oc-headers.json";
const log = [];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    log.push({
      method: req.method,
      url: req.url,
      headers: {
        "x-opencode-session": req.headers["x-opencode-session"] || "",
        "user-agent": req.headers["user-agent"] || "",
        authorization: req.headers.authorization || "",
        "content-type": req.headers["content-type"] || "",
      },
    });
    fs.writeFileSync(outFile, JSON.stringify(log, null, 2));

    if (req.url && req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "kimi-k3" }, { id: "glm-5.3" }] }));
      return;
    }
    if (req.url && req.url.includes("/chat/completions")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "pong" } }],
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log("mock listening on " + port);
});
