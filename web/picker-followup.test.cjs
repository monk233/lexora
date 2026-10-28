const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "picker.js"), "utf8");
function extract(name) {
  const pattern = new RegExp("  (?:async )?function " + name + "\\(");
  const start = source.search(pattern);
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf("\n  }", start) + 4);
}
function node(tag, className, text) {
  return {
    tag, className, textContent: text || "",
    hidden: true, value: "", disabled: false, style: {}, children: [],
    classList: { remove() {}, toggle() {} },
    appendChild(child) { this.children.push(child); child.parentNode = this; },
    removeChild(child) { this.children = this.children.filter((item) => item !== child); child.parentNode = null; },
    addEventListener(event, handler) { this[event] = handler; }, focus() {},
    set innerHTML(value) { this.children = []; },
  };
}
function harness(available = true, streamOnly = false) {
  let sequence = 0;
  const calls = [];
  const pending = [];
  const cancelled = [];
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  function advance(ms) {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.at <= now) { timers.delete(id); timer.fn(); }
    }
  }
  const state = {
    text: "原文", panelOpen: true, panelMode: "scroll", suggestionsAvailable: available,
    followupSession: 0, suggestionVersion: 0, suggestionRound: -1,
    followupHistory: [], initialAnswer: "", followupAnswer: "", followupBusy: false,
  };
  const context = vm.createContext({
    state, Promise, String, Array, Math, Date: { now: () => now },
    panelFollowup: node(), panelFollowupInput: node(), panelFollowupSend: node(),
    panelSuggestions: node(), panelBody: node(), panel: node(), pickerEl: node(),
    activeRequest: null, suggestionRequest: null, suggestionCancellation: null, suggestionPrefetch: null,
    window: { requestAnimationFrame(fn) { fn(); },
      setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
      clearTimeout(id) { timers.delete(id); } },
    el: node, makeRequestId: () => "request-" + ++sequence,
    resizePanelForContent() {}, renderRequestResult() {}, renderMarkdownInto() {}, renderTranslationDraft() {},
    requestOutputText: (request) => request.raw, plainFromMarkdown: (text) => text,
    setPanelSpeakText() {}, setPanelCopyText() {}, removeLoadingRow() {},
    emptyResultMessage() {}, failTranslation() { assert.fail("Unexpected main failure"); },
    friendlyError: String, showToast() { assert.fail("Unexpected toast"); },
    appendFollowupBlock() { return { block: node(), answer: node(), loading: node() }; },
    abortActiveRequest() {}, stopSpeech() {}, setInputActivated() {}, syncPanelPin() {},
    notifyPanelState() {}, closeMenu() {}, scheduleToolbarResize() {}, PICKER_SURFACE: "panel",
    API: {
      cancelFollowups(id) { cancelled.push(id); return Promise.resolve({ ok: true }); },
      generateFollowups(...args) {
        calls.push(args);
        return new Promise((resolve, reject) => pending.push({ resolve, reject, id: args[0] }));
      },
      followup(...args) { calls.push(["followup", ...args]); return Promise.resolve({ ok: true }); },
      captureFollowup(...args) { calls.push(["capture", ...args]); return Promise.resolve({ ok: true }); },
    },
  });
  for (const name of ["cancelFollowupSuggestions", "runAfterSuggestions", "syncFollowupOverlay", "resetFollowup", "invalidateFollowupSuggestions",
    "showPrefetchedSuggestions", "finishFollowupSuggestions", "guardRepetition", "handleTranslateEvent", "refreshFollowupSuggestions", "setFollowupSuggestions", "enableFollowup", "setFollowupBusy",
    "submitFollowup", "finishFollowup", "failFollowup", "finishTranslation", "resetForHidden", "closePanel"])
    vm.runInContext(extract(name), context);
  // Legacy completion tests model an already received final chunk.
  for (const name of streamOnly ? [] : ["enableFollowup", "finishTranslation", "finishFollowup"]) {
    const original = context[name];
    context[name] = (request) => {
      if (request && request.active !== false) context.refreshFollowupSuggestions(request);
      return original(request);
    };
  }
  return { context, state, calls, pending, cancelled, advance, timers, elapse(ms) { now += ms; } };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("every text/image AI success uses the shared suggestion controller", async () => {
  for (const request of [
    { kind: "translate" }, { kind: "assist", action: "summarize" },
    { kind: "assist", action: "explain" }, { kind: "polish" },
    { kind: "custom", skillId: "custom-text" },
    ...["ocr", "translate", "explain", "custom"].map((imageAction) => ({ kind: "image", imageAction })),
  ]) {
    const { context, state, calls, pending } = harness();
    context.finishTranslation({ ...request, active: true, raw: "初始回答" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], request.skillId || request.imageAction || request.action || request.kind);
    assert.equal(calls[0][2], "原文");
    assert.equal(calls[0][3], "初始回答");
    await context.refreshFollowupSuggestions();
    assert.equal(calls.length, 1, "Repeated rendering uses the current-round cache");
    pending[0].resolve({ ok: true, requestId: pending[0].id, suggestions: ["问题一", "问题二", "问题三"] });
    await flush();
    assert.equal(context.panelSuggestions.children.length, 3);
    assert.equal(state.initialAnswer, "初始回答");
  }
  assert.doesNotMatch(source, /function (?:wordSuggestions|singleEnglishWord)\(/);
  const runSkill = extract("runSkill");
  assert.doesNotMatch(runSkill, /refreshFollowupSuggestions|enableFollowup/);
});

test("missing general model hides all follow-up UI without calling generation", async () => {
  const { context, calls } = harness(false);
  context.finishTranslation({ active: true, kind: "translate", raw: "翻译仍成功" });
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(context.panelFollowup.hidden, true);
  assert.equal(context.panelSuggestions.hidden, true);
  context.submitFollowup("不能发送");
  assert.equal(calls.length, 0);
});

test("three rounds retain the original answer and ordered complete history", async () => {
  const { context, state, calls, advance } = harness();
  context.enableFollowup({ kind: "polish", raw: "初始回答" });
  for (let round = 1; round <= 3; round++) {
    context.submitFollowup("问题" + round);
    await flush();
    const request = context.activeRequest;
    const call = calls.findLast((args) => args[0] === "followup");
    assert.equal(call[3], "初始回答");
    assert.equal(call[5].length, round - 1);
    advance(50);
    request.raw = "回答" + round;
    context.finishFollowup(request);
    context.finishFollowup(request);
    await flush();
    assert.equal(state.followupHistory.length, round, "Done events cannot duplicate history");
    assert.equal(calls.at(-1)[3], "初始回答");
    assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1)[4])),
      Array.from({ length: round }, (_, i) => ({ question: "问题" + (i + 1), answer: i === round - 1 ? "" : "回答" + (i + 1) })));
  }
  assert.equal(state.initialAnswer, "初始回答");
  assert.equal(state.followupAnswer, "初始回答");
  await flush();
});

