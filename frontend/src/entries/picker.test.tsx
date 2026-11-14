import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { PickerWindow } from "../windows/PickerWindow";

describe("PickerWindow", () => {
  test("renders panel surface by default", () => {
    render(<PickerWindow surface="panel" />);
    expect(screen.getByTestId("surface")).toHaveTextContent("panel");
  });

  test("renders toolbar surface when asked", () => {
    render(<PickerWindow surface="toolbar" />);
    expect(screen.getByTestId("surface")).toHaveTextContent("toolbar");
  });
});
