/* Long-shot control bar (P5c).
 *
 * Floating clickable bar below the selection (the capture overlays are
 * click-through so the wheel reaches the target app): direction, auto-scroll,
 * frame/size status, cancel and finish.
 */
import { I18nProvider, normalizeLocale, useT } from "@/lib/i18n";
import { useLongshotBar } from "@/hooks/useLongshotBridge";

function firstLocale() {
  if (typeof document === "undefined") return "en";
  return normalizeLocale(document.documentElement.lang || navigator.language);
}

export function LongshotBarWindow() {
  return (
    <I18nProvider initialLocale={firstLocale()}>
      <LongshotBarBody />
    </I18nProvider>
  );
}

function LongshotBarBody() {
  const { t } = useT();
  const bar = useLongshotBar();
  const frames = Number(bar.progress.frames ?? 1);
  const width = Number(bar.progress.width ?? 0);
  const height = Number(bar.progress.height ?? 0);

  const status = bar.autoscroll
    ? t("longshot.statusAuto", { frame: frames, width, height })
    : t("longshot.status", { frame: frames, width, height });

  return (
    <div
      role="toolbar"
      aria-label={t("longshot.bar.aria")}
      data-testid="longshot-bar"
      className="flex h-full w-full items-center gap-2 rounded-lg border bg-card px-2 py-1 text-xs shadow-lg"
    >
      <span className="text-muted-foreground">{t("longshot.direction")}</span>
      <div role="group" aria-label={t("longshot.direction.aria")} className="flex items-center gap-0.5">
        {(["vertical", "horizontal"] as const).map((direction) => (
          <button
            key={direction}
            type="button"
            data-direction={direction}
            aria-pressed={bar.direction === direction}
            title={t(direction === "vertical" ? "longshot.verticalHint" : "longshot.horizontalHint")}
            className={
              bar.direction === direction
                ? "rounded bg-primary px-2 py-0.5 text-primary-foreground"
                : "rounded px-2 py-0.5 hover:bg-accent"
            }
            onClick={() => bar.setDirection(direction)}
          >
            {t(direction === "vertical" ? "longshot.vertical" : "longshot.horizontal")}
          </button>
        ))}
      </div>

      <span aria-hidden="true" className="h-4 w-px bg-border" />
      <button
        type="button"
        aria-pressed={bar.autoscroll}
        title={t("longshot.autoscrollHint")}
        className={
          bar.autoscroll
            ? "rounded bg-primary px-2 py-0.5 text-primary-foreground"
            : "rounded px-2 py-0.5 hover:bg-accent"
        }
        onClick={() => bar.setAutoscroll(!bar.autoscroll)}
      >
        {t(bar.autoscroll ? "longshot.stopAutoscroll" : "longshot.autoscroll")}
      </button>

      <span aria-hidden="true" className="h-4 w-px bg-border" />
      <span data-testid="longshot-status" className="text-muted-foreground">
        {status}
      </span>

      <span className="flex-1" />
      <button
        type="button"
        data-action="cancel"
        title={t("longshot.cancelHint")}
        className="rounded px-2 py-0.5 text-destructive hover:bg-destructive/10"
        onClick={bar.cancel}
      >
        {t("common.cancel")}
      </button>
      <button
        type="button"
        data-action="finish"
        title={t("longshot.finishHint")}
        className="rounded bg-primary px-2 py-0.5 text-primary-foreground"
        onClick={bar.finish}
      >
        {t("longshot.finish")}
      </button>
    </div>
  );
}
