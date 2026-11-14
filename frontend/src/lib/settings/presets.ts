/* Provider presets (C05) and pre-flight base-URL validation (C06/C11/C13).
 *
 * The base URLs are copied verbatim from `web/shared/constants.js:182-240`
 * (LP.PRESETS): they are product data, not formatting, so they must not drift.
 * Only `opencode-go` carries a separate models base URL, and switching a preset
 * always clears the API key, the model name and the fetched model list.
 */
import type { SettingsPatch } from "./types";

export type PresetId =
  | "deepseek"
  | "openai"
  | "moonshot"
  | "zhipu"
  | "opencode-go"
  | "ollama"
  | "lmstudio"
  | "custom";

export interface ProviderPreset {
  id: PresetId;
  baseUrl: string;
  modelsBaseUrl: string;
  needsKey: boolean;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    modelsBaseUrl: "",
    needsKey: true,
  },
  {
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelsBaseUrl: "",
    needsKey: true,
  },
  {
    id: "moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    modelsBaseUrl: "",
    needsKey: true,
  },
  {
    id: "zhipu",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    modelsBaseUrl: "",
    needsKey: true,
  },
  {
    id: "opencode-go",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    modelsBaseUrl: "https://opencode.ai/inference/go/v1",
    needsKey: true,
  },
  {
    id: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    modelsBaseUrl: "",
    needsKey: false,
  },
  {
    id: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    modelsBaseUrl: "",
    needsKey: false,
  },
  {
    id: "custom",
    baseUrl: "",
    modelsBaseUrl: "",
    needsKey: true,
  },
];

const PRESET_MAP: Record<string, ProviderPreset> = Object.fromEntries(
  PRESETS.map((preset) => [preset.id, preset])
);

/** Unknown ids resolve to `undefined` so render sites can fall back to `custom`. */
export function presetFor(id: string): ProviderPreset | undefined {
  return PRESET_MAP[String(id ?? "")];
}

export function presetLabelKey(id: PresetId): string {
  return `settings.preset.${id}.label`;
}

export function presetHintKey(id: PresetId): string {
  return `settings.preset.${id}.hint`;
}

/**
 * Patch applied when the preset select changes: fills the preset's base URLs
 * and clears the key / model / fetched list. A model name is never pre-filled
 * (contracts.md §7.2) — the user pulls `/models` and picks one explicitly.
 */
export function presetPatch(id: string): SettingsPatch {
  const preset = presetFor(id);
  const known = preset && preset.id !== "custom" ? preset : undefined;
  return {
    provider: {
      online: {
        preset: known ? known.id : "custom",
        baseUrl: known ? known.baseUrl : "",
        modelsBaseUrl: known ? known.modelsBaseUrl : "",
        apiKey: "",
        model: "",
      },
    },
  };
}

export type BaseUrlValidation =
  | { ok: true; url: string }
  | { ok: false; key: "settings.error.baseUrlRequired" | "settings.error.baseUrlScheme" };

/** Front-end pre-flight check shared by "fetch models" and "test connection". */
export function validateBaseUrl(raw: string): BaseUrlValidation {
  const url = String(raw ?? "").trim();
  if (!url) return { ok: false, key: "settings.error.baseUrlRequired" };
  if (!/^https?:\/\//i.test(url)) return { ok: false, key: "settings.error.baseUrlScheme" };
  return { ok: true, url };
}
