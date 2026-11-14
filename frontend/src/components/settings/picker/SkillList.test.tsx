/* Text skill list (C36, assertions 21–23, 25).
 *
 * Mounts the list against the real settings form store so every write is
 * observable as a `update_settings` patch on the fake bridge.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { SkillList } from "@/components/settings/picker/SkillList";
import { Toaster } from "@/components/ui/toaster";
import { SettingsFormProvider } from "@/hooks/useSettingsForm";
import { I18nProvider } from "@/lib/i18n";
import type { DeepPartial, FakeSettingsApi } from "@/test/settings-harness";
import { createFakeSettingsApi, makeState, zh } from "@/test/settings-harness";
import type { StatePayload } from "@/lib/settings/types";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => {
    vi.advanceTimersByTime(4000);
  });
  cleanup();
  vi.useRealTimers();
});

async function renderSkillList(overrides: DeepPartial<StatePayload> = {}) {
  document.documentElement.lang = "zh";
  const state = makeState(overrides);
  const api = createFakeSettingsApi(state);
  const view = render(
    <SettingsFormProvider api={api}>
      <I18nProvider initialLocale="zh">
        <SkillList kind="text" onOpenSearch={() => {}} onEditCustom={() => {}} />
        <Toaster />
      </I18nProvider>
    </SettingsFormProvider>
  );
  await act(async () => {});
  return { api, ...view };
}

function advance(ms: number): Promise<void> {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function updateCalls(api: FakeSettingsApi): unknown[] {
  return api.calls
    .filter((call) => call.method === "updateSettings")
    .map((call) => call.args[0]);
}

function row(id: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-skill="${id}"]`);
  if (!node) throw new Error(`missing skill row ${id}`);
  return node;
}

function rowIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-skill]")).map(
    (node) => node.getAttribute("data-skill") ?? ""
  );
}

function switchFor(id: string, labelKey: string): HTMLElement {
  return within(row(id)).getByRole("switch", {
    name: zh("settings.aria.enableSkill", { name: zh(labelKey) }),
  });
}

test("orders enabled text skills first, then hidden built-ins and custom skills", async () => {
  await renderSkillList({
    settings: {
      picker: {
        skills: ["summarize", "translate"],
        customSkills: [
          {
            id: "custom-a",
            label: "自定义文字",
            icon: "sparkles",
            kind: "text",
            prompt: "do it",
          },
        ],
      },
    },
  });

  expect(rowIds()).toEqual([
    "summarize",
    "translate",
    "explain",
    "polish",
    "read",
    "copy",
    "screenshot",
    "search",
    "custom-a",
  ]);
  expect(row("summarize").getAttribute("data-disabled")).toBeNull();
  expect(row("explain").getAttribute("data-disabled")).toBe("true");
  expect(
    within(row("explain")).getByLabelText(zh("settings.aria.dragReorderDisabled")).getAttribute("draggable")
  ).toBe("false");
  expect(
    within(row("summarize")).getByLabelText(zh("settings.aria.dragReorder")).getAttribute("draggable")
  ).toBe("true");
  expect(within(row("custom-a")).getByText("自定义文字")).toBeTruthy();
});

test("disabling a skill drops only that id from the stored order", async () => {
  const { api } = await renderSkillList({
    settings: { picker: { skills: ["translate", "summarize"] } },
  });

  fireEvent.click(switchFor("summarize", "skill.summarize"));
  expect(updateCalls(api)).toContainEqual({ picker: { skills: ["translate"] } });
});

test("enabling a hidden skill appends it to the stored order", async () => {
  const { api } = await renderSkillList({
    settings: { picker: { skills: ["translate"] } },
  });

  fireEvent.click(switchFor("polish", "skill.polish"));
  expect(updateCalls(api)).toContainEqual({ picker: { skills: ["translate", "polish"] } });
});

test("refuses to disable the last remaining text skill", async () => {
  const { api } = await renderSkillList({
    settings: { picker: { skills: ["translate"] } },
  });

  fireEvent.click(switchFor("translate", "skill.translate"));
  expect(updateCalls(api)).toEqual([]);
  expect(screen.getByText(zh("settings.toast.keepOneSkill"))).toBeTruthy();
});

test("dragging reorders only the text category's slots", async () => {
  const { api } = await renderSkillList({
    settings: {
      picker: {
        skills: ["translate", "custom-img", "summarize"],
        customSkills: [
          {
            id: "custom-img",
            label: "图片自定义",
            icon: "zap",
            kind: "image",
            prompt: "",
          },
        ],
      },
    },
  });

  const moved = row("summarize");
  const target = row("translate");
  fireEvent.dragStart(moved, { dataTransfer: { effectAllowed: "", setData: () => {} } });
  fireEvent.dragOver(target, { dataTransfer: { dropEffect: "" } });
  fireEvent.drop(target, { dataTransfer: {} });

  expect(updateCalls(api)).toContainEqual({
    picker: { skills: ["summarize", "custom-img", "translate"] },
  });
});

test("toggling a text skill keeps a stale image-custom id in the saved order", async () => {
  const { api } = await renderSkillList({
    settings: {
      picker: {
        skills: ["translate", "custom-img", "summarize"],
        customSkills: [
          { id: "custom-img", label: "图片自定义", icon: "zap", kind: "image", prompt: "" },
        ],
      },
    },
  });

  fireEvent.click(switchFor("summarize", "skill.summarize"));
  expect(updateCalls(api)).toContainEqual({ picker: { skills: ["translate", "custom-img"] } });
});

test("prompt buttons only appear for editable skills and save a normalized override", async () => {
  const { api } = await renderSkillList();

  const promptButtons = screen.getAllByRole("button", {
    name: zh("settings.action.editPrompt"),
  });
  expect(promptButtons).toHaveLength(4);
  expect(within(row("read")).queryByRole("button", { name: zh("settings.action.editPrompt") })).toBeNull();
  expect(within(row("search")).queryByRole("button", { name: zh("settings.action.editPrompt") })).toBeNull();

  fireEvent.click(
    within(row("translate")).getByRole("button", { name: zh("settings.action.editPrompt") })
  );
  const areas = within(row("translate")).getAllByRole("textbox");
  expect(areas).toHaveLength(2);
  expect((areas[0] as HTMLTextAreaElement).value).toBe("Translate into {target}.");

  fireEvent.change(areas[0]!, { target: { value: "  Translate into {target}.  " } });
  await advance(500);
  expect(updateCalls(api)).toContainEqual({ picker: { prompts: { translate: "" } } });

  fireEvent.change(areas[0]!, { target: { value: "自定义翻译" } });
  await advance(500);
  expect(updateCalls(api)).toContainEqual({ picker: { prompts: { translate: "自定义翻译" } } });
});

test("the search row offers the search configuration panel", async () => {
  const { api } = await renderSkillList({
    settings: { picker: { searchEngine: "google" } },
  });

  fireEvent.click(
    within(row("search")).getByRole("button", { name: zh("settings.action.configureSearch") })
  );
  const radios = screen.getAllByRole("radio");
  expect(radios).toHaveLength(3);
  fireEvent.click(screen.getByRole("radio", { name: zh("settings.aria.searchWith", { engine: zh("settings.searchEngine.baidu") }) }));
  expect(updateCalls(api)).toContainEqual({ picker: { searchEngine: "baidu" } });
});

test("disabling the picker greys the list without hiding rows", async () => {
  await renderSkillList({ settings: { picker: { enabled: false } } });

  expect(rowIds()).toHaveLength(8);
  const list = screen.getByTestId("skill-list-text");
  expect(list.getAttribute("data-picker-disabled")).toBe("true");
  expect(list.className).toContain("opacity-60");
});
