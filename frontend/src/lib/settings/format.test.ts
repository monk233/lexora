/* Formatting helpers shared by the provider card (C13 latency badge) and the
 * local model panel (C19/C25 download copy, quant pills). */
import { expect, test } from "vitest";

import type { DownloadProgress } from "./types";
import {
  activeDownloadFor,
  catalogProgressText,
  engineProgressText,
  formatBytes,
  formatMs,
  isActiveDownload,
  quantLabel,
} from "./format";

const baseProgress: DownloadProgress = {
  kind: "model",
  id: "qwen3.5-2b-q3-k-m",
  filename: "qwen3.5-2b-q3-k-m.gguf",
  received: 0,
  total: 0,
  percent: 0,
  status: "downloading",
  error: "",
};

function t(key: string, params?: Record<string, string | number>): string {
  if (key === "settings.catalog.mmproj") return `视觉投影器 · ${String(params?.percent)}%`;
  if (key === "settings.status.verifying") return "校验中…";
  return key;
}

test("formats bytes and latency like the legacy helpers", () => {
  expect(formatBytes(0)).toBe("—");
  expect(formatBytes(-1)).toBe("—");
  expect(formatBytes(Number.NaN)).toBe("—");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
  expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
  expect(formatMs(1234.6)).toBe("1235 ms");
  expect(formatMs(0)).toBe("0 ms");
});

test("labels the quantization suffix of a GGUF filename", () => {
  expect(quantLabel("qwen3.5-2b-q3-k-m.gguf")).toBe("Q3_K_M");
  expect(quantLabel("qwen2.5-1.5b-instruct-q4_k_m.gguf")).toBe("Q4_K_M");
  expect(quantLabel("model.gguf")).toBe("");
  expect(quantLabel("")).toBe("");
});

test("treats only downloading/verifying as active downloads", () => {
  expect(isActiveDownload(baseProgress)).toBe(true);
  expect(isActiveDownload({ ...baseProgress, status: "verifying" })).toBe(true);
  expect(isActiveDownload({ ...baseProgress, status: "failed" })).toBe(false);
  expect(isActiveDownload({ ...baseProgress, status: "cancelled" })).toBe(false);
});

test("finds the active download for an engine or a model id", () => {
  const engine: DownloadProgress = { ...baseProgress, kind: "engine", id: "" };
  const model: DownloadProgress = { ...baseProgress, id: "qwen3.5-4b-q3-k-m" };
  const downloads = [engine, model];
  expect(activeDownloadFor(downloads, "engine")).toEqual(engine);
  expect(activeDownloadFor(downloads, "qwen3.5-4b-q3-k-m")).toEqual(model);
  expect(activeDownloadFor(downloads, "missing")).toBeUndefined();
  expect(
    activeDownloadFor([{ ...engine, status: "failed" }], "engine")
  ).toBeUndefined();
  /* The engine task is keyed by `kind`, not by the model-id argument. */
  expect(activeDownloadFor([model], "engine")).toBeUndefined();
});

test("renders engine and catalog progress copy", () => {
  expect(
    engineProgressText({ ...baseProgress, received: 1024, total: 4096, percent: 25 }, t)
  ).toBe("1 KB / 4 KB · 25%");
  expect(
    engineProgressText({ ...baseProgress, received: 1024, total: 4096, percent: 25, status: "verifying" }, t)
  ).toBe("校验中…");

  expect(catalogProgressText({ ...baseProgress, filename: "mmproj-model.gguf", percent: 42.6 }, t)).toBe(
    "视觉投影器 · 43%"
  );
  expect(catalogProgressText({ ...baseProgress, percent: 42.6 }, t)).toBe("43%");
  expect(catalogProgressText({ ...baseProgress, status: "verifying" }, t)).toBe("校验中…");
  /* Percent is clamped to the progress range before rounding. */
  expect(catalogProgressText({ ...baseProgress, percent: 140 }, t)).toBe("100%");
});
