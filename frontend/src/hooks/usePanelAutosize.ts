/* Panel auto-size (P3, Task 8).
 *
 * `auto` mode (contracts §7.1:403): the window is 360px wide and grows with the
 * content up to `min(availableHeight - 80, 760)`; during a stream the height may
 * only increase (no flicker), and reports are merged at 200ms like the legacy
 * panel resizer. `scroll` mode keeps a fixed window and stores the user size in
 * localStorage (`lexora.panelSize`).
 */
import { useCallback, useEffect, useRef } from "react";

export const AUTO_PANEL_WIDTH = 360;
export const AUTO_PANEL_MAX_HEIGHT = 760;
export const AUTO_PANEL_SCREEN_MARGIN = 80;
export const PANEL_RESIZE_INTERVAL_MS = 200;
export const PANEL_SIZE_KEY = "lexora.panelSize";

export interface PanelSize {
  width: number;
  height: number;
}

export function readStoredPanelSize(): PanelSize | null {
  try {
    const raw = localStorage.getItem(PANEL_SIZE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PanelSize>;
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") return null;
    return { width: parsed.width, height: parsed.height };
  } catch {
    return null;
  }
}

export function storePanelSize(size: PanelSize): void {
  try {
    localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(size));
  } catch {
    /* storage may be unavailable: the panel then keeps its current size */
  }
}

export function availablePanelHeight(): number {
  if (typeof window === "undefined") return AUTO_PANEL_MAX_HEIGHT;
  const screenHeight = window.screen?.availHeight || window.innerHeight || 900;
  return Math.min(screenHeight - AUTO_PANEL_SCREEN_MARGIN, AUTO_PANEL_MAX_HEIGHT);
}

export interface AutosizeOptions {
  enabled: boolean;
  contentHeight: number;
  streaming: boolean;
  onResize: (width: number, height: number) => void;
}

/**
 * Reports the auto-mode window size; `contentHeight` is the natural (unclamped)
 * height the panel would like to have.
 */
export function usePanelAutosize({
  enabled,
  contentHeight,
  streaming,
  onResize,
}: AutosizeOptions): void {
  const lastHeight = useRef(0);
  const timer = useRef<number | null>(null);
  const pending = useRef<number | null>(null);

  const flush = useCallback(() => {
    const height = pending.current;
    pending.current = null;
    timer.current = null;
    if (height === null) return;
    if (streaming && height < lastHeight.current) return;
    lastHeight.current = height;
    onResize(AUTO_PANEL_WIDTH, height);
  }, [onResize, streaming]);

  useEffect(() => {
    if (!enabled) return;
    const max = availablePanelHeight();
    const desired = Math.max(1, Math.min(Math.round(contentHeight), max));
    if (desired <= 0) return;
    if (streaming && desired < lastHeight.current) return;
    pending.current = desired;
    if (timer.current !== null) return;
    timer.current = window.setTimeout(flush, PANEL_RESIZE_INTERVAL_MS);
    return () => {
      /* The cleanup only clears on unmount; a pending flush keeps its timer. */
      if (timer.current !== null && pending.current === desired) return;
    };
  }, [contentHeight, enabled, flush, streaming]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
    },
    []
  );
}
