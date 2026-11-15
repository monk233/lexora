/* Picker panel flow (Task 5): skill run → stream → stop/retry/copy.
 *
 * `useStream` subscribes through `@/lib/tauri-api.js` directly (not through the
 * injected bridge), so the stream event layer is mocked here while the bridge
 * stays the fake from the harness.
 */
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

function setup(text = "Hello world") {
  const api = createFakePickerApi();
  renderPickerWindow(<PickerWindow api={api} />);
  api.emitData({
    text,
    programName: "Notepad",
    config: {
      skills: ["translate", "summarize", "read", "copy"],
      defaultTargetLang: "auto",
      suggestionsAvailable: false,
    },
  });
  return api;
}

function requestIdOf(api: ReturnType<typeof createFakePickerApi>, method = "translate"): string {
  const call = api.calls.find((entry) => entry.method === method);
  return String(call?.args[0] ?? "");
}

test("running a text skill opens the panel and streams the result", async () => {
  const api = setup();
  fireEvent.click(await screen.findByLabelText("翻译"));

  await waitFor(() => expect(api.calls.some((call) => call.method === "translate")).toBe(true));
  expect(screen.getByTestId("picker-panel")).toBeTruthy();
  expect(screen.getByTestId("panel-title").textContent).toBe("翻译");

  const requestId = requestIdOf(api);
  act(() => {
    emitStream({ requestId, type: "chunk", text: "你好" });
    emitStream({ requestId, type: "chunk", text: "世界" });
  });
  await waitFor(() => expect(screen.getByTestId("panel-markdown").textContent).toContain("你好世界"));

  act(() => {
    emitStream({ requestId, type: "done", elapsedMs: 1200 });
  });
  await waitFor(() =>
    expect((screen.getByLabelText("停止") as HTMLButtonElement).disabled).toBe(true)
  );
});

test("stop keeps the partial output and ignores late chunks", async () => {
  const api = setup();
  fireEvent.click(await screen.findByLabelText("翻译"));
  await waitFor(() => expect(api.calls.some((call) => call.method === "translate")).toBe(true));
  const requestId = requestIdOf(api);

  act(() => {
    emitStream({ requestId, type: "chunk", text: "部分译文" });
  });
  await waitFor(() => expect(screen.getByTestId("panel-markdown").textContent).toContain("部分译文"));

  fireEvent.click(screen.getByLabelText("停止"));
  await waitFor(() => expect(api.calls.some((call) => call.method === "abortTranslate")).toBe(true));
  expect(screen.getByText("已停止生成")).toBeTruthy();

  act(() => {
    emitStream({ requestId, type: "chunk", text: "迟到" });
    emitStream({ requestId, type: "done" });
  });
  expect(screen.getByTestId("panel-markdown").textContent).toContain("部分译文");
  expect(screen.getByTestId("panel-markdown").textContent).not.toContain("迟到");
});

test("errors render inline with a retry entry", async () => {
  const api = setup();
  fireEvent.click(await screen.findByLabelText("翻译"));
  await waitFor(() => expect(api.calls.some((call) => call.method === "translate")).toBe(true));
  const requestId = requestIdOf(api);

  act(() => {
    emitStream({ requestId, type: "error", message: "网络错误", hint: "检查网络" });
  });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("网络错误"));
  expect(screen.getByText("检查网络")).toBeTruthy();

  const before = api.calls.filter((call) => call.method === "translate").length;
  fireEvent.click(screen.getByText("重试"));
  await waitFor(() =>
    expect(api.calls.filter((call) => call.method === "translate").length).toBe(before + 1)
  );
});

test("copy sends the streamed text to the bridge", async () => {
  const api = setup();
  fireEvent.click(await screen.findByLabelText("翻译"));
  await waitFor(() => expect(api.calls.some((call) => call.method === "translate")).toBe(true));
  const requestId = requestIdOf(api);

  act(() => {
    emitStream({ requestId, type: "chunk", text: "要复制的内容" });
  });
  await waitFor(() => expect(screen.getByTestId("panel-markdown").textContent).toContain("要复制的内容"));

  fireEvent.click(screen.getByLabelText("复制"));
  await waitFor(() =>
    expect(api.calls.some((call) => call.method === "copy" && call.args[0] === "要复制的内容")).toBe(
      true
    )
  );
});

test("the toolbar surface delegates panel skills to the shell", async () => {
  const api = createFakePickerApi();
  renderPickerWindow(<PickerWindow surface="toolbar" api={api} />);
  api.emitData({ text: "Hello", config: { skills: ["translate"], defaultTargetLang: "auto" } });

  fireEvent.click(await screen.findByLabelText("翻译"));
  await waitFor(() =>
    expect(api.calls.some((call) => call.method === "runToolbarSkill")).toBe(true)
  );
  expect(api.calls.some((call) => call.method === "translate")).toBe(false);
});



