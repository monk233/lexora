/* Pin bridge (P4): load the image, follow shell close notifications. */
import { useEffect, useRef, useState } from "react";

import { pinAPI } from "@/lib/tauri-api.js";
import type { PinReadyResult } from "@/lib/pin/model";

export interface PinApi {
  ready?(id: string): Promise<PinReadyResult>;
  drag?(id: string, dx: number, dy: number): Promise<unknown>;
  zoom?(id: string, zoom: number): Promise<unknown>;
  copy?(id: string): Promise<unknown>;
  close?(id: string): Promise<unknown>;
  editWindow?(id: string, editing: boolean, toolbarHeight: number, toolbarWidth: number): Promise<unknown>;
  exportAnnotations?(id: string, annotations: unknown[], apply: boolean): Promise<unknown>;
  skill?(
    id: string,
    requestId: string,
    action: string,
    skillId: string,
    targetLang: string,
    annotations: unknown[]
  ): Promise<unknown>;
  onClose?(callback: () => void): () => void;
  [command: string]: unknown;
}

export interface PinBridge {
  api: PinApi;
  id: string;
  dataUrl: string;
  error?: { message: string; hint?: string };
  ready: boolean;
}

export function usePinBridge(id: string, options: { api?: PinApi } = {}): PinBridge {
  const api = (options.api ?? pinAPI) as unknown as PinApi;
  const [dataUrl, setDataUrl] = useState("");
  const [error, setError] = useState<{ message: string; hint?: string } | undefined>();
  const [ready, setReady] = useState(false);
  const requested = useRef(false);

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void api.ready?.(id).then((result) => {
      if (!result) return;
      if (result.ok && result.dataUrl) {
        setDataUrl(result.dataUrl);
      } else {
        setError({ message: result.error || "pin", hint: result.hint });
      }
      setReady(true);
    });
  }, [api, id]);

  useEffect(() => {
    const off = api.onClose?.(() => setReady(false));
    return () => off?.();
  }, [api]);

  return { api, id, dataUrl, error, ready };
}

