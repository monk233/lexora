/* Settings draft store: optimistic state, serial save queue and autosave
 * semantics (inventory §4, C01).
 *
 * The provider is the single source of truth for the settings window:
 *   - `get_state` on mount, with the legacy "state not managed" retry;
 *   - `state-changed` / `toast` subscriptions (cleanup on unmount);
 *   - `save(patch)` = optimistic deepMerge + enqueue, never concurrent IPC;
 *   - text fields via `useSettingsTextField` (500ms debounce, blur / Enter /
 *     window-blur / visibilitychange flush, IME composition pauses flushing).
 *
 * Uncommitted drafts live outside `state`, so a `state-changed` payload can
 * never wipe typed-but-not-yet-saved text.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { toast } from "@/components/ui/use-toast";
import { deepMerge, type PlainObject } from "@/lib/constants";
import { normalizeLocale, translate } from "@/lib/i18n";
import { settingsApi, type SettingsApi } from "@/lib/settings/api";
import { createSaveQueue, type FlushResult, type SaveQueue } from "@/lib/settings/save-queue";
import type {
  GetStateResult,
  Locale,
  SaveStatus,
  Settings,
  SettingsPatch,
  StatePayload,
} from "@/lib/settings/types";

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_RETRY_DELAYS: number[] = [100, 250, 500];
const MANAGED_STATE_ERROR = /state not managed/i;

export interface TextFieldConfig {
  /** Stable field id; also used to discard/clear the draft. */
  id: string;
  /** Server-side current value. */
  value: string;
  /** The owning component trims/normalizes before building the patch. */
  build: (value: string) => SettingsPatch;
  /** true: Ctrl/Cmd+Enter flushes (textarea); false: Enter flushes (input). */
  multiline?: boolean;
  /** Defaults to the provider's `debounceMs` (500ms). */
  debounceMs?: number;
}

export interface TextFieldBinding {
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onBlur: () => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
}

export interface SettingsFormApi {
  state: StatePayload | null;
  settings: Settings | null;
  status: SaveStatus;
  loadError: string | null;
  save(patch: SettingsPatch): void;
  flushSaveQueue(): Promise<FlushResult>;
  /** Replace the whole state with a command result (`reset_settings`). */
  applyState(next: StatePayload): void;
  refresh(): Promise<GetStateResult>;
}

interface DraftEntry {
  value: string;
  timer: ReturnType<typeof setTimeout> | null;
  build: (value: string) => SettingsPatch;
  /** Last value handed to `save`, so a duplicate blur/Enter cannot re-send it. */
  lastSent: string | null;
}

interface SettingsFormContextValue extends SettingsFormApi {
  debounceMs: number;
  /** Bumped on every draft mutation so context consumers re-render. */
  draftTick: number;
  readDraft(id: string): string | undefined;
  writeDraft(
    id: string,
    value: string,
    build: (value: string) => SettingsPatch,
    debounceMs: number
  ): void;
  flushDraft(id: string): void;
  flushAllDrafts(): void;
  focusField(id: string): void;
  blurField(id: string): void;
  startComposition(id: string): void;
  endComposition(
    id: string,
    build: (value: string) => SettingsPatch,
    debounceMs: number
  ): void;
}

const INITIAL_STATUS: SaveStatus = { kind: "idle", message: "" };

const SettingsFormContext = createContext<SettingsFormContextValue | null>(null);

function currentLocale(): Locale {
  if (typeof document === "undefined") return "en";
  return normalizeLocale(document.documentElement.lang || "en");
}

