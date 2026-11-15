/* Capture bridge (P5): monitor screenshot, armed notifications, ready call.
 *
 * The overlay window is reused between captures, so the page is NOT reloaded and
 * a mount-scoped effect would stop reporting after the first session. Rust emits
 * `capture-armed {index}` at the start of every capture: the bridge re-fetches
 * the monitor screenshot and reports `capture_ready` each time (contract §10.1).
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

export function useCaptureBridge(index: number, options: { api?: CaptureApi } = {}): CaptureBridge {
  const api = (options.api ?? captureAPI) as unknown as CaptureApi;
  const [monitor, setMonitor] = useState<MonitorInfo | null>(null);
  const [armedSeq, setArmedSeq] = useState(0);
  const armedRef = useRef(false);

  useEffect(() => {
    const arm = () => {
      armedRef.current = true;
      setArmedSeq((seq) => seq + 1);
      void api.monitor?.(index).then((result) => setMonitor(result ?? null));
      void api.ready?.(index);
    };

    const off = api.onArmed?.(() => arm());
    /* First paint also reports ready: the window may be created with the
     * capture already running (Rust emitted `capture-armed` before we listened). */
    if (!armedRef.current) arm();

    return () => off?.();
  }, [api, index]);

  return { api, index, monitor, armedSeq };
}
