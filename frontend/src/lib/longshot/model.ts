/* Long screenshot models (P5c).
 *
 * `longshot` window = transparent preview frame with the stitched image;
 * `longshot-bar` = floating control bar (direction, auto-scroll, status,
 * cancel, finish) placed below the selection.
 */

export type LongshotDirection = "vertical" | "horizontal";

export interface LongshotProgress {
  width?: number;
  height?: number;
  frames?: number;
  stalled?: boolean;
}

export interface LongshotStateResult {
  ok: boolean;
  dataUrl?: string;
  width?: number;
  height?: number;
  frames?: number;
  direction?: LongshotDirection;
  autoscroll?: boolean;
  error?: string;
  hint?: string;
}

export function progressText(progress: LongshotProgress, template: (p: { frames: number; width: number; height: number }) => string): string {
  return template({
    frames: Number(progress.frames ?? 0),
    width: Number(progress.width ?? 0),
    height: Number(progress.height ?? 0),
  });
}

export function normalizeDirection(value: unknown): LongshotDirection {
  return String(value ?? "").toLowerCase() === "horizontal" ? "horizontal" : "vertical";
}

/** The preview scales to fit while keeping the aspect ratio. */
export function fitWithin(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
