/* Capture overlay model (P5).
 *
 * The overlay covers one monitor; Rust grabs the screenshot and returns it as a
 * data URL (`capture_monitor_info`). Selection rectangles are logical CSS pixels
 * inside the overlay; commands that crop the real image take the same rect.
 */

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MonitorInfo {
  ok: boolean;
  dataUrl?: string;
  width?: number;
  height?: number;
  originX?: number;
  originY?: number;
  scaleFactor?: number;
  error?: string;
  hint?: string;
}

export const MIN_SELECTION = 4;

export function monitorIndexFromSearch(search: string = window.location.search): number {
  const raw = new URLSearchParams(search).get("monitor");
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function normalizeRect(rect: CaptureRect): CaptureRect {
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  return { x, y, width, height };
}

export function rectFromPoints(ax: number, ay: number, bx: number, by: number): CaptureRect {
  return normalizeRect({
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(ax - bx),
    height: Math.abs(ay - by),
  });
}

export function clampRect(rect: CaptureRect, width: number, height: number): CaptureRect {
  const x = Math.min(Math.max(0, rect.x), Math.max(0, width - 1));
  const y = Math.min(Math.max(0, rect.y), Math.max(0, height - 1));
  const w = Math.min(rect.width, Math.max(1, width - x));
  const h = Math.min(rect.height, Math.max(1, height - y));
  return normalizeRect({ x, y, width: w, height: h });
}

export function rectContains(rect: CaptureRect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height;
}

/** Screenshot pixel rect: logical overlay coordinates are 1:1 with the image. */
export function physicalRect(rect: CaptureRect): CaptureRect {
  return normalizeRect(rect);
}

/** Toolbar placement: below the selection, or above when there is no room. */
export function toolbarPosition(rect: CaptureRect, viewportHeight: number, toolbarHeight = 40) {
  const below = rect.y + rect.height + 8;
  const above = rect.y - toolbarHeight - 8;
  if (below + toolbarHeight <= viewportHeight) return { top: below, left: rect.x };
  return { top: Math.max(0, above), left: rect.x };
}
