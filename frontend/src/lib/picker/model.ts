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
  skills?: PickerSkill[];
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

/** Skills from the payload config, normalized for rendering. */
export function payloadSkills(payload: PickerPayload | null): PickerSkill[] {
  const skills = payload?.config?.skills;
  if (!Array.isArray(skills)) return [];
  return skills
    .filter((skill): skill is PickerSkill => !!skill && typeof skill.id === "string")
    .map((skill) => ({
      id: skill.id,
      label: typeof skill.label === "string" ? skill.label : undefined,
      icon: typeof skill.icon === "string" ? skill.icon : undefined,
      custom: skill.custom === true,
      kind: skill.kind === "image" ? "image" : "text",
    }));
}
