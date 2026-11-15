/* Picker entry surfaces (P0 scaffold test, kept as the smoke gate for P3). */
import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";

import { PickerWindow } from "@/windows/PickerWindow";
import { createFakePickerApi, renderPicker } from "@/test/picker-harness";

describe("PickerWindow", () => {
  test("renders panel surface by default", () => {
    renderPicker(<PickerWindow api={createFakePickerApi()} />);
    expect(screen.getByTestId("surface").getAttribute("data-surface")).toBe("panel");
  });

  test("renders toolbar surface when asked", () => {
    renderPicker(<PickerWindow surface="toolbar" api={createFakePickerApi()} />);
    expect(screen.getByTestId("surface").getAttribute("data-surface")).toBe("toolbar");
    expect(screen.getByRole("toolbar")).toBeTruthy();
  });
});
