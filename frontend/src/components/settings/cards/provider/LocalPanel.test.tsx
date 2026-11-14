/* Local model panel of the translation service card (C16–C31, D3).

 * Every assertion goes through the real window + fake bridge from the test
 * harness: `api.calls` proves which IPC command ran, `api.emitDownload` drives
 * the backend `download-progress` event and `api.unsubscribed.download` proves
 * the subscription is released on unmount.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { SettingsApi } from "@/lib/settings/api";
import type {
  CatalogEntry,
  DownloadProgress,
  EngineStatus,
  ModelInfo,
  StatePayload,
} from "@/lib/settings/types";
import {
  createFakeSettingsApi,
  makeState,
  renderSettingsWindow,
  zh,
} from "@/test/settings-harness";

/* ---- Fixtures ------------------------------------------------------------ */

const CATALOG: CatalogEntry[] = [
  {
    id: "qwen3.5-0.8b-q3-k-m",
    name: "Qwen3.5 0.8B",
    description: "轻量模型",
    filename: "qwen3.5-0.8b-q3-k-m.gguf",
    sizeBytes: 600 * 1024 * 1024,
    license: "Apache-2.0",
    languages: "多语言",
    recommended: false,
    installed: false,
    vision: true,
  },
  {
    id: "qwen3.5-2b-q3-k-m",
    name: "Qwen3.5 2B",
    description: "均衡模型",
    filename: "qwen3.5-2b-q3_k_m.gguf",
    sizeBytes: 1200 * 1024 * 1024,
    license: "Apache-2.0",
    languages: "多语言",
    recommended: true,
    installed: true,
    vision: true,
  },
];

function model(file: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    file,
    name: overrides.name ?? file,
    path: `C:\\models\\${file}`,
    sizeBytes: 1024 * 1024,
    modifiedAt: 0,
    catalogId: "",
    ...overrides,
  };
}

const MODELS: ModelInfo[] = [
  model("qwen3.5-0.8b-q3-k-m.gguf", {
    name: "Qwen3.5 0.8B",
    catalogId: "qwen3.5-0.8b-q3-k-m",
  }),
  model("qwen3.5-2b-q3_k_m.gguf", {
    name: "Qwen3.5 2B",
    catalogId: "qwen3.5-2b-q3-k-m",
  }),
  model("Hy-MT2-1.8B-Q4_K_M.gguf", { name: "Hy-MT2 1.8B" }),
];

interface LocalOverrides {
  engine?: Partial<EngineStatus>;
  models?: ModelInfo[];
  catalog?: CatalogEntry[];
  hardware?: Partial<StatePayload["hardwareRecommendation"]>;
  downloads?: DownloadProgress[];
  selectedModel?: string;
  keepRunning?: boolean;
}

function localState(overrides: LocalOverrides = {}): StatePayload {
  const state = makeState({ settings: { provider: { mode: "local" } } });
  state.engine = { ...state.engine, mode: "local", ...overrides.engine };
  if (overrides.models) state.models = overrides.models;
  if (overrides.catalog) state.catalog = overrides.catalog;
  if (overrides.hardware) {
    state.hardwareRecommendation = { ...state.hardwareRecommendation, ...overrides.hardware };
  }
  if (overrides.downloads) state.downloads = overrides.downloads;
  if (overrides.selectedModel !== undefined) {
    state.settings.provider.local.selectedModel = overrides.selectedModel;
  }
  if (overrides.keepRunning !== undefined) {
    state.settings.provider.local.keepRunning = overrides.keepRunning;
  }
  return state;
}

async function renderLocal(
  overrides: LocalOverrides = {},
  apiOverrides: Partial<SettingsApi> = {}
) {
  const state = localState(overrides);
  const api = createFakeSettingsApi(state, apiOverrides);
  return renderSettingsWindow({ state, api });
}

function progress(overrides: Partial<DownloadProgress> = {}): DownloadProgress {
  return {
    kind: "engine",
    id: "",
    filename: "llama.cpp.zip",
    received: 1024,
    total: 4096,
    percent: 25,
    status: "downloading",
    error: "",
    ...overrides,
  };
}

