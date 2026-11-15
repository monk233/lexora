/* Overflow menu + dismissal semantics (Tasks 9/10). */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { PickerWindow } from "@/windows/PickerWindow";
import { createFakePickerApi, renderPickerWindow } from "@/test/picker-harness";

const streamListeners = vi.hoisted(() => [] as ((payload: unknown) => void)[]);

vi.mock("@/lib/tauri-api.js", () => ({
  subscribe: (_name: string, handler: (payload: unknown) => void) => {
    streamListeners.push(handler);
    return () => {
      const index = streamListeners.indexOf(handler);
      if (index >= 0) streamListeners.splice(index, 1);
    };
  },
  currentWebviewTarget: () => undefined,
  pickerAPI: {},
  settingsAPI: {},
  quickAPI: {},
}));

function emitStream(event: unknown) {
  for (const listener of [...streamListeners]) listener(event);
}

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  vi.restoreAllMocks();
  streamListeners.length = 0;
});

test("the more menu lists configuration entries and runs them", async () => {
  const api = createFakePickerApi();
  renderPickerWindow(<PickerWindow api={api} />);
  api.emitData({ text: "hi", programName: "Notepad", config: { skills: ["translate"] } });

  fireEvent.click(await screen.findByRole("button", { name: "更多" }));
  expect(screen.getByTestId("picker-menu")).toBeTruthy();

  fireEvent.click(screen.getByRole("menuitem", { name: "在此应用中禁用" }));
  await waitFor(() =>
    expect(
      api.calls.some(
        (call) => call.method === "disableInApp" && call.args[0] === "Notepad"
      )
    ).toBe(true)
  );
});

test("Escape closes the open panel through picker_close", async () => {
  const api = createFakePickerApi();
  renderPickerWindow(<PickerWindow api={api} />);
  api.emitData({ text: "hello", config: { skills: ["translate"], defaultTargetLang: "auto" } });

  fireEvent.click(await screen.findByLabelText("翻译"));
  await waitFor(() => expect(screen.getByTestId("picker-panel")).toBeTruthy());

  act(() => {
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
  });
  await vi.waitFor(() =>
    expect(api.calls.some((call) => call.method === "close")).toBe(true)
  );
  await vi.waitFor(() => expect(screen.queryByTestId("picker-panel")).toBeNull());
});

test("the toolbar surface keeps rendering after a panel would close", async () => {
  const api = createFakePickerApi();
  renderPickerWindow(<PickerWindow surface="toolbar" api={api} />);
  api.emitData({ text: "hi", config: { skills: ["translate"] } });

  await waitFor(() => expect(screen.getByRole("toolbar")).toBeTruthy());
  act(() => {
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
  });
  expect(api.calls.some((call) => call.method === "close")).toBe(false);
});


