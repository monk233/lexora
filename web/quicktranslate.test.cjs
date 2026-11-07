/* Quick-translate renderer tests (contract §6).
 *
 * The window renderer is a plain IIFE with DOM side effects; the pure helpers it
 * relies on are extracted from the source and exercised in a `vm` context, the
 * same approach as web/picker-repetition.test.cjs. The source-language
 * heuristic is also compared with the browser-preview mock (shared/tauri-api.js)
 * so both keep the same rules as the Rust `detect_source_lang`.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function extract(source, name) {
  const start = source.indexOf("  function " + name + "(");
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf("\n  }", start) + 4);
}

const quickSource = fs.readFileSync(path.join(__dirname, "quicktranslate.js"), "utf8");
const apiSource = fs.readFileSync(path.join(__dirname, "shared", "tauri-api.js"), "utf8");

const context = vm.createContext({ MAX_CHARS: 20000, console });

for (const name of [
  "qtCountChars",
  "qtDetectSourceLang",
  "qtFilterHistory",
  "qtFormatElapsed",
  "qtFormatHistoryTime",
  "qtMakeRequestId",
  "qtNormalizeInput",
  "qtSourceLanguages",
  "qtNormalizeSourceLang",
  "qtSourceLangLabel",
]) {
  vm.runInContext(extract(quickSource, name), context);
}

/* Project target-language table (38 entries), loaded from the real shared file. */
const sharedContext = vm.createContext({ window: {}, console });
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "shared", "constants.js"), "utf8"),
  sharedContext
);
const projectLanguages = Array.from(sharedContext.window.LP.LANGUAGES, (entry) => ({
  value: entry.value,
  label: entry.label,
}));

/* Cross-realm arrays need a copy before deepEqual: the vm context has its own
 * Array prototype. */
function plain(list) {
  return Array.from(list);
}

/* Plain JSON copy for cross-realm object comparisons. */
function json(value) {
  return JSON.parse(JSON.stringify(value));
}

test("source language heuristic follows the Rust contract order", () => {
  const cases = [
    ["Hello world", "en"],
    ["你好，世界", "zh"],
    ["繁體中文", "zh"],
    ["こんにちは、世界。", "ja"], // kana wins over Han
    ["カタカナだけ", "ja"],
    ["안녕하세요", "ko"],
    ["Привет, мир", "ru"],
    ["مرحبا بالعالم", "ar"],
    ["สวัสดีชาวโลก", "th"],
    ["नमस्ते दुनिया", "hi"],
    ["שלום עולם", "he"],
    ["", "en"],
    ["   ", "en"],
    ["12345 !!!", "en"],
    ["Hello 你好", "zh"], // any Han text is treated as Chinese
    ["Hello Привет", "ru"], // non-Latin scripts outrank Latin
    [null, "en"],
    [undefined, "en"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      context.qtDetectSourceLang(input),
      expected,
      "detect_source_lang(" + JSON.stringify(input) + ")"
    );
  }
});

test("browser-preview mock uses the same source-language heuristic", () => {
  const mockContext = vm.createContext({ console });
  vm.runInContext(extract(apiSource, "mockDetectSourceLang"), mockContext);
  const samples = [
    "",
    "Hello world",
    "你好，世界",
    "こんにちは",
    "カタカナ",
    "안녕하세요",
    "Привет",
    "مرحبا",
    "สวัสดี",
    "नमस्ते",
    "שלום",
    "Hello 你好",
    "12345",
    "한국어 mixed English",
    "日本語のテキスト with latin",
  ];
  for (const sample of samples) {
    assert.equal(
      mockContext.mockDetectSourceLang(sample),
      context.qtDetectSourceLang(sample),
      "mock and renderer disagree for " + JSON.stringify(sample)
    );
  }
});

test("history filtering is case-insensitive over source and target", () => {
  const entries = [
    { id: "a", source: "Hello World", target: "你好，世界" },
    { id: "b", source: "Good morning", target: "早上好" },
    { id: "c", source: "Error handling", target: "错误处理" },
  ];

  assert.deepEqual(plain(context.qtFilterHistory(entries, "")).map((entry) => entry.id), [
    "a",
    "b",
    "c",
  ]);
  // The empty query returns a copy, never the live array.
  const copy = context.qtFilterHistory(entries, "");
  assert.notEqual(copy, entries);

  assert.deepEqual(
    plain(context.qtFilterHistory(entries, "hello")).map((entry) => entry.id),
    ["a"]
  );
  assert.deepEqual(
    plain(context.qtFilterHistory(entries, "  WORLD  ")).map((entry) => entry.id),
    ["a"]
  );
  assert.deepEqual(
    plain(context.qtFilterHistory(entries, "错误")).map((entry) => entry.id),
    ["c"]
  );
  assert.deepEqual(
    plain(context.qtFilterHistory(entries, "早上")).map((entry) => entry.id),
    ["b"]
  );
  assert.deepEqual(plain(context.qtFilterHistory(entries, "missing")), []);
});

