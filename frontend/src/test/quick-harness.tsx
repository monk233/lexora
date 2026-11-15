/* Quick-translate test harness (P4). */
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

import type { QuickApi } from "@/hooks/useQuickBridge";

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export interface FakeQuickApi extends QuickApi {
  calls: RecordedCall[];
  emitTranslateEvent(event: unknown): void;
  emitShow(): void;
  emitLocale(locale: string): void;
}

const ok = () => ({ ok: true });
const INITIAL_HISTORY = [
  { id: "h1", source: "hello", target: "你好", sourceLang: "en", targetLang: "zh" },
  { id: "h2", source: "world", target: "世界", sourceLang: "en", targetLang: "zh" },
];

export function createFakeQuickApi(
  options: { ready?: unknown; history?: unknown[] } = {}
): FakeQuickApi {
  const calls: RecordedCall[] = [];
  const eventListeners: ((event: unknown) => void)[] = [];
  const showListeners: (() => void)[] = [];
  const localeListeners: ((payload: { locale?: string }) => void)[] = [];
  let history: { id: string }[] = [...(options.history ?? INITIAL_HISTORY)] as { id: string }[];

  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
  };

  const api = {
    calls,
    ready: async () => {
      record("ready");
      return (
        options.ready ?? {
          ok: true,
          locale: "zh",
          config: { sourceLang: "auto", targetLang: "zh", pinned: false },
        }
      );
    },
    open: async () => {
      record("open");
      return ok();
    },
    hide: async () => {
      record("hide");
      return ok();
    },
    pin: async (pinned: boolean) => {
      record("pin", pinned);
      return ok();
    },
    setHotkey: async (shortcut: string) => {
      record("setHotkey", shortcut);
      return ok();
    },
    setTargetLang: async (lang: string) => {
      record("setTargetLang", lang);
      return ok();
    },
    setSourceLang: async (lang: string) => {
      record("setSourceLang", lang);
      return ok();
    },
    translate: async (
      requestId: string,
      text: string,
      targetLang: string,
      sourceLang: string
    ) => {
      record("translate", requestId, text, targetLang, sourceLang);
      return ok();
    },
    abortTranslate: async (requestId: string) => {
      record("abortTranslate", requestId);
      return ok();
    },
    onTranslateEvent: (callback: (event: unknown) => void) => {
      eventListeners.push(callback);
      return () => {
        const index = eventListeners.indexOf(callback);
        if (index >= 0) eventListeners.splice(index, 1);
      };
    },
    onShow: (callback: () => void) => {
      showListeners.push(callback);
      return () => {
        const index = showListeners.indexOf(callback);
        if (index >= 0) showListeners.splice(index, 1);
      };
    },
    onLocale: (callback: (payload: { locale?: string }) => void) => {
      localeListeners.push(callback);
      return () => {
        const index = localeListeners.indexOf(callback);
        if (index >= 0) localeListeners.splice(index, 1);
      };
    },
    historyList: async () => {
      record("historyList");
      return { ok: true, entries: history };
    },
    historyDelete: async (id: string) => {
      record("historyDelete", id);
      history = history.filter((entry) => entry.id !== id);
      return ok();
    },
    historyClear: async () => {
      record("historyClear");
      history = [];
      return ok();
    },
    copy: async (text: string) => {
      record("copy", text);
      return ok();
    },
    openSettings: async () => {
      record("openSettings");
      return ok();
    },
    resize: async (width: number, height: number) => {
      record("resize", width, height);
      return ok();
    },
    dragPanel: async (dx: number, dy: number) => {
      record("dragPanel", dx, dy);
      return ok();
    },
    start: async (skill: string) => {
      record("start", skill);
      return ok();
    },

    emitTranslateEvent(event: unknown) {
      for (const listener of [...eventListeners]) listener(event);
    },
    emitShow() {
      for (const listener of [...showListeners]) listener();
    },
    emitLocale(locale: string) {
      for (const listener of [...localeListeners]) listener({ locale });
    },
  };

  return api as unknown as FakeQuickApi;
}

export function renderQuick(ui: ReactElement): RenderResult {
  return render(ui);
}

