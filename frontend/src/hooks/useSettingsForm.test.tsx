/* Behavioural tests for the settings draft store (inventory §4 + C01).
 *
 * The probe renders one text field plus the current save-status kind; the fake
 * API mirrors the backend (optimistic patch in, merged state out) so the tests
 * exercise the real queue/status machine without touching Tauri.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { toast } from "@/components/ui/use-toast";
import { deepMerge, type PlainObject } from "@/lib/constants";
import type { SettingsApi } from "@/lib/settings/api";
import type {
  GetStateResult,
  SaveResult,
  Settings,
  SettingsPatch,
  StatePayload,
} from "@/lib/settings/types";

import {
  SettingsFormProvider,
  useSettingsForm,
  useSettingsTextField,
  type SettingsFormApi,
} from "./useSettingsForm";

vi.mock("@/components/ui/use-toast", () => ({ toast: vi.fn() }));

function makeState(baseUrl = "https://server"): StatePayload {
  return {
    settings: {
      provider: { online: { baseUrl } },
      picker: { enabled: true },
      quick: { prompt: "" },
    },
  } as unknown as StatePayload;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createApi(initial: StatePayload) {
  let current = initial;
  let stateListener: ((state: StatePayload) => void) | null = null;
  const offState = vi.fn();
  const offToast = vi.fn();

  const getState = vi.fn(async (): Promise<GetStateResult> => ({ ok: true, state: current }));
  const updateSettings = vi.fn(async (patch: SettingsPatch): Promise<SaveResult> => {
    current = {
      ...current,
      settings: deepMerge(
        current.settings as unknown as PlainObject,
        patch as PlainObject
      ) as unknown as Settings,
    };
    return { ok: true, state: current };
  });

  const ok = vi.fn(async () => ({ ok: true }));

  const api = {
    live: false,
    getState,
    updateSettings,
    resetSettings: vi.fn(async () => ({ ok: true, state: current })),
    testOnline: ok,
    listOnlineModels: vi.fn(async () => ({ ok: true, models: [] })),
    downloadEngine: ok,
    downloadModel: ok,
    cancelDownload: ok,
    importModel: ok,
    removeModel: ok,
    startLocal: ok,
    restartLocal: ok,
    stopLocal: ok,
    openDir: ok,
    openExternal: ok,
    setStartAtLogin: ok,
    setCaptureHotkey: vi.fn(async (shortcut: string) => ({ ok: true, shortcut })),
    setQuickHotkey: vi.fn(async (shortcut: string) => ({ ok: true, shortcut })),
    clearQuickHistory: ok,
    checkUpdate: vi.fn(async () => ({ ok: true })),
    installUpdate: ok,
    notifyUpdateAvailable: ok,
    quit: ok,
    onState: vi.fn((cb: (state: StatePayload) => void) => {
      stateListener = cb;
      return offState;
    }),
    onDownloadProgress: vi.fn(() => vi.fn()),
    onUpdateProgress: vi.fn(() => vi.fn()),
    onUpdateAvailable: vi.fn(() => vi.fn()),
    onToast: vi.fn(() => offToast),
  } as unknown as SettingsApi;

  return {
    api,
    getState,
    updateSettings,
    offState,
    offToast,
    emitState(state: StatePayload) {
      stateListener?.(state);
    },
  };
}

let lastForm: SettingsFormApi | null = null;

function Probe() {
  const form = useSettingsForm();
  lastForm = form;
  const field = useSettingsTextField({
    id: "base-url",
    value: form.settings?.provider.online.baseUrl ?? "",
    build: (value) => ({ provider: { online: { baseUrl: value.trim() } } }),
  });
  const prompt = useSettingsTextField({
    id: "prompt",
    value: form.settings?.quick.prompt ?? "",
    build: (value) => ({ quick: { prompt: value } }),
    multiline: true,
  });
  return (
    <div>
      <input aria-label="base-url" {...field} />
      <textarea aria-label="prompt" {...prompt} />
      <span data-testid="status">{form.status.kind}</span>
    </div>
  );
}

async function flushMicrotasks() {
  await act(async () => {});
}

async function renderProbe(api: SettingsApi, debounceMs = 500) {
  const view = render(
    <SettingsFormProvider api={api} debounceMs={debounceMs}>
      <Probe />
    </SettingsFormProvider>
  );
  await flushMicrotasks();
  return view;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function statusKind(): string | null {
  return screen.getByTestId("status").textContent;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  lastForm = null;
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, "hidden");
});

test("debounces text input by 500ms and trims before saving", async () => {
  const { api, updateSettings } = createApi(makeState());
  await renderProbe(api);
  const input = screen.getByLabelText("base-url");

  fireEvent.change(input, { target: { value: "  https://x  " } });
  await advance(499);
  expect(updateSettings).not.toHaveBeenCalled();

  await advance(1);
  expect(updateSettings).toHaveBeenCalledTimes(1);
  expect(updateSettings.mock.calls[0]?.[0]).toEqual({
    provider: { online: { baseUrl: "https://x" } },
  });
});

test("blur flushes immediately and Enter flushes then blurs", async () => {
  const { api, updateSettings } = createApi(makeState());
  await renderProbe(api);
  const input = screen.getByLabelText("base-url") as HTMLInputElement;

  fireEvent.change(input, { target: { value: "https://blur" } });
  fireEvent.blur(input);
  expect(updateSettings).toHaveBeenCalledTimes(1);
  expect(updateSettings.mock.calls[0]?.[0]).toEqual({
    provider: { online: { baseUrl: "https://blur" } },
  });

  fireEvent.change(input, { target: { value: "https://enter" } });
  fireEvent.keyDown(input, { key: "Enter" });
  // The first request is still in flight, so the queue sends this patch as
  // soon as the previous one settles (never concurrently).
  await flushMicrotasks();
  expect(updateSettings).toHaveBeenCalledTimes(2);
  expect(updateSettings.mock.calls[1]?.[0]).toEqual({
    provider: { online: { baseUrl: "https://enter" } },
  });
  expect(document.activeElement).not.toBe(input);
});

test("window blur and a hidden visibilitychange flush dirty text fields", async () => {
  const { api, updateSettings } = createApi(makeState());
  await renderProbe(api);
  const input = screen.getByLabelText("base-url");

  fireEvent.change(input, { target: { value: "https://window" } });
  act(() => {
    window.dispatchEvent(new Event("blur"));
  });
  expect(updateSettings).toHaveBeenCalledTimes(1);

  fireEvent.change(input, { target: { value: "https://hidden" } });
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flushMicrotasks();
  expect(updateSettings).toHaveBeenCalledTimes(2);
});

test("state-changed never overwrites an uncommitted draft and composition pauses the debounce", async () => {
  const { api, updateSettings, emitState } = createApi(makeState());
  await renderProbe(api);
  const input = screen.getByLabelText("base-url");

  fireEvent.change(input, { target: { value: "draft" } });
  act(() => {
    emitState(makeState("https://server"));
  });
  expect(input).toHaveValue("draft");

  await advance(500);
  expect(updateSettings).toHaveBeenCalledTimes(1);
  const callsAfterSave = updateSettings.mock.calls.length;
  await flushMicrotasks();

  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "draft2" } });
  await advance(1000);
  expect(updateSettings).toHaveBeenCalledTimes(callsAfterSave);
  expect(input).toHaveValue("draft2");
});

test("composition does not arm the debounce timer", async () => {
  const { api, updateSettings } = createApi(makeState());
  await renderProbe(api);
  const input = screen.getByLabelText("base-url");

  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "ime" } });
  expect(vi.getTimerCount()).toBe(0);

  await advance(1000);
  expect(updateSettings).not.toHaveBeenCalled();
  expect(input).toHaveValue("ime");
});

test("composition blocks blur / window-blur flushes and re-arms on compositionend", async () => {
  const { api, updateSettings } = createApi(makeState());
  await renderProbe(api);
  const input = screen.getByLabelText("base-url");

  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "https://ime" } });
  fireEvent.blur(input);
  act(() => {
    window.dispatchEvent(new Event("blur"));
  });
  await advance(1000);
  expect(updateSettings).not.toHaveBeenCalled();

  fireEvent.compositionEnd(input);
  await advance(500);
  expect(updateSettings).toHaveBeenCalledTimes(1);
  expect(updateSettings.mock.calls[0]?.[0]).toEqual({
    provider: { online: { baseUrl: "https://ime" } },
  });
});

test("a save settling during IME composition keeps the draft visible", async () => {
  const { api, updateSettings } = createApi(makeState());
  await renderProbe(api);
  const input = screen.getByLabelText("base-url");

  let resolveSave: ((result: SaveResult) => void) | null = null;
  updateSettings.mockImplementation(
    () =>
      new Promise<SaveResult>((resolve) => {
        resolveSave = resolve;
      })
  );

  fireEvent.change(input, { target: { value: "  https://ime  " } });
  await advance(500);
  expect(updateSettings).toHaveBeenCalledTimes(1);

  fireEvent.compositionStart(input);
  await act(async () => {
    resolveSave?.({ ok: true, state: makeState("https://ime") });
  });
  await flushMicrotasks();

  // I1: the settle must not swap the composing text for the server value.
  expect(input).toHaveValue("  https://ime  ");
  expect(updateSettings).toHaveBeenCalledTimes(1);

  fireEvent.compositionEnd(input);
  await advance(500);
  expect(updateSettings).toHaveBeenCalledTimes(1);
  expect(input).toHaveValue("https://ime");
});

test("a save settling while focused keeps the raw draft until blur", async () => {
  const { api, updateSettings } = createApi(makeState());
  await renderProbe(api);
  const input = screen.getByLabelText("base-url");

  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "  https://focus  " } });
  await advance(500);
  await flushMicrotasks();

  expect(updateSettings).toHaveBeenCalledTimes(1);
  expect(input).toHaveValue("  https://focus  ");

  fireEvent.blur(input);
  await flushMicrotasks();
  expect(updateSettings).toHaveBeenCalledTimes(1);
  expect(input).toHaveValue("https://focus");
});

test("rollback is serialized: a stale get_state cannot overwrite a later save", async () => {
  const { api, updateSettings, getState } = createApi(makeState());
  await renderProbe(api);
  const input = screen.getByLabelText("base-url");

  const rollback = deferred<GetStateResult>();
  getState.mockImplementation(() => rollback.promise);

  let call = 0;
  updateSettings.mockImplementation(async () => {
    call += 1;
    if (call === 1) return { ok: false, error: "boom" };
    return { ok: true, state: makeState("https://new") };
  });

  fireEvent.change(input, { target: { value: "https://old" } });
  fireEvent.blur(input);
  await flushMicrotasks();
  expect(updateSettings).toHaveBeenCalledTimes(1);
  expect(statusKind()).toBe("error");

  fireEvent.change(input, { target: { value: "https://new" } });
  fireEvent.blur(input);
  await flushMicrotasks();
  // The drain is parked on the rollback: the next patch must not be sent yet.
  expect(updateSettings).toHaveBeenCalledTimes(1);

  await act(async () => {
    rollback.resolve({ ok: true, state: makeState("https://server") });
  });
  await flushMicrotasks();
  await flushMicrotasks();

  expect(updateSettings).toHaveBeenCalledTimes(2);
  expect(statusKind()).toBe("saved");
  expect(input).toHaveValue("https://new");
});

test("save status runs saving -> saved -> idle, and a failure keeps the draft", async () => {
  const { api, updateSettings, getState } = createApi(makeState());
  await renderProbe(api);
  const input = screen.getByLabelText("base-url");

  let resolveSave: ((result: SaveResult) => void) | null = null;
  updateSettings.mockImplementation(
    () =>
      new Promise<SaveResult>((resolve) => {
        resolveSave = resolve;
      })
  );

  fireEvent.change(input, { target: { value: "https://slow" } });
  await advance(500);
  expect(statusKind()).toBe("saving");

  await act(async () => {
    resolveSave?.({ ok: true, state: makeState("https://slow") });
  });
  expect(statusKind()).toBe("saved");

  await advance(2200);
  expect(statusKind()).toBe("idle");

  updateSettings.mockResolvedValue({ ok: false, error: "boom" });
  fireEvent.change(input, { target: { value: "https://fail" } });
  await advance(500);
  await flushMicrotasks();

  expect(statusKind()).toBe("error");
  expect(getState).toHaveBeenCalledTimes(2);
  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: expect.stringContaining("boom") })
  );
  // I4 / inventory §4.9: a failed save never discards the user's text.
  expect(input).toHaveValue("https://fail");
});

test("a failed save keeps the draft and a retry re-sends it", async () => {
  const { api, updateSettings } = createApi(makeState());
  await renderProbe(api);
  const input = screen.getByLabelText("base-url");

  updateSettings.mockResolvedValue({ ok: false, error: "boom" });
  fireEvent.change(input, { target: { value: "https://retry" } });
  fireEvent.blur(input);
  await flushMicrotasks();

  expect(updateSettings).toHaveBeenCalledTimes(1);
  expect(input).toHaveValue("https://retry");

  updateSettings.mockResolvedValue({ ok: true, state: makeState("https://retry") });
  fireEvent.focus(input);
  fireEvent.blur(input);
  await flushMicrotasks();

  expect(updateSettings).toHaveBeenCalledTimes(2);
  expect(updateSettings.mock.calls[1]?.[0]).toEqual({
    provider: { online: { baseUrl: "https://retry" } },
  });
  expect(input).toHaveValue("https://retry");
});

test("non-text controls save immediately without debounce", async () => {
  const { api, updateSettings } = createApi(makeState());
  await renderProbe(api);

  act(() => {
    lastForm!.save({ picker: { enabled: false } });
  });
  await flushMicrotasks();

  expect(updateSettings).toHaveBeenCalledTimes(1);
  expect(updateSettings.mock.calls[0]?.[0]).toEqual({ picker: { enabled: false } });
});

test("multiline plain Enter does not flush; the debounce saves it", async () => {
  const { api, updateSettings } = createApi(makeState());
  await renderProbe(api);
  const textarea = screen.getByLabelText("prompt");

  fireEvent.change(textarea, { target: { value: "line1\nline2" } });
  fireEvent.keyDown(textarea, { key: "Enter" });
  expect(updateSettings).not.toHaveBeenCalled();

  await advance(500);
  expect(updateSettings).toHaveBeenCalledTimes(1);
  expect(updateSettings.mock.calls[0]?.[0]).toEqual({ quick: { prompt: "line1\nline2" } });
});

test("multiline Ctrl+Enter and Cmd+Enter flush immediately and blur", async () => {
  const { api, updateSettings } = createApi(makeState());
  await renderProbe(api);
  const textarea = screen.getByLabelText("prompt");

  fireEvent.change(textarea, { target: { value: "ctrl" } });
  fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
  expect(updateSettings).toHaveBeenCalledTimes(1);
  expect(updateSettings.mock.calls[0]?.[0]).toEqual({ quick: { prompt: "ctrl" } });
  expect(document.activeElement).not.toBe(textarea);

  fireEvent.change(textarea, { target: { value: "cmd" } });
  fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
  await flushMicrotasks();
  expect(updateSettings).toHaveBeenCalledTimes(2);
  expect(updateSettings.mock.calls[1]?.[0]).toEqual({ quick: { prompt: "cmd" } });
  expect(document.activeElement).not.toBe(textarea);
});

test("Enter followed by blur sends the value once", async () => {
  const { api, updateSettings } = createApi(makeState());
  await renderProbe(api);
  const input = screen.getByLabelText("base-url");

  fireEvent.change(input, { target: { value: "https://once" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.blur(input);
  await flushMicrotasks();

  expect(updateSettings).toHaveBeenCalledTimes(1);
});

test("flushSaveQueue resolves ok:false when a queued save failed", async () => {
  const { api, updateSettings } = createApi(makeState());
  await renderProbe(api);
  const input = screen.getByLabelText("base-url");
  updateSettings.mockResolvedValue({ ok: false, error: "denied" });

  fireEvent.change(input, { target: { value: "https://x" } });
  fireEvent.blur(input);

  let result: { ok: boolean; error?: string } | null = null;
  await act(async () => {
    result = await lastForm!.flushSaveQueue();
  });
  expect(result).toEqual({ ok: false, error: "denied" });
});

test("initial load retries only 'state not managed' failures and then reports loadError", async () => {
  const { api, getState } = createApi(makeState());
  getState.mockResolvedValue({ ok: false, error: "state not managed yet" });

  await renderProbe(api);
  expect(getState).toHaveBeenCalledTimes(1);

  await advance(100);
  expect(getState).toHaveBeenCalledTimes(2);
  await advance(250);
  expect(getState).toHaveBeenCalledTimes(3);
  await advance(500);
  expect(getState).toHaveBeenCalledTimes(4);

  await advance(2000);
  expect(getState).toHaveBeenCalledTimes(4);
  expect(lastForm?.loadError).toContain("state not managed");
  // The shell (Task 3) owns the single `settings.error.readSettings` toast.
  expect(toast).not.toHaveBeenCalled();
});

test("applyState replaces the whole state (reset_settings path)", async () => {
  const { api } = createApi(makeState());
  await renderProbe(api);
  const input = screen.getByLabelText("base-url");

  act(() => {
    lastForm!.applyState(makeState("https://reset"));
  });

  expect(input).toHaveValue("https://reset");
});

test("failure toast uses the locale supplied by the provider", async () => {
  const { api, updateSettings } = createApi(makeState());
  render(
    <SettingsFormProvider api={api} debounceMs={500} locale="zh">
      <Probe />
    </SettingsFormProvider>
  );
  await flushMicrotasks();
  const input = screen.getByLabelText("base-url");
  updateSettings.mockResolvedValue({ ok: false, error: "boom" });

  fireEvent.change(input, { target: { value: "https://x" } });
  fireEvent.blur(input);
  await flushMicrotasks();

  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: expect.stringContaining("保存失败") })
  );
});

test("unmount disposes both event subscriptions", async () => {
  const { api, offState, offToast } = createApi(makeState());
  const { unmount } = await renderProbe(api);

  unmount();

  expect(api.onState).toHaveBeenCalledTimes(1);
  expect(offState).toHaveBeenCalledTimes(1);
  expect(offToast).toHaveBeenCalledTimes(1);
});