test("empty, failed, rejected and malformed suggestions preserve the main result and input", async () => {
  for (const mode of ["empty", "failed", "reject", "malformed", "wrong-id"]) {
    const { context, state, pending } = harness();
    context.finishTranslation({ active: true, kind: "image", imageAction: "ocr", raw: "识别结果" });
    if (mode === "reject") pending[0].reject(new Error("offline"));
    else pending[0].resolve({ ok: mode !== "failed", requestId: mode === "wrong-id" ? "old" : pending[0].id,
      suggestions: mode === "malformed" ? [null, {}, " "] : [] });
    await flush();
    assert.equal(context.panelSuggestions.hidden, true);
    assert.equal(context.panelFollowup.hidden, false);
    assert.equal(context.panelFollowupInput.disabled, false);
    assert.equal(state.initialAnswer, "识别结果");
  }
});

test("new task, close, hide and follow-up invalidate late suggestion responses", async () => {
  for (const action of ["resetFollowup", "closePanel", "resetForHidden", "submitFollowup"]) {
    const { context, state, pending } = harness();
    context.enableFollowup({ kind: "translate", raw: "初始回答" });
    context[action]("新问题");
    pending[0].resolve({ ok: true, requestId: pending[0].id, suggestions: ["过期建议"] });
    await flush();
    assert.equal(context.panelSuggestions.hidden, true, action);
    if (action !== "submitFollowup") assert.equal(state.initialAnswer, "");
  }
});

