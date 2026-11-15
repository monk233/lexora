/* Picker window data model (P3).
 *
 * Shapes mirror docs/contracts.md §6.2 (`PickerPayload`) and §10.5
 * (`picker-image`); fields are camelCase because Rust serializes them that way.
 */

export type PickerSurface = "panel" | "toolbar";

export type PickerPanelSurface = "panel" | "toolbar";

export interface PickerSkill {
  id: string;
  label?: string;
  icon?: string;
  custom?: boolean;
  kind?: "text" | "image";
}

export interface PickerConfig {
  /** Enabled skill ids, backend order (selection.rs sends strings). */
  skills?: string[];
  /** Metadata for custom skills only. */
  customSkills?: PickerSkill[];
  compact?: boolean;
  defaultTargetLang?: string;
  searchEngine?: string;
  suggestionsAvailable?: boolean;
  panelMode?: "auto" | "scroll";
  [key: string]: unknown;
}

export interface PickerPayload {
  text: string;
  programName?: string;
  anchorX?: number;
  anchorY?: number;
  scaleFactor?: number;
  config?: PickerConfig;
  [key: string]: unknown;
}

export type CaptureAction = "ocr" | "translate" | "explain" | "custom";

export interface PickerImage {
  requestId: string;
  action: CaptureAction;
  skillId?: string;
  label: string;
  targetLang?: string;
  clipboard?: boolean;
  hint?: string;
}

/** Which surface this window is: `picker.html` vs `picker.html?surface=toolbar`. */
export function detectSurface(search: string = window.location.search): PickerSurface {
  return new URLSearchParams(search).get("surface") === "toolbar" ? "toolbar" : "panel";
}

/** Built-in skill icons (web/shared/constants.js SKILLS[].icon). */
export const BUILTIN_SKILL_ICONS: Record<string, string> = {
  translate: "languages",
  summarize: "list",
  explain: "lightbulb",
  polish: "wand-sparkles",
  read: "volume-2",
  copy: "copy",
  screenshot: "scan-eye",
  search: "search",
};

/** Default toolbar order (contracts §7.1; web/shared/constants.js DEFAULT_SKILLS). */
export const DEFAULT_SKILL_IDS = [
  "translate",
  "summarize",
  "explain",
  "polish",
  "read",
  "copy",
  "screenshot",
  "search",
] as const;

/**
 * Skills from the payload config, normalized for rendering.
 *
 * The shell sends `config.skills` as a string-id array (selection.rs; legacy
 * picker.js:3482-3490), with metadata for custom skills in
 * `config.customSkills`. Built-in labels/icons are resolved from i18n /
 * BUILTIN_SKILL_ICONS by the renderer.
 */
export function payloadSkills(payload: PickerPayload | null): PickerSkill[] {
  const config = payload?.config;
  const custom = Array.isArray(config?.customSkills) ? config.customSkills : [];
  const metaById = new Map<string, PickerSkill>();
  for (const entry of custom) {
    if (!entry || typeof entry.id !== "string") continue;
    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : "";
    metaById.set(entry.id, {
      id: entry.id,
      label: label || undefined,
      icon: typeof entry.icon === "string" && entry.icon.trim() ? entry.icon.trim() : undefined,
      custom: true,
      kind: entry.kind === "image" ? "image" : "text",
    });
  }

  const ids = Array.isArray(config?.skills) ? config.skills : [];
  const seen = new Set<string>();
  const skills: PickerSkill[] = [];
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const meta = metaById.get(id);
    skills.push(
      meta ?? {
        id,
        icon: BUILTIN_SKILL_ICONS[id],
        custom: false,
        kind: "text",
      }
    );
  }

  if (skills.length > 0) return skills;
  return DEFAULT_SKILL_IDS.map((id) => ({
    id,
    icon: BUILTIN_SKILL_ICONS[id],
    custom: false,
    kind: id === "screenshot" ? "image" : "text",
  }));
}
