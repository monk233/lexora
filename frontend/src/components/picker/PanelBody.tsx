/* Panel body (P3, Task 5): loading / streamed Markdown / error / stopped.
 *
 * Markdown is sanitized by `renderMarkdown` (HTML escaped first, only http(s)
 * links survive); link clicks leave the webview through `open_external` instead
 * of navigating. Streaming follows the bottom unless the user scrolled up
 * (contracts §7.1:398), and a stopped stream keeps its partial text.
 */
import { useEffect, useRef } from "react";

import type { PickerApi } from "@/hooks/usePickerBridge";
import { useT } from "@/lib/i18n";
import { renderMarkdown } from "@/lib/markdown";

export type PanelPhase = "loading" | "streaming" | "done" | "error" | "stopped" | "repetition";

export interface PanelBodyProps {
  api: PickerApi;
  phase: PanelPhase;
  text: string;
  source?: string;
  error?: { message: string; hint?: string };
  onRetry: () => void;
  stoppedNote?: string;
  loadingKey?: string;
}

export function PanelBody({
  api,
  phase,
  text,
  source,
  error,
  onRetry,
  stoppedNote,
  loadingKey = "picker.loading.processing",
}: PanelBodyProps) {
  const { t } = useT();
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  /* Track whether the user is at the bottom; only then auto-scroll. */
  useEffect(() => {
    const node = nodeRef.current?.parentElement;
    if (!node) return;
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      followRef.current = distance < 28;
    };
    node.addEventListener("scroll", onScroll);
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const node = nodeRef.current?.parentElement;
    if (!node || !followRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [text]);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || !/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      void api.openExternal?.(href);
    };
    node.addEventListener("click", onClick);
    return () => node.removeEventListener("click", onClick);
  }, [api]);

  if (phase === "error" && error) {
    return (
      <div className="flex flex-col gap-2">
        <p role="alert" className="text-sm font-medium text-destructive">
          {error.message}
        </p>
        {error.hint ? <p className="text-xs text-muted-foreground">{error.hint}</p> : null}
        <button
          type="button"
          className="self-start text-xs font-medium text-primary underline-offset-2 hover:underline"
          onClick={onRetry}
        >
          {t("picker.action.retry")}
        </button>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div className="flex flex-col gap-2 text-sm text-muted-foreground">
        <p>{t(loadingKey)}</p>
        {source ? (
          <p className="max-h-24 overflow-hidden text-xs opacity-80">{source}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 text-sm">
      <div
        ref={nodeRef}
        data-testid="panel-markdown"
        className="break-words [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      />
      {phase === "stopped" ? (
        <p className="text-xs text-muted-foreground">
          {stoppedNote ?? t("picker.note.stopped")}
        </p>
      ) : null}
      {phase === "repetition" ? (
        <p className="text-xs text-muted-foreground">{t("picker.error.repetitionStopped")}</p>
      ) : null}
    </div>
  );
}