test("latest session and latest round win even when old generation finishes last", async () => {
  const { context, pending } = harness();
  context.enableFollowup({ kind: "translate", raw: "旧回答" });
  context.resetFollowup();
  context.enableFollowup({ kind: "polish", raw: "新回答" });
  await flush();
  pending[1].resolve({ ok: true, requestId: pending[1].id, suggestions: ["新建议"] });
  await flush();
  pending[0].resolve({ ok: true, requestId: pending[0].id, suggestions: ["旧建议"] });
  await flush();
  assert.equal(context.panelSuggestions.children.length, 1);
  assert.equal(context.panelSuggestions.children[0].textContent, "新建议");
  assert.equal(context.state.initialAnswer, "新回答");
});

test("failed follow-up retry appends history only on success", async () => {
  const { context, state } = harness();
  context.enableFollowup({ kind: "translate", raw: "初始回答" });
  context.submitFollowup("问题");
  await flush();
  const failed = context.activeRequest;
  context.failFollowup(failed, "offline");
  assert.equal(state.followupHistory.length, 0);
  const error = failed.block.children[0];
  error.children.at(-1).click();
  await flush();
  context.activeRequest.raw = "重试成功";
  context.finishFollowup(context.activeRequest);
  assert.equal(state.followupHistory.length, 1);
  assert.equal(state.followupHistory[0].question, "问题");
  assert.equal(state.initialAnswer, "初始回答");
  await flush();
});

test("old failed retry clicks preserve its block while another round is busy", async () => {
  const { context, state, calls } = harness();
  context.enableFollowup({ kind: "translate", raw: "初始回答" });
  context.submitFollowup("旧问题");
  await flush();
  const failed = context.activeRequest;
  context.panelBody.appendChild(failed.block);
  context.failFollowup(failed, "offline");
  const retry = failed.block.children[0].children.at(-1);
  context.submitFollowup("新问题");
  await flush();
  const current = context.activeRequest, count = calls.length;
  retry.click(); retry.click();
  assert.equal(state.followupBusy, true);
  assert.equal(context.activeRequest, current);
  assert.equal(failed.block.parentNode, context.panelBody);
  assert.equal(calls.length, count);
  assert.equal(state.followupHistory.length, 0);
});

test("image follow-up preserves initial context and rejects the previous round's suggestions", async () => {
  const { context, state, calls, pending, advance } = harness();
  state.image = { action: "explain" };
  context.enableFollowup({ kind: "image", imageAction: "explain", raw: "图片初始回答" });
  context.submitFollowup("图片细节");
  await flush();
  assert.equal(calls.at(-1)[0], "capture");
  assert.equal(calls.at(-1)[3], "图片初始回答");
  advance(50);
  context.activeRequest.raw = "图片细节回答";
  context.finishFollowup(context.activeRequest);
  await flush();
  pending[1].resolve({ ok: true, requestId: pending[1].id, suggestions: ["当前轮建议"] });
  await flush();
  pending[0].resolve({ ok: true, requestId: pending[0].id, suggestions: ["上一轮建议"] });
  await flush();
  assert.equal(context.panelSuggestions.children[0].textContent, "当前轮建议");
});

test("live Tauri wrapper sends the exact camelCase command contract", async () => {
  const calls = [];
  const window = { location: { search: "" }, __TAURI__: {
    core: { invoke(command, args) { calls.push({ command, args }); return Promise.resolve({ ok: true, requestId: args.requestId, suggestions: [] }); } },
    event: { listen() { return Promise.resolve(() => {}); } },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "shared/tauri-api.js"), "utf8"), { window, console });
  const history = [{ question: "问题", answer: "回答" }];
  await window.pickerAPI.generateFollowups("live-1", "custom-text", "原文", "初始回答", history);
  await window.pickerAPI.cancelFollowups("live-1");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ command: "generate_followups", args: {
    requestId: "live-1", skill: "custom-text", source: "原文", initialAnswer: "初始回答", history,
  } }, { command: "cancel_followups", args: { requestId: "live-1" } }]);
});

