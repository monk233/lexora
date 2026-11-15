/* Picker toolbar capsule (P3, Task 3).
 *
 * Renders the enabled skills in backend order with their icon+label, and pushes
 * the skills that do not fit into the "more" menu — the layout algorithm is the
 * legacy one (web/picker.js:1010-1072): measure unconstrained, then keep a
 * leading run that fits inside the 560/420px budget together with the divider,
 * the "more" button and the toolbar chrome. The window size is Rust's job, so
 * the component only reports the measured size through ``picker_resize``.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useT } from "@/lib/i18n";
import type { PickerApi } from "@/hooks/usePickerBridge";
import type { PickerSkill } from "@/lib/picker/model";
import { CUSTOM_SKILL_ICON_SVGS } from "@/lib/settings/skill-icons";
import { normalizeIconKey } from "@/lib/settings/skills";

export const MAX_TOOLBAR_WIDTH = 560;
export const COMPACT_MAX_TOOLBAR_WIDTH = 420;
export const TOOLBAR_BUTTON_GAP = 2;
/** Extra pixels the legacy code adds around the measured capsule. */
const TOOLBAR_CHROME = 4;

export interface PickerToolbarProps {
  skills: PickerSkill[];
  compact?: boolean;
  onRun: (skillId: string) => void;
  onMore?: () => void;
  api: PickerApi;
  /** `false` while a menu/panel is open: never shrink the window then. */
  canResize?: boolean;
}

function iconSvg(icon: string | undefined): string {
  const key = normalizeIconKey(icon || "sparkles");
  return CUSTOM_SKILL_ICON_SVGS[key] ?? CUSTOM_SKILL_ICON_SVGS.sparkles ?? "";
}

export function PickerToolbar({
  skills,
  compact = false,
  onRun,
  onMore,
  api,
  canResize = true,
}: PickerToolbarProps) {
  const { t } = useT();
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const buttonsRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const dividerRef = useRef<HTMLSpanElement | null>(null);
  const [cutoff, setCutoff] = useState(skills.length);

  const maxWidth = compact ? COMPACT_MAX_TOOLBAR_WIDTH : MAX_TOOLBAR_WIDTH;

  /* Measure exactly like the legacy renderer: the budget covers the buttons,
   * the gaps, the divider, the "more" button and the toolbar chrome. */
  useLayoutEffect(() => {
    const nodes = buttonsRef.current?.children;
    const more = moreRef.current;
    const divider = dividerRef.current;
    const toolbar = toolbarRef.current;
    if (!nodes || !more || !divider || !toolbar) return;

    const style = window.getComputedStyle(toolbar);
    const chrome =
      TOOLBAR_CHROME +
      (parseFloat(style.paddingLeft) || 0) +
      (parseFloat(style.paddingRight) || 0) +
      (parseFloat(style.borderLeftWidth) || 0) +
      (parseFloat(style.borderRightWidth) || 0);
    const fixed =
      TOOLBAR_BUTTON_GAP +
      divider.getBoundingClientRect().width +
      TOOLBAR_BUTTON_GAP +
      more.getBoundingClientRect().width +
      chrome;

    let used = 0;
    let next = nodes.length;
    for (let index = 0; index < nodes.length; index += 1) {
      const width = (nodes[index] as HTMLElement).getBoundingClientRect().width;
      const candidate = used + (index ? TOOLBAR_BUTTON_GAP : 0) + width;
      if (candidate + fixed > maxWidth) {
        next = index;
        break;
      }
      used = candidate;
    }
    setCutoff((current) => (current === next ? current : next));
  }, [skills, maxWidth, compact]);

  const reportSize = useCallback(() => {
    if (!canResize) return;
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const rect = toolbar.getBoundingClientRect();
    const width = Math.min(Math.ceil(rect.width + TOOLBAR_CHROME), maxWidth);
    const height = Math.ceil(rect.height + TOOLBAR_CHROME);
    void api.resize(Math.max(width, 1), Math.max(height, 1));
  }, [api, canResize, maxWidth]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(reportSize);
    return () => window.cancelAnimationFrame(frame);
  }, [reportSize, cutoff, skills]);

  const visible = skills.slice(0, cutoff);
  const overflow = skills.slice(cutoff);

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={t("picker.aria.toolbar")}
      data-compact={compact ? "true" : "false"}
      className="inline-flex items-center gap-[2px] rounded-xl border bg-card px-1.5 py-1 shadow-float"
    >
      <div ref={buttonsRef} className="contents">
        {visible.map((skill) => (
          <button
            key={skill.id}
            type="button"
            data-skill={skill.id}
            data-kind={skill.kind === "image" ? "image" : "text"}
            title={skill.label || skill.id}
            aria-label={skill.label || skill.id}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium hover:bg-accent"
            onClick={() => onRun(skill.id)}
          >
            <span
              aria-hidden="true"
              className="h-4 w-4 [&>svg]:h-4 [&>svg]:w-4"
              dangerouslySetInnerHTML={{ __html: iconSvg(skill.icon) }}
            />
            <span>{skill.label || skill.id}</span>
          </button>
        ))}
      </div>
      <span ref={dividerRef} aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
      <button
        ref={moreRef}
        type="button"
        data-role="more"
        data-overflow-count={overflow.length}
        title={t("picker.toolbar.more")}
        aria-label={t("picker.toolbar.more")}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent"
        onClick={() => onMore?.()}
      >
        <span aria-hidden="true" className="text-base leading-none">
          ⋯
        </span>
      </button>
    </div>
  );
}
