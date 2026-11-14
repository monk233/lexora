/* Text and image skill lists (C36/C37, assertions 21–23, 25–26, 30).
 *
 * Reads the picker slice from the settings store and writes back in place. The
 * rendered order is: enabled skills in their stored order, then hidden built-ins
 * in canonical order, then hidden custom skills of the same category (legacy
 * `renderSkills` / `captureSkillOrder`).
 *
 * Drag ordering only reorders the enabled ids of the active category and merges
 * them back into the stored list, so the other category never moves. The text
 * list refuses to disable its last row; the image list may be empty (the
 * screenshot toolbar then only offers confirm/cancel).
 *
 * Custom rows are editable/deletable from both tabs and their delete is a
 * two-step armed confirm (`useArmedConfirm`).
 */
import { useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";

import { toast } from "@/components/ui/use-toast";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { useT } from "@/lib/i18n";
import {
  DEFAULT_TEXT_SKILLS,
  IMAGE_SKILLS,
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
  onEditCustom: (id: string) => void;
  onDeleteCustom: (id: string) => void;
  /** Id of the custom skill currently open in the editor, for aria-expanded. */
  editingId?: string;
}

const TEXT_META: Record<string, SkillMeta> = Object.fromEntries(
  TEXT_SKILLS.map((meta) => [meta.id, meta])
);
const IMAGE_META: Record<string, SkillMeta> = Object.fromEntries(
  IMAGE_SKILLS.map((meta) => [meta.id, meta])
);
const EMPTY_CUSTOM_SKILLS: CustomSkill[] = [];

/** Screenshot prompt defaults use their own keys (`captureTranslate`…). */
export function captureDefaultKey(slot: PromptSlot): string {
  const suffix = slot.charAt(0).toUpperCase() + slot.slice(1);
  return `capture${suffix}`;
}

export function SkillList({
  kind,
  onOpenSearch,
  onEditCustom,
  onDeleteCustom,
  editingId,
}: SkillListProps) {
  const form = useSettingsForm();
  const { t } = useT();
  const [openPrompts, setOpenPrompts] = useState<Set<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);

  const picker = form.settings?.picker;
  const customSkills = picker?.customSkills ?? EMPTY_CUSTOM_SKILLS;
  const isImage = kind === "image";
  const builtins = isImage ? IMAGE_SKILLS : TEXT_SKILLS;
  const metaById = isImage ? IMAGE_META : TEXT_META;
  const target = isImage ? "captureSkills" : "skills";

  const categoryCustoms = useMemo(
    () => customSkills.filter((skill) => (skill.kind === "image") === isImage),
    [customSkills, isImage]
  );

  /* `picker.skills` / `picker.captureSkills` only hold enabled ids, but a stale
   * custom id may still sit in the saved array: keep it in the saved order
   * (never drop data the user did not touch) while rendering one category. */
  const knownPickerIds = useMemo(() => {
    const ids = new Set([...TEXT_SKILLS, ...IMAGE_SKILLS].map((meta) => meta.id));
    for (const skill of customSkills) ids.add(skill.id);
    return ids;
  }, [customSkills]);

  const rawStored = isImage ? picker?.captureSkills : picker?.skills;

  const enabledAll = useMemo<string[]>(() => {
    const list = Array.isArray(rawStored)
      ? rawStored
      : isImage
        ? []
        : DEFAULT_TEXT_SKILLS;
    const result: string[] = [];
    for (const value of list) {
      const id = String(value ?? "");
      if (id && knownPickerIds.has(id) && !result.includes(id)) result.push(id);
    }
    return result;
  }, [isImage, knownPickerIds, rawStored]);

  const categoryIds = useMemo(() => {
    const ids = new Set(builtins.map((meta) => meta.id));
    for (const skill of categoryCustoms) ids.add(skill.id);
    return ids;
  }, [builtins, categoryCustoms]);

  const stored = useMemo(
    () => enabledAll.filter((id) => categoryIds.has(id)),
    [enabledAll, categoryIds]
  );

  const order = useMemo(() => {
    const next = stored.slice();
    for (const meta of builtins) if (!next.includes(meta.id)) next.push(meta.id);
    for (const skill of categoryCustoms) if (!next.includes(skill.id)) next.push(skill.id);
    return next;
  }, [builtins, categoryCustoms, stored]);

  const drag = useDragReorder({
    ids: stored,
    canDrag: (id) => stored.includes(id),
    onReorder: (next) => {
      if (!picker) return;
      const raw = Array.isArray(rawStored) ? rawStored.map(String) : stored.slice();
      form.save({ picker: { [target]: mergeCategoryOrder(raw, next) } });
    },
  });

  const customById = useMemo(() => {
    const map = new Map<string, CustomSkill>();
    for (const skill of categoryCustoms) map.set(skill.id, skill);
    return map;
  }, [categoryCustoms]);

  if (!picker) return null;

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
      form.save({ picker: { [target]: [...enabledAll, id] } });
      return;
    }
    if (!isImage && stored.length <= 1) {
      toast({ description: t("settings.toast.keepOneSkill"), tone: "error" });
      return;
    }
    form.save({ picker: { [target]: enabledAll.filter((item) => item !== id) } });
  };

  const promptNode = (meta: SkillMeta) => {
    const slots = meta.promptSlots ?? [];
    if (slots.length === 0) return null;
    const promptTarget = meta.promptTarget ?? "prompts";
    const current = (picker[promptTarget] ?? {}) as unknown as Record<string, string>;
    const defaults = form.state?.promptDefaults ?? {};
    const label = t(meta.labelKey);
    const isTranslate = meta.id === "translate";

    return (
      <div className="flex flex-col gap-2">
        {slots.map((slot) => {
          const defaultKey =
            promptTarget === "capturePrompts" ? captureDefaultKey(slot) : slot;
          const title = isTranslate
            ? t(
                slot === "wordLookup"
                  ? "settings.prompt.wordLookup"
                  : "settings.prompt.translate"
              )
            : t("settings.prompt.forSkill", { skill: label });
          const hint = isTranslate
            ? t(
                slot === "wordLookup"
                  ? promptTarget === "capturePrompts"
                    ? "settings.prompt.wordLookupHintCapture"
                    : "settings.prompt.wordLookupHint"
                  : "settings.prompt.translateHint"
              )
            : t(
                promptTarget === "capturePrompts"
                  ? "settings.hint.capturePrompt"
                  : "settings.hint.skillPrompt"
              );
          const patch = (value: string): SettingsPatch => ({
            picker: { [promptTarget]: { [slot]: value } },
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

  const listClass = cn("flex flex-col gap-1.5", picker.enabled === false && "opacity-60");

  return (
    <ul
      id={isImage ? "skill-list-image" : "skill-list-text"}
      data-testid={isImage ? "skill-list-image" : "skill-list-text"}
      data-picker-disabled={picker.enabled === false ? "true" : undefined}
      className={listClass}
    >
      {order.map((id) => {
        const meta = metaById[id];
        const custom = customById.get(id);
        const label = meta ? t(meta.labelKey) : (custom?.label ?? id);
        const description = meta
          ? t(`${meta.labelKey}.desc`)
          : String(custom?.prompt ?? "").replace(/\s+/g, " ").trim();
        const resolvedMeta: SkillMeta = meta ?? {
          id,
          kind,
          icon: "sparkles",
          labelKey: "",
        };
        const enabled = stored.includes(id);
        const showSearch = !isImage && id === "search";
        return (
          <SkillRow
            key={id}
            meta={custom ? { ...resolvedMeta, icon: custom.icon } : resolvedMeta}
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
            onEdit={custom ? () => onEditCustom(id) : undefined}
            onDelete={custom ? () => onDeleteCustom(id) : undefined}
            editing={Boolean(custom) && editingId === id}
            badge={
              custom && isImage ? (
                <span
                  title={t("settings.badge.imageSkillTitle")}
                  className="shrink-0 rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground"
                >
                  {t("settings.skillKind.image")}
                </span>
              ) : undefined
            }
          />
        );
      })}
      {!isImage && searchOpen ? (
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
