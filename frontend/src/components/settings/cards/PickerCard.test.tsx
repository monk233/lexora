/* Picker behavior card scaffold (C32–C35, C45–C47, assertions 19–28).
 *
 * Mounted through the real settings window so the card sees the same store the
 * production page does; writes are asserted on the fake bridge's call log.
 */
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { FakeSettingsApi } from "@/test/settings-harness";
import { makeState, renderSettingsWindow, zh } from "@/test/settings-harness";

/* jsdom gaps that Radix Select / Popper touch while opening the listbox. */
beforeEach(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (!("ResizeObserver" in globalThis)) {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function updateCalls(api: FakeSettingsApi): unknown[] {
  return api.calls
    .filter((call) => call.method === "updateSettings")
    .map((call) => call.args[0]);
}

function field(key: string): string {
  return zh(key);
}

test("saves the enable switch, compact switch and panel mode immediately", async () => {
  const { api } = await renderSettingsWindow();

  fireEvent.click(screen.getByRole("switch", { name: field("settings.field.pickerEnabled") }));
  await act(async () => {});
  expect(updateCalls(api)).toContainEqual({ picker: { enabled: false } });

  fireEvent.click(screen.getByRole("switch", { name: field("settings.field.compactMode") }));
  await act(async () => {});
  expect(updateCalls(api)).toContainEqual({ picker: { compact: false } });

  const scroll = screen.getByRole("button", { name: field("settings.panelMode.scroll") });
  expect(screen.getByRole("button", { name: field("settings.panelMode.auto") })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  fireEvent.click(scroll);
  await act(async () => {});
  expect(updateCalls(api)).toContainEqual({ picker: { panelMode: "scroll" } });
  expect(scroll).toHaveAttribute("aria-pressed", "true");
});

test("shows tab counts and switches lists", async () => {
  await renderSettingsWindow({
    state: makeState({ settings: { picker: { captureSkills: ["pin", "ocr"] } } }),
  });

  expect(screen.getByRole("tab", { name: /文字技能/ })).toBeTruthy();
  expect(screen.getByRole("tab", { name: /图片技能.*2/ })).toBeTruthy();
  expect(screen.queryByTestId("skill-list-image")).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: /图片技能/ }));
  expect(screen.getByTestId("skill-list-image")).toBeTruthy();
  expect(screen.queryByTestId("skill-list-text")).toBeNull();
  expect(screen.getByRole("tab", { name: /图片技能/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: /图片技能/ })).toHaveAttribute(
    "aria-controls",
    "skill-list-image"
  );
});

test("target language list has 39 options with auto first", async () => {
  const { api } = await renderSettingsWindow();

  fireEvent.click(screen.getByRole("combobox", { name: field("settings.field.defaultTargetLang") }));
  const options = screen.getAllByRole("option");
  expect(options).toHaveLength(39);
  expect(options[0]).toHaveTextContent(zh("settings.targetLang.auto"));

  fireEvent.click(options[1]!);
  expect(updateCalls(api)).toContainEqual({ picker: { defaultTargetLang: "zh" } });
});

test("an unknown stored target language falls back to auto", async () => {
  await renderSettingsWindow({
    state: makeState({ settings: { picker: { defaultTargetLang: "not-a-language" } } }),
  });

  const trigger = screen.getByRole("combobox", { name: field("settings.field.defaultTargetLang") });
  expect(trigger).toHaveTextContent(zh("settings.targetLang.auto"));
});

test("the search skill expands the engine radio group and saves the choice", async () => {
  const { api } = await renderSettingsWindow();

  fireEvent.click(screen.getByRole("button", { name: field("settings.action.configureSearch") }));
  const radios = screen.getAllByRole("radio");
  expect(radios).toHaveLength(3);
  expect(screen.getByRole("radio", { name: zh("settings.aria.searchWith", { engine: zh("settings.searchEngine.google") }) })).toHaveAttribute(
    "aria-checked",
    "true"
  );

  fireEvent.click(
    screen.getByRole("radio", {
      name: zh("settings.aria.searchWith", { engine: zh("settings.searchEngine.baidu") }),
    })
  );
  expect(updateCalls(api)).toContainEqual({ picker: { searchEngine: "baidu" } });
});

test("renders blacklist chips and removes an entry", async () => {
  const { api } = await renderSettingsWindow({
    state: makeState({ settings: { picker: { blacklist: ["Chrome.exe", "WeChat.exe"] } } }),
  });

  expect(screen.getByText("Chrome.exe")).toBeTruthy();
  expect(screen.getByText("WeChat.exe")).toBeTruthy();

  fireEvent.click(
    screen.getByRole("button", {
      name: zh("settings.aria.removeBlacklist", { name: "Chrome.exe" }),
    })
  );
  expect(updateCalls(api)).toContainEqual({ picker: { blacklist: ["WeChat.exe"] } });
});

test("adds a blacklist entry through the card field", async () => {
  const { api } = await renderSettingsWindow();

  const input = screen.getByPlaceholderText(zh("settings.placeholder.blacklist"));
  fireEvent.change(input, { target: { value: "Notepad.exe" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(updateCalls(api)).toContainEqual({ picker: { blacklist: ["Notepad.exe"] } });
});
