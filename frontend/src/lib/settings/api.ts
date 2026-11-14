/* Typed wrapper around the legacy settings IPC bridge.
 *
 * This is the only settings module allowed to touch `settingsAPI` directly.
 * Command names, argument shapes and event names are copied verbatim from
 * `frontend/src/lib/tauri-api.js` (docs/contracts.md §5.1/§5.3); renaming any
 * of them is a protocol change and must not happen here.
 */
import { settingsAPI } from "@/lib/tauri-api.js";
import type {
  ApiResult,
  DirKind,
  DownloadProgress,
  GetStateResult,
  HotkeyResult,
  SaveResult,
  SettingsPatch,
  StatePayload,
  Unsubscribe,
  UpdateCheckResult,
  UpdateProgress,
} from "./types";

export type {
  ApiResult,
  DirKind,
  DownloadProgress,
  GetStateResult,
  HotkeyResult,
  SaveResult,
  SettingsPatch,
  StatePayload,
  Unsubscribe,
  UpdateCheckResult,
  UpdateProgress,
};

export interface OnlineModelList {
  ok: boolean;
  models: string[];
  error?: string;
  hint?: string;
}

export interface SettingsApi {
  readonly live: boolean;
  getState(): Promise<GetStateResult>;
  updateSettings(patch: SettingsPatch): Promise<SaveResult>;
  resetSettings(): Promise<GetStateResult>;
  testOnline(input: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs?: number;
  }): Promise<ApiResult>;
  listOnlineModels(input: {
    baseUrl: string;
    apiKey: string;
  }): Promise<OnlineModelList>;
  downloadEngine(): Promise<ApiResult>;
  downloadModel(id: string): Promise<ApiResult>;
  cancelDownload(id?: string): Promise<ApiResult>;
  importModel(): Promise<ApiResult>;
  removeModel(file: string): Promise<ApiResult>;
  startLocal(): Promise<ApiResult>;
  restartLocal(): Promise<ApiResult>;
  stopLocal(): Promise<ApiResult>;
  openDir(which: DirKind): Promise<ApiResult>;
  openExternal(url: string): Promise<ApiResult>;
  setStartAtLogin(enabled: boolean): Promise<ApiResult>;
  setCaptureHotkey(shortcut: string): Promise<HotkeyResult>;
  setQuickHotkey(shortcut: string): Promise<HotkeyResult>;
  clearQuickHistory(): Promise<ApiResult>;
  checkUpdate(): Promise<UpdateCheckResult>;
  installUpdate(): Promise<ApiResult>;
  notifyUpdateAvailable(version: string): Promise<ApiResult>;
  quit(): Promise<ApiResult>;
  onState(cb: (state: StatePayload) => void): Unsubscribe;
  onDownloadProgress(cb: (progress: DownloadProgress) => void): Unsubscribe;
  onUpdateProgress(cb: (progress: UpdateProgress) => void): Unsubscribe;
  onUpdateAvailable(cb: (info: UpdateCheckResult) => void): Unsubscribe;
  onToast(cb: (payload: { type: "success" | "error" | "info"; message: string }) => void): Unsubscribe;
}

/* One bridge cast for the whole surface: `tauri-api.d.ts` declares command
 * methods generically (`Command`), while this module narrows them per command. */
interface RawSettingsApi {
  live?: boolean;
  getState(): Promise<GetStateResult>;
  updateSettings(patch: SettingsPatch): Promise<SaveResult>;
  resetSettings(): Promise<GetStateResult>;
  testOnline(input: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number }): Promise<ApiResult>;
  listOnlineModels(input: { baseUrl: string; apiKey: string }): Promise<OnlineModelList>;
  downloadEngine(): Promise<ApiResult>;
  downloadModel(id: string): Promise<ApiResult>;
  cancelDownload(id: string): Promise<ApiResult>;
  importModel(): Promise<ApiResult>;
  removeModel(file: string): Promise<ApiResult>;
  startLocal(): Promise<ApiResult>;
  restartLocal(): Promise<ApiResult>;
  stopLocal(): Promise<ApiResult>;
  openDir(which: DirKind): Promise<ApiResult>;
  openExternal(url: string): Promise<ApiResult>;
  setStartAtLogin(enabled: boolean): Promise<ApiResult>;
  setCaptureHotkey(shortcut: string): Promise<HotkeyResult>;
  quickSetHotkey(shortcut: string): Promise<HotkeyResult>;
  quickHistoryClear(): Promise<ApiResult>;
  checkUpdate(): Promise<UpdateCheckResult>;
  installUpdate(): Promise<ApiResult>;
  notifyUpdateAvailable(version: string): Promise<ApiResult>;
  quit(): Promise<ApiResult>;
  onState(cb: (state: StatePayload) => void): Unsubscribe;
  onDownloadProgress(cb: (progress: DownloadProgress) => void): Unsubscribe;
  onUpdateProgress(cb: (progress: UpdateProgress) => void): Unsubscribe;
  onUpdateAvailable(cb: (info: UpdateCheckResult) => void): Unsubscribe;
  onToast(cb: (payload: { type: "success" | "error" | "info"; message: string }) => void): Unsubscribe;
}

