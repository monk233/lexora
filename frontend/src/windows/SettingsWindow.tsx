/* Settings window shell (Task 3).
 *
 * Composition order is load-bearing: `SettingsFormProvider` is the outer layer
 * because it owns the backend `StatePayload`; only after it has data can the
 * locale be derived. `SettingsLocaleBridge` reads `state.app.locale` and mounts
 * `I18nProvider` beneath the form store, so a `state-changed` payload switches
 * the language of every already-rendered card in one pass. Cards consume
 * `useSettingsForm()` and `useT()`; this file only owns the page skeleton.
 */
import { useEffect, useRef, useState } from "react";

import { Toaster } from "@/components/ui/toaster";
import { toast } from "@/components/ui/use-toast";
import { SectionCard } from "@/components/settings/SectionCard";
import { HotkeyCard } from "@/components/settings/cards/HotkeyCard";
import { PickerCard } from "@/components/settings/cards/PickerCard";
import { ProviderCard } from "@/components/settings/cards/ProviderCard";
import { QuickTranslateCard } from "@/components/settings/cards/QuickTranslateCard";
import { Topbar } from "@/components/settings/Topbar";
import { useColorScheme } from "@/hooks/useColorScheme";
import { SettingsFormProvider, useSettingsForm } from "@/hooks/useSettingsForm";
import { I18nProvider, normalizeLocale, useT } from "@/lib/i18n";
import type { SettingsApi } from "@/lib/settings/api";
import type { Locale } from "@/lib/settings/types";

/** Locale to render with before the backend state arrives. */
function firstLocale(): Locale {
  if (typeof document === "undefined") return "en";
  return normalizeLocale(document.documentElement.lang || navigator.language);
}

export function SettingsWindow({ api }: { api?: SettingsApi } = {}) {
  return (
    <SettingsFormProvider api={api}>
      <SettingsLocaleBridge />
    </SettingsFormProvider>
  );
}

function SettingsLocaleBridge() {
  const form = useSettingsForm();
  /* Read once: the provider must not remount (and lose `setLocale` history)
   * when the backend locale arrives a moment later. */
  const [initialLocale] = useState(firstLocale);
  const locale = form.state?.app.locale;

  return (
    <I18nProvider initialLocale={initialLocale}>
      <SettingsLocaleSync locale={locale} />
      <SettingsShell />
    </I18nProvider>
  );
}

function SettingsLocaleSync({ locale }: { locale?: Locale }) {
  const { setLocale } = useT();
  useEffect(() => {
    if (locale) setLocale(locale);
  }, [locale, setLocale]);
  return null;
}

function SettingsShell() {
  const form = useSettingsForm();
  const { t } = useT();
  useColorScheme();

  /* One toast per distinct read error; a language switch changes `t` but must
   * not replay the same failure. */
  const reportedError = useRef<string | null>(null);
  useEffect(() => {
    if (!form.loadError) {
      reportedError.current = null;
      return;
    }
    if (reportedError.current === form.loadError) return;
    reportedError.current = form.loadError;
    toast({
      description: t("settings.error.readSettings", { error: form.loadError }),
      tone: "error",
    });
  }, [form.loadError, t]);

  useEffect(() => {
    document.title = t("settings.windowTitle");
  }, [t]);

  /* Cards mount only once a state exists: on a failed load the shell (topbar +
   * page frame) stays visible without pretending to have settings to edit. */
  const ready = form.state !== null;

  return (
    <div className="settings-window min-h-full bg-background text-foreground">
      <Topbar status={form.status} />
      <main
        data-testid="settings-page"
        className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-8 py-6"
      >
        {ready ? (
          <>
            <ProviderCard />
            <PickerCard />
            <QuickTranslateCard />
            <HotkeyCard />
            <SectionCard
              id="app"
              title={t("settings.card.app.title")}
              description={t("settings.card.app.desc")}
            >
              {null}
            </SectionCard>
            <SectionCard
              id="about"
              title={t("settings.card.about.title")}
              description={t("settings.card.about.desc")}
            >
              {null}
            </SectionCard>
          </>
        ) : null}
      </main>
      <Toaster />
    </div>
  );
}
