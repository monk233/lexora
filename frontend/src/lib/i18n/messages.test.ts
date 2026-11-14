import { expect, test } from "vitest";
import { messages as zh } from "./messages.zh";
import { messages as en } from "./messages.en";

test("zh and en expose the same keys", () => {
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
});

test("known key resolves both languages", () => {
  expect(zh["common.ok"]).toBe("确定");
  expect(en["common.ok"]).toBe("OK");
});

test("interpolation placeholders survive migration", () => {
  expect(en["capture.colorWithValue"]).toBe("Color {color}");
});
