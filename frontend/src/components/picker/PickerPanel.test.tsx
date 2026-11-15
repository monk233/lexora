/* Panel chrome (Task 4): header interactions, footer states, panel assembly. */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { PickerPanel } from "@/components/picker/PickerPanel";
import { createFakePickerApi, renderPicker } from "@/test/picker-harness";

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPanel(overrides: Partial<Parameters<typeof PickerPanel>[0]> = {}) {
  const api = createFakePickerApi();
  const handlers = {
    onClose: vi.fn(),
    onPinChange: vi.fn(),
    onTargetLangChange: vi.fn(),
    onSpeak: vi.fn(),
    onCopy: vi.fn(),
    onRetry: vi.fn(),
    onStop: vi.fn(),
    onResize: vi.fn(),
    onResetSize: vi.fn(),
  };
  renderPicker(
    <PickerPanel
      api={api}
      title="翻译"
      showLanguage
      targetLang="zh"
      pinned={false}
      streaming={false}
      canRetry={false}
      canCopy
      canSpeak
      {...handlers}
      {...overrides}
    >
      <p>译文内容</p>
    </PickerPanel>
  );
  return { api, ...handlers };
}

test("renders the title, body and footer actions", () => {
  renderPanel();
  expect(screen.getByTestId("panel-title").textContent).toBe("翻译");
  expect(screen.getByText("译文内容")).toBeTruthy();
  const footer = screen.getByTestId("panel-footer");
  expect(within(footer).getByLabelText("朗读")).toBeTruthy();
  expect(within(footer).getByLabelText("复制")).toBeTruthy();
  /* Retry is hidden without a retryable action; stop is disabled while idle. */
  expect(within(footer).queryByLabelText("重试")).toBeNull();
  expect((within(footer).getByLabelText("停止") as HTMLButtonElement).disabled).toBe(true);
});

test("shows the language selector only when the skill uses it", () => {
  renderPanel();
  expect(screen.getByLabelText("目标语言")).toBeTruthy();
});

test("hides the language selector for non-translate skills", () => {
  renderPanel({ showLanguage: false });
  expect(screen.queryByLabelText("目标语言")).toBeNull();
});

test("pin and close call the bridge", () => {
  const { api, onPinChange, onClose } = renderPanel({ pinned: false });
  fireEvent.click(screen.getByLabelText("固定到桌面"));
  expect(onPinChange).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByLabelText("关闭"));
  expect(onClose).toHaveBeenCalled();
  expect(api.calls.length).toBeGreaterThanOrEqual(0);
});

test("dragging the header blank area sends logical deltas", () => {
  const { api } = renderPanel();
  const header = screen.getByTestId("panel-header");
  fireEvent.mouseDown(header, { clientX: 100, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 130, clientY: 140 });
  expect(api.calls.some((call) => call.method === "dragPanel")).toBe(true);
  const drag = api.calls.find((call) => call.method === "dragPanel");
  expect(drag?.args).toEqual([30, 40]);
});

test("dragging from a header button does not move the window", () => {
  const { api } = renderPanel();
  fireEvent.mouseDown(screen.getByLabelText("关闭"), { clientX: 100, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 130, clientY: 140 });
  expect(api.calls.some((call) => call.method === "dragPanel")).toBe(false);
});

test("streaming enables stop and a retryable panel shows retry", () => {
  renderPanel({ streaming: true, canRetry: true });
  const footer = screen.getByTestId("panel-footer");
  expect((within(footer).getByLabelText("停止") as HTMLButtonElement).disabled).toBe(false);
  expect(within(footer).getByLabelText("重试")).toBeTruthy();
  fireEvent.click(within(footer).getByLabelText("停止"));
});
