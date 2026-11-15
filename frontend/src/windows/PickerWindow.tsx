/* Picker window root (P3).
 *
 * Owns the bridge and renders one of the two surfaces:
 *  - `picker` (result panel) — Task 4+ replaces the placeholder body;
 *  - `picker-toolbar` (capsule, `?surface=toolbar`) — Task 3 replaces it.
 */
import { usePickerBridge, type PickerApi } from "@/hooks/usePickerBridge";
import type { PickerSurface } from "@/lib/picker/model";

export interface PickerWindowProps {
  surface?: PickerSurface;
  api?: PickerApi;
}

export function PickerWindow({ surface, api }: PickerWindowProps = {}) {
  const bridge = usePickerBridge({ surface, api });

  if (bridge.surface === "toolbar") {
    return (
      <div
        data-testid="surface"
        data-surface="toolbar"
        className="pointer-events-none h-full w-full bg-transparent"
      >
        <div className="pointer-events-auto inline-flex items-center rounded-xl border bg-card px-2 py-1 text-sm shadow-float">
          toolbar
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="surface"
      data-surface="panel"
      className="h-full w-full bg-transparent text-foreground"
    >
      <div className="h-full w-full rounded-xl border bg-card text-sm">panel</div>
    </div>
  );
}
