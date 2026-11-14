/* Skill metadata and ordering helpers (C35/C36, contract §7.2).
 *
 * The ordering helper is the React port of `mergeCategoryOrder`
 * (`web/settings.js:2268-2284`): dragging inside one tab must never move the
 * other category's rows.
 */
import { expect, test } from "vitest";

import {
  DEFAULT_CAPTURE_SKILLS,
  DEFAULT_TEXT_SKILLS,
  IMAGE_SKILLS,
  TEXT_SKILLS,
  countTextSkills,
  mergeCategoryOrder,
  newCustomSkillId,
  normalizeIconKey,
  normalizePrompt,
  skillIconName,
} from "@/lib/settings/skills";
import type { CustomSkill } from "@/lib/settings/types";

test("mergeCategoryOrder only reshuffles the category's own slots", () => {
  const all = ["a", "c1", "b", "c2", "d"];
  expect(mergeCategoryOrder(all, ["c2", "c1"])).toEqual(["a", "c2", "b", "c1", "d"]);
});

test("mergeCategoryOrder keeps the other category's relative order", () => {
  expect(mergeCategoryOrder(["translate", "custom-img", "summarize"], ["summarize", "translate"]))
    .toEqual(["summarize", "custom-img", "translate"]);
});

test("normalizes prompts to the empty override sentinel", () => {
  expect(normalizePrompt("  ", "default")).toBe("");
  expect(normalizePrompt(" default ", "default")).toBe("");
  expect(normalizePrompt("custom", "default")).toBe("custom");
  expect(normalizePrompt("  custom  ", "default")).toBe("custom");
});

test("generates unique custom ids matching the backend pattern", () => {
  const id = newCustomSkillId(1760000000000, () => 0.5);
  expect(id).toMatch(/^custom-[a-z0-9_-]{1,40}$/);
  expect(newCustomSkillId(1760000000000, () => 0.5)).toBe(id);
  /* A different random draw must not collide with the same timestamp. */
  expect(newCustomSkillId(1760000000000, () => 0.25)).not.toBe(id);
});

test("a key that exists in the gallery wins over a legacy alias", () => {
  /* `pen`/`globe`/`book` are real Lucide keys as well as v0.1.x aliases:
   * remapping them made those three gallery entries unselectable. */
  expect(normalizeIconKey("pen")).toBe("pen");
  expect(normalizeIconKey("globe")).toBe("globe");
  expect(normalizeIconKey("book")).toBe("book");
});

test("maps legacy icon keys and falls back to sparkles", () => {
  expect(normalizeIconKey("zap")).toBe("zap");
  expect(normalizeIconKey("wand")).toBe("wand-sparkles");
  expect(normalizeIconKey("chat")).toBe("message-circle");
  expect(normalizeIconKey("not-a-real-icon")).toBe("sparkles");
  expect(normalizeIconKey("")).toBe("sparkles");
  expect(TEXT_SKILLS.map((skill) => skill.id)).toEqual([
    "translate",
    "summarize",
    "explain",
    "polish",
    "read",
    "copy",
    "screenshot",
    "search",
  ]);
  expect(IMAGE_SKILLS.map((skill) => skill.id)).toEqual([
    "pin",
    "shape",
    "arrow",
    "pen",
    "text",
    "number",
    "mosaic",
    "ocr",
    "translate",
    "explain",
    "longshot",
  ]);
});

test("default enabled lists mirror the Rust defaults", () => {
  expect(DEFAULT_TEXT_SKILLS).toEqual([
    "translate",
    "summarize",
    "explain",
    "read",
    "copy",
    "search",
  ]);
  expect(DEFAULT_CAPTURE_SKILLS).toEqual([
    "pin",
    "shape",
    "arrow",
    "pen",
    "text",
    "mosaic",
    "ocr",
    "translate",
    "explain",
  ]);
});

test("countTextSkills counts every text row and ignores image skills", () => {
  const custom: CustomSkill[] = [
    { id: "custom-txt", label: "Mine", icon: "zap", kind: "text", prompt: "p" },
    { id: "custom-img", label: "Shot", icon: "rocket", kind: "image", prompt: "p" },
  ];
  /* Legacy `textOrder.length`: enabled or disabled does not enter the count. */
  expect(countTextSkills([])).toBe(TEXT_SKILLS.length);
  expect(countTextSkills(custom)).toBe(TEXT_SKILLS.length + 1);
});

test("prompt slots are declared only for editable skills", () => {
  const slots = Object.fromEntries(
    [...TEXT_SKILLS, ...IMAGE_SKILLS].map((skill) => [skill.id, skill.promptSlots ?? []])
  );
  expect(slots.translate).toEqual(["translate", "wordLookup"]);
  expect(slots.summarize).toEqual(["summarize"]);
  expect(slots.explain).toEqual(["explain"]);
  expect(slots.polish).toEqual(["polish"]);
  expect(slots.read).toEqual([]);
  expect(slots.copy).toEqual([]);
  expect(slots.search).toEqual([]);
});

test("skillIconName prefers built-in icons and normalizes custom ones", () => {
  const custom: CustomSkill[] = [
    { id: "custom-abc", label: "Mine", icon: "chat", kind: "text", prompt: "p" },
  ];
  expect(skillIconName("translate", [])).toBe("languages");
  expect(skillIconName("summarize", [])).toBe("list");
  expect(skillIconName("search", [])).toBe("search");
  expect(skillIconName("custom-abc", custom)).toBe("message-circle");
  expect(skillIconName("custom-missing", custom)).toBe("sparkles");
});
