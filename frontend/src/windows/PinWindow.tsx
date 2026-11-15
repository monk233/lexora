/* Pinned image window (P4/P5).
 *
 * Display, wheel zoom, drag, copy and close; edit mode (P5d) overlays the ported
 * annotation canvas engine and exports the drawing through
 * `pin_export_annotations`, using the same toolbar as the capture overlay.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Pencil, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AnnotationToolbar } from "@/components/capture/AnnotationToolbar";
import { usePinBridge, type PinApi } from "@/hooks/usePinBridge";
import { I18nProvider, normalizeLocale, useT } from "@/lib/i18n";
import {
  CaptureAnnotate,
  type AnnotationHistoryState,
  type AnnotationOptions,
} from "@/lib/annotation-editor";
import { clampZoom, pinIdFromSearch, zoomIn, zoomOut } from "@/lib/pin/model";

function firstLocale() {
  if (typeof document === "undefined") return "en";
  return normalizeLocale(document.documentElement.lang || navigator.language);
}

export function PinWindow({ id, api }: { id?: string; api?: PinApi } = {}) {
  const pinId = id ?? pinIdFromSearch();
  const bridge = usePinBridge(pinId, { api });
  return (
    <I18nProvider initialLocale={firstLocale()}>
      <PinBody bridge={bridge} />
    </I18nProvider>
  );
}

function PinBody({ bridge }: { bridge: ReturnType<typeof usePinBridge> }) {
  const { t } = useT();
  const { api, dataUrl, error, id } = bridge;
  const [zoom, setZoom] = useState(1);
  const [zoomHint, setZoomHint] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState("");
  const [options, setOptions] = useState<AnnotationOptions>(CaptureAnnotate.DEFAULT_OPTIONS);
  const [history, setHistory] = useState<AnnotationHistoryState>({
    canUndo: false,
    canRedo: false,
    hasAnnotations: false,
  });
  const hintTimer = useRef<number | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const editorRef = useRef<ReturnType<typeof CaptureAnnotate.create> | null>(null);

  const showZoom = useCallback((value: number) => {
    setZoomHint(`${Math.round(value * 100)}%`);
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setZoomHint(null), 900);
  }, []);

  /* Wheel zooms the pinned image (contracts: 10% per notch, 15% floor). */
  useEffect(() => {
    if (editing) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const next = event.deltaY < 0 ? zoomIn(zoom) : zoomOut(zoom);
      if (next === zoom) return;
      setZoom(next);
      showZoom(next);
      void (api.zoom?.(id, next) as Promise<unknown> | undefined);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [api, editing, id, showZoom, zoom]);

  /* Build the annotation engine while editing. */
  useEffect(() => {
    if (!editing) {
      editorRef.current?.setTool(null);
      return;
    }
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;
    const editor = CaptureAnnotate.create({
      canvas,
      image,
      getSelection: () => ({
        x: 0,
        y: 0,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      }),
      onHistoryChange: (state) => setHistory(state),
    });
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
    };
  }, [dataUrl, editing]);

  const onMouseDown = useCallback(
    (event: React.MouseEvent<HTMLImageElement>) => {
      if (editing || event.button !== 0) return;
      drag.current = { x: event.clientX, y: event.clientY };
      const move = (next: MouseEvent) => {
        const start = drag.current;
        if (!start) return;
        const dx = next.clientX - start.x;
        const dy = next.clientY - start.y;
        start.x = next.clientX;
        start.y = next.clientY;
        void (api.drag?.(id, dx, dy) as Promise<unknown> | undefined);
      };
      const up = () => {
        drag.current = null;
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [api, editing, id]
  );

  const startEdit = useCallback(() => {
    setEditing(true);
    setTool("");
    void (api.editWindow?.(id, true, 0, 0) as Promise<unknown> | undefined);
  }, [api, id]);

  const finishEdit = useCallback(() => {
    const annotations = editorRef.current?.getAnnotations() ?? [];
    void (api.exportAnnotations?.(id, annotations, true) as Promise<unknown> | undefined);
    setEditing(false);
    void (api.editWindow?.(id, false, 0, 0) as Promise<unknown> | undefined);
  }, [api, id]);

  const cancelEdit = useCallback(() => {
    editorRef.current?.clear();
    setEditing(false);
    void (api.editWindow?.(id, false, 0, 0) as Promise<unknown> | undefined);
  }, [api, id]);

  const setOption = useCallback(
    <K extends keyof AnnotationOptions>(key: K, value: AnnotationOptions[K]) => {
      setOptions((current) => ({ ...current, [key]: value }));
      editorRef.current?.setOption(key, value);
    },
    []
  );

  const imageStyle = imageRef.current
    ? {
        width: Math.max(1, Math.round(imageRef.current.naturalWidth * clampZoom(zoom))),
        height: Math.max(1, Math.round(imageRef.current.naturalHeight * clampZoom(zoom))),
      }
    : undefined;

  return (
    <div data-testid="pin-root" className="relative flex h-full w-full flex-col bg-transparent">
      {error ? (
        <div role="alert" data-testid="pin-error" className="m-2 rounded-lg border bg-card p-3 text-sm">
          <p className="font-medium text-destructive">
            {error.message === "pin" ? t("pin.loadFailed") : error.message}
          </p>
          {error.hint ? <p className="mt-1 text-xs text-muted-foreground">{error.hint}</p> : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => {
              void (api.close?.(id) as Promise<unknown> | undefined);
            }}
          >
            {t("common.close")}
          </Button>
        </div>
      ) : (
        <>
          <img
            ref={imageRef}
            src={dataUrl || undefined}
            alt=""
            draggable={false}
            data-testid="pin-image"
            style={imageStyle}
            className="max-h-full max-w-full cursor-move select-none object-contain"
            onMouseDown={onMouseDown}
          />
          <canvas
            ref={canvasRef}
            data-testid="pin-annotations"
            hidden={!editing}
            className="absolute inset-0 h-full w-full"
            style={{ zIndex: 11 }}
          />
        </>
      )}

      {editing ? (
        <div
          className="absolute inset-x-0 bottom-2 z-20 flex flex-col items-center gap-1"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <AnnotationToolbar
            tool={tool}
            options={options}
            canUndo={history.canUndo}
            canRedo={history.canRedo}
            onTool={(next) => {
              setTool(next);
              editorRef.current?.setTool(next);
            }}
            onOption={setOption}
            onUndo={() => editorRef.current?.undo()}
            onRedo={() => editorRef.current?.redo()}
            onClear={() => editorRef.current?.clear()}
          />
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={finishEdit}>
              {t("pin.confirmHint")}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={cancelEdit}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div
          data-testid="pin-toolbar"
          className="absolute right-2 top-2 flex items-center gap-1 rounded-lg border bg-card/95 p-1 shadow"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("pin.edit")}
            title={t("pin.edit")}
            onClick={startEdit}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("pin.copyImage")}
            title={t("pin.copyImage")}
            disabled={!dataUrl}
            onClick={() => {
              void (api.copy?.(id) as Promise<unknown> | undefined);
            }}
          >
            <Copy className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("pin.closeHint")}
            title={t("pin.closeHint")}
            onClick={() => {
              void (api.close?.(id) as Promise<unknown> | undefined);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {zoomHint && !editing ? (
        <div
          data-testid="pin-zoom"
          role="status"
          className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-foreground/80 px-2 py-0.5 text-xs text-background"
        >
          {zoomHint}
        </div>
      ) : null}
    </div>
  );
}
