/* Installed local model list (C21/C22).
 *
 * One card per `state.models` entry. Qwen3.5 rows expose the select / selected /
 * "complete the download first" button; custom `.gguf` imports (`catalogId
 * === ""`) expose a delete button that arms for four seconds before deleting
 * (legacy `armDanger`, settings.js:906-931).
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useArmedConfirm } from "@/components/settings/useArmedConfirm";
import { useT } from "@/lib/i18n";
import { formatBytes } from "@/lib/settings/format";
import { cn } from "@/lib/utils";
import type { CatalogEntry, ModelInfo } from "@/lib/settings/types";

const QWEN35 = /^qwen3\.5-(?:0\.8b|2b|4b)-q[34]-k-m$/;

/** The only models that may be selected for the shared local runtime. */
export function isQwen35(id: string | undefined): boolean {
  return QWEN35.test(String(id ?? ""));
}

export interface LocalModelListProps {
  models: ModelInfo[];
  catalog: CatalogEntry[];
  selectedModel: string;
  recommendedModelId: string;
  removingFile: string | null;
  onSelect: (catalogId: string) => void;
  onRemove: (file: string) => void;
}

export function LocalModelList(props: LocalModelListProps) {
  const { models, catalog, selectedModel, recommendedModelId, removingFile, onSelect, onRemove } =
    props;

  if (!models.length) return null;

  return (
    <div data-testid="local-models" className="flex flex-col gap-2">
      {models.map((model) => (
        <LocalModelRow
          key={model.file}
          model={model}
          installed={catalog.some(
            (entry) =>
              entry.id === (model.catalogId ?? "") && entry.installed === true
          )}
          selectedModel={selectedModel}
          recommended={model.catalogId === recommendedModelId}
          removing={removingFile === model.file}
          onSelect={onSelect}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

interface LocalModelRowProps {
  model: ModelInfo;
  installed: boolean;
  selectedModel: string;
  recommended: boolean;
  removing: boolean;
  onSelect: (catalogId: string) => void;
  onRemove: (file: string) => void;
}

function LocalModelRow({
  model,
  installed,
  selectedModel,
  recommended,
  removing,
  onSelect,
  onRemove,
}: LocalModelRowProps) {
  const { t } = useT();
  const catalogId = model.catalogId ?? "";
  const builtin = isQwen35(catalogId);
  const selectable = builtin && installed;
  const selected = selectable && selectedModel === catalogId;
  const name = model.name || model.file || t("settings.model.unnamed");
  const confirmDelete = useArmedConfirm(() => onRemove(model.file));

  return (
    <div
      data-testid="local-model-row"
      data-file={model.file}
      data-catalog-id={catalogId}
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-lg border bg-background px-3 py-2",
        selected && "is-selected border-primary/60 bg-primary/5"
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium">{name}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={builtin ? "default" : "muted"}>
            {t(builtin ? "settings.modelRole.builtin" : "settings.modelRole.other")}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {formatBytes(model.sizeBytes)}
          </span>
          {recommended ? (
            <Badge tone="ok">{t("settings.badge.recommended")}</Badge>
          ) : null}
        </div>
      </div>

      {builtin ? (
        <Button
          type="button"
          size="sm"
          variant={selected ? "default" : "outline"}
          aria-pressed={selected}
          disabled={!selectable}
          aria-label={t(
            selected ? "settings.aria.currentModel" : "settings.aria.selectModel",
            { name }
          )}
          onClick={() => onSelect(catalogId)}
        >
          {selected
            ? t("settings.action.selected")
            : selectable
              ? t("settings.action.select")
              : t("settings.action.completeDownload")}
        </Button>
      ) : null}

      {catalogId === "" ? (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={removing}
          aria-label={t("settings.aria.deleteModel", { name })}
          onClick={confirmDelete.arm}
        >
          {confirmDelete.armed
            ? t("settings.action.confirmDelete")
            : t("settings.action.delete")}
        </Button>
      ) : null}
    </div>
  );
}
