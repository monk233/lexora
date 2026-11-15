/* Panel sizing (Task 8): initial window size on open, scroll-mode memory. */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { PANEL_SIZE_KEY, readStoredPanelSize, storePanelSize, availablePanelHeight } from "@/hooks/usePanelAutosize";
import { PickerWindow } from "@/windows/PickerWindow";
import { createFakePickerApi, renderPickerWindow } from "@/test/picker-harness";

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

beforeEach(() => {
  localStorage.clear();
});

async function openPanel(config: Record<string, unknown> = {}) {
  const api = createFakePickerApi();
  renderPickerWindow(<PickerWindow api={api} />);
  act(() => {
    api.emitData({ text: "Hello", config: { skills: ["translate"], defaultTargetLang: "auto", ...config } });
  });
  fireEvent.click(await screen.findByLabelText("翻译"));
  await waitFor(() => expect(api.calls.some((call) => call.method === "translate")).toBe(true));
  return api;
}

test("opening the panel reports the auto-mode window size", async () => {
  const api = await openPanel();
  await waitFor(() => expect(api.calls.some((call) => call.method === "resize")).toBe(true));
  const resize = api.calls.find((call) => call.method === "resize");
  expect(Number(resize?.args[0])).toBe(360);
  expect(Number(resize?.args[1])).toBeGreaterThan(0);
});

test("scroll mode reuses the stored panel size", async () => {
  storePanelSize({ width: 480, height: 400 });
  expect(readStoredPanelSize()).toEqual({ width: 480, height: 400 });

  const api = await openPanel({ panelMode: "scroll" });
  await waitFor(() => expect(api.calls.some((call) => call.method === "resize")).toBe(true));
  const resize = api.calls.find((call) => call.method === "resize");
  expect(Number(resize?.args[0])).toBe(480);
  expect(Number(resize?.args[1])).toBe(400);
});

test("the stored size is clamped by the available screen height", () => {
  const height = availablePanelHeight();
  expect(height).toBeGreaterThan(0);
  expect(height).toBeLessThanOrEqual(760);
});

test("the stored key is the documented one", () => {
  storePanelSize({ width: 400, height: 300 });
  expect(localStorage.getItem(PANEL_SIZE_KEY)).toContain("400");
});


