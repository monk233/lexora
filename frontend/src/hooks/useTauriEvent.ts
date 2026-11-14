import { useEffect, useRef } from "react";
import { subscribe } from "../lib/tauri-api.js";

/**
 * Subscribe to a Tauri event addressed to one specific webview window.
 *
 * The target is always pinned: Tauri's default `Any` target also delivers
 * events that were emitted via `emit_to` for other window labels, which would
 * leak cross-window events into multi-monitor capture overlays
 * (docs/contracts.md §10.1). The handler is kept in a ref so a changed handler
 * does not tear down and rebuild the listener; only `eventName`/`label` do.
 */
export function useTauriEvent<T>(
  eventName: string,
  handler: (payload: T) => void,
  label: string
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const dispose = subscribe(
      eventName,
      (payload) => handlerRef.current(payload as T),
      { target: { kind: "WebviewWindow", label } }
    );
    return dispose;
  }, [eventName, label]);
}