test("browser mock forwards history, supports unavailable/empty/failure/delay", async () => {
  const scheduled = [];
  const window = { location: { search: "" }, clearTimeout,
    setTimeout(fn, delay) { scheduled.push(delay); return setTimeout(fn, 0); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "shared/tauri-api.js"), "utf8"), { window, console });
  await window.settingsAPI.updateSettings({ provider: { mode: "local" } });
  assert.equal((await window.pickerAPI.status()).suggestionsAvailable, false);
  await window.settingsAPI.updateSettings({ provider: { mode: "online", online: { baseUrl: "https://example.com", model: "test" } } });
  assert.equal((await window.pickerAPI.status()).suggestionsAvailable, true);
  const history = [{ question: "此前问题", answer: "此前回答" }];
  window.__mockFollowups = { delay: 85 };
  const result = await window.pickerAPI.generateFollowups("mock-1", "explain", "原文", "初始回答", history);
  assert.equal(result.suggestions.length, 3);
  assert.match(result.suggestions[0], /此前问题/);
  assert.equal(scheduled.includes(85), true);
  assert.deepEqual(JSON.parse(JSON.stringify(window.__mockFollowupRequests[0])),
    { requestId: "mock-1", skill: "explain", source: "原文", initialAnswer: "初始回答", history });
  window.__mockFollowups = { empty: true };
  assert.equal((await window.pickerAPI.generateFollowups("mock-2", "translate", "原文", "回答", [])).suggestions.length, 0);
  window.__mockFollowups = { fail: true };
  assert.equal((await window.pickerAPI.generateFollowups("mock-3", "translate", "原文", "回答", [])).ok, false);
});


test("new primary waits for cancellation completion; close stays synchronous and deduplicates cancellation", async () => {
  const { context, calls } = harness();
  let completeCancel;
  const cancellations = [];
  context.API.cancelFollowups = (id) => {
    cancellations.push(id);
    return new Promise((resolve) => { completeCancel = resolve; });
  };
  context.enableFollowup({ kind: "translate", raw: "回答" });
  context.submitFollowup("下一问");
  assert.equal(cancellations.length, 1);
  assert.equal(calls.some((call) => call[0] === "followup"), false);
  await flush();
  assert.equal(calls.some((call) => call[0] === "followup"), false);
  completeCancel({ ok: true });
  await flush();
  assert.equal(calls.some((call) => call[0] === "followup"), true);
  assert.equal(cancellations.length, 1);

  context.state.followupBusy = false;
  context.activeRequest.active = false;
  context.enableFollowup({ kind: "translate", raw: "另一回答" });
  const closing = context.closePanel();
  assert.equal(closing, undefined);
  assert.equal(context.state.panelOpen, false);
  assert.equal(cancellations.length, 2);
  context.resetForHidden();
  assert.equal(cancellations.length, 2);
  completeCancel({ ok: true });
  await flush();
});

test("cancellation rejection still dispatches primary and superseded primary never dispatches", async () => {
  const { context, calls } = harness();
  let rejectCancel;
  context.API.cancelFollowups = () => new Promise((resolve, reject) => { rejectCancel = reject; });
  context.enableFollowup({ kind: "translate", raw: "回答" });
  context.submitFollowup("下一问");
  rejectCancel(new Error("cancel unavailable"));
  await flush();
  assert.equal(calls.some((call) => call[0] === "followup"), true);
  let completeCancel;
  context.suggestionRequest = { id: "old" };
  context.API.cancelFollowups = () => new Promise((resolve) => { completeCancel = resolve; });
  const request = { active: true };
  context.activeRequest = request;
  let dispatched = false;
  const result = context.runAfterSuggestions(request, () => { dispatched = true; });
  request.active = false;
  completeCancel({ ok: true });
  await result;
  assert.equal(dispatched, false);
});

test("all picker AI dispatch paths use the cancellation barrier", () => {
  for (const name of ["translateSkill", "startPolish", "startCustomSkill", "assistSkill", "retryImageRequest", "submitFollowup", "startImageCapture"])
    assert.match(extract(name), /runAfterSuggestions\(/, name);
});

test("cancel command and browser mock support pending, completed and unknown requests", async () => {
  const window = { location: { search: "" }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "shared/tauri-api.js"), "utf8"), { window, console });
  await window.settingsAPI.updateSettings({ provider: { mode: "online", online: { baseUrl: "https://example.com", model: "test" } } });
  window.__mockFollowups = { delay: 60000 };
  const generation = window.pickerAPI.generateFollowups("cancel-me", "explain", "原文", "回答", []);
  assert.equal((await window.pickerAPI.cancelFollowups("cancel-me")).ok, true);
  assert.equal((await generation).suggestions.length, 0);
  assert.equal((await window.pickerAPI.cancelFollowups("cancel-me")).ok, true);
  assert.equal((await window.pickerAPI.cancelFollowups("unknown")).ok, true);
});


