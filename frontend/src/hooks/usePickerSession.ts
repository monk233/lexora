/* Picker panel session (P3, Task 5).
 *
 * Turns a toolbar skill into a panel request and folds the `translate-event`
 * stream into panel state. Stream semantics follow contracts.md:400: a stop
 * keeps the partial output (useStream.stop), while teardown paths (skill
 * switch, close, hidden, image payload) abort the backend request.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PickerApi } from "@/hooks/usePickerBridge";
import { useStream, type StreamEvent } from "@/hooks/useStream";
import { guardRepetition } from "@/lib/stream-guard";
import { useT } from "@/lib/i18n";
import {
  DEFAULT_SKILL_IDS,
  payloadSkills,
  type PickerPayload,
  type PickerSurface,
} from "@/lib/picker/model";

export type PanelPhase =
  | "loading"
  | "streaming"
  | "done"
  | "error"
  | "stopped"
  | "repetition";

export interface PanelView {
  skill: string;
  title: string;
  showLanguage: boolean;
  loadingKey: string;
  requestId: string;
  targetLang: string;
  source: string;
  pinned: boolean;
}

interface StreamState {
  text: string;
  error?: { message: string; hint?: string };
  elapsedMs?: number;
  resolvedTarget?: string;
  repetition?: boolean;
}

const EMPTY: StreamState = { text: "" };
const OPENS_PANEL = new Set(["translate", "summarize", "explain", "polish"]);
const SEARCH_ENGINES: Record<string, string> = {
  google: "https://www.google.com/search?q=",
  baidu: "https://www.baidu.com/s?wd=",
  bing: "https://www.bing.com/search?q=",
};

function makeRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PickerSessionOptions {
  api: PickerApi;
  payload: PickerPayload | null;
  surface: PickerSurface;
}

export function usePickerSession({ api, payload, surface }: PickerSessionOptions) {
  const { t, locale } = useT();
  const [panel, setPanel] = useState<PanelView | null>(null);
  const [requestId, setRequestId] = useState("");
  const panelRef = useRef<PanelView | null>(null);
  panelRef.current = panel;

  const reduce = useCallback((state: StreamState, event: StreamEvent): StreamState => {
    switch (event.type) {
      case "chunk": {
        const next = state.text + (event.text ?? "");
        const view = panelRef.current;
        const guard = guardRepetition(
          next,
          { kind: view?.skill === "translate" ? "translate" : undefined },
          view && (view.skill === "translate" || view.skill === "polish") ? view.source : undefined
        );
        if (guard.repeated) return { ...state, text: guard.text, repetition: true };
        return { ...state, text: next };
      }
      case "target":
        return { ...state, resolvedTarget: event.targetLang };
      case "error":
        return {
          ...state,
          error: {
            message: event.message || t("picker.error.unknown"),
            hint: event.hint,
          },
        };
      case "done":
        return { ...state, elapsedMs: event.elapsedMs };
      default:
        return state;
    }
  }, [t]);

  const stream = useStream<StreamState>({
    requestId,
    eventName: "translate-event",
    label: surface === "toolbar" ? "picker-toolbar" : "picker",
    initial: EMPTY,
    reduce,
  });

  /* A repetition stop also cancels the backend request. */
  useEffect(() => {
    if (stream.state.repetition && requestId) void api.abortTranslate?.(requestId);
  }, [api, requestId, stream.state.repetition]);

  const titleFor = useCallback(
    (skillId: string): string => {
      const custom = payloadSkills(payload).find((skill) => skill.id === skillId);
      if (custom?.label) return custom.label;
      const key = `skill.${skillId}`;
      const text = t(key);
      return text === key ? skillId : text;
    },
    [payload, t]
  );

  const send = useCallback(
    (view: PanelView) => {
      switch (view.skill) {
        case "translate":
          void api.translate?.(view.requestId, view.source, view.targetLang);
          break;
        case "summarize":
        case "explain":
          void api.assist?.(view.requestId, view.skill, view.source);
          break;
        case "polish":
          void api.polish?.(view.requestId, view.source);
          break;
        default:
          void api.customSkill?.(
            view.requestId,
            view.skill,
            view.source,
            payload?.programName ?? ""
          );
          break;
      }
    },
    [api, payload]
  );

  const open = useCallback(
    (skillId: string, overrides: Partial<PanelView> = {}) => {
      const nextId = makeRequestId();
      const view: PanelView = {
        skill: skillId,
        title: titleFor(skillId),
        showLanguage: skillId === "translate",
        loadingKey:
          skillId === "translate"
            ? "picker.loading.translate"
            : skillId === "summarize"
              ? "picker.loading.summarize"
              : skillId === "explain"
                ? "picker.loading.explain"
                : skillId === "polish"
                  ? "picker.loading.polish"
                  : "picker.loading.processing",
        requestId: nextId,
        targetLang: String(payload?.config?.defaultTargetLang || "auto"),
        source: payload?.text ?? "",
        pinned: false,
        ...overrides,
      };
      setPanel(view);
      setRequestId(nextId);
      send(view);
    },
    [payload, send, titleFor]
  );

  const speak = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    },
    []
  );

  const run = useCallback(
    (skillId: string) => {
      const text = payload?.text ?? "";
      const opensPanel = OPENS_PANEL.has(skillId) || !DEFAULT_SKILL_IDS.includes(
        skillId as (typeof DEFAULT_SKILL_IDS)[number]
      );
      if (surface === "toolbar" && opensPanel) {
        void api.runToolbarSkill?.(skillId);
        return;
      }
      switch (skillId) {
        case "translate":
        case "summarize":
        case "explain":
        case "polish":
          open(skillId);
          return;
        case "read":
          speak(text);
          return;
        case "copy":
          void api.copy?.(text);
          return;
        case "search": {
          const engine = String(payload?.config?.searchEngine || "google");
          const base = SEARCH_ENGINES[engine] || SEARCH_ENGINES.google;
          if (text.trim()) void api.openExternal?.(base + encodeURIComponent(text));
          return;
        }
        case "screenshot":
          void api.runToolbarSkill?.("screenshot");
          return;
        default:
          open(skillId);
      }
    },
    [api, open, payload, speak, surface]
  );

  const close = useCallback(() => {
    const view = panelRef.current;
    if (view) void api.abortTranslate?.(view.requestId);
    stream.abort();
    setPanel(null);
    setRequestId("");
    void api.close?.();
  }, [api, stream]);

  const stop = useCallback(() => {
    const view = panelRef.current;
    stream.stop();
    if (view) void api.abortTranslate?.(view.requestId);
  }, [api, stream]);

  const retry = useCallback(() => {
    const view = panelRef.current;
    if (!view) return;
    open(view.skill, { targetLang: view.targetLang });
  }, [open]);

  const setTargetLang = useCallback(
    (lang: string) => {
      const view = panelRef.current;
      if (!view) return;
      open(view.skill, { targetLang: lang });
    },
    [open]
  );

  const pin = useCallback(
    (pinned: boolean) => {
      setPanel((current) => (current ? { ...current, pinned } : current));
      void api.pin?.(pinned, true);
    },
    [api]
  );

  const phase: PanelPhase = useMemo(() => {
    if (stream.state.repetition) return "repetition";
    if (stream.status === "stopped") return "stopped";
    if (stream.status === "error") return "error";
    if (stream.status === "done") return "done";
    if (stream.status === "streaming") return "streaming";
    return "loading";
  }, [stream.state.repetition, stream.status]);

  /* Keep the resolved image-translate target visible in the selector. */
  const targetLang = panel?.showLanguage
    ? stream.state.resolvedTarget || panel.targetLang
    : panel?.targetLang ?? "";

  return {
    locale,
    panel,
    phase,
    text: stream.state.text,
    error: stream.state.error,
    targetLang,
    run,
    stop,
    retry,
    close,
    pin,
    setTargetLang,
    speak,
    copy: () => {
      if (panel) void api.copy?.(stream.state.text);
    },
  };
}
