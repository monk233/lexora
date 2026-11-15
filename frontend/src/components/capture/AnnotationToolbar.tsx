/* Capture annotation toolbar (P5b).
 *
 * Drives the canvas engine (`lib/annotation-editor`): tool selection, stroke
 * colour/width, shape sub-mode, undo/redo and clear. The heavier palette rows
 * (font size, bold, text background, mosaic cell size, eyedropper) are wired
 * through the same `onOption` path but only the primary rows are rendered here.
 */
import { Redo2, Trash2, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import type { AnnotationOptions, ShapeMode } from "@/lib/annotation-editor";

export const ANNOTATION_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#111827",
  "#ffffff",
];

export interface AnnotationToolbarProps {
  tool: string;
  options: AnnotationOptions;
  canUndo: boolean;
  canRedo: boolean;
  onTool: (tool: string) => void;
  onOption: <K extends keyof AnnotationOptions>(key: K, value: AnnotationOptions[K]) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
}

const TOOLS: { id: string; labelKey: string }[] = [
  { id: "shape", labelKey: "capture.shape" },
  { id: "arrow", labelKey: "capture.arrow" },
  { id: "pen", labelKey: "capture.pen" },
  { id: "text", labelKey: "capture.text" },
  { id: "number", labelKey: "capture.number" },
  { id: "mosaic", labelKey: "capture.mosaic" },
];

const SHAPE_MODES: ShapeMode[] = ["rect", "circle", "line"];

export function AnnotationToolbar({
  tool,
  options,
  canUndo,
  canRedo,
  onTool,
  onOption,
  onUndo,
  onRedo,
  onClear,
}: AnnotationToolbarProps) {
  const { t } = useT();

  return (
    <div
      data-testid="annotation-toolbar"
      role="toolbar"
      aria-label={t("capture.toolbar.toolsAria")}
      className="flex flex-wrap items-center gap-1 rounded-lg border bg-card px-1.5 py-1 shadow-lg"
    >
      {TOOLS.map((entry) => (
        <Button
          key={entry.id}
          type="button"
          size="sm"
          variant={tool === entry.id ? "default" : "outline"}
          aria-pressed={tool === entry.id}
          title={t(entry.labelKey)}
          onClick={() => onTool(entry.id)}
        >
          {t(entry.labelKey)}
        </Button>
      ))}

      {tool === "shape" ? (
        <span className="flex items-center gap-0.5" role="group" aria-label={t("capture.shape")}>
          {SHAPE_MODES.map((mode) => (
            <Button
              key={mode}
              type="button"
              size="sm"
              variant={options.shapeMode === mode ? "default" : "ghost"}
              aria-pressed={options.shapeMode === mode}
              onClick={() => onOption("shapeMode", mode)}
            >
              {mode === "rect" ? "▭" : mode === "circle" ? "◯" : "／"}
            </Button>
          ))}
        </span>
      ) : null}

      <span className="mx-1 h-5 w-px bg-border" />
      <span className="flex items-center gap-1" role="group" aria-label="color">
        {ANNOTATION_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            data-color={color}
            aria-label={color}
            aria-pressed={options.color === color}
            className={
              options.color === color
                ? "h-5 w-5 rounded-full border-2 border-primary"
                : "h-5 w-5 rounded-full border border-border"
            }
            style={{ backgroundColor: color }}
            onClick={() => onOption("color", color)}
          />
        ))}
      </span>

      <span className="mx-1 h-5 w-px bg-border" />
      <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <input
          type="range"
          min={1}
          max={12}
          value={options.width}
          aria-label="width"
          className="w-16"
          onChange={(event) => onOption("width", Number(event.target.value))}
        />
        {options.width}
      </label>

      <span className="mx-1 h-5 w-px bg-border" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label="undo"
        title="undo"
        disabled={!canUndo}
        onClick={onUndo}
      >
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label="redo"
        title="redo"
        disabled={!canRedo}
        onClick={onRedo}
      >
        <Redo2 className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label="clear"
        title="clear"
        onClick={onClear}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
