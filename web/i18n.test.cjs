"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function loadI18n() {
  const context = vm.createContext({ window: {}, console });
  for (const file of ["messages.zh.js", "messages.en.js", "i18n.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "shared", file), "utf8"), context);
  }
  return context.window.LP;
}

test("t() resolves the current locale, falls back to en, then to the key", () => {
  const LP = loadI18n();
  LP.i18n.init("zh");
  assert.equal(LP.t("common.ok"), "确定");
  LP.i18n.setLocale("en");
  assert.equal(LP.t("common.ok"), "OK");
  assert.equal(LP.t("missing.key"), "missing.key");
});

test("t() interpolates named parameters", () => {
  const LP = loadI18n();
  LP.i18n.init("en");
  assert.equal(LP.t("settings.modelHint", { model: "Qwen3.5" }), "All local AI tasks share Qwen3.5");
});

test("setLocale returns whether the locale changed and normalizes unknown values", () => {
  const LP = loadI18n();
  LP.i18n.init("zh");
  assert.equal(LP.i18n.setLocale("zh"), false);
  assert.equal(LP.i18n.setLocale("en"), true);
  assert.equal(LP.i18n.setLocale("jp"), false);
  assert.equal(LP.i18n.currentLocale(), "en");
});

test("applyStatic translates text, title, aria-label and placeholder", () => {
  const LP = loadI18n();
  LP.i18n.init("en");
  const attributes = { "data-i18n": "common.ok", "data-i18n-title": "common.cancel", "data-i18n-aria-label": "common.cancel", "data-i18n-placeholder": "common.search" };
  function makeNode(attrs) {
    return {
      attrs,
      textContent: "",
      innerHTML: "",
      setAttribute(name, value) { attrs[name] = value; },
      getAttribute(name) { return this.attrs[name] === undefined ? null : this.attrs[name]; },
      removeAttribute(name) { delete this.attrs[name]; },
    };
  }
  const textNode = makeNode(attributes);
  const root = {
    querySelectorAll(selector) { return [textNode]; },
    getAttribute() { return null; },
    removeAttribute() {},
  };
  LP.i18n.applyStatic(root);
  assert.equal(textNode.textContent, "OK");
  assert.equal(textNode.getAttribute("title"), "Cancel");
  assert.equal(textNode.getAttribute("aria-label"), "Cancel");
  assert.equal(textNode.getAttribute("placeholder"), "Search");
});

test("language packs have the same keys", () => {
  const LP = loadI18n();
  assert.deepEqual(Object.keys(LP.messages.zh).sort(), Object.keys(LP.messages.en).sort());
});

