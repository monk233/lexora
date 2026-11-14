/* Online API panel (C05–C15).
 *
 * One-shot commands (`list_online_models` / `test_online`) are spied on the
 * module-level bridge wrapper; settings writes always go through the harness'
 * fake `SettingsApi` and are asserted on `api.calls`.
 */
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { translate, type TParams } from "@/lib/i18n";
import { settingsApi } from "@/lib/settings/api";
import { presetPatch } from "@/lib/settings/presets";
import { MODEL_NONE, modelPatch } from "@/components/settings/cards/provider/OnlinePanel";
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

function openSelect(name: string): void {
  fireEvent.click(screen.getByRole("combobox", { name }));
}

function field(key: string, params?: TParams): string {
  return zh(key, params);
}

function clickButton(key: string): void {
  fireEvent.click(screen.getByRole("button", { name: zh(key) }));
}

function testBadge(): HTMLElement {
  return screen.getByTestId("test-badge");
}

test("switching presets saves the preset patch and drops fetched models", async () => {
  const listSpy = vi
    .spyOn(settingsApi, "listOnlineModels")
    .mockResolvedValue({ ok: true, models: ["m1", "m2", "m3"] });

  const { api } = await renderSettingsWindow({
    state: makeState({ settings: { provider: { online: { model: "", apiKey: "" } } } }),
  });

  clickButton("settings.action.fetchModels");
  await act(async () => {});
  expect(listSpy).toHaveBeenCalledTimes(1);

  openSelect(field("settings.field.modelName"));
  expect(screen.getByRole("option", { name: "m1" })).toBeTruthy();
  fireEvent.click(screen.getByRole("option", { name: "m1" }));
  await act(async () => {});

  openSelect(field("settings.field.providerPreset"));
  fireEvent.click(
    screen.getByRole("option", { name: field("settings.preset.openai.label") })
  );
  await act(async () => {});
  expect(updateCalls(api)).toContainEqual(presetPatch("openai"));

  openSelect(field("settings.field.modelName"));
  expect(screen.queryByRole("option", { name: "m1" })).toBeNull();
  expect(screen.getByRole("option", { name: field("settings.action.customModel") })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("option", { name: field("settings.onlineModel.none") })
  );
  await act(async () => {});

  openSelect(field("settings.field.providerPreset"));
  fireEvent.click(
    screen.getByRole("option", { name: field("settings.preset.opencode-go.label") })
  );
  await act(async () => {});
  expect(updateCalls(api)).toContainEqual(presetPatch("opencode-go"));
});

test("blocks fetch and test until the base url is a real http(s) url", async () => {
  const listSpy = vi.spyOn(settingsApi, "listOnlineModels");
  const testSpy = vi.spyOn(settingsApi, "testOnline");

  await renderSettingsWindow({
    state: makeState({ settings: { provider: { online: { baseUrl: "" } } } }),
  });

  clickButton("settings.action.fetchModels");
  expect(screen.getByText(field("settings.error.baseUrlRequired"))).toBeTruthy();
  expect(listSpy).not.toHaveBeenCalled();

  const urlInput = screen.getByLabelText(field("settings.field.baseUrl"));
  fireEvent.change(urlInput, { target: { value: "ftp://x" } });

  clickButton("settings.action.fetchModels");
  expect(screen.getAllByText(field("settings.error.baseUrlScheme")).length).toBeGreaterThan(0);
  expect(listSpy).not.toHaveBeenCalled();

  clickButton("settings.action.testConnection");
  expect(screen.getAllByText(field("settings.error.baseUrlScheme")).length).toBeGreaterThan(0);
  expect(testSpy).not.toHaveBeenCalled();
});

test("fetches models, reports counts and shows the empty state", async () => {
  const listSpy = vi.spyOn(settingsApi, "listOnlineModels").mockResolvedValue({
    ok: true,
    models: [],
  });

  await renderSettingsWindow({
    state: makeState({ settings: { provider: { online: { apiKey: "k" } } } }),
  });

  clickButton("settings.action.fetchModels");
  await act(async () => {});
  expect(screen.getByText(field("settings.hint.modelsEmpty"))).toBeTruthy();

  listSpy.mockResolvedValue({ ok: true, models: ["m1", "m2", "m3"] });
  clickButton("settings.action.fetchModels");
  await act(async () => {});

  expect(listSpy).toHaveBeenLastCalledWith({
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "k",
  });
  expect(screen.getByText(field("settings.hint.modelsLoaded", { count: 3 }))).toBeTruthy();

  openSelect(field("settings.field.modelName"));
  expect(screen.getByRole("option", { name: "m1" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "m2" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "m3" })).toBeTruthy();
  expect(
    screen.getByRole("option", {
      name: field("settings.onlineModel.current", { model: "deepseek-chat" }),
    })
  ).toBeTruthy();
});

