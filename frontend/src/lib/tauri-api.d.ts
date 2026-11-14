export interface ApiResult<T = unknown> {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

type Command = (...args: unknown[]) => Promise<ApiResult>;

/** Command map plus the runtime flags the legacy UI reads (`live`, `surface`). */
export type ServiceApi = Record<string, Command> & { live: boolean; surface?: string };

export const pickerAPI: ServiceApi;
export const settingsAPI: ServiceApi;
export const quickAPI: ServiceApi;
export const captureAPI: ServiceApi;
export const longshotAPI: ServiceApi;
export const pinAPI: ServiceApi;

export function subscribe(
  eventName: string,
  handler: (payload: unknown) => void,
  options?: { target?: { kind: "WebviewWindow"; label: string } }
): () => void;

export function currentWebviewTarget():
  | { target: { kind: "WebviewWindow"; label: string } }
  | undefined;

declare const api: {
  pickerAPI: ServiceApi;
  settingsAPI: ServiceApi;
  quickAPI: ServiceApi;
  subscribe: typeof subscribe;
  currentWebviewTarget: typeof currentWebviewTarget;
};
export default api;
