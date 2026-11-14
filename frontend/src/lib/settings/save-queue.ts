/* Serial save queue for `update_settings`.
 *
 * Equivalent to `web/settings.js:391-429` (inventory §4.5-§4.8), but as a pure,
 * injectable unit: no React, no DOM, no module state. One `send` call is in
 * flight at a time; patches enqueued while a save is running are deep-merged
 * into the next request instead of racing it.
 *
 * Status machine: idle -> saving -> saved -> (savedIdleMs) -> idle, with
 * `error` sticking until the next save succeeds. A failed save never blocks
 * later patches: the loop keeps draining, but it awaits `onFailure` first so a
 * rollback refresh can never race the next patch (inventory §4.7).
 */
import { deepMerge, type PlainObject } from "@/lib/constants";
import type {
  SaveResult,
  SaveStatus,
  SettingsPatch,
  StatePayload,
} from "./types";

export const SAVED_IDLE_MS = 2200;

/** i18n key path used when the backend reports no error text and the caller
 * injects no localized fallback (the hook always injects one). */
const DEFAULT_FAILURE_MESSAGE = "settings.error.saveFailed";

export interface FlushResult {
  ok: boolean;
  error?: string;
}

export interface SaveQueueOptions {
  send: (patch: SettingsPatch) => Promise<SaveResult>;
  onStatus: (status: SaveStatus) => void;
  onSaved: (state: StatePayload) => void;
  /** Caller handles the toast and the `get_state` rollback. The drain awaits
   * this promise, so the rollback finishes before the next patch is sent. */
  onFailure: (error: string) => void | Promise<void>;
  /** How long `saved` stays visible; defaults to 2200ms (C01). */
  savedIdleMs?: number;
  /** Localized text for a failure without a server message. The hook injects
   * `translate(locale, "settings.error.unknown")`; the default is the key path. */
  failureMessage?: string;
}

export interface SaveQueue {
  enqueue(patch: SettingsPatch): void;
  flush(): Promise<FlushResult>;
  pending(): boolean;
  dispose(): void;
}

export function createSaveQueue(options: SaveQueueOptions): SaveQueue {
  const savedIdleMs = options.savedIdleMs ?? SAVED_IDLE_MS;

  let queued: PlainObject | null = null;
  let draining: Promise<FlushResult> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function setStatus(kind: SaveStatus["kind"], message = ""): void {
    if (disposed) return;
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    options.onStatus({ kind, message });
    if (kind === "saved") {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        setStatus("idle");
      }, savedIdleMs);
    }
  }

  async function drain(): Promise<FlushResult> {
    /* Only failures of the work this drain actually covered may fail the
     * promise it resolves; a failure from an earlier flush must not stick. */
    let failure: FlushResult | null = null;

    while (queued !== null && !disposed) {
      const patch = queued;
      queued = null;
      setStatus("saving");

      let result: SaveResult;
      try {
        result = await options.send(patch);
      } catch (error) {
        result = { ok: false, error: String(error) };
      }

      if (disposed) return failure ?? { ok: true };

      if (result.ok) {
        if (result.state) options.onSaved(result.state);
        /* Only claim "saved" once nothing else is waiting (inventory §4.6). */
        if (queued === null) setStatus("saved");
      } else {
        const error = result.error || options.failureMessage || DEFAULT_FAILURE_MESSAGE;
        failure = { ok: false, error };
        setStatus("error");
        /* Serialize the rollback with the queue: the caller's `get_state` must
         * settle before the next patch is sent (inventory §4.7). A rejected
         * rollback must not stall the drain. */
        try {
          await options.onFailure(error);
        } catch {
          /* Caller-owned rollback failures are not queue failures. */
        }
      }
    }
    return failure ?? { ok: true };
  }

  function flush(): Promise<FlushResult> {
    if (draining) return draining;
    /* Nothing pending: an earlier failure is history, not this flush's result
     * (legacy `web/settings.js:396-398` resolves {ok:true} on an empty queue). */
    if (queued === null) return Promise.resolve({ ok: true });
    const promise = drain().finally(() => {
      if (draining === promise) draining = null;
    });
    draining = promise;
    return promise;
  }

  function enqueue(patch: SettingsPatch): void {
    if (disposed) return;
    queued =
      queued === null
        ? deepMerge({}, patch as PlainObject)
        : deepMerge(queued, patch as PlainObject);
    void flush();
  }

  function pending(): boolean {
    return queued !== null || draining !== null;
  }

  function dispose(): void {
    disposed = true;
    queued = null;
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  return { enqueue, flush, pending, dispose };
}
