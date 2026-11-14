export interface ApiResult<T = unknown> {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** A request/response bridge method: always resolves, never rejects. */
export type Command = (...args: unknown[]) => Promise<ApiResult>;

/** Disposes a subscription created by an `on*` method. */
export type Unsubscribe = () => void;

/** Every `on*` method returns its own dispose function (it forwards `subscribe`). */
export type Subscription = (...args: unknown[]) => Unsubscribe;

/** Command map plus the runtime flags the legacy UI reads (`live`, `surface`). */
export type ServiceApi = Record<string, Command> & {
  live?: boolean;
  surface?: string;
};

export const pickerAPI: ServiceApi & {
  onData: Subscription;
  onHidden: Subscription;
  onRunSkill: Subscription;
  onImage: Subscription;
  onTranslateEvent: Subscription;
};

export const settingsAPI: ServiceApi & {
  onUpdateProgress: Subscription;
  onState: Subscription;
  onUpdateAvailable: Subscription;
  onDownloadProgress: Subscription;
  onToast: Subscription;
};

export const quickAPI: ServiceApi & {
  onTranslateEvent: Subscription;
  onShow: Subscription;
  onLocale: Subscription;
};

/**
 * Screenshot/capture bridge objects expose commands and subscriptions, but no
 * `live`/`surface` flags (only the picker/settings/quick windows have those).
 */
export const captureAPI: Record<string, Command> & {
  onLongshotProgress: Subscription;
  onLongshotDone: Subscription;
  onSelectionState: Subscription;
  onCopyColor: Subscription;
  onArmed: Subscription;
};

export const longshotAPI: Record<string, Command> & {
  onStarted: Subscription;
  onProgress: Subscription;
  onCancelled: Subscription;
};

export const pinAPI: Record<string, Command> & {
  onClose: Subscription;
};

export function subscribe(
  eventName: string,
  handler: (payload: unknown) => void,
  options?: { target?: { kind: "WebviewWindow"; label: string } }
): Unsubscribe;

export function currentWebviewTarget():
  | { target: { kind: "WebviewWindow"; label: string } }
  | undefined;

declare const api: {
  pickerAPI: typeof pickerAPI;
  settingsAPI: typeof settingsAPI;
  quickAPI: typeof quickAPI;
  subscribe: typeof subscribe;
  currentWebviewTarget: typeof currentWebviewTarget;
};
export default api;