test("shows the backend error and hint when fetching fails", async () => {
  vi.spyOn(settingsApi, "listOnlineModels").mockResolvedValue({
    ok: false,
    models: [],
    error: "boom",
    hint: "h",
  });

  await renderSettingsWindow();
  clickButton("settings.action.fetchModels");
  await act(async () => {});

  expect(screen.getByText("boom")).toBeTruthy();
  expect(screen.getByText("h")).toBeTruthy();
});

test("writes the chosen model and maps the none sentinel", async () => {
  expect(modelPatch(MODEL_NONE)).toEqual({ provider: { online: { model: "" } } });
  expect(modelPatch("m1")).toEqual({ provider: { online: { model: "m1" } } });

  vi.spyOn(settingsApi, "listOnlineModels").mockResolvedValue({
    ok: true,
    models: ["m1"],
  });

  const { api } = await renderSettingsWindow();
  clickButton("settings.action.fetchModels");
  await act(async () => {});

  openSelect(field("settings.field.modelName"));
  fireEvent.click(screen.getByRole("option", { name: "m1" }));
  await act(async () => {});
  expect(updateCalls(api)).toContainEqual({ provider: { online: { model: "m1" } } });
});

test("renders the none sentinel for the empty model state", async () => {
  await renderSettingsWindow({
    state: makeState({ settings: { provider: { online: { model: "" } } } }),
  });

  const trigger = screen.getByRole("combobox", { name: field("settings.field.modelName") });
  expect(trigger.textContent).toBe(field("settings.onlineModel.none"));
});

test("keeps a saved model that is missing from the fetched list", async () => {
  await renderSettingsWindow({
    state: makeState({ settings: { provider: { online: { model: "gpt-x" } } } }),
  });

  openSelect(field("settings.field.modelName"));
  expect(
    screen.getByRole("option", {
      name: field("settings.onlineModel.current", { model: "gpt-x" }),
    })
  ).toBeTruthy();
});

test("custom model mode focuses the input and never writes an empty model", async () => {
  vi.useFakeTimers();
  const { api } = await renderSettingsWindow({
    state: makeState({ settings: { provider: { online: { model: "deepseek-chat" } } } }),
  });

  openSelect(field("settings.field.modelName"));
  fireEvent.click(
    screen.getByRole("option", { name: field("settings.action.customModel") })
  );

  const input = screen.getByLabelText(field("settings.field.customModelName"));
  expect(document.activeElement).toBe(input);
  expect(updateCalls(api)).toEqual([]);

  fireEvent.change(input, { target: { value: "gpt-4o-custom" } });
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(updateCalls(api)).toContainEqual({
    provider: { online: { model: "gpt-4o-custom" } },
  });

  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  expect(screen.queryByLabelText(field("settings.field.customModelName"))).toBeNull();
  expect(
    updateCalls(api).some((patch) => JSON.stringify(patch) === '{"provider":{"online":{"model":""}}}')
  ).toBe(false);
});

test("clearing the custom model then blurring cancels the pending draft", async () => {
  vi.useFakeTimers();
  const { api } = await renderSettingsWindow({
    state: makeState({ settings: { provider: { online: { model: "deepseek-chat" } } } }),
  });

  openSelect(field("settings.field.modelName"));
  fireEvent.click(
    screen.getByRole("option", { name: field("settings.action.customModel") })
  );

  const input = screen.getByLabelText(field("settings.field.customModelName"));
  fireEvent.change(input, { target: { value: "gpt-4o-custom" } });
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(updateCalls(api)).toContainEqual({
    provider: { online: { model: "gpt-4o-custom" } },
  });

  const callsBeforeClear = updateCalls(api).length;

  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  expect(screen.queryByLabelText(field("settings.field.customModelName"))).toBeNull();

  /* The 500ms debounce armed by the empty change must not fire after the blur. */
  await act(async () => {
    vi.advanceTimersByTime(600);
  });
  const lateModelPatches = updateCalls(api)
    .slice(callsBeforeClear)
    .filter((patch) => {
      const model = (patch as { provider?: { online?: { model?: unknown } } }).provider
        ?.online?.model;
      return typeof model === "string" && model !== "";
    });
  expect(lateModelPatches).toEqual([]);

  /* Picking custom mode again pre-fills the stored model, not an empty draft. */
  openSelect(field("settings.field.modelName"));
  fireEvent.click(
    screen.getByRole("option", { name: field("settings.action.customModel") })
  );
  const reopened = screen.getByLabelText(
    field("settings.field.customModelName")
  ) as HTMLInputElement;
  expect(reopened.value).toBe("gpt-4o-custom");
});

