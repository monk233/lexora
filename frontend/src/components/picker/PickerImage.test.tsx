/* Screenshot payloads (Task 7): picker-image opens the shared result panel. */
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

function openImage(api: ReturnType<typeof createFakePickerApi>, action: string, label: string) {
  api.emitData({ text: "", config: { skills: ["translate"] } });
  act(() => {
    api.emitImage({
      requestId: "capture-1",
      action,
      label,
      targetLang: "auto",
      clipboard: true,
    });
  });
}

test("an OCR payload opens a plain-text panel without the language selector", async () => {
  const api = createFakePickerApi();
  renderPicker(<PickerWindow api={api} />);
  openImage(api, "ocr", "提取文字");

  await waitFor(() => expect(screen.getByTestId("picker-panel")).toBeTruthy());
  expect(screen.getByTestId("panel-title").textContent).toBe("提取文字");
  expect(screen.queryByLabelText("目标语言")).toBeNull();

  act(() => {
    emitStream({ requestId: "capture-1", type: "chunk", text: "识别结果" });
    emitStream({ requestId: "capture-1", type: "done" });
  });
  await waitFor(() =>
    expect(screen.getByTestId("panel-markdown").textContent).toContain("识别结果")
  );
});

test("a translate payload shows the language selector and follows the resolved target", async () => {
  const api = createFakePickerApi();
  renderPicker(<PickerWindow api={api} />);
  openImage(api, "translate", "翻译");

  await waitFor(() => expect(screen.getByLabelText("目标语言")).toBeTruthy());
  act(() => {
    emitStream({ requestId: "capture-1", type: "target", targetLang: "en" });
    emitStream({ requestId: "capture-1", type: "chunk", text: "translated" });
  });
  await waitFor(() =>
    expect(screen.getByTestId("panel-markdown").textContent).toContain("translated")
  );
});

test("retry on an image panel goes through capture_retry", async () => {
  const api = createFakePickerApi();
  renderPicker(<PickerWindow api={api} />);
  openImage(api, "explain", "解释图片");

  await waitFor(() => expect(screen.getByTestId("picker-panel")).toBeTruthy());
  act(() => {
    emitStream({ requestId: "capture-1", type: "error", message: "识别失败" });
  });
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  fireEvent.click(screen.getAllByLabelText("重试")[0]);

  await waitFor(() =>
    expect(api.calls.some((call) => call.method === "captureRetry")).toBe(true)
  );
});
