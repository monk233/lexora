/* Capture overlay window (P5a).
 *
 * Covers one monitor with the frozen screenshot and lets the user drag a
 * selection. The action bar offers the capture skills (copy / pin / long-shot /
 * OCR / translate / explain) plus close; the annotation canvas and its palette
 * are migrated separately (P5b) and will drive the same selection rectangle.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCaptureBridge, type CaptureApi } from "@/hooks/useCaptureBridge";
import { I18nProvider, normalizeLocale, useT } from "@/lib/i18n";
import {
  MIN_SELECTION,
  clampRect,
  monitorIndexFromSearch,
  physicalRect,
  rectContains,
  rectFromPoints,
  toolbarPosition,
  type CaptureRect,
} from "@/lib/capture/model";

function firstLocale() {
  if (typeof document === "undefined") return "en";
  return normalizeLocale(document.documentElement.lang || navigator.language);
}

function makeRequestId(): string {
  return `capture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function CaptureWindow({ index, api }: { index?: number; api?: CaptureApi } = {}) {
  const monitorIndex = index ?? monitorIndexFromSearch();
  const bridge = useCaptureBridge(monitorIndex, { api });
  return (
    <I18nProvider initialLocale={firstLocale()}>
      <CaptureBody bridge={bridge} />
    </I18nProvider>
  );
}

type Bridge = ReturnType<typeof useCaptureBridge>;

function CaptureBody({ bridge }: { bridge: Bridge }) {
  const { t } = useT();
  const { api, index, monitor } = bridge;
  const [rect, setRect] = useState<CaptureRect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ startX: number; startY: number } | null>(null);
  const moving = useRef<{ x: number; y: number } | null>(null);

  /* Escape cancels the whole capture session. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void api.close?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [api]);

  const onMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (rect && rectContains(rect, event.clientX, event.clientY)) {
        moving.current = { x: event.clientX, y: event.clientY };
        return;
      }
      drag.current = { startX: event.clientX, startY: event.clientY };
      setRect({ x: event.clientX, y: event.clientY, width: 0, height: 0 });
    },
    [rect]
  );

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const start = drag.current;
      if (start) {
        setRect(rectFromPoints(start.startX, start.startY, event.clientX, event.clientY));
        return;
      }
      const origin = moving.current;
      if (!origin || !rect) return;
      const dx = event.clientX - origin.x;
      const dy = event.clientY - origin.y;
      origin.x = event.clientX;
      origin.y = event.clientY;
      setRect(
        clampRect(
          { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height },
          window.innerWidth,
          window.innerHeight
        )
      );
    };
    const up = () => {
      drag.current = null;
      moving.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [rect]);

  const readyRect = rect && rect.width >= MIN_SELECTION && rect.height >= MIN_SELECTION ? rect : null;

  const copy = useCallback(() => {
    if (!readyRect) return;
    void api.copy?.(index, physicalRect(readyRect), [], undefined);
  }, [api, index, readyRect]);

  const pin = useCallback(() => {
    if (!readyRect) return;
    void api.pin?.(index, physicalRect(readyRect), [], undefined);
  }, [api, index, readyRect]);

  const longshot = useCallback(() => {
    if (!readyRect) return;
    void api.longshot?.(index, physicalRect(readyRect));
  }, [api, index, readyRect]);

  const runSkill = useCallback(
    (action: "ocr" | "translate" | "explain") => {
      if (!readyRect) return;
      void api.skill?.(
        makeRequestId(),
        index,
        physicalRect(readyRect),
        action,
        "",
        "auto",
        [],
        undefined
      );
    },
    [api, index, readyRect]
  );

  if (monitor && monitor.ok === false) {
    return (
      <div
        data-testid="capture-error"
        role="alert"
        className="flex h-full w-full flex-col items-center justify-center gap-2 bg-background p-6 text-sm"
      >
        <p className="font-medium text-destructive">{monitor.error || "capture"}</p>
        {monitor.hint ? <p className="text-muted-foreground">{monitor.hint}</p> : null}
        <Button type="button" variant="outline" size="sm" onClick={() => void api.close?.()}>
          {t("common.close")}
        </Button>
      </div>
    );
  }

  const position = readyRect
    ? toolbarPosition(readyRect, window.innerHeight, 44)
    : { top: 0, left: 0 };

  return (
    <div
      data-testid="capture-overlay"
      className="relative h-full w-full cursor-crosshair select-none overflow-hidden bg-black/40"
      onMouseDown={onMouseDown}
    >
      {monitor?.dataUrl ? (
        <img
          src={monitor.dataUrl}
          alt=""
          draggable={false}
          data-testid="capture-shot"
          className="pointer-events-none absolute inset-0 h-full w-full object-fill"
        />
      ) : null}

      {readyRect ? (
        <div
          data-testid="capture-selection"
          className="pointer-events-none absolute border-2 border-primary"
          style={{
            left: readyRect.x,
            top: readyRect.y,
            width: readyRect.width,
            height: readyRect.height,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
          }}
        />
      ) : null}

      {readyRect ? (
        <div
          data-testid="capture-toolbar"
          role="toolbar"
          aria-label={t("capture.toolbar.aria")}
          className="absolute z-10 flex items-center gap-1 rounded-lg border bg-card px-1.5 py-1 shadow-lg"
          style={{ top: position.top, left: Math.max(0, position.left) }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Button type="button" size="sm" onClick={copy}>
            {t("skill.copy")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={pin}>
            {t("capture.pin")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={longshot}>
            {t("capture.longshot")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => runSkill("ocr")}>
            {t("capture.ocr")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => runSkill("translate")}>
            {t("capture.translate")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => runSkill("explain")}>
            {t("capture.explain")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("common.close")}
            onClick={() => void api.close?.()}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
          <span className="rounded-full bg-card/90 px-3 py-1 text-xs shadow">
            {t("capture.selectHint")}
          </span>
        </div>
      )}

      {error ? (
        <p role="alert" className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded bg-destructive px-3 py-1 text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