test("every settings.js literal lookup exists in both packs", () => {
  const LP = loadI18n();
  const source = fs.readFileSync(path.join(__dirname, "settings.js"), "utf8");
  // Skip runtime-built keys such as LP.t("skill." + id): only whole literals
  // are checked here, the pack-parity test still guards the rest.
  const keys = Array.from(source.matchAll(/LP\.t\("([^"]+)"(?!\s*\+)/g)).map((match) => match[1]);
  assert.ok(keys.length > 100, "expected the settings page to use LP.t");
  for (const key of new Set(keys)) {
    assert.ok(LP.messages.zh[key] !== undefined, `missing zh key ${key}`);
    assert.ok(LP.messages.en[key] !== undefined, `missing en key ${key}`);
  }
});

test("skill label helpers resolve the active pack and fall back to metadata", () => {
  const context = vm.createContext({ window: {}, console });
  for (const file of ["messages.zh.js", "messages.en.js", "i18n.js", "constants.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "shared", file), "utf8"), context);
  }
  const LP = context.window.LP;
  LP.i18n.init("en");
  assert.equal(LP.skillLabel("translate"), "Translate");
  assert.match(LP.skillDescription("translate"), /default target language/);
  LP.i18n.init("zh");
  assert.equal(LP.skillLabel("translate"), "翻译");
  assert.equal(LP.skillLabel("custom-not-in-pack"), "custom-not-in-pack");
});

test("every picker.js literal lookup exists in both packs", () => {
  const LP = loadI18n();
  const source = fs.readFileSync(path.join(__dirname, "picker.js"), "utf8");
  const keys = Array.from(source.matchAll(/LP\.t\("([^"]+)"(?!\s*\+)/g)).map((match) => match[1]);
  const scoped = keys.filter((key) => /^(?:picker|skill|capture|common)\./.test(key));
  assert.ok(scoped.length > 15, "expected the picker window to use LP.t");
  for (const key of new Set(scoped)) {
    assert.ok(LP.messages.zh[key] !== undefined, `missing zh key ${key}`);
    assert.ok(LP.messages.en[key] !== undefined, `missing en key ${key}`);
  }
});

test("every picker.html data-i18n key exists in both packs", () => {
  const LP = loadI18n();
  const source = fs.readFileSync(path.join(__dirname, "picker.html"), "utf8");
  const keys = Array.from(source.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)).map((match) => match[1]);
  assert.ok(keys.length > 8, "expected the picker shell to tag its static copy");
  for (const key of new Set(keys)) {
    assert.ok(LP.messages.zh[key] !== undefined, `missing zh key ${key}`);
    assert.ok(LP.messages.en[key] !== undefined, `missing en key ${key}`);
  }
});

test("capture, longshot, longshot-bar and pin pages load the shared i18n runtime", () => {
  for (const page of ["capture.html", "longshot.html", "longshot-bar.html", "pin.html"]) {
    const source = fs.readFileSync(path.join(__dirname, page), "utf8");
    for (const file of ["messages.zh.js", "messages.en.js", "i18n.js"]) {
      assert.ok(
        source.includes(`src="shared/${file}"`),
        `${page} must load shared/${file}`
      );
    }
  }
});

test("every capture.js and longshot-bar.js literal lookup exists in both packs", () => {
  const LP = loadI18n();
  for (const file of ["capture.js", "longshot-bar.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    const keys = Array.from(source.matchAll(/LP\.t\("([^"]+)"(?!\s*\+)/g)).map((match) => match[1]);
    const scoped = keys.filter((key) => /^(?:capture|longshot|common)\./.test(key));
    assert.ok(scoped.length > 15, `expected ${file} to use LP.t`);
    for (const key of new Set(scoped)) {
      assert.ok(LP.messages.zh[key] !== undefined, `missing zh key ${key} (${file})`);
      assert.ok(LP.messages.en[key] !== undefined, `missing en key ${key} (${file})`);
    }
  }
});

test("every capture.html and longshot-bar.html data-i18n key exists in both packs", () => {
  const LP = loadI18n();
  for (const page of ["capture.html", "longshot-bar.html"]) {
    const source = fs.readFileSync(path.join(__dirname, page), "utf8");
    const keys = Array.from(source.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)).map((match) => match[1]);
    assert.ok(keys.length > 10, `expected ${page} to tag its static copy`);
    for (const key of new Set(keys)) {
      assert.ok(LP.messages.zh[key] !== undefined, `missing zh key ${key} (${page})`);
      assert.ok(LP.messages.en[key] !== undefined, `missing en key ${key} (${page})`);
    }
  }
});

test("auto target stays language-complementary regardless of UI language", () => {
  const LP = loadI18n();
  // loadI18n() returns the LP runtime itself, so expose it as window.LP for
  // lang.js instead of treating it as the whole window object.
  const context = vm.createContext({ window: { LP }, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "shared", "lang.js"), "utf8"), context);
  LP.i18n.init("zh");
  assert.equal(LP.resolveTargetLang("hello world", "auto"), "zh");
  assert.equal(LP.resolveTargetLang("这是中文", "auto"), "en");
  LP.i18n.init("en");
  assert.equal(LP.resolveTargetLang("这是中文", "auto"), "en");
  assert.equal(LP.resolveTargetLang("hello world", "auto"), "zh");
  assert.equal(LP.resolveTargetLang("hello", "ja"), "ja");
});
