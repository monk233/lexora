/* Local model panel of the translation service card (C16–C31, D3/D9/D10).
 *
 * Owns the `download-progress` subscription for the whole window while the
 * local mode is open: progress events merge into the snapshot returned by
 * `get_state` (`mergeDownloads`), terminal events trigger exactly one refresh,
 * and the disposer runs on unmount. Engine / model state itself is never
 * polled — it always comes from `state` (inventory §3 "没有轮询").
 *
 * `restart_local` must see the queued model selection first, so the restart
 * handler awaits `flushSaveQueue()` and aborts on failure (inventory §4.12).
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { Field } from "@/components/settings/Field";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { useT } from "@/lib/i18n";
import { activeDownloadFor, formatBytes, isActiveDownload } from "@/lib/settings/format";
import type {
  ApiResult,
  DownloadProgress,
  HardwareRecommendation,
} from "@/lib/settings/types";

import { EngineRow } from "./EngineRow";
import { isQwen35, LocalModelList } from "./LocalModelList";
import { ModelCatalog } from "./ModelCatalog";

type LocalAction = "" | "start" | "stop" | "restart";

/** Inline copy captured at command time, localized only when rendered. */
type LocalError =
  | { text: string; hint?: string }
  | { key: string; params?: Record<string, string | number>; hint?: string };

function downloadKey(progress: DownloadProgress): string {
  return `${progress.kind}:${progress.id ?? ""}`;
}

/**
 * Merge live `download-progress` payloads into the backend snapshot. An event
 * for an existing key replaces it; a new active task is appended; a terminal
 * task is dropped from the override map by the caller (legacy
 * `mergeProgressIntoDownloads`, settings.js:1012-1041).
 */
function mergeDownloads(
  base: DownloadProgress[],
  overrides: Record<string, DownloadProgress>
): DownloadProgress[] {
  const merged = base.map((item) => overrides[downloadKey(item)] ?? item);
  const seen = new Set(merged.map(downloadKey));
  for (const item of Object.values(overrides)) {
    if (!seen.has(downloadKey(item))) merged.push(item);
  }
  return merged;
}

/** The engine treats a user cancellation as a no-op, not as an error (C31). */
function isCancellation(message: string | undefined): boolean {
  return /取消|cancel/i.test(String(message ?? ""));
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return error === undefined || error === null ? "" : String(error);
}

