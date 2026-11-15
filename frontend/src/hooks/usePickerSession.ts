/* Picker panel session (P3, Tasks 5-7).
 *
 * Turns a toolbar skill into a panel request, folds the `translate-event`
 * stream into panel state, and appends follow-up rounds on the same panel.
 * Stream semantics follow contracts.md:400: a stop keeps partial output, while
 * teardown paths abort the backend request. Follow-up rounds keep the initial
 * answer and append one {question, answer} pair per successful round
 * (contracts §7.1:408).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PickerApi } from "@/hooks/usePickerBridge";
import { useStream, type StreamEvent } from "@/hooks/useStream";
import { guardRepetition } from "@/lib/stream-guard";
import { useT } from "@/lib/i18n";
import {
  DEFAULT_SKILL_IDS,
  payloadSkills,
  type PickerImage,
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

export interface FollowupRound {
  question: string;
  answer: string;
}

interface StreamState {
  text: string;
  followup: string;
  error?: { message: string; hint?: string };
  elapsedMs?: number;
  resolvedTarget?: string;
  repetition?: boolean;
}

const EMPTY: StreamState = { text: "", followup: "" };
const OPENS_PANEL = new Set(["translate", "summarize", "explain", "polish"]);
const SEARCH_ENGINES: Record<string, string> = {
  google: "https://www.google.com/search?q=",
  baidu: "https://www.baidu.com/s?wd=",
  bing: "https://www.bing.com/search?q=",
};
const MAX_FOLLOWUPS = 10;

function makeRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PickerSessionOptions {
  api: PickerApi;
  payload: PickerPayload | null;
  image?: PickerImage | null;
  surface: PickerSurface;
}

export function usePickerSession({ api, payload, image, surface }: PickerSessionOptions) {
  const { t } = useT();
  const [panel, setPanel] = useState<PanelView | null>(null);
  const [requestId, setRequestId] = useState("");
  const [rounds, setRounds] = useState<FollowupRound[]>([]);
  const [asking, setAsking] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const panelRef = useRef<PanelView | null>(null);
  panelRef.current = panel;
  const imageRef = useRef<PickerImage | null>(null);
  imageRef.current = image ?? null;
  const modeRef = useRef<"main" | "followup">("main");
  const questionRef = useRef("");
  const roundsRef = useRef<FollowupRound[]>([]);
  roundsRef.current = rounds;

  const reduce = useCallback(
    (state: StreamState, event: StreamEvent): StreamState => {
      const view = panelRef.current;
      switch (event.type) {
        case "chunk": {
          const followup = modeRef.current === "followup";
          const next = (followup ? state.followup : state.text) + (event.text ?? "");
          const guard = guardRepetition(
            next,
            { kind: view?.skill === "translate" ? "translate" : undefined },
            view && (view.skill === "translate" || view.skill === "polish")
              ? view.source
              : undefined
          );
          if (guard.repeated) {
            return followup
              ? { ...state, followup: guard.text, repetition: true }
              : { ...state, text: guard.text, repetition: true };
          }
          return followup ? { ...state, followup: next } : { ...state, text: next };
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
    },
    [t]
  );

  const stream = useStream<StreamState>({
    requestId,
    eventName: "translate-event",
    label: surface === "toolbar" ? "picker-toolbar" : "picker",
    initial: EMPTY,
    reduce,
  });

  /* Screenshot payloads open the same panel (contracts §10.5): the shell has
   * already started the request, so this only sets the panel view/request id. */
  useEffect(() => {
    if (!image) return;
    const view: PanelView = {
      skill: image.action === "custom" ? image.skillId || "custom" : image.action,
      title: image.label || image.action,
      showLanguage: image.action === "translate",
      loadingKey:
        image.action === "ocr"
          ? "picker.loading.ocr"
          : image.action === "translate"
            ? "picker.loading.translate"
            : image.action === "explain"
              ? "picker.loading.explain"
              : "picker.loading.processing",
      requestId: image.requestId,
      targetLang: image.targetLang || "auto",
      source: "",
      pinned: false,
    };
    modeRef.current = "main";
    setRounds([]);
    setSuggestions([]);
    setAsking(false);
    setPanel(view);
    setRequestId(image.requestId);
  }, [image]);

  /* Repetition stops also cancel the backend request. */
  useEffect(() => {
    if (stream.state.repetition && requestId) void api.abortTranslate?.(requestId);
  }, [api, requestId, stream.state.repetition]);

  /* Finalize a follow-up round once its stream completes. */
  useEffect(() => {
    if (stream.status !== "done" || modeRef.current !== "followup") return;
    const answer = stream.state.followup;
    const question = questionRef.current;
    modeRef.current = "main";
    questionRef.current = "";
    setAsking(false);
    if (question && answer) {
      setRounds((current) => {
        const next = [...current, { question, answer }];
        return next.length > MAX_FOLLOWUPS ? next.slice(next.length - MAX_FOLLOWUPS) : next;
      });
    }
  }, [stream.status, stream.state.followup]);

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
      modeRef.current = "main";
      setRounds([]);
      setSuggestions([]);
      setAsking(false);
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

  const speak = useCallback((text: string) => {
    if (!text.trim()) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }, []);

  const run = useCallback(
    (skillId: string) => {
      const text = payload?.text ?? "";
      const knownBuiltin = DEFAULT_SKILL_IDS.includes(
        skillId as (typeof DEFAULT_SKILL_IDS)[number]
      );
      const opensPanel = OPENS_PANEL.has(skillId) || !knownBuiltin;
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
    setRounds([]);
    setSuggestions([]);
    setAsking(false);
    modeRef.current = "main";
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
    const current = imageRef.current;
    if (current) {
      const nextId = makeRequestId();
      setPanel({ ...view, requestId: nextId });
      setRequestId(nextId);
      void api.captureRetry?.(nextId, view.showLanguage ? view.targetLang : "");
      return;
    }
    open(view.skill, { targetLang: view.targetLang });
  }, [api, open]);

  const setTargetLang = useCallback(
    (lang: string) => {
      const view = panelRef.current;
      if (!view) return;
      if (imageRef.current) {
        const nextId = makeRequestId();
        setPanel({ ...view, targetLang: lang, requestId: nextId });
        setRequestId(nextId);
        void api.captureRetry?.(nextId, lang);
        return;
      }
      open(view.skill, { targetLang: lang });
    },
    [api, open]
  );

  /* Follow-up question on the current panel (text or capture context). */
  const ask = useCallback(
    (question: string) => {
      const view = panelRef.current;
      const trimmed = question.trim();
      if (!view || !trimmed || asking) return;
      const nextId = makeRequestId();
      modeRef.current = "followup";
      questionRef.current = trimmed;
      setAsking(true);
      setSuggestions([]);
      setRequestId(nextId);
      const history = roundsRef.current.map((round) => ({
        question: round.question,
        answer: round.answer,
      }));
      if (imageRef.current) {
        void api.captureFollowup?.(nextId, trimmed, stream.state.text, history);
      } else {
        void api.followup?.(
          nextId,
          view.source,
          stream.state.text,
          trimmed,
          history
        );
      }
    },
    [api, asking, stream.state.text]
  );

  /* Dynamic suggestions: only when the shell says the model supports them. */
  const requestSuggestions = useCallback(() => {
    const view = panelRef.current;
    if (!view || payload?.config?.suggestionsAvailable !== true) return;
    const answer = stream.state.text;
    if (!answer) return;
    const history = roundsRef.current.map((round) => ({
      question: round.question,
      answer: round.answer,
    }));
    void api.generateFollowups?.(
      makeRequestId(),
      view.skill,
      view.source,
      answer,
      history
    );
  }, [api, payload, stream.state.text]);

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

  const targetLang = panel?.showLanguage
    ? stream.state.resolvedTarget || panel.targetLang
    : panel?.targetLang ?? "";

  return {
    panel,
    phase,
    text: stream.state.text,
    followupText: stream.state.followup,
    asking,
    rounds,
    suggestions,
    error: stream.state.error,
    targetLang,
    run,
    stop,
    retry,
    close,
    pin,
    ask,
    requestSuggestions,
    setTargetLang,
    speak,
    copy: () => {
      if (panel) void api.copy?.(stream.state.text);
    },
  };
}
