/* Quick-translate window (P4): layout, translation stream, history, pin. */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { QuickTranslateWindow } from "@/windows/QuickTranslateWindow";
import { PickerWindow } from "@/windows/PickerWindow";
import { createFakePickerApi, renderPicker } from "@/test/picker-harness";
import { createFakeQuickApi, renderQuick } from "@/test/quick-harness";

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
  quickAPI: {},
  pickerAPI: {},
  settingsAPI: {},
}));

function emitStream(event: unknown) {
  for (const listener of [...streamListeners]) listener(event);
}

afterEach(() => {
  vi.restoreAllMocks();
  streamListeners.length = 0;
});

test("renders the source and result columns", async () => {
  const api = createFakeQuickApi();
  renderQuick(<QuickTranslateWindow api={api} />);
  expect(await screen.findByLabelText("源语言")).toBeTruthy();
  expect(screen.getByLabelText("目标语言")).toBeTruthy();
  expect(screen.getByText("原文")).toBeTruthy();
  expect(screen.getByText("译文")).toBeTruthy();
});

test("Ctrl+Enter starts a translation through quick_translate", async () => {
  const api = createFakeQuickApi();
  renderQuick(<QuickTranslateWindow api={api} />);
  const textarea = await screen.findByRole("textbox");
  fireEvent.change(textarea, { target: { value: "hello" } });
  fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

  await waitFor(() => expect(api.calls.some((call) => call.method === "translate")).toBe(true));
  const call = api.calls.find((entry) => entry.method === "translate");
  expect(call?.args[1]).toBe("hello");
});

test("streams the translation into the result column", async () => {
  const api = createFakeQuickApi();
  renderQuick(<QuickTranslateWindow api={api} />);
  const textarea = await screen.findByRole("textbox");
  fireEvent.change(textarea, { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "翻译" }));
  await waitFor(() => expect(api.calls.some((call) => call.method === "translate")).toBe(true));
  const requestId = String(api.calls.find((entry) => entry.method === "translate")?.args[0]);

  act(() => {
    emitStream({ requestId, type: "chunk", text: "你好" });
    emitStream({ requestId, type: "chunk", text: "世界" });
  });
  await waitFor(() => expect(screen.getByTestId("quick-result").textContent).toContain("你好世界"));
});

test("the history overlay lists entries, filters and deletes", async () => {
  const api = createFakeQuickApi();
  renderQuick(<QuickTranslateWindow api={api} />);
  await screen.findByLabelText("源语言");

  fireEvent.click(screen.getByRole("button", { name: "历史" }));
  await waitFor(() => expect(api.calls.some((call) => call.method === "historyList")).toBe(true));
  await waitFor(() => expect(screen.getAllByTestId("history-entry")).toHaveLength(2));

  fireEvent.change(screen.getByLabelText("搜索翻译历史"), { target: { value: "world" } });
  expect(screen.getAllByTestId("history-entry")).toHaveLength(1);

  fireEvent.click(screen.getByLabelText("删除这条翻译历史"));
  await waitFor(() => expect(api.calls.some((call) => call.method === "historyDelete")).toBe(true));
});

test("pin toggles through quick_pin", async () => {
  const api = createFakeQuickApi();
  renderQuick(<QuickTranslateWindow api={api} />);
  await screen.findByLabelText("源语言");
  fireEvent.click(screen.getByLabelText("置顶显示"));
  await waitFor(() => expect(api.calls.some((call) => call.method === "pin")).toBe(true));
  expect(api.calls.find((call) => call.method === "pin")?.args[0]).toBe(true);
});


