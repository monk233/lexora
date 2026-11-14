/* Picker behavior card (C32–C44, C45–C47, assertions 19–31).
 *
 * Card order mirrors the contract §7.2: enable switch → compact switch (right
 * aligned) → panel mode → text/image tabs (text badge counts every text row,
 * image badge counts enabled capture actions) → skill list →
 * add-skill button + inline custom-skill editor → default target language →
 * application blacklist.
 *
 * The image tab lists the screenshot toolbar actions plus custom image skills;
 * it may be empty (the toolbar then only offers confirm/cancel), and an
 * explicit `[]` is saved as-is. Saving/deleting a custom skill keeps
 * `picker.skills` and `picker.captureSkills` in sync with the skill kind in one
 * `update_settings` patch (legacy `saveCustomSkill` / `deleteCustomSkill`).
 */
import { useState } from "react";
import { Plus } from "lucide-react";

import { Field } from "@/components/settings/Field";
import { SectionCard } from "@/components/settings/SectionCard";
import { SegmentedControl } from "@/components/settings/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { LANGUAGES } from "@/lib/constants";
import { useT } from "@/lib/i18n";
import {
  DEFAULT_TEXT_SKILLS,
  IMAGE_SKILLS,
  countTextSkills,
  newCustomSkillId,
} from "@/lib/settings/skills";
import type { CustomSkill } from "@/lib/settings/types";

import { BlacklistInput } from "../picker/BlacklistInput";
import {
  CustomSkillEditor,
  type CustomSkillDraft,
} from "../picker/CustomSkillEditor";
import { SkillList } from "../picker/SkillList";

type SkillTab = "text" | "image";

interface EditorState {
  draft: CustomSkillDraft;
  editing: boolean;
}

const TARGET_LANGS: string[] = [
  "auto",
  ...LANGUAGES.map((language) => language.value),
];
const IMAGE_IDS = new Set(IMAGE_SKILLS.map((meta) => meta.id));