function modelRow(file: string): HTMLElement {
  const row = screen
    .getAllByTestId("local-model-row")
    .find((node) => node.getAttribute("data-file") === file);
  if (!row) throw new Error(`model row not found: ${file}`);
  return row;
}

function catalogRow(id: string): HTMLElement {
  const row = screen
    .getAllByTestId("catalog-row")
    .find((node) => node.getAttribute("data-catalog-id") === id);
  if (!row) throw new Error(`catalog row not found: ${id}`);
  return row;
}

function click(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ---- C16: engine status line -------------------------------------------- */

test("renders the engine status copy and tone for every engine state", async () => {
  const missing = await renderLocal();
  expect(screen.getByTestId("engine-title").textContent).toBe(zh("settings.engine.missing"));
  expect(screen.getByTestId("engine-sub").textContent).toBe(zh("settings.engine.missingSub"));
  expect(screen.getByTestId("engine-dot").getAttribute("data-tone")).toBe("warn");
  missing.unmount();

  const installed = await renderLocal({ engine: { engineAvailable: true } });
  expect(screen.getByTestId("engine-title").textContent).toBe(zh("settings.engine.installed"));
  expect(screen.getByTestId("engine-sub").textContent).toBe(zh("settings.engine.installedSub"));
  expect(screen.getByTestId("engine-dot").getAttribute("data-tone")).toBe("ok");
  installed.unmount();

  await renderLocal({ downloads: [progress()] });
  expect(screen.getByTestId("engine-title").textContent).toBe(
    zh("settings.engine.downloading")
  );
  expect(screen.getByTestId("engine-sub").textContent).toBe("llama.cpp.zip");
});

/* ---- C17/C18: download / cancel the engine ------------------------------ */

test("offers engine download until installed and cancels an active download", async () => {
  const { api, unmount } = await renderLocal();
  click(zh("settings.action.downloadEngine"));
  await act(async () => {});
  expect(api.calls).toContainEqual({ method: "downloadEngine", args: [] });
  unmount();

  const downloading = await renderLocal({ downloads: [progress()] });
  expect(
    screen.queryByRole("button", { name: zh("settings.action.downloadEngine") })
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: zh("common.cancel") }));
  await act(async () => {});
  expect(downloading.api.calls).toContainEqual({
    method: "cancelDownload",
    args: ["engine"],
  });
  downloading.unmount();

  await renderLocal({ engine: { engineAvailable: true } });
  expect(
    screen.queryByRole("button", { name: zh("settings.action.downloadEngine") })
  ).toBeNull();
  expect(screen.queryByRole("button", { name: zh("common.cancel") })).toBeNull();
});

/* ---- C19: engine download progress -------------------------------------- */

test("shows the engine progress bar with bytes or the verifying copy", async () => {
  const plain = await renderLocal();
  expect(screen.queryByTestId("engine-progress")).toBeNull();
  plain.unmount();

  const downloading = await renderLocal({ downloads: [progress()] });
  expect(screen.getByTestId("engine-progress-text").textContent).toBe("1 KB / 4 KB · 25%");
  downloading.unmount();

  await renderLocal({ downloads: [progress({ status: "verifying" })] });
  expect(screen.getByTestId("engine-progress-text").textContent).toBe(
    zh("settings.status.verifying")
  );
});

/* ---- C20: hardware recommendation --------------------------------------- */

test("summarizes the hardware recommendation and falls back when empty", async () => {
  const recommended = await renderLocal({
    hardware: {
      totalMemoryBytes: 8 * 1024 * 1024 * 1024,
      cpuThreads: 12,
      gpuName: "NVIDIA RTX 3060",
      gpuVramBytes: 6 * 1024 * 1024 * 1024,
      recommendedModelId: "qwen3.5-2b-q3-k-m",
      reason: "显存足够运行 2B",
    },
  });
  expect(screen.getByTestId("local-hardware-summary").textContent).toBe(
    "内存 8 GB · CPU 12 线程 · NVIDIA RTX 3060 · 显存 6 GB"
  );
  expect(screen.getByTestId("local-hardware-reason").textContent).toBe(
    zh("settings.hardware.recommendation", { reason: "显存足够运行 2B" })
  );
  expect(screen.getByTestId("local-hardware").getAttribute("aria-live")).toBe("polite");
  recommended.unmount();

  await renderLocal();
  expect(screen.getByTestId("local-hardware-summary").textContent).toBe(
    zh("settings.hardware.none")
  );
  expect(screen.getByTestId("local-hardware-reason").textContent).toBe(
    zh("settings.hardware.recommendationFallback")
  );
});

