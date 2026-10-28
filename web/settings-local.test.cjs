const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "settings.js"), "utf8");
function extract(name) {
  const start = source.indexOf("  function " + name + "(");
  assert.notEqual(start, -1);
  const end = source.indexOf("\n  function ", start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}
function element(tag, className, text) {
  const attrs = {};
  return {
    tag, className, textContent: text || "", children: [], hidden: false,
    classList: { add() {}, remove() {} },
    setAttribute(key, value) { attrs[key] = value; },
    getAttribute(key) { return attrs[key] === undefined ? null : attrs[key]; },
    removeAttribute(key) { delete attrs[key]; },
    appendChild(child) { this.children.push(child); },
    addEventListener(event, handler) { this[event] = handler; },
    querySelector(selector) { return this.children.find((child) => child.className.includes(selector.slice(1))); },
  };
}
async function main() {
  const nodes = {};
  for (const id of ["local-state-badge", "start-local", "stop-local", "restart-local", "local-state-hint", "local-error", "local-models"]) nodes[id] = element("div", "");
  let timer;
  let deletes = 0;
  let releaseDelete;
  let releaseRestart;
  const context = vm.createContext({
    Promise, Object,
    state: { engine: { localState: "ready" }, catalog: [] },
    localBusy: false, localAction: "", removingModels: Object.create(null),
    window: { setTimeout(fn) { timer = fn; return 1; }, clearTimeout() {} },
    el: element, byId: (id) => nodes[id],
    isQwen35: (id) => String(id || "").startsWith("qwen3.5-"),
    selectedLocalModel: () => "", recommendedModelId: () => "", LP: { formatBytes: () => "1 GB" },
    setHidden(node, hidden) { node.hidden = hidden; }, setTone() {}, toast() {},
    hideInlineError(node) { node.hidden = true; node.textContent = ""; },
    showInlineError(node, error, hint) { node.hidden = false; node.textContent = error + (hint || ""); },
    flushSaveQueue: () => Promise.resolve({ ok: true }),
    API: {
      removeModel() { deletes++; return new Promise((resolve) => { releaseDelete = resolve; }); },
      restartLocal() { return new Promise((resolve) => { releaseRestart = resolve; }); },
    },
  });
  for (const name of ["modelRole", "localModelRow", "armDanger", "disarmDanger", "renderLocalIdleTimeout", "renderLocalState", "runLocalAction", "restartLocal"]) vm.runInContext(extract(name), context);
  context.refreshState = async () => { context.renderLocalState(); };
  for (const catalogId of ["qwen3.5-2b-q3-k-m", undefined]) {
    const row = context.localModelRow({ catalogId, file: "builtin.gguf" });
    assert.equal(row.children.some((child) => child.className.includes("btn-danger")), false);
  }
  assert.equal(context.modelRole("hy-mt2-1.8b").label, "其他本地模型");
  assert.equal(context.modelRole("").builtin, false);
  const row = context.localModelRow({ catalogId: "", file: "Hy-MT2-1.8B-Q4_K_M.gguf" });
  nodes["local-models"].appendChild(row);
  const button = row.querySelector(".btn-danger");
  button.click();
  assert.equal(button.textContent, "确认删除");
  assert.equal(deletes, 0);
  timer();
  assert.equal(button.textContent, "删除");
  button.click(); button.click(); button.click();
  assert.equal(deletes, 1);
  assert.equal(button.disabled, true);
  releaseDelete({ ok: false, error: "删除失败", hint: "请停止引擎" });
  await new Promise(setImmediate);
  assert.equal(nodes["local-error"].textContent, "删除失败请停止引擎");
  assert.equal(button.disabled, false);
  for (const state of ["ready", "running", "starting", "stopped"]) {
    context.state.engine.localState = state;
    context.renderLocalState();
    assert.equal(nodes["restart-local"].hidden, state === "stopped");
    assert.equal(nodes["restart-local"].disabled, state === "starting");
  }
  context.state.engine.localState = "ready";
  const pending = context.restartLocal();
  await new Promise(setImmediate);
  assert.equal(nodes["restart-local"].textContent, "重启中…");
  assert.equal(nodes["restart-local"].disabled, true);
  assert.equal(nodes["stop-local"].disabled, true);
  assert.equal(context.restartLocal(), undefined, "Repeated actions are ignored while busy");
  releaseRestart({ ok: false, error: "重启失败", hint: "请检查模型" });
  await pending;
  assert.equal(nodes["restart-local"].textContent, "重启");
  assert.equal(nodes["stop-local"].disabled, false);
  assert.equal(nodes["local-error"].hidden, false);
  assert.equal(nodes["local-error"].textContent, "重启失败请检查模型");
  console.log("PASS: model deletion confirmation, timeout and busy guard; restart visibility, busy guard and errors");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

const test = require("node:test");
function savingHarness() {
  const nodes = {};
  for (const id of ["local-state-badge", "start-local", "stop-local", "restart-local", "local-state-hint", "local-error"]) nodes[id] = element("div", "");
  const saves = [];
  const calls = [];
  let persisted = "old";
  let refreshes = 0;
  const merge = (target, patch) => {
    const result = { ...target };
    for (const key of Object.keys(patch)) result[key] = patch[key] && typeof patch[key] === "object" && !Array.isArray(patch[key]) ? merge(target[key] || {}, patch[key]) : patch[key];
    return result;
  };
  const context = vm.createContext({
    Promise, Object,
    state: { engine: { localState: "ready" }, settings: { provider: { local: { selectedModel: "old" } } } },
    saveQueue: null, saving: false, savePending: null, localBusy: false, localAction: "",
    // Restart must not flush unrelated text drafts, including online API credentials.
    flushAllTextFields() { throw new Error("Unexpected text debounce flush"); },
    LP: { deepMerge: merge }, byId: (id) => nodes[id],
    setSaveStatus() {}, toast() {}, setTone() {},
    setHidden(node, hidden) { node.hidden = hidden; },
    hideInlineError(node) { node.hidden = true; node.textContent = ""; },
    showInlineError(node, error, hint) { node.hidden = false; node.textContent = error + (hint || ""); },
    API: {
      updateSettings(patch) {
        calls.push("save");
        return new Promise((resolve, reject) => saves.push({ patch, reject, finish(ok = true) {
          if (ok && patch.provider) persisted = patch.provider.local.selectedModel;
          resolve(ok ? { ok: true, state: { settings: { provider: { local: { selectedModel: persisted } } } } } : { ok: false, error: "磁盘写入失败" });
        } }));
      },
      restartLocal() { calls.push("restart:" + persisted); return Promise.resolve({ ok: true }); },
    },
  });
  for (const name of ["optimisticApply", "enqueuePatch", "flushSaveQueue", "save", "renderLocalIdleTimeout", "renderLocalState", "runLocalAction", "restartLocal"]) vm.runInContext(extract(name), context);
  context.renderAll = () => context.renderLocalState();
  context.applyState = () => {};
  context.refreshState = async () => { refreshes++; context.renderLocalState(); return { ok: true }; };
  return { context, nodes, saves, calls, refreshes: () => refreshes };
}
test("restart waits for in-flight and queued selection saves before invoking engine", async () => {
  const h = savingHarness();
  h.context.save({ app: { resident: true } });
  h.context.save({ provider: { local: { selectedModel: "new" } } });
  const restart = h.context.restartLocal();
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, ["save"]);
  assert.equal(h.nodes["restart-local"].disabled, true);
  assert.equal(h.context.localBusy, true);
  h.saves[0].finish();
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, ["save", "save"]);
  assert.equal(h.saves[1].patch.provider.local.selectedModel, "new");
  h.saves[1].finish();
  await restart;
  assert.deepEqual(h.calls, ["save", "save", "restart:new"]);
  assert.equal(h.context.localBusy, false);
  assert.equal(h.nodes["restart-local"].disabled, false);
});
for (const rejection of [false, true]) test("restart aborts and restores UI on save " + (rejection ? "rejection" : "failure"), async () => {
  const h = savingHarness();
  h.context.save({ provider: { local: { selectedModel: "new" } } });
  const restart = h.context.restartLocal();
  await new Promise(setImmediate);
  if (rejection) h.saves[0].reject(new Error("磁盘写入失败"));
  else h.saves[0].finish(false);
  await restart;
  assert.deepEqual(h.calls, ["save"]);
  assert.equal(h.context.localBusy, false);
  assert.equal(h.context.saving, false);
  assert.equal(h.nodes["restart-local"].disabled, false);
  assert.equal(h.nodes["local-error"].hidden, false);
  assert.match(h.nodes["local-error"].textContent, /磁盘写入失败/);
  assert.ok(h.refreshes() > 0);
});
test("restart preserves an earlier save failure while draining later queued selection", async () => {
  const h = savingHarness();
  h.context.save({ app: { resident: true } });
  h.context.save({ provider: { local: { selectedModel: "new" } } });
  const restart = h.context.restartLocal();
  await new Promise(setImmediate);
  h.saves[0].finish(false);
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, ["save", "save"]);
  h.saves[1].finish();
  await restart;
  assert.deepEqual(h.calls, ["save", "save"]);
  assert.equal(h.context.localBusy, false);
  assert.match(h.nodes["local-error"].textContent, /磁盘写入失败/);
});
test("restart waits for additional model selection queued during the save", async () => {
  const h = savingHarness();
  h.context.save({ provider: { local: { selectedModel: "first" } } });
  const restart = h.context.restartLocal();
  await new Promise(setImmediate);
  h.context.save({ provider: { local: { selectedModel: "latest" } } });
  h.saves[0].finish();
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, ["save", "save"]);
  h.saves[1].finish();
  await restart;
  assert.deepEqual(h.calls, ["save", "save", "restart:latest"]);
});