test("closing while a replacement suggestion waits prevents it from starting", async () => {
  const { context, calls } = harness();
  let completeCancel;
  context.API.cancelFollowups = () => new Promise((resolve) => { completeCancel = resolve; });
  context.enableFollowup({ kind: "translate", raw: "旧回答" });
  context.resetFollowup();
  context.enableFollowup({ kind: "explain", raw: "新回答" });
  assert.equal(calls.length, 1);
  context.closePanel();
  completeCancel({ ok: true });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(context.suggestionRequest, null);
});

function streamingRequest(context, extra = {}) {
  const request = { id: "main", kind: "translate", raw: "", active: true, ...extra };
  context.activeRequest = request;
  return request;
}
function chunk(context, request, text) {
  context.handleTranslateEvent({ requestId: request.id, type: "chunk", text });
}
function done(context, request) {
  context.handleTranslateEvent({ requestId: request.id, type: "done" });
}
function resolveSuggestions(pending, text = "有效建议") {
  pending.resolve({ ok: true, requestId: pending.id, suggestions: [text] });
}

test("primary dispatch schedules one prefetch without any chunk for every AI kind; done reveals cached result", async () => {
  for (const extra of [
    { kind: "translate" }, { kind: "polish" },
    { kind: "assist", action: "summarize" }, { kind: "assist", action: "explain" },
    { kind: "custom", skillId: "custom-text" },
    ...["ocr", "translate", "explain", "custom"].map((imageAction) => ({ kind: "image", imageAction })),
  ]) {
    const h = harness(true, true);
    const { context, calls, pending, state } = h;
    const request = streamingRequest(context, extra);
    let dispatched = false;
    const primary = context.runAfterSuggestions(request, () => { dispatched = true; return { ok: true }; });
    assert.equal(dispatched, true);
    assert.equal(request.suggestionsStarted, true, "Prefetch is reserved at dispatch, before body");
    assert.equal(calls.length, 0);
    h.advance(49);
    assert.equal(calls.length, 0);
    h.advance(1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], extra.skillId || extra.imageAction || extra.action || extra.kind);
    assert.equal(calls[0][2], "原文");
    assert.equal(calls[0][3], "");
    resolveSuggestions(pending[0]);
    await flush();
    assert.equal(context.panelSuggestions.hidden, true);
    chunk(context, request, "短回答");
    done(context, request);
    assert.equal(calls.length, 1, "Final answer never starts another generation");
    assert.equal(context.panelSuggestions.children[0].textContent, "有效建议");
    assert.equal(state.initialAnswer, "短回答");
    assert.equal((await primary).ok, true);
  }
});

test("deadline starts at done, accepts exactly 3000ms and rejects later even before timer callback", async () => {
  for (const delay of [2999, 3000, 3001]) {
    const h = harness(true, true);
    const request = streamingRequest(h.context);
    h.context.runAfterSuggestions(request, () => Promise.resolve({ ok: true }));
    h.advance(50);
    chunk(h.context, request, "正文");
    h.advance(20000);
    assert.equal(h.cancelled.length, 0, "Streaming time does not consume the grace period");
    done(h.context, request);
    h.elapse(delay);
    resolveSuggestions(h.pending[0]);
    await flush();
    assert.equal(h.context.panelSuggestions.hidden, delay > 3000);
  }
});

test("3000ms timeout cancels pending generation and late results never reappear", async () => {
  const h = harness(true, true);
  const request = streamingRequest(h.context);
  chunk(h.context, request, "正文");
  done(h.context, request);
  h.advance(2999);
  assert.equal(h.cancelled.length, 0);
  h.advance(1);
  assert.deepEqual(h.cancelled, [h.pending[0].id]);
  resolveSuggestions(h.pending[0]);
  await flush();
  assert.equal(h.context.panelSuggestions.hidden, true);
  assert.equal(h.state.initialAnswer, "正文");
});