export function SettingsFormProvider(props: {
  children: ReactNode;
  api?: SettingsApi;
  debounceMs?: number;
  retryDelays?: number[];
  /** Locale for save-failure copy; Task 3 passes `useT().locale`. Falls back to
   * `document.documentElement.lang` so the provider stays standalone. */
  locale?: Locale;
}): JSX.Element {
  const { children, debounceMs = DEFAULT_DEBOUNCE_MS, retryDelays = DEFAULT_RETRY_DELAYS } = props;

  /* The injected API is captured once: the window owns one bridge instance for
   * its whole lifetime, exactly like `API` in the legacy page. */
  const apiRef = useRef<SettingsApi>(props.api ?? settingsApi);
  /* Read once: a caller passing a fresh array literal must not re-trigger the
   * initial load on every render. */
  const retryDelaysRef = useRef<number[]>(retryDelays);

  const [state, setState] = useState<StatePayload | null>(null);
  const [status, setStatus] = useState<SaveStatus>(INITIAL_STATUS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftTick, setDraftTick] = useState(0);

  const stateRef = useRef<StatePayload | null>(null);
  const draftsRef = useRef<Map<string, DraftEntry>>(new Map());
  const composingRef = useRef<Set<string>>(new Set());
  const focusedRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<SaveQueue | null>(null);

  /* Read through a ref: the queue is created once, but the locale prop may
   * change when the user switches language. When the shell mounts this provider
   * above `I18nProvider` it passes no prop, so the *current* document language
   * is resolved at failure time (the i18n layer keeps `<html lang>` in sync). */
  const localePropRef = useRef<Locale | undefined>(props.locale);
  localePropRef.current = props.locale;
  const resolveLocale = useCallback((): Locale => localePropRef.current ?? currentLocale(), []);

  const commitState = useCallback((next: StatePayload | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const notifyDrafts = useCallback(() => {
    setDraftTick((tick) => tick + 1);
  }, []);

  const refresh = useCallback(async (): Promise<GetStateResult> => {
    const result = await apiRef.current.getState();
    if (result.ok && result.state) commitState(result.state);
    return result;
  }, [commitState]);

  const handleFailure = useCallback(
    async (error: string): Promise<void> => {
      toast({
        description: translate(resolveLocale(), "settings.error.saveFailed", { error }),
        tone: "error",
      });
      /* Roll the optimistic value back to the backend state (inventory §4.7).
       * The queue awaits this promise, so the stale snapshot can never land
       * after a newer patch's response. */
      await refresh();
    },
    [refresh, resolveLocale]
  );

  if (queueRef.current === null) {
    queueRef.current = createSaveQueue({
      send: (patch) => apiRef.current.updateSettings(patch),
      onStatus: setStatus,
      onSaved: commitState,
      onFailure: handleFailure,
      /* M1: no hardcoded copy in the queue; the hook injects localized text. */
      get failureMessage() {
        return translate(resolveLocale(), "settings.error.unknown");
      },
    });
  }

  const save = useCallback(
    (patch: SettingsPatch) => {
      const current = stateRef.current;
      if (current) {
        commitState({
          ...current,
          settings: deepMerge(
            current.settings as unknown as PlainObject,
            patch as PlainObject
          ) as unknown as Settings,
        });
      }
      queueRef.current?.enqueue(patch);
    },
    [commitState]
  );

  const flushDraft = useCallback(
    (id: string) => {
      const entry = draftsRef.current.get(id);
      if (!entry || composingRef.current.has(id)) return;
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      const value = entry.value;
      const sent = entry.lastSent !== value;
      if (sent) {
        entry.lastSent = value;
        save(entry.build(value));
      }
      void queueRef.current?.flush().then((result) => {
        const current = draftsRef.current.get(id);
        /* Only clean up when the user has not typed past the saved value. */
        if (!current || current.value !== value) return;
        if (!result.ok) {
          /* Failed saves keep the user's text so it can be retried
           * (inventory §4.9): drop the dedupe marker so a retry re-sends. */
          if (sent) current.lastSent = null;
          return;
        }
        /* A save that settles mid-IME (or while the field is focused) must not
         * swap the visible value for the server's normalized copy. The next
         * blur / compositionend flush performs the cleanup. */
        if (composingRef.current.has(id) || focusedRef.current.has(id)) return;
        draftsRef.current.delete(id);
        notifyDrafts();
      });
    },
    [notifyDrafts, save]
  );

  const flushAllDrafts = useCallback(() => {
    for (const id of Array.from(draftsRef.current.keys())) flushDraft(id);
  }, [flushDraft]);

  const focusField = useCallback((id: string) => {
    focusedRef.current.add(id);
  }, []);

  const blurField = useCallback((id: string) => {
    focusedRef.current.delete(id);
  }, []);

  const writeDraft = useCallback(
    (
      id: string,
      value: string,
      build: (value: string) => SettingsPatch,
      fieldDebounceMs: number
    ) => {
      let entry = draftsRef.current.get(id);
      if (!entry) {
        entry = { value, timer: null, build, lastSent: null };
        draftsRef.current.set(id, entry);
      } else {
        entry.value = value;
        entry.build = build;
      }
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (!composingRef.current.has(id)) {
        const target = entry;
        target.timer = setTimeout(() => {
          target.timer = null;
          flushDraft(id);
        }, fieldDebounceMs);
      }
      notifyDrafts();
    },
    [flushDraft, notifyDrafts]
  );

  const startComposition = useCallback((id: string) => {
    composingRef.current.add(id);
  }, []);

  const endComposition = useCallback(
    (id: string, build: (value: string) => SettingsPatch, fieldDebounceMs: number) => {
      composingRef.current.delete(id);
      const entry = draftsRef.current.get(id);
      if (entry) writeDraft(id, entry.value, build, fieldDebounceMs);
    },
    [writeDraft]
  );

  const flushSaveQueue = useCallback(async (): Promise<FlushResult> => {
    flushAllDrafts();
    return queueRef.current ? queueRef.current.flush() : { ok: true };
  }, [flushAllDrafts]);

  /* Initial load with the bounded "state not managed" retry (inventory D1).
   * A render-layer toast owns the user-visible read error (Task 3 shell). */
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const api = apiRef.current;
      const delays = retryDelaysRef.current;
      let result = await api.getState();
      for (let attempt = 0; attempt < delays.length; attempt += 1) {
        if (cancelled) return;
        if (result.ok || !MANAGED_STATE_ERROR.test(result.error ?? "")) break;
        const delay = delays[attempt] ?? 0;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delay);
        });
        if (cancelled) return;
        result = await api.getState();
      }
      if (cancelled) return;
      if (result.ok && result.state) {
        setLoadError(null);
        commitState(result.state);
      } else {
        setLoadError(result.error ?? "unknown error");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [commitState]);

  /* Live state + backend toasts; both disposers run on unmount. */
  useEffect(() => {
    const api = apiRef.current;
    const offState = api.onState((next) => {
      commitState(next);
    });
    const offToast = api.onToast((payload) => {
      toast({
        description: payload.message,
        tone: payload.type,
      });
    });
    return () => {
      offState();
      offToast();
    };
  }, [commitState]);

  /* Flush-all triggers (inventory §4.4). Registration order matters in the
   * legacy page because the recorder cancels first; this hook owns no recorder,
   * so the flush listeners stand alone. */
  useEffect(() => {
    const onWindowBlur = () => flushAllDrafts();
    const onVisibilityChange = () => {
      if (document.hidden) flushAllDrafts();
    };
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [flushAllDrafts]);

  /* Drop pending debounce timers on unmount so a closing window cannot fire a
   * late save. The queue itself is window-scoped and stays usable. */
  useEffect(() => {
    const drafts = draftsRef.current;
    return () => {
      for (const entry of drafts.values()) {
        if (entry.timer !== null) clearTimeout(entry.timer);
      }
      drafts.clear();
    };
  }, []);

  const readDraft = useCallback((id: string): string | undefined => {
    return draftsRef.current.get(id)?.value;
  }, []);

  const settings = state?.settings ?? null;

  const value = useMemo<SettingsFormContextValue>(
    () => ({
      state,
      settings,
      status,
      loadError,
      save,
      flushSaveQueue,
      applyState: commitState,
      refresh,
      debounceMs,
      draftTick,
      readDraft,
      writeDraft,
      flushDraft,
      flushAllDrafts,
      focusField,
      blurField,
      startComposition,
      endComposition,
    }),
    [
      state,
      settings,
      status,
      loadError,
      save,
      flushSaveQueue,
      commitState,
      refresh,
      debounceMs,
      draftTick,
      readDraft,
      writeDraft,
      flushDraft,
      flushAllDrafts,
      focusField,
      blurField,
      startComposition,
      endComposition,
    ]
  );

  return <SettingsFormContext.Provider value={value}>{children}</SettingsFormContext.Provider>;
}

