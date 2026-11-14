/* Two-column field grid used by every card.
 *
 * The label column is `minmax(150px, 220px)` and the control column
 * `minmax(0, 1fr)`, matching the legacy `.field` grid (settings.css:258-263).
 * Hints and errors are rendered under the control so later tasks can attach
 * inline validation without inventing another layout.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  controlClassName?: string;
  children: ReactNode;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  controlClassName,
  children,
}: FieldProps) {
  return (
    <div className="grid items-start gap-x-6 gap-y-1.5 py-3.5 sm:grid-cols-[minmax(150px,220px)_minmax(0,1fr)]">
      <label htmlFor={htmlFor} className="text-sm font-medium leading-6">
        {label}
      </label>
      <div className={cn("flex min-w-0 flex-col gap-1.5", controlClassName)}>
        {children}
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        {error ? (
          <p role="alert" className="text-xs font-medium text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
