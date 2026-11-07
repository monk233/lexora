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
    selectedLocalModel: () => "", recommendedModelId: () => "", LP: { formatBytes: () => "1 GB", t: (key) => key },
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
  assert.equal(context.modelRole("hy-mt2-1.8b").label, "settings.modelRole.other");
  assert.equal(context.modelRole("").builtin, false);
  const row = context.localModelRow({ catalogId: "", file: "Hy-MT2-1.8B-Q4_K_M.gguf" });
  nodes["local-models"].appendChild(row);
  const button = row.querySelector(".btn-danger");
  button.click();
  assert.equal(button.textContent, "settings.action.confirmDelete");
  assert.equal(deletes, 0);
  timer();
  assert.equal(button.textContent, "settings.action.delete");
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
  assert.equal(nodes["restart-local"].textContent, "settings.status.restarting");
  assert.equal(nodes["restart-local"].disabled, true);
  assert.equal(nodes["stop-local"].disabled, true);
  assert.equal(context.restartLocal(), undefined, "Repeated actions are ignored while busy");
  releaseRestart({ ok: false, error: "重启失败", hint: "请检查模型" });
  await pending;
  assert.equal(nodes["restart-local"].textContent, "settings.action.restart");
  assert.equal(nodes["stop-local"].disabled, false);
  assert.equal(nodes["local-error"].hidden, false);
  assert.equal(nodes["local-error"].textContent, "重启失败请检查模型");
  console.log("PASS: model deletion confirmation, timeout and busy guard; restart visibility, busy guard and errors");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

