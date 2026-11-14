/* Sticky topbar: brand copy on the left, save status on the right (C01/S1).
 *
 * It is not a window drag strip: the Tauri title bar stays native (plan Global
 * Constraints). Keeping the header sticky is why the page body scrolls instead
 * of using a ScrollArea wrapper.
 */
import { useT } from "@/lib/i18n";
import type { SaveStatus } from "@/lib/settings/types";

import { SaveStatusPill } from "./SaveStatusPill";

export function Topbar({ status }: { status: SaveStatus }) {
  const { t } = useT();

  return (
    <header className="sticky top-0 z-20 border-b bg-background">
      <div className="mx-auto flex w-full max-w-[1100px] items-center justify-between gap-4 px-8 py-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-base font-semibold leading-tight">
            {t("settings.page.title")}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {t("settings.page.subtitle")}
          </span>
        </div>
        <SaveStatusPill status={status} />
      </div>
    </header>
  );
}
