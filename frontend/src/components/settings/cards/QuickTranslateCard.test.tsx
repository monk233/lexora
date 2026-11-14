/* Quick translate card (C48–C53, assertions 34–35).
 *
 * Mounted through the real settings window: the card consumes the shared form
 * store and the prompt editors' IME-safe debounce, so writes are asserted on
 * the fake bridge's call log and the visible textarea value.
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
  vi.useRealTimers();
});

function updateCalls(api: FakeSettingsApi): unknown[] {
  return api.calls
    .filter((call) => call.method === "updateSettings")
    .map((call) => call.args[0]);
}

function advance(ms: number): Promise<void> {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/* Every prompt-bearing card (picker skills) also renders "编辑提示词" buttons,
 * so editor queries are scoped to this card's section. */
function quickCard(): HTMLElement {
  return screen.getByRole("region", { name: zh("settings.quick.title") });
}

function editorButtons(): HTMLElement[] {
  return within(quickCard()).getAllByRole("button", {
    name: zh("settings.action.editPrompt"),
  });
}

test("toggles quick translate immediately and echoes the stored enabled flag", async () => {
  const { api, unmount } = await renderSettingsWindow();
  const toggle = screen.getByRole("switch", { name: zh("settings.quick.enabled") });
  expect(toggle).toBeChecked();

  fireEvent.click(toggle);
  await act(async () => {});

  expect(updateCalls(api)).toContainEqual({ quick: { enabled: false } });
  unmount();

  await renderSettingsWindow({
    state: makeState({ settings: { quick: { enabled: false } } }),
  });
  expect(screen.getByRole("switch", { name: zh("settings.quick.enabled") })).not.toBeChecked();
});

test("prefills the builtin default and normalizes a default-equal draft to an empty override", async () => {
  vi.useFakeTimers();
  const { api } = await renderSettingsWindow();
  const defaultPrompt = makeState().promptDefaults.quickTranslate;

  fireEvent.click(editorButtons()[0]);
  const area = screen.getByRole("textbox", {
    name: zh("settings.quick.promptLabel"),
  }) as HTMLTextAreaElement;
  expect(area.value).toBe(defaultPrompt);
  expect(area.rows).toBe(6);
  expect(area.getAttribute("maxlength")).toBe("4000");

  fireEvent.change(area, { target: { value: `  ${defaultPrompt}  ` } });
  await advance(500);
  expect(updateCalls(api).at(-1)).toEqual({ quick: { prompt: "" } });
});

test("saves each prompt slot to its own field and flushes on blur", async () => {
  vi.useFakeTimers();
  const { api } = await renderSettingsWindow();

  fireEvent.click(editorButtons()[0]);
  const paragraph = screen.getByRole("textbox", {
    name: zh("settings.quick.promptLabel"),
  });
  fireEvent.change(paragraph, { target: { value: "段落自定义 {target}" } });
  fireEvent.blur(paragraph);
  await act(async () => {});
  expect(updateCalls(api).at(-1)).toEqual({ quick: { prompt: "段落自定义 {target}" } });

  fireEvent.click(editorButtons()[1]);
  const word = screen.getByRole("textbox", {
    name: zh("settings.quick.wordPromptLabel"),
  }) as HTMLTextAreaElement;
  const wordDefault = makeState().promptDefaults.quickTranslateWordLookup;
  expect(word.value).toBe(wordDefault);

  fireEvent.change(word, { target: { value: "单词自定义 {source}" } });
  await advance(500);
  expect(updateCalls(api).at(-1)).toEqual({
    quick: { wordLookupPrompt: "单词自定义 {source}" },
  });
});

