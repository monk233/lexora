/* Picker window root (P3).
 *
 * Both surfaces share one entry. The toolbar surface renders the capsule and
 * delegates panel-opening skills to the shell (`picker_toolbar_run_skill`); the
 * panel surface shows the capsule first and swaps to the result panel once a
 * skill starts, which is the legacy single-window behaviour (contracts §7.1).
 */
import { useEffect, useMemo, useState } from "react";

import { PickerMenu } from "@/components/picker/PickerMenu";
import { PickerPanel } from "@/components/picker/PickerPanel";
import { PickerToolbar } from "@/components/picker/PickerToolbar";
import { PanelBody } from "@/components/picker/PanelBody";
import { usePickerBridge, type PickerApi } from "@/hooks/usePickerBridge";
import { usePickerSession } from "@/hooks/usePickerSession";
import { useT } from "@/lib/i18n";
import { payloadSkills, type PickerSkill, type PickerSurface } from "@/lib/picker/model";

export interface PickerWindowProps {
  surface?: PickerSurface;
  api?: PickerApi;
}

export function PickerWindow({ surface, api }: PickerWindowProps = {}) {
  const bridge = usePickerBridge({ surface, api });
  const session = usePickerSession({
    api: bridge.api,
    payload: bridge.payload,
    image: bridge.image,
    surface: bridge.surface,
  });
  const { t } = useT();
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
      </PickerPanel>
      <span className="sr-only">{t("picker.aria.toolbar")}</span>
    </div>
  );
}