const test = require("node:test");
function savingHarness() {
  const nodes = {};
  for (const id of ["local-state-badge", "start-local", "stop-local", "restart-local", "local-state-hint", "local-error", "app-language"]) nodes[id] = element("div", "");
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
    document: { activeElement: null },
    saveQueue: null, saving: false, savePending: null, localBusy: false, localAction: "",
    // Restart must not flush unrelated text drafts, including online API credentials.
    flushAllTextFields() { throw new Error("Unexpected text debounce flush"); },
    LP: { deepMerge: merge, t: (key) => key }, byId: (id) => nodes[id],
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
  for (const name of ["optimisticApply", "enqueuePatch", "flushSaveQueue", "save", "renderAppLanguage", "saveAppLanguage", "renderLocalState", "runLocalAction", "restartLocal"]) vm.runInContext(extract(name), context);
  context.renderAll = () => context.renderLocalState();
  context.applyState = () => {};
  context.refreshState = async () => { refreshes++; context.renderLocalState(); return { ok: true }; };
  return { context, nodes, saves, calls, refreshes: () => refreshes };
}
test("language select renders the saved value and saves changes", async () => {
  const h = savingHarness();
  h.context.state.settings.app = { language: "system" };
  h.nodes["app-language"] = element("select", "");
  h.context.renderAppLanguage();
  assert.equal(h.nodes["app-language"].value, "system");
  h.context.saveAppLanguage("en");
  await new Promise(setImmediate);
  // The patch literal comes from the vm realm, so compare its field instead of
  // deep-equaling prototypes across realms.
  assert.equal(h.saves.at(-1).patch.app.language, "en");
});
test("renderAll re-applies the localized save status after a language switch", () => {
  const nodes = { "save-status": element("div", ""), "save-status-text": element("span", "") };
  const locales = {
    zh: { idle: "所有更改自动保存", saved: "已保存" },
    en: { idle: "All changes are saved automatically", saved: "Saved" },
  };
  let locale = "zh";
  let updateRenders = 0;
  const context = vm.createContext({
    Object, Promise,
    state: {},
    saveStatus: { kind: "idle", message: "" },
    saveStatusTimer: null,
    renderedLocale: "",
    window: { setTimeout: () => 1, clearTimeout() {} },
    byId: (id) => nodes[id],
    LP: { t: (key) => locales[locale][key.split(".").pop()], i18n: { currentLocale: () => locale } },
  });
  for (const name of ["saveStatusText", "renderSaveStatus", "setSaveStatus", "renderLocale", "renderAll"]) {
    vm.runInContext(extract(name), context);
  }
  // applyStatic is not involved here: renderAll must re-apply the tracked state.
  // renderAll also renders the quick-translate card (master): stub it like the
  // other state-dependent renderers extracted from the same function.
  for (const name of ["renderMode", "renderProviderBadge", "renderOnline", "renderLocal", "renderPicker", "renderQuick", "renderApp", "renderAbout", "renderApiKeyVisibility", "renderUpdateNotesToggle"]) {
    context[name] = () => {};
  }
  // The update card has no static fallback for its message, so renderAll must
  // re-render it exactly when the locale changed.
  context.renderUpdate = () => { updateRenders += 1; };
  context.setSaveStatus("saved");
  assert.equal(nodes["save-status-text"].textContent, "已保存");
  assert.equal(nodes["save-status"].getAttribute("data-state"), "saved");
  context.renderAll();
  assert.equal(updateRenders, 1, "renderAll renders the update card on the first pass");
  locale = "en";
  context.renderAll();
  assert.equal(nodes["save-status-text"].textContent, "Saved");
  assert.equal(nodes["save-status"].getAttribute("data-state"), "saved");
  assert.equal(updateRenders, 2, "renderAll refreshes the update card on each locale change");
  context.renderAll();
  assert.equal(updateRenders, 2, "an unchanged locale leaves the update card alone");
});
test("local model cards and catalog rows rebuild local labels after a language switch", () => {
  function listNode() {
    const node = element("div", "");
    Object.defineProperty(node, "innerHTML", {
      get() { return ""; },
      set() { node.children.length = 0; },
    });
    return node;
  }
  function textOf(node) {
    return [node.textContent || ""].concat(node.children.map(textOf)).join(" ");
  }
  const nodes = {
    "engine-dot": element("div", ""),
    "engine-title": element("div", ""),
    "engine-sub": element("div", ""),
    "download-engine": element("div", ""),
    "cancel-engine-download": element("div", ""),
    "local-models": listNode(),
    "local-models-hint": element("div", ""),
    catalog: element("section", ""),
    "catalog-list": listNode(),
    "toggle-catalog": element("button", ""),
  };
  const state = {
    engine: { engineAvailable: true, localState: "ready" },
    models: [
      {
        file: "qwen3.5-2b-q3-k-m.gguf",
        name: "Qwen3.5 2B Q3_K_M",
        catalogId: "qwen3.5-2b-q3-k-m",
        sizeBytes: 1117320736,
      },
      { file: "legacy.gguf", name: "Legacy", catalogId: "", sizeBytes: 42 },
    ],
    catalog: [
      {
        id: "qwen3.5-2b-q3-k-m",
        name: "Qwen3.5 2B Q3_K_M",
        filename: "qwen3.5-2b-q3-k-m.gguf",
        sizeBytes: 1117320736,
        vision: true,
        installed: true,
      },
    ],
    settings: {
      provider: { local: { selectedModel: "qwen3.5-2b-q3-k-m" } },
    },
  };
  const context = vm.createContext({
    Object,
    Promise,
    window: {},
    document: { createElement: element },
    state,
    catalogOpen: true,
    localBusy: false,
    localAction: "",
    removingModels: Object.create(null),
    byId: (id) => nodes[id],
    el: element,
    isQwen35: (id) => /^qwen3\.5-(?:0\.8b|2b|4b)-q[34]-k-m$/.test(String(id || "")),
    selectedLocalModel: () => "qwen3.5-2b-q3-k-m",
    recommendedModelId: () => "qwen3.5-2b-q3-k-m",
    activeDownload: () => null,
    activeModelDownloadIds: () => [],
    setTone() {},
    setHidden(node, hidden) { node.hidden = hidden; },
    renderEngineProgress() {},
    renderHardwareRecommendation() {},
    renderLocalState() {},
    updateCatalogProgress() {},
    toast() {},
    save() {},
    API: {},
  });
  for (const file of ["constants.js", "messages.zh.js", "messages.en.js", "i18n.js"]) {
    vm.runInContext(
      fs.readFileSync(require("node:path").join(__dirname, "shared", file), "utf8"),
      context
    );
  }
  context.LP = context.window.LP;
  context.LP.i18n.init("zh");
  for (const name of ["modelRole", "localModelRow", "catalogRow", "renderLocale", "renderCatalog", "renderLocal"]) {
    vm.runInContext(extract(name), context);
  }

  context.renderLocal();
  const cards = nodes["local-models"];
  const catalog = nodes["catalog-list"];
  assert.match(textOf(cards), /翻译 \/ 通用 \/ 视觉/);
  assert.match(textOf(cards), /已选择/);
  assert.match(textOf(cards), /推荐/);
  assert.match(textOf(cards), /删除/);
  assert.match(textOf(catalog), /已安装/);
  const zhCard = cards.children[0];

  // An unchanged locale must keep the already-built rows.
  context.renderLocal();
  assert.equal(cards.children[0], zhCard, "same-locale render keeps the model card");

  context.LP.i18n.init("en");
  context.renderLocal();
  assert.notEqual(cards.children[0], zhCard, "language switch rebuilds the model card");
  assert.match(textOf(cards), /Translation \/ General \/ Vision/);
  assert.match(textOf(cards), /Selected/);
  assert.match(textOf(cards), /Recommended/);
  assert.match(textOf(cards), /Delete/);
  assert.match(textOf(catalog), /Installed/);
  assert.doesNotMatch(textOf(cards), /翻译 \/ 通用 \/ 视觉|已选择|推荐/);
});

