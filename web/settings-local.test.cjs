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
  for (const name of ["modelRole", "localModelRow", "armDanger", "disarmDanger", "renderLocalState", "runLocalAction", "restartLocal"]) vm.runInContext(extract(name), context);
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
  for (const name of ["optimisticApply", "enqueuePatch", "flushSaveQueue", "save", "renderLocalState", "runLocalAction", "restartLocal"]) vm.runInContext(extract(name), context);
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

/* ---- Quick translate settings card (quick-translate §7) ---------------- */

const mergePatch = (target, patch) => {
  const result = { ...target };
  for (const key of Object.keys(patch)) {
    result[key] =
      patch[key] && typeof patch[key] === "object" && !Array.isArray(patch[key])
        ? mergePatch(target[key] || {}, patch[key])
        : patch[key];
  }
  return result;
};

/* Mirrors `QUICK_DEFAULTS` in settings.js (top-level var, not extractable). */
const QUICK_DEFAULTS = { enabled: true, hotkey: "Alt+Space", targetLang: "zh", prompt: "", pinned: false };

function quickSettingsHarness(settings) {
  const context = vm.createContext({
    state: settings === undefined ? {} : { settings },
    QUICK_DEFAULTS,
  });
  vm.runInContext(extract("quickSettings"), context);
  return context;
}

function renderQuickHarness(quick, promptDefaults) {
  const nodes = {
    "quick-enabled": element("input", ""),
    "quick-hotkey": element("button", ""),
    "quick-hotkey-restore": element("button", ""),
    "quick-hotkey-error": element("p", ""),
    "quick-prompt": element("textarea", ""),
  };
  const calls = { checked: [], values: [], hotkey: [] };
  const context = vm.createContext({
    Promise, Object,
    state: { settings: quick === undefined ? {} : { quick }, promptDefaults },
    QUICK_DEFAULTS,
    quickPromptDraft: null,
    byId: (id) => nodes[id] || null,
    setChecked(node, value) { node.checked = value; calls.checked.push(value); },
    setInputValue(node, value) { node.value = value; calls.values.push(value); },
    renderHotkey(target) { calls.hotkey.push(target); },
  });
  for (const name of ["quickSettings", "quickPromptDefault", "quickPromptEditorValue", "renderQuickPrompt", "renderQuick"]) {
    vm.runInContext(extract(name), context);
  }
  context.renderQuick();
  return { context, nodes, calls };
}

function quickSaveHarness(promptDefaults) {
  const saves = [];
  const context = vm.createContext({
    state: { promptDefaults },
    save(patch) { saves.push(JSON.parse(JSON.stringify(patch))); },
  });
  for (const name of ["quickPromptDefault", "saveQuickPromptValue", "saveQuickEnabled"]) {
    vm.runInContext(extract(name), context);
  }
  return { context, saves };
}

function quickHotkeyHarness(result, available = true) {
  const nodes = {
    "quick-hotkey": element("button", "hotkey-display"),
    "quick-hotkey-restore": element("button", "btn"),
    "quick-hotkey-error": element("p", "inline-error"),
  };
  nodes["quick-hotkey-error"].hidden = true;
  const calls = { setHotkey: [], toasts: [], rendering: [] };
  const quickApi = available
    ? {
        setHotkey(combo) {
          calls.setHotkey.push(combo);
          return Promise.resolve(result);
        },
      }
    : null;
  const context = vm.createContext({
    Promise, Object,
    state: { settings: { quick: { enabled: true, hotkey: "Alt+Space", targetLang: "zh", prompt: "", pinned: false } } },
    hotkeyRecorders: { capture: { recording: false, saving: false }, quick: { recording: false, saving: false } },
    HOTKEY_TARGETS: {
      capture: { button: "capture-hotkey", restore: "capture-hotkey-restore", error: "capture-hotkey-error", label: "截图快捷键", fallback: "Win+Shift+X" },
      quick: { button: "quick-hotkey", restore: "quick-hotkey-restore", error: "quick-hotkey-error", label: "呼出快捷键", fallback: "Alt+Space" },
    },
    QUICK_API_ALIASES: { setHotkey: ["setHotkey", "quickSetHotkey"], historyClear: ["historyClear", "quickHistoryClear"] },
    LP: { deepMerge: mergePatch },
    window: quickApi ? { quickAPI: quickApi } : {},
    byId: (id) => nodes[id] || null,
    hotkeyErrorNode: (target) => (target === "quick" ? nodes["quick-hotkey-error"] : null),
    renderHotkey(target) { calls.rendering.push(target); },
    hideInlineError(node) { node.hidden = true; node.textContent = ""; },
    showInlineError(node, message, hint) { node.hidden = false; node.textContent = message + (hint || ""); },
    toast(message) { calls.toasts.push(message); },
  });
  for (const name of ["quickApiMethod", "quickApiCall", "hotkeyTargetShortcut", "storeHotkeyTargetShortcut", "submitHotkey"]) {
    vm.runInContext(extract(name), context);
  }
  return { context, nodes, calls };
}

