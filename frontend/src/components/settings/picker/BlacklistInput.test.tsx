/* Blacklist chips editor (C46/C47, assertion 28).
 *
 * Legacy rules: Enter adds, blur adds, an empty input removes the last entry on
 * Backspace, entries dedupe case-insensitively after dropping a trailing
 * `.exe`, a single entry is capped at 120 chars and the list at 200.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Toaster } from "@/components/ui/toaster";
import { BlacklistInput } from "@/components/settings/picker/BlacklistInput";
import { I18nProvider } from "@/lib/i18n";
import { zh } from "@/test/settings-harness";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  /* Drain the 3.6s toast removal queue so the module store starts empty. */
  act(() => {
    vi.advanceTimersByTime(4000);
  });
  cleanup();
  vi.useRealTimers();
});

function renderInput(entries: string[]) {
  const onChange = vi.fn();
  const view = render(
    <I18nProvider initialLocale="zh">
      <BlacklistInput entries={entries} onChange={onChange} />
      <Toaster />
    </I18nProvider>
  );
  const input = screen.getByPlaceholderText(zh("settings.placeholder.blacklist"));
  return { onChange, input, ...view };
}

test("adds on Enter, on blur, dedupes case and .exe, and removes the last entry on empty Backspace", () => {
  const { onChange, input } = renderInput(["Chrome.exe"]);

  fireEvent.change(input, { target: { value: "notepad" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith(["Chrome.exe", "notepad"]);

  fireEvent.change(input, { target: { value: "chrome" } });
  fireEvent.blur(input);
  /* A duplicate is silently dropped (the input clears without a write), so the
   * last emitted patch is still the previous add. */
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenLastCalledWith(["Chrome.exe", "notepad"]);

  fireEvent.keyDown(input, { key: "Backspace" });
  expect(onChange).toHaveBeenLastCalledWith([]);
});

test("blank input never adds and Backspace keeps an empty list empty", () => {
  const { onChange, input } = renderInput([]);
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.blur(input);
  fireEvent.keyDown(input, { key: "Backspace" });
  expect(onChange).not.toHaveBeenCalled();
});

test("a process name longer than 120 chars is rejected with a toast", () => {
  const { onChange, input } = renderInput([]);
  fireEvent.change(input, { target: { value: "x".repeat(121) } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByText(zh("settings.error.processNameTooLong"))).toBeTruthy();
});

test("a full list of 200 entries rejects the next one with a toast", () => {
  const entries = Array.from({ length: 200 }, (_, index) => `app-${index}`);
  const { onChange, input } = renderInput(entries);
  fireEvent.change(input, { target: { value: "one-more" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByText(zh("settings.error.blacklistFull"))).toBeTruthy();
});

test("chips expose a localized remove button", () => {
  const { onChange, input } = renderInput(["Chrome.exe", "WeChat.exe"]);
  expect(screen.getByText("Chrome.exe")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: zh("settings.aria.removeBlacklist", { name: "Chrome.exe" }) }));
  expect(onChange).toHaveBeenCalledWith(["WeChat.exe"]);
  fireEvent.change(input, { target: { value: "notepad" } });
});
