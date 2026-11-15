/* Pinned image window model (P4).
 *
 * `pin.html?id=<id>&lang=<zh|en>`; `pin_ready` returns the image as a data URL.
 * The annotation editor (pin-edit mode) reuses the capture annotation canvas and
 * is migrated with the capture workspaces in P5 — P4 delivers the display,
 * zoom, drag, copy and close paths.
 */

export interface PinReadyResult {
  ok: boolean;
  dataUrl?: string;
  error?: string;
  hint?: string;
}

export const PIN_ZOOM_STEP = 1.1;
export const PIN_MIN_ZOOM = 0.15;
export const PIN_MAX_ZOOM = 1;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return PIN_MAX_ZOOM;
  return Math.min(PIN_MAX_ZOOM, Math.max(PIN_MIN_ZOOM, zoom));
}

export function zoomIn(zoom: number): number {
  return clampZoom(zoom * PIN_ZOOM_STEP);
}

export function zoomOut(zoom: number): number {
  return clampZoom(zoom / PIN_ZOOM_STEP);
}

/** The image renders at `naturalSize * zoom` CSS pixels (1 = pixel-perfect). */
export function renderedSize(naturalWidth: number, naturalHeight: number, zoom: number) {
  const clamped = clampZoom(zoom);
  return {
    width: Math.max(1, Math.round(naturalWidth * clamped)),
    height: Math.max(1, Math.round(naturalHeight * clamped)),
  };
}

export function pinIdFromSearch(search: string = window.location.search): string {
  return new URLSearchParams(search).get("id") || "";
}
