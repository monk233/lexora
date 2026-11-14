/* Built-in skill metadata, prompt slots and ordering helpers (C35/C36).
 *
 * These values are a mechanical port of the legacy shared constants and the
 * picker helpers:
 *   - `web/shared/constants.js` LP.SKILLS / PROMPT_SKILLS / icons;
 *   - `web/settings.js` CAPTURE_ACTION_META (screenshot toolbar icons);
 *   - `web/settings.js:2268-2284` mergeCategoryOrder;
 *   - `web/shared/skill-icons.js` LEGACY_SKILL_ICON_ALIASES;
 *   - Rust `settings.rs` SKILLS / CAPTURE_SKILLS / default_* (order matters).
 *
 * Labels and descriptions are deliberately not stored here: the UI resolves
 * them through `message packs` (`skill.<id>` / `capture.<id>`), which keeps the
 * English and Chinese copy in one place.
 */
import { CUSTOM_SKILL_ICON_KEYS } from "@/lib/constants";
import type { CustomSkill } from "./types";

export type PromptSlot = "translate" | "wordLookup" | "summarize" | "explain" | "polish";

export interface SkillMeta {
  id: string;
  kind: "text" | "image";
  /** lucide icon name in kebab-case (from the legacy SKILL_MAP). */
  icon: string;
  /** Message key for the row label. */
  labelKey: string;
  /** Which picker prompt map the editable slots write to. */
  promptTarget?: "prompts" | "capturePrompts";
  /** Only skills with an editable prompt declare slots. */
  promptSlots?: PromptSlot[];
}

/** Text-tab skills, including the screenshot entry (C35, legacy SKILL_IDS). */
export const TEXT_SKILLS: SkillMeta[] = [
  {
    id: "translate",
    kind: "text",
    icon: "languages",
    labelKey: "skill.translate",
    promptTarget: "prompts",
    promptSlots: ["translate", "wordLookup"],
  },
  {
    id: "summarize",
    kind: "text",
    icon: "list",
    labelKey: "skill.summarize",
    promptTarget: "prompts",
    promptSlots: ["summarize"],
  },
  {
    id: "explain",
    kind: "text",
    icon: "lightbulb",
    labelKey: "skill.explain",
    promptTarget: "prompts",
    promptSlots: ["explain"],
  },
  {
    id: "polish",
    kind: "text",
    icon: "wand-sparkles",
    labelKey: "skill.polish",
    promptTarget: "prompts",
    promptSlots: ["polish"],
  },
  { id: "read", kind: "text", icon: "volume-2", labelKey: "skill.read" },
  { id: "copy", kind: "text", icon: "copy", labelKey: "skill.copy" },
  { id: "screenshot", kind: "text", icon: "scan-eye", labelKey: "skill.screenshot" },
  { id: "search", kind: "text", icon: "search", labelKey: "skill.search" },
];

/** Screenshot toolbar entries (C37; rendered by the Task 7 image tab). */
export const IMAGE_SKILLS: SkillMeta[] = [
  { id: "pin", kind: "image", icon: "pin", labelKey: "capture.pin" },
  { id: "shape", kind: "image", icon: "square", labelKey: "capture.shape" },
  { id: "arrow", kind: "image", icon: "arrow-up-right", labelKey: "capture.arrow" },
  { id: "pen", kind: "image", icon: "pen", labelKey: "capture.pen" },
  { id: "text", kind: "image", icon: "type", labelKey: "capture.text" },
  { id: "number", kind: "image", icon: "hash", labelKey: "capture.number" },
  { id: "mosaic", kind: "image", icon: "layout-grid", labelKey: "capture.mosaic" },
  { id: "ocr", kind: "image", icon: "scan-text", labelKey: "capture.ocr" },
  {
    id: "translate",
    kind: "image",
    icon: "languages",
    labelKey: "capture.translate",
    promptTarget: "capturePrompts",
    promptSlots: ["translate", "wordLookup"],
  },
  {
    id: "explain",
    kind: "image",
    icon: "lightbulb",
    labelKey: "capture.explain",
    promptTarget: "capturePrompts",
    promptSlots: ["explain"],
  },
  { id: "longshot", kind: "image", icon: "scroll", labelKey: "capture.longshot" },
];

/** Rust `default_skills()`: every built-in text skill except polish/screenshot. */
export const DEFAULT_TEXT_SKILLS: string[] = TEXT_SKILLS.filter(
  (skill) => skill.id !== "polish" && skill.id !== "screenshot"
).map((skill) => skill.id);

/** Rust `default_capture_skills()`: every action except number/longshot. */
export const DEFAULT_CAPTURE_SKILLS: string[] = IMAGE_SKILLS.filter(
  (skill) => skill.id !== "number" && skill.id !== "longshot"
).map((skill) => skill.id);

/** Old settings may reference the 12 hand-drawn v0.1.x icons. */
export const LEGACY_SKILL_ICON_ALIASES: Readonly<Record<string, string>> = {
  sparkles: "sparkles",
  wand: "wand-sparkles",
  pen: "pen-line",
  book: "book-open",
  globe: "earth",
  code: "code",
  list: "list",
  chat: "message-circle",
  lightbulb: "lightbulb",
  quote: "quote",
  briefcase: "briefcase",
  star: "star",
};

const BUILTIN_ICONS: Record<string, string> = Object.fromEntries(
  [...TEXT_SKILLS, ...IMAGE_SKILLS].map((skill) => [skill.id, skill.icon])
);

const ICON_KEYS = new Set(CUSTOM_SKILL_ICON_KEYS);

/**
 * Refill the category's own slots while every other id keeps its position
 * (`web/settings.js:2268-2284`). Reference behavior, unit-tested for the
 * "other category unchanged" invariant.
 */
export function mergeCategoryOrder(all: string[], categoryOrder: string[]): string[] {
  const inCategory = new Set(categoryOrder);
  let cursor = 0;
  return all.map((id) => {
    if (!inCategory.has(id)) return id;
    const replacement = categoryOrder[cursor];
    cursor += 1;
    return replacement ?? id;
  });
}

/** `custom-<base36 timestamp><4 base36 chars>`, matching the Rust pattern. */
export function newCustomSkillId(now: number = Date.now(), random: () => number = Math.random): string {
  const stamp = Math.max(0, Math.floor(now)).toString(36);
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0")
    .slice(-4);
  return `custom-${stamp}${suffix}`;
}

/** Map a stored icon key through the legacy aliases; unknown keys fall back. */
export function normalizeIconKey(icon: string): string {
  const name = String(icon ?? "");
  const resolved = LEGACY_SKILL_ICON_ALIASES[name] ?? name;
  return ICON_KEYS.has(resolved) ? resolved : "sparkles";
}

/**
 * Save-value normalization for prompt overrides: trimmed, and an empty or
 * default-equal value becomes the empty override sentinel (falls back to the
 * bundled prompt on the backend).
 */
export function normalizePrompt(value: string, defaultPrompt: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed === String(defaultPrompt ?? "").trim()) return "";
  return trimmed;
}

/** Icon lookup for a built-in id or a custom skill. */
export function skillIconName(id: string, customSkills: CustomSkill[]): string {
  const builtin = BUILTIN_ICONS[id];
  if (builtin) return builtin;
  const custom = customSkills.find((skill) => skill.id === id);
  if (custom) return normalizeIconKey(custom.icon);
  return "sparkles";
}
