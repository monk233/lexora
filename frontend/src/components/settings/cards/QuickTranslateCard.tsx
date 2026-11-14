/* Quick translate card (C48–C53, assertions 34–35, contract §7.4).
 *
 * Card order: enable switch → paragraph/long-sentence prompt → word/phrase
 * prompt → clear-history danger button. Both prompt slots share one rendering
 * loop; `PromptEditor` owns the IME-safe debounce, and the save value is
 * normalized to the empty override sentinel when it matches the bundled
 * default. The history button follows the legacy `armDanger` semantics through
 * `useArmedConfirm` (second click within four seconds).
 *
 * Recording the invocation hotkey (C57/C58) belongs to the shortcuts card
 * (Task 9); this card must not grow a second recorder. `quick.sourceLang`,
 * `quick.targetLang` and `quick.pinned` deliberately have no controls: the
 * panel owns them (inventory §S4 note after the C-table).
 */
import { useState } from "react";

import { Field } from "@/components/settings/Field";
import { SectionCard } from "@/components/settings/SectionCard";
import { useArmedConfirm } from "@/components/settings/useArmedConfirm";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/use-toast";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { useT } from "@/lib/i18n";
import { normalizePrompt } from "@/lib/settings/skills";

import { PromptEditor } from "../picker/PromptEditor";

type QuickPromptSlot = "prompt" | "wordLookupPrompt";

interface PromptSlotConfig {
  slot: QuickPromptSlot;
  /** Stable draft id; also the textarea's legacy id. */
  id: string;
  defaultKey: "quickTranslate" | "quickTranslateWordLookup";
  labelKey: string;
  hintKey: string;
}

const PROMPT_SLOTS: PromptSlotConfig[] = [
  {
    slot: "prompt",
    id: "quick-prompt",
    defaultKey: "quickTranslate",
    labelKey: "settings.quick.promptLabel",
    hintKey: "settings.quick.promptHintDetail",
  },
  {
    slot: "wordLookupPrompt",
    id: "quick-word-prompt",
    defaultKey: "quickTranslateWordLookup",
    labelKey: "settings.quick.wordPromptLabel",
    hintKey: "settings.quick.wordPromptHintDetail",
  },
];

export function QuickTranslateCard() {
  const form = useSettingsForm();
  const { t } = useT();
  /* Inline preview degradation (legacy `quickApiCall` fallback): never a modal,
   * never a command. The message is stored as a key and resolved on render so a
   * language switch re-localizes it. */
  const [historyErrorKey, setHistoryErrorKey] = useState<string | null>(null);

  const clearHistory = async () => {
    if (!form.api.live) {
      setHistoryErrorKey("settings.quick.error.apiUnsupported");
      return;
    }
    setHistoryErrorKey(null);
    let result;
    try {
      result = await form.api.clearQuickHistory();
    } catch (error) {
      result = { ok: false, error: String(error) };
    }
    if (result.ok) {
      toast({ description: t("settings.quick.toast.historyCleared"), tone: "success" });
    } else {
      toast({
        description: t("settings.quick.error.clearFailed", {
          error: result.error || t("common.unknownError"),
        }),
        tone: "error",
      });
    }
  };

  const historyClear = useArmedConfirm(() => {
    void clearHistory();
  });

  const quick = form.settings?.quick;
  const promptDefaults = form.state?.promptDefaults ?? {};
  if (!quick) return null;

  const savePrompt = (config: PromptSlotConfig, value: string) => {
    const defaultPrompt = String(promptDefaults[config.defaultKey] ?? "");
    form.save({ quick: { [config.slot]: normalizePrompt(value, defaultPrompt) } });
  };

  const resetPrompt = (config: PromptSlotConfig) => {
    form.save({ quick: { [config.slot]: "" } });
    toast({ description: t("settings.toast.promptReset"), tone: "success" });
  };

  return (
    <SectionCard
      id="quick"
      title={t("settings.quick.title")}
      description={t("settings.quick.desc")}
    >
      <div className="flex flex-col divide-y">
        <Field
          label={t("settings.quick.enabled")}
          htmlFor="quick-enabled"
          hint={t("settings.quick.enabledHint")}
        >
          <Switch
            id="quick-enabled"
            checked={quick.enabled !== false}
            onCheckedChange={(enabled) => form.save({ quick: { enabled } })}
          />
        </Field>

        {PROMPT_SLOTS.map((config) => {
          const defaultPrompt = String(promptDefaults[config.defaultKey] ?? "");
          return (
            <div key={config.slot} className="py-3.5">
              <PromptEditor
                id={config.id}
                title={t(config.labelKey)}
                hint={t(config.hintKey)}
                value={quick[config.slot] ?? ""}
                defaultPrompt={defaultPrompt}
                resetLabel={t("settings.quick.resetPrompt")}
                onSave={(value) => savePrompt(config, value)}
                onReset={() => resetPrompt(config)}
              />
            </div>
          );
        })}

        <Field
          label={t("settings.quick.history")}
          hint={t("settings.quick.historyHint")}
          error={historyErrorKey ? t(historyErrorKey) : undefined}
          controlClassName="items-start"
        >
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={historyClear.arm}
          >
            {t(
              historyClear.armed
                ? "settings.quick.confirmClear"
                : "settings.quick.clearHistory"
            )}
          </Button>
        </Field>
      </div>
    </SectionCard>
  );
}
