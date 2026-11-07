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

test("t() ignores inherited object keys and falls back to the key", () => {
  const LP = loadI18n();
  LP.i18n.init("en");
  assert.equal(LP.t("constructor"), "constructor");
  assert.equal(LP.t("toString"), "toString");
  assert.equal(LP.t("__proto__"), "__proto__");
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
  for (const file of ["messages.zh.js", "messages.en.js", "i18n.js", "constants.js", "lang.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "shared", file), "utf8"), context);
  }
  const LP = context.window.LP;
  LP.i18n.init("en");
  assert.equal(LP.skillLabel("translate"), "Translate");
  assert.match(LP.skillDescription("translate"), /default target language/);
  assert.equal(LP.languageLabel("ja"), "Japanese");
  assert.equal(LP.languageLabel("unknown-code"), "unknown-code");
  assert.equal(LP.presetLabel("ollama"), "Ollama (local)");
  assert.equal(LP.presetHint("custom"), "Any OpenAI-compatible service URL");
  assert.equal(LP.platformLabel({ platform: "windows", packaged: true }), "Windows · Installed");
  LP.LANGUAGES.forEach((language) => {
    assert.equal(LP.languageLabel(language.value), LP.t("language." + language.value));
  });
  LP.PRESETS.forEach((preset) => {
    assert.equal(LP.presetLabel(preset.id), LP.t("settings.preset." + preset.id + ".label"));
    assert.equal(LP.presetHint(preset.id), LP.t("settings.preset." + preset.id + ".hint"));
  });
  LP.i18n.init("zh");
  assert.equal(LP.skillLabel("translate"), "翻译");
  assert.equal(LP.skillLabel("custom-not-in-pack"), "custom-not-in-pack");
  assert.equal(LP.presetLabel("custom"), "自定义");
  assert.equal(LP.platformLabel({ platform: "windows", portable: true }), "Windows · 便携版");
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

test("every pin.js literal lookup exists in both packs", () => {
  const LP = loadI18n();
  const source = fs.readFileSync(path.join(__dirname, "pin.js"), "utf8");
  // Same negative lookahead as the other windows: concatenated keys are built
  // at runtime and are only guarded by the pack-parity test.
  const keys = Array.from(source.matchAll(/LP\.t\("([^"]+)"(?!\s*\+)/g)).map((match) => match[1]);
  const scoped = keys.filter((key) => /^(?:pin|longshot|common)\./.test(key));
  assert.ok(scoped.length > 15, "expected the pin window to use LP.t");
  for (const key of new Set(scoped)) {
    assert.ok(LP.messages.zh[key] !== undefined, `missing zh key ${key} (pin.js)`);
    assert.ok(LP.messages.en[key] !== undefined, `missing en key ${key} (pin.js)`);
  }
});

test("quicktranslate page loads the shared i18n runtime", () => {
  const source = fs.readFileSync(path.join(__dirname, "quicktranslate.html"), "utf8");
  for (const file of ["constants.js", "messages.zh.js", "messages.en.js", "i18n.js", "lang.js"]) {
    assert.ok(
      source.includes(`src="shared/${file}"`),
      `quicktranslate.html must load shared/${file}`
    );
  }
  // The runtime must load before the page script that calls LP.t.
  const runtimeIndex = source.indexOf('src="shared/i18n.js"');
  const pageIndex = source.indexOf('src="quicktranslate.js"');
  assert.ok(runtimeIndex >= 0 && pageIndex > runtimeIndex, "i18n runtime before quicktranslate.js");
});

test("every quicktranslate.html data-i18n key exists in both packs", () => {
  const LP = loadI18n();
  const source = fs.readFileSync(path.join(__dirname, "quicktranslate.html"), "utf8");
  const keys = Array.from(source.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)).map((match) => match[1]);
  assert.ok(keys.length > 20, `expected the quick panel to tag its static copy (found ${keys.length})`);
  for (const key of new Set(keys)) {
    assert.ok(LP.messages.zh[key] !== undefined, `missing zh key ${key} (quicktranslate.html)`);
    assert.ok(LP.messages.en[key] !== undefined, `missing en key ${key} (quicktranslate.html)`);
  }
});

test("every quicktranslate.js literal lookup exists in both packs", () => {
  const LP = loadI18n();
  const source = fs.readFileSync(path.join(__dirname, "quicktranslate.js"), "utf8");
  const keys = Array.from(source.matchAll(/LP\.t\("([^"]+)"(?!\s*\+)/g)).map((match) => match[1]);
  // The panel looks keys up through its `tr()` wrapper, which delegates to
  // LP.t; the wrapper itself is asserted below.
  assert.ok(source.includes("typeof LP.t === \"function\""), "tr() must delegate to LP.t");
  const trKeys = Array.from(source.matchAll(/tr\("([^"]+)"(?!\s*\+)/g)).map((match) => match[1]);
  const scoped = keys.concat(trKeys).filter((key) => /^(?:quick|common)\./.test(key));
  assert.ok(scoped.length > 40, `expected the quick panel to use message keys (found ${scoped.length})`);
  for (const key of new Set(scoped)) {
    assert.ok(LP.messages.zh[key] !== undefined, `missing zh key ${key} (quicktranslate.js)`);
    assert.ok(LP.messages.en[key] !== undefined, `missing en key ${key} (quicktranslate.js)`);
  }
});

test("quicktranslate.js has no user-visible Chinese literals", () => {
  const source = fs.readFileSync(path.join(__dirname, "quicktranslate.js"), "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  // The panel must get every visible string from the packs (comments and the
  // language-code tables are stripped above and may stay as-is).
  const match = /[\u4e00-\u9fff]/.exec(code);
  assert.equal(match, null, `Chinese literal left in quicktranslate.js: ${match && match[0]}`);
});

test("every quicktranslate.html Chinese string is bound to a message key", () => {
  const source = fs.readFileSync(path.join(__dirname, "quicktranslate.html"), "utf8");
  const html = source.replace(/<!--[\s\S]*?-->/g, "");
  // Text nodes: the Chinese pre-init placeholder may stay, but only inside an
  // element (or subtree) that carries a data-i18n* attribute.
  const voidTags = /^<(?:meta|link|input|br|img|hr|source|wbr|area|base|col|embed|param|track)\b/i;
  const stack = [];
  const untaggedText = [];
  for (const token of html.split(/(<[^>]*>)/)) {
    if (!token) {
      continue;
    }
    if (token.startsWith("<")) {
      if (/^<\//.test(token)) {
        stack.pop();
      } else if (!/\/>$/.test(token) && !voidTags.test(token)) {
        stack.push(/data-i18n(?:-[a-z-]+)?="/.test(token));
      }
      continue;
    }
    if (/[\u4e00-\u9fff]/.test(token) && !stack.some(Boolean)) {
      untaggedText.push(token.trim());
    }
  }
  assert.deepEqual(untaggedText, [], "untagged Chinese copy in quicktranslate.html");
  // Attribute copy (title / aria-label / placeholder) needs the matching
  // data-i18n-<attribute> key on the same tag.
  for (const [tag] of html.matchAll(/<[a-z][^>]*>/gi)) {
    if (!/[\u4e00-\u9fff]/.test(tag)) {
      continue;
    }
    for (const attribute of ["title", "aria-label", "placeholder"]) {
      const pattern = new RegExp(`(?:^|\\s)${attribute}="[^"]*[\\u4e00-\\u9fff][^"]*"`);
      if (!pattern.test(tag)) {
        continue;
      }
      assert.ok(
        tag.includes(`data-i18n-${attribute}=`),
        `untagged ${attribute} in quicktranslate.html: ${tag}`
      );
    }
  }
});

test("quick settings card in index.html is fully tagged for translation", () => {
  const LP = loadI18n();
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const marker = 'aria-labelledby="card-quick-title"';
  const markerIndex = html.indexOf(marker);
  assert.notEqual(markerIndex, -1, "missing card-quick-title");
  const start = html.lastIndexOf("<section", markerIndex);
  const end = html.indexOf("</section>", markerIndex);
  const card = html.slice(start, end);
  const keys = Array.from(card.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)).map((match) => match[1]);
  assert.ok(keys.length >= 15, `expected the quick card to tag its copy (found ${keys.length})`);
  for (const key of new Set(keys)) {
    assert.ok(key.startsWith("settings.quick."), `quick card key outside its namespace: ${key}`);
    assert.ok(LP.messages.zh[key] !== undefined, `missing zh key ${key} (quick card)`);
    assert.ok(LP.messages.en[key] !== undefined, `missing en key ${key} (quick card)`);
  }
  // Every Chinese text node of the card must sit inside an element that carries
  // a data-i18n* attribute; comments are the only allowed Chinese leftovers.
  const untagged = card
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<([a-z0-9]+)\b[^>]*data-i18n(?:-[a-z-]+)?="[^"]+"[^>]*>[\s\S]*?<\/\1>/g,
      ""
    );
  const leftover = /[\u4e00-\u9fff]/.exec(untagged);
  assert.equal(leftover, null, `untagged Chinese copy in the quick card: ${leftover && leftover[0]}`);
});

test("every pin.html and longshot.html data-i18n key exists in both packs", () => {
  const LP = loadI18n();
  const minimumKeys = { "pin.html": 40, "longshot.html": 2 };
  for (const page of ["pin.html", "longshot.html"]) {
    const source = fs.readFileSync(path.join(__dirname, page), "utf8");
    const keys = Array.from(source.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)).map((match) => match[1]);
    assert.ok(
      keys.length >= minimumKeys[page],
      `expected ${page} to tag its static copy (found ${keys.length})`
    );
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
