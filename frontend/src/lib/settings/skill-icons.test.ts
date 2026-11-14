/* Generated icon table (C39, assertion 31): the gallery must stay in lockstep
 * with the legacy key list, and every value must be a plain inline SVG.
 */
import { expect, test } from "vitest";

import { CUSTOM_SKILL_ICON_KEYS } from "@/lib/constants";

import { CUSTOM_SKILL_ICON_SVGS } from "./skill-icons";

test("covers exactly the legacy icon key set", () => {
  expect(Object.keys(CUSTOM_SKILL_ICON_SVGS).sort()).toEqual(
    [...CUSTOM_SKILL_ICON_KEYS].sort()
  );
  expect(Object.keys(CUSTOM_SKILL_ICON_SVGS)).toHaveLength(202);
  for (const svg of Object.values(CUSTOM_SKILL_ICON_SVGS)) {
    expect(svg.trimStart().startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/<script|onload=|javascript:/i);
  }
});

test("known legacy keys keep their drawn artwork", () => {
  expect(CUSTOM_SKILL_ICON_SVGS.book).toContain("<path");
  expect(CUSTOM_SKILL_ICON_SVGS.sparkles).toContain("<path");
  expect(CUSTOM_SKILL_ICON_SVGS["arrow-up-right"]).toContain("<path");
});
