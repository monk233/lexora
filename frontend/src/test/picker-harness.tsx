/* Picker test harness (P3).
 *
 * A fake `pickerAPI` that records commands and lets tests push events, plus a
 * renderer that wraps the component in the real i18n provider. Mirrors the
 * settings harness so card tests read the same way.
 */
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

import type { PickerApi } from "@/hooks/usePickerBridge";
import { I18nProvider, type Locale } from "@/lib/i18n";

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export interface FakePickerApi extends PickerApi {
  calls: RecordedCall[];
  live: boolean;
  surface: string;
  emitData(payload: unknown): void;
  emitHidden(): void;
  emitImage(image: unknown): void;
  emitTranslateEvent(event: unknown): void;
  emitRunSkill(skillId: unknown): void;
}

type Listener = (payload: unknown) => void;

interface ListenerSets {
  data: Listener[];
  hidden: Listener[];
  image: Listener[];
  translate: Listener[];
  runSkill: Listener[];
}

export interface FakePickerOptions {
  translate?: (requestId: string, text: string, targetLang: string) => unknown;
  followup?: (requestId: string, question: string) => unknown;
  generateFollowups?: () => unknown;
  resize?: (width: number, height: number) => unknown;
}

const ok = () => ({ ok: true });

export function createFakePickerApi(options: FakePickerOptions = {}): FakePickerApi {
  const calls: RecordedCall[] = [];
  const listeners: ListenerSets = {
    data: [],
    hidden: [],
    image: [],
    translate: [],
    runSkill: [],
  };

  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
  };
  const subscribe = (list: Listener[]) => (callback: Listener) => {
    list.push(callback);
    return () => {
      const index = list.indexOf(callback);
      if (index >= 0) list.splice(index, 1);
    };
  };

  const api = {
    live: false,
    surface: "panel",
    calls,
    ready: async () => {
      record("ready");
      return ok();
    },
    onData: subscribe(listeners.data),
    onHidden: subscribe(listeners.hidden),
    onImage: subscribe(listeners.image),
    onTranslateEvent: subscribe(listeners.translate),
    onRunSkill: subscribe(listeners.runSkill),
    close: async (...args: unknown[]) => {
      record("close", ...args);
      return ok();
    },
    pin: async (...args: unknown[]) => {
      record("pin", ...args);
      return ok();
    },
    panelState: async (...args: unknown[]) => {
      record("panelState", ...args);
      return ok();
    },
    activate: async (...args: unknown[]) => {
      record("activate", ...args);
      return ok();
    },
    resize: async (width: number, height: number) => {
      record("resize", width, height);
      return options.resize ? options.resize(width, height) : null;
    },
    runToolbarSkill: async (...args: unknown[]) => {
      record("runToolbarSkill", ...args);
      return ok();
    },
    copy: async (...args: unknown[]) => {
      record("copy", ...args);
      return ok();
    },
    openSettings: async () => {
      record("openSettings");
      return ok();
    },
    translate: async (requestId: string, text: string, targetLang: string) => {
      record("translate", requestId, text, targetLang);
      return options.translate
        ? options.translate(requestId, text, targetLang)
        : ok();
    },
    abortTranslate: async (...args: unknown[]) => {
      record("abortTranslate", ...args);
      return ok();
    },
    assist: async (...args: unknown[]) => {
      record("assist", ...args);
      return ok();
    },
    customSkill: async (...args: unknown[]) => {
      record("customSkill", ...args);
      return ok();
    },
    followup: async (...args: unknown[]) => {
      record("followup", ...args);
      const [requestId, question] = args as [string, string];
      return options.followup ? options.followup(requestId, question) : ok();
    },
    captureRetry: async (...args: unknown[]) => {
      record("captureRetry", ...args);
      return ok();
    },
    captureFollowup: async (...args: unknown[]) => {
      record("captureFollowup", ...args);
      return ok();
    },
    polish: async (...args: unknown[]) => {
      record("polish", ...args);
      return ok();
    },
    openExternal: async (...args: unknown[]) => {
      record("openExternal", ...args);
      return ok();
    },
    cancelFollowups: async (...args: unknown[]) => {
      record("cancelFollowups", ...args);
      return ok();
    },
    generateFollowups: async (...args: unknown[]) => {
      record("generateFollowups", ...args);
      return options.generateFollowups ? options.generateFollowups() : ok();
    },
    status: async () => {
      record("status");
      return ok();
    },
    dragPanel: async (...args: unknown[]) => {
      record("dragPanel", ...args);
      return ok();
    },
    disableInApp: async (...args: unknown[]) => {
      record("disableInApp", ...args);
      return ok();
    },
    disableTool: async (...args: unknown[]) => {
      record("disableTool", ...args);
      return ok();
    },

    emitData(payload: unknown) {
      for (const listener of [...listeners.data]) listener(payload);
    },
    emitHidden() {
      for (const listener of [...listeners.hidden]) listener(undefined);
    },
    emitImage(image: unknown) {
      for (const listener of [...listeners.image]) listener(image);
    },
    emitTranslateEvent(event: unknown) {
      for (const listener of [...listeners.translate]) listener(event);
    },
    emitRunSkill(skillId: unknown) {
      for (const listener of [...listeners.runSkill]) listener(skillId);
    },
  };

  return api as unknown as FakePickerApi;
}

/** Renders a component that mounts its own I18nProvider (e.g. PickerWindow). */
export function renderPickerWindow(ui: ReactElement): RenderResult {
  return render(ui);
}

export function renderPicker(
  ui: ReactElement,
  { locale = "zh" }: { locale?: Locale } = {}
): RenderResult & { api?: FakePickerApi } {
  return render(<I18nProvider initialLocale={locale}>{ui}</I18nProvider>);
}

