import { render, screen } from "@testing-library/react"
import { expect, test } from "vitest"

import { Progress } from "./progress"

function indicator(bar: HTMLElement): HTMLElement {
  return bar.firstElementChild as HTMLElement
}

test("clamps values above 100", () => {
  render(<Progress value={150} aria-label="下载中" />)

  const bar = screen.getByRole("progressbar", { name: "下载中" })
  expect(bar).toHaveAttribute("aria-valuenow", "100")
  expect(indicator(bar).style.transform).toBe("translateX(0%)")
})

test("clamps negative values to zero", () => {
  render(<Progress value={-5} />)

  const bar = screen.getByRole("progressbar")
  expect(bar).toHaveAttribute("aria-valuenow", "0")
  expect(indicator(bar).style.transform).toBe("translateX(-100%)")
})

test("passes normal values through and forwards aria-label", () => {
  render(<Progress value={40} aria-label="处理进度" />)

  const bar = screen.getByRole("progressbar", { name: "处理进度" })
  expect(bar).toHaveAttribute("aria-valuenow", "40")
  expect(indicator(bar).style.transform).toBe("translateX(-60%)")
})