test("history filtering tolerates malformed data", () => {
  assert.deepEqual(plain(context.qtFilterHistory(null, "x")), []);
  assert.deepEqual(plain(context.qtFilterHistory(undefined, "")), []);
  assert.deepEqual(plain(context.qtFilterHistory([null, "text", 42], "x")), []);
  assert.deepEqual(
    plain(context.qtFilterHistory([{ source: "abc" }, { target: "xyz" }], "y")).map(
      (entry) => entry.target
    ),
    ["xyz"]
  );
});

test("character counter counts code points like the Rust side", () => {
  assert.equal(context.qtCountChars(""), 0);
  assert.equal(context.qtCountChars(null), 0);
  assert.equal(context.qtCountChars(undefined), 0);
  assert.equal(context.qtCountChars("abc"), 3);
  assert.equal(context.qtCountChars("你好世界"), 4);
  assert.equal(context.qtCountChars("😀"), 1); // surrogate pair
  assert.equal(context.qtCountChars("a😀b"), 3);
  assert.equal(context.qtCountChars(12345), 5);
});

test("elapsed formatting shows seconds with one decimal or a dash", () => {
  assert.equal(context.qtFormatElapsed(842), "0.8 秒");
  assert.equal(context.qtFormatElapsed(842.6), "0.8 秒");
  assert.equal(context.qtFormatElapsed(1100), "1.1 秒");
  assert.equal(context.qtFormatElapsed(1000), "1.0 秒");
  assert.equal(context.qtFormatElapsed(499), "0.5 秒");
  assert.equal(context.qtFormatElapsed(2500), "2.5 秒");
  assert.equal(context.qtFormatElapsed(10000), "10.0 秒");
  assert.equal(context.qtFormatElapsed("120"), "0.1 秒");
  assert.equal(context.qtFormatElapsed(9), "0.0 秒");
  assert.equal(context.qtFormatElapsed(0), "—");
  assert.equal(context.qtFormatElapsed(null), "—");
  assert.equal(context.qtFormatElapsed(undefined), "—");
  assert.equal(context.qtFormatElapsed(""), "—");
  assert.equal(context.qtFormatElapsed(-5), "—");
  assert.equal(context.qtFormatElapsed("abc"), "—");
});

test("history time formatting uses the local 2026/11/02 10:15 shape", () => {
  const stamp = new Date(2026, 10, 2, 10, 15, 42, 0).getTime();
  assert.equal(context.qtFormatHistoryTime(stamp), "2026/11/02 10:15");
  assert.equal(context.qtFormatHistoryTime(0), "");
  assert.equal(context.qtFormatHistoryTime(null), "");
  assert.equal(context.qtFormatHistoryTime("invalid"), "");
});

