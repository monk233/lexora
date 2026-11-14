import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Button } from "./button";

test("renders children with primary styling", () => {
  render(<Button>确定</Button>);
  const button = screen.getByRole("button", { name: "确定" });
  expect(button.className).toContain("bg-primary");
});

test("supports outline variant", () => {
  render(<Button variant="outline">取消</Button>);
  expect(screen.getByRole("button", { name: "取消" }).className).toContain("border");
});
