/* Pinned image window (P4): load, zoom, drag, copy, close. */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { render } from "@testing-library/react";

import { PinWindow } from "@/windows/PinWindow";
import type { PinApi } from "@/hooks/usePinBridge";

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface FakePinApi extends PinApi {
  calls: { method: string; args: unknown[] }[];
}

function createFakePinApi(dataUrl = "data:image/png;base64,AAAA"): FakePinApi {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
  };
  return {
    calls,
    ready: async (id: string) => {
      record("ready", id);
      return { ok: true, dataUrl };
    },
    drag: async (id: string, dx: number, dy: number) => {
      record("drag", id, dx, dy);
      return { ok: true };
    },
    zoom: async (id: string, zoom: number) => {
      record("zoom", id, zoom);
      return { ok: true };
    },
    copy: async (id: string) => {
      record("copy", id);
      return { ok: true };
    },
    close: async (id: string) => {
      record("close", id);
      return { ok: true };
    },
    editWindow: async (id: string, editing: boolean) => {
      record("editWindow", id, editing);
      return { ok: true };
    },
    exportAnnotations: async (id: string, annotations: unknown[], apply: boolean) => {
      record("exportAnnotations", id, annotations, apply);
      return { ok: true };
    },
    onClose: () => () => undefined,
  } as FakePinApi;
}

test("loads the pinned image through pin_ready", async () => {
  const api = createFakePinApi();
  render(<PinWindow id="pin-1" api={api} />);
  await waitFor(() => expect(api.calls.some((call) => call.method === "ready")).toBe(true));
  const image = await screen.findByTestId("pin-image");
  expect(image.getAttribute("src")).toContain("data:image/png");
});

test("wheel zoom reports the new zoom through pin_zoom", async () => {
  const api = createFakePinApi();
  render(<PinWindow id="pin-2" api={api} />);
  await screen.findByTestId("pin-image");

  fireEvent.wheel(window, { deltaY: 100 });
  await waitFor(() => expect(api.calls.some((call) => call.method === "zoom")).toBe(true));
  const zoomCall = api.calls.find((call) => call.method === "zoom");
  expect(Number(zoomCall?.args[1])).toBeGreaterThanOrEqual(0.15);
});

test("dragging the image sends logical deltas", async () => {
  const api = createFakePinApi();
  render(<PinWindow id="pin-3" api={api} />);
  const image = await screen.findByTestId("pin-image");

  fireEvent.mouseDown(image, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.mouseMove(window, { clientX: 30, clientY: 25 });
  expect(api.calls.some((call) => call.method === "drag")).toBe(true);
  const dragCall = api.calls.find((call) => call.method === "drag");
  expect(dragCall?.args.slice(1)).toEqual([20, 15]);
});

test("copy and close call their commands", async () => {
  const api = createFakePinApi();
  render(<PinWindow id="pin-4" api={api} />);
  await screen.findByTestId("pin-image");

  fireEvent.click(screen.getByLabelText("复制图片"));
  await waitFor(() => expect(api.calls.some((call) => call.method === "copy")).toBe(true));

  fireEvent.click(screen.getByLabelText("关闭（Esc）"));
  await waitFor(() => expect(api.calls.some((call) => call.method === "close")).toBe(true));
});

test("a failed load shows the error state", async () => {
  const api = {
    calls: [],
    ready: async () => ({ ok: false, error: "pin", hint: "hint" }),
    onClose: () => () => undefined,
  } as unknown as FakePinApi;
  render(<PinWindow id="pin-5" api={api} />);
  await waitFor(() => expect(screen.getByTestId("pin-error")).toBeTruthy());
});


test("edit mode arms the annotation canvas and exports on confirm", async () => {
  const api = createFakePinApi();
  render(<PinWindow id="pin-6" api={api} />);
  await screen.findByTestId("pin-image");

  fireEvent.click(screen.getByLabelText("编辑"));
  await waitFor(() => expect(screen.getByTestId("pin-annotations").hidden).toBe(false));

  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await waitFor(() =>
    expect(api.calls.some((call) => call.method === "exportAnnotations")).toBe(true)
  );
  const call = api.calls.find((entry) => entry.method === "exportAnnotations");
  expect(call?.args[2]).toBe(true);
});
