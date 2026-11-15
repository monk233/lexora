/* Capture bridge (P5): monitor screenshot, armed notifications, ready call. */
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
  onLongshotProgress?(callback: (payload: unknown) => void): () => void;
  onLongshotDone?(callback: (payload: unknown) => void): () => void;
  [command: string]: unknown;
}

export interface CaptureBridge {
  api: CaptureApi;
  index: number;
  monitor: MonitorInfo | null;
  armed: boolean;
}

export function useCaptureBridge(index: number, options: { api?: CaptureApi } = {}): CaptureBridge {
  const api = (options.api ?? captureAPI) as unknown as CaptureApi;
  const [monitor, setMonitor] = useState<MonitorInfo | null>(null);
  const [armed, setArmed] = useState(false);
  const requested = useRef(false);

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void api.monitor?.(index).then((result) => setMonitor(result ?? null));
    void api.ready?.(index);
  }, [api, index]);

  return { api, index, monitor, armed };
}
