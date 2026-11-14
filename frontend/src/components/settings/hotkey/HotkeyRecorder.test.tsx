/* Native capture-phase hotkey recorder (C54–C59, assertions 32–33).
 *
 * The recorder is the one place in the settings window that must not use React
 * synthetic events: the plan/inventory require
 * `window.addEventListener("keydown", handler, true)` with
 * `preventDefault()` + `stopPropagation()`, so the combination can never reach
 * the focused button, a text field or another page shortcut.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { Toaster } from "@/components/ui/toaster";
import { I18nProvider } from "@/lib/i18n";
import { zh } from "@/test/settings-harness";

import {
  HotkeyRecorder,
  type HotkeyRecorderProps,
  type HotkeySaveResult,
} from "./HotkeyRecorder";

function renderRecorder(overrides: Partial<HotkeyRecorderProps> = {}) {
  const props: HotkeyRecorderProps = {
    target: "capture",
    labelKey: "settings.hotkey.captureLabel",
    value: "Win+Shift+X",
    fallback: "Win+Shift+X",
    blocked: false,
    onRecordingChange: vi.fn(),
    onSave: vi.fn(async (): Promise<HotkeySaveResult> => ({ ok: true, shortcut: "Ctrl+Alt+P" })),
    onSaved: vi.fn(),
    ...overrides,
  };
  const view = render(
    <I18nProvider initialLocale="zh">
      <>
        <HotkeyRecorder {...props} />
        <Toaster />
      </>
    </I18nProvider>
  );
  return { ...view, props };
}

function recordButton(): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(zh("settings.hotkey.captureLabel")) });
}

afterEach(() => {
  vi.useRealTimers();
});

test("records with a native capture-phase listener and saves on a complete combo", async () => {
  const onSave = vi.fn(async (): Promise<HotkeySaveResult> => ({
    ok: true,
    shortcut: "Ctrl+Alt+P",
  }));
  renderRecorder({ onSave });

  fireEvent.click(recordButton());
  expect(screen.getByText(/请按下新的快捷键/)).toBeTruthy();
  expect(recordButton().getAttribute("title")).toBe(zh("settings.hotkey.recordingTitle"));

  /* Only modifiers so far: the event is swallowed but the recorder keeps waiting. */
  expect(
    fireEvent.keyDown(window, { key: "Control", code: "ControlLeft", ctrlKey: true })
  ).toBe(false);
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText(/请按下新的快捷键/)).toBeTruthy();

  /* A complete combo is swallowed (capture phase) and saved once. */
  expect(
    fireEvent.keyDown(window, { key: "p", code: "KeyP", ctrlKey: true, altKey: true })
  ).toBe(false);
  await waitFor(() => expect(onSave).toHaveBeenCalledWith("Ctrl+Alt+P"));
  await waitFor(() =>
    expect(screen.getAllByText(zh("settings.toast.hotkeySaved")).length).toBeGreaterThan(0)
  );
});

test("stops the recorded combo from reaching the focused control", () => {
  const onSave = vi.fn(async (): Promise<HotkeySaveResult> => ({ ok: true }));
  renderRecorder({ onSave });
  const button = recordButton();
  fireEvent.click(button);

  const bubbled = vi.fn();
  document.addEventListener("keydown", bubbled);
  fireEvent.keyDown(button, { key: "p", code: "KeyP", ctrlKey: true });
  document.removeEventListener("keydown", bubbled);

  expect(bubbled).not.toHaveBeenCalled();
});

test("keeps recording for bare modifiers and cancels on Escape without saving", () => {
  const onSave = vi.fn(async (): Promise<HotkeySaveResult> => ({ ok: true }));
  const onRecordingChange = vi.fn();
  renderRecorder({
    onSave,
    onRecordingChange,
    value: "Alt+Space",
    fallback: "Alt+Space",
  });

  fireEvent.click(recordButton());
  expect(onRecordingChange).toHaveBeenLastCalledWith(true);
  expect(screen.getByText(/请按下新的快捷键/)).toBeTruthy();

  fireEvent.keyDown(window, { key: "Escape", code: "Escape" });

  expect(onRecordingChange).toHaveBeenLastCalledWith(false);
  expect(screen.getByText("Alt + Space")).toBeTruthy();
  expect(onSave).not.toHaveBeenCalled();
});

test("ignores IME composition and auto-repeat events", () => {
  const onSave = vi.fn(async (): Promise<HotkeySaveResult> => ({ ok: true }));
  renderRecorder({ onSave });

  fireEvent.click(recordButton());
  fireEvent.keyDown(window, {
    key: "p",
    code: "KeyP",
    ctrlKey: true,
    isComposing: true,
  } as KeyboardEventInit);
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText(/请按下新的快捷键/)).toBeTruthy();

  fireEvent.keyDown(window, { key: "p", code: "KeyP", ctrlKey: true, repeat: true });
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText(/请按下新的快捷键/)).toBeTruthy();
});

test("reports an unsupported key and a missing modifier inline, then recovers", async () => {
  const onSave = vi.fn(async (): Promise<HotkeySaveResult> => ({
    ok: true,
    shortcut: "Ctrl+P",
  }));
  renderRecorder({ onSave });

  fireEvent.click(recordButton());
  fireEvent.keyDown(window, { key: "AudioVolumeUp", code: "", ctrlKey: true });
  expect(screen.getByText(zh("settings.error.hotkeyUnsupportedKey"))).toBeTruthy();
  expect(screen.getByText(zh("settings.hint.hotkeySupportedKeys"))).toBeTruthy();

  fireEvent.keyDown(window, { key: "p", code: "KeyP" });
  expect(screen.getByText(zh("settings.error.hotkeyModifierRequired"))).toBeTruthy();
  expect(screen.getByText(zh("settings.hint.hotkeyModifierRequired"))).toBeTruthy();

  fireEvent.keyDown(window, { key: "p", code: "KeyP", ctrlKey: true });
  await waitFor(() => expect(onSave).toHaveBeenCalledWith("Ctrl+P"));
  expect(screen.queryByText(zh("settings.error.hotkeyModifierRequired"))).toBeNull();
});

