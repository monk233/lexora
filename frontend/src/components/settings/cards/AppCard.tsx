/* App & startup card (C60-C66).
 *
 * Startup-at-login is deliberately NOT part of the settings patch: it reflects
 * the OS login item, so the switch reads ``state.loginItem.enabled`` (never
 * ``app.startAtLogin``) and saves through ``set_start_at_login``.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/use-toast";
import { Field } from "@/components/settings/Field";
import { SectionCard } from "@/components/settings/SectionCard";
import { useArmedConfirm } from "@/components/settings/useArmedConfirm";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { useT } from "@/lib/i18n";
import type { DirKind } from "@/lib/settings/api";

type LanguageSetting = "system" | "zh" | "en";

const LANGUAGES: { value: LanguageSetting; labelKey: string }[] = [
  { value: "system", labelKey: "common.followSystem" },
  { value: "zh", labelKey: "language.zh" },
  { value: "en", labelKey: "language.en" },
];

const DIRS: { which: DirKind; labelKey: string }[] = [
  { which: "data", labelKey: "settings.action.dataDir" },
  { which: "models", labelKey: "settings.action.modelsDir" },
  { which: "logs", labelKey: "settings.action.logsDir" },
  { which: "engine", labelKey: "settings.action.engineDir" },
];

export function AppCard() {
  const form = useSettingsForm();
  const { t } = useT();
  const settings = form.settings;
  const app = settings?.app;
  const login = form.state?.loginItem;
  const portable = form.state?.app.portable === true;
  const language: LanguageSetting =
    app?.language === "zh" || app?.language === "en" ? app.language : "system";

  const [loginBusy, setLoginBusy] = useState(false);

  async function resetSettings() {
    const result = await form.api.resetSettings();
    if (result.ok && result.state) {
      form.applyState(result.state);
      toast({ description: t("settings.toast.resetDone"), tone: "success" });
      return;
    }
    toast({
      description: t("settings.error.resetSettings", {
        error: result.error || "",
      }),
      tone: "error",
    });
  }

  async function quit() {
    await form.api.quit();
  }

  const reset = useArmedConfirm(() => {
    void resetSettings();
  });
  const quitConfirm = useArmedConfirm(() => {
    void quit();
  });

  const changeLanguage = (next: string) => {
    if (next === "system" || next === "zh" || next === "en") {
      form.save({ app: { language: next } });
    }
  };

  const toggleStartAtLogin = async (enabled: boolean) => {
    setLoginBusy(true);
    const result = await form.api.setStartAtLogin(enabled);
    setLoginBusy(false);
    if (!result.ok) {
      toast({
        description: t("settings.error.startAtLogin", {
          error: result.error || "",
        }),
        tone: "error",
      });
    }
    /* Always re-read: the OS login item is the source of truth. */
    await form.refresh();
  };

  const resetSettingsHandler = () => {
    reset.arm();
  };

  const quitHandler = () => {
    quitConfirm.arm();
  };

  return (
    <SectionCard
      id="app"
      title={t("settings.card.app.title")}
      description={t("settings.card.app.desc")}
    >
      <Field label={t("settings.language.title")} hint={t("settings.language.hint")}>
        <Select value={language} onValueChange={changeLanguage}>
          <SelectTrigger aria-label={t("settings.language.title")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {t(entry.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field
        label={t("settings.field.startAtLogin")}
        hint={
          portable && login?.supported === false
            ? t("settings.login.portableHint")
            : t("settings.hint.startAtLogin")
        }
      >
        <div className="flex flex-col gap-1.5">
          <Switch
            aria-label={t("settings.field.startAtLogin")}
            checked={login?.enabled === true}
            disabled={loginBusy || portable || login?.supported === false}
            onCheckedChange={(checked) => {
              void toggleStartAtLogin(checked);
            }}
          />
          {portable ? (
            <p className="text-xs text-muted-foreground">
              {t("settings.login.portableNote")}
            </p>
          ) : null}
        </div>
      </Field>

      <Field label={t("settings.field.closeToTray")}>
        <Switch
          aria-label={t("settings.field.closeToTray")}
          checked={app ? app.closeToTray !== false : true}
          onCheckedChange={(checked) => form.save({ app: { closeToTray: checked } })}
        />
      </Field>

      <Field label={t("settings.action.dataDir")}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {DIRS.map((entry) => (
            <Button
              key={entry.which}
              type="button"
              variant="outline"
              size="sm"
              data-dir={entry.which}
              onClick={() => {
                void form.api.openDir(entry.which);
              }}
            >
              {t(entry.labelKey)}
            </Button>
          ))}
        </div>
      </Field>

      <Field label={t("settings.danger.resetTitle")} hint={t("settings.danger.resetDesc")}>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          data-action="reset"
          onClick={resetSettingsHandler}
        >
          {reset.armed ? t("settings.action.confirmReset") : t("settings.action.reset")}
        </Button>
      </Field>

      <Field label={t("settings.danger.quitTitle")} hint={t("settings.danger.quitDesc")}>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          data-action="quit"
          onClick={quitHandler}
        >
          {quitConfirm.armed ? t("settings.action.confirmQuit") : t("settings.action.quit")}
        </Button>
      </Field>
    </SectionCard>
  );
}