/* Extracts one <section class="card"> block by its `aria-labelledby` title id. */
function cardBlock(html, titleId) {
  const marker = 'aria-labelledby="' + titleId + '"';
  const markerIndex = html.indexOf(marker);
  assert.notEqual(markerIndex, -1, "missing card " + titleId);
  const start = html.lastIndexOf("<section", markerIndex);
  const end = html.indexOf("</section>", markerIndex);
  assert.ok(start >= 0 && end > markerIndex, "malformed card " + titleId);
  return html.slice(start, end);
}

test("settings cards run provider, picker, quick, shortcuts, app, about", () => {
  const html = fs.readFileSync(require("node:path").join(__dirname, "index.html"), "utf8");
  const order = ["card-provider-title", "card-picker-title", "card-quick-title", "card-shortcuts-title", "card-app-title", "card-about-title"];
  const positions = order.map((id) => html.indexOf('aria-labelledby="' + id + '"'));
  for (let index = 0; index < positions.length; index += 1) {
    assert.ok(positions[index] >= 0, "missing card " + order[index]);
    if (index > 0) {
      assert.ok(positions[index] > positions[index - 1], order[index] + " must follow " + order[index - 1]);
    }
  }
});

test("shortcut card owns both shortcut rows; quick card keeps its own controls", () => {
  const html = fs.readFileSync(require("node:path").join(__dirname, "index.html"), "utf8");
  for (const id of ["quick-enabled", "quick-hotkey", "quick-hotkey-restore", "quick-hotkey-error", "quick-prompt", "quick-prompt-reset", "quick-history-clear"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing #" + id);
  }
  assert.match(html, /<textarea[^>]*id="quick-prompt"[^>]*maxlength="4000"/s);
  const shortcutsCard = cardBlock(html, "card-shortcuts-title");
  const quickCard = cardBlock(html, "card-quick-title");
  for (const id of ["quick-hotkey", "quick-hotkey-restore", "quick-hotkey-error"]) {
    assert.ok(shortcutsCard.includes('id="' + id + '"'), id + " must live in the shortcuts card");
    assert.ok(!quickCard.includes('id="' + id + '"'), id + " must not live in the quick card");
  }
  assert.ok(
    shortcutsCard.indexOf('id="capture-hotkey"') < shortcutsCard.indexOf('id="quick-hotkey"'),
    "capture shortcut row keeps its place above the quick translate row"
  );
  assert.match(shortcutsCard, /配置 Lexora 的全局快捷键。/);
  assert.match(shortcutsCard, /呼出快捷翻译/);
  assert.match(shortcutsCard, /点击后按下新的组合键；需含修饰键/);
  for (const id of ["quick-enabled", "quick-prompt", "quick-history-clear"]) {
    assert.ok(quickCard.includes('id="' + id + '"'), id + " must stay in the quick card");
  }
  assert.match(quickCard, /按快捷键呼出翻译面板，再次按下隐藏/);
  assert.match(quickCard, /最多保留 500 条/);
});

test("quick card wiring targets quickAPI and update_settings", () => {
  assert.match(source, /quickApiCall\("setHotkey"/);
  assert.match(source, /quickApiCall\("historyClear"/);
  assert.match(source, /renderHotkey\("quick"\)/);
  assert.match(source, /byId\("quick-enabled"\)\.addEventListener\("change"/);
  assert.match(source, /byId\("quick-history-clear"\)\.addEventListener/);
});

test("quick settings default to enabled Alt+Space and Chinese", () => {
  const defaults = quickSettingsHarness({}).quickSettings();
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.hotkey, "Alt+Space");
  assert.equal(defaults.targetLang, "zh");
  assert.equal(defaults.prompt, "");
  assert.equal(defaults.pinned, false);
  const stored = quickSettingsHarness({
    quick: { enabled: false, hotkey: "Ctrl+Alt+Q", targetLang: "en", prompt: "P {target}", pinned: true },
  }).quickSettings();
  assert.equal(stored.enabled, false);
  assert.equal(stored.hotkey, "Ctrl+Alt+Q");
  assert.equal(stored.targetLang, "en");
  assert.equal(stored.prompt, "P {target}");
  assert.equal(stored.pinned, true);
  const empty = quickSettingsHarness({
    quick: { hotkey: "   ", targetLang: "", prompt: 42, pinned: "1" },
  }).quickSettings();
  assert.equal(empty.hotkey, "Alt+Space");
  assert.equal(empty.targetLang, "zh");
  assert.equal(empty.prompt, "");
  assert.equal(empty.pinned, false);
});

test("quick card renders defaults and falls back to the built-in prompt", () => {
  const defaults = renderQuickHarness(undefined, { quickTranslate: "DEFAULT {target}" });
  assert.equal(defaults.nodes["quick-enabled"].checked, true);
  assert.equal(defaults.nodes["quick-prompt"].value, "DEFAULT {target}");
  assert.deepEqual(defaults.calls.hotkey, ["quick"]);
  const custom = renderQuickHarness({ enabled: false, prompt: "CUSTOM {target}" }, { quickTranslate: "DEFAULT" });
  assert.equal(custom.nodes["quick-enabled"].checked, false);
  assert.equal(custom.nodes["quick-prompt"].value, "CUSTOM {target}");
  const noDefaults = renderQuickHarness({ prompt: "" }, undefined);
  assert.equal(noDefaults.nodes["quick-prompt"].value, "");
});

test("quick card saves partial quick patches through update_settings", () => {
  const h = quickSaveHarness({ quickTranslate: "Default {target}" });
  h.context.saveQuickEnabled(false);
  h.context.saveQuickPromptValue("  Custom {target}  ");
  h.context.saveQuickPromptValue("Default {target}");
  h.context.saveQuickPromptValue("   ");
  assert.deepEqual(h.saves, [
    { quick: { enabled: false } },
    { quick: { prompt: "Custom {target}" } },
    { quick: { prompt: "" } },
    { quick: { prompt: "" } },
  ]);
  // Partial patches leave targetLang / pinned to the backend merge.
  assert.deepEqual(Object.keys(h.saves[0].quick), ["enabled"]);
  assert.deepEqual(Object.keys(h.saves[1].quick), ["prompt"]);
});

test("quick hotkey recorder saves through quickAPI.setHotkey", async () => {
  const h = quickHotkeyHarness({ ok: true, shortcut: "Ctrl+Alt+Q" });
  h.context.submitHotkey("quick", "Ctrl+Alt+Q");
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.setHotkey, ["Ctrl+Alt+Q"]);
  assert.equal(h.context.state.settings.quick.hotkey, "Ctrl+Alt+Q");
  assert.deepEqual(h.calls.toasts, ["呼出快捷键已更新"]);
  assert.equal(h.nodes["quick-hotkey-error"].hidden, true);
  assert.equal(h.context.hotkeyRecorders.quick.saving, false);
});

test("quick hotkey failure keeps the previous value and shows inline error", async () => {
  const h = quickHotkeyHarness({ ok: false, error: "快捷键被占用", hint: "请换一个组合" });
  h.context.submitHotkey("quick", "Ctrl+Alt+Q");
  await new Promise(setImmediate);
  assert.equal(h.context.state.settings.quick.hotkey, "Alt+Space");
  assert.equal(h.nodes["quick-hotkey-error"].hidden, false);
  assert.equal(h.nodes["quick-hotkey-error"].textContent, "快捷键被占用请换一个组合");
  assert.deepEqual(h.calls.toasts, []);
});

test("quick hotkey recorder degrades when quickAPI is unavailable", async () => {
  const h = quickHotkeyHarness(null, false);
  h.context.submitHotkey("quick", "Ctrl+Alt+Q");
  await new Promise(setImmediate);
  assert.match(h.nodes["quick-hotkey-error"].textContent, /当前版本不支持快捷翻译接口/);
  assert.equal(h.context.state.settings.quick.hotkey, "Alt+Space");
});

test("quick history clear calls quickAPI.historyClear and toasts", async () => {
  const toasts = [];
  const calls = [];
  const context = vm.createContext({
    Promise, Object,
    QUICK_API_ALIASES: { historyClear: ["historyClear", "quickHistoryClear"] },
    window: { quickAPI: { historyClear() { calls.push("clear"); return Promise.resolve({ ok: true }); } } },
    toast(message, tone) { toasts.push([message, tone]); },
  });
  for (const name of ["quickApiMethod", "quickApiCall", "clearQuickHistory"]) vm.runInContext(extract(name), context);
  context.clearQuickHistory();
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["clear"]);
  assert.deepEqual(toasts, [["已清空翻译历史", "success"]]);
});

test("quick prompt debounce saves after 500ms", () => {
  const nodes = { "quick-prompt": element("textarea", "textarea") };
  const saves = [];
  const timers = [];
  const context = vm.createContext({
    Promise, Object,
    state: { promptDefaults: { quickTranslate: "Default {target}" } },
    quickPromptDraft: null,
    quickPromptTimer: null,
    window: {
      setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
      clearTimeout() {},
    },
    byId: (id) => nodes[id] || null,
    save(patch) { saves.push(JSON.parse(JSON.stringify(patch))); },
    setInputValue() {},
  });
  for (const name of ["quickPromptDefault", "saveQuickPromptValue", "saveQuickPromptDraft", "flushQuickPromptDraft", "bindQuickPrompt"]) {
    vm.runInContext(extract(name), context);
  }
  context.bindQuickPrompt();
  nodes["quick-prompt"].value = "  Custom prompt  ";
  nodes["quick-prompt"].input();
  assert.equal(saves.length, 0);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 500);
  timers[0].fn();
  assert.deepEqual(saves, [{ quick: { prompt: "Custom prompt" } }]);
});
