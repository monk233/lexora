/* Engine status row of the local model panel (C16–C19).
 *
 * Read-only state line plus the download / cancel actions and the engine
 * download progress bar. Everything is driven by props: the owning panel owns
 * the IPC calls and the merged download list.
 */
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useT } from "@/lib/i18n";
import { engineProgressText } from "@/lib/settings/format";
import type { DownloadProgress, EngineStatus } from "@/lib/settings/types";

export interface EngineRowProps {
  engine: EngineStatus;
  download?: DownloadProgress;
  busy: boolean;
  onDownload: () => void;
  onCancel: () => void;
}

const DOT_TONE: Record<string, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-destructive",
  muted: "bg-muted-foreground",
};

export function EngineRow({ engine, download, busy, onDownload, onCancel }: EngineRowProps) {
  const { t } = useT();
  const tone = engine.engineAvailable ? "ok" : "warn";

  let title = t("settings.engine.missing");
  let sub = t("settings.engine.missingSub");
  if (download) {
    title = t("settings.engine.downloading");
    sub = String(download.filename ?? "");
  } else if (engine.engineAvailable) {
    title = t("settings.engine.installed");
    sub = t("settings.engine.installedSub");
  }

  return (
    <div data-testid="engine-row" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            data-testid="engine-dot"
            data-tone={tone}
            aria-hidden="true"
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT_TONE[tone]}`}
          />
          <div className="flex min-w-0 flex-col">
            <span data-testid="engine-title" className="text-sm font-medium leading-tight">
              {title}
            </span>
            <span
              data-testid="engine-sub"
              className="truncate text-xs text-muted-foreground"
            >
              {sub}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {download ? (
            <Button
              id="cancel-engine-download"
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onCancel}
            >
              {t("common.cancel")}
            </Button>
          ) : engine.engineAvailable ? null : (
            <Button
              id="download-engine"
              type="button"
              size="sm"
              disabled={busy}
              onClick={onDownload}
            >
              {t("settings.action.downloadEngine")}
            </Button>
          )}
        </div>
      </div>

      {download ? (
        <div data-testid="engine-progress" className="flex flex-col gap-1">
          <Progress value={download.percent} aria-label={t("settings.engine.downloading")} />
          <span data-testid="engine-progress-text" className="text-xs text-muted-foreground">
            {engineProgressText(download, t)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