function useSettingsFormContext(): SettingsFormContextValue {
  const value = useContext(SettingsFormContext);
  if (!value) throw new Error("useSettingsForm must be used inside SettingsFormProvider");
  return value;
}

export function useSettingsForm(): SettingsFormApi {
  return useSettingsFormContext();
}

export function useSettingsTextField(config: TextFieldConfig): TextFieldBinding {
  const form = useSettingsFormContext();
  const fieldDebounceMs = config.debounceMs ?? form.debounceMs;
  const draft = form.readDraft(config.id);
  const build = config.build;

  return {
    value: draft ?? config.value,
    onChange: (event) => {
      form.writeDraft(config.id, event.target.value, build, fieldDebounceMs);
    },
    onBlur: () => {
      form.blurField(config.id);
      form.flushDraft(config.id);
    },
    onFocus: () => {
      form.focusField(config.id);
    },
    onKeyDown: (event) => {
      const isEnter = event.key === "Enter";
      const shouldFlush = config.multiline
        ? isEnter && (event.ctrlKey || event.metaKey)
        : isEnter;
      if (!shouldFlush) return;
      event.preventDefault();
      form.flushDraft(config.id);
      event.currentTarget.blur();
    },
    onCompositionStart: () => {
      form.startComposition(config.id);
    },
    onCompositionEnd: () => {
      form.endComposition(config.id, build, fieldDebounceMs);
    },
  };
}
