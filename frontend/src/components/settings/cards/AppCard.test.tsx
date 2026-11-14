/* App & startup card (C60-C66).
 *
 * Startup-at-login is asserted twice: the switch display comes from the OS login
 * item (not `app.startAtLogin`) and saving goes through `set_start_at_login`.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

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

function appCard(): HTMLElement {
  return screen.getByRole("region", { name: zh("settings.card.app.title") });
}

function switchByLabel(label: string): HTMLButtonElement {
  return within(appCard()).getByRole("switch", { name: label }) as HTMLButtonElement;
}

function updateCalls(api: FakeSettingsApi): unknown[] {
  return api.calls
    .filter((call) => call.method === "updateSettings")
    .map((call) => call.args[0]);
}

test("language select saves app.language", async () => {
  const api = createFakeSettingsApi(makeState());
  await renderSettingsWindow({ api });

  fireEvent.click(within(appCard()).getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: zh("language.en") }));

  await vi.waitFor(() =>
    expect(updateCalls(api)).toContainEqual({ app: { language: "en" } })
  );
});

test("start-at-login reflects the OS login item, not app.startAtLogin", async () => {
  const api = createFakeSettingsApi(
    makeState({
      settings: { app: { startAtLogin: true } },
      loginItem: { supported: true, enabled: false },
    })
  );
  await renderSettingsWindow({ api });

  expect(switchByLabel(zh("settings.field.startAtLogin")).getAttribute("aria-checked")).toBe(
    "false"
  );

  fireEvent.click(switchByLabel(zh("settings.field.startAtLogin")));

  await vi.waitFor(() =>
    expect(api.calls.some((call) => call.method === "setStartAtLogin")).toBe(true)
  );
  const updates = updateCalls(api).filter(
    (patch) => JSON.stringify(patch).includes("startAtLogin")
  );
  expect(updates).toHaveLength(0);
});

test("start-at-login is disabled for portable builds and shows the note", async () => {
  const api = createFakeSettingsApi(
    makeState({
      app: { portable: true },
      loginItem: { supported: false, enabled: false },
    })
  );
  await renderSettingsWindow({ api });

  expect(switchByLabel(zh("settings.field.startAtLogin")).disabled).toBe(true);
  expect(within(appCard()).getByText(zh("settings.login.portableNote"))).toBeTruthy();
});

test("close-to-tray defaults to on and saves the toggle", async () => {
  const api = createFakeSettingsApi(makeState({ settings: { app: { closeToTray: true } } }));
  await renderSettingsWindow({ api });

  const toggle = switchByLabel(zh("settings.field.closeToTray"));
  expect(toggle.getAttribute("aria-checked")).toBe("true");

  fireEvent.click(toggle);
  await vi.waitFor(() =>
    expect(updateCalls(api)).toContainEqual({ app: { closeToTray: false } })
  );
});

test("directory buttons call open_dir with the right target", async () => {
  const api = createFakeSettingsApi(makeState());
  await renderSettingsWindow({ api });

  fireEvent.click(screen.getByRole("button", { name: zh("settings.action.logsDir") }));
  await vi.waitFor(() =>
    expect(api.calls.some((call) => call.method === "openDir" && call.args[0] === "logs")).toBe(
      true
    )
  );
});

test("reset and quit require a second click", async () => {
  const api = createFakeSettingsApi(makeState());
  await renderSettingsWindow({ api });

  const reset = screen.getByRole("button", { name: zh("settings.action.reset") });
  fireEvent.click(reset);
  expect(api.calls.some((call) => call.method === "resetSettings")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: zh("settings.action.confirmReset") }));
  await vi.waitFor(() =>
    expect(api.calls.some((call) => call.method === "resetSettings")).toBe(true)
  );

  fireEvent.click(screen.getByRole("button", { name: zh("settings.action.quit") }));
  expect(api.calls.some((call) => call.method === "quit")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: zh("settings.action.confirmQuit") }));
  await vi.waitFor(() => expect(api.calls.some((call) => call.method === "quit")).toBe(true));
});
