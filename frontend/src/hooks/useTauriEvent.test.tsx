import { render } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useTauriEvent } from "./useTauriEvent";

const subscribe = vi.fn().mockReturnValue(() => {});

vi.mock("../lib/tauri-api.js", () => ({
  subscribe: (...args: unknown[]) => subscribe(...args),
}));

function Probe() {
  useTauriEvent<{ value: number }>("demo-event", () => {}, "capture-0");
  return null;
}

function HandlerProbe({
  handler,
}: {
  handler: (payload: { value: number }) => void;
}) {
  useTauriEvent<{ value: number }>("demo-event", handler, "capture-0");
  return null;
}

beforeEach(() => {
  subscribe.mockClear();
});

test("subscribes with a pinned webview target", () => {
  render(<Probe />);
  expect(subscribe).toHaveBeenCalledWith(
    "demo-event",
    expect.any(Function),
    { target: { kind: "WebviewWindow", label: "capture-0" } }
  );
});

test("a new handler re-render does not re-subscribe and reaches the latest handler", () => {
  const first = vi.fn();
  const second = vi.fn();
  const { rerender } = render(<HandlerProbe handler={first} />);
  rerender(<HandlerProbe handler={second} />);

  expect(subscribe).toHaveBeenCalledTimes(1);
  const listener = subscribe.mock.calls[0][1] as (payload: { value: number }) => void;
  listener({ value: 1 });
  expect(second).toHaveBeenCalledWith({ value: 1 });
  expect(first).not.toHaveBeenCalled();
});

test("unmount calls the disposer returned by subscribe", () => {
  const dispose = vi.fn();
  subscribe.mockReturnValueOnce(dispose);

  const { unmount } = render(<Probe />);
  unmount();

  expect(dispose).toHaveBeenCalledTimes(1);
});