test("shows the latency badge, model count and missing-model warning", async () => {
  const spy = vi.spyOn(settingsApi, "testOnline").mockResolvedValue({
    ok: true,
    latencyMs: 1234,
    models: ["a", "b", "c"],
  });

  await renderSettingsWindow({
    state: makeState({ settings: { provider: { online: { model: "deepseek-chat" } } } }),
  });

  clickButton("settings.action.testConnection");
  await act(async () => {});

  expect(spy).toHaveBeenCalledWith({
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-chat",
    timeoutMs: 60000,
  });
  expect(testBadge().textContent).toBe(
    [
      field("settings.status.connected"),
      "1234 ms",
      field("settings.hint.modelsAvailable", { count: 3 }),
    ].join(" · ")
  );
  expect(testBadge().getAttribute("data-tone")).toBe("ok");
  expect(
    screen.getByText(field("settings.error.modelMissing", { model: "deepseek-chat" }))
  ).toBeTruthy();
});

test("omits the missing-model warning when the model is in the list", async () => {
  vi.spyOn(settingsApi, "testOnline").mockResolvedValue({
    ok: true,
    latencyMs: 42,
    models: ["deepseek-chat", "other"],
  });

  await renderSettingsWindow();
  clickButton("settings.action.testConnection");
  await act(async () => {});

  expect(
    screen.queryByText(field("settings.error.modelMissing", { model: "deepseek-chat" }))
  ).toBeNull();
});

test("renders the failed connection badge plus the backend error and hint", async () => {
  vi.spyOn(settingsApi, "testOnline").mockResolvedValue({
    ok: false,
    error: "boom",
    hint: "h",
  });

  await renderSettingsWindow();
  clickButton("settings.action.testConnection");
  await act(async () => {});

  expect(testBadge().textContent).toBe(field("settings.badge.connectionFailed"));
  expect(testBadge().getAttribute("data-tone")).toBe("error");
  expect(screen.getByText("boom")).toBeTruthy();
  expect(screen.getByText("h")).toBeTruthy();
});

test("toggles the api key visibility and keeps focus in the input", async () => {
  await renderSettingsWindow();
  const keyInput = screen.getByLabelText(field("settings.field.apiKey")) as HTMLInputElement;
  expect(keyInput.type).toBe("password");

  const show = screen.getByRole("button", { name: field("settings.apiKey.show") });
  expect(show.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(show);

  expect(keyInput.type).toBe("text");
  const hide = screen.getByRole("button", { name: field("settings.apiKey.hide") });
  expect(hide.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(keyInput);

  fireEvent.click(hide);
  expect(keyInput.type).toBe("password");
});

test("trims the base url but keeps the api key verbatim", async () => {
  vi.useFakeTimers();
  const { api } = await renderSettingsWindow();

  const keyInput = screen.getByLabelText(field("settings.field.apiKey"));
  fireEvent.change(keyInput, { target: { value: "  sk-1  " } });
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(updateCalls(api)).toContainEqual({ provider: { online: { apiKey: "  sk-1  " } } });

  const urlInput = screen.getByLabelText(field("settings.field.baseUrl"));
  fireEvent.change(urlInput, { target: { value: " https://x/v1 " } });
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(updateCalls(api)).toContainEqual({
    provider: { online: { baseUrl: "https://x/v1" } },
  });
});

test("re-renders preset, sentinel and action copy after a language switch", async () => {
  const { api } = await renderSettingsWindow({
    state: makeState({ settings: { provider: { online: { model: "" } } } }),
  });

  act(() => {
    api.emitState(
      makeState({
        app: { locale: "en" },
        settings: { provider: { online: { model: "" } } },
      })
    );
  });

  const en = (key: string, params?: TParams): string => translate("en", key, params);
  expect(screen.getByRole("button", { name: en("settings.action.fetchModels") })).toBeTruthy();
  expect(screen.getByRole("button", { name: en("settings.action.testConnection") })).toBeTruthy();

  openSelect(en("settings.field.providerPreset"));
  const openai = screen.getByRole("option", { name: en("settings.preset.openai.label") });
  expect(openai).toBeTruthy();
  fireEvent.click(openai);
  await act(async () => {});

  openSelect(en("settings.field.modelName"));
  expect(
    screen.getByRole("option", { name: en("settings.onlineModel.none") })
  ).toBeTruthy();
  expect(
    screen.getByRole("option", { name: en("settings.action.customModel") })
  ).toBeTruthy();
});
