/* Qwen3.5 model catalog (C23/C25).
 *
 * The toggle button owns the `aria-expanded` contract, the open panel lists the
 * six catalog entries with their metadata, and each row swaps its download
 * button for the live progress line while a task is active. `open` is UI state
 * owned by the panel (`catalogOpen`, never persisted — inventory D10).
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useT } from "@/lib/i18n";
import {
  activeDownloadFor,
  catalogProgressText,
  formatBytes,
  quantLabel,
} from "@/lib/settings/format";
import type { CatalogEntry, DownloadProgress } from "@/lib/settings/types";

export interface ModelCatalogProps {
  open: boolean;
  catalog: CatalogEntry[];
  downloads: DownloadProgress[];
  recommendedModelId: string;
  onToggle: () => void;
  onDownload: (id: string) => void;
  onCancel: (id: string) => void;
}

export function ModelCatalog({
  open,
  catalog,
  downloads,
  recommendedModelId,
  onToggle,
  onDownload,
  onCancel,
}: ModelCatalogProps) {
  const { t } = useT();

  return (
    <>
      <Button
        id="toggle-catalog"
        type="button"
        variant="outline"
        aria-expanded={open}
        onClick={onToggle}
      >
        {t(open ? "settings.action.collapseCatalog" : "settings.action.downloadModel")}
      </Button>
      {open ? (
        <div
          data-testid="catalog-panel"
          className="w-full rounded-lg border bg-muted/20 px-3 py-2.5"
        >
          <div className="mb-2 flex flex-col gap-0.5">
            <span className="text-sm font-medium">{t("settings.catalog.title")}</span>
            <span className="text-xs text-muted-foreground">
              {t("settings.catalog.sub")}
            </span>
          </div>
          <ul data-testid="catalog-list" className="flex flex-col divide-y">
            {catalog.map((entry) => (
              <CatalogRow
                key={entry.id}
                entry={entry}
                download={activeDownloadFor(downloads, entry.id)}
                recommended={entry.id === recommendedModelId}
                onDownload={onDownload}
                onCancel={onCancel}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

interface CatalogRowProps {
  entry: CatalogEntry;
  download?: DownloadProgress;
  recommended: boolean;
  onDownload: (id: string) => void;
  onCancel: (id: string) => void;
}

function CatalogRow({ entry, download, recommended, onDownload, onCancel }: CatalogRowProps) {
  const { t } = useT();
  const quant = quantLabel(entry.filename);

  return (
    <li
      data-testid="catalog-row"
      data-catalog-id={entry.id}
      className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{entry.name || entry.id}</span>
          {entry.vision ? (
            <Badge tone="muted">{t("settings.modelRole.builtin")}</Badge>
          ) : null}
          {recommended ? <Badge tone="ok">{t("settings.badge.recommended")}</Badge> : null}
        </div>
        {entry.description ? (
          <p className="text-xs text-muted-foreground">{entry.description}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{formatBytes(entry.sizeBytes)}</span>
          {quant ? <span>{quant}</span> : null}
          {entry.license ? <span>{entry.license}</span> : null}
          {entry.languages ? <span>{entry.languages}</span> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {download ? (
          <>
            <div className="flex w-40 flex-col gap-1">
              <Progress
                value={download.percent}
                aria-label={entry.name || entry.id}
              />
              <span
                data-testid="catalog-progress-text"
                title={String(download.filename ?? "")}
                className="text-xs text-muted-foreground"
              >
                {catalogProgressText(download, t)}
              </span>
            </div>
            {download.status === "downloading" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onCancel(entry.id)}
              >
                {t("common.cancel")}
              </Button>
            ) : null}
          </>
        ) : entry.installed ? (
          <Badge tone="ok">{t("settings.badge.installed")}</Badge>
        ) : (
          <Button type="button" size="sm" onClick={() => onDownload(entry.id)}>
            {t("settings.action.download")}
          </Button>
        )}
      </div>
    </li>
  );
}