test("the API key toggle label follows its expanded state across a language switch", () => {
  const nodes = {
    "api-key-toggle": element("button", ""),
    "online-api-key": Object.assign(element("input", ""), { type: "text" }),
  };
  const labels = {
    zh: { show: "显示 API Key", hide: "隐藏 API Key" },
    en: { show: "Show API key", hide: "Hide API key" },
  };
  let locale = "zh";
  const context = vm.createContext({
    Object,
    byId: (id) => nodes[id],
    LP: { t: (key) => labels[locale][key.split(".").pop()] },
  });
  vm.runInContext(extract("renderApiKeyVisibility"), context);
  context.renderApiKeyVisibility();
  assert.equal(nodes["api-key-toggle"].title, "隐藏 API Key");
  assert.equal(nodes["api-key-toggle"].getAttribute("aria-pressed"), "true");
  locale = "en";
  context.renderApiKeyVisibility();
  assert.equal(nodes["api-key-toggle"].getAttribute("aria-label"), "Hide API key");
  nodes["online-api-key"].type = "password";
  context.renderApiKeyVisibility();
  assert.equal(nodes["api-key-toggle"].title, "Show API key");
  assert.equal(nodes["api-key-toggle"].getAttribute("aria-pressed"), "false");
});
test("blacklist chip aria labels follow a language switch", () => {
  const nodes = { "blacklist-chips": element("div", "") };
  Object.defineProperty(nodes["blacklist-chips"], "innerHTML", {
    get() { return ""; },
    set() { nodes["blacklist-chips"].children.length = 0; },
  });
  const labels = { zh: "移除 {name}", en: "Remove {name}" };
  let locale = "zh";
  const context = vm.createContext({
    Object,
    state: { settings: { picker: { blacklist: ["example.com"] } } },
    byId: (id) => nodes[id],
    el: element,
    LP: {
      t: (key, params) => (labels[locale] || key).replace("{name}", params && params.name),
      i18n: { currentLocale: () => locale },
    },
  });
  for (const name of ["renderLocale", "renderBlacklist"]) vm.runInContext(extract(name), context);
  context.renderBlacklist();
  assert.equal(nodes["blacklist-chips"].children.length, 1);
  assert.equal(
    nodes["blacklist-chips"].children[0].children[1].getAttribute("aria-label"),
    "移除 example.com"
  );
  locale = "en";
  context.renderBlacklist();
  assert.equal(nodes["blacklist-chips"].children.length, 1);
  assert.equal(
    nodes["blacklist-chips"].children[0].children[1].getAttribute("aria-label"),
    "Remove example.com"
  );
});
test("update card copy is localized at render time after a language switch", () => {
  const nodes = {};
  for (const id of ["update-status", "update-message", "check-update", "update-notes", "update-meta", "update-actions", "update-progress", "update-error"]) {
    nodes[id] = element("div", "");
  }
  const pack = {
    zh: {
      "settings.update.latest": "已是最新版本 v{version}",
      "settings.action.recheck": "重新检查",
      "settings.error.checkUpdate": "无法检查更新",
    },
    en: {
      "settings.update.latest": "Already on the latest version v{version}",
      "settings.action.recheck": "Check again",
      "settings.error.checkUpdate": "Could not check for updates",
    },
  };
  let locale = "zh";
  const context = vm.createContext({
    Object,
    updateState: "latest",
    updateInfo: { latestVersion: "9.9.9" },
    updateErrorKey: "",
    updateErrorText: "",
    updateErrorHint: "",
    updateProgressPercent: 0,
    updateNotesExpanded: false,
    updateCurrentVersion: () => "1.0.0",
    byId: (id) => nodes[id],
    setHidden(node, hidden) { if (node) node.hidden = hidden; },
    hideInlineError(node) { if (node) { node.hidden = true; node.textContent = ""; } },
    showInlineError(node, error, hint) { if (node) { node.hidden = false; node.textContent = error + (hint || ""); } },
    renderUpdateNotes() {},
    renderUpdateProgress() {},
    LP: {
      t: (key, params) => String((pack[locale] && pack[locale][key]) || key)
        .replace("{version}", (params && params.version) || ""),
      formatBytes: () => "1 MB",
    },
  });
  vm.runInContext(extract("renderUpdate"), context);
  context.renderUpdate();
  assert.equal(nodes["update-message"].textContent, "已是最新版本 v9.9.9");
  assert.equal(nodes["check-update"].textContent, "重新检查");
  locale = "en";
  context.renderUpdate();
  assert.equal(nodes["update-message"].textContent, "Already on the latest version v9.9.9");
  assert.equal(nodes["check-update"].textContent, "Check again");
  // Error title is a key kept in state: switching language must retranslate it
  // instead of replaying the string captured in the previous language.
  locale = "zh";
  context.updateState = "error";
  context.updateErrorKey = "settings.error.checkUpdate";
  context.updateErrorText = "boom";
  context.renderUpdate();
  assert.equal(nodes["update-message"].textContent, "无法检查更新");
  locale = "en";
  context.renderUpdate();
  assert.equal(nodes["update-message"].textContent, "Could not check for updates");
  assert.equal(nodes["update-error"].textContent, "boom");
});
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
const QUICK_DEFAULTS = { enabled: true, hotkey: "Alt+Space", targetLang: "zh", prompt: "", wordLookupPrompt: "", pinned: false };

