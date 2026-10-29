const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "settings.js"), "utf8");
const start = source.indexOf("  function getInitialState(");
const end = source.indexOf("\n  function ", start + 1);
function harness(results) {
  const delays = [];
  let calls = 0;
  const context = vm.createContext({
    initialStateSettled: false,
    API: { getState: async () => results[Math.min(calls++, results.length - 1)] },
    window: { setTimeout(resolve, delay) { delays.push(delay); resolve(); } },
  });
  vm.runInContext(source.slice(start, end), context);
  return { run: () => context.getInitialState(), delays, calls: () => calls };
}
const missing = { ok: false, error: "state not managed for field `state` on command `get_state`" };
test("initial state retries registration errors then succeeds", async () => {
  const success = { ok: true, state: {} };
  const h = harness([missing, missing, success]);
  assert.equal(await h.run(), success);
  assert.deepEqual(h.delays, [100, 250]);
  assert.equal(h.calls(), 3);
});
test("initial state stops after three bounded retries", async () => {
  const h = harness([missing]);
  assert.equal(await h.run(), missing);
  assert.deepEqual(h.delays, [100, 250, 500]);
  assert.equal(h.calls(), 4);
});
test("initial state does not retry other errors or successful responses", async () => {
  for (const result of [{ ok: false, error: "permission denied" }, { ok: true, state: {} }]) {
    const h = harness([result]);
    assert.equal(await h.run(), result);
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.delays, []);
  }
});
test("boot renders or reports only the final initial-state result", () => {
  const boot = source.slice(source.indexOf("  function boot()"));
  assert.match(boot, /getInitialState\(\)\.then/);
  assert.equal((boot.match(/settings\.error\.readSettings/g) || []).length, 1);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function raceHarness() {
  const pending = [];
  const timers = [];
  const rendered = [];
  const toasts = [];
  const context = vm.createContext({
    initialStateSettled: false,
    state: null,
    API: { getState() { const call = deferred(); pending.push(call); return call.promise; } },
    window: { setTimeout(resolve) { timers.push(resolve); } },
    LP: { t: (key) => key },
    renderAll() { rendered.push(context.state); },
    toast(message) { toasts.push(message); },
  });
  for (const name of ["applyState", "handleStateChanged", "getInitialState"]) {
    const from = source.indexOf("  function " + name + "(");
    const to = source.indexOf("\n  function ", from + 1);
    vm.runInContext(source.slice(from, to), context);
  }
  const from = source.indexOf("    getInitialState().then(function (result) {");
  const to = source.indexOf("\n    });", from) + "\n    });".length;
  return { context, pending, timers, rendered, toasts,
    run() { return vm.runInContext(source.slice(from, to), context); } };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
test("state event wins over an in-flight retry response", async () => {
  const h = raceHarness();
  const done = h.run();
  h.pending[0].resolve(missing);
  await flush();
  h.timers.shift()();
  await flush();
  const newest = { settings: { version: "newest" } };
  h.context.handleStateChanged(newest);
  h.pending[1].resolve({ ok: true, state: { settings: { version: "stale" } } });
  await done;
  assert.equal(h.context.state, newest);
  assert.deepEqual(h.rendered, [newest]);
  assert.deepEqual(h.toasts, []);
});
test("valid event during retry delay cancels further reads", async () => {
  const h = raceHarness();
  const done = h.run();
  h.pending[0].resolve(missing);
  await flush();
  h.context.handleStateChanged({ settings: {} });
  h.timers.shift()();
  await done;
  assert.equal(h.pending.length, 1);
  assert.deepEqual(h.toasts, []);
});
test("invalid event does not settle initial state; exhausted retries toast once", async () => {
  const h = raceHarness();
  const done = h.run();
  h.context.handleStateChanged({});
  for (let index = 0; index < 4; index++) {
    h.pending[index].resolve(missing);
    await flush();
    if (index < 3) { h.timers.shift()(); await flush(); }
  }
  await done;
  assert.equal(h.toasts.length, 1);
  assert.equal(h.rendered.length, 0);
});
test("late initial failure after valid event stays silent", async () => {
  const h = raceHarness();
  const done = h.run();
  const newest = { settings: {} };
  h.context.handleStateChanged(newest);
  h.pending[0].resolve({ ok: false, error: "permission denied" });
  await done;
  assert.equal(h.context.state, newest);
  assert.deepEqual(h.toasts, []);
});
