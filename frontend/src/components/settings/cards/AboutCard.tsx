/* About card (C67-C71): build info, directories and the update flow.
 *
 * The update widget keeps the legacy six-state machine
 * (idle/checking/latest/available/downloading/ready/error) and renders release
 * notes through the sanitized Markdown renderer; links leave the app through
 * ``open_external``.
 */
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/use-toast";
import { Field } from "@/components/settings/Field";
import { SectionCard } from "@/components/settings/SectionCard";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { useT } from "@/lib/i18n";
import { renderMarkdown } from "@/lib/markdown";
import type { UpdateProgress } from "@/lib/settings/types";

const NOTES_CLAMP = 240;

type UpdateState =
  | "idle"
  | "checking"
  | "latest"
  | "available"
  | "downloading"
  | "ready"
  | "error";

interface UpdateInfo {
  version?: string;
  currentVersion?: string;
  notes?: string;
  publishedAt?: string;
  sizeBytes?: number;
}

export function AboutCard() {
  const form = useSettingsForm();
  const { t } = useT();
  const state = form.state;
  const app = state?.app;
  const engine = state?.engine;
  const models = state?.models ?? [];

  const [phase, setPhase] = useState<UpdateState>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const notesRef = useRef<HTMLDivElement | null>(null);
  const notesIntercepted = useRef(false);

  /* Live progress/availability events; the fake bridge exposes the same pair. */
  useEffect(() => {
    const offProgress = form.api.onUpdateProgress((next) => {
      setProgress(next);
      setPhase(next.status === "ready" ? "ready" : "downloading");
    });
    const offAvailable = form.api.onUpdateAvailable((next) => {
      setInfo((current) => ({ ...current, ...next }));
      setPhase((current) =>
        current === "downloading" || current === "ready" ? current : "available"
      );
    });
    return () => {
      offProgress();
      offAvailable();
    };
  }, [form.api]);

  /* Release notes may contain links: route them through open_external. */
  useEffect(() => {
    const node = notesRef.current;
    if (!node || notesIntercepted.current) return;
    notesIntercepted.current = true;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || !/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      void form.api.openExternal(href);
    };
    node.addEventListener("click", onClick);
    return () => node.removeEventListener("click", onClick);
  }, [form.api, info]);

  const checkUpdate = async () => {
    setPhase("checking");
    setError(null);
    const result = await form.api.checkUpdate();
    if (!result.ok) {
      setPhase("error");
      setError(result.error || null);
      return;
    }
    setInfo(result);
    if (result.hasUpdate) {
      setPhase("available");
      if (result.latestVersion) {
        void form.api.notifyUpdateAvailable(result.latestVersion);
      }
      return;
    }
    setPhase("latest");
  };

  const installUpdate = async () => {
    setPhase("downloading");
    setProgress(null);
    const result = await form.api.installUpdate();
    if (!result.ok) {
      setPhase("error");
      setError(result.error || null);
    }
  };

  const openExternal = (url: string | undefined) => {
    if (url) void form.api.openExternal(url);
  };

  const version = app?.version || "";
  const notes = String(info?.notes || "");
  const showExpand = notes.length > NOTES_CLAMP || expanded;

  const engineLine = engine
    ? `${engine.engineAvailable ? t("settings.about.engineInstalled") : t("settings.about.engineMissing")} · ${
        engine.localState === "ready"
          ? t("settings.about.localRunning")
          : engine.localState === "starting"
            ? t("settings.about.localStarting")
            : engine.onlineConfigured
              ? t("settings.about.onlineReady")
              : t("settings.about.localStopped")
      }`
    : "";

  const modelLine =
    models.length > 0
      ? t("settings.about.modelsCount", {
          count: models.length,
          name: models[0].name || models[0].file,
        })
      : t("settings.about.modelsNone");

  return (
    <SectionCard
      id="about"
      title={t("settings.card.about.title")}
      description={t("settings.card.about.desc")}
    >
      <Field label={t("settings.about.version")}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="muted">{version ? `v${version}` : "—"}</Badge>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => openExternal(app?.repoUrl)}
          >
            {t("settings.action.githubRepo")}
          </Button>
        </div>
      </Field>

      <Field label={t("settings.about.platform")}>
        <p className="text-sm">{app?.platform || "—"}</p>
      </Field>

      <Field label={t("settings.about.license")}>
        <p className="text-sm">{app?.license || "MIT"}</p>
      </Field>

      <Field label={t("settings.about.engine")}>
        <p className="text-sm">{engineLine || "—"}</p>
      </Field>

      <Field label={t("settings.about.dataDir")}>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 break-all text-xs" title={app?.dataDir || ""}>
            {app?.dataDir || "—"}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void form.api.openDir("data");
            }}
          >
            {t("settings.action.open")}
          </Button>
        </div>
      </Field>

      <Field label={t("settings.about.localModels")}>
        <p className="text-sm">{modelLine}</p>
      </Field>

      <Field
        label={t("settings.update.title")}
        hint={
          version
            ? t("settings.update.versionHint", { version })
            : t("settings.update.versionHintUnknown")
        }
      >
        <div className="flex flex-col gap-2" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={phase === "checking" || phase === "downloading" || phase === "ready"}
              onClick={() => {
                void checkUpdate();
              }}
            >
              {phase === "checking"
                ? t("settings.action.checking")
                : phase === "downloading"
                  ? t("settings.action.updating")
                  : phase === "ready"
                    ? t("settings.action.restartingSoon")
                    : t("settings.action.checkUpdate")}
            </Button>
            {phase === "available" ? (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  void installUpdate();
                }}
              >
                {t("settings.action.installUpdate")}
              </Button>
            ) : null}
            {phase === "available" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPhase("idle");
                }}
              >
                {t("settings.action.later")}
              </Button>
            ) : null}
          </div>

          {phase === "latest" ? (
            <p className="text-sm">{t("settings.update.latest", { version })}</p>
          ) : null}
          {phase === "available" ? (
            <p className="text-sm">
              {t("settings.update.available", {
                version: info?.version || "—",
                current: info?.currentVersion || version,
              })}
            </p>
          ) : null}
          {phase === "downloading" || phase === "ready" ? (
            <div className="flex flex-col gap-1.5">
              <Progress
                value={progress?.percent ?? 0}
                aria-label={t("settings.update.downloading")}
              />
              <p className="text-xs text-muted-foreground">
                {phase === "ready"
                  ? t("settings.update.ready")
                  : t("settings.update.downloading")}
              </p>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs font-medium text-destructive">
              {error}
            </p>
          ) : null}

          {notes ? (
            <div ref={notesRef} className="flex flex-col gap-1">
              <div
                className={
                  expanded
                    ? "max-h-none overflow-auto text-sm"
                    : "max-h-[84px] overflow-hidden text-sm"
                }
                dangerouslySetInnerHTML={{ __html: renderMarkdown(notes) }}
              />
              {showExpand ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => setExpanded((current) => !current)}
                >
                  {expanded ? t("settings.action.collapse") : t("settings.action.expandNotes")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </Field>

      <Field label={t("settings.action.githubRepo")}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => openExternal(app?.repoUrl)}
        >
          {app?.repoUrl || "https://github.com/monk233/lexora"}
        </Button>
      </Field>
    </SectionCard>
  );
}