/* ---- C21/C22: installed model list + selection hint --------------------- */

test("only allows selecting a fully installed Qwen3.5 model", async () => {
  const { api } = await renderLocal({
    models: MODELS,
    catalog: CATALOG,
    selectedModel: "",
  });

  const incomplete = within(modelRow("qwen3.5-0.8b-q3-k-m.gguf"));
  const incompleteButton = incomplete.getByRole("button", {
    name: zh("settings.aria.selectModel", { name: "Qwen3.5 0.8B" }),
  });
  expect(incompleteButton.textContent).toBe(zh("settings.action.completeDownload"));
  expect(incompleteButton).toBeDisabled();

  const ready = within(modelRow("qwen3.5-2b-q3_k_m.gguf"));
  const readyButton = ready.getByRole("button", {
    name: zh("settings.aria.selectModel", { name: "Qwen3.5 2B" }),
  });
  expect(readyButton.textContent).toBe(zh("settings.action.select"));
  expect(readyButton.getAttribute("aria-pressed")).toBe("false");

  expect(
    within(modelRow("Hy-MT2-1.8B-Q4_K_M.gguf")).getByRole("button", {
      name: zh("settings.aria.deleteModel", { name: "Hy-MT2 1.8B" }),
    })
  ).toBeTruthy();

  expect(screen.getByTestId("local-models-hint").textContent).toBe(
    zh("settings.hint.modelSelectionMissing")
  );

  fireEvent.click(readyButton);
  await act(async () => {});

  expect(api.calls).toContainEqual({
    method: "updateSettings",
    args: [{ provider: { local: { selectedModel: "qwen3.5-2b-q3-k-m" } } }],
  });
  const selected = within(modelRow("qwen3.5-2b-q3_k_m.gguf"));
  expect(
    selected.getByRole("button", {
      name: zh("settings.aria.currentModel", { name: "Qwen3.5 2B" }),
    }).textContent
  ).toBe(zh("settings.action.selected"));
  expect(
    selected
      .getByRole("button", {
        name: zh("settings.aria.currentModel", { name: "Qwen3.5 2B" }),
      })
      .getAttribute("aria-pressed")
  ).toBe("true");
  expect(screen.getByTestId("local-models-hint").textContent).toBe(
    zh("settings.hint.modelSelectionReady")
  );
});

test("toasts the model switch only while the engine is running", async () => {
  const idle = await renderLocal({
    models: MODELS,
    catalog: CATALOG,
    engine: { localState: "stopped" },
  });
  fireEvent.click(
    within(modelRow("qwen3.5-2b-q3_k_m.gguf")).getByRole("button", {
      name: zh("settings.aria.selectModel", { name: "Qwen3.5 2B" }),
    })
  );
  await act(async () => {});
  expect(screen.queryAllByText(zh("settings.toast.modelSwitched"))).toHaveLength(0);
  idle.unmount();

  await renderLocal({
    models: MODELS,
    catalog: CATALOG,
    engine: { localState: "ready" },
  });
  fireEvent.click(
    within(modelRow("qwen3.5-2b-q3_k_m.gguf")).getByRole("button", {
      name: zh("settings.aria.selectModel", { name: "Qwen3.5 2B" }),
    })
  );
  await act(async () => {});
  expect(screen.getAllByText(zh("settings.toast.modelSwitched")).length).toBeGreaterThan(0);
});

/* ---- C21: delete requires confirmation ---------------------------------- */

test("deletes a non-catalog model only after the second click", async () => {
  const { api } = await renderLocal({ models: MODELS });
  const row = within(modelRow("Hy-MT2-1.8B-Q4_K_M.gguf"));
  const button = row.getByRole("button", {
    name: zh("settings.aria.deleteModel", { name: "Hy-MT2 1.8B" }),
  });

  fireEvent.click(button);
  expect(button.textContent).toBe(zh("settings.action.confirmDelete"));
  expect(api.calls.filter((call) => call.method === "removeModel")).toHaveLength(0);

  fireEvent.click(button);
  await act(async () => {});
  expect(api.calls).toContainEqual({
    method: "removeModel",
    args: ["Hy-MT2-1.8B-Q4_K_M.gguf"],
  });
  expect(api.calls.filter((call) => call.method === "getState").length).toBeGreaterThan(1);
  expect(screen.getAllByText(zh("settings.toast.modelDeleted")).length).toBeGreaterThan(0);
});

