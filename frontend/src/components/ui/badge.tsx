import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

export type BadgeTone = "default" | "ok" | "warn" | "error" | "muted"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        ok: "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
        warn: "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
        muted: "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>

/* `error` shares the destructive styling instead of duplicating it. */
const toneToVariant: Record<BadgeTone, BadgeVariant> = {
  default: "default",
  ok: "ok",
  warn: "warn",
  error: "destructive",
  muted: "muted",
}

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  tone?: BadgeTone
}

function Badge({ className, variant, tone, ...props }: BadgeProps) {
  return (
    <div
      className={cn(badgeVariants({ variant: tone ? toneToVariant[tone] : variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
