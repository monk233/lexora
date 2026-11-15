/* Picker window root (P3).
 *
 * Both surfaces share one entry. The toolbar surface renders the capsule and
 * delegates panel-opening skills to the shell (`picker_toolbar_run_skill`); the
 * panel surface shows the capsule first and swaps to the result panel once a
 * skill starts, which is the legacy single-window behaviour (contracts §7.1).
 */
import { useEffect, useMemo, useState } from "react";

import { FollowupBar } from "@/components/picker/FollowupBar";
import { PickerMenu } from "@/components/picker/PickerMenu";
import { PickerPanel } from "@/components/picker/PickerPanel";
import { PickerToolbar } from "@/components/picker/PickerToolbar";
import { PanelBody } from "@/components/picker/PanelBody";
import { usePickerBridge, type PickerApi } from "@/hooks/usePickerBridge";
import { usePickerSession } from "@/hooks/usePickerSession";
import {
  AUTO_PANEL_WIDTH,
  availablePanelHeight,
  readStoredPanelSize,
} from "@/hooks/usePanelAutosize";

import { I18nProvider, normalizeLocale, useT } from "@/lib/i18n";
import { renderMarkdown } from "@/lib/markdown";
import { payloadSkills, type PickerSkill, type PickerSurface } from "@/lib/picker/model";

export interface PickerWindowProps {
  surface?: PickerSurface;
  api?: PickerApi;
}

export function PickerWindow({ surface, api }: PickerWindowProps = {}) {
  const bridge = usePickerBridge({ surface, api });
  const [initialLocale] = useState(() =>
    normalizeLocale(document.documentElement.lang || navigator.language)
  );
  return (
    <I18nProvider initialLocale={initialLocale}>
      <PickerLocaleSync locale={bridge.payload?.config?.locale} />
      <PickerSurfaces bridge={bridge} />
    </I18nProvider>
  );
}

function PickerLocaleSync({ locale }: { locale?: string }) {
  const { setLocale } = useT();
  useEffect(() => {
    if (locale) setLocale(normalizeLocale(locale));
  }, [locale, setLocale]);
  return null;
}

function PickerSurfaces({ bridge }: { bridge: ReturnType<typeof usePickerBridge> }) {
  const session = usePickerSession({
    api: bridge.api,
    payload: bridge.payload,
    image: bridge.image,
    surface: bridge.surface,
  });
  const { t } = useT();
  const panelOpen = session.panel !== null;

  /* Size the window once the panel opens: auto mode uses the narrow column and
   * grows later; scroll mode reuses the stored user size. */
  useEffect(() => {
    if (!panelOpen) return;
    const stored = readStoredPanelSize();
    const mode = bridge.payload?.config?.panelMode;
    if (mode === "scroll" && stored) {
      void (bridge.api.resize(stored.width, stored.height) as Promise<unknown> | null);
      return;
    }
    const height = Math.min(520, availablePanelHeight());
    void (bridge.api.resize(AUTO_PANEL_WIDTH, height) as Promise<unknown> | null);
  }, [bridge.api, bridge.payload, panelOpen]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [overflow, setOverflow] = useState<PickerSkill[]>([]);
  const skills = useMemo(() => payloadSkills(bridge.payload), [bridge.payload]);

  /* Close the panel on Escape; the toolbar surface leaves dismissal to Rust. */
  useEffect(() => {
    if (bridge.surface !== "panel" || !session.panel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") session.close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [bridge.surface, session]);

  const toolbar = (
    <div className="relative inline-block">
      <PickerToolbar
        skills={skills}
        compact={bridge.payload?.config?.compact === true}
        api={bridge.api}
        onRun={(skillId) => {
          setMenuOpen(false);
          session.run(skillId);
        }}
        onMore={() => setMenuOpen((open) => !open)}
        onOverflowChange={setOverflow}
        canResize={!session.panel && !menuOpen}
      />
      {menuOpen ? (
        <PickerMenu
          api={bridge.api}
          skills={overflow}
          programName={bridge.payload?.programName}
          onRunSkill={(skillId) => {
            setMenuOpen(false);
            session.run(skillId);
          }}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
    </div>
  );

  if (bridge.surface === "toolbar") {
    return (
      <div
        data-testid="surface"
        data-surface="toolbar"
        className="h-full w-full bg-transparent p-[2px]"
      >
        {toolbar}
      </div>
    );
  }

  if (!session.panel) {
    return (
      <div
        data-testid="surface"
        data-surface="panel"
        className="h-full w-full bg-transparent p-[2px]"
      >
        {toolbar}
      </div>
    );
  }

  const { panel } = session;

  return (
    <div
      data-testid="surface"
      data-surface="panel"
      data-panel-open="true"
      className="h-full w-full bg-transparent text-foreground"
    >
      <PickerPanel
        api={bridge.api}
        title={panel.title}
        showLanguage={panel.showLanguage}
        targetLang={session.targetLang}
        pinned={panel.pinned}
        streaming={session.phase === "loading" || session.phase === "streaming"}
        canRetry={session.phase !== "loading" && session.phase !== "streaming"}
        canCopy={session.text.length > 0}
        canSpeak={session.text.length > 0}
        onClose={session.close}
        onPinChange={session.pin}
        onTargetLangChange={session.setTargetLang}
        onSpeak={() => session.speak(session.text)}
        onCopy={session.copy}
        onRetry={session.retry}
        onStop={session.stop}
        onResize={(width, height) => {
          void (bridge.api.resize(width, height) as Promise<unknown> | null);
        }}
        onResetSize={() => undefined}
      >
        <PanelBody
          api={bridge.api}
          phase={session.phase}
          text={session.text}
          source={panel.source}
          error={session.error}
          loadingKey={panel.loadingKey}
          onRetry={session.retry}
        />
        {session.rounds.map((round, index) => (
          <div key={`${index}-${round.question}`} data-testid="followup-round" className="mt-2 border-t pt-2">
            <p className="mb-1 text-xs text-muted-foreground">{round.question}</p>
            <div
              className="text-sm"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(round.answer) }}
            />
          </div>
        ))}
        {session.asking && session.followupText ? (
          <div
            data-testid="followup-stream"
            className="mt-2 border-t pt-2 text-sm"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(session.followupText) }}
          />
        ) : null}
        {(session.phase === "done" ||
          session.phase === "stopped" ||
          session.phase === "repetition") &&
        (bridge.payload?.config?.suggestionsAvailable === true || bridge.image) ? (
          <FollowupBar
            suggestions={session.suggestions}
            busy={session.asking}
            onSubmit={session.ask}
          />
        ) : null}
      </PickerPanel>
      <span className="sr-only">{t("picker.aria.toolbar")}</span>
    </div>
  );
}




