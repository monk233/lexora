/* Custom skill editor (C38, C40–C44, assertions 29–30).
 *
 * A local draft (the card owns persistence): icon gallery → skill kind → name →
 * prompt → save / cancel / armed delete. Validation mirrors
 * `web/settings.js:3595-3643`; `Esc` closes the editor (the icon gallery
 * consumes its own Esc first) and `Ctrl/Cmd+Enter` saves.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { SegmentedControl } from "@/components/settings/SegmentedControl";
import { useArmedConfirm } from "@/components/settings/useArmedConfirm";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { IconPicker } from "./IconPicker";

export interface CustomSkillDraft {
  id: string;
  label: string;
  icon: string;
  kind: "text" | "image";
  prompt: string;
}

export type SkillFieldError =
  | "settings.error.skillNameRequired"
  | "settings.error.skillNameTooLong"
  | "settings.error.promptRequiredText"
  | "settings.error.promptRequiredImage"
  | "settings.error.promptTooLong";

export interface CustomSkillErrors {
  label?: SkillFieldError;
  prompt?: SkillFieldError;
}

/** Pure field validation, mirroring the legacy save gate. */
export function validateCustomSkill(draft: CustomSkillDraft): CustomSkillErrors {
  const errors: CustomSkillErrors = {};
  const label = String(draft.label ?? "").trim();
  const prompt = String(draft.prompt ?? "").trim();

  if (!label) errors.label = "settings.error.skillNameRequired";
  else if (label.length > 20) errors.label = "settings.error.skillNameTooLong";

  if (!prompt) {
    errors.prompt =
      draft.kind === "image"
        ? "settings.error.promptRequiredImage"
        : "settings.error.promptRequiredText";
  } else if (prompt.length > 4000) {
    errors.prompt = "settings.error.promptTooLong";
  }
  return errors;
}

export interface CustomSkillEditorProps {
  draft: CustomSkillDraft;
  /** true → delete button + `settings.editor.editTitle`. */
  editing: boolean;
  /** Non-blocking duplicate-name hint: every same-kind sibling label. */
  existingLabels?: string[];
  onSave: (draft: CustomSkillDraft) => void;
  onCancel: () => void;
  onDelete?: () => void;
}

const INPUT_CLASS =
  "h-9 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const TEXTAREA_CLASS =
  "min-h-[9rem] w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function CustomSkillEditor({
  draft,
  editing,
  existingLabels,
  onSave,
  onCancel,
  onDelete,
}: CustomSkillEditorProps) {
  const { t } = useT();
  const fieldId = useId();
  const nameId = `${fieldId}-name`;
  const promptId = `${fieldId}-prompt`;

  const [value, setValue] = useState<CustomSkillDraft>(() => ({ ...draft }));
  const [errors, setErrors] = useState<CustomSkillErrors>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const remove = useArmedConfirm(() => onDelete?.());

  /* The card mounts the editor for one draft at a time: focus the name and make
   * sure the inline panel is visible (legacy `openCustomEditor`). */
  useEffect(() => {
    rootRef.current?.scrollIntoView?.({ block: "nearest" });
    nameRef.current?.focus();
  }, []);

  const patch = (next: Partial<CustomSkillDraft>) => {
    setValue((previous) => ({ ...previous, ...next }));
  };

  const save = () => {
    const normalized: CustomSkillDraft = {
      id: value.id,
      label: value.label.replace(/\s+/g, " ").trim(),
      icon: value.icon,
      kind: value.kind === "image" ? "image" : "text",
      prompt: value.prompt.trim(),
    };
    const nextErrors = validateCustomSkill(normalized);
    setErrors(nextErrors);
    if (nextErrors.label) {
      nameRef.current?.focus();
      return;
    }
    if (nextErrors.prompt) {
      promptRef.current?.focus();
      return;
    }
    onSave(normalized);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    }
  };

  /* Any same-kind sibling may own the name, not only the first one. */
  const draftLabel = value.label.trim();
  const duplicateLabel =
    draftLabel.length === 0
      ? undefined
      : (existingLabels ?? []).find(
          (label) => label.trim().toLowerCase() === draftLabel.toLowerCase()
        );

  return (
    <div
      ref={rootRef}
      data-testid="custom-skill-editor"
      role="group"
      aria-label={t(editing ? "settings.editor.editTitle" : "settings.editor.newTitle")}
      className="flex flex-col gap-4 rounded-lg border bg-card p-4"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold">
          {t(editing ? "settings.editor.editTitle" : "settings.editor.newTitle")}
        </span>
        <span className="text-xs text-muted-foreground">{t("settings.editor.subtitle")}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t("settings.field.icon")}</span>
        <IconPicker
          id="custom-skill-icon"
          value={value.icon}
          onChange={(icon) => patch({ icon })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {t("settings.field.skillKind")}
        </span>
        <SegmentedControl
          ariaLabel={t("settings.field.skillKind")}
          mode="pressed"
          value={value.kind}
          options={[
            {
              value: "text",
              label: t("settings.skillKind.text"),
              ariaLabel: t("settings.skillKind.textAria"),
            },
            {
              value: "image",
              label: t("settings.skillKind.image"),
              ariaLabel: t("settings.skillKind.imageAria"),
            },
          ]}
          onChange={(kind) => {
            patch({ kind });
            setErrors((previous) => ({ ...previous, prompt: undefined }));
          }}
        />
        <p className="text-xs text-muted-foreground">
          {t(`settings.hint.customKind.${value.kind}`)}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground">
          {t("settings.field.name")}
        </label>
        <input
          ref={nameRef}
          id={nameId}
          type="text"
          maxLength={20}
          autoComplete="off"
          spellCheck={false}
          placeholder={t("settings.placeholder.skillName")}
          value={value.label}
          className={cn(INPUT_CLASS, errors.label && "border-destructive")}
          onChange={(event) => {
            patch({ label: event.target.value });
            setErrors((previous) => ({ ...previous, label: undefined }));
          }}
        />
        {duplicateLabel !== undefined ? (
          <p className="text-xs text-amber-600">
            {t("settings.hint.skillNameDuplicate", { label: duplicateLabel })}
          </p>
        ) : null}
        {errors.label ? (
          <p role="alert" className="text-xs font-medium text-destructive">
            {t(errors.label)}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={promptId} className="text-xs font-medium text-muted-foreground">
          {t("settings.field.prompt")}
        </label>
        <textarea
          ref={promptRef}
          id={promptId}
          rows={6}
          maxLength={4000}
          spellCheck={false}
          placeholder={t("settings.placeholder.skillPrompt")}
          value={value.prompt}
          className={cn(TEXTAREA_CLASS, errors.prompt && "border-destructive")}
          onChange={(event) => {
            patch({ prompt: event.target.value });
            setErrors((previous) => ({ ...previous, prompt: undefined }));
          }}
        />
        <p
          className="text-xs text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono"
          dangerouslySetInnerHTML={{ __html: t(`settings.varsHint.${value.kind}`) }}
        />
        {errors.prompt ? (
          <p role="alert" className="text-xs font-medium text-destructive">
            {t(errors.prompt)}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={save}>
          {t("settings.action.save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        {editing && onDelete ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="ml-auto"
            onClick={remove.arm}
          >
            {t(remove.armed ? "settings.action.confirmDeleteAgain" : "settings.action.delete")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
