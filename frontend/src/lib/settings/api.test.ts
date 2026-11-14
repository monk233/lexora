import { beforeEach, expect, test, vi } from "vitest";

const calls: Array<[string, unknown]> = [];
vi.mock("@/lib/tauri-api.js", () => ({
  settingsAPI: {
    live: true,
    getState: vi.fn(async () => ({ ok: true, state: { settings: {} } })),
    updateSettings: vi.fn(async (patch: unknown) => {
      calls.push(["update_settings", patch]);
      return { ok: true, state: { settings: {} } };
    }),
    setStartAtLogin: vi.fn(async (enabled: boolean) => {
      calls.push(["set_start_at_login", enabled]);
      return { ok: true };
    }),
    setCaptureHotkey: vi.fn(async (shortcut: string) => {
      calls.push(["capture_set_hotkey", shortcut]);
      return { ok: true, shortcut };
    }),
    quickSetHotkey: vi.fn(async (shortcut: string) => {
      calls.push(["quick_set_hotkey", shortcut]);
      return { ok: true, shortcut };
    }),
    onState: vi.fn(() => () => {}),
    onDownloadProgress: vi.fn(() => () => {}),
    onUpdateProgress: vi.fn(() => () => {}),
    onUpdateAvailable: vi.fn(() => () => {}),
    onToast: vi.fn(() => () => {}),
  },
  subscribe: vi.fn(),
}));

beforeEach(() => {
  calls.length = 0;
  vi.resetModules();
});

test("keeps the legacy IPC names and argument shapes", async () => {
  const { settingsApi } = await import("./api");
  await settingsApi.updateSettings({ app: { language: "en" } });
  await settingsApi.setStartAtLogin(true);
  await settingsApi.setCaptureHotkey("Ctrl+Alt+P");
  await settingsApi.setQuickHotkey("Alt+Space");
  expect(calls).toEqual([
    ["update_settings", { app: { language: "en" } }],
    ["set_start_at_login", true],
    ["capture_set_hotkey", "Ctrl+Alt+P"],
    ["quick_set_hotkey", "Alt+Space"],
  ]);
});

test("on* methods return an unsubscriber", async () => {
  const { settingsApi } = await import("./api");
  expect(typeof settingsApi.onState(() => {})).toBe("function");
  expect(typeof settingsApi.onToast(() => {})).toBe("function");
});