test("prefetch failure stays silent and unavailable capability makes zero calls during streaming", async () => {
  for (const available of [false, true]) {
    const h = harness(available, true);
    const request = streamingRequest(h.context);
    chunk(h.context, request, "正文");
    done(h.context, request);
    if (available) { h.pending[0].reject(new Error("offline")); await flush(); }
    h.advance(4000);
    assert.equal(h.calls.length, available ? 1 : 0);
    assert.equal(h.context.panelSuggestions.hidden, true);
    assert.equal(h.context.panelFollowup.hidden, !available);
    assert.equal(h.state.initialAnswer, "正文");
    assert.equal(h.timers.size, 0);
  }
});

test("new session invalidates an in-flight stream prefetch", async () => {
  const h = harness(true, true);
  let request = streamingRequest(h.context);
  chunk(h.context, request, "旧正文".repeat(40));
  h.context.resetFollowup();
  request = streamingRequest(h.context, { id: "new" });
  chunk(h.context, request, "新正文".repeat(40));
  await flush();
  done(h.context, request);
  resolveSuggestions(h.pending[1], "新建议");
  await flush();
  resolveSuggestions(h.pending[0], "旧建议");
  await flush();
  assert.equal(h.context.panelSuggestions.children[0].textContent, "新建议");
});

test("multi-round dispatch prefetch keeps initial answer, completed history and current unanswered question", async () => {
  const h = harness(true, true);
  h.state.text = "";
  h.state.image = { action: "explain" };
  let request = streamingRequest(h.context, { kind: "image", imageAction: "explain" });
  chunk(h.context, request, "初始回答");
  done(h.context, request);
  for (let round = 1; round <= 3; round++) {
    h.context.submitFollowup("问题" + round);
    await flush();
    request = h.context.activeRequest;
    h.advance(50);
    const call = h.calls.at(-1);
    chunk(h.context, request, "部分" + round);
    chunk(h.context, request, "正文".repeat(60));
    assert.equal(call[3], "初始回答");
    assert.deepEqual(JSON.parse(JSON.stringify(call[4])), [
      ...Array.from({ length: round - 1 }, (_, i) => ({ question: "问题" + (i + 1), answer: "部分" + (i + 1) + "正文".repeat(60) + "完成" })),
      { question: "问题" + round, answer: "" },
    ]);
    chunk(h.context, request, "完成");
    done(h.context, request);
    resolveSuggestions(h.pending.at(-1));
    await flush();
    assert.equal(h.context.panelSuggestions.hidden, false);
    assert.equal(h.state.initialAnswer, "初始回答");
  }
});

test("mock supports independent per-skill prefetch delays and cancellation", async () => {
  const scheduled = [];
  const window = { location: { search: "" }, clearTimeout,
    setTimeout(fn, delay) { scheduled.push(delay); return setTimeout(fn, 0); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "shared/tauri-api.js"), "utf8"), { window, console });
  await window.settingsAPI.updateSettings({ provider: { mode: "online", online: { baseUrl: "https://example.com", model: "test" } } });
  window.__mockFollowups = { delay: 50, skills: { translate: { delay: 250 }, ocr: { empty: true } } };
  assert.equal((await window.pickerAPI.generateFollowups("skill-1", "translate", "原文", "部分", [])).suggestions.length, 3);
  assert.equal((await window.pickerAPI.generateFollowups("skill-2", "ocr", "原文", "部分", [])).suggestions.length, 0);
  assert.deepEqual(scheduled.filter((delay) => delay !== 8), [250, 50]);
});


test("short answer done before the 50ms timer still uses dispatch context and waits at most three seconds", async () => {
  const h = harness(true, true);
  const request = streamingRequest(h.context);
  h.context.runAfterSuggestions(request, () => Promise.resolve({ ok: true }));
  chunk(h.context, request, "简短回答");
  done(h.context, request);
  assert.equal(h.calls.length, 0);
  h.advance(50);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][3], "");
  h.advance(2949);
  assert.equal(h.cancelled.length, 0);
  h.advance(1);
  assert.deepEqual(h.cancelled, [h.pending[0].id]);
});

