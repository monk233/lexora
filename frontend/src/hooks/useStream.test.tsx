import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useStream, type StreamEvent } from "./useStream";

let handler: ((payload: unknown) => void) | undefined;

vi.mock("../lib/tauri-api.js", () => ({
  subscribe: (_name: string, fn: (payload: unknown) => void) => {
    handler = fn;
    return () => {};
  },
}));

interface Chunk {
  text: string;
  status: string;
  elapsed?: number;
}

const initial: Chunk = { text: "", status: "idle" };

function reduce(state: Chunk, event: StreamEvent): Chunk {
  if (event.type === "chunk") {
    return { text: state.text + (event.text ?? ""), status: "streaming" };
  }
  if (event.type === "done") {
    return { ...state, elapsed: event.elapsedMs };
  }
  return state;
}

function renderStream(requestId: string) {
  return renderHook(() =>
    useStream<Chunk>({
      requestId,
      eventName: "translate-event",
      label: "picker",
      initial,
      reduce,
    })
  );
}

test("accumulates chunks then reaches done", () => {
  const { result } = renderStream("r1");

  act(() => handler?.({ requestId: "r1", type: "chunk", text: "你好" }));
  expect(result.current.state.text).toBe("你好");
  expect(result.current.status).toBe("streaming");

  act(() => handler?.({ requestId: "r1", type: "chunk", text: "世界" }));
  expect(result.current.state.text).toBe("你好世界");

  act(() => handler?.({ requestId: "r1", type: "done", elapsedMs: 12 }));
  expect(result.current.status).toBe("done");
  // `reduce` still runs for terminal events (e.g. it records `elapsedMs`).
  expect(result.current.state.elapsed).toBe(12);
});

test("ignores events after done", () => {
  const { result } = renderStream("r2");

  act(() => handler?.({ requestId: "r2", type: "chunk", text: "ok" }));
  act(() => handler?.({ requestId: "r2", type: "done" }));
  act(() => handler?.({ requestId: "r2", type: "chunk", text: "late" }));

  expect(result.current.state.text).toBe("ok");
  expect(result.current.status).toBe("done");
});

test("late chunk in the same sync batch cannot overwrite done", () => {
  const { result } = renderStream("r4");

  act(() => {
    handler?.({ requestId: "r4", type: "chunk", text: "ok" });
    handler?.({ requestId: "r4", type: "done" });
    handler?.({ requestId: "r4", type: "chunk", text: "late" });
  });

  expect(result.current.state.text).toBe("ok");
  expect(result.current.status).toBe("done");
});

test("ignores events after error", () => {
  const { result } = renderStream("r5");

  act(() => handler?.({ requestId: "r5", type: "error", message: "boom" }));
  expect(result.current.status).toBe("error");

  act(() => handler?.({ requestId: "r5", type: "chunk", text: "late" }));
  expect(result.current.state.text).toBe("");
  expect(result.current.status).toBe("error");
});

test("ignores late chunks after abort until restart", () => {
  const { result } = renderStream("r6");

  act(() => handler?.({ requestId: "r6", type: "chunk", text: "partial" }));
  act(() => result.current.abort());
  expect(result.current.status).toBe("idle");

  act(() => handler?.({ requestId: "r6", type: "chunk", text: "late" }));
  expect(result.current.state).toEqual(initial);
  expect(result.current.status).toBe("idle");

  act(() => result.current.start());
  act(() => handler?.({ requestId: "r6", type: "chunk", text: "again" }));
  expect(result.current.state.text).toBe("again");
  expect(result.current.status).toBe("streaming");
});

test("ignores events with a different requestId", () => {
  const { result } = renderStream("r3");

  expect(handler).toBeTypeOf("function");

  act(() => handler?.({ requestId: "other", type: "chunk", text: "nope" }));
  act(() => handler?.({ requestId: "other", type: "done" }));

  expect(result.current.state).toEqual(initial);
  expect(result.current.status).toBe("idle");
});
