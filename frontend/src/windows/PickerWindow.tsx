/* Picker window root (P3).
 *
 * Owns the bridge and renders one of the two surfaces:
 *  - `picker` (result panel) — Task 4+ replaces the placeholder body;
 *  - `picker-toolbar` (capsule, `?surface=toolbar`) — Task 3 replaces it.
 */
import { PickerToolbar } from "@/components/picker/PickerToolbar";
import { usePickerBridge, type PickerApi } from "@/hooks/usePickerBridge";
import { payloadSkills, type PickerSurface } from "@/lib/picker/model";

export interface PickerWindowProps {
  surface?: PickerSurface;
  api?: PickerApi;
}

export function PickerWindow({ surface, api }: PickerWindowProps = {}) {
  const bridge = usePickerBridge({ surface, api });

  if (bridge.surface === "toolbar") {
    const skills = payloadSkills(bridge.payload);
    return (
      <div
        data-testid="surface"
        data-surface="toolbar"
        className="h-full w-full bg-transparent p-[2px]"
      >
        <PickerToolbar
          skills={skills}
          compact={bridge.payload?.config?.compact === true}
          api={bridge.api}
          onRun={(skillId) => {
            void bridge.api.runToolbarSkill?.(skillId);
          }}
        />
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