test("keeps the model row and shows the server error when deletion fails", async () => {
  await renderLocal(
    { models: MODELS },
    {
      removeModel: async () => ({ ok: false, error: "请先停止引擎", hint: "然后再试" }),
    }
  );
  const button = within(modelRow("Hy-MT2-1.8B-Q4_K_M.gguf")).getByRole("button", {
    name: zh("settings.aria.deleteModel", { name: "Hy-MT2 1.8B" }),
  });
  fireEvent.click(button);
  fireEvent.click(button);
  await act(async () => {});

  expect(screen.getByTestId("local-error").textContent).toContain("请先停止引擎");
  expect(screen.getByTestId("local-error").textContent).toContain("然后再试");
});

/* ---- C23/C25: model catalog --------------------------------------------- */

test("toggles the catalog and offers download, cancel and progress per row", async () => {
  const { api } = await renderLocal({
    catalog: CATALOG,
    downloads: [
      progress({
        kind: "model",
        id: "qwen3.5-0.8b-q3-k-m",
        filename: "mmproj-qwen3.5-0.8b.gguf",
        percent: 42.6,
      }),
    ],
  });

  expect(screen.queryByTestId("catalog-list")).toBeNull();
  const toggle = screen.getByRole("button", { name: zh("settings.action.downloadModel") });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  await act(async () => {});

  expect(
    screen.getByRole("button", { name: zh("settings.action.collapseCatalog") })
  ).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByTestId("catalog-list")).toBeTruthy();

  const installed = within(catalogRow("qwen3.5-2b-q3-k-m"));
  expect(installed.getByText(zh("settings.badge.installed"))).toBeTruthy();
  expect(
    installed.queryByRole("button", { name: zh("settings.action.download") })
  ).toBeNull();

  const active = within(catalogRow("qwen3.5-0.8b-q3-k-m"));
  expect(active.getByTestId("catalog-progress-text").textContent).toBe(
    zh("settings.catalog.mmproj", { percent: 43 })
  );
  fireEvent.click(active.getByRole("button", { name: zh("common.cancel") }));
  await act(async () => {});
  expect(api.calls).toContainEqual({
    method: "cancelDownload",
    args: ["qwen3.5-0.8b-q3-k-m"],
  });
});

test("downloads an uninstalled catalog entry and shows verifying copy", async () => {
  const { api } = await renderLocal({ catalog: CATALOG });
  fireEvent.click(screen.getByRole("button", { name: zh("settings.action.downloadModel") }));
  await act(async () => {});

  const row = within(catalogRow("qwen3.5-0.8b-q3-k-m"));
  fireEvent.click(row.getByRole("button", { name: zh("settings.action.download") }));
  await act(async () => {});
  expect(api.calls).toContainEqual({
    method: "downloadModel",
    args: ["qwen3.5-0.8b-q3-k-m"],
  });
  expect(api.calls.filter((call) => call.method === "getState").length).toBeGreaterThan(1);
});

test("renders the verifying stage without a cancel button", async () => {
  await renderLocal({
    catalog: CATALOG,
    downloads: [
      progress({
        kind: "model",
        id: "qwen3.5-0.8b-q3-k-m",
        filename: "qwen3.5-0.8b-q3-k-m.gguf",
        status: "verifying",
        percent: 100,
      }),
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: zh("settings.action.downloadModel") }));
  await act(async () => {});

  const row = within(catalogRow("qwen3.5-0.8b-q3-k-m"));
  expect(row.getByTestId("catalog-progress-text").textContent).toBe(
    zh("settings.status.verifying")
  );
  expect(row.queryByRole("button", { name: zh("common.cancel") })).toBeNull();
});

/* ---- Download completion: a terminal snapshot clears the row ------------ */

