/* Overflow menu (P3, Task 9).
 *
 * The skills that did not fit in the capsule are listed first (backend order),
 * then a separator and the three configuration entries (contracts §7.1:389-390):
 * disable in this app, open selection settings, disable the tool. The menu
 * scrolls when the list is long and closes on Escape / outside click.
 */
import { useEffect, useRef } from "react";

import type { PickerApi } from "@/hooks/usePickerBridge";
import { useT } from "@/lib/i18n";
import type { PickerSkill } from "@/lib/picker/model";

export interface PickerMenuProps {
  api: PickerApi;
  skills: PickerSkill[];
  programName?: string;
  onRunSkill: (skillId: string) => void;
  onClose: () => void;
}

export function PickerMenu({ api, skills, programName, onRunSkill, onClose }: PickerMenuProps) {
  const { t } = useT();
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const node = menuRef.current;
      if (node && event.target instanceof Node && !node.contains(event.target)) onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onPointerDown, true);
    };
  }, [onClose]);

  const item = (key: string, label: string, onClick: () => void) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      data-menu-item={key}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
      onClick={onClick}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid="picker-menu"
      className="absolute left-0 top-full z-20 mt-1 max-h-[320px] w-[240px] overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
    >
      {skills.map((skill) =>
        item(skill.id, skill.label || skill.id, () => onRunSkill(skill.id))
      )}
      {skills.length > 0 ? <div role="separator" className="my-1 h-px bg-border" /> : null}
      {item("disable-in-app", t("picker.menu.disableInApp"), () => {
        if (programName) void api.disableInApp?.(programName);
      })}
      {item("open-settings", t("picker.menu.openSettings"), () => {
        void api.openSettings?.();
      })}
      {item("disable-tool", t("picker.menu.disableTool"), () => {
        void api.disableTool?.();
      })}
    </div>
  );
}
