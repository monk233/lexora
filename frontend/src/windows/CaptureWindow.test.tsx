/* Capture overlay (P5a): screenshot, selection, action bar. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { CaptureWindow } from "@/windows/CaptureWindow";
import type { CaptureApi } from "@/hooks/useCaptureBridge";

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface FakeCaptureApi extends CaptureApi {
  calls: { method: string; args: unknown[] }[];
}

function createFakeCaptureApi(monitor: unknown = {
  ok: true,
  dataUrl: "data:image/png;base64,AAAA",
  width: 800,
  height: 600,
}): FakeCaptureApi {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
  return {
    calls,
    monitor: async (index: number) => {
      record("monitor", index);
      return monitor as never;
    },
    ready: async (index: number) => {
      record("ready", index);
      return { ok: true };
    },
    copy: async (index: number, rect: unknown) => {
      record("copy", index, rect);
      return { ok: true };
    },
    pin: async (index: number, rect: unknown) => {
      record("pin", index, rect);
      return { ok: true };
    },
    longshot: async (index: number, rect: unknown) => {
      record("longshot", index, rect);
      return { ok: true };
    },
    skill: async (...args: unknown[]) => {
      record("skill", ...args);
      return { ok: true };
    },
    close: async () => {
      record("close");
      return { ok: true };
    },
  } as FakeCaptureApi;
}

function selectArea() {
  const overlay = screen.getByTestId("capture-overlay");
  fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 300, clientY: 260 });
  return overlay;
}

test("shows the frozen screenshot and hints selection", async () => {
  const api = createFakeCaptureApi();
  render(<CaptureWindow index={0} api={api} />);
  await waitFor(() => expect(api.calls.some((call) => call.method === "monitor")).toBe(true));
  expect(screen.getByTestId("capture-shot").getAttribute("src")).toContain("data:image/png");
  expect(screen.getByText("点击窗口选择 · 拖动框选 · Esc 取消")).toBeTruthy();
});

test("dragging creates a selection and reveals the action bar", async () => {
  const api = createFakeCaptureApi();
  render(<CaptureWindow index={0} api={api} />);
  await screen.findByTestId("capture-shot");

  selectArea();
  await waitFor(() => expect(screen.getByTestId("capture-selection")).toBeTruthy());
  expect(screen.getByTestId("capture-toolbar")).toBeTruthy();
});

test("copy sends the selection rectangle", async () => {
  const api = createFakeCaptureApi();
  render(<CaptureWindow index={0} api={api} />);
  await screen.findByTestId("capture-shot");
  selectArea();
  await waitFor(() => expect(screen.getByTestId("capture-toolbar")).toBeTruthy());

  fireEvent.click(screen.getByRole("button", { name: "复制" }));
  await waitFor(() => expect(api.calls.some((call) => call.method === "copy")).toBe(true));
  const call = api.calls.find((entry) => entry.method === "copy");
  expect(call?.args[1]).toEqual({ x: 100, y: 100, width: 200, height: 160 });
});

test("capture skills go through capture_skill", async () => {
  const api = createFakeCaptureApi();
  render(<CaptureWindow index={0} api={api} />);
  await screen.findByTestId("capture-shot");
  selectArea();
  await waitFor(() => expect(screen.getByTestId("capture-toolbar")).toBeTruthy());

  fireEvent.click(screen.getByRole("button", { name: "提取文字" }));
  await waitFor(() => expect(api.calls.some((call) => call.method === "skill")).toBe(true));
  const call = api.calls.find((entry) => entry.method === "skill");
  expect(call?.args[3]).toBe("ocr");
});

test("Escape cancels the capture session", async () => {
  const api = createFakeCaptureApi();
  render(<CaptureWindow index={0} api={api} />);
  await screen.findByTestId("capture-shot");

  fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
  await waitFor(() => expect(api.calls.some((call) => call.method === "close")).toBe(true));
});

test("a failed monitor shows the error state", async () => {
  const api = createFakeCaptureApi({ ok: false, error: "截图失败", hint: "重试" });
  render(<CaptureWindow index={0} api={api} />);
  await waitFor(() => expect(screen.getByTestId("capture-error")).toBeTruthy());
  expect(screen.getByText("截图失败")).toBeTruthy();
});
