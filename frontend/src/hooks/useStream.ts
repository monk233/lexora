import { useCallback, useMemo, useRef, useState } from "react";
import { useTauriEvent } from "./useTauriEvent";

export type StreamEvent =
  | { requestId: string; type: "chunk"; text?: string }
  | { requestId: string; type: "target"; targetLang?: string }
  | { requestId: string; type: "error"; message?: string; hint?: string }
  | { requestId: string; type: "done"; elapsedMs?: number };

export type StreamStatus = "idle" | "streaming" | "done" | "error" | "stopped";

interface Options<TState> {
  requestId: string;
  eventName: string;
  label: string;
  initial: TState;
  reduce: (state: TState, event: StreamEvent) => TState;
}

/**
 * Subscribe to a per-request stream event and fold it into local state.
 *
 * Events from other requests are dropped, and the terminal `done`/`error`
 * states are sticky: a late `chunk` after completion must not reopen or
 * overwrite the finished stream (docs/contracts.md stream contract).
 *
 * The phase is mirrored in a ref because `status` from the render closure is
 * stale when two events are delivered in the same sync batch (one Tauri task,
 * or one test `act`): the second event would still read `"streaming"` and
 * overwrite the terminal state. `statusRef` is updated synchronously before
 * the next event can be observed.
 */
export function useStream<TState>({
  requestId,
  eventName,
  label,
  initial,
  reduce,
}: Options<TState>) {
  const [state, setState] = useState<TState>(initial);
  const [status, setStatus] = useState<StreamStatus>("idle");

  const statusRef = useRef<StreamStatus>("idle");
  // `"idle"` means "no phase yet" on mount, which must accept a first event
  // (streams are often observed without calling `start()`), but after
  // `abort()` it must not: the request will never emit `done`, so a late
  // chunk would otherwise resurrect `"streaming"`. `armedRef` distinguishes
  // those two idle states; `start()` re-arms the stream.
  const armedRef = useRef(true);

  const setPhase = useCallback((next: StreamStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  useTauriEvent<StreamEvent>(
    eventName,
    useCallback(
      (event: StreamEvent) => {
        if (!event || event.requestId !== requestId) return;
        const phase = statusRef.current;
        if (phase === "done" || phase === "error" || phase === "stopped") return;
        if (phase === "idle" && !armedRef.current) return;
        const next: StreamStatus =
          event.type === "done" ? "done" : event.type === "error" ? "error" : "streaming";
        setPhase(next);
        setState((current) => reduce(current, event));
      },
      [requestId, reduce, setPhase]
    ),
    label
  );

  const start = useCallback(() => {
    armedRef.current = true;
    setPhase("streaming");
  }, [setPhase]);

  const abort = useCallback(() => {
    armedRef.current = false;
    setPhase("idle");
    setState(initial);
  }, [initial, setPhase]);

  /* Stop keeps the partial output (docs/contracts.md:400): the picker appends
   * "已停止生成" itself, and every late chunk/error/done is ignored from here. */
  const stop = useCallback(() => {
    armedRef.current = false;
    setPhase("stopped");
  }, [setPhase]);

  return useMemo(
    () => ({ state, status, start, abort, stop }),
    [state, status, start, abort, stop]
  );
}
