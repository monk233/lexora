/* Test harness for the settings window (Task 3, non-test module).
 *
 * Cards and the shell are exercised against a fake `SettingsApi` so no Tauri
 * IPC is involved: `createFakeSettingsApi` keeps an in-memory `StatePayload`,
 * records every command call and exposes `emit*` helpers that drive the five
 * backend events. `renderSettingsWindow` mounts the real `SettingsWindow` with
 * that fake and waits for the initial `get_state` to settle, because
 * `SettingsFormProvider` loads asynchronously.
 */
import { act, render, type RenderResult } from "@testing-library/react";

import { translate, type TParams } from "@/lib/i18n";
import { deepMerge, type PlainObject } from "@/lib/constants";
import type { SettingsApi } from "@/lib/settings/api";
import type {
  ApiResult,
  DownloadProgress,
  GetStateResult,
  HotkeyResult,
  SaveResult,
  Settings,
  StatePayload,
  UpdateCheckResult,
  UpdateProgress,
} from "@/lib/settings/types";
import { SettingsWindow } from "@/windows/SettingsWindow";

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

type EventKey = "state" | "download" | "updateProgress" | "updateAvailable" | "toast";

type SubscriptionCounts = Record<EventKey, number>;

export interface FakeSettingsApi extends SettingsApi {
  calls: Array<{ method: string; args: unknown[] }>;
  subscribed: SubscriptionCounts;
  unsubscribed: SubscriptionCounts;
  emitState(state: StatePayload): void;
  emitDownload(progress: DownloadProgress): void;
  emitUpdateProgress(progress: UpdateProgress): void;
  emitUpdateAvailable(info: UpdateCheckResult): void;
  emitToast(payload: { type: "success" | "error" | "info"; message: string }): void;
}

/* Defaults mirror the Rust `Settings::default()` / `StatePayload` values
 * (settings.rs:413-505, docs/contracts.md §5.4). Fresh objects on every call:
 * no test can pollute the next one. */
function defaultState(): StatePayload {
  return {
    app: {
      name: "Lexora",
      version: "0.4.3",
      platform: "windows",
      packaged: false,
      portable: false,
      dataDir: "C:\\Lexora\\data",
      modelsDir: "C:\\Lexora\\models",
      logsDir: "C:\\Lexora\\logs",
      repoUrl: "https://github.com/lexora/lexora",
      license: "MIT",
      locale: "zh",
      languageSetting: "system",
    },
    settings: {
      version: 11,
      picker: {
        enabled: true,
        skills: ["translate", "summarize", "explain", "read", "copy", "search"],
        compact: true,
        defaultTargetLang: "auto",
        blacklist: [],
        maxChars: 5000,
        searchEngine: "google",
        panelPinned: false,
        panelMode: "auto",
        captureSkills: [
          "pin",
          "shape",
          "arrow",
          "pen",
          "text",
          "mosaic",
          "ocr",
          "translate",
          "explain",
        ],
        capturePrompts: { translate: "", wordLookup: "", explain: "" },
        prompts: { wordLookup: "", translate: "", summarize: "", explain: "", polish: "" },
        customSkills: [],
      },
      provider: {
        mode: "online",
        online: {
          preset: "deepseek",
          baseUrl: "https://api.deepseek.com/v1",
          modelsBaseUrl: "",
          apiKey: "",
          model: "deepseek-chat",
          timeoutMs: 60000,
          temperature: 0.2,
          maxTokens: 1024,
        },
        local: {
          selectedModel: "",
          contextSize: 4096,
          threads: 0,
          gpuLayers: 0,
          autoStart: true,
          keepRunning: false,
        },
      },
      app: {
        closeToTray: true,
        startAtLogin: true,
        theme: "system",
        language: "system",
      },
      capture: { regionShortcut: "Win+Shift+X" },
      quick: {
        enabled: true,
        hotkey: "Alt+Space",
        targetLang: "zh",
        sourceLang: "auto",
        prompt: "",
        wordLookupPrompt: "",
        pinned: false,
      },
    },
    promptDefaults: {
      translate: "Translate into {target}.",
      wordLookup: "Explain the selected word.",
      summarize: "Summarize the selected text.",
      explain: "Explain the selected text.",
      polish: "Polish the selected text.",
      captureTranslate: "Translate the screenshot into {target}.",
      captureWordLookup: "Explain the word in the screenshot.",
      captureExplain: "Explain the screenshot.",
      quickTranslate: "Translate into {target}.",
      quickTranslateWordLookup: "Explain the word.",
    },
    engine: {
      mode: "online",
      ready: false,
      hint: "",
      providerLabel: "",
      onlineConfigured: false,
      localState: "stopped",
      localModelFile: "",
      localModelName: "",
      localError: "",
      engineAvailable: false,
    },
    models: [],
    catalog: [],
    hardwareRecommendation: {
      totalMemoryBytes: 0,
      cpuThreads: 0,
      gpuVramBytes: 0,
      gpuName: "",
      recommendedModelId: "",
      recommendedQuant: "",
      reason: "",
    },
    downloads: [],
    picker: { visible: false, pinned: false },
    loginItem: { supported: true, enabled: false },
  };
}

