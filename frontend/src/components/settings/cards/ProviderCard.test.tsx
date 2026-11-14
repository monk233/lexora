/* Translation service card — provider mode + service badge (C02/C03/C04).
 *
 * The card owns the `role="tab"` segmented control that flips
 * `provider.mode`, the engine-derived service badge, and the panel switch.
 * Both panels are covered by their own suites (OnlinePanel / LocalPanel).
 */
import { act, fireEvent, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { providerBadge } from "@/components/settings/cards/ProviderCard";
import { makeState, renderSettingsWindow, zh } from "@/test/settings-harness";

import type { EngineStatus } from "@/lib/settings/types";

test("switches provider mode immediately", async () => {
  const { api } = await renderSettingsWindow();
  expect(screen.getByTestId("provider-online-panel")).toBeTruthy();

  fireEvent.click(screen.getByRole("tab", { name: zh("settings.mode.local") }));
  await act(async () => {});

  expect(api.calls).toContainEqual({
    method: "updateSettings",
    args: [{ provider: { mode: "local" } }],
  });
  expect(screen.getByTestId("provider-local")).toBeTruthy();
  expect(screen.queryByTestId("provider-online-panel")).toBeNull();
});

test("opens the saved mode on mount and can switch back to online", async () => {
  const { api } = await renderSettingsWindow({
    state: makeState({ settings: { provider: { mode: "local" } } }),
  });
  expect(screen.getByTestId("provider-local")).toBeTruthy();
  expect(screen.queryByTestId("provider-online-panel")).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: zh("settings.mode.online") }));
  await act(async () => {});

  expect(api.calls).toContainEqual({
    method: "updateSettings",
    args: [{ provider: { mode: "online" } }],
  });
  expect(screen.getByTestId("provider-online-panel")).toBeTruthy();
});

test.each([
  [
    { mode: "local", localState: "ready", engineAvailable: true },
    "settings.provider.localRunning",
    "ok",
  ],
  [{ mode: "local", localState: "starting" }, "settings.provider.localStarting", "warn"],
  [{ mode: "local", localState: "error" }, "settings.provider.localError", "error"],
  [
    { mode: "local", localState: "stopped", engineAvailable: true },
    "settings.provider.localStopped",
    "muted",
  ],
  [
    { mode: "local", localState: "stopped", engineAvailable: false },
    "settings.provider.localNoEngine",
    "warn",
  ],
  [{ mode: "online", ready: true }, "settings.provider.onlineReady", "ok"],
  [
    { mode: "online", ready: false, onlineConfigured: true },
    "settings.provider.onlineUnverified",
    "warn",
  ],
  [
    { mode: "online", ready: false, onlineConfigured: false },
    "settings.provider.onlineUnconfigured",
    "warn",
  ],
] as Array<[Partial<EngineStatus>, string, string]>)(
  "maps engine state %o onto the service badge",
  (engine, key, tone) => {
    expect(providerBadge({ ...makeState().engine, ...engine })).toEqual({ key, tone });
  }
);

test("renders the derived badge copy and tone in the card header", async () => {
  await renderSettingsWindow({
    state: makeState({
      settings: { provider: { mode: "local" } },
      engine: { mode: "local", localState: "ready", engineAvailable: true },
    }),
  });

  const badge = screen.getByTestId("provider-badge");
  expect(badge.textContent).toBe(zh("settings.provider.localRunning"));
  expect(badge.getAttribute("data-tone")).toBe("ok");
});
