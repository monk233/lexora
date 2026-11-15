/* Long-shot windows (P5c): preview image and control bar. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const progressListeners = vi.hoisted(() => [] as ((payload: unknown) => void)[]);
const stateResult = vi.hoisted(() => ({
  ok: true,
  dataUrl: "data:image/png;base64,AAAA",
  width: 800,
  height: 1200,
  frames: 2,
}));
const calls = vi.hoisted(() => [] as { method: string; args: unknown[] }[]);

vi.mock("@/lib/tauri-api.js", () => {
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const ok = () => ({ ok: true });
  return {
    longshotAPI: {
      ready: async (index: number) => {
        record("ready", index);
        return ok();
      },
      state: async () => {
        record("state");
        return stateResult;
      },
      preview: async () => {
        record("preview");
        return ok();
      },
      previewReady: async () => {
        record("previewReady");
        return ok();
      },
      autoscroll: async (enabled: boolean) => {
        record("autoscroll", enabled);
        return ok();
      },
      direction: async (direction: string) => {
        record("direction", direction);
        return ok();
      },
      finish: async () => {
        record("finish");
        return ok();
      },
      cancel: async () => {
        record("cancel");
        return ok();
      },
      onStarted: () => () => undefined,
      onProgress: (callback: (payload: unknown) => void) => {
        progressListeners.push(callback);
        return () => {
          const index = progressListeners.indexOf(callback);
          if (index >= 0) progressListeners.splice(index, 1);
        };
      },
      onCancelled: () => () => undefined,
    },
    subscribe: () => () => undefined,
    currentWebviewTarget: () => undefined,
    pickerAPI: {},
    settingsAPI: {},
    quickAPI: {},
    captureAPI: {},
    pinAPI: {},
  };
});

import { LongshotWindow } from "@/windows/LongshotWindow";
import { LongshotBarWindow } from "@/windows/LongshotBarWindow";

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
  calls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("the preview shows the stitched image from longshot_state", async () => {
  render(<LongshotWindow />);
  await waitFor(() => expect(screen.getByTestId("longshot-image")).toBeTruthy());
  expect(screen.getByTestId("longshot-image").getAttribute("src")).toContain("data:image/png");
});

test("the bar switches direction through longshot_direction", async () => {
  render(<LongshotBarWindow />);
  fireEvent.click(screen.getByRole("button", { name: "横向" }));
  await waitFor(() => expect(calls.some((call) => call.method === "direction")).toBe(true));
  expect(calls.find((call) => call.method === "direction")?.args[0]).toBe("horizontal");
});

test("the bar toggles auto-scroll", async () => {
  render(<LongshotBarWindow />);
  fireEvent.click(screen.getByRole("button", { name: "自动滚动" }));
  await waitFor(() => expect(calls.some((call) => call.method === "autoscroll")).toBe(true));
  expect(calls.find((call) => call.method === "autoscroll")?.args[0]).toBe(true);
});

test("the bar cancels and finishes", async () => {
  render(<LongshotBarWindow />);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(calls.some((call) => call.method === "cancel")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "完成" }));
  await waitFor(() => expect(calls.some((call) => call.method === "finish")).toBe(true));
});

test("progress events update the status line", async () => {
  render(<LongshotBarWindow />);
  await waitFor(() => expect(screen.getByTestId("longshot-bar")).toBeTruthy());
  for (const listener of [...progressListeners]) {
    listener({ frames: 5, width: 800, height: 3200 });
  }
  await waitFor(() =>
    expect(screen.getByTestId("longshot-status").textContent).toContain("5")
  );
  expect(screen.getByTestId("longshot-status").textContent).toContain("3200");
});
