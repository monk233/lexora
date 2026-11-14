/* About card (C67-C71): build info and the six-state update flow. */
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

function aboutCard(): HTMLElement {
  return screen.getByRole("region", { name: zh("settings.card.about.title") });
}

test("shows the version, license and local model summary", async () => {
  const api = createFakeSettingsApi(
    makeState({
      app: { version: "0.4.3", license: "MIT", dataDir: "D:\\Lexora\\data" },
      models: [{ file: "qwen.gguf", name: "Qwen 0.8B", path: "", sizeBytes: 1, modifiedAt: 0 }],
    })
  );
  await renderSettingsWindow({ api });

  expect(within(aboutCard()).getByText("v0.4.3")).toBeTruthy();
  expect(within(aboutCard()).getByText("MIT")).toBeTruthy();
  expect(
    within(aboutCard()).getByText(/Qwen 0\.8B/)
  ).toBeTruthy();
});

test("checking for updates reports the latest version", async () => {
  const api = createFakeSettingsApi(makeState());
  await renderSettingsWindow({ api });

  fireEvent.click(
    within(aboutCard()).getByRole("button", { name: zh("settings.action.checkUpdate") })
  );
  await vi.waitFor(() =>
    expect(api.calls.some((call) => call.method === "checkUpdate")).toBe(true)
  );
  await vi.waitFor(() =>
    expect(within(aboutCard()).getByText(/已是最新版本/)).toBeTruthy()
  );
});

test("an available update can be installed", async () => {
  const api = createFakeSettingsApi(makeState());
  api.checkUpdate = async () => ({
    ok: true,
    hasUpdate: true,
    latestVersion: "0.5.0",
    currentVersion: "0.4.3",
    notes: "## 更新内容\n- 修复若干问题",
  });
  await renderSettingsWindow({ api });

  fireEvent.click(
    within(aboutCard()).getByRole("button", { name: zh("settings.action.checkUpdate") })
  );
  await vi.waitFor(() =>
    expect(within(aboutCard()).getByText(/发现新版本/)).toBeTruthy()
  );
  fireEvent.click(
    within(aboutCard()).getByRole("button", { name: zh("settings.action.installUpdate") })
  );
  await vi.waitFor(() =>
    expect(api.calls.some((call) => call.method === "installUpdate")).toBe(true)
  );
});

test("the GitHub button opens the repository externally", async () => {
  const api = createFakeSettingsApi(
    makeState({ app: { repoUrl: "https://github.com/monk233/lexora" } })
  );
  await renderSettingsWindow({ api });

  fireEvent.click(within(aboutCard()).getAllByRole("button", { name: zh("settings.action.githubRepo") })[0]);
  await vi.waitFor(() =>
    expect(
      api.calls.some(
        (call) =>
          call.method === "openExternal" &&
          call.args[0] === "https://github.com/monk233/lexora"
      )
    ).toBe(true)
  );
});
