/* Formatting helpers shared by the settings cards.
 *
 * Task 4 needs the two legacy helpers used by the online panel: byte sizes
 * (reused again by the model catalog) and connection latency. Task 5 adds the
 * download copy and the quantization pill. Everything here is a port of
 * `web/shared/constants.js` (LP.formatBytes / LP.formatMs / LP.quantLabel) or of
 * the legacy render helpers (`renderEngineProgress` / `catalogProgressText`);
 * these are pure functions so they can be unit tested without a component.
 */
import type { DownloadProgress } from "./types";

/** `<= 0` and non-finite values render as an em dash, like the legacy helper. */
export function formatBytes(bytes: number): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let scaled = value;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  /* Integral values (1 KB, 4 KB) keep no trailing decimal; only fractional
   * magnitudes inside 1..10 get one digit. */
  const integral = index === 0 || scaled >= 10 || Number.isInteger(scaled);
  const text = integral ? String(Math.round(scaled)) : scaled.toFixed(1);
  return `${text} ${units[index]}`;
}

export function formatMs(ms: number): string {
  return `${Math.round(Number(ms) || 0)} ms`;
}

/** Quantization pill ("Q4_K_M") from a GGUF filename; "" when unknown.
 * Legacy `LP.quantLabel` only understands `_` inside the suffix, while the
 * catalog filenames use `-` as well, so the separator is normalized before the
 * label is upper-cased (plan Task 5 Step 1). */
export function quantLabel(filename: string): string {
  const match =
    /(?:^|[-_.])((?:iq|q)\d(?:[-_][a-z0-9]){0,3})(?:[-_.]|$)/i.exec(String(filename ?? ""));
  return match ? match[1].replace(/-/g, "_").toUpperCase() : "";
}

/** `downloading` and `verifying` are the only states that own a UI slot; a
 * failed / cancelled payload only signals that the slot must be dropped. */
export function isActiveDownload(progress: DownloadProgress | null | undefined): boolean {
  return (
    !!progress &&
    (progress.status === "downloading" || progress.status === "verifying")
  );
}

/**
 * Active download for an engine (`id === "engine"`) or a catalog id.
 *
 * The engine task carries `kind: "engine"` and an empty id, so it is matched on
 * the kind alone; model tasks must match both kind and id (legacy
 * `activeDownload(kind, id)`, settings.js:987-1000).
 */
export function activeDownloadFor(
  downloads: DownloadProgress[],
  id: string
): DownloadProgress | undefined {
  const engine = id === "engine";
  return downloads.find((progress) => {
    if (!isActiveDownload(progress)) return false;
    if (progress.kind !== (engine ? "engine" : "model")) return false;
    return engine || String(progress.id ?? "") === String(id);
  });
}

function percentValue(percent: number): number {
  return Math.round(Math.max(0, Math.min(100, Number(percent) || 0)));
}

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Engine download line: `校验中…` or `received / total · N%`. */
export function engineProgressText(progress: DownloadProgress, t: Translate): string {
  if (progress.status === "verifying") return t("settings.status.verifying");
  return `${formatBytes(progress.received)} / ${formatBytes(progress.total)} · ${percentValue(progress.percent)}%`;
}

/**
 * Catalog row line. A Qwen3.5 download fetches the main GGUF and then the
 * mmproj projector; naming that stage keeps the percentage from looking like it
 * restarted (legacy `catalogProgressText`, settings.js:1314-1326).
 */
export function catalogProgressText(progress: DownloadProgress, t: Translate): string {
  if (progress.status === "verifying") return t("settings.status.verifying");
  const percent = percentValue(progress.percent);
  if (/^mmproj-/i.test(String(progress.filename ?? ""))) {
    return t("settings.catalog.mmproj", { percent });
  }
  return `${percent}%`;
}
