"use client"

import { useToast, type ToastTone } from "@/components/ui/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import type { ToastProps } from "@/components/ui/toast"

type ToastVariant = NonNullable<ToastProps["variant"]>

const TONE_VARIANT: Record<ToastTone, ToastVariant> = {
  info: "info",
  success: "success",
  error: "destructive",
}

/* Legacy callers pass `variant` instead of `tone`; keep `data-tone` truthful
 * for them without changing their call sites. */
const VARIANT_TONE: Partial<Record<ToastVariant, ToastTone>> = {
  info: "info",
  success: "success",
  destructive: "error",
}

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, tone, variant, ...props }) {
        const resolvedVariant = tone ? TONE_VARIANT[tone] : (variant ?? "default")
        const resolvedTone: ToastTone | "default" =
          tone ?? (variant ? VARIANT_TONE[variant] : undefined) ?? "default"

        return (
          <Toast
            key={id}
            variant={resolvedVariant}
            data-tone={resolvedTone}
            {...props}
          >
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && <ToastDescription>{description}</ToastDescription>}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
