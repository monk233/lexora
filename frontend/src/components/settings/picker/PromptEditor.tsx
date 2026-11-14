/* Inline prompt editor (C36, assertion 25, inventory risk 1).
 *
 * A controlled `<textarea>` whose draft lives in the shared settings store
 * (`useSettingsTextField`): composition pauses the 500ms debounce, `Ctrl/Cmd +
 * Enter` flushes, and collapsing flushes before hiding so a keystroke can never
 * be lost. The save value is normalized first: empty or default-equal content
 * persists as the empty override sentinel that makes the backend fall back to
 * the bundled prompt.
 *
 * Callers own persistence through `onSave`, which receives the normalized value
 * and returns the patch to write; returning nothing is allowed for callers that
 * persist themselves (the form store never sends an empty patch) and resetting
 * is announced by the caller so its toast copy stays local.
 */
import { useState } from "react";
import { Pencil } from "lucide-react";

import { useSettingsForm, useSettingsTextField } from "@/hooks/useSettingsForm";
import { useT } from "@/lib/i18n";
import { normalizePrompt } from "@/lib/settings/skills";
import type { SettingsPatch } from "@/lib/settings/types";
import { cn } from "@/lib/utils";

export interface PromptEditorProps {
  id: string;
  title: string;
  hint?: string;
  value: string;
  defaultPrompt: string;
  /** Receives the normalized value; return the patch to persist it. */
  onSave: (value: string) => SettingsPatch | void;
  onReset: () => void;
  /** Reset-button copy; defaults to `common.reset`. The quick-translate card
   * passes its own key even though the two strings are currently identical. */
  resetLabel?: string;
  /** `false` inside a row whose own button already discloses the editor. */
  collapsible?: boolean;
}

const TEXTAREA_CLASS =
  "mt-2 min-h-[7rem] w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function PromptEditor({
  id,
  title,
  hint,
  value,
  defaultPrompt,
  onSave,
  onReset,
  resetLabel,
  collapsible = true,
}: PromptEditorProps) {
  const form = useSettingsForm();
  const { t } = useT();
  const [open, setOpen] = useState(!collapsible);

  const field = useSettingsTextField({
    id,
    value: value || defaultPrompt,
    build: (raw) => onSave(normalizePrompt(raw, defaultPrompt)) ?? {},
    multiline: true,
  });

  /* Flush before collapsing: unmounting the textarea must not drop the draft. */
  const toggle = () => {
    if (open) form.flushDraft(id);
    setOpen((previous) => !previous);
  };

  const reset = () => {
    /* Reset discards the uncommitted draft: the caller writes the empty
     * override, so flushing the discarded text first would only race it. */
    form.cancelDraft(id);
    onReset();
  };

  return (
    <div className="rounded-md border bg-muted/40 p-3" data-testid={`prompt-editor-${id}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-foreground">{title}</span>
        {collapsible ? (
          <button
            type="button"
            aria-label={t("settings.action.editPrompt")}
            aria-expanded={open}
            title={t("settings.action.editPrompt")}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
              "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
            onClick={toggle}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {open ? (
        <>
          <textarea
            {...field}
            aria-label={title}
            className={TEXTAREA_CLASS}
            rows={6}
            maxLength={4000}
            spellCheck={false}
          />
          <div className="mt-2 flex items-start justify-between gap-3">
            {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : <span />}
            <button
              type="button"
              className="shrink-0 text-xs font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={reset}
            >
              {resetLabel ?? t("common.reset")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
