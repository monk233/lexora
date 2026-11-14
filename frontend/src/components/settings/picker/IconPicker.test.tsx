/* Icon picker (C39, assertion 31): 202-icon radio gallery, English-key search,
 * Esc precedence and selection behaviour.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { IconPicker } from "@/components/settings/picker/IconPicker";
import { I18nProvider } from "@/lib/i18n";

import { zh } from "@/test/settings-harness";

afterEach(cleanup);

function renderPicker(value = "sparkles", onChange = vi.fn()) {
  render(
    <I18nProvider initialLocale="zh">
      <IconPicker value={value} onChange={onChange} />
    </I18nProvider>
  );
  return onChange;
}

function openPicker(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: zh("settings.action.changeIcon") }));
  return screen.getByPlaceholderText(zh("settings.placeholder.iconSearch"));
}

test("shows all 202 icons, filters by key and honors Esc precedence", () => {
  renderPicker();
  const search = openPicker();

  expect(screen.getAllByRole("radio")).toHaveLength(202);

  fireEvent.change(search, { target: { value: "book" } });
  const filtered = screen.getAllByRole("radio");
  expect(filtered.length).toBeLessThan(202);
  expect(filtered.length).toBeGreaterThan(0);

  fireEvent.keyDown(search, { key: "Escape" });
  expect(screen.getAllByRole("radio")).toHaveLength(202);

  fireEvent.keyDown(screen.getByPlaceholderText(zh("settings.placeholder.iconSearch")), {
    key: "Escape",
  });
  expect(screen.queryByRole("radiogroup")).toBeNull();
});

test("selecting an icon closes the panel, updates the preview and restores focus", () => {
  const onChange = renderPicker();
  openPicker();

  const rocket = screen
    .getAllByRole("radio")
    .find((node) => node.getAttribute("title") === "rocket");
  if (!rocket) throw new Error("rocket icon missing from the gallery");
  fireEvent.click(rocket);

  expect(onChange).toHaveBeenCalledWith("rocket");
  expect(screen.queryByRole("radiogroup")).toBeNull();
  expect(screen.getByRole("button", { name: zh("settings.action.changeIcon") })).toHaveFocus();
});

test("shows the empty hint for a search without matches", () => {
  renderPicker();
  const search = openPicker();

  fireEvent.change(search, { target: { value: "zzzz" } });
  expect(screen.queryAllByRole("radio")).toHaveLength(0);
  expect(screen.getByText(zh("settings.hint.iconEmpty"))).toBeTruthy();
});

test("reopening resets the search and focuses the search field", () => {
  renderPicker();
  const search = openPicker();
  expect(search).toHaveFocus();
  fireEvent.change(search, { target: { value: "pen" } });
  fireEvent.keyDown(search, { key: "Escape" });
  expect(screen.getAllByRole("radio")).toHaveLength(202);
  fireEvent.keyDown(screen.getByPlaceholderText(zh("settings.placeholder.iconSearch")), {
    key: "Escape",
  });
  expect(screen.queryByRole("radiogroup")).toBeNull();

  const reopened = openPicker();
  expect(reopened).toHaveFocus();
  expect((reopened as HTMLInputElement).value).toBe("");
  expect(screen.getAllByRole("radio")).toHaveLength(202);
});

test("the expanded gallery is a labelled radiogroup with the selected icon checked", () => {
  renderPicker("rocket");
  openPicker();

  const group = screen.getByRole("radiogroup", { name: zh("settings.field.iconGrid") });
  const selected = group.querySelector('[aria-checked="true"]');
  expect(selected?.getAttribute("title")).toBe("rocket");
  expect(group.querySelectorAll('[role="radio"]')).toHaveLength(202);
});