/* Mirrors `QUICK_PROMPT_SLOTS` in settings.js. */
const QUICK_PROMPT_SLOTS = {
  paragraph: { input: "quick-prompt", reset: "quick-prompt-reset", field: "prompt", defaultKey: "quickTranslate" },
  word: { input: "quick-word-prompt", reset: "quick-word-prompt-reset", field: "wordLookupPrompt", defaultKey: "quickTranslateWordLookup" },
};

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
    "quick-word-prompt": element("textarea", ""),
  };
  const calls = { checked: [], values: [], hotkey: [] };
  const context = vm.createContext({
    Promise, Object,
    state: { settings: quick === undefined ? {} : { quick }, promptDefaults },
    QUICK_DEFAULTS,
    QUICK_PROMPT_SLOTS,
    quickPromptDrafts: { paragraph: null, word: null },
    byId: (id) => nodes[id] || null,
    setChecked(node, value) { node.checked = value; calls.checked.push(value); },
    setInputValue(node, value) { node.value = value; calls.values.push(value); },
    renderHotkey(target) { calls.hotkey.push(target); },
  });
  for (const name of ["quickSettings", "quickPromptDefault", "quickPromptCustomValue", "quickPromptEditorValue", "renderQuickPrompt", "renderQuick"]) {
    vm.runInContext(extract(name), context);
  }
  context.renderQuick();
  return { context, nodes, calls };
}

