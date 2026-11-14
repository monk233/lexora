/* Save-status pill (C01).
 *
 * DOM contract from the plan: `role="status"`, `aria-live="polite"`,
 * `data-state={kind}` and `data-testid="save-status"`. A non-empty
 * `status.message` (the backend's own error text) wins over the localized
 * label, matching the legacy `setSaveStatus` behaviour.
 */
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { SaveStatus } from "@/lib/settings/types";

const STATE_CLASS: Record<SaveStatus["kind"], string> = {
  idle: "border-border bg-muted text-muted-foreground",
  saving:
    "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  saved:
    "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  error: "border-transparent bg-destructive text-destructive-foreground",
};

export function SaveStatusPill({ status }: { status: SaveStatus }) {
  const { t } = useT();
  const label = status.message || t(`settings.saveStatus.${status.kind}`);

  return (
    <span
      role="status"
      aria-live="polite"
      data-state={status.kind}
      data-testid="save-status"
      className={cn(
        "inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-semibold",
        STATE_CLASS[status.kind]
      )}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      <span>{label}</span>
    </span>
  );
}