test("reset writes an empty override for each slot and toasts", async () => {
  const { api } = await renderSettingsWindow({
    state: makeState({ settings: { quick: { prompt: "custom" } } }),
  });

  fireEvent.click(editorButtons()[0]);
  const paragraphEditor = screen.getByTestId("prompt-editor-quick-prompt");
  const paragraphArea = within(paragraphEditor).getByRole("textbox") as HTMLTextAreaElement;
  expect(paragraphArea.value).toBe("custom");
  fireEvent.change(paragraphArea, { target: { value: "unsaved draft" } });
  fireEvent.click(
    within(paragraphEditor).getByRole("button", {
      name: zh("settings.quick.resetPrompt"),
    })
  );
  await act(async () => {});

  expect(updateCalls(api).at(-1)).toEqual({ quick: { prompt: "" } });
  /* The discarded draft must not resurface: reset falls back to the default. */
  expect(
    (within(paragraphEditor).getByRole("textbox") as HTMLTextAreaElement).value
  ).toBe(makeState().promptDefaults.quickTranslate);
  expect(screen.getByText(zh("settings.toast.promptReset"))).toBeTruthy();

  fireEvent.click(editorButtons()[1]);
  const wordEditor = screen.getByTestId("prompt-editor-quick-word-prompt");
  fireEvent.click(
    within(wordEditor).getByRole("button", { name: zh("settings.quick.resetPrompt") })
  );
  await act(async () => {});
  expect(updateCalls(api).at(-1)).toEqual({ quick: { wordLookupPrompt: "" } });
});

test("clearing the history needs a second click within four seconds", async () => {
  vi.useFakeTimers();
  const api = createFakeSettingsApi(makeState(), { live: true });
  await renderSettingsWindow({ api });

  const button = within(quickCard()).getByRole("button", {
    name: zh("settings.quick.clearHistory"),
  });
  fireEvent.click(button);
  expect(
    within(quickCard()).getByRole("button", { name: zh("settings.quick.confirmClear") })
  ).toBeTruthy();
  expect(api.calls).not.toContainEqual({ method: "clearQuickHistory", args: [] });

  await advance(4000);
  expect(
    within(quickCard()).getByRole("button", { name: zh("settings.quick.clearHistory") })
  ).toBeTruthy();

  fireEvent.click(button);
  fireEvent.click(
    within(quickCard()).getByRole("button", { name: zh("settings.quick.confirmClear") })
  );
  await act(async () => {});

  expect(api.calls).toContainEqual({ method: "clearQuickHistory", args: [] });
  expect(screen.getByText(zh("settings.quick.toast.historyCleared"))).toBeTruthy();
});

test("preview mode shows the unsupported-API error inline and never calls the command", async () => {
  const api = createFakeSettingsApi(makeState(), { live: false });
  await renderSettingsWindow({ api });

  fireEvent.click(
    within(quickCard()).getByRole("button", { name: zh("settings.quick.clearHistory") })
  );
  fireEvent.click(
    within(quickCard()).getByRole("button", { name: zh("settings.quick.confirmClear") })
  );
  await act(async () => {});

  expect(screen.getByText(zh("settings.quick.error.apiUnsupported"))).toBeTruthy();
  expect(api.calls).not.toContainEqual({ method: "clearQuickHistory", args: [] });
});

test("a rejected clear keeps the user informed with the backend error", async () => {
  const api = createFakeSettingsApi(makeState(), {
    live: true,
    clearQuickHistory: async () => ({ ok: false, error: "disk" }),
  });
  await renderSettingsWindow({ api });

  fireEvent.click(
    within(quickCard()).getByRole("button", { name: zh("settings.quick.clearHistory") })
  );
  fireEvent.click(
    within(quickCard()).getByRole("button", { name: zh("settings.quick.confirmClear") })
  );
  await act(async () => {});

  expect(
    screen.getByText(zh("settings.quick.error.clearFailed", { error: "disk" }))
  ).toBeTruthy();
});

test("an armed clear re-localizes its confirm label after a language switch", async () => {
  vi.useFakeTimers();
  const { api } = await renderSettingsWindow();

  fireEvent.click(
    within(quickCard()).getByRole("button", { name: zh("settings.quick.clearHistory") })
  );
  act(() => {
    api.emitState(makeState({ app: { locale: "en" } }));
  });

  expect(
    screen.getByRole("button", {
      name: translate("en", "settings.quick.confirmClear"),
    })
  ).toBeTruthy();
  expect(screen.getByRole("switch", { name: translate("en", "settings.quick.enabled") })).toBeTruthy();
});
