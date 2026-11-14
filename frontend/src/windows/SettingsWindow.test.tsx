/* Shell-level behaviour for the settings window (Task 3).
 *
 * Covers inventory C01's shell parts and assertions 1–3 + 36: the sticky topbar
 * with the save-status pill, the six contract-ordered cards, locale following
 * the backend `state-changed` payload, the document title, the single read-error
 * toast, and the shared SegmentedControl semantics.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { SaveStatusPill } from "@/components/settings/SaveStatusPill";
import {
  SegmentedControl,
  type SegmentOption,
} from "@/components/settings/SegmentedControl";
import { I18nProvider, translate } from "@/lib/i18n";
import type { SaveStatus } from "@/lib/settings/types";
import {
  createFakeSettingsApi,
  makeState,
  renderSettingsWindow,
  zh,
} from "@/test/settings-harness";

const CARDS: Array<[id: string, titleKey: string]> = [
  ["provider", "settings.card.services.title"],
  ["picker", "settings.card.picker.title"],
  ["quick", "settings.quick.title"],
  ["shortcuts", "settings.card.shortcuts.title"],
  ["app", "settings.card.app.title"],
  ["about", "settings.card.about.title"],
];

afterEach(() => {
  document.documentElement.classList.remove("dark");
  vi.unstubAllGlobals();
});

test("renders the topbar title, subtitle and the idle save status", async () => {
  await renderSettingsWindow();

  expect(screen.getByText(zh("settings.page.title"))).toBeTruthy();
  expect(screen.getByText(zh("settings.page.subtitle"))).toBeTruthy();

  const pill = screen.getByTestId("save-status");
  expect(pill.getAttribute("role")).toBe("status");
  expect(pill.getAttribute("aria-live")).toBe("polite");
  expect(pill.getAttribute("data-state")).toBe("idle");
  expect(pill.textContent).toBe(zh("settings.saveStatus.idle"));
});

test("renders every save-status kind and prefers the server message", () => {
  const kinds: Array<SaveStatus["kind"]> = ["idle", "saving", "saved", "error"];
  for (const kind of kinds) {
    const { unmount } = render(
      <I18nProvider initialLocale="zh">
        <SaveStatusPill status={{ kind, message: "" }} />
      </I18nProvider>
    );
    const pill = screen.getByTestId("save-status");
    expect(pill.getAttribute("data-state")).toBe(kind);
    expect(pill.textContent).toBe(zh(`settings.saveStatus.${kind}`));
    unmount();
  }

  const { unmount } = render(
    <I18nProvider initialLocale="zh">
      <SaveStatusPill status={{ kind: "error", message: "boom" }} />
    </I18nProvider>
  );
  expect(screen.getByTestId("save-status").textContent).toBe("boom");
  unmount();
});

test("renders the six cards in contract order with localized titles", async () => {
  const { container } = await renderSettingsWindow();

  const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-card]"));
  expect(cards.map((card) => card.getAttribute("data-card"))).toEqual(
    CARDS.map(([id]) => id)
  );

  for (const [id, titleKey] of CARDS) {
    const card = container.querySelector<HTMLElement>(`[data-card="${id}"]`);
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByRole("heading", { name: zh(titleKey) })).toBeTruthy();
  }
});

test("follows the backend locale and re-renders every text on change", async () => {
  const { api } = await renderSettingsWindow();
  expect(
    screen.getByRole("heading", { name: zh("settings.card.services.title") })
  ).toBeTruthy();

  act(() => {
    api.emitState(makeState({ app: { locale: "en" } }));
  });

  expect(
    screen.getByRole("heading", {
      name: translate("en", "settings.card.services.title"),
    })
  ).toBeTruthy();
  expect(screen.getByText(translate("en", "settings.page.subtitle"))).toBeTruthy();
  expect(document.documentElement.lang).toBe("en");

  act(() => {
    api.emitState(makeState({ app: { locale: "zh" } }));
  });

  expect(
    screen.getByRole("heading", { name: zh("settings.card.services.title") })
  ).toBeTruthy();
  expect(document.documentElement.lang).toBe("zh-CN");
});

test("keeps document.title in sync with the active language", async () => {
  const { api } = await renderSettingsWindow();
  expect(document.title).toBe(zh("settings.windowTitle"));

  act(() => {
    api.emitState(makeState({ app: { locale: "en" } }));
  });
  expect(document.title).toBe(translate("en", "settings.windowTitle"));
});

test("a failed initial load shows one read-error toast and leaves the shell", async () => {
  const api = createFakeSettingsApi(makeState(), {
    getState: async () => ({ ok: false, error: "x" }),
  });
  const { container } = await renderSettingsWindow({ api });

  const message = zh("settings.error.readSettings", { error: "x" });
  expect(screen.getAllByText(message)).toHaveLength(1);
  expect(screen.getByTestId("settings-page")).toBeTruthy();
  expect(container.querySelectorAll("[data-card]")).toHaveLength(0);
});

test("applies the dark class from prefers-color-scheme", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));

  const { unmount } = await renderSettingsWindow();
  expect(document.documentElement.classList.contains("dark")).toBe(true);

  unmount();
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

test("SegmentedControl keeps tab and pressed semantics", () => {
  const tabOptions: Array<SegmentOption<"online" | "local">> = [
    { value: "online", label: "在线 API" },
    { value: "local", label: "本地模型" },
  ];
  const onTabChange = vi.fn();
  const { unmount } = render(
    <SegmentedControl
      ariaLabel="模式"
      mode="tab"
      value="online"
      options={tabOptions}
      onChange={onTabChange}
    />
  );

  expect(screen.getByRole("tablist", { name: "模式" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "在线 API" }).getAttribute("aria-selected")).toBe(
    "true"
  );
  expect(screen.getByRole("tab", { name: "本地模型" }).getAttribute("aria-selected")).toBe(
    "false"
  );

  fireEvent.click(screen.getByRole("tab", { name: "本地模型" }));
  expect(onTabChange).toHaveBeenCalledWith("local");
  unmount();

  const pressedOptions: Array<SegmentOption<"auto" | "scroll">> = [
    { value: "auto", label: "自适应" },
    { value: "scroll", label: "滚动" },
  ];
  const onPressedChange = vi.fn();
  render(
    <SegmentedControl
      ariaLabel="面板模式"
      mode="pressed"
      value="scroll"
      options={pressedOptions}
      onChange={onPressedChange}
    />
  );

  expect(screen.getByRole("group", { name: "面板模式" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "滚动" }).getAttribute("aria-pressed")).toBe(
    "true"
  );
  expect(
    screen.getByRole("button", { name: "自适应" }).getAttribute("aria-pressed")
  ).toBe("false");

  fireEvent.click(screen.getByRole("button", { name: "自适应" }));
  expect(onPressedChange).toHaveBeenCalledWith("auto");
});