function quickSaveHarness(promptDefaults) {
  const nodes = {
    "quick-prompt": element("textarea", "textarea"),
    "quick-word-prompt": element("textarea", "textarea"),
  };
  const saves = [];
  const toasts = [];
  const context = vm.createContext({
    Promise, Object,
    state: { promptDefaults },
    QUICK_PROMPT_SLOTS,
    quickPromptDrafts: { paragraph: null, word: null },
    quickPromptTimers: { paragraph: null, word: null },
    window: { clearTimeout() {} },
    byId: (id) => nodes[id] || null,
    save(patch) { saves.push(JSON.parse(JSON.stringify(patch))); },
    setInputValue(node, value) { if (node) node.value = value; },
    toast(message) { toasts.push(message); },
  });
  for (const name of ["quickPromptDefault", "saveQuickPromptValue", "saveQuickPromptDraft", "flushQuickPromptDraft", "resetQuickPrompt", "saveQuickEnabled"]) {
    vm.runInContext(extract(name), context);
  }
  return { context, saves, nodes, toasts };
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
    LP: { deepMerge: mergePatch, t: (key) => key },
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
  for (const id of ["quick-enabled", "quick-hotkey", "quick-hotkey-restore", "quick-hotkey-error", "quick-prompt", "quick-prompt-reset", "quick-word-prompt", "quick-word-prompt-reset", "quick-history-clear"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing #" + id);
  }
  assert.match(html, /<textarea[^>]*id="quick-prompt"[^>]*maxlength="4000"/s);
  assert.match(html, /<textarea[^>]*id="quick-word-prompt"[^>]*maxlength="4000"/s);
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
  // The shortcuts card is localized (i18n R1): both rows carry message keys,
  // while the quick-translate card keeps master's untranslated Chinese copy.
  assert.match(shortcutsCard, /data-i18n="settings.card.shortcuts.desc"/);
  assert.match(shortcutsCard, /data-i18n="settings.field.captureHotkey"/);
  assert.match(shortcutsCard, /data-i18n="settings.field.quickHotkey"/);
  assert.match(shortcutsCard, /data-i18n="settings.hint.quickHotkey"/);
  assert.match(shortcutsCard, /data-i18n-title="settings.action.quickHotkeyTitle"/);
  assert.match(shortcutsCard, /data-i18n="settings.action.restoreDefault"/);
  const hotkeyLabels = [...shortcutsCard.matchAll(/data-i18n="(settings\.[^"]+)"/g)].map((match) => match[1]);
  assert.ok(hotkeyLabels.includes("settings.field.captureHotkey"));
  assert.ok(hotkeyLabels.includes("settings.hint.captureHotkey"));
  for (const id of ["quick-enabled", "quick-prompt", "quick-prompt-reset", "quick-word-prompt", "quick-word-prompt-reset", "quick-history-clear"]) {
    assert.ok(quickCard.includes('id="' + id + '"'), id + " must stay in the quick card");
  }
  for (const id of ["quick-prompt", "quick-word-prompt"]) {
    assert.ok(!shortcutsCard.includes('id="' + id + '"'), id + " must not live in the shortcuts card");
  }
  assert.match(quickCard, /段落 \/ 长句提示词/);
  assert.match(quickCard, /单词 \/ 短语提示词/);
  assert.match(quickCard, /\{source\} 与 \{target\} 占位符/);
  assert.match(quickCard, /自动识别源语言时 \{source\} 使用检测到的语言/);
  assert.match(quickCard, /按快捷键呼出翻译面板，再次按下隐藏/);
  assert.match(quickCard, /最多保留 500 条/);
});

