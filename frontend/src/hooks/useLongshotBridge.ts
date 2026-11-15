/* Long-shot bridges (P5c).
 *
 * Preview window: `longshot_state` gives the current stitched image and
 * `longshot-progress` / `longshot-cancelled` events keep it updated.
 * Control bar: direction / auto-scroll / finish / cancel commands plus the same
 * progress events for its frame counter.
 */
import { useEffect, useRef, useState } from "react";

import { longshotAPI } from "@/lib/tauri-api.js";
import type { LongshotProgress, LongshotStateResult } from "@/lib/longshot/model";

export interface LongshotApi {
  ready?(index: number): Promise<unknown>;
  state?(): Promise<LongshotStateResult>;
  preview?(): Promise<LongshotStateResult>;
  previewReady?(): Promise<unknown>;
  autoscroll?(enabled: boolean): Promise<unknown>;
  direction?(direction: string): Promise<unknown>;
  finish?(): Promise<unknown>;
  cancel?(): Promise<unknown>;
  onStarted?(callback: (payload: unknown) => void): () => void;
  onProgress?(callback: (payload: LongshotProgress) => void): () => void;
  onCancelled?(callback: (payload: unknown) => void): () => void;
  [command: string]: unknown;
}

export interface LongshotPreviewBridge {
  api: LongshotApi;
  dataUrl: string;
  width: number;
  height: number;
  frames: number;
  cancelled: boolean;
}

export function useLongshotPreview(options: { api?: LongshotApi; index?: number } = {}): LongshotPreviewBridge {
  const api = (options.api ?? longshotAPI) as unknown as LongshotApi;
  const [dataUrl, setDataUrl] = useState("");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [frames, setFrames] = useState(0);
  const [cancelled, setCancelled] = useState(false);
  const requested = useRef(false);

  useEffect(() => {
    void api.ready?.(options.index ?? 0);
    if (!requested.current) {
      requested.current = true;
      void api.state?.().then((result) => {
        if (!result?.ok) return;
        if (result.dataUrl) setDataUrl(result.dataUrl);
        setSize({ width: result.width ?? 0, height: result.height ?? 0 });
        setFrames(result.frames ?? 0);
      });
    }
    const offProgress = api.onProgress?.((progress) => {
      setFrames(Number(progress.frames ?? 0));
      setSize({
        width: Number(progress.width ?? 0),
        height: Number(progress.height ?? 0),
      });
    });
    const offCancelled = api.onCancelled?.(() => setCancelled(true));
    return () => {
      offProgress?.();
      offCancelled?.();
    };
  }, [api, options.index]);

  return { api, dataUrl, width: size.width, height: size.height, frames, cancelled };
}

export interface LongshotBarBridge {
  api: LongshotApi;
  progress: LongshotProgress;
  direction: string;
  autoscroll: boolean;
  setDirection: (direction: string) => void;
  setAutoscroll: (enabled: boolean) => void;
  finish: () => void;
  cancel: () => void;
}

export function useLongshotBar(options: { api?: LongshotApi } = {}): LongshotBarBridge {
  const api = (options.api ?? longshotAPI) as unknown as LongshotApi;
  const [progress, setProgress] = useState<LongshotProgress>({});
  const [direction, setDirectionState] = useState("vertical");
  const [autoscroll, setAutoscrollState] = useState(false);

  useEffect(() => {
    const offProgress = api.onProgress?.((next) => setProgress(next));
    const offStarted = api.onStarted?.((payload) => {
      const value = payload as { direction?: string; autoscroll?: boolean };
      if (value?.direction) setDirectionState(String(value.direction));
      if (typeof value?.autoscroll === "boolean") setAutoscrollState(value.autoscroll);
    });
    return () => {
      offProgress?.();
      offStarted?.();
    };
  }, [api]);

  return {
    api,
    progress,
    direction,
    autoscroll,
    setDirection: (next) => {
      setDirectionState(next);
      void api.direction?.(next);
    },
    setAutoscroll: (enabled) => {
      setAutoscrollState(enabled);
      void api.autoscroll?.(enabled);
    },
    finish: () => {
      void api.finish?.();
    },
    cancel: () => {
      void api.cancel?.();
    },
  };
}
