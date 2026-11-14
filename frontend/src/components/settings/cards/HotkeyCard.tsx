/* Shortcuts card (C54–C59 / D16).
 *
 * Two recorders that are mutually exclusive: arming one sets `recording`, which
 * blocks the other, so a single keydown can never be consumed twice. Saves go
 * straight to the dedicated commands (`capture_set_hotkey` /
 * `quick_set_hotkey`) — shortcuts are not part of the settings patch, and Rust
 * normalizes/rejects them.
 *
 * C54/C57 rows: field label + static hint + recorder + "restore default".
 * C56/C59 errors are rendered inline by the recorder (never a modal/Alert).
 */
import { useCallback, useState } from "react";

import { Field } from "@/components/settings/Field";
import { SectionCard } from "@/components/settings/SectionCard";
import {
  HotkeyRecorder,
  type HotkeyTarget,
} from "@/components/settings/hotkey/HotkeyRecorder";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { useT } from "@/lib/i18n";
import { CAPTURE_FALLBACK, QUICK_FALLBACK } from "@/lib/settings/hotkeys";

export function HotkeyCard() {
  const form = useSettingsForm();
  const { t } = useT();
  const [recording, setRecording] = useState<HotkeyTarget | null>(null);

  const captureRecordingChange = useCallback((active: boolean) => {
    setRecording((current) => (active ? "capture" : current === "capture" ? null : current));
  }, []);
  const quickRecordingChange = useCallback((active: boolean) => {
    setRecording((current) => (active ? "quick" : current === "quick" ? null : current));
  }, []);

  const settings = form.settings;
  const captureValue = settings?.capture?.regionShortcut ?? "";
  const quickValue = settings?.quick?.hotkey ?? "";

  return (
    <SectionCard
      id="shortcuts"
      title={t("settings.card.shortcuts.title")}
      description={t("settings.card.shortcuts.desc")}
    >
      <div className="flex flex-col divide-y">
        <Field
          label={t("settings.field.captureHotkey")}
          hint={t("settings.hint.captureHotkey")}
        >
          <HotkeyRecorder
            target="capture"
            labelKey="settings.hotkey.captureLabel"
            value={captureValue}
            fallback={CAPTURE_FALLBACK}
            blocked={recording !== null && recording !== "capture"}
            onRecordingChange={captureRecordingChange}
            onSave={(shortcut) => form.api.setCaptureHotkey(shortcut)}
            onSaved={() => undefined}
          />
        </Field>
        <Field
          label={t("settings.field.quickHotkey")}
          hint={t("settings.hint.quickHotkey")}
        >
          <HotkeyRecorder
            target="quick"
            labelKey="settings.hotkey.quickLabel"
            value={quickValue}
            fallback={QUICK_FALLBACK}
            blocked={recording !== null && recording !== "quick"}
            onRecordingChange={quickRecordingChange}
            onSave={(shortcut) => form.api.setQuickHotkey(shortcut)}
            onSaved={() => undefined}
          />
        </Field>
      </div>
    </SectionCard>
  );
}
