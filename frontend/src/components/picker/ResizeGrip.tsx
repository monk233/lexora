/* Panel resize grip (P3, Task 4/8).
 *
 * Dragging reports the desired window size; the server clamps it to the virtual
 * desktop (contracts §6.3). Double-click restores the automatic size. Reporting
 * is throttled: the legacy code merges panel resizes at 200ms (picker.js:68). */
import { useCallback, useEffect, useRef } from "react";

export const PANEL_RESIZE_INTERVAL_MS = 200;
export const PANEL_MIN_WIDTH = 360;
export const PANEL_MIN_HEIGHT = 240;

export interface ResizeGripProps {
  onResize: (width: number, height: number) => void;
  onReset: () => void;
  disabled?: boolean;
}

export function ResizeGrip({ onResize, onReset, disabled = false }: ResizeGripProps) {
  const state = useRef<{ x: number; y: number; width: number; height: number; timer: number | null } | null>(
    null
  );

  useEffect(
    () => () => {
      const current = state.current;
      if (current?.timer) window.clearTimeout(current.timer);
      state.current = null;
    },
    []
  );

  const onMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      state.current = {
        x: event.clientX,
        y: event.clientY,
        width: window.innerWidth,
        height: window.innerHeight,
        timer: null,
      };

      const move = (next: MouseEvent) => {
        const current = state.current;
        if (!current) return;
        const width = Math.max(PANEL_MIN_WIDTH, current.width + (next.clientX - current.x));
        const height = Math.max(PANEL_MIN_HEIGHT, current.height + (next.clientY - current.y));
        if (current.timer) return;
        current.timer = window.setTimeout(() => {
          if (!state.current) return;
          state.current.timer = null;
          onResize(width, height);
        }, PANEL_RESIZE_INTERVAL_MS);
      };
      const up = () => {
        const current = state.current;
        if (current?.timer) {
          window.clearTimeout(current.timer);
          current.timer = null;
        }
        state.current = null;
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [disabled, onResize]
  );

  return (
    <div
      role="separator"
      aria-label="调整面板大小"
      title="拖动调整大小 · 双击恢复自动大小"
      data-testid="resize-grip"
      aria-disabled={disabled}
      className={
        disabled
          ? "hidden"
          : "absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
      }
      onMouseDown={onMouseDown}
      onDoubleClick={onReset}
    />
  );
}
