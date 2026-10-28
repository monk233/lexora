const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { test } = require("node:test");
const picker = fs.readFileSync(path.join(__dirname, "picker.js"), "utf8");
const settings = fs.readFileSync(path.join(__dirname, "settings.js"), "utf8");
function extract(source, name) {
  const start = source.indexOf("  function " + name + "(");
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf("\n  }", start) + 4);
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  const pending = [], calls = [], nodes = [];
  const state = { panelOpen: true, panelCopyText: "", panelSpeakText: "" };
  const context = vm.createContext({ state, pronunciationRequest: null, Promise,
    API: { lookupPronunciation(text) { calls.push(text); return new Promise((resolve, reject) => pending.push({ resolve, reject })); } },
    el(tag, className, text) { const node = { tag, className, textContent: text }; nodes.push(node); return node; },
    requestOutputText(request) { return request.raw; },
    resizePanelForContent() {}, syncPanelFoot() {},
  });
  for (const name of ["lookupRequestPronunciation", "setPanelCopyText"]) vm.runInContext(extract(picker, name), context);
  function request() {
    const result = {};
    return { raw: "正文", result, target: { children: [result], insertBefore(node, before) {
      this.children.splice(this.children.indexOf(before), 0, node);
    } } };
  }
  return { context, state, pending, calls, nodes, request };
}
const verified = { ok: true, result: { status: "Verified", notation: "ipa", value: "/kreɪzi/" } };
test("verified pronunciation is separate from Markdown, included in copy and excluded from speech", async () => {
  const h = harness(), request = h.request();
  h.context.lookupRequestPronunciation(request, "crazy");
  await flush();
  assert.deepEqual(h.calls, ["crazy"]);
  h.state.panelSpeakText = request.raw;
  h.context.setPanelCopyText(request.raw);
  h.pending[0].resolve(verified);
  await flush();
  assert.equal(request.target.children[0].className, "pronunciation");
  assert.equal(request.target.children[0].textContent, "音标：/kreɪzi/");
  assert.equal(request.raw, "正文");
  assert.equal(h.state.panelCopyText, "音标：/kreɪzi/\n\n正文");
  assert.equal(h.state.panelSpeakText, "正文");
  h.context.setPanelCopyText("更新正文");
  assert.equal(h.state.panelCopyText, "音标：/kreɪzi/\n\n更新正文");
});
test("early pronunciation is retained when answer completes later", async () => {
  const h = harness(), request = h.request();
  h.context.lookupRequestPronunciation(request, "银行");
  await flush();
  h.pending[0].resolve({ ok: true, result: { status: "Verified", notation: "pinyin", value: "yín háng" } });
  await flush();
  h.context.setPanelCopyText(request.raw);
  assert.equal(h.state.panelCopyText, "拼音：yín háng\n\n正文");
});
test("unknown, ambiguous, not applicable, malformed and failed lookups stay silent", async () => {
  for (const response of [
    ...["Unknown", "Ambiguous", "NotApplicable"].map((status) => ({ ok: true, result: { status, notation: "ipa", value: "unverified" } })),
    { ok: true, result: { status: "Verified", notation: "ipa" } }, { ok: false }, null,
  ]) {
    const h = harness(), request = h.request();
    h.context.lookupRequestPronunciation(request, "carzy");
    await flush(); h.pending[0].resolve(response); await flush();
    assert.equal(h.nodes.length, 0);
    assert.equal(request.raw, "正文");
  }
  const h = harness();
  h.context.lookupRequestPronunciation(h.request(), "crazy");
  await flush(); h.pending[0].reject(new Error("offline")); await flush();
  assert.equal(h.nodes.length, 0);
});
test("new request and closed or hidden panels reject stale lookup results", async () => {
  for (const invalidate of [
    (h) => { h.context.pronunciationRequest = null; },
    (h) => { h.state.panelOpen = false; },
    (h) => { h.context.lookupRequestPronunciation(h.request(), "银行"); },
  ]) {
    const h = harness(), old = h.request();
    h.context.lookupRequestPronunciation(old, "crazy");
    await flush(); invalidate(h); h.pending[0].resolve(verified); await flush();
    assert.equal(h.nodes.length, 0);
  }
  for (const name of ["openPanel", "closePanel", "resetForHidden", "submitFollowup"]) {
    assert.match(extract(picker, name), /pronunciationRequest = null/);
  }
});
test("only text translation and explanation start pronunciation lookup", () => {
  assert.match(extract(picker, "translateSkill"), /lookupRequestPronunciation\(request, state.text\)/);
  assert.match(extract(picker, "assistSkill"), /if \(action === "explain"\) lookupRequestPronunciation/);
  for (const name of ["startCustomSkill", "startPolish", "beginImageRequest", "submitFollowup"]) {
    assert.doesNotMatch(extract(picker, name), /lookupRequestPronunciation\(/);
  }
});
test("word lookup mode normalizes and saves under picker; prompt editor saves and resets independently", () => {
  const patches = [];
  const context = vm.createContext({
    state: { settings: { picker: { prompts: { translate: "keep", wordLookup: "saved" } } }, promptDefaults: { wordLookup: "default" } },
    promptDrafts: {}, promptTimers: {}, save(patch) { patches.push(JSON.parse(JSON.stringify(patch))); },
  });
  for (const name of ["normalizeWordLookupMode", "saveWordLookupMode", "promptCustomValue", "promptDefault", "promptEditorValue", "savePromptValue", "savePromptDraft"])
    vm.runInContext(extract(settings, name), context);
  for (const mode of ["auto", "off", "prefer", "bad", undefined, " OFF ", " PREFER "]) {
    context.saveWordLookupMode(mode);
    assert.deepEqual(patches.at(-1), { picker: { wordLookupMode: ["off", "prefer"].includes(String(mode || "").trim().toLowerCase()) ? mode.trim().toLowerCase() : "auto" } });
  }
  assert.equal(context.promptEditorValue("wordLookup"), "saved");
  context.promptDrafts.wordLookup = "  edited  ";
  assert.equal(context.promptEditorValue("wordLookup"), "  edited  ");
  context.savePromptDraft("wordLookup");
  assert.deepEqual(patches.at(-1), { picker: { prompts: { wordLookup: "edited" } } });
  context.savePromptValue("wordLookup", "default");
  assert.deepEqual(patches.at(-1), { picker: { prompts: { wordLookup: "" } } });
  assert.equal(context.promptCustomValue("translate"), "keep");
});

test("word lookup editor input persists after blur and reset restores default", () => {
  const patches = [];
  function element(tag, className, text) {
    return { tag, className, textContent: text, children: [], value: "",
      setAttribute(key, value) { this[key] = value; },
      addEventListener(event, callback) { this[event] = callback; },
      appendChild(child) { this.children.push(child); },
    };
  }
  const textarea = {};
  const context = vm.createContext({
    state: { settings: { picker: { prompts: {} } }, promptDefaults: { wordLookup: "default dictionary" } },
    promptDrafts: {}, promptTimers: {},
    el: element, document: { createElement: (tag) => element(tag, "") },
    window: { setTimeout() { return 1; }, clearTimeout() {} },
    save(patch) { patches.push(JSON.parse(JSON.stringify(patch))); }, toast() {},
    byId(id) { return id === "word-lookup-prompt" ? { querySelector() { return textarea; } } : null; },
  });
  for (const name of ["promptCustomValue", "promptDefault", "promptEditorValue", "skillPromptPanel", "savePromptDraft", "flushPromptDraft", "savePromptValue", "resetPromptValue"])
    vm.runInContext(extract(settings, name), context);
  const panel = context.skillPromptPanel("wordLookup", { label: "单词查询" });
  const input = panel.children[0];
  assert.equal(input["data-prompt-input"], "wordLookup");
  assert.equal(input.value, "default dictionary");
  input.value = "new dictionary prompt"; input.input(); input.blur();
  assert.deepEqual(patches.at(-1), { picker: { prompts: { wordLookup: "new dictionary prompt" } } });
  context.resetPromptValue("wordLookup");
  assert.deepEqual(patches.at(-1), { picker: { prompts: { wordLookup: "" } } });
  assert.equal(textarea.value, "default dictionary");
});
