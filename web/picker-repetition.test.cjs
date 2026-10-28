const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "picker.js"), "utf8");
function extract(name) {
  const start = source.indexOf("  function " + name + "(");
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf("\n  }", start) + 4);
}
function node() {
  return { children: [], classList: { remove() {}, toggle() {} },
    appendChild(child) { this.children.push(child); child.parentNode = this; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
    addEventListener(event, callback) { this[event] = callback; },
    querySelector() { return this.children.find((child) => child.className === "error-note"); },
    focus() {},
  };
}
function harness() {
  const cancelled = [], frames = [], rendered = [];
  const context = vm.createContext({
    state: { followupHistory: [], initialAnswer: "", suggestionsAvailable: false },
    activeRequest: null, pronunciationRequest: null,
    panelFollowup: node(), panelFollowupInput: node(), panelFollowupSend: node(), panelBody: node(),
    window: { requestAnimationFrame(callback) { frames.push(callback); } },
    API: { abortTranslate(id) { cancelled.push(id); return Promise.resolve(); } },
    el(tag, className, text) { return Object.assign(node(), { tag, className, textContent: text }); },
    renderMarkdownInto(result, raw) { result.textContent = raw; rendered.push(raw); },
    requestOutputText(request) { return request.raw; },
    setPanelSpeakText(text) { context.state.speech = text; },
    setPanelCopyText(text) { context.state.copy = text; },
    invalidateFollowupSuggestions() {}, finishFollowupSuggestions() {}, refreshFollowupSuggestions() {},
    syncFollowupOverlay() {}, resizePanelForContent() {},
    renderTranslationDraft(request) {
      frames.push(() => { if (request.active) context.renderRequestResult(request); });
    },
    plainFromMarkdown(text) { return text; },
    submitFollowup(question) { context.retried = question; },
    friendlyError(text) { return text; },
  });
  for (const name of ["guardRepetition", "stopRepeatedRequest", "handleTranslateEvent", "abortActiveRequest",
    "removeLoadingRow", "renderRequestResult", "appendErrorNote", "enableFollowup", "setFollowupBusy",
    "finishTranslation", "finishFollowup", "failFollowup", "failTranslation"])
    vm.runInContext(extract(name), context);
  function request(kind = "assist") {
    const block = node();
    const request = { id: "r" + (cancelled.length + 1), kind, action: "explain", question: "为何？",
      active: true, failed: false, raw: "", target: block, block, result: node() };
    context.activeRequest = request;
    return request;
  }
  function event(request, type, text) { context.handleTranslateEvent({ requestId: request.id, type, text }); }
  return { context, cancelled, frames, rendered, request, event,
    guard(text, request, original) { return context.guardRepetition(text, request, original); } };
}
const paragraph = "模型应聚焦问题，给出简洁且准确的回答。";
const cycle = "这是一段超过二十四个字符的重复内容，用于验证没有换行时的循环防护。";

test("translation and polish preserve repeated source structure and following content", () => {
  for (const kind of ["translate", "polish"]) {
    for (const separator of ["\n", "\n\n"]) {
      const h = harness(), request = h.request(kind);
      h.context.state.text = ["1. Repeat this source paragraph.", "2. Repeat this source paragraph.",
        "3. Repeat this source paragraph.", "Continue normally."].join(separator);
      const raw = ("- " + paragraph + separator).repeat(3) + "接下来是正常内容。";
      for (const ch of raw) h.event(request, "chunk", ch);
      assert.equal(request.raw, raw);
      assert.equal(request.active, true);
      assert.equal(h.cancelled.length, 0);
      h.event(request, "done");
      assert.equal(h.context.state.initialAnswer, raw);
      assert.equal(h.guard((paragraph + "\n\n").repeat(3), { kind }, "One source paragraph.").repeated, true);
      assert.equal(h.guard(("- " + paragraph + "\n").repeat(3), { kind }, "carzy").repeated, true);
      assert.equal(h.guard("word\n".repeat(10), { kind }, "word").repeated, false);
    }
  }
});

test("source repetition allowance is bounded and does not exempt image translation", () => {
  const h = harness(), original = ("Repeated source paragraph.\n\n").repeat(3);
  assert.equal(h.guard((paragraph + "\n\n").repeat(4), { kind: "translate" }, original).repeated, true);
  assert.equal(h.guard((paragraph + "\n\n").repeat(3), { kind: "image", imageAction: "translate" }, original).repeated, true);
});

test("repeated retry clicks while another follow-up is busy leave history and DOM intact", () => {
  const h = harness(), old = h.request("followup"), parent = node();
  parent.appendChild(old.block);
  h.event(old, "chunk", (paragraph + "\n\n").repeat(3));
  const button = old.target.children.find((child) => child.className === "followup-retry");
  const history = h.context.state.followupHistory.slice();
  const next = h.request("followup");
  h.context.state.followupBusy = true;
  button.click(); button.click();
  assert.deepEqual(h.context.state.followupHistory.slice(), history);
  assert.equal(old.block.parentNode, parent);
  assert.equal(h.context.retried, undefined);
  h.context.state.followupBusy = false;
  button.click();
  assert.equal(old.block.parentNode, parent, "Active requests also prevent destructive retries");
  next.active = false;
  button.click();
  assert.equal(h.context.retried, old.question);
  assert.equal(h.context.state.followupHistory.length, 0);
  assert.equal(old.block.parentNode, null);
});

test("exact Markdown paragraphs and list items stop at three copies, retain first", () => {
  const h = harness();
  for (const text of [paragraph + "\n\n", paragraph + "\n补充说明说明。\n\n", "- " + paragraph + "\n", "1. " + paragraph + "\n"]) {
    const result = h.guard("前言\n\n" + text.repeat(3));
    assert.equal(result.repeated, true);
    assert.equal(result.text, "前言\n\n" + text.trimEnd());
  }
  assert.equal(h.guard((paragraph + "\n\n").repeat(2)).repeated, false);
});

test("cross-chunk and single-chunk loops share cancellation and cleaned history", () => {
  for (const kind of ["assist", "followup", "image", "custom"]) {
    for (const split of [1, 13, 10000]) {
      const h = harness(), request = h.request(kind);
      if (kind === "image") request.imageAction = "explain";
      const input = (paragraph + "\n\n").repeat(5);
      for (let i = 0; i < input.length; i += split) h.event(request, "chunk", input.slice(i, i + split));
      assert.equal(request.raw, paragraph);
      assert.equal(request.finishReason, "repetition");
      assert.equal(request.partial, true);
      assert.equal(request.active, false);
      assert.deepEqual(h.cancelled, [request.id]);
      assert.equal(h.context.state.copy, paragraph);
      assert.equal(request.result.textContent, paragraph);
      assert.equal(request.target.children[0].textContent, "检测到重复输出，已停止");
      if (kind === "followup") assert.equal(h.context.state.followupHistory[0].answer, paragraph);
      else assert.equal(h.context.state.initialAnswer, paragraph);
      h.event(request, "chunk", "迟到的重复");
      h.event(request, "done");
      h.event(request, "error");
      h.context.failFollowup(request, "迟到失败");
      h.context.failTranslation(request, "迟到失败");
      h.frames.forEach((callback) => callback());
      assert.equal(request.result.textContent, paragraph);
      assert.equal(request.target.children[0].textContent, "检测到重复输出，已停止");
      assert.equal(request.finishReason, "repetition");
      assert.equal(h.context.state.followupHistory.length, kind === "followup" ? 1 : 0);
    }
  }
});

test("long tail periods require four copies, including Unicode and arbitrary chunk boundaries", () => {
  const h = harness();
  assert.equal(h.guard(cycle.repeat(3)).repeated, false);
  assert.equal(h.guard(cycle.repeat(4)).text, cycle);
  const request = h.request();
  for (const ch of Array.from(cycle.repeat(5))) h.event(request, "chunk", ch);
  assert.equal(request.raw, cycle);
  assert.equal(request.finishReason, "repetition");
  assert.equal(h.guard(cycle.repeat(180)).text, cycle);
  assert.equal(h.guard((paragraph + "\n\n").repeat(300)).text, paragraph);
});

test("normal terminology, nonconsecutive repetition and recovery do not trigger", () => {
  const h = harness();
  for (const text of [
    "模型 ".repeat(70), "token ".repeat(70),
    paragraph + "\n\n" + paragraph + "\n\n新的解释内容。",
    [paragraph, "另一个观点", paragraph, "第三个观点", paragraph].join("\n\n"),
    ["- 模型用于翻译", "- 模型用于解释", "- 模型用于总结"].join("\n"),
  ]) assert.equal(h.guard(text).repeated, false, text);
});

test("code fences, indented code, tables and blockquotes remain literal", () => {
  const h = harness(), lines = (paragraph + "\n\n").repeat(4);
  for (const text of [
    "```text\n" + lines + "```", "~~~~\n" + cycle.repeat(5) + "\n~~~~",
    "````\n```\n" + lines + "````", "```\n" + lines,
    ("    " + cycle + "\n").repeat(5), ("\t" + cycle + "\n").repeat(5),
    ("| " + cycle + " |\n").repeat(5), ("> " + cycle + "\n").repeat(5),
    "> 引用开始\n" + cycle.repeat(5),
  ]) assert.equal(h.guard(text).repeated, false, text);
  assert.equal(h.guard("```\ncode\n```\n\n" + lines).repeated, true);
  assert.equal(h.guard(paragraph + "\n\n```\ncode\n```\n\n" + (paragraph + "\n\n").repeat(2)).repeated, false);
});

test("OCR remains exempt in unified stream handler", () => {
  for (const attributes of [
    { kind: "image", imageAction: "ocr" },
  ]) {
    const h = harness(), request = Object.assign(h.request(), attributes);
    const raw = (paragraph + "\n\n").repeat(5);
    h.event(request, "chunk", raw);
    assert.equal(request.raw, raw);
    assert.equal(request.active, true);
    assert.equal(h.cancelled.length, 0);
    h.event(request, "done");
    assert.equal(request.finishReason, "complete");
    assert.equal(request.partial, false);
  }
});

test("retry replaces partial follow-up history and a new request starts clean", () => {
  const h = harness(), old = h.request("followup");
  h.event(old, "chunk", (paragraph + "\n\n").repeat(3));
  old.target.children.find((child) => child.className === "followup-retry").click();
  assert.equal(h.context.retried, old.question);
  assert.equal(h.context.state.followupHistory.length, 0);
  const retry = h.request("followup");
  h.event(old, "chunk", "旧请求");
  h.event(old, "done");
  h.event(retry, "chunk", "新的简洁回答");
  h.event(retry, "done");
  h.event(retry, "done");
  assert.equal(retry.finishReason, "complete");
  assert.equal(retry.partial, false);
  assert.equal(h.context.state.followupHistory.length, 1);
  assert.equal(h.context.state.followupHistory[0].answer, "新的简洁回答");
  for (const name of ["submitFollowup", "translateSkill", "beginImageRequest", "startPolish", "startCustomSkill", "assistSkill"]) {
    assert.match(extract(name), /finishReason: null/);
    assert.match(extract(name), /partial: false/);
  }
});


test("translation, image translation, polish and custom stop repeated natural-language bullets", () => {
  for (const attributes of [{ kind: "translate" }, { kind: "image", imageAction: "translate" },
    { kind: "polish", plain: true }, { kind: "custom", preserveStructure: true }]) {
    const h = harness(), request = Object.assign(h.request(), attributes);
    h.event(request, "chunk", ("- " + paragraph + "\n").repeat(5));
    assert.equal(request.finishReason, "repetition");
    assert.deepEqual(h.cancelled, [request.id]);
    assert.equal(request.raw, "- " + paragraph);
    assert.equal(h.context.state.initialAnswer, "- " + paragraph);
  }
});

test("short translated words and sentences remain literal", () => {
  const h = harness();
  for (const text of ["你好\n".repeat(5), "- hello world\n".repeat(5), "谢谢 谢谢 谢谢", "word ".repeat(60)]) {
    assert.equal(h.guard(text, { kind: "translate" }).repeated, false, text);
  }
  assert.equal(h.guard(("测量误差的累积性是指\n").repeat(3), { kind: "translate" }).repeated, true);
});

test("inline code is preserved across arbitrary chunks and history stays complete", () => {
  for (const raw of [
    ("`SELECT id FROM users WHERE active = 1;`\n").repeat(4),
    ("``SELECT `id` FROM users WHERE active = 1;``\n").repeat(4),
    "`" + cycle.repeat(5) + "`",
    "`SELECT\n" + cycle.repeat(5) + "`",
  ]) {
    for (const split of [1, 7, 10000]) {
      const h = harness(), request = h.request("followup");
      for (let i = 0; i < raw.length; i += split) h.event(request, "chunk", raw.slice(i, i + split));
      assert.equal(request.raw, raw);
      assert.equal(h.cancelled.length, 0);
      h.event(request, "done");
      assert.equal(h.context.state.followupHistory[0].answer, raw);
    }
  }
});

test("loop cleanup retains closed inline code and only one repeated paragraph in history", () => {
  const h = harness(), request = h.request("followup");
  const prefix = "`SELECT id FROM users;`\n\n";
  h.event(request, "chunk", prefix + (paragraph + "\n\n").repeat(5));
  assert.equal(request.finishReason, "repetition");
  assert.equal(request.raw, prefix + paragraph);
  assert.equal(h.context.state.followupHistory[0].answer, prefix + paragraph);
});