const MODEL_ID = "qwen3.5-0.8b-q3-k-m";

function installedCatalog(): CatalogEntry[] {
  return CATALOG.map((entry) =>
    entry.id === MODEL_ID ? { ...entry, installed: true } : entry
  );
}

test("drops a finished download once the backend snapshot no longer lists it", async () => {
  const { api } = await renderLocal({ catalog: CATALOG });
  fireEvent.click(screen.getByRole("button", { name: zh("settings.action.downloadModel") }));
  await act(async () => {});

  /* Two downloads in flight at the same time: the engine and one model. */
  act(() => {
    api.emitDownload(progress({ kind: "engine", filename: "llama.cpp.zip" }));
    api.emitDownload(
      progress({
        kind: "model",
        id: MODEL_ID,
        filename: "qwen3.5-0.8b-q3-k-m.gguf",
        percent: 80,
      })
    );
  });
  await act(async () => {});

  expect(screen.getByTestId("engine-progress-text").textContent).toBe("1 KB / 4 KB · 25%");
  expect(
    within(catalogRow(MODEL_ID)).getByTestId("catalog-progress-text").textContent
  ).toBe("80%");
  expect(screen.getAllByRole("button", { name: zh("common.cancel") })).toHaveLength(2);

  /* Both enter the verifying stage; only the engine keeps a cancel button. */
  act(() => {
    api.emitDownload(progress({ kind: "engine", status: "verifying", percent: 100 }));
    api.emitDownload(
      progress({
        kind: "model",
        id: MODEL_ID,
        filename: "qwen3.5-0.8b-q3-k-m.gguf",
        status: "verifying",
        percent: 100,
      })
    );
  });
  await act(async () => {});
  expect(screen.getByTestId("engine-progress-text").textContent).toBe(
    zh("settings.status.verifying")
  );

  /* The model finished: the backend snapshot lists only the engine task, so
   * the model override must be dropped while the engine row stays live. */
  act(() => {
    api.emitState(
      localState({
        catalog: installedCatalog(),
        downloads: [progress({ kind: "engine", status: "verifying", percent: 100 })],
      })
    );
  });
  await act(async () => {});

  const finished = within(catalogRow(MODEL_ID));
  expect(finished.getByText(zh("settings.badge.installed"))).toBeTruthy();
  expect(finished.queryByTestId("catalog-progress-text")).toBeNull();
  expect(finished.queryByRole("button", { name: zh("common.cancel") })).toBeNull();
  expect(screen.getByTestId("engine-progress-text").textContent).toBe(
    zh("settings.status.verifying")
  );

  /* The engine then finishes too: an empty snapshot clears its row. */
  act(() => {
    api.emitState(
      localState({
        engine: { engineAvailable: true },
        catalog: installedCatalog(),
        downloads: [],
      })
    );
  });
  await act(async () => {});

  expect(screen.getByTestId("engine-title").textContent).toBe(
    zh("settings.engine.installed")
  );
  expect(screen.queryByTestId("engine-progress")).toBeNull();
  expect(screen.queryByRole("button", { name: zh("common.cancel") })).toBeNull();
});

/* ---- C24: import a GGUF ------------------------------------------------ */

test("imports a GGUF file, toasts and refreshes the model list", async () => {
  const { api } = await renderLocal({ models: MODELS });
  click(zh("settings.action.importModel"));
  await act(async () => {});

  expect(api.calls).toContainEqual({ method: "importModel", args: [] });
  expect(screen.getAllByText(zh("settings.toast.modelImported")).length).toBeGreaterThan(0);
  expect(api.calls.filter((call) => call.method === "getState").length).toBeGreaterThan(1);
});

/* ---- C26–C29: local run state ------------------------------------------ */

const RUN_STATES: Array<[EngineStatus["localState"], string, string]> = [
  ["stopped", "settings.engine.notStarted", "muted"],
  ["starting", "settings.status.starting", "warn"],
  ["ready", "settings.status.running", "ok"],
  ["error", "settings.status.startFailed", "error"],
];

test.each(RUN_STATES)(
  "maps localState %s onto the badge copy and tone",
  async (localState, key, tone) => {
    await renderLocal({ engine: { localState, engineAvailable: true } });
    const badge = screen.getByTestId("local-state-badge");
    expect(badge.textContent).toBe(zh(key));
    expect(badge.getAttribute("data-tone")).toBe(tone);
  }
);

