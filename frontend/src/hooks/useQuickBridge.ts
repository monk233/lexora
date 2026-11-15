/* Quick-translate bridge (P4).
 *
 * Wires `quickAPI`: initial `quick_ready` (locale + config), `quick-show`
 * refreshes the config, `quick-locale` switches the interface language, and
 * `translate-event` carries the per-request stream.
 */
import { useEffect, useRef, useState } from "react";

import { quickAPI } from "@/lib/tauri-api.js";
import type { QuickConfig, QuickLocale, QuickReadyResult } from "@/lib/quick/model";

export interface QuickApi {
  ready(): Promise<QuickReadyResult>;
  open?(): Promise<unknown>;
  hide?(): Promise<unknown>;
  pin?(pinned: boolean): Promise<unknown>;
  setHotkey?(shortcut: string): Promise<unknown>;
  setTargetLang?(targetLang: string): Promise<unknown>;
  setSourceLang?(sourceLang: string): Promise<unknown>;
  translate?(
    requestId: string,
    text: string,
    targetLang: string,
    sourceLang: string
  ): Promise<unknown>;
  abortTranslate?(requestId: string): Promise<unknown>;
  onTranslateEvent?(callback: (event: unknown) => void, requestId?: string): () => void;
  onShow?(callback: () => void): () => void;
  onLocale?(callback: (payload: { locale?: string }) => void): () => void;
  historyList?(): Promise<unknown>;
  historyDelete?(id: string): Promise<unknown>;
  historyClear?(): Promise<unknown>;
  copy?(text: string): Promise<unknown>;
  openSettings?(): Promise<unknown>;
  resize?(width: number, height: number): Promise<unknown>;
  dragPanel?(dx: number, dy: number): Promise<unknown>;
  start?(presetSkillId: string): Promise<unknown>;
  [command: string]: unknown;
}

export interface QuickBridge {
  api: QuickApi;
  locale: QuickLocale | null;
  config: QuickConfig;
  ready: boolean;
}

const QUICK_WINDOW_LABEL = "quicktranslate";

export function useQuickBridge(options: { api?: QuickApi } = {}): QuickBridge {
  const api = (options.api ?? quickAPI) as unknown as QuickApi;
  const [locale, setLocale] = useState<QuickLocale | null>(null);
  const [config, setConfig] = useState<QuickConfig>({});
  const [ready, setReady] = useState(false);
  const readyOnce = useRef(false);

  useEffect(() => {
    const offShow = api.onShow?.(() => {
      void api.ready?.().then((result) => {
        if (!result) return;
        if (result.locale) setLocale(result.locale);
        if (result.config) setConfig(result.config);
      });
    });
    const offLocale = api.onLocale?.((payload) => {
      const next = payload?.locale === "en" ? "en" : payload?.locale === "zh" ? "zh" : null;
      if (next) setLocale(next);
    });
    if (!readyOnce.current) {
      readyOnce.current = true;
      void api.ready?.().then((result) => {
        if (!result) return;
        if (result.locale) setLocale(result.locale);
        if (result.config) setConfig(result.config);
        setReady(true);
      });
    }
    return () => {
      offShow?.();
      offLocale?.();
    };
  }, [api]);

  return { api, locale, config, ready };
}

export { QUICK_WINDOW_LABEL };