test("a window blur cancels the recording and detaches the listener", () => {
  const onSave = vi.fn(async (): Promise<HotkeySaveResult> => ({ ok: true }));
  const onRecordingChange = vi.fn();
  renderRecorder({ onSave, onRecordingChange });

  fireEvent.click(recordButton());
  fireEvent.blur(window);

  expect(onRecordingChange).toHaveBeenLastCalledWith(false);
  expect(screen.getByText("Win + Shift + X")).toBeTruthy();

  fireEvent.keyDown(window, { key: "p", code: "KeyP", ctrlKey: true });
  expect(onSave).not.toHaveBeenCalled();
});

test("a failed save keeps the old value and shows the backend error and hint", async () => {
  const onSave = vi.fn(
    async (): Promise<HotkeySaveResult> => ({
      ok: false,
      error: "冲突",
      hint: "换一个组合",
    })
  );
  const onSaved = vi.fn();
  renderRecorder({ onSave, onSaved });

  fireEvent.click(recordButton());
  fireEvent.keyDown(window, { key: "p", code: "KeyP", ctrlKey: true });

  await waitFor(() => expect(screen.getByText("冲突")).toBeTruthy());
  expect(screen.getByText("换一个组合")).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByText("Win + Shift + X")).toBeTruthy();
});

test("falls back to the generic save error when the backend sends no message", async () => {
  const onSave = vi.fn(async (): Promise<HotkeySaveResult> => ({ ok: false }));
  renderRecorder({ onSave });

  fireEvent.click(recordButton());
  fireEvent.keyDown(window, { key: "p", code: "KeyP", ctrlKey: true });

  await waitFor(() =>
    expect(screen.getByText(zh("settings.error.hotkeySave"))).toBeTruthy()
  );
});

test("restore default submits the fallback combination", async () => {
  const onSave = vi.fn(async (): Promise<HotkeySaveResult> => ({
    ok: true,
    shortcut: "Win+Shift+X",
  }));
  renderRecorder({ onSave, value: "Ctrl+P" });

  fireEvent.click(
    screen.getByRole("button", {
      name: zh("settings.hotkey.restoreAriaWithValue", { shortcut: "Win + Shift + X" }),
    })
  );

  await waitFor(() => expect(onSave).toHaveBeenCalledWith("Win+Shift+X"));
});

test("disables the buttons while recording and while a save is in flight", async () => {
  let resolveSave: (result: HotkeySaveResult) => void = () => {};
  const onSave = vi.fn(
    () =>
      new Promise<HotkeySaveResult>((resolve) => {
        resolveSave = resolve;
      })
  );
  const onSaved = vi.fn();
  renderRecorder({ onSave, onSaved });

  fireEvent.click(recordButton());
  const restore = screen.getByRole("button", {
    name: zh("settings.hotkey.restoreAriaWithValue", { shortcut: "Win + Shift + X" }),
  });
  expect(restore).toBeDisabled();

  fireEvent.keyDown(window, { key: "p", code: "KeyP", ctrlKey: true });
  expect(screen.getByText(zh("settings.hotkey.saving"))).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: zh("settings.hotkey.savingAriaWithLabel", {
        label: zh("settings.hotkey.captureLabel"),
      }),
    })
  ).toBeDisabled();
  expect(restore).toBeDisabled();

  /* A second combo while the first save is pending is ignored. */
  fireEvent.keyDown(window, { key: "q", code: "KeyQ", ctrlKey: true });
  expect(onSave).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveSave({ ok: true, shortcut: "Ctrl+Alt+P" });
  });
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith("Ctrl+Alt+P"));
});

test("a blocked recorder cannot start, and unloading drops the listener", () => {
  const onSave = vi.fn(async (): Promise<HotkeySaveResult> => ({ ok: true }));
  const blockedView = renderRecorder({ blocked: true, onSave });
  expect(recordButton()).toBeDisabled();
  fireEvent.click(recordButton());
  expect(screen.queryByText(/请按下新的快捷键/)).toBeNull();
  blockedView.unmount();

  const { unmount } = renderRecorder({ onSave });
  fireEvent.click(recordButton());
  unmount();
  fireEvent.keyDown(window, { key: "p", code: "KeyP", ctrlKey: true });
  expect(onSave).not.toHaveBeenCalled();
});

test("the quick target uses its own label and success toast", async () => {
  const onSave = vi.fn(async (): Promise<HotkeySaveResult> => ({
    ok: true,
    shortcut: "Ctrl+Alt+K",
  }));
  renderRecorder({
    target: "quick",
    labelKey: "settings.hotkey.quickLabel",
    value: "",
    fallback: "Alt+Space",
    onSave,
  });

  expect(screen.getByText("Alt + Space")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(zh("settings.hotkey.quickLabel")) })
  );
  fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true, altKey: true });

  await waitFor(() => expect(onSave).toHaveBeenCalledWith("Ctrl+Alt+K"));
  await waitFor(() =>
    expect(
      screen.getAllByText(zh("settings.toast.quickHotkeySaved")).length
    ).toBeGreaterThan(0)
  );
});
