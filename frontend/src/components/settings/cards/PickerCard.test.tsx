/* Picker behavior card scaffold (C32–C35, C45–C47, assertions 19–28).
 *
 * Mounted through the real settings window so the card sees the same store the
 * production page does; writes are asserted on the fake bridge's call log.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { FakeSettingsApi } from "@/test/settings-harness";
import { makeState, renderSettingsWindow, zh } from "@/test/settings-harness";

/* jsdom gaps that Radix Select / Popper touch while opening the listbox. */
beforeEach(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (!("ResizeObserver" in globalThis)) {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function updateCalls(api: FakeSettingsApi): unknown[] {
  return api.calls
    .filter((call) => call.method === "updateSettings")
    .map((call) => call.args[0]);
}

function field(key: string): string {
  return zh(key);
}

test("saves the enable switch, compact switch and panel mode immediately", async () => {
  const { api } = await renderSettingsWindow();

  fireEvent.click(screen.getByRole("switch", { name: field("settings.field.pickerEnabled") }));
  await act(async () => {});
  expect(updateCalls(api)).toContainEqual({ picker: { enabled: false } });

  fireEvent.click(screen.getByRole("switch", { name: field("settings.field.compactMode") }));
  await act(async () => {});
  expect(updateCalls(api)).toContainEqual({ picker: { compact: false } });

  const scroll = screen.getByRole("button", { name: field("settings.panelMode.scroll") });
  expect(screen.getByRole("button", { name: field("settings.panelMode.auto") })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  fireEvent.click(scroll);
  await act(async () => {});
  expect(updateCalls(api)).toContainEqual({ picker: { panelMode: "scroll" } });
  expect(scroll).toHaveAttribute("aria-pressed", "true");
});

test("shows tab counts and switches lists", async () => {
  await renderSettingsWindow({
    state: makeState({ settings: { picker: { captureSkills: ["pin", "ocr"] } } }),
  });

  expect(screen.getByRole("tab", { name: /文字技能/ })).toBeTruthy();
  /* Legacy semantics: every text row counts, enabled or not. */
  expect(screen.getByRole("tab", { name: /文字技能/ })).toHaveTextContent("(8)");
  expect(screen.getByRole("tab", { name: /图片技能.*2/ })).toBeTruthy();
  expect(screen.queryByTestId("skill-list-image")).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: /图片技能/ }));
  expect(screen.getByTestId("skill-list-image")).toBeTruthy();
  expect(screen.queryByTestId("skill-list-text")).toBeNull();
  expect(screen.getByRole("tab", { name: /图片技能/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: /图片技能/ })).toHaveAttribute(
    "aria-controls",
    "skill-list-image"
  );
});

test("disabling a text skill does not change the text tab count", async () => {
  const { api } = await renderSettingsWindow();

  const textTab = () => screen.getByRole("tab", { name: /文字技能/ });
  const rowSwitches = () =>
    within(screen.getByTestId("skill-list-text")).getAllByRole("switch");

  expect(rowSwitches()).toHaveLength(8);
  expect(textTab()).toHaveTextContent("(8)");

  fireEvent.click(
    screen.getByRole("switch", {
      name: zh("settings.aria.enableSkill", { name: zh("skill.summarize") }),
    })
  );
  await act(async () => {});

  expect(updateCalls(api)).toContainEqual({
    picker: { skills: ["translate", "explain", "read", "copy", "search"] },
  });
  expect(rowSwitches()).toHaveLength(8);
  expect(textTab()).toHaveTextContent("(8)");
});

test("target language list has 39 options with auto first", async () => {
  const { api } = await renderSettingsWindow();

  fireEvent.click(screen.getByRole("combobox", { name: field("settings.field.defaultTargetLang") }));
  const options = screen.getAllByRole("option");
  expect(options).toHaveLength(39);
  expect(options[0]).toHaveTextContent(zh("settings.targetLang.auto"));

  fireEvent.click(options[1]!);
  expect(updateCalls(api)).toContainEqual({ picker: { defaultTargetLang: "zh" } });
});