test("request ids are unique and quick-prefixed", () => {
  const ids = new Set();
  for (let index = 0; index < 200; index += 1) {
    const id = context.qtMakeRequestId();
    assert.match(id, /^quick-[0-9a-z]+-[0-9a-z]{6}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 200);
});

test("input normalization trims and truncates to 20000 code points", () => {
  assert.equal(context.qtNormalizeInput("  hello  "), "hello");
  assert.equal(context.qtNormalizeInput(null), "");
  assert.equal(context.qtNormalizeInput(undefined), "");
  assert.equal(context.qtNormalizeInput("   "), "");

  const long = "a".repeat(20001);
  assert.equal(context.qtNormalizeInput(long).length, 20000);

  // Code-point truncation never splits a surrogate pair in half.
  const emoji = "😀".repeat(20005);
  const truncated = context.qtNormalizeInput(emoji);
  assert.equal(Array.from(truncated).length, 20000);
  assert.equal(context.qtDetectSourceLang(truncated), "en");

  // Trimming happens before truncation, so the limit applies to the payload.
  const padded = " " + "b".repeat(20000) + " ";
  assert.equal(context.qtNormalizeInput(padded).length, 20000);
});

test("source language selector list covers auto + project + extra languages", () => {
  const list = json(context.qtSourceLanguages(projectLanguages));
  assert.equal(list.length, 1 + projectLanguages.length + 28);
  assert.deepEqual(list[0], { value: "auto", label: "自动识别" });

  const values = list.map((entry) => entry.value);
  assert.equal(new Set(values).size, values.length, "values must be unique");
  assert.ok(values.every((value) => typeof value === "string" && value.length > 0));
  assert.ok(
    list.every((entry) => /[\u4e00-\u9fff]/.test(entry.label)),
    "every label is Chinese"
  );

  const byValue = Object.fromEntries(list.map((entry) => [entry.value, entry.label]));
  // Project target languages keep their labels.
  for (const [code, label] of [
    ["zh", "中文"],
    ["en", "英语"],
    ["zh-hant", "繁体中文"],
    ["yue", "粤语"],
  ]) {
    assert.equal(byValue[code], label);
  }
  // Extra common source languages (patch list order/labels).
  const extras = {
    sv: "瑞典语",
    no: "挪威语",
    da: "丹麦语",
    fi: "芬兰语",
    el: "希腊语",
    hu: "匈牙利语",
    ro: "罗马尼亚语",
    sk: "斯洛伐克语",
    sl: "斯洛文尼亚语",
    hr: "克罗地亚语",
    sr: "塞尔维亚语",
    lt: "立陶宛语",
    lv: "拉脱维亚语",
    et: "爱沙尼亚语",
    is: "冰岛语",
    bg: "保加利亚语",
    be: "白俄罗斯语",
    az: "阿塞拜疆语",
    uz: "乌兹别克语",
    ka: "格鲁吉亚语",
    hy: "亚美尼亚语",
    sq: "阿尔巴尼亚语",
    ca: "加泰罗尼亚语",
    cy: "威尔士语",
    ga: "爱尔兰语",
    mt: "马耳他语",
    af: "南非荷兰语",
    sw: "斯瓦希里语",
  };
  assert.equal(Object.keys(extras).length, 28);
  for (const [code, label] of Object.entries(extras)) {
    assert.equal(byValue[code], label, code);
  }
});

test("source language list drops duplicates and keeps base labels", () => {
  const base = [
    { value: "auto", label: "不应出现" },
    { value: "sv", label: "自定义瑞典语" },
    { value: "zh", label: "中文" },
  ];
  const list = json(context.qtSourceLanguages(base));
  assert.equal(list.filter((entry) => entry.value === "auto").length, 1);
  assert.equal(list.filter((entry) => entry.value === "sv").length, 1);
  assert.equal(list.find((entry) => entry.value === "sv").label, "自定义瑞典语");
  assert.equal(list.find((entry) => entry.value === "zh").label, "中文");

  // Missing/hostile base data must not break the selector.
  assert.equal(json(context.qtSourceLanguages(null))[0].value, "auto");
  assert.equal(json(context.qtSourceLanguages([null, {}, { label: "x" }])).length, 1 + 28);
});

test("source language normalization falls back to auto", () => {
  const list = json(context.qtSourceLanguages(projectLanguages));
  assert.equal(context.qtNormalizeSourceLang("sv", list), "sv");
  assert.equal(context.qtNormalizeSourceLang("zh", list), "zh");
  assert.equal(context.qtNormalizeSourceLang("auto", list), "auto");
  assert.equal(context.qtNormalizeSourceLang(" mars ", list), "auto");
  assert.equal(context.qtNormalizeSourceLang("", list), "auto");
  assert.equal(context.qtNormalizeSourceLang(null, list), "auto");
  assert.equal(context.qtNormalizeSourceLang(undefined, list), "auto");
});

test("history source language labels use the Chinese table and never auto", () => {
  const list = json(context.qtSourceLanguages(projectLanguages));
  assert.equal(context.qtSourceLangLabel("sv", list), "瑞典语");
  assert.equal(context.qtSourceLangLabel("zh", list), "中文");
  assert.equal(context.qtSourceLangLabel("zh-hant", list), "繁体中文");
  assert.equal(context.qtSourceLangLabel("en", list), "英语");
  assert.equal(context.qtSourceLangLabel("auto", list), "");
  assert.equal(context.qtSourceLangLabel("", list), "");
  assert.equal(context.qtSourceLangLabel(null, list), "");
  // Unknown codes fall back to the upper-cased code (e.g. a new detector code).
  assert.equal(context.qtSourceLangLabel("xx", list), "XX");
  assert.equal(context.qtSourceLangLabel("sv-se", list), "SV-SE");
});

test("preview mock accepts exactly the same extra source languages", () => {
  // The mock keeps its own copy of the extra codes; keep both lists in sync.
  const mockExtraSource = /var MOCK_EXTRA_SOURCE_LANGS = \[([\s\S]*?)\];/.exec(apiSource);
  assert.notEqual(mockExtraSource, null);
  const mockExtra = (mockExtraSource[1].match(/"([a-z]+)"/g) || []).map((value) =>
    value.replace(/"/g, "")
  );
  const frontendList = json(context.qtSourceLanguages(projectLanguages));
  const frontendExtra = frontendList
    .map((entry) => entry.value)
    .filter((value) => !projectLanguages.some((entry) => entry.value === value) && value !== "auto");
  assert.deepEqual(mockExtra.slice().sort(), frontendExtra.slice().sort());
  assert.equal(mockExtra.length, 28);

  // mockSourceLangValid mirrors qtNormalizeSourceLang for the same inputs.
  const mockContext = vm.createContext({
    window: { LP: { LANGUAGES: projectLanguages } },
    MOCK_EXTRA_SOURCE_LANGS: mockExtra,
    console,
  });
  vm.runInContext(extract(apiSource, "mockSourceLangValid"), mockContext);
  for (const code of ["auto", "sv", "zh", "en", "zh-hant", "yue", "xx", "", null, undefined, "SV"]) {
    const previewValid = mockContext.mockSourceLangValid(code) === true;
    const frontendValid = context.qtNormalizeSourceLang(code, frontendList) === String(code == null ? "" : code).trim() && String(code == null ? "" : code).trim() !== "";
    assert.equal(previewValid, frontendValid, "source language " + JSON.stringify(code));
  }
});

test("preview mock keeps quick word-lookup prompt and source language", async () => {
  const mockWindow = {
    location: { search: "" },
    setTimeout: (callback) => setTimeout(callback, 0),
    clearTimeout,
    setInterval: (callback) => setInterval(callback, 0),
    clearInterval,
  };
  const mockContext = vm.createContext({ window: mockWindow, console });
  const load = (file) =>
    vm.runInContext(fs.readFileSync(path.join(__dirname, "shared", file), "utf8"), mockContext);
  load("constants.js");
  load("tauri-api.js");
  const settingsApi = mockWindow.settingsAPI;

  let result = await settingsApi.updateSettings({
    quick: { sourceLang: "sv", wordLookupPrompt: "  custom word prompt  " },
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.settings.quick.sourceLang, "sv");
  assert.equal(result.state.settings.quick.wordLookupPrompt, "custom word prompt");
  result = await settingsApi.getState();
  assert.equal(result.state.settings.quick.sourceLang, "sv");
  assert.equal(result.state.settings.quick.wordLookupPrompt, "custom word prompt");

  // Unknown source codes normalize back to "auto".
  result = await settingsApi.updateSettings({ quick: { sourceLang: "xx" } });
  assert.equal(result.state.settings.quick.sourceLang, "auto");

  // quick_ready exposes the remembered source language and both prompt defaults.
  const quick = await mockWindow.quickAPI.ready();
  assert.equal(quick.quick.sourceLang, "auto");
  const state = (await settingsApi.getState()).state;
  assert.ok(
    typeof state.promptDefaults.quickTranslateWordLookup === "string" &&
      state.promptDefaults.quickTranslateWordLookup.includes("{target}")
  );

  // A quick translation with a pinned source language stores that code in the
  // simulated history (the stream itself is accelerated in this mock window).
  const requestId = "quick-test-" + Date.now().toString(36);
  const translated = await mockWindow.quickAPI.translate(
    requestId,
    "Det här är ett test.",
    "zh",
    "sv"
  );
  assert.equal(translated.ok, true);
  let entries = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    entries = (await mockWindow.quickAPI.historyList()).entries;
    if (entries.length) {
      break;
    }
  }
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sourceLang, "sv");
  assert.equal(entries[0].targetLang, "zh");

  // Omitting sourceLang falls back to the remembered quick.sourceLang (shell
  // semantics: empty/invalid -> quick.sourceLang, then detect only if "auto").
  await settingsApi.updateSettings({ quick: { sourceLang: "sv" } });
  const fallbackRequestId = "quick-fallback-" + Date.now().toString(36);
  const fallback = await mockWindow.quickAPI.translate(
    fallbackRequestId,
    "Ett till test.",
    "zh"
  );
  assert.equal(fallback.ok, true);
  let entriesAfterFallback = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    entriesAfterFallback = (await mockWindow.quickAPI.historyList()).entries;
    if (entriesAfterFallback.length >= 2) {
      break;
    }
  }
  assert.equal(entriesAfterFallback.length, 2);
  // "Ett till test." is Latin; without the fallback the mock would store "en".
  assert.equal(entriesAfterFallback[0].sourceLang, "sv");
});
