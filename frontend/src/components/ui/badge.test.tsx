import { render, screen } from "@testing-library/react"
import { expect, test } from "vitest"

import { Badge, type BadgeTone } from "./badge"

const TONES: BadgeTone[] = ["default", "ok", "warn", "error", "muted"]

test("renders each settings tone with its own styling", () => {
  render(
    <>
      {TONES.map((tone) => (
        <Badge key={tone} tone={tone}>
          {`tone-${tone}`}
        </Badge>
      ))}
    </>
  )

  expect(screen.getByText("tone-default").className).toContain("bg-primary")
  expect(screen.getByText("tone-ok").className).toContain("emerald")
  expect(screen.getByText("tone-warn").className).toContain("amber")
  expect(screen.getByText("tone-error").className).toContain("destructive")
  expect(screen.getByText("tone-muted").className).toContain("bg-muted")
})

test("keeps the variant prop working for existing callers", () => {
  render(<Badge variant="secondary">legacy-badge</Badge>)

  expect(screen.getByText("legacy-badge").className).toContain("bg-secondary")
})
