"use client"

import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/lib/utils"

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => {
  /* Radix rejects out-of-range values and falls back to an indeterminate bar,
   * so clamp here and keep every real progress reading inside [0, 100]. */
  const clamped =
    value === undefined || value === null ? value : Math.min(100, Math.max(0, value))

  return (
    <ProgressPrimitive.Root
      ref={ref}
      value={clamped}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-primary/20", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className="h-full w-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(${-(100 - (clamped ?? 0))}%)` }}
      />
    </ProgressPrimitive.Root>
  )
})
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
