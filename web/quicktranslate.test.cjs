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
]) {
  vm.runInContext(extract(quickSource, name), context);
}

/* Cross-realm arrays need a copy before deepEqual: the vm context has its own
 * Array prototype. */
function plain(list) {
  return Array.from(list);
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