test("an unknown stored target language falls back to auto", async () => {
  await renderSettingsWindow({
    state: makeState({ settings: { picker: { defaultTargetLang: "not-a-language" } } }),
  });

  const trigger = screen.getByRole("combobox", { name: field("settings.field.defaultTargetLang") });
  expect(trigger).toHaveTextContent(zh("settings.targetLang.auto"));
});

test("the search skill expands the engine radio group and saves the choice", async () => {
  const { api } = await renderSettingsWindow();

  fireEvent.click(screen.getByRole("button", { name: field("settings.action.configureSearch") }));
  const radios = screen.getAllByRole("radio");
  expect(radios).toHaveLength(3);
  expect(screen.getByRole("radio", { name: zh("settings.aria.searchWith", { engine: zh("settings.searchEngine.google") }) })).toHaveAttribute(
    "aria-checked",
    "true"
  );

  fireEvent.click(
    screen.getByRole("radio", {
      name: zh("settings.aria.searchWith", { engine: zh("settings.searchEngine.baidu") }),
    })
  );
  expect(updateCalls(api)).toContainEqual({ picker: { searchEngine: "baidu" } });
});

test("renders blacklist chips and removes an entry", async () => {
  const { api } = await renderSettingsWindow({
    state: makeState({ settings: { picker: { blacklist: ["Chrome.exe", "WeChat.exe"] } } }),
  });

  expect(screen.getByText("Chrome.exe")).toBeTruthy();
  expect(screen.getByText("WeChat.exe")).toBeTruthy();

  fireEvent.click(
    screen.getByRole("button", {
      name: zh("settings.aria.removeBlacklist", { name: "Chrome.exe" }),
    })
  );
  expect(updateCalls(api)).toContainEqual({ picker: { blacklist: ["WeChat.exe"] } });
});