const raw = settingsAPI as unknown as RawSettingsApi;

/** Bridge methods resolve rather than reject; this keeps that guarantee even
 * if the underlying invoke ever throws (legacy `Promise.catch` equivalent). */
function failure<T extends { ok: boolean }>(fallback: T) {
  return (error: unknown): T => ({ ...fallback, ok: false, error: String(error) });
}

export const settingsApi: SettingsApi = {
  live: raw.live === true,

  getState: () => raw.getState().catch(failure<GetStateResult>({ ok: false })),

  updateSettings: (patch) => raw.updateSettings(patch).catch(failure<SaveResult>({ ok: false })),

  resetSettings: () => raw.resetSettings().catch(failure<GetStateResult>({ ok: false })),

  testOnline: (input) => raw.testOnline(input).catch(failure<ApiResult>({ ok: false })),

  listOnlineModels: (input) =>
    raw
      .listOnlineModels(input)
      .catch(failure<OnlineModelList>({ ok: false, models: [] })),

  downloadEngine: () => raw.downloadEngine().catch(failure<ApiResult>({ ok: false })),
  downloadModel: (id) => raw.downloadModel(id).catch(failure<ApiResult>({ ok: false })),
  cancelDownload: (id) => raw.cancelDownload(id ?? "").catch(failure<ApiResult>({ ok: false })),
  importModel: () => raw.importModel().catch(failure<ApiResult>({ ok: false })),
  removeModel: (file) => raw.removeModel(file).catch(failure<ApiResult>({ ok: false })),
  startLocal: () => raw.startLocal().catch(failure<ApiResult>({ ok: false })),
  restartLocal: () => raw.restartLocal().catch(failure<ApiResult>({ ok: false })),
  stopLocal: () => raw.stopLocal().catch(failure<ApiResult>({ ok: false })),
  openDir: (which) => raw.openDir(which).catch(failure<ApiResult>({ ok: false })),
  openExternal: (url) => raw.openExternal(url).catch(failure<ApiResult>({ ok: false })),

  setStartAtLogin: (enabled) => raw.setStartAtLogin(enabled).catch(failure<ApiResult>({ ok: false })),
  setCaptureHotkey: (shortcut) =>
    raw.setCaptureHotkey(shortcut).catch(failure<HotkeyResult>({ ok: false })),
  setQuickHotkey: (shortcut) =>
    raw.quickSetHotkey(shortcut).catch(failure<HotkeyResult>({ ok: false })),
  clearQuickHistory: () => raw.quickHistoryClear().catch(failure<ApiResult>({ ok: false })),

  checkUpdate: () => raw.checkUpdate().catch(failure<UpdateCheckResult>({ ok: false })),
  installUpdate: () => raw.installUpdate().catch(failure<ApiResult>({ ok: false })),
  notifyUpdateAvailable: (version) =>
    raw.notifyUpdateAvailable(version).catch(failure<ApiResult>({ ok: false })),
  quit: () => raw.quit().catch(failure<ApiResult>({ ok: false })),

  onState: (cb) => raw.onState(cb),
  onDownloadProgress: (cb) => raw.onDownloadProgress(cb),
  onUpdateProgress: (cb) => raw.onUpdateProgress(cb),
  onUpdateAvailable: (cb) => raw.onUpdateAvailable(cb),
  onToast: (cb) => raw.onToast(cb),
};
