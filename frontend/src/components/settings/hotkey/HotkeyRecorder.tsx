/* Global shortcut recorder (C54–C59, assertions 32–33).
 *
 * The recorder MUST listen in the capture phase on `window`: React/Radix
 * handlers run on the bubble phase and would both miss combinations pressed
 * while focus sits on `body` and let the page react to the keys. The listener
 * therefore does `preventDefault()` + `stopPropagation()` before anything else
 * (after the IME guard), exactly like `web/settings.js:1754-1794`.
 *
 * State machine: idle → recording → saving → idle. Only one recorder may be
 * recording at a time (`blocked` from the card) and a save in flight cannot be
 * re-entered (`savingRef`), so a held key cannot double-submit.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { useT } from "@/lib/i18n";
import {
  comboFromEvent,
  comboIssue,
  formatShortcut,
  isModifierKey,
  resolveShortcut,
} from "@/lib/settings/hotkeys";

export type HotkeyTarget = "capture" | "quick";

export interface HotkeySaveResult {
  ok: boolean;
  shortcut?: string;
  error?: string;
  hint?: string;
}

export interface HotkeyRecorderProps {
  target: HotkeyTarget;
  /** Localized field label used by the state-dependent aria labels. */
  labelKey: string;
  /** Current settings value; empty means "not set yet" → `fallback`. */
  value: string;
  fallback: string;
  /** The other recorder is recording → this one cannot arm. */
  blocked: boolean;
  onRecordingChange: (recording: boolean) => void;
  onSave: (shortcut: string) => Promise<HotkeySaveResult>;
  /** Successful sanitized value, so the display is deterministic before the
   * backend `state-changed` broadcast arrives. */
  onSaved: (shortcut: string) => void;
}

/** Localized-or-raw inline failure: keys re-translate, backend text is verbatim. */
interface Failure {
  messageKey?: string;
  message?: string;
  hintKey?: string;
  hint?: string;
}

const UNSUPPORTED_KEY: Failure = {
  messageKey: "settings.error.hotkeyUnsupportedKey",
  hintKey: "settings.hint.hotkeySupportedKeys",
};

const MODIFIER_REQUIRED: Failure = {
  messageKey: "settings.error.hotkeyModifierRequired",
  hintKey: "settings.hint.hotkeyModifierRequired",
};

export function HotkeyRecorder({
  target,
  labelKey,
  value,
  fallback,
  blocked,
  onRecordingChange,
  onSave,
  onSaved,
}: HotkeyRecorderProps) {
  const { t } = useT();
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  /* Locally saved value wins until the backend broadcast (or an external
   * reset) changes the `value` prop. */
  const [saved, setSaved] = useState<string | null>(null);

  /* Latest props/`t` for the stable native listener: a language switch or a
   * parent re-render must not re-register the capture listener mid-recording. */
  const current = useRef({ target, onRecordingChange, onSave, onSaved, t });
  current.current = { target, onRecordingChange, onSave, onSaved, t };

  const recordingRef = useRef(false);
  const savingRef = useRef(false);

  /* Adopt an externally changed value (settings reset / another window). */
  useEffect(() => {
    setSaved(null);
  }, [value]);

  const shortcut = saved ?? resolveShortcut(value, fallback);
  const display = formatShortcut(shortcut);

  const stopRecording = useCallback(() => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    current.current.onRecordingChange(false);
  }, []);

  /* Esc, window blur and a second click on the button: no save, error cleared. */
  const cancelRecording = useCallback(() => {
    setFailure(null);
    stopRecording();
  }, [stopRecording]);

  const commit = useCallback(async (next: string) => {
    if (savingRef.current) return;
    savingRef.current = true;
    recordingRef.current = false;
    setRecording(false);
    current.current.onRecordingChange(false);
    setSaving(true);
    setFailure(null);
    let result: HotkeySaveResult;
    try {
      result = await current.current.onSave(next);
    } catch (error) {
      result = { ok: false, error: String(error) };
    }
    savingRef.current = false;
    setSaving(false);
    if (result.ok) {
      const stored = String(result.shortcut ?? next).trim() || next;
      setSaved(stored);
      current.current.onSaved(stored);
      toast({
        description: current.current.t(
          current.current.target === "quick"
            ? "settings.toast.quickHotkeySaved"
            : "settings.toast.hotkeySaved"
        ),
        tone: "success",
      });
      return;
    }
    /* C59: keep the previous value, show the backend message (or the generic
     * copy) plus its hint. */
    setFailure({
      message: result.error,
      messageKey: result.error ? undefined : "settings.error.hotkeySave",
      hint: result.hint,
    });
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!recordingRef.current) return;
      if (event.isComposing) return;
      /* Swallow before the repeat check so a held key never reaches the page. */
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (event.key === "Escape" || event.key === "Esc") {
        cancelRecording();
        return;
      }
      if (isModifierKey(event.key)) {
        /* Only modifiers so far: keep waiting, no error. */
        return;
      }
      const combo = comboFromEvent(event);
      if (!combo) {
        setFailure(comboIssue(event) === "unsupported-key" ? UNSUPPORTED_KEY : MODIFIER_REQUIRED);
        return;
      }
      void commit(combo);
    },
    [cancelRecording, commit]
  );

  /* The capture-phase listener lives for exactly as long as `recording`. */
  const handlerRef = useRef(handleKeyDown);
  handlerRef.current = handleKeyDown;

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => handlerRef.current(event);
    const onWindowBlur = () => cancelRecording();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [cancelRecording, recording]);

  const startRecording = () => {
    if (blocked || savingRef.current || recordingRef.current) return;
    setFailure(null);
    recordingRef.current = true;
    setRecording(true);
    current.current.onRecordingChange(true);
  };

  const restoreDefault = () => {
    if (recordingRef.current || savingRef.current) return;
    void commit(fallback);
  };

  const label = t(labelKey);
  const ariaLabel = recording
    ? t("settings.hotkey.recordingAriaWithLabel", { label })
    : saving
      ? t("settings.hotkey.savingAriaWithLabel", { label })
      : t("settings.hotkey.currentAriaWithLabel", { label, shortcut: display });
  /* Legacy titles: the recording hint while armed, the action hint otherwise. */
  const title = recording
    ? t("settings.hotkey.recordingTitle")
    : saving
      ? undefined
      : t(
          target === "quick"
            ? "settings.action.quickHotkeyTitle"
            : "settings.action.captureHotkeyTitle"
        );
  const shown = saving
    ? t("settings.hotkey.saving")
    : recording
      ? t("settings.hotkey.recording")
      : display;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-target={target}
          data-recording={recording ? "true" : "false"}
          disabled={blocked || saving}
          aria-label={ariaLabel}
          title={title}
          onClick={recording ? cancelRecording : startRecording}
        >
          <span data-testid="hotkey-value">{shown}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={recording || saving}
          aria-label={t("settings.hotkey.restoreAriaWithValue", {
            shortcut: formatShortcut(fallback),
          })}
          onClick={restoreDefault}
        >
          {t("settings.action.restoreDefault")}
        </Button>
      </div>
      {failure ? (
        <>
          <p role="alert" className="text-xs font-medium text-destructive">
            {failure.messageKey ? t(failure.messageKey) : failure.message}
          </p>
          {failure.hintKey || failure.hint ? (
            <p className="text-xs text-muted-foreground">
              {failure.hintKey ? t(failure.hintKey) : failure.hint}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
