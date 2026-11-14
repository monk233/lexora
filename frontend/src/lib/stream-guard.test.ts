/* Vitest port of the guardRepetition cases in web/picker-repetition.test.cjs.
 *
 * Ported (guard-level expectations, inputs and expected values unchanged):
 *   - "translation and polish preserve repeated source structure and following content"
 *     (only the three h.guard(...) assertions; the streaming-harness assertions
 *      for handleTranslateEvent / done belong to P3)
 *   - "source repetition allowance is bounded and does not exempt image translation"
 *   - "exact Markdown paragraphs and list items stop at three copies, retain first"
 *   - "long tail periods require four copies, including Unicode and arbitrary chunk boundaries"
 *     (cycle detection assertions; the per-character streaming part stays in P3)
 *   - "normal terminology, nonconsecutive repetition and recovery do not trigger"
 *   - "code fences, indented code, tables and blockquotes remain literal"
 *   - "OCR remains exempt in unified stream handler" (guard-level projection:
 *      request { kind: "image", imageAction: "ocr" } returns the input untouched;
 *      the stream/request-state assertions are deferred to P3)
 *   - "short translated words and sentences remain literal"
 *   - "inline code is preserved across arbitrary chunks and history stays complete"
 *     (guard-level projection: each raw input is returned unchanged; chunking and
 *      history assertions are deferred to P3)
 *   - "loop cleanup retains closed inline code and only one repeated paragraph in history"
 *     (guard-level projection: text is truncated after the first paragraph; the
 *      history assertions are deferred to P3)
 *
 * Left for P3 (DOM / state / stream orchestration, not guardRepetition):
 *   - "repeated retry clicks while another follow-up is busy leave history and DOM intact"
 *   - "cross-chunk and single-chunk loops share cancellation and cleaned history"
 *   - "retry replaces partial follow-up history and a new request starts clean"
 *   - "translation, image translation, polish and custom stop repeated natural-language bullets"
 *     (stream handler + stopRepeatedRequest)
 */
import { expect, test } from "vitest";
import { guardRepetition } from "./stream-guard";

const paragraph = "模型应聚焦问题，给出简洁且准确的回答。";
const cycle = "这是一段超过二十四个字符的重复内容，用于验证没有换行时的循环防护。";

test("translation and polish preserve repeated source structure and following content", () => {
  for (const kind of ["translate", "polish"]) {
    expect(guardRepetition((paragraph + "\n\n").repeat(3), { kind }, "One source paragraph.").repeated).toBe(true);
    expect(guardRepetition(("- " + paragraph + "\n").repeat(3), { kind }, "carzy").repeated).toBe(true);
    expect(guardRepetition("word\n".repeat(10), { kind }, "word").repeated).toBe(false);
  }
});

test("source repetition allowance is bounded and does not exempt image translation", () => {
  const original = ("Repeated source paragraph.\n\n").repeat(3);
  expect(guardRepetition((paragraph + "\n\n").repeat(4), { kind: "translate" }, original).repeated).toBe(true);
  expect(guardRepetition((paragraph + "\n\n").repeat(3), { kind: "image", imageAction: "translate" }, original).repeated).toBe(true);
});

test("exact Markdown paragraphs and list items stop at three copies, retain first", () => {
  for (const text of [paragraph + "\n\n", paragraph + "\n补充说明说明。\n\n", "- " + paragraph + "\n", "1. " + paragraph + "\n"]) {
    const result = guardRepetition("前言\n\n" + text.repeat(3));
    expect(result.repeated).toBe(true);
    expect(result.text).toBe("前言\n\n" + text.trimEnd());
  }
  expect(guardRepetition((paragraph + "\n\n").repeat(2)).repeated).toBe(false);
});

test("long tail periods require four copies, including Unicode and arbitrary chunk boundaries", () => {
  expect(guardRepetition(cycle.repeat(3)).repeated).toBe(false);
  expect(guardRepetition(cycle.repeat(4)).text).toBe(cycle);
  expect(guardRepetition(cycle.repeat(180)).text).toBe(cycle);
  expect(guardRepetition((paragraph + "\n\n").repeat(300)).text).toBe(paragraph);
});

test("normal terminology, nonconsecutive repetition and recovery do not trigger", () => {
  for (const text of [
    "模型 ".repeat(70), "token ".repeat(70),
    paragraph + "\n\n" + paragraph + "\n\n新的解释内容。",
    [paragraph, "另一个观点", paragraph, "第三个观点", paragraph].join("\n\n"),
    ["- 模型用于翻译", "- 模型用于解释", "- 模型用于总结"].join("\n"),
  ]) expect(guardRepetition(text).repeated, text).toBe(false);
});

test("code fences, indented code, tables and blockquotes remain literal", () => {
  const lines = (paragraph + "\n\n").repeat(4);
  for (const text of [
    "```text\n" + lines + "```", "~~~~\n" + cycle.repeat(5) + "\n~~~~",
    "````\n```\n" + lines + "````", "```\n" + lines,
    ("    " + cycle + "\n").repeat(5), ("\t" + cycle + "\n").repeat(5),
    ("| " + cycle + " |\n").repeat(5), ("> " + cycle + "\n").repeat(5),
    "> 引用开始\n" + cycle.repeat(5),
  ]) expect(guardRepetition(text).repeated, text).toBe(false);
  expect(guardRepetition("```\ncode\n```\n\n" + lines).repeated).toBe(true);
  expect(guardRepetition(paragraph + "\n\n```\ncode\n```\n\n" + (paragraph + "\n\n").repeat(2)).repeated).toBe(false);
});

test("OCR remains exempt in unified stream handler", () => {
  const raw = (paragraph + "\n\n").repeat(5);
  const result = guardRepetition(raw, { kind: "image", imageAction: "ocr" });
  expect(result.repeated).toBe(false);
  expect(result.text).toBe(raw);
});

test("short translated words and sentences remain literal", () => {
  for (const text of ["你好\n".repeat(5), "- hello world\n".repeat(5), "谢谢 谢谢 谢谢", "word ".repeat(60)]) {
    expect(guardRepetition(text, { kind: "translate" }).repeated, text).toBe(false);
  }
  expect(guardRepetition(("测量误差的累积性是指\n").repeat(3), { kind: "translate" }).repeated).toBe(true);
});

test("inline code is preserved across arbitrary chunks and history stays complete", () => {
  for (const raw of [
    ("`SELECT id FROM users WHERE active = 1;`\n").repeat(4),
    ("``SELECT `id` FROM users WHERE active = 1;``\n").repeat(4),
    "`" + cycle.repeat(5) + "`",
    "`SELECT\n" + cycle.repeat(5) + "`",
  ]) {
    const result = guardRepetition(raw);
    expect(result.repeated).toBe(false);
    expect(result.text).toBe(raw);
  }
});

test("loop cleanup retains closed inline code and only one repeated paragraph in history", () => {
  const prefix = "`SELECT id FROM users;`\n\n";
  const result = guardRepetition(prefix + (paragraph + "\n\n").repeat(5));
  expect(result.repeated).toBe(true);
  expect(result.text).toBe(prefix + paragraph);
});
