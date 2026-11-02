const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "picker.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "picker.html"), "utf8");

function extract(name) {
  const start = source.indexOf("  function " + name + "(");
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf("\n  }", start) + 4);
}

function node(text) {
  return {
    tag: "",
    className: "",
    textContent: text || "",
    hidden: false,
    disabled: false,
    title: "",
    children: [],
    classList: {
      toggle() {},
      remove() {},
      add() {},
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
      child.parentNode = null;
    },
    addEventListener(event, handler) {
      this[event] = handler;
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    querySelector() {
      return null;
    },
    focus() {},
  };
}

/* Covers the shared footer: `syncPanelFoot` (stop button enablement) and
 * `stopActiveRequest` (abort + freeze). Both are AI-panel agnostic because
 * every stream registers `activeRequest` and reports chunks on translate-event. */
function harness() {
  const aborted = [];
  const busy = [];
  const invalidated = [];
  const resized = [];
  const state = { translating: false, panelSpeakText: "", panelCopyText: "" };
  const panelSpeak = node();
  const panelCopy = node("已渲染结果");
  const panelRetry = node();
  const panelStop = node();
  const panelBody = node("正文");
  const context = vm.createContext({
    state,
    activeRequest: null,
    panelSpeak: panelSpeak,
    panelCopy: panelCopy,
    panelRetry: panelRetry,
    panelStop: panelStop,
    panelBody: panelBody,
    API: {
      abortTranslate(id) {
        aborted.push(id);
      },
    },
    el(tag, className, text) {
      return Object.assign(node(text), { tag: tag, className: className || "" });
    },
    renderRequestResult(request) {
      request.result.textContent = String(request.raw || "");
    },
    requestOutputText(request) {
      return String(request.raw || "");
    },
    setPanelSpeakText(text) {
      state.panelSpeakText = String(text || "");
      context.syncPanelFoot();
    },
    setPanelCopyText(text) {
      state.panelCopyText = String(text || "");
      context.syncPanelFoot();
    },
    invalidateFollowupSuggestions() {
      invalidated.push(true);
    },
    setFollowupBusy(value) {
      busy.push(value);
    },
    resizePanelForContent() {
      resized.push(true);
    },
  });
  for (const name of ["syncPanelFoot", "removeLoadingRow", "stopActiveRequest"]) {
    vm.runInContext(extract(name), context);
  }
  function request(overrides) {
    const request = Object.assign(
      {
        id: "request-1",
        kind: "translate",
        active: true,
        raw: "",
        target: node(),
        result: node(),
        loading: node(),
      },
      overrides
    );
    context.activeRequest = request;
    if (request.target && request.loading) {
      request.target.appendChild(request.loading);
    }
    return request;
  }
  return { context, state, aborted, busy, invalidated, resized, request, panelStop };
}

test("stop aborts the running request, freezes the partial answer and disables itself", () => {
  const h = harness();
  const request = h.request({ raw: "部分译文" });
  h.context.syncPanelFoot();
  assert.equal(h.panelStop.disabled, false, "a running stream arms the stop button");
  assert.equal(request.loading.parentNode, request.target, "loading row starts in the panel");

  h.context.stopActiveRequest();

  assert.deepEqual(h.aborted, ["request-1"]);
  assert.equal(request.active, false);
  assert.equal(request.finishReason, "stopped");
  assert.equal(h.context.activeRequest, null);
  assert.equal(h.state.translating, false);
  assert.equal(request.loading, null, "the loading row is removed");
  assert.equal(request.result.textContent, "部分译文", "partial output stays rendered");
  assert.equal(h.state.panelSpeakText, "部分译文");
  assert.equal(h.state.panelCopyText, "部分译文");
  assert.equal(request.target.children.at(-1).className, "stop-note");
  assert.equal(request.target.children.at(-1).textContent, "已停止生成");
  assert.equal(h.panelStop.disabled, true, "the stop button returns to disabled");
  assert.deepEqual(h.invalidated, [true]);
});

test("a stopped follow-up keeps its partial turn and leaves the input usable", () => {
  const h = harness();
  const block = node();
  const request = h.request({ kind: "followup", raw: "部分回答", block: block });
  h.context.stopActiveRequest();

  assert.deepEqual(h.aborted, ["request-1"]);
  assert.deepEqual(h.busy, [false]);
  assert.equal(block.children.at(-1).className, "stop-note");
  assert.equal(block.children.at(-1).textContent, "已停止生成");
  assert.equal(request.active, false);
});

test("stop is a no-op when no stream is running", () => {
  const h = harness();
  h.context.activeRequest = null;
  h.context.syncPanelFoot();
  assert.equal(h.panelStop.disabled, true);

  h.context.stopActiveRequest();

  assert.deepEqual(h.aborted, []);
  assert.equal(h.panelStop.disabled, true);
});

test("every AI panel start path arms the shared footer", () => {
  // translate / summarize / explain / polish / custom text + image custom
  // (beginImageRequest) / follow-up all run through these entry points.
  for (const name of [
    "translateSkill",
    "startPolish",
    "startCustomSkill",
    "assistSkill",
    "beginImageRequest",
    "submitFollowup",
  ]) {
    assert.match(extract(name), /syncPanelFoot\(\)/, name);
  }
});

test("the footer wires four icon-only buttons with tooltips", () => {
  const foot = html.match(/<div class="panel-foot"[\s\S]*?<\/div>/);
  assert.ok(foot, "panel-foot exists");
  const buttons = [...foot[0].matchAll(/<button[^>]*id="(panel-[a-z]+)"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.deepEqual(
    buttons.map((match) => match[1]),
    ["panel-speak", "panel-copy", "panel-retry", "panel-stop"]
  );
  for (const button of buttons) {
    assert.equal(button[2].trim(), "", button[1] + " must not contain label text");
    assert.match(button[0], /title="[^"]+"/, button[1] + " must carry a tooltip");
    assert.match(button[0], /aria-label="[^"]+"/, button[1] + " must carry an accessible name");
  }
});

test("the footer icons are injected as SVG without label spans", () => {
  assert.match(source, /panelSpeak\.innerHTML = skillIconSvg\(/);
  assert.match(source, /panelCopy\.innerHTML = skillIconSvg\(/);
  assert.match(source, /panelRetry\.innerHTML = ICONS\.refresh;/);
  assert.match(source, /panelStop\.innerHTML = ICONS\.stop;/);
  assert.match(source, /stop:\s*\n\s*'<svg class="icon"/);
  assert.doesNotMatch(source, /panel(?:Speak|Copy|Retry)\.innerHTML = [^;]*<span>/);
  assert.match(source, /panelStop\.addEventListener\("click", stopActiveRequest\)/);
});