test("image dispatch prefetch prefers existing recognized text without sending image bytes", () => {
  for (const key of ["ocrText", "cachedText", "sourceText", "text"]) {
    const h = harness(true, true);
    h.state.text = "";
    h.state.image = { [key]: "图片中已识别的有效文字", dataUrl: "private-image-bytes" };
    const request = streamingRequest(h.context, { kind: "image", imageAction: "explain" });
    h.context.runAfterSuggestions(request, () => Promise.resolve({ ok: true }));
    h.advance(50);
    assert.equal(request.raw, "");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][2], "图片中已识别的有效文字");
    assert.equal(JSON.stringify(h.calls).includes("private-image-bytes"), false);
  }
});

test("image without recognized text waits for useful body or full short answer", () => {
  for (const long of [false, true]) {
    const h = harness(true, true);
    h.state.text = "";
    h.state.image = { requestId: "main" };
    const request = streamingRequest(h.context, { kind: "image", imageAction: "explain" });
    h.context.runAfterSuggestions(request, () => Promise.resolve({ ok: true }));
    h.advance(50);
    assert.equal(h.calls.length, 0);
    chunk(h.context, request, "这张");
    assert.equal(h.calls.length, 0);
    if (long) chunk(h.context, request, "详细描述".repeat(30));
    else { chunk(h.context, request, "图片里是一只猫"); done(h.context, request); }
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][3], request.raw);
  }
});

test("empty source and body never call suggestion generation", () => {
  const h = harness(true, true);
  h.state.text = "";
  const request = streamingRequest(h.context, { kind: "image", imageAction: "explain" });
  h.context.runAfterSuggestions(request, () => Promise.resolve({ ok: true }));
  h.advance(50);
  chunk(h.context, request, "   ");
  h.context.refreshFollowupSuggestions(request, true);
  h.context.finishFollowupSuggestions(request);
  assert.equal(h.calls.length, 0);
});

test("closing or hiding before 50ms removes the scheduled prefetch", () => {
  for (const action of ["closePanel", "resetForHidden", "resetFollowup"]) {
    const h = harness(true, true);
    const request = streamingRequest(h.context);
    h.context.runAfterSuggestions(request, () => Promise.resolve({ ok: true }));
    h.context[action]();
    h.advance(50);
    assert.equal(h.calls.length, 0, action);
    assert.equal(h.timers.size, 0, action);
  }
});

test("unavailable capability never calls generation at dispatch, chunk or done", () => {
  const h = harness(false, true);
  const request = streamingRequest(h.context);
  let dispatched = false;
  h.context.runAfterSuggestions(request, () => { dispatched = true; return { ok: true }; });
  h.advance(50);
  chunk(h.context, request, "短回答");
  done(h.context, request);
  assert.equal(dispatched, true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.size, 0);
});

test("prefetch exceptions preserve a pending main request and completed answer", async () => {
  for (const synchronous of [false, true]) {
    const h = harness(true, true);
    const request = streamingRequest(h.context);
    let finishMain;
    const primary = h.context.runAfterSuggestions(request, () => new Promise((resolve) => { finishMain = resolve; }));
    h.context.API.generateFollowups = () => {
      if (synchronous) throw new Error("offline");
      return Promise.reject(new Error("offline"));
    };
    h.advance(50);
    await flush();
    assert.equal(request.active, true);
    chunk(h.context, request, "主回答成功");
    done(h.context, request);
    finishMain({ ok: true });
    assert.equal((await primary).ok, true);
    assert.equal(h.state.initialAnswer, "主回答成功");
    assert.equal(h.context.panelSuggestions.hidden, true);
  }
});

test("initial screenshot registration prefetches recognized text before its first chunk", () => {
  for (const recognized of [false, true]) {
    const h = harness(true, true);
    Object.assign(h.context, {
      IMAGE_ACTION_LABELS: { explain: "图片解释" },
      openPanel() { h.context.resetFollowup(); },
      clearPendingImageTarget() {}, setPanelLanguage() {}, setPanelRetry() {},
      retryImageRequest() {}, setBody() {}, loadingNode: node,
    });
    vm.runInContext(extract("beginImageRequest"), h.context);
    const request = h.context.beginImageRequest({
      action: "explain", ocrText: recognized ? "已有图片文字" : "",
    }, "image-main");
    h.advance(50);
    assert.equal(request.raw, "");
    assert.equal(h.calls.length, recognized ? 1 : 0);
    if (recognized) {
      assert.equal(h.calls[0][2], "已有图片文字");
      assert.equal(h.calls[0][3], "");
    }
  }
});
