/* Quick-translate window model (P4).
 *
 * Mirrors contracts §7.4: two columns (source text / streamed translation),
 * source language `auto` or a pinned code, 38 target languages, recent history
 * in `quick-history.json`.
 */

export type QuickLocale = "zh" | "en";

export interface QuickConfig {
  sourceLang?: string;
  targetLang?: string;
  pinned?: boolean;
  enabled?: boolean;
  hotkey?: string;
}

export interface QuickReadyResult {
  ok: boolean;
  locale?: QuickLocale;
  config?: QuickConfig;
  error?: string;
}

export interface QuickHistoryEntry {
  id: string;
  source: string;
  target: string;
  sourceLang?: string;
  targetLang?: string;
  createdAt?: number;
  elapsedMs?: number;
}

export const QUICK_SOURCE_AUTO = "auto";
export const QUICK_MAX_CHARS = 20000;

/** Source languages = auto + every target language (contracts §7.4:459). */
export function sourceLangOptions(targets: readonly { value: string; label: string }[]) {
  return [{ value: QUICK_SOURCE_AUTO, label: "" }, ...targets];
}

export function normalizeTargetLang(value: unknown, fallback = "zh"): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return fallback;
  return raw;
}

export function normalizeSourceLang(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw || QUICK_SOURCE_AUTO;
}

/** "Took 1.1s" / "耗时 1.1 秒" — seconds with one decimal. */
export function elapsedText(
  elapsedMs: number | undefined,
  locale: QuickLocale,
  template: (seconds: string) => string
): string | null {
  if (!elapsedMs || elapsedMs <= 0) return null;
  return template((elapsedMs / 1000).toFixed(1));
}