test("shows start while stopped, restart+stop while ready", async () => {
  const stopped = await renderLocal({ engine: { localState: "stopped" } });
  expect(screen.getByRole("button", { name: zh("settings.action.start") })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: zh("settings.action.restart") })
  ).toBeNull();
  expect(screen.queryByRole("button", { name: zh("settings.action.stop") })).toBeNull();
  stopped.unmount();

  const ready = await renderLocal({ engine: { localState: "ready" } });
  expect(screen.queryByRole("button", { name: zh("settings.action.start") })).toBeNull();
  expect(screen.getByRole("button", { name: zh("settings.action.restart") })).toBeTruthy();
  expect(screen.getByRole("button", { name: zh("settings.action.stop") })).toBeTruthy();
  ready.unmount();

  await renderLocal({ engine: { localState: "starting" } });
  const starting = screen.getByRole("button", { name: zh("settings.status.starting") });
  expect(starting).toBeDisabled();
  expect(screen.getByRole("button", { name: zh("settings.action.restart") })).toBeDisabled();
});

test("runs start/stop through the bridge and disables the controls while busy", async () => {
  const started = await renderLocal({ engine: { localState: "stopped" } });
  click(zh("settings.action.start"));
  await act(async () => {});
  expect(started.api.calls).toContainEqual({ method: "startLocal", args: [] });
  started.unmount();

  let releaseStop: (value: { ok: boolean }) => void = () => {};
  const stopPending = new Promise<{ ok: boolean }>((resolve) => {
    releaseStop = resolve;
  });
  const stopSpy = vi.fn(() => stopPending);
  await renderLocal({ engine: { localState: "ready" } }, { stopLocal: stopSpy });
  click(zh("settings.action.stop"));
  await act(async () => {});
  expect(stopSpy).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: zh("settings.action.stop") })).toBeDisabled();
  expect(screen.getByRole("button", { name: zh("settings.action.restart") })).toBeDisabled();
  releaseStop({ ok: true });
  await act(async () => {});
  expect(screen.getByRole("button", { name: zh("settings.action.stop") })).not.toBeDisabled();
});

/* ---- C28: restart flushes the save queue first -------------------------- */

test("aborts the restart when the queued model selection fails to save", async () => {
  const state = localState({
    models: MODELS,
    catalog: CATALOG,
    engine: { localState: "ready" },
  });
  const api = createFakeSettingsApi(state);
  let failSave = true;
  const updateSpy = vi
    .spyOn(api, "updateSettings")
    .mockImplementation(async (patch) => {
      api.calls.push({ method: "updateSettings", args: [patch] });
      return failSave ? { ok: false, error: "boom" } : { ok: true };
    });

  await renderSettingsWindow({ state, api });

  fireEvent.click(
    within(modelRow("qwen3.5-2b-q3_k_m.gguf")).getByRole("button", {
      name: zh("settings.aria.selectModel", { name: "Qwen3.5 2B" }),
    })
  );
  click(zh("settings.action.restart"));
  await act(async () => {});

  expect(updateSpy).toHaveBeenCalled();
  expect(api.calls.filter((call) => call.method === "restartLocal")).toHaveLength(0);
  expect(screen.getByTestId("local-error").textContent).toContain("boom");

  failSave = false;
  fireEvent.click(
    within(modelRow("qwen3.5-2b-q3_k_m.gguf")).getByRole("button", {
      name: zh("settings.aria.selectModel", { name: "Qwen3.5 2B" }),
    })
  );
  click(zh("settings.action.restart"));
  await act(async () => {});

  const restartAt = api.calls.findIndex((call) => call.method === "restartLocal");
  expect(restartAt).toBeGreaterThan(0);
  expect(api.calls[restartAt - 1]?.method).toBe("updateSettings");
});

/* ---- C30: runtime hint -------------------------------------------------- */