test("adds a blacklist entry through the card field", async () => {
  const { api } = await renderSettingsWindow();

  const input = screen.getByPlaceholderText(zh("settings.placeholder.blacklist"));
  fireEvent.change(input, { target: { value: "Notepad.exe" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(updateCalls(api)).toContainEqual({ picker: { blacklist: ["Notepad.exe"] } });
});

test("capture skills may all be disabled and then show the empty hint", async () => {
  const { api } = await renderSettingsWindow({
    state: makeState({ settings: { picker: { captureSkills: [] } } }),
  });

  fireEvent.click(screen.getByRole("tab", { name: /图片技能/ }));
  expect(screen.getByText(zh("settings.hint.captureEmpty"))).toBeTruthy();
  expect(screen.getByRole("tab", { name: /图片技能/ })).toHaveTextContent("(0)");

  fireEvent.click(
    screen.getByRole("switch", {
      name: zh("settings.aria.enableSkill", { name: zh("capture.ocr") }),
    })
  );
  await act(async () => {});
  expect(updateCalls(api)).toContainEqual({ picker: { captureSkills: ["ocr"] } });
  expect(screen.queryByText(zh("settings.hint.captureEmpty"))).toBeNull();
  expect(screen.getByRole("tab", { name: /图片技能/ })).toHaveTextContent("(1)");
});

test("saving a custom image skill enables it in captureSkills and switches tab", async () => {
  const { api } = await renderSettingsWindow();

  fireEvent.click(screen.getByRole("button", { name: /添加技能/ }));
  const editor = screen.getByTestId("custom-skill-editor");
  const name = within(editor).getByLabelText(zh("settings.field.name"));
  expect(name).toHaveFocus();

  fireEvent.change(name, { target: { value: "截图问答" } });
  fireEvent.click(
    within(editor).getByRole("button", { name: zh("settings.skillKind.imageAria") })
  );
  fireEvent.change(within(editor).getByLabelText(zh("settings.field.prompt")), {
    target: { value: "What is in this picture?" },
  });

  fireEvent.click(
    within(editor).getByRole("button", { name: zh("settings.action.changeIcon") })
  );
  const rocket = screen
    .getAllByRole("radio")
    .find((node) => node.getAttribute("title") === "rocket");
  if (!rocket) throw new Error("rocket icon missing from the gallery");
  fireEvent.click(rocket);

  fireEvent.click(within(editor).getByRole("button", { name: zh("settings.action.save") }));
  await act(async () => {});

  const patch = updateCalls(api).at(-1) as {
    picker: { customSkills: Array<Record<string, unknown>>; captureSkills: string[] };
  };
  expect(patch.picker.customSkills).toHaveLength(1);
  expect(patch.picker.customSkills[0]).toMatchObject({
    label: "截图问答",
    icon: "rocket",
    kind: "image",
    prompt: "What is in this picture?",
  });
  expect(patch.picker.captureSkills).toContain(patch.picker.customSkills[0]!.id);
  expect(screen.getByRole("tab", { name: /图片技能/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(screen.queryByTestId("custom-skill-editor")).toBeNull();
  expect(screen.getByText(zh("settings.toast.skillAdded", { label: "截图问答" }))).toBeTruthy();
});

test("editing an existing custom image skill pre-fills and deletes it from both arrays", async () => {
  const { api } = await renderSettingsWindow({
    state: makeState({
      settings: {
        picker: {
          captureSkills: ["ocr", "custom-img"],
          customSkills: [
            {
              id: "custom-img",
              label: "自定义图片",
              icon: "rocket",
              kind: "image",
              prompt: "看图说话",
            },
          ],
        },
      },
    }),
  });

  fireEvent.click(screen.getByRole("tab", { name: /图片技能/ }));
  fireEvent.click(screen.getByRole("button", { name: zh("settings.action.editSkill") }));

  const editor = screen.getByTestId("custom-skill-editor");
  expect(within(editor).getByLabelText(zh("settings.field.name"))).toHaveValue("自定义图片");
  expect(screen.getByText(zh("settings.editor.editTitle"))).toBeTruthy();

  fireEvent.click(within(editor).getByRole("button", { name: zh("settings.action.delete") }));
  fireEvent.click(
    within(editor).getByRole("button", { name: zh("settings.action.confirmDeleteAgain") })
  );
  await act(async () => {});

  const patch = updateCalls(api).at(-1) as {
    picker: { customSkills: unknown[]; captureSkills: string[] };
  };
  expect(patch.picker.customSkills).toEqual([]);
  expect(patch.picker.captureSkills).toEqual(["ocr"]);
  expect(screen.queryByTestId("custom-skill-editor")).toBeNull();
  expect(
    screen.getByText(zh("settings.toast.skillDeleted", { label: "自定义图片" }))
  ).toBeTruthy();
});

test("deleting the last custom text skill restores the builtin defaults", async () => {
  const { api } = await renderSettingsWindow({
    state: makeState({
      settings: {
        picker: {
          skills: ["custom-txt"],
          customSkills: [
            {
              id: "custom-txt",
              label: "自定义文字",
              icon: "zap",
              kind: "text",
              prompt: "写点字",
            },
          ],
        },
      },
    }),
  });

  fireEvent.click(
    screen.getByRole("button", {
      name: zh("settings.aria.deleteSkill", { name: "自定义文字" }),
    })
  );
  fireEvent.click(
    screen.getByRole("button", { name: zh("settings.action.confirmDeleteAgain") })
  );
  await act(async () => {});

  const patch = updateCalls(api).at(-1) as {
    picker: { customSkills: unknown[]; skills: string[]; captureSkills: string[] };
  };
  expect(patch.picker.customSkills).toEqual([]);
  expect(patch.picker.skills).toEqual([
    "translate",
    "summarize",
    "explain",
    "read",
    "copy",
    "search",
  ]);
  expect(patch.picker.captureSkills).toEqual([
    "pin",
    "shape",
    "arrow",
    "pen",
    "text",
    "mosaic",
    "ocr",
    "translate",
    "explain",
  ]);
});
