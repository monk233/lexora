/* Picker behavior card (C32–C36, C45–C47, assertions 19–28).
 *
 * Card order mirrors the contract §7.2: enable switch → compact switch (right
 * aligned) → panel mode → text/image tabs with enabled counts → skill list →
 * default target language → application blacklist. The image tab's rows,
 * custom-skill editor and the "add skill" action belong to Task 7; this card
 * only mounts the tab and its empty list container.
 */
import { useState } from "react";

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
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { LANGUAGES } from "@/lib/constants";
import { useT } from "@/lib/i18n";
import { IMAGE_SKILLS, TEXT_SKILLS } from "@/lib/settings/skills";

import { BlacklistInput } from "../picker/BlacklistInput";
import { SkillList } from "../picker/SkillList";

type SkillTab = "text" | "image";

const TARGET_LANGS: string[] = [
  "auto",
  ...LANGUAGES.map((language) => language.value),
];
const IMAGE_IDS = new Set(IMAGE_SKILLS.map((meta) => meta.id));

export function PickerCard() {
  const form = useSettingsForm();
  const { t } = useT();
  const [tab, setTab] = useState<SkillTab>("text");

  const picker = form.settings?.picker;
  if (!picker) return null;

  const customSkills = picker.customSkills ?? [];
  const textIds = new Set([
    ...TEXT_SKILLS.map((meta) => meta.id),
    ...customSkills.filter((skill) => skill.kind !== "image").map((skill) => skill.id),
  ]);
  const imageIds = new Set([
    ...IMAGE_IDS,
    ...customSkills.filter((skill) => skill.kind === "image").map((skill) => skill.id),
  ]);
  const enabledTextCount = new Set(
    (picker.skills ?? []).map(String).filter((id) => textIds.has(id))
  ).size;
  const enabledImageCount = new Set(
    (picker.captureSkills ?? []).map(String).filter((id) => imageIds.has(id))
  ).size;

  const panelMode: "auto" | "scroll" = picker.panelMode === "scroll" ? "scroll" : "auto";
  const targetLang = TARGET_LANGS.includes(picker.defaultTargetLang)
    ? picker.defaultTargetLang
    : "auto";
  const blacklist = Array.isArray(picker.blacklist) ? picker.blacklist : [];

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
                      ({enabledTextCount})
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
            <SkillList kind={tab} onOpenSearch={() => {}} onEditCustom={() => {}} />
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
