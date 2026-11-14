import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { Toaster } from "./toaster"
import { toast } from "./use-toast"

function AddToasts({ prefix, count }: { prefix: string; count: number }) {
  return (
    <button
      onClick={() => {
        for (let i = 0; i < count; i += 1) toast({ description: `${prefix}-${i}` })
      }}
    >
      add
    </button>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  /* Drain the 3.6s removal queue so the module-level store starts every test
   * empty, then unmount. */
  act(() => {
    vi.advanceTimersByTime(4000)
  })
  cleanup()
  vi.useRealTimers()
})

test("caps the stack at four toasts, dropping the oldest", () => {
  render(
    <>
      <Toaster />
      <AddToasts prefix="limit" count={5} />
    </>
  )

  fireEvent.click(screen.getByText("add"))

  expect(screen.queryByText("limit-0")).toBeNull()
  expect(screen.getAllByText(/^limit-\d$/)).toHaveLength(4)
})

test("auto-removes a toast after 3.6 seconds", () => {
  render(
    <>
      <Toaster />
      <AddToasts prefix="delay" count={5} />
    </>
  )

  fireEvent.click(screen.getByText("add"))

  act(() => {
    vi.advanceTimersByTime(3599)
  })
  expect(screen.getByText("delay-4")).toBeInTheDocument()

  act(() => {
    vi.advanceTimersByTime(1)
  })
  expect(screen.queryByText("delay-4")).toBeNull()
})

test("maps tone onto the toast variant and a data-tone attribute", () => {
  render(<Toaster />)

  act(() => {
    toast({ description: "tone-info", tone: "info" })
    toast({ description: "tone-success", tone: "success" })
    toast({ description: "tone-error", tone: "error" })
    toast({ description: "tone-plain" })
  })

  const info = screen.getByText("tone-info").closest<HTMLElement>("[data-tone]")
  const success = screen.getByText("tone-success").closest<HTMLElement>("[data-tone]")
  const error = screen.getByText("tone-error").closest<HTMLElement>("[data-tone]")
  const plain = screen.getByText("tone-plain").closest<HTMLElement>("[data-tone]")

  expect(info).toHaveAttribute("data-tone", "info")
  expect(info?.className).toContain("bg-accent")
  expect(success).toHaveAttribute("data-tone", "success")
  expect(success?.className).toContain("emerald")
  expect(error).toHaveAttribute("data-tone", "error")
  expect(error?.className).toContain("destructive")
  expect(plain).toHaveAttribute("data-tone", "default")
  expect(plain?.className).toContain("bg-background")
})
