/* Local segmented control that preserves the legacy accessibility contract.
 *
 * The plan deliberately avoids the Radix Tabs/ToggleGroup primitives: their
 * roving focus changes keyboard behaviour, while `web/settings.js` exposed a
 * `role="tab"` + `aria-selected` pair for the provider/skill tabs (C02/C34/C35)
 * and `aria-pressed` for exclusive panel-mode groups (C40).
 *
 * mode="tab"     -> container role="tablist", buttons role="tab" + aria-selected
 * mode="pressed" -> container role="group", buttons aria-pressed
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  title?: string;
  ariaLabel?: string;
  badge?: ReactNode;
  ariaControls?: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  options: Array<SegmentOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  mode?: "tab" | "pressed";
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  mode = "pressed",
  className,
}: SegmentedControlProps<T>) {
  const isTab = mode === "tab";

  return (
    <div
      role={isTab ? "tablist" : "group"}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border bg-muted p-1",
        className
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role={isTab ? "tab" : undefined}
            aria-selected={isTab ? active : undefined}
            aria-pressed={isTab ? undefined : active}
            aria-label={option.ariaLabel}
            aria-controls={option.ariaControls}
            title={option.title}
            data-state={active ? "active" : "inactive"}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            {option.badge}
          </button>
        );
      })}
    </div>
  );
}