test("explains the runtime hint from localState and keepRunning", async () => {
  const ready = await renderLocal({ engine: { localState: "ready" } });
  expect(screen.getByTestId("local-state-hint").textContent).toBe(
    zh("settings.hint.modelReady")
  );
  ready.unmount();

  const starting = await renderLocal({ engine: { localState: "starting" } });
  expect(screen.getByTestId("local-state-hint").textContent).toBe(
    zh("settings.hint.modelLoading")
  );
  starting.unmount();

  const idle = await renderLocal({
    engine: { localState: "stopped" },
    keepRunning: true,
  });
  expect(screen.getByTestId("local-state-hint").textContent).toBe(
    zh("settings.hint.idleStopped")
  );
  idle.unmount();

  await renderLocal({ engine: { localState: "stopped" }, keepRunning: false });
  expect(screen.getByTestId("local-state-hint").textContent).toBe(
    zh("settings.hint.notStartedAuto")
  );
});

/* ---- C31: inline errors ------------------------------------------------- */

test("shows the persisted local error and suppresses cancellation errors", async () => {
  const broken = await renderLocal({ engine: { localError: "引擎崩溃了" } });
  expect(screen.getByTestId("local-error").textContent).toBe("引擎崩溃了");
  broken.unmount();

  const cancelled = await renderLocal(
    {},
    { downloadEngine: async () => ({ ok: false, error: "用户取消下载" }) }
  );
  click(zh("settings.action.downloadEngine"));
  await act(async () => {});
  expect(screen.queryByTestId("local-error")).toBeNull();
  cancelled.unmount();

  const failed = await renderLocal(
    {},
    { downloadEngine: async () => ({ ok: false, error: "网络错误" }) }
  );
  click(zh("settings.action.downloadEngine"));
  await act(async () => {});
  expect(screen.getByTestId("local-error").textContent).toBe("网络错误");
  failed.unmount();

  const importFailed = await renderLocal(
    {},
    { importModel: async () => ({ ok: false, error: "文件损坏" }) }
  );
  click(zh("settings.action.importModel"));
  await act(async () => {});
  expect(screen.getByTestId("local-error").textContent).toBe("文件损坏");
  importFailed.unmount();

  const startSpy = vi.fn(async () => ({ ok: false }));
  await renderLocal(
    { engine: { localState: "stopped" } },
    { startLocal: startSpy }
  );
  click(zh("settings.action.start"));
  await act(async () => {});
  expect(startSpy).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("local-error").textContent).toBe(
    zh("settings.error.startLocal")
  );
});

/* ---- D3: download-progress subscription lifecycle ----------------------- */

test("applies download-progress events and releases the subscription on unmount", async () => {
  const { api, unmount } = await renderLocal({ catalog: CATALOG });
  expect(api.subscribed.download).toBe(1);

  act(() => {
    api.emitDownload(
      progress({
        kind: "model",
        id: "qwen3.5-0.8b-q3-k-m",
        filename: "qwen3.5-0.8b-q3-k-m.gguf",
        percent: 12,
      })
    );
  });
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: zh("settings.action.downloadModel") }));
  await act(async () => {});
  expect(
    within(catalogRow("qwen3.5-0.8b-q3-k-m")).getByTestId("catalog-progress-text").textContent
  ).toBe("12%");

  act(() => {
    api.emitDownload(
      progress({ kind: "engine", status: "downloading", filename: "engine.zip", percent: 40 })
    );
  });
  await act(async () => {});
  expect(screen.getByTestId("engine-title").textContent).toBe(
    zh("settings.engine.downloading")
  );

  act(() => {
    api.emitDownload(progress({ kind: "engine", status: "failed", error: "镜像不可用" }));
  });
  await act(async () => {});
  expect(screen.getByTestId("local-error").textContent).toBe("镜像不可用");
  expect(screen.queryByTestId("engine-progress")).toBeNull();

  act(() => {
    api.emitDownload(
      progress({
        kind: "model",
        id: "qwen3.5-0.8b-q3-k-m",
        filename: "qwen3.5-0.8b-q3-k-m.gguf",
        status: "failed",
        error: "下载中断",
      })
    );
  });
  await act(async () => {});
  expect(
    screen.getAllByText(
      zh("settings.toast.downloadFailed", { error: "下载中断" })
    ).length
  ).toBeGreaterThan(0);

  unmount();
  expect(api.unsubscribed.download).toBe(1);
});
