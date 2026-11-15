/* Capture annotation integration (P5b): toolbar appears with a selection and
 * drives the ported canvas engine. */
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

function createFakeCaptureApi(): FakeCaptureApi {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
  return {
    calls,
    monitor: async () => ({
      ok: true,
      dataUrl: "data:image/png;base64,AAAA",
      width: 800,
      height: 600,
    }),
    ready: async () => ({ ok: true }),
    copy: async (index: number, rect: unknown, annotations: unknown[]) => {
      record("copy", index, rect, annotations);
      return { ok: true };
    },
    pin: async (...args: unknown[]) => {
      record("pin", ...args);
      return { ok: true };
    },
    longshot: async () => ({ ok: true }),
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

async function selectArea() {
  const overlay = screen.getByTestId("capture-overlay");
  fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 320, clientY: 280 });
  await waitFor(() => expect(screen.getByTestId("capture-selection")).toBeTruthy());
}

test("a selection reveals the annotation toolbar", async () => {
  const api = createFakeCaptureApi();
  render(<CaptureWindow index={0} api={api} />);
  await screen.findByTestId("capture-shot");
  await selectArea();
  expect(screen.getByTestId("annotation-toolbar")).toBeTruthy();
  for (const label of ["形状", "箭头", "画笔", "文字", "序号", "马赛克"]) {
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
  }
});

test("picking a tool arms the annotation canvas", async () => {
  const api = createFakeCaptureApi();
  render(<CaptureWindow index={0} api={api} />);
  await screen.findByTestId("capture-shot");
  await selectArea();

  const canvas = screen.getByTestId("capture-annotations") as HTMLCanvasElement;
  expect(canvas.hidden).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "箭头" }));
  await waitFor(() => expect(canvas.hidden).toBe(false));
  expect(canvas.style.pointerEvents).toBe("auto");
});

test("shape sub-modes and stroke width are adjustable", async () => {
  const api = createFakeCaptureApi();
  render(<CaptureWindow index={0} api={api} />);
  await screen.findByTestId("capture-shot");
  await selectArea();

  fireEvent.click(screen.getByRole("button", { name: "形状" }));
  const circle = screen.getByRole("button", { name: "◯" });
  fireEvent.click(circle);
  expect(circle.getAttribute("aria-pressed")).toBe("true");

  const width = screen.getByLabelText("width") as HTMLInputElement;
  fireEvent.change(width, { target: { value: "8" } });
  expect(width.value).toBe("8");
});

test("copy forwards the current annotation list", async () => {
  const api = createFakeCaptureApi();
  render(<CaptureWindow index={0} api={api} />);
  await screen.findByTestId("capture-shot");
  await selectArea();

  fireEvent.click(screen.getByRole("button", { name: "复制" }));
  await waitFor(() => expect(api.calls.some((call) => call.method === "copy")).toBe(true));
  const call = api.calls.find((entry) => entry.method === "copy");
  expect(Array.isArray(call?.args[2])).toBe(true);
});