/** Deep-merge `overrides` onto a fresh set of Rust defaults. */
export function makeState(overrides: DeepPartial<StatePayload> = {}): StatePayload {
  return deepMerge(
    defaultState() as unknown as PlainObject,
    overrides as PlainObject
  ) as unknown as StatePayload;
}

export function createFakeSettingsApi(
  initial: StatePayload,
  overrides: Partial<SettingsApi> = {}
): FakeSettingsApi {
  let current = initial;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const subscribed: SubscriptionCounts = {
    state: 0,
    download: 0,
    updateProgress: 0,
    updateAvailable: 0,
    toast: 0,
  };
  const unsubscribed: SubscriptionCounts = {
    state: 0,
    download: 0,
    updateProgress: 0,
    updateAvailable: 0,
    toast: 0,
  };

  const stateListeners = new Set<(state: StatePayload) => void>();
  const downloadListeners = new Set<(progress: DownloadProgress) => void>();
  const updateProgressListeners = new Set<(progress: UpdateProgress) => void>();
  const updateAvailableListeners = new Set<(info: UpdateCheckResult) => void>();
  const toastListeners = new Set<
    (payload: { type: "success" | "error" | "info"; message: string }) => void
  >();

  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };

  const ok = async (): Promise<ApiResult> => ({ ok: true });

  const api: FakeSettingsApi = {
    live: false,
    calls,
    subscribed,
    unsubscribed,

    getState: async (): Promise<GetStateResult> => {
      record("getState");
      return { ok: true, state: current };
    },
    updateSettings: async (patch): Promise<SaveResult> => {
      record("updateSettings", patch);
      current = {
        ...current,
        settings: deepMerge(
          current.settings as unknown as PlainObject,
          patch as PlainObject
        ) as unknown as Settings,
      };
      return { ok: true, state: current };
    },
    resetSettings: async (): Promise<GetStateResult> => {
      record("resetSettings");
      return { ok: true, state: current };
    },

    testOnline: async (input) => {
      record("testOnline", input);
      return { ok: true };
    },
    listOnlineModels: async (input) => {
      record("listOnlineModels", input);
      return { ok: true, models: [] };
    },

    downloadEngine: async () => {
      record("downloadEngine");
      return ok();
    },
    downloadModel: async (id) => {
      record("downloadModel", id);
      return ok();
    },
    cancelDownload: async (id) => {
      record("cancelDownload", id);
      return ok();
    },
    importModel: async () => {
      record("importModel");
      return ok();
    },
    removeModel: async (file) => {
      record("removeModel", file);
      return ok();
    },
    startLocal: async () => {
      record("startLocal");
      return ok();
    },
    restartLocal: async () => {
      record("restartLocal");
      return ok();
    },
    stopLocal: async () => {
      record("stopLocal");
      return ok();
    },

    openDir: async (which) => {
      record("openDir", which);
      return ok();
    },
    openExternal: async (url) => {
      record("openExternal", url);
      return ok();
    },

    setStartAtLogin: async (enabled) => {
      record("setStartAtLogin", enabled);
      return ok();
    },
    setCaptureHotkey: async (shortcut): Promise<HotkeyResult> => {
      record("setCaptureHotkey", shortcut);
      return { ok: true, shortcut };
    },
    setQuickHotkey: async (shortcut): Promise<HotkeyResult> => {
      record("setQuickHotkey", shortcut);
      return { ok: true, shortcut };
    },
    clearQuickHistory: async () => {
      record("clearQuickHistory");
      return ok();
    },

    checkUpdate: async (): Promise<UpdateCheckResult> => {
      record("checkUpdate");
      return { ok: true };
    },
    installUpdate: async () => {
      record("installUpdate");
      return ok();
    },
    notifyUpdateAvailable: async (version) => {
      record("notifyUpdateAvailable", version);
      return ok();
    },
    quit: async () => {
      record("quit");
      return ok();
    },

    onState: (cb) => {
      subscribed.state += 1;
      stateListeners.add(cb);
      return () => {
        unsubscribed.state += 1;
        stateListeners.delete(cb);
      };
    },
    onDownloadProgress: (cb) => {
      subscribed.download += 1;
      downloadListeners.add(cb);
      return () => {
        unsubscribed.download += 1;
        downloadListeners.delete(cb);
      };
    },
    onUpdateProgress: (cb) => {
      subscribed.updateProgress += 1;
      updateProgressListeners.add(cb);
      return () => {
        unsubscribed.updateProgress += 1;
        updateProgressListeners.delete(cb);
      };
    },
    onUpdateAvailable: (cb) => {
      subscribed.updateAvailable += 1;
      updateAvailableListeners.add(cb);
      return () => {
        unsubscribed.updateAvailable += 1;
        updateAvailableListeners.delete(cb);
      };
    },
    onToast: (cb) => {
      subscribed.toast += 1;
      toastListeners.add(cb);
      return () => {
        unsubscribed.toast += 1;
        toastListeners.delete(cb);
      };
    },

    emitState: (state) => {
      current = state;
      stateListeners.forEach((cb) => cb(state));
    },
    emitDownload: (progress) => {
      downloadListeners.forEach((cb) => cb(progress));
    },
    emitUpdateProgress: (progress) => {
      updateProgressListeners.forEach((cb) => cb(progress));
    },
    emitUpdateAvailable: (info) => {
      updateAvailableListeners.forEach((cb) => cb(info));
    },
    emitToast: (payload) => {
      toastListeners.forEach((cb) => cb(payload));
    },
  };

  Object.assign(api, overrides);
  return api;
}

export interface RenderSettingsOptions {
  state?: StatePayload;
  api?: SettingsApi;
}

/** Mount the real window with a fake bridge and wait for the initial load. */
export async function renderSettingsWindow(
  options: RenderSettingsOptions = {}
): Promise<RenderResult & { api: FakeSettingsApi }> {
  /* The harness pins the source locale so assertions can use `zh(key)`
   * regardless of the host machine's language. */
  document.documentElement.lang = "zh-CN";
  const state = options.state ?? makeState();
  const api = (options.api as FakeSettingsApi | undefined) ?? createFakeSettingsApi(state);
  const view = render(<SettingsWindow api={api} />);
  await act(async () => {});
  return { api, ...view };
}

/** Resolve a settings key in Chinese; every UI assertion goes through it. */
export function zh(key: string, params?: TParams): string {
  return translate("zh", key, params);
}
