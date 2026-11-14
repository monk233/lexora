/* Native HTML5 drag ordering for one skill list (contract §8).
 *
 * Deliberately no `@dnd-kit`: the window already runs with
 * `dragDropEnabled: false`, and every row interaction is a plain browser drag.
 * The hook only tracks ids and computes the next order; the caller merges that
 * order back into the stored global list (`mergeCategoryOrder`).
 */
import { useCallback, useRef, useState, type DragEvent } from "react";

export interface DragHandlers {
  draggable: boolean;
  onDragStart: (event: DragEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent) => void;
  onDragEnd: () => void;
}

export interface UseDragReorderInput {
  /** Ids in their rendered order (enabled rows only). */
  ids: string[];
  canDrag: (id: string) => boolean;
  onReorder: (next: string[]) => void;
}

export interface UseDragReorderResult {
  dragId: string | null;
  overId: string | null;
  handlers: (id: string) => DragHandlers;
}

/** Controls that must never start a row drag (legacy `settings.js:3794`). */
const INTERACTIVE_SELECTOR = "button, input, label, textarea, .skill-prompt";

export function useDragReorder({
  ids,
  canDrag,
  onReorder,
}: UseDragReorderInput): UseDragReorderResult {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);

  const clear = useCallback(() => {
    dragRef.current = null;
    setDragId(null);
    setOverId(null);
  }, []);

  const handlers = useCallback(
    (id: string): DragHandlers => ({
      draggable: canDrag(id),
      onDragStart: (event) => {
        if (!canDrag(id)) {
          event.preventDefault();
          return;
        }
        const target = event.target as HTMLElement | null;
        if (target && typeof target.closest === "function" && target.closest(INTERACTIVE_SELECTOR)) {
          event.preventDefault();
          return;
        }
        dragRef.current = id;
        setDragId(id);
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          try {
            event.dataTransfer.setData("text/plain", id);
          } catch {
            /* jsdom / IE-style dataTransfer quirks: the id is tracked in memory. */
          }
        }
      },
      onDragOver: (event) => {
        if (!dragRef.current || !canDrag(id)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        setOverId(id);
      },
      onDragLeave: () => {
        setOverId((previous) => (previous === id ? null : previous));
      },
      onDrop: (event) => {
        const moved = dragRef.current;
        event.preventDefault();
        clear();
        if (!moved || moved === id) return;
        const from = ids.indexOf(moved);
        if (from < 0) return;
        const next = ids.slice();
        next.splice(from, 1);
        const to = next.indexOf(id);
        if (to < 0) return;
        next.splice(to, 0, moved);
        if (next.join("|") === ids.join("|")) return;
        onReorder(next);
      },
      onDragEnd: clear,
    }),
    [canDrag, clear, ids, onReorder]
  );

  return { dragId, overId, handlers };
}
