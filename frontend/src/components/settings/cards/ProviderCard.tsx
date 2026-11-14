/* Translation service card (C02–C04).
 *
 * Owns the provider-mode segmented control (`role="tab"`, matching the legacy
 * aria contract), the engine-derived service badge, and the panel switch. The
 * online and local halves live in `provider/OnlinePanel` and
 * `provider/LocalPanel`; this file only owns the shared header and mode state.
 */
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { SectionCard } from "@/components/settings/SectionCard";
import { SegmentedControl } from "@/components/settings/SegmentedControl";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { useT } from "@/lib/i18n";
import type { EngineStatus } from "@/lib/settings/types";

import { OnlinePanel } from "./provider/OnlinePanel";
import { LocalPanel } from "./provider/LocalPanel";

/** Engine status → header badge copy, verbatim legacy branch order
 * (`web/settings.js:559-595`). */
export function providerBadge(engine: EngineStatus): { tone: BadgeTone; key: string } {
  if (engine.mode === "local") {
    if (engine.localState === "ready") {
      return { tone: "ok", key: "settings.provider.localRunning" };
    }
    if (engine.localState === "starting") {
      return { tone: "warn", key: "settings.provider.localStarting" };
    }
    if (engine.localState === "error") {
      return { tone: "error", key: "settings.provider.localError" };
    }
    if (engine.engineAvailable) {
      return { tone: "muted", key: "settings.provider.localStopped" };
    }
    return { tone: "warn", key: "settings.provider.localNoEngine" };
  }
  if (engine.ready) return { tone: "ok", key: "settings.provider.onlineReady" };
  if (engine.onlineConfigured) {
    return { tone: "warn", key: "settings.provider.onlineUnverified" };
  }
  return { tone: "warn", key: "settings.provider.onlineUnconfigured" };
}

export function ProviderCard() {
  const form = useSettingsForm();
  const { t } = useT();

  const mode: "online" | "local" =
    form.settings?.provider.mode === "local" ? "local" : "online";
  const engine = form.state?.engine;

  if (!form.settings) return null;

  const badge = engine ? providerBadge(engine) : null;

  return (
    <SectionCard
      id="provider"
      title={t("settings.card.services.title")}
      description={t("settings.card.services.desc")}
      badge={
        badge ? (
          <Badge data-testid="provider-badge" data-tone={badge.tone} tone={badge.tone}>
            {t(badge.key)}
          </Badge>
        ) : null
      }
    >
      <div className="flex flex-col gap-4">
        <SegmentedControl
          ariaLabel={t("settings.tabs.providerMode")}
          mode="tab"
          value={mode}
          options={[
            { value: "online", label: t("settings.mode.online") },
            { value: "local", label: t("settings.mode.local") },
          ]}
          onChange={(next) => form.save({ provider: { mode: next } })}
        />
        {mode === "online" ? <OnlinePanel /> : <LocalPanel />}
      </div>
    </SectionCard>
  );
}