export function LocalPanel() {
  const form = useSettingsForm();
  const { t } = useT();
  const { api, refresh, save, flushSaveQueue } = form;

  const engine = form.state?.engine;
  const models = form.state?.models ?? [];
  const catalog = form.state?.catalog ?? [];
  const hardware: HardwareRecommendation = form.state?.hardwareRecommendation ?? {
    totalMemoryBytes: 0,
    cpuThreads: 0,
    gpuVramBytes: 0,
    gpuName: "",
    recommendedModelId: "",
    recommendedQuant: "",
    reason: "",
  };
  const selectedModel = form.settings?.provider.local.selectedModel ?? "";
  const keepRunning = form.settings?.provider.local.keepRunning === true;

  const [localBusy, setLocalBusy] = useState(false);
  const [localAction, setLocalAction] = useState<LocalAction>("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [removingFile, setRemovingFile] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<LocalError | null>(null);
  const [progressOverrides, setProgressOverrides] = useState<
    Record<string, DownloadProgress>
  >({});
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const busyRef = useRef(false);
  /* The subscription is created once; `t` / `refresh` are read through refs so
   * a language switch or a re-render never re-subscribes (the harness asserts a
   * single unsubscribe on unmount). */
  const tRef = useRef(t);
  tRef.current = t;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const off = api.onDownloadProgress((progress) => {
      if (!progress || typeof progress !== "object") return;
      const key = downloadKey(progress);
      setProgressOverrides((previous) => {
        if (!isActiveDownload(progress)) {
          if (!(key in previous)) return previous;
          const next = { ...previous };
          delete next[key];
          return next;
        }
        return { ...previous, [key]: progress };
      });
      if (isActiveDownload(progress)) return;
      if (progress.status === "failed") {
        if (progress.kind === "engine") {
          setInlineError({
            text: progress.error || tRef.current("settings.error.engineDownload"),
          });
        } else {
          toast({
            description: tRef.current("settings.toast.downloadFailed", {
              error: progress.error || tRef.current("settings.error.unknown"),
            }),
            tone: "error",
          });
        }
      }
      void refreshRef.current();
    });
    return off;
  }, [api]);

  const downloads = useMemo(
    () => mergeDownloads(form.state?.downloads ?? [], progressOverrides),
    [form.state?.downloads, progressOverrides]
  );

  const engineDownload = activeDownloadFor(downloads, "engine");
  const localState = engine?.localState ?? "stopped";
  const starting = localState === "starting";
  const running = localState === "ready" || String(localState) === "running";

  const markPending = (key: string, value: boolean): void => {
    setPending((previous) => {
      if (value) return { ...previous, [key]: true };
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  };

  const handleDownloadEngine = async (): Promise<void> => {
    if (pending.engine) return;
    markPending("engine", true);
    setInlineError(null);
    try {
      const result = await api.downloadEngine();
      if (!result.ok && !isCancellation(result.error)) {
        setInlineError({
          text: result.error || t("settings.error.engineDownload"),
          hint: result.hint,
        });
      }
    } catch (error) {
      setInlineError({ text: errorText(error) || t("settings.error.engineDownload") });
    } finally {
      markPending("engine", false);
    }
    await refresh();
  };

  const handleCancelDownload = async (id: string): Promise<void> => {
    await api.cancelDownload(id);
    await refresh();
  };

  const handleDownloadModel = async (id: string): Promise<void> => {
    if (activeDownloadFor(downloads, id)) {
      toast({ description: t("settings.toast.modelDownloading"), tone: "info" });
      return;
    }
    if (pending[id]) return;
    markPending(id, true);
    setInlineError(null);
    try {
      const result = await api.downloadModel(id);
      if (!result.ok && !isCancellation(result.error)) {
        toast({
          description: t("settings.toast.modelDownloadFailed", {
            error: result.error || t("settings.error.unknown"),
          }),
          tone: "error",
        });
        setInlineError({
          text: result.error || t("settings.error.modelDownload"),
          hint: result.hint,
        });
      }
    } catch (error) {
      setInlineError({ text: errorText(error) || t("settings.error.modelDownload") });
    } finally {
      markPending(id, false);
    }
    await refresh();
  };

  const handleImportModel = async (): Promise<void> => {
    setInlineError(null);
    try {
      const result = await api.importModel();
      if (!result.ok) {
        setInlineError({
          text: result.error || t("settings.error.importModel"),
          hint: result.hint,
        });
        return;
      }
      toast({ description: t("settings.toast.modelImported"), tone: "success" });
      await refresh();
    } catch (error) {
      setInlineError({ text: errorText(error) || t("settings.error.importModel") });
    }
  };

  const handleRemoveModel = async (file: string): Promise<void> => {
    if (removingFile) return;
    setRemovingFile(file);
    setInlineError(null);
    try {
      const result = await api.removeModel(file);
      await refresh();
      if (result.ok) {
        toast({ description: t("settings.toast.modelDeleted"), tone: "success" });
      } else {
        setInlineError({
          text: result.error || t("settings.error.modelDelete"),
          hint: result.hint,
        });
      }
    } catch (error) {
      setInlineError({ text: errorText(error) || t("settings.error.modelDelete") });
    } finally {
      setRemovingFile(null);
    }
  };

  const handleSelectModel = (catalogId: string): void => {
    if (selectedModel === catalogId) return;
    save({ provider: { local: { selectedModel: catalogId } } });
    if (running || starting) {
      toast({ description: t("settings.toast.modelSwitched"), tone: "info" });
    }
  };

  const runLocalAction = async (
    action: Exclude<LocalAction, "" | "restart">,
    invoke: () => Promise<ApiResult>,
    fallbackKey: string
  ): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLocalBusy(true);
    setLocalAction(action);
    setInlineError(null);
    try {
      const result = await invoke();
      await refresh();
      if (!result.ok) {
        setInlineError({ text: result.error || t(fallbackKey), hint: result.hint });
      }
    } catch (error) {
      setInlineError({ text: errorText(error) || t(fallbackKey) });
    } finally {
      busyRef.current = false;
      setLocalBusy(false);
      setLocalAction("");
    }
  };

  const handleRestart = async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLocalBusy(true);
    setLocalAction("restart");
    setInlineError(null);
    try {
      /* Only the queue is flushed — unrelated text drafts (online key etc.) are
       * deliberately left alone (inventory §4.12). */
      const flushed = await flushSaveQueue();
      if (!flushed.ok) {
        setInlineError(
          flushed.error
            ? { text: flushed.error }
            : { key: "settings.error.restartLocal" }
        );
        return;
      }
      const result = await api.restartLocal();
      await refresh();
      if (!result.ok) {
        setInlineError({
          text: result.error || t("settings.error.restartLocal"),
          hint: result.hint,
        });
      }
    } catch (error) {
      setInlineError({ text: errorText(error) || t("settings.error.restartLocal") });
    } finally {
      busyRef.current = false;
      setLocalBusy(false);
      setLocalAction("");
    }
  };

  if (!engine) return <div data-testid="provider-local" />;

  let stateTone: BadgeTone = "muted";
  let stateKey = "settings.engine.notStarted";
  if (starting) {
    stateTone = "warn";
    stateKey = "settings.status.starting";
  } else if (running) {
    stateTone = "ok";
    stateKey = "settings.status.running";
  } else if (localState === "error") {
    stateTone = "error";
    stateKey = "settings.status.startFailed";
  }

  let stateHintKey = "settings.hint.notStartedAuto";
  if (running) stateHintKey = "settings.hint.modelReady";
  else if (starting) stateHintKey = "settings.hint.modelLoading";
  else if (keepRunning) stateHintKey = "settings.hint.idleStopped";

  const hardwareParts: string[] = [];
  if (hardware.totalMemoryBytes) {
    hardwareParts.push(
      t("settings.hardware.memory", { size: formatBytes(hardware.totalMemoryBytes) })
    );
  }
  if (hardware.cpuThreads) {
    hardwareParts.push(t("settings.hardware.cpuThreads", { count: hardware.cpuThreads }));
  }
  if (hardware.gpuName) hardwareParts.push(String(hardware.gpuName));
  if (hardware.gpuVramBytes) {
    hardwareParts.push(
      t("settings.hardware.vram", { size: formatBytes(hardware.gpuVramBytes) })
    );
  }
  const hardwareSummary = hardwareParts.length
    ? hardwareParts.join(" · ")
    : t("settings.hardware.none");
  const hardwareReason = hardware.reason
    ? t("settings.hardware.recommendation", { reason: hardware.reason })
    : t("settings.hardware.recommendationFallback");

  const selectionInstalled = catalog.some(
    (entry) => entry.id === selectedModel && isQwen35(entry.id) && entry.installed === true
  );

  const shownError: LocalError | null =
    inlineError ?? (engine.localError ? { text: engine.localError } : null);
  const engineBusy = localBusy || pending.engine === true;

  return (
    <div data-testid="provider-local" className="flex flex-col gap-2">
      <EngineRow
        engine={engine}
        download={engineDownload}
        busy={engineBusy}
        onDownload={() => {
          void handleDownloadEngine();
        }}
        onCancel={() => {
          void handleCancelDownload("engine");
        }}
      />

      <Field
        label={t("settings.field.localModel")}
        hint={t("settings.hint.localModel")}
      >
        <div
          data-testid="local-hardware"
          aria-live="polite"
          className="flex flex-col gap-0.5"
        >
          <p data-testid="local-hardware-summary" className="text-sm">
            {hardwareSummary}
          </p>
          <p data-testid="local-hardware-reason" className="text-xs text-muted-foreground">
            {hardwareReason}
          </p>
        </div>

        <LocalModelList
          models={models}
          catalog={catalog}
          selectedModel={selectedModel}
          recommendedModelId={hardware.recommendedModelId}
          removingFile={removingFile}
          onSelect={handleSelectModel}
          onRemove={(file) => {
            void handleRemoveModel(file);
          }}
        />

        <p data-testid="local-models-hint" className="text-xs text-muted-foreground">
          {t(
            selectionInstalled
              ? "settings.hint.modelSelectionReady"
              : "settings.hint.modelSelectionMissing"
          )}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <ModelCatalog
            open={catalogOpen}
            catalog={catalog}
            downloads={downloads}
            recommendedModelId={hardware.recommendedModelId}
            onToggle={() => setCatalogOpen((open) => !open)}
            onDownload={(id) => {
              void handleDownloadModel(id);
            }}
            onCancel={(id) => {
              void handleCancelDownload(id);
            }}
          />
          <Button
            id="import-model"
            type="button"
            variant="outline"
            onClick={() => {
              void handleImportModel();
            }}
          >
            {t("settings.action.importModel")}
          </Button>
        </div>
      </Field>

      <Field label={t("settings.field.runtime")} hint={t("settings.hint.runtime")}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge data-testid="local-state-badge" data-tone={stateTone} tone={stateTone}>
            {t(stateKey)}
          </Badge>
          {running ? null : (
            <Button
              id="start-local"
              type="button"
              disabled={localBusy || starting}
              onClick={() => {
                void runLocalAction(
                  "start",
                  () => api.startLocal(),
                  "settings.error.startLocal"
                );
              }}
            >
              {t(starting ? "settings.status.starting" : "settings.action.start")}
            </Button>
          )}
          {running || starting ? (
            <Button
              id="restart-local"
              type="button"
              variant="outline"
              disabled={localBusy || starting}
              onClick={() => {
                void handleRestart();
              }}
            >
              {t(
                localAction === "restart"
                  ? "settings.status.restarting"
                  : "settings.action.restart"
              )}
            </Button>
          ) : null}
          {running || starting ? (
            <Button
              id="stop-local"
              type="button"
              variant="outline"
              disabled={localBusy}
              onClick={() => {
                void runLocalAction(
                  "stop",
                  () => api.stopLocal(),
                  "settings.error.stopLocal"
                );
              }}
            >
              {t("settings.action.stop")}
            </Button>
          ) : null}
        </div>

        <p data-testid="local-state-hint" className="text-xs text-muted-foreground">
          {t(stateHintKey)}
        </p>

        {shownError ? (
          <p data-testid="local-error" role="alert" className="text-xs font-medium text-destructive">
            {"text" in shownError
              ? shownError.text
              : t(shownError.key, shownError.params)}
            {shownError.hint ? ` ${shownError.hint}` : ""}
          </p>
        ) : null}
      </Field>
    </div>
  );
}