test("quick card wiring targets quickAPI and update_settings", () => {
  assert.match(source, /quickApiCall\("setHotkey"/);
  assert.match(source, /quickApiCall\("historyClear"/);
  assert.match(source, /renderHotkey\("quick"\)/);
  assert.match(source, /byId\("quick-enabled"\)\.addEventListener\("change"/);
  assert.match(source, /byId\("quick-history-clear"\)\.addEventListener/);
  assert.match(source, /byId\("quick-word-prompt-reset"\)\.addEventListener/);
  assert.match(source, /wordLookupPrompt/);
});

test("quick settings default to enabled Alt+Space and Chinese", () => {
  const defaults = quickSettingsHarness({}).quickSettings();
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.hotkey, "Alt+Space");
  assert.equal(defaults.targetLang, "zh");
  assert.equal(defaults.prompt, "");
  assert.equal(defaults.wordLookupPrompt, "");
  assert.equal(defaults.pinned, false);
  const stored = quickSettingsHarness({
    quick: { enabled: false, hotkey: "Ctrl+Alt+Q", targetLang: "en", prompt: "P {source} {target}", wordLookupPrompt: "W {source} {target}", pinned: true },
  }).quickSettings();
  assert.equal(stored.enabled, false);
  assert.equal(stored.hotkey, "Ctrl+Alt+Q");
  assert.equal(stored.targetLang, "en");
  assert.equal(stored.prompt, "P {source} {target}");
  assert.equal(stored.wordLookupPrompt, "W {source} {target}");
  assert.equal(stored.pinned, true);
  const empty = quickSettingsHarness({
    quick: { hotkey: "   ", targetLang: "", prompt: 42, wordLookupPrompt: 7, pinned: "1" },
  }).quickSettings();
  assert.equal(empty.hotkey, "Alt+Space");
  assert.equal(empty.targetLang, "zh");
  assert.equal(empty.prompt, "");
  assert.equal(empty.wordLookupPrompt, "");
  assert.equal(empty.pinned, false);
});

test("quick card renders both prompt defaults and custom values", () => {
  const defaults = renderQuickHarness(undefined, { quickTranslate: "DEFAULT {target}", quickTranslateWordLookup: "WORDDEFAULT {source}" });
  assert.equal(defaults.nodes["quick-enabled"].checked, true);
  assert.equal(defaults.nodes["quick-prompt"].value, "DEFAULT {target}");
  assert.equal(defaults.nodes["quick-word-prompt"].value, "WORDDEFAULT {source}");
  assert.deepEqual(defaults.calls.hotkey, ["quick"]);
  const custom = renderQuickHarness(
    { enabled: false, prompt: "CUSTOM {target}", wordLookupPrompt: "WORDCUSTOM {source}" },
    { quickTranslate: "DEFAULT", quickTranslateWordLookup: "WORDDEFAULT" }
  );
  assert.equal(custom.nodes["quick-enabled"].checked, false);
  assert.equal(custom.nodes["quick-prompt"].value, "CUSTOM {target}");
  assert.equal(custom.nodes["quick-word-prompt"].value, "WORDCUSTOM {source}");
  const noDefaults = renderQuickHarness({ prompt: "", wordLookupPrompt: "" }, undefined);
  assert.equal(noDefaults.nodes["quick-prompt"].value, "");
  assert.equal(noDefaults.nodes["quick-word-prompt"].value, "");
});

test("quick card saves partial quick patches through update_settings", () => {
  const h = quickSaveHarness({ quickTranslate: "Default {target}", quickTranslateWordLookup: "Word default {source}" });
  h.context.saveQuickEnabled(false);
  h.context.saveQuickPromptValue("paragraph", "  Custom {target}  ");
  h.context.saveQuickPromptValue("paragraph", "Default {target}");
  h.context.saveQuickPromptValue("paragraph", "   ");
  h.context.saveQuickPromptValue("word", "  Custom word {source}  ");
  h.context.saveQuickPromptValue("word", "Word default {source}");
  assert.deepEqual(h.saves, [
    { quick: { enabled: false } },
    { quick: { prompt: "Custom {target}" } },
    { quick: { prompt: "" } },
    { quick: { prompt: "" } },
    { quick: { wordLookupPrompt: "Custom word {source}" } },
    { quick: { wordLookupPrompt: "" } },
  ]);
  // Partial patches leave targetLang / pinned / the other prompt to the merge.
  assert.deepEqual(Object.keys(h.saves[0].quick), ["enabled"]);
  assert.deepEqual(Object.keys(h.saves[1].quick), ["prompt"]);
  assert.deepEqual(Object.keys(h.saves[4].quick), ["wordLookupPrompt"]);
});

test("quick prompt reset clears custom values and restores both defaults", () => {
  const h = quickSaveHarness({ quickTranslate: "Default {target}", quickTranslateWordLookup: "Word default {source}" });
  h.context.resetQuickPrompt("paragraph");
  h.context.resetQuickPrompt("word");
  assert.deepEqual(h.saves, [
    { quick: { prompt: "" } },
    { quick: { wordLookupPrompt: "" } },
  ]);
  assert.equal(h.nodes["quick-prompt"].value, "Default {target}");
  assert.equal(h.nodes["quick-word-prompt"].value, "Word default {source}");
  assert.deepEqual(h.toasts, ["已重置为默认提示词", "已重置为默认提示词"]);
});

test("quick hotkey recorder saves through quickAPI.setHotkey", async () => {
  const h = quickHotkeyHarness({ ok: true, shortcut: "Ctrl+Alt+Q" });
  h.context.submitHotkey("quick", "Ctrl+Alt+Q");
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.setHotkey, ["Ctrl+Alt+Q"]);
  assert.equal(h.context.state.settings.quick.hotkey, "Ctrl+Alt+Q");
  assert.deepEqual(h.calls.toasts, ["settings.toast.quickHotkeySaved"]);
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

test("quick prompt debounce saves after 500ms per editor", () => {
  const nodes = {
    "quick-prompt": element("textarea", "textarea"),
    "quick-word-prompt": element("textarea", "textarea"),
  };
  const saves = [];
  const timers = [];
  const context = vm.createContext({
    Promise, Object,
    state: { promptDefaults: { quickTranslate: "Default {target}", quickTranslateWordLookup: "Word default {source}" } },
    QUICK_PROMPT_SLOTS,
    quickPromptDrafts: { paragraph: null, word: null },
    quickPromptTimers: { paragraph: null, word: null },
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
  context.bindQuickPrompt("paragraph");
  context.bindQuickPrompt("word");
  nodes["quick-prompt"].value = "  Custom prompt  ";
  nodes["quick-prompt"].input();
  nodes["quick-word-prompt"].value = "  Custom word  ";
  nodes["quick-word-prompt"].input();
  assert.equal(saves.length, 0);
  assert.equal(timers.length, 2);
  assert.deepEqual(timers.map((timer) => timer.delay), [500, 500]);
  timers[0].fn();
  timers[1].fn();
  assert.deepEqual(saves, [
    { quick: { prompt: "Custom prompt" } },
    { quick: { wordLookupPrompt: "Custom word" } },
  ]);
});
