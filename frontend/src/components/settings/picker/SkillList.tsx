/* Text-tab skill list (C36, assertions 21–23, 25–26).
 *
 * Reads the picker slice from the settings store and writes back in place. The
 * rendered order is: enabled skills in their stored order, then hidden built-ins
 * in canonical order, then hidden custom text skills (legacy `renderSkills`).
 * Drag ordering only reorders the enabled text ids and merges them back into
 * the stored global order, so the image category never moves.
 *
 * The image half of the list is Task 7; this module only owns the empty list
 * container the tab contract already exposes.
 */
import { useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";

import { toast } from "@/components/ui/use-toast";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { useT } from "@/lib/i18n";
import {
  DEFAULT_TEXT_SKILLS,
  TEXT_SKILLS,
  mergeCategoryOrder,
  type PromptSlot,
  type SkillMeta,
} from "@/lib/settings/skills";
import type { CustomSkill, SettingsPatch } from "@/lib/settings/types";
import { cn } from "@/lib/utils";

import { PromptEditor } from "./PromptEditor";
import { SearchEnginePanel } from "./SearchEnginePanel";
import { SkillRow } from "./SkillRow";
import { useDragReorder } from "./useDragReorder";

export interface SkillListProps {
  kind: "text" | "image";
  onOpenSearch: () => void;
  onEditCustom: (id: string | null) => void;
}

const TEXT_META: Record<string, SkillMeta> = Object.fromEntries(
  TEXT_SKILLS.map((meta) => [meta.id, meta])
);
const EMPTY_CUSTOM_SKILLS: CustomSkill[] = [];
function customTextSkills(customSkills: CustomSkill[]): CustomSkill[] {
  return customSkills.filter((skill) => skill.kind !== "image");
}

/** Screenshot prompt defaults use their own keys (`captureTranslate`…). */
export function captureDefaultKey(slot: PromptSlot): string {
  const suffix = slot.charAt(0).toUpperCase() + slot.slice(1);
  return `capture${suffix}`;
}

export function SkillList({ kind, onOpenSearch, onEditCustom }: SkillListProps) {
  const form = useSettingsForm();
  const { t } = useT();
  const [openPrompts, setOpenPrompts] = useState<Set<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);

  /* Custom-skill edit/delete is Task 7; keep the prop wired so the card's API
   * does not change again when the editor lands. */
  void onEditCustom;

  const picker = form.settings?.picker;
  const customSkills = picker?.customSkills ?? EMPTY_CUSTOM_SKILLS;
  const textCustoms = useMemo(() => customTextSkills(customSkills), [customSkills]);

  /* `picker.skills` only holds enabled picker rows, but a stale custom image id
   * may still sit in the saved array: keep it in the saved order (never drop
   * data the user did not touch) while rendering only the text category. */
  const knownPickerIds = useMemo(() => {
    const ids = new Set(TEXT_SKILLS.map((meta) => meta.id));
    for (const skill of customSkills) ids.add(skill.id);
    return ids;
  }, [customSkills]);

  const enabledAll = useMemo<string[]>(() => {
    const raw = picker?.skills;
    const list = Array.isArray(raw) ? raw : DEFAULT_TEXT_SKILLS;
    const result: string[] = [];
    for (const value of list) {
      const id = String(value ?? "");
      if (id && knownPickerIds.has(id) && !result.includes(id)) result.push(id);
    }
    return result;
  }, [knownPickerIds, picker?.skills]);

  const textIds = useMemo(() => {
    const ids = new Set(TEXT_SKILLS.map((meta) => meta.id));
    for (const skill of textCustoms) ids.add(skill.id);
    return ids;
  }, [textCustoms]);

  const stored = useMemo(
    () => enabledAll.filter((id) => textIds.has(id)),
    [enabledAll, textIds]
  );

  const order = useMemo(() => {
    const next = stored.slice();
    for (const meta of TEXT_SKILLS) if (!next.includes(meta.id)) next.push(meta.id);
    for (const skill of textCustoms) if (!next.includes(skill.id)) next.push(skill.id);
    return next;
  }, [stored, textCustoms]);

  const drag = useDragReorder({
    ids: stored,
    canDrag: (id) => stored.includes(id),
    onReorder: (next) => {
      if (!picker) return;
      const raw = Array.isArray(picker.skills) ? picker.skills.map(String) : stored.slice();
      form.save({ picker: { skills: mergeCategoryOrder(raw, next) } });
    },
  });

  const customById = useMemo(() => {
    const map = new Map<string, CustomSkill>();
    for (const skill of textCustoms) map.set(skill.id, skill);
    return map;
  }, [textCustoms]);

  if (!picker) return null;

  if (kind === "image") {
    return <ul id="skill-list-image" data-testid="skill-list-image" className="flex flex-col gap-1.5" />;
  }

  const promptOpenKey = (id: string) => `${kind}:${id}`;
  const isPromptOpen = (id: string) => openPrompts.has(promptOpenKey(id));

  const togglePrompt = (id: string) => {
    setOpenPrompts((previous) => {
      const next = new Set(previous);
      const key = promptOpenKey(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSkill = (id: string, enabled: boolean) => {
    if (enabled) {
      form.save({ picker: { skills: [...enabledAll, id] } });
      return;
    }
    if (stored.length <= 1) {
      toast({ description: t("settings.toast.keepOneSkill"), tone: "error" });
      return;
    }
    form.save({ picker: { skills: enabledAll.filter((item) => item !== id) } });
  };

  const promptNode = (meta: SkillMeta) => {
    const slots = meta.promptSlots ?? [];
    if (slots.length === 0) return null;
    const target = meta.promptTarget ?? "prompts";
    const current = (picker[target] ?? {}) as unknown as Record<string, string>;
    const defaults = form.state?.promptDefaults ?? {};
    const label = t(meta.labelKey);

    return (
      <div className="flex flex-col gap-2">
        {slots.map((slot) => {
          const defaultKey = target === "capturePrompts" ? captureDefaultKey(slot) : slot;
          const title =
            meta.id === "translate"
              ? t(slot === "wordLookup" ? "settings.prompt.wordLookup" : "settings.prompt.translate")
              : t("settings.prompt.forSkill", { skill: label });
          const hint =
            meta.id === "translate"
              ? t(
                  slot === "wordLookup"
                    ? "settings.prompt.wordLookupHint"
                    : "settings.prompt.translateHint"
                )
              : t("settings.hint.skillPrompt");
          const patch = (value: string): SettingsPatch => ({
            picker: { [target]: { [slot]: value } },
          });
          return (
            <PromptEditor
              key={slot}
              id={`skill-prompt-${kind}-${meta.id}-${slot}`}
              title={title}
              hint={hint}
              value={current[slot] ?? ""}
              defaultPrompt={defaults[defaultKey] ?? ""}
              onSave={patch}
              onReset={() => {
                form.save(patch(""));
                toast({ description: t("settings.toast.promptReset"), tone: "success" });
              }}
              collapsible={false}
            />
          );
        })}
      </div>
    );
  };

  const searchBadge = (
    <button
      type="button"
      aria-label={t("settings.action.configureSearch")}
      aria-expanded={searchOpen}
      title={t("settings.action.configureSearch")}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => {
        setSearchOpen((previous) => !previous);
        onOpenSearch();
      }}
    >
      <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );

  return (
    <ul
      id="skill-list-text"
      data-testid="skill-list-text"
      data-picker-disabled={picker.enabled === false ? "true" : undefined}
      className={cn(
        "flex flex-col gap-1.5",
        picker.enabled === false && "opacity-60"
      )}
    >
      {order.map((id) => {
        const meta = TEXT_META[id];
        const custom = customById.get(id);
        const label = meta ? t(meta.labelKey) : (custom?.label ?? id);
        const description = meta
          ? t(`${meta.labelKey}.desc`)
          : String(custom?.prompt ?? "").replace(/\s+/g, " ").trim();
        const resolvedMeta: SkillMeta = meta ?? {
          id,
          kind: "text",
          icon: "sparkles",
          labelKey: "",
        };
        const enabled = stored.includes(id);
        const showSearch = id === "search";
        return (
          <SkillRow
            key={id}
            meta={resolvedMeta}
            label={label}
            description={description || undefined}
            enabled={enabled}
            custom={Boolean(custom)}
            canDrag={enabled}
            dragging={drag.dragId === id}
            dropTarget={drag.overId === id}
            onToggle={(next) => toggleSkill(id, next)}
            drag={drag.handlers(id)}
            onPromptToggle={() => togglePrompt(id)}
            promptOpen={isPromptOpen(id)}
            promptNode={isPromptOpen(id) ? promptNode(resolvedMeta) : undefined}
            searchBadge={showSearch ? searchBadge : undefined}
          />
        );
      })}
      {searchOpen ? (
        <li className="list-none">
          <SearchEnginePanel
            value={picker.searchEngine}
            onChange={(engine) => form.save({ picker: { searchEngine: engine } })}
          />
        </li>
      ) : null}
    </ul>
  );
}
