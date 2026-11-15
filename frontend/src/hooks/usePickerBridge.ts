/* Picker bridge (P3, Task 2).
 *
 * Owns the window-side subscriptions and the surface split:
 *  - `picker.html` renders the result panel;
 *  - `picker.html?surface=toolbar` renders the toolbar capsule (used while a
 *    pinned panel is open, see contracts §7.1:404).
 *
 * `ready()` is called exactly once per mount; a ref guards StrictMode's
 * double-invoked effect so the backend does not replay the payload twice.
 */
import { useEffect, useRef, useState } from "react";

import { pickerAPI } from "@/lib/tauri-api.js";
import {
  detectSurface,
  type PickerImage,
  type PickerPayload,
  type PickerSurface,
} from "@/lib/picker/model";

/** The subset of the bridge this hook needs (the fake in tests implements it). */
export interface PickerApi {
  ready(): Promise<unknown>;
  onData(callback: (payload: unknown) => void): () => void;
  onHidden(callback: () => void): () => void;
  onImage(callback: (image: unknown) => void): () => void;
  onTranslateEvent(callback: (event: unknown) => void): () => void;
  onRunSkill(callback: (skillId: unknown) => void): () => void;
  resize(width: number, height: number): Promise<unknown> | null;
  runToolbarSkill?(skill: string): Promise<unknown>;
  close?(): Promise<unknown>;
  pin?(pinned: boolean, remember?: boolean): Promise<unknown>;
  panelState?(open: boolean): Promise<unknown>;
  activate?(active: boolean): Promise<unknown>;
  dragPanel?(dx: number, dy: number): Promise<unknown>;
  copy?(text: string): Promise<unknown>;
  openSettings?(): Promise<unknown>;
  openExternal?(url: string): Promise<unknown>;
  translate?(requestId: string, text: string, targetLang: string): Promise<unknown>;
  abortTranslate?(requestId: string): Promise<unknown>;
  assist?(requestId: string, action: string, text: string): Promise<unknown>;
  customSkill?(
    requestId: string,
    skillId: string,
    text: string,
    programName: string
  ): Promise<unknown>;
  polish?(requestId: string, text: string): Promise<unknown>;
  followup?(
    requestId: string,
    text: string,
    previousAnswer: string,
    question: string,
    history: unknown[]
  ): Promise<unknown>;
  captureRetry?(requestId: string, targetLang: string): Promise<unknown>;
  captureFollowup?(
    requestId: string,
    question: string,
    previousAnswer: string,
    history: unknown[]
  ): Promise<unknown>;
  generateFollowups?(
    requestId: string,
    skill: string,
    source: string,
    initialAnswer: string,
    history: unknown[]
  ): Promise<unknown>;
  cancelFollowups?(requestId: string): Promise<unknown>;
  status?(): Promise<unknown>;
  disableInApp?(programName: string): Promise<unknown>;
  disableTool?(): Promise<unknown>;
  [command: string]: unknown;
}

export interface PickerBridge {
  surface: PickerSurface;
  payload: PickerPayload | null;
  image: PickerImage | null;
  hidden: boolean;
  api: PickerApi;
}

export interface PickerBridgeOptions {
  api?: PickerApi;
  surface?: PickerSurface;
}

export function usePickerBridge(options: PickerBridgeOptions = {}): PickerBridge {
  const api = (options.api ?? pickerAPI) as unknown as PickerApi;
  const [surface] = useState<PickerSurface>(options.surface ?? detectSurface);
  const [payload, setPayload] = useState<PickerPayload | null>(null);
  const [image, setImage] = useState<PickerImage | null>(null);
  const [hidden, setHidden] = useState(true);
  const readyOnce = useRef(false);

  useEffect(() => {
    const offData = api.onData((next) => {
      setPayload((next ?? null) as PickerPayload | null);
      setImage(null);
      setHidden(false);
    });
    const offImage = api.onImage((next) => {
      if (next) setImage(next as PickerImage);
      setHidden(false);
    });
    const offHidden = api.onHidden(() => {
      setPayload(null);
      setImage(null);
      setHidden(true);
    });
    if (!readyOnce.current) {
      readyOnce.current = true;
      void api.ready();
    }
    return () => {
      offData();
      offImage();
      offHidden();
    };
  }, [api]);

  return { surface, payload, image, hidden, api };
}
