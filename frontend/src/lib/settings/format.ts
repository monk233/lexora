/* Formatting helpers shared by the settings cards.
 *
 * Task 4 needs the two legacy helpers used by the online panel: byte sizes
 * (later reused by the model catalog) and connection latency. Behaviour is a
 * mechanical port of `web/shared/constants.js` (LP.formatBytes / LP.formatMs).
 */

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
  const text =
    index === 0 || scaled >= 10 ? String(Math.round(scaled)) : scaled.toFixed(1);
  return `${text} ${units[index]}`;
}

export function formatMs(ms: number): string {
  return `${Math.round(Number(ms) || 0)} ms`;
}
