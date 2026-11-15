/* Picker toolbar capsule (Task 3). */
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { PickerToolbar } from "@/components/picker/PickerToolbar";
import type { PickerSkill } from "@/lib/picker/model";
import { createFakePickerApi, renderPicker } from "@/test/picker-harness";

afterEach(() => {
  vi.restoreAllMocks();
});

const SKILLS: PickerSkill[] = [
  { id: "translate", label: "翻译", icon: "languages" },
  { id: "summarize", label: "总结", icon: "list" },
  { id: "explain", label: "解释", icon: "lightbulb" },
  { id: "screenshot", label: "截图", icon: "scan-eye", kind: "image" },
];

function renderToolbar(overrides: Partial<Parameters<typeof PickerToolbar>[0]> = {}) {
  const api = createFakePickerApi();
  const onRun = vi.fn();
  const onMore = vi.fn();
  renderPicker(
    <PickerToolbar
      skills={SKILLS}
      onRun={onRun}
      onMore={onMore}
      api={api}
      {...overrides}
    />
  );
  return { api, onRun, onMore };
}

test("renders skill buttons in backend order with labels", () => {
  renderToolbar();
  const toolbar = screen.getByRole("toolbar");
  const buttons = Array.from(toolbar.querySelectorAll("[data-skill]"));
  expect(buttons.map((button) => button.getAttribute("data-skill"))).toEqual([
    "translate",
    "summarize",
    "explain",
    "screenshot",
  ]);
  expect(screen.getByLabelText("翻译")).toBeTruthy();
  expect(buttons[3].getAttribute("data-kind")).toBe("image");
});

test("marks the compact mode", () => {
  renderToolbar({ compact: true });
  expect(screen.getByRole("toolbar").getAttribute("data-compact")).toBe("true");
});

test("clicking a skill runs it", () => {
  const { onRun } = renderToolbar();
  fireEvent.click(screen.getByLabelText("总结"));
  expect(onRun).toHaveBeenCalledWith("summarize");
});

test("the more button reports how many skills overflowed", () => {
  const { onMore } = renderToolbar();
  const more = screen.getByRole("button", { name: "更多" });
  expect(more.getAttribute("data-overflow-count")).toBe("0");
  fireEvent.click(more);
  expect(onMore).toHaveBeenCalled();
});

test("reports its measured size through picker_resize", async () => {
  const { api } = renderToolbar();
  await vi.waitFor(() => expect(api.calls.some((call) => call.method === "resize")).toBe(true));
  const call = api.calls.find((entry) => entry.method === "resize");
  expect(Number(call?.args[0])).toBeGreaterThanOrEqual(1);
  expect(Number(call?.args[1])).toBeGreaterThanOrEqual(1);
});
