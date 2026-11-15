export type AnnotationTool = "shape" | "arrow" | "pen" | "text" | "number" | "mosaic";
export type ShapeMode = "rect" | "circle" | "line";
export type FillMode = "outline" | "fill";

export interface AnnotationOptions {
  color: string;
  width: number;
  shapeMode: ShapeMode;
  fill: FillMode;
  fontSize: number;
  bold: boolean;
  textBg: string;
  mosaicSize: number;
}

export interface AnnotationHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  hasAnnotations: boolean;
}

export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotationEditor {
  setTool(tool: string | null): void;
  getTool(): AnnotationTool;
  setOption(key: keyof AnnotationOptions, value: unknown): void;
  getOptions(): AnnotationOptions;
  setShapeMode(mode: string): void;
  setSourceSize(width: number, height: number): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
  reset(): void;
  hasAnnotations(): boolean;
  getAnnotations(): unknown[];
  renderToPng(rect: SelectionRect): string;
  pickColor(x: number, y: number): string | null;
  [key: string]: unknown;
}

export interface CreateAnnotationEditorOptions {
  canvas: HTMLCanvasElement;
  image: HTMLImageElement | null;
  getSelection: () => SelectionRect;
  onHistoryChange?: (state: AnnotationHistoryState) => void;
}

export const CaptureAnnotate: {
  create(options: CreateAnnotationEditorOptions): AnnotationEditor;
  TOOLS: string[];
  SHAPE_MODES: string[];
  DEFAULT_OPTIONS: AnnotationOptions;
};

export default CaptureAnnotate;