export function PickerCard() {
  const form = useSettingsForm();
  const { t } = useT();
  const [tab, setTab] = useState<SkillTab>("text");
  const [editor, setEditor] = useState<EditorState | null>(null);

  const picker = form.settings?.picker;
  if (!picker) return null;

  const customSkills = picker.customSkills ?? [];
  /* Text count follows the legacy tab badge: every text row, not only enabled
   * ones. Image count stays the enabled capture actions (assertion 21). */
  const textCount = countTextSkills(customSkills);
  const imageIds = new Set([
    ...IMAGE_IDS,
    ...customSkills.filter((skill) => skill.kind === "image").map((skill) => skill.id),
  ]);
  const enabledImageCount = new Set(
    (picker.captureSkills ?? []).map(String).filter((id) => imageIds.has(id))
  ).size;

  const panelMode: "auto" | "scroll" = picker.panelMode === "scroll" ? "scroll" : "auto";
  const targetLang = TARGET_LANGS.includes(picker.defaultTargetLang)
    ? picker.defaultTargetLang
    : "auto";
  const blacklist = Array.isArray(picker.blacklist) ? picker.blacklist : [];

  const openNewSkill = () => {
    setEditor({
      draft: {
        id: newCustomSkillId(),
        label: "",
        icon: "sparkles",
        kind: tab,
        prompt: "",
      },
      editing: false,
    });
  };

  const openEditSkill = (id: string) => {
    const custom = customSkills.find((skill) => skill.id === id);
    if (!custom) {
      toast({ description: t("settings.error.skillMissing"), tone: "error" });
      void form.refresh();
      return;
    }
    setEditor({
      draft: {
        id: custom.id,
        label: custom.label,
        icon: custom.icon,
        kind: custom.kind === "image" ? "image" : "text",
        prompt: custom.prompt,
      },
      editing: true,
    });
  };

  const saveCustomSkill = (draft: CustomSkillDraft) => {
    const stored = customSkills.slice();
    const index = stored.findIndex((skill) => skill.id === draft.id);
    if (editor?.editing && index < 0) {
      toast({ description: t("settings.error.skillMissing"), tone: "error" });
      setEditor(null);
      void form.refresh();
      return;
    }
    if (index >= 0) stored[index] = draft;
    else stored.push(draft);

    let skills = (Array.isArray(picker.skills) ? picker.skills : DEFAULT_TEXT_SKILLS).map(
      String
    );
    let captureSkills = (Array.isArray(picker.captureSkills) ? picker.captureSkills : []).map(
      String
    );
    /* An id already in its container keeps its position; edits never reorder. */
    if (draft.kind === "image") {
      skills = skills.filter((id) => id !== draft.id);
      if (!captureSkills.includes(draft.id)) captureSkills = [...captureSkills, draft.id];
    } else {
      captureSkills = captureSkills.filter((id) => id !== draft.id);
      if (!skills.includes(draft.id)) skills = [...skills, draft.id];
    }

    form.save({ picker: { customSkills: stored, skills, captureSkills } });
    toast({
      description: t(editor?.editing ? "settings.toast.skillSaved" : "settings.toast.skillAdded", {
        label: draft.label,
      }),
      tone: "success",
    });
    setEditor(null);
    setTab(draft.kind);
  };

  const deleteCustomSkill = (id: string) => {
    const custom = customSkills.find((skill) => skill.id === id);
    if (!custom) {
      toast({ description: t("settings.error.skillMissing"), tone: "error" });
      void form.refresh();
      return;
    }
    const remaining: CustomSkill[] = customSkills.filter((skill) => skill.id !== id);
    let skills = (Array.isArray(picker.skills) ? picker.skills : DEFAULT_TEXT_SKILLS)
      .map(String)
      .filter((skillId) => skillId !== id);
    if (skills.length === 0) skills = DEFAULT_TEXT_SKILLS.slice();
    /* Remove the id from both toolbars so a delete never leaves a dangling
     * action behind, whichever category the skill lived in. */
    const captureSkills = (Array.isArray(picker.captureSkills) ? picker.captureSkills : [])
      .map(String)
      .filter((skillId) => skillId !== id);

    if (editor?.draft.id === id) setEditor(null);
    form.save({ picker: { customSkills: remaining, skills, captureSkills } });
    toast({
      description: t("settings.toast.skillDeleted", { label: custom.label }),
      tone: "success",
    });
  };

  /* One sibling label is enough for the editor's non-blocking duplicate hint:
   * the editor compares it against the live draft on every keystroke. */
  const siblingLabel =
    editor === null
      ? undefined
      : customSkills.find(
          (skill) => skill.id !== editor.draft.id && skill.kind === editor.draft.kind
        )?.label;

  return (
    <SectionCard
      id="picker"
      title={t("settings.card.picker.title")}
      description={t("settings.card.picker.desc")}
    >
      <div className="flex flex-col divide-y">
        <Field
          label={t("settings.field.pickerEnabled")}
          htmlFor="picker-enabled"
          hint={t("settings.hint.pickerEnabled")}
        >
          <Switch
            id="picker-enabled"
            checked={picker.enabled !== false}
            onCheckedChange={(enabled) => form.save({ picker: { enabled } })}
          />
        </Field>

        <Field
          label={t("settings.field.compactMode")}
          htmlFor="picker-compact"
          hint={t("settings.hint.compactMode")}
          controlClassName="items-end"
        >
          <Switch
            id="picker-compact"
            checked={picker.compact === true}
            onCheckedChange={(compact) => form.save({ picker: { compact } })}
          />
        </Field>

        <Field
          label={t("settings.field.panelMode")}
          hint={t("settings.hint.panelMode")}
          controlClassName="items-start"
        >
          <SegmentedControl
            ariaLabel={t("settings.field.panelMode")}
            mode="pressed"
            value={panelMode}
            options={[
              {
                value: "auto",
                label: t("settings.panelMode.auto"),
                title: t("settings.panelMode.autoTitle"),
              },
              {
                value: "scroll",
                label: t("settings.panelMode.scroll"),
                title: t("settings.panelMode.scrollTitle"),
              },
            ]}
            onChange={(next) => form.save({ picker: { panelMode: next } })}
          />
        </Field>

        <Field
          label={t("settings.field.toolbarSkills")}
          hint={t("settings.hint.toolbarSkills")}
          controlClassName="items-stretch"
        >
          <div className="flex flex-col gap-3">
            <SegmentedControl
              ariaLabel={t("settings.tabs.skillKind")}
              mode="tab"
              value={tab}
              options={[
                {
                  value: "text",
                  label: t("settings.skills.textTab"),
                  ariaControls: "skill-list-text",
                  badge: (
                    <span className="text-[11px] font-normal text-muted-foreground">
                      ({textCount})
                    </span>
                  ),
                },
                {
                  value: "image",
                  label: t("settings.skills.imageTab"),
                  ariaControls: "skill-list-image",
                  badge: (
                    <span className="text-[11px] font-normal text-muted-foreground">
                      ({enabledImageCount})
                    </span>
                  ),
                },
              ]}
              onChange={setTab}
            />
            <SkillList
              kind={tab}
              onOpenSearch={() => {}}
              onEditCustom={openEditSkill}
              onDeleteCustom={deleteCustomSkill}
              editingId={editor?.draft.id}
            />
            {tab === "image" ? (
              enabledImageCount === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("settings.hint.captureEmpty")}
                </p>
              ) : null
            ) : null}
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={openNewSkill}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t("settings.action.addSkill")}
              </Button>
            </div>
            {editor ? (
              <CustomSkillEditor
                key={`${editor.draft.id}:${editor.editing ? "edit" : "new"}`}
                draft={editor.draft}
                editing={editor.editing}
                existingLabel={siblingLabel}
                onSave={saveCustomSkill}
                onCancel={() => setEditor(null)}
                onDelete={editor.editing ? () => deleteCustomSkill(editor.draft.id) : undefined}
              />
            ) : null}
          </div>
        </Field>

        <Field
          label={t("settings.field.defaultTargetLang")}
          htmlFor="picker-target-lang"
          hint={t("settings.hint.defaultTargetLang")}
        >
          <Select
            value={targetLang}
            onValueChange={(value) => form.save({ picker: { defaultTargetLang: value } })}
          >
            <SelectTrigger
              id="picker-target-lang"
              aria-label={t("settings.field.defaultTargetLang")}
            >
              <SelectValue>{t(`settings.targetLang.${targetLang}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {TARGET_LANGS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`settings.targetLang.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label={t("settings.field.blacklist")}
          hint={t("settings.hint.blacklist")}
        >
          <BlacklistInput
            entries={blacklist}
            onChange={(next) => form.save({ picker: { blacklist: next } })}
          />
        </Field>
      </div>
    </SectionCard>
  );
}
