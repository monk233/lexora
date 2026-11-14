/* Shortcuts card (C54–C59, assertions 32–33, D16).
 *
 * Mounted through the real settings window: the card consumes the shared form
 * store, so writes are asserted on the fake bridge's command log and the two
 * recorders are exercised through real capture-phase keydown events.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { translate } from "@/lib/i18n";
import type { FakeSettingsApi } from "@/test/settings-harness";
import {
  createFakeSettingsApi,
  makeState,
  renderSettingsWindow,
  zh,
} from "@/test/settings-harness";

afterEach(() => {
  vi.restoreAllMocks();
});

function shortcutsCard(): HTMLElement {
  return screen.getByRole("region", { name: zh("settings.card.shortcuts.title") });
}

function recorder(target: "capture" | "quick"): HTMLButtonElement {
  const node = within(shortcutsCard())
    .getAllByRole("button")
    .find((button) => button.getAttribute("data-target") === target);
  if (!node) throw new Error(`recorder ${target} not found`);
  return node as HTMLButtonElement;
}

function restoreButton(shortcut: string): HTMLElement {
  return within(shortcutsCard()).getByRole("button", {
    name: zh("settings.hotkey.restoreAriaWithValue", { shortcut }),
  });
}

function hotkeyCalls(api: FakeSettingsApi): string[] {
  return api.calls
    .filter(
      (call) => call.method === "setCaptureHotkey" || call.method === "setQuickHotkey"
    )
    .map((call) => `${call.method}:${String(call.args[0])}`);
}

test("renders both recorders with their defaults and static hints", async () => {
  await renderSettingsWindow({ api: createFakeSettingsApi(makeState()) });

  expect(recorder("capture").textContent).toBe("Win + Shift + X");
  expect(recorder("quick").textContent).toBe("Alt + Space");
  /* C54/C57 field hints stay visible below the control. */
  expect(within(shortcutsCard()).getByText(zh("settings.hint.captureHotkey"))).toBeTruthy();
  expect(within(shortcutsCard()).getByText(zh("settings.hint.quickHotkey"))).toBeTruthy();
});

test("empty stored shortcuts fall back to the default labels", async () => {
  await renderSettingsWindow({
    state: makeState({
      settings: { capture: { regionShortcut: "" }, quick: { hotkey: "" } },
    }),
  });

  expect(recorder("capture").textContent).toBe("Win + Shift + X");
  expect(recorder("quick").textContent).toBe("Alt + Space");
});

test("saves the screenshot shortcut through capture_set_hotkey, not update_settings", async () => {
  const api = createFakeSettingsApi(makeState());
  await renderSettingsWindow({ api });

  fireEvent.click(recorder("capture"));
  fireEvent.keyDown(window, { key: "p", code: "KeyP", ctrlKey: true, altKey: true });

  await vi.waitFor(() =>
    expect(hotkeyCalls(api)).toContain("setCaptureHotkey:Ctrl+Alt+P")
  );
  expect(api.calls.filter((call) => call.method === "updateSettings")).toHaveLength(0);
  await vi.waitFor(() => expect(recorder("capture").textContent).toBe("Ctrl + Alt + P"));
  await screen.findAllByText(zh("settings.toast.hotkeySaved"));
});

test("saves the quick-translate shortcut through quick_set_hotkey", async () => {
  const api = createFakeSettingsApi(makeState());
  await renderSettingsWindow({ api });

  fireEvent.click(recorder("quick"));
  fireEvent.keyDown(window, { key: "j", code: "KeyJ", ctrlKey: true, shiftKey: true });

  await vi.waitFor(() =>
    expect(hotkeyCalls(api)).toContain("setQuickHotkey:Ctrl+Shift+J")
  );
  await vi.waitFor(() => expect(recorder("quick").textContent).toBe("Ctrl + Shift + J"));
  await screen.findAllByText(zh("settings.toast.quickHotkeySaved"));
});

test("restore default submits each target's fallback combination", async () => {
  const api = createFakeSettingsApi(
    makeState({
      settings: {
        capture: { regionShortcut: "Ctrl+Alt+P" },
        quick: { hotkey: "Ctrl+Alt+K" },
      },
    })
  );
  await renderSettingsWindow({ api });

  fireEvent.click(restoreButton("Win + Shift + X"));
  await vi.waitFor(() =>
    expect(hotkeyCalls(api)).toContain("setCaptureHotkey:Win+Shift+X")
  );
  fireEvent.click(restoreButton("Alt + Space"));
  await vi.waitFor(() => expect(hotkeyCalls(api)).toContain("setQuickHotkey:Alt+Space"));
});

test("only one recorder can be armed at a time", async () => {
  const api = createFakeSettingsApi(makeState());
  await renderSettingsWindow({ api });

  fireEvent.click(recorder("capture"));
  expect(recorder("capture").disabled).toBe(false);
  expect(recorder("quick").disabled).toBe(true);
  expect(recorder("capture").getAttribute("data-recording")).toBe("true");

  fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
  expect(recorder("quick").disabled).toBe(false);
  expect(recorder("capture").getAttribute("data-recording")).toBe("false");
});

test("a rejected save keeps the old display and shows the backend message inline", async () => {
  const api = createFakeSettingsApi(makeState(), {
    setCaptureHotkey: async () => ({
      ok: false,
      error: "快捷键被占用",
      hint: "换一个组合",
    }),
  });
  await renderSettingsWindow({ api });

  fireEvent.click(recorder("capture"));
  fireEvent.keyDown(window, { key: "p", code: "KeyP", ctrlKey: true });

  await vi.waitFor(() => expect(screen.getByText("快捷键被占用")).toBeTruthy());
  expect(screen.getByText("换一个组合")).toBeTruthy();
  /* C59: the display falls back to the previous combination. */
  expect(recorder("capture").textContent).toBe("Win + Shift + X");
});

test("the aria labels follow a language switch, including while recording", async () => {
  const api = createFakeSettingsApi(makeState());
  await renderSettingsWindow({ api });

  fireEvent.click(recorder("capture"));
  act(() => {
    api.emitState(makeState({ app: { locale: "en" } }));
  });

  /* The card title and every label re-localize in the same pass. */
  const enCard = screen.getByRole("region", {
    name: translate("en", "settings.card.shortcuts.title"),
  });
  const capture = within(enCard)
    .getAllByRole("button")
    .find((button) => button.getAttribute("data-target") === "capture") as HTMLElement;

  expect(capture.getAttribute("aria-label")).toBe(
    translate("en", "settings.hotkey.recordingAriaWithLabel", {
      label: translate("en", "settings.hotkey.captureLabel"),
    })
  );
  /* Both English hints share the same copy, so assert on the count. */
  expect(
    within(enCard).getAllByText(translate("en", "settings.hint.captureHotkey")).length
  ).toBeGreaterThan(0);

  fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
  expect(capture.getAttribute("aria-label")).toBe(
    translate("en", "settings.hotkey.currentAriaWithLabel", {
      label: translate("en", "settings.hotkey.captureLabel"),
      shortcut: "Win + Shift + X",
    })
  );
});
