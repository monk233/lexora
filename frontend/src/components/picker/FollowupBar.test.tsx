/* Follow-up rounds (Task 6). */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { PickerWindow } from "@/windows/PickerWindow";
import { createFakePickerApi, renderPicker } from "@/test/picker-harness";

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

afterEach(() => {
  vi.restoreAllMocks();
  streamListeners.length = 0;
});

async function openPanel() {
  const api = createFakePickerApi();
  renderPicker(<PickerWindow api={api} />);
  act(() => {
    api.emitData({
      text: "Hello",
      config: { skills: ["translate"], defaultTargetLang: "auto", suggestionsAvailable: true },
    });
  });
  fireEvent.click(await screen.findByLabelText("翻译"));
  await waitFor(() => expect(api.calls.some((call) => call.method === "translate")).toBe(true));
  const requestId = String(api.calls.find((call) => call.method === "translate")?.args[0]);
  act(() => {
    emitStream({ requestId, type: "chunk", text: "主回答" });
    emitStream({ requestId, type: "done" });
  });
  await waitFor(() => expect(screen.getByTestId("panel-markdown").textContent).toContain("主回答"));
  return { api, requestId };
}

test("a completed answer offers the follow-up input", async () => {
  await openPanel();
  expect(screen.getByTestId("followup-bar")).toBeTruthy();
  expect(screen.getByTestId("followup-input")).toBeTruthy();
});

test("sending a question starts a follow-up request and appends the round", async () => {
  const { api } = await openPanel();

  fireEvent.change(screen.getByTestId("followup-input"), {
    target: { value: "这是什么意思？" },
  });
  fireEvent.click(screen.getByTestId("followup-send"));

  await waitFor(() => expect(api.calls.some((call) => call.method === "followup")).toBe(true));
  const followupCall = api.calls.find((call) => call.method === "followup");
  expect(followupCall?.args[3]).toBe("这是什么意思？");
  const followupId = String(followupCall?.args[0]);

  act(() => {
    emitStream({ requestId: followupId, type: "chunk", text: "这是追问回答" });
  });
  await waitFor(() =>
    expect(screen.getByTestId("followup-stream").textContent).toContain("这是追问回答")
  );

  act(() => {
    emitStream({ requestId: followupId, type: "done" });
  });
  await waitFor(() => expect(screen.getByTestId("followup-round")).toBeTruthy());
  expect(screen.getByTestId("followup-round").textContent).toContain("这是追问回答");
});

test("the follow-up bar is hidden without suggestion support", async () => {
  const api = createFakePickerApi();
  renderPicker(<PickerWindow api={api} />);
  act(() => {
    api.emitData({
      text: "Hello",
      config: { skills: ["translate"], defaultTargetLang: "auto", suggestionsAvailable: false },
    });
  });
  fireEvent.click(await screen.findByLabelText("翻译"));
  await waitFor(() => expect(api.calls.some((call) => call.method === "translate")).toBe(true));
  const requestId = String(api.calls.find((call) => call.method === "translate")?.args[0]);
  act(() => {
    emitStream({ requestId, type: "chunk", text: "回答" });
    emitStream({ requestId, type: "done" });
  });
  await waitFor(() =>
    expect(screen.getByTestId("panel-markdown").textContent).toContain("回答")
  );
  expect(screen.queryByTestId("followup-bar")).toBeNull();
});
