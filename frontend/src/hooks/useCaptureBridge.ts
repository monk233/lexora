/* Capture bridge (P5): monitor screenshot, armed notifications, ready call.
 *
 * The overlay window is reused between captures, so the page is NOT reloaded and
 * a mount-scoped effect would stop reporting after the first session. Rust emits
 * `capture-armed {index}` at the start of every capture; the bridge then polls
 * `capture_monitor_info` until the encoded screenshot is available (the legacy
 * renderer polled too — the first call can land before encode finishes) and only
 * then reports `capture_ready` (contract §10.1).
 */
import { useEffect, useRef, useState } from "react";

import { captureAPI } from "@/lib/tauri-api.js";
import type { MonitorInfo } from "@/lib/capture/model";

export interface CaptureApi {
  monitor?(index: number): Promise<MonitorInfo>;
  ready?(index: number): Promise<unknown>;
  copy?(index: number, rect: unknown, annotations: unknown[], globalRect?: unknown): Promise<unknown>;
  skill?(
    requestId: string,
    index: number,
    rect: unknown,
    action: string,
    skillId: string,
    targetLang: string,
    annotations: unknown[],
    globalRect?: unknown
  ): Promise<unknown>;
  pin?(index: number, rect: unknown, annotations: unknown[], globalRect?: unknown): Promise<unknown>;
  longshot?(index: number, rect: unknown): Promise<unknown>;
  close?(): Promise<unknown>;
  layout?(): Promise<unknown>;
  copyText?(text: string): Promise<unknown>;
  hover?(x: number, y: number): Promise<unknown>;
  retry?(requestId: string, targetLang: string): Promise<unknown>;
  onArmed?(callback: (payload: unknown) => void): () => void;
  onLongshotProgress?(callback: (payload: unknown) => void): () => void;
  onLongshotDone?(callback: (payload: unknown) => void): () => void;
  [command: string]: unknown;
}

export interface CaptureBridge {
  api: CaptureApi;
  index: number;
  monitor: MonitorInfo | null;
  /** Increments on every `capture-armed`; consumers reset their session state. */
  armedSeq: number;
}

const POLL_INTERVAL_MS = 150;
const MAX_POLL_ATTEMPTS = 12;

export function useCaptureBridge(index: number, options: { api?: CaptureApi } = {}): CaptureBridge {
  const api = (options.api ?? captureAPI) as unknown as CaptureApi;
  const [monitor, setMonitor] = useState<MonitorInfo | null>(null);
  const [armedSeq, setArmedSeq] = useState(0);
  const armedRef = useRef(false);
  const pollRef = useRef(0);

  useEffect(() => {
    const poll = (attempt: number) => {
      void api.monitor?.(index).then((result) => {
        if (result?.ok && result.dataUrl) {
          setMonitor(result);
          void api.ready?.(index);
          return;
        }
        if (attempt < MAX_POLL_ATTEMPTS) {
          pollRef.current = window.setTimeout(() => poll(attempt + 1), POLL_INTERVAL_MS);
          return;
        }
        setMonitor(result ?? null);
        void api.ready?.(index);
      });
    };

    const arm = () => {
      armedRef.current = true;
      setArmedSeq((seq) => seq + 1);
      if (pollRef.current) window.clearTimeout(pollRef.current);
      poll(0);
    };

    const off = api.onArmed?.(() => arm());
    /* First paint also reports: the window may be created with the capture
     * already running (Rust emitted `capture-armed` before we listened). */
    if (!armedRef.current) arm();

    return () => {
      off?.();
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [api, index]);

  return { api, index, monitor, armedSeq };
}
