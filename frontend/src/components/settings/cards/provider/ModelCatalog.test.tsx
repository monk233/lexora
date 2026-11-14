/* Model catalog list (C23/C25) in isolation: the toggle button, the per-row
 * installed badge / download / cancel actions, and both progress copy stages. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import type { ComponentProps } from "react";

import { ModelCatalog } from "@/components/settings/cards/provider/ModelCatalog";
import { I18nProvider } from "@/lib/i18n";
import type { CatalogEntry, DownloadProgress } from "@/lib/settings/types";
import { zh } from "@/test/settings-harness";

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
    description: "",
    filename: "qwen3.5-2b-q3_k_m.gguf",
    sizeBytes: 1200 * 1024 * 1024,
    license: "Apache-2.0",
    languages: "多语言",
    recommended: true,
    installed: true,
    vision: false,
  },
];

type CatalogProps = ComponentProps<typeof ModelCatalog>;

function renderCatalog(overrides: Partial<CatalogProps> = {}) {
  const onToggle = vi.fn();
  const onDownload = vi.fn();
  const onCancel = vi.fn();
  const props: CatalogProps = {
    open: true,
    catalog: CATALOG,
    downloads: [],
    recommendedModelId: "",
    onToggle,
    onDownload,
    onCancel,
    ...overrides,
  };
  const view = render(
    <I18nProvider initialLocale="zh">
      <ModelCatalog {...props} />
    </I18nProvider>
  );
  return { ...view, onToggle, onDownload, onCancel };
}

function row(id: string): HTMLElement {
  const found = screen
    .getAllByTestId("catalog-row")
    .find((node) => node.getAttribute("data-catalog-id") === id);
  if (!found) throw new Error(`catalog row not found: ${id}`);
  return found;
}

function downloadProgress(overrides: Partial<DownloadProgress> = {}): DownloadProgress {
  return {
    kind: "model",
    id: "qwen3.5-0.8b-q3-k-m",
    filename: "qwen3.5-0.8b-q3-k-m.gguf",
    received: 512,
    total: 1024,
    percent: 50,
    status: "downloading",
    error: "",
    ...overrides,
  };
}

test("toggles between the download-models and collapse labels", () => {
  const closed = renderCatalog({ open: false });
  const toggle = screen.getByRole("button", { name: zh("settings.action.downloadModel") });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByTestId("catalog-list")).toBeNull();
  fireEvent.click(toggle);
  expect(closed.onToggle).toHaveBeenCalledTimes(1);
  closed.unmount();

  renderCatalog({ open: true });
  expect(
    screen.getByRole("button", { name: zh("settings.action.collapseCatalog") })
  ).toHaveAttribute("aria-expanded", "true");
});

test("renders size, quant, license, vision and recommended metadata", () => {
  renderCatalog({ recommendedModelId: "qwen3.5-2b-q3-k-m" });
  const entry = within(row("qwen3.5-0.8b-q3-k-m"));
  expect(entry.getByText("Qwen3.5 0.8B")).toBeTruthy();
  expect(entry.getByText("轻量模型")).toBeTruthy();
  expect(entry.getByText("600 MB")).toBeTruthy();
  expect(entry.getByText("Q3_K_M")).toBeTruthy();
  expect(entry.getByText("Apache-2.0")).toBeTruthy();
  expect(entry.getByText(zh("settings.modelRole.builtin"))).toBeTruthy();

  const recommended = within(row("qwen3.5-2b-q3-k-m"));
  expect(recommended.getByText(zh("settings.badge.recommended"))).toBeTruthy();
});

test("shows the installed badge instead of the download button", () => {
  renderCatalog();
  const installed = within(row("qwen3.5-2b-q3-k-m"));
  expect(installed.getByText(zh("settings.badge.installed"))).toBeTruthy();
  expect(
    installed.queryByRole("button", { name: zh("settings.action.download") })
  ).toBeNull();

  const available = within(row("qwen3.5-0.8b-q3-k-m"));
  expect(available.queryByText(zh("settings.badge.installed"))).toBeNull();
});

test("starts a download for an available entry", () => {
  const view = renderCatalog();
  fireEvent.click(
    within(row("qwen3.5-0.8b-q3-k-m")).getByRole("button", {
      name: zh("settings.action.download"),
    })
  );
  expect(view.onDownload).toHaveBeenCalledWith("qwen3.5-0.8b-q3-k-m");
});

test("shows per-row progress and cancels a downloading entry", () => {
  const view = renderCatalog({ downloads: [downloadProgress()] });
  const active = within(row("qwen3.5-0.8b-q3-k-m"));
  expect(active.getByTestId("catalog-progress-text").textContent).toBe("50%");
  expect(
    active.queryByRole("button", { name: zh("settings.action.download") })
  ).toBeNull();
  fireEvent.click(active.getByRole("button", { name: zh("common.cancel") }));
  expect(view.onCancel).toHaveBeenCalledWith("qwen3.5-0.8b-q3-k-m");
});

test("labels the vision projector stage and hides cancel while verifying", () => {
  const view = renderCatalog({
    downloads: [
      downloadProgress({ filename: "mmproj-qwen3.5-0.8b.gguf", percent: 42.6 }),
    ],
  });
  expect(
    within(row("qwen3.5-0.8b-q3-k-m")).getByTestId("catalog-progress-text").textContent
  ).toBe(zh("settings.catalog.mmproj", { percent: 43 }));
  view.unmount();

  renderCatalog({ downloads: [downloadProgress({ status: "verifying", percent: 100 })] });
  const verifying = within(row("qwen3.5-0.8b-q3-k-m"));
  expect(verifying.getByTestId("catalog-progress-text").textContent).toBe(
    zh("settings.status.verifying")
  );
  expect(verifying.queryByRole("button", { name: zh("common.cancel") })).toBeNull();
});
