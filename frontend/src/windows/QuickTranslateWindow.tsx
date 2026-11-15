/* Quick-translate window (P4).
 *
 * Contracts §7.4: a frameless transparent card with a two-column layout
 * (source text / streamed Markdown translation), language selectors, swap,
 * pin, history overlay, `Ctrl+Enter`, stop/retry, copy and speak. The window
 * size is Rust's job; this component reports its preferred height once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Languages, Pin, Volume2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStream } from "@/hooks/useStream";
import { useQuickBridge, type QuickApi } from "@/hooks/useQuickBridge";
import { I18nProvider, normalizeLocale, useT } from "@/lib/i18n";
import { LANGUAGES } from "@/lib/constants";
import { renderMarkdown } from "@/lib/markdown";
import {
  QUICK_MAX_CHARS,
  QUICK_SOURCE_AUTO,
  normalizeSourceLang,
  normalizeTargetLang,
  type QuickHistoryEntry,
  type QuickLocale,
} from "@/lib/quick/model";

function makeRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function firstLocale(): QuickLocale {
  if (typeof document === "undefined") return "en";
  return normalizeLocale(document.documentElement.lang || navigator.language);
}

interface QuickStreamState {
  text: string;
  error?: string;
  elapsedMs?: number;
}

const EMPTY_STREAM: QuickStreamState = { text: "" };

export function QuickTranslateWindow({ api }: { api?: QuickApi } = {}) {
  const bridge = useQuickBridge({ api });
  const initial = useRef<QuickLocale>(bridge.locale ?? firstLocale());
  return (
    <I18nProvider initialLocale={initial.current}>
      <QuickLocaleSync locale={bridge.locale} />
      <QuickBody bridge={bridge} />
    </I18nProvider>
  );
}

function QuickLocaleSync({ locale }: { locale: QuickLocale | null }) {
  const { setLocale } = useT();
  useEffect(() => {
    if (locale) setLocale(locale);
  }, [locale, setLocale]);
  return null;
}

function QuickBody({ bridge }: { bridge: ReturnType<typeof useQuickBridge> }) {
  const { t, locale } = useT();
  const { api } = bridge;
  const [source, setSource] = useState("");
  const [sourceLang, setSourceLang] = useState(normalizeSourceLang(bridge.config.sourceLang));
  const [targetLang, setTargetLang] = useState(
    normalizeTargetLang(bridge.config.targetLang ?? "zh")
  );
  const [pinned, setPinned] = useState(bridge.config.pinned === true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<QuickHistoryEntry[]>([]);
  const [search, setSearch] = useState("");
  const [requestId, setRequestId] = useState("");
  const [copied, setCopied] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const reduce = useCallback(
    (state: QuickStreamState, event: { type: string; text?: string; message?: string; elapsedMs?: number }) => {
      if (event.type === "chunk") return { ...state, text: state.text + (event.text ?? "") };
      if (event.type === "error") {
        return { ...state, error: event.message || t("common.unknownError") };
      }
      if (event.type === "done") return { ...state, elapsedMs: event.elapsedMs };
      return state;
    },
    [t]
  );

  const stream = useStream<QuickStreamState>({
    requestId,
    eventName: "translate-event",
    label: "quicktranslate",
    initial: EMPTY_STREAM,
    reduce,
  });

  /* Preferred window height follows the card; Rust clamps it. */
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const height = Math.min(760, Math.max(420, shell.scrollHeight + 24));
    void (api.resize?.(900, height) as Promise<unknown> | undefined);
  }, [api, historyOpen]);

  const translate = useCallback(() => {
    if (!source.trim()) return;
    const nextId = makeRequestId();
    setRequestId(nextId);
    void api.translate?.(nextId, source, targetLang, normalizeSourceLang(sourceLang));
  }, [api, source, sourceLang, targetLang]);

  const stop = useCallback(() => {
    stream.stop();
    if (requestId) void api.abortTranslate?.(requestId);
  }, [api, requestId, stream]);

  const swap = useCallback(() => {
    if (sourceLang === QUICK_SOURCE_AUTO) {
      setSourceLang(targetLang);
      setTargetLang(normalizeTargetLang(sourceLang, "en"));
      return;
    }
    setSourceLang(targetLang);
    setTargetLang(normalizeTargetLang(sourceLang, "en"));
  }, [sourceLang, targetLang]);

  const togglePin = useCallback(() => {
    const next = !pinned;
    setPinned(next);
    void api.pin?.(next);
  }, [api, pinned]);

  const copy = useCallback(() => {
    if (!stream.state.text) return;
    void api.copy?.(stream.state.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [api, stream.state.text]);

  const speak = useCallback(() => {
    if (!stream.state.text || typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(stream.state.text));
  }, [stream.state.text]);

  const loadHistory = useCallback(() => {
    void api.historyList?.().then((result) => {
      const entries = (result as { entries?: QuickHistoryEntry[] })?.entries;
      if (Array.isArray(entries)) setHistory(entries);
    });
  }, [api]);

  useEffect(() => {
    if (historyOpen) loadHistory();
  }, [historyOpen, loadHistory]);

  const filteredHistory = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return history;
    return history.filter(
      (entry) =>
        entry.source.toLowerCase().includes(needle) ||
        entry.target.toLowerCase().includes(needle)
    );
  }, [history, search]);

  const streaming = stream.status === "streaming";
  const elapsed =
    stream.state.elapsedMs && stream.state.elapsedMs > 0
      ? (stream.state.elapsedMs / 1000).toFixed(1)
      : null;

  const targetOptions = LANGUAGES.filter((language) => language.value !== "auto");
  const sourceOptions = [{ value: QUICK_SOURCE_AUTO, label: t("picker.lang.auto") }, ...targetOptions];

  return (
    <div className="qt-window h-full w-full bg-transparent p-2 text-foreground">
      <div
        ref={shellRef}
        className="flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card shadow-lg"
      >
        <header
          data-testid="quick-topbar"
          className="flex cursor-move items-center justify-between gap-2 border-b px-3 py-2"
        >
          <div className="flex items-center gap-1.5">
            <Languages className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Select value={sourceLang} onValueChange={setSourceLang}>
              <SelectTrigger aria-label={t("quick.lang.sourceAria")} className="h-7 w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sourceOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label || option.value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={t("quick.action.swap")}
              title={t("quick.action.swap")}
              onClick={swap}
            >
              <span aria-hidden="true">⇄</span>
            </Button>
            <Select value={targetLang} onValueChange={setTargetLang}>
              <SelectTrigger aria-label={t("quick.lang.targetAria")} className="h-7 w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targetOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-pressed={pinned}
              aria-label={t("quick.action.pin")}
              title={t("quick.action.pin")}
              onClick={togglePin}
            >
              <Pin className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-haspopup="dialog"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              {t("quick.action.history")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={t("quick.action.closeAria")}
              title={t("quick.action.close")}
              onClick={() => {
                void api.hide?.();
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <main className="grid min-h-0 flex-1 grid-cols-2 gap-2 p-2">
          <section aria-labelledby="quick-source-title" className="flex min-h-0 flex-col rounded-lg border">
            <div className="flex items-center justify-between border-b px-2 py-1.5">
              <h2 id="quick-source-title" className="text-xs font-semibold">
                {t("quick.source.title")}
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">
                  {t("quick.source.count", { count: source.length, limit: QUICK_MAX_CHARS })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => setSource("")}
                >
                  {t("quick.source.clear")}
                </Button>
              </div>
            </div>
            <textarea
              value={source}
              maxLength={QUICK_MAX_CHARS}
              spellCheck={false}
              placeholder={t("quick.source.placeholder")}
              aria-label={t("quick.source.aria")}
              className="min-h-0 flex-1 resize-none bg-transparent p-2 text-sm outline-none"
              onChange={(event) => setSource(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  if (event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  translate();
                }
              }}
            />
            <div className="flex items-center justify-between border-t px-2 py-1.5">
              <span className="text-[11px] text-muted-foreground">{t("quick.source.limitHint", { count: LANGUAGES.length, limit: QUICK_MAX_CHARS })}</span>
              <div className="flex items-center gap-1.5">
                {streaming ? (
                  <Button type="button" variant="outline" size="sm" onClick={stop}>
                    {t("quick.action.stop")}
                  </Button>
                ) : null}
                <Button type="button" size="sm" disabled={!source.trim()} onClick={translate}>
                  {t("quick.action.translate")}
                </Button>
              </div>
            </div>
          </section>

          <section aria-labelledby="quick-result-title" className="flex min-h-0 flex-col rounded-lg border">
            <div className="flex items-center justify-between border-b px-2 py-1.5">
              <h2 id="quick-result-title" className="text-xs font-semibold">
                {t("quick.result.title")}
              </h2>
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground">
                  {t("quick.result.count", { count: stream.state.text.length })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={!stream.state.text}
                  aria-label={t("quick.result.speak")}
                  title={t("quick.result.speak")}
                  onClick={speak}
                >
                  <Volume2 className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={!stream.state.text}
                  aria-label={t("quick.result.copy")}
                  title={t("quick.result.copy")}
                  onClick={copy}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-live="polite">
              {stream.state.error ? (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {stream.state.error}
                </p>
              ) : stream.state.text ? (
                <div
                  data-testid="quick-result"
                  className="text-sm [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(stream.state.text) }}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
                  <p className="text-sm text-muted-foreground">{t("quick.empty.title")}</p>
                  <p className="text-xs text-muted-foreground">{t("quick.empty.hint")}</p>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between border-t px-2 py-1.5">
              <span className="text-[11px] text-muted-foreground">
                {elapsed ? t("quick.elapsed", { time: locale === "zh" ? `${elapsed} 秒` : `${elapsed}s` }) : t("quick.elapsedNone")}
              </span>
              {copied ? (
                <span className="text-[11px] text-muted-foreground">{t("quick.toast.copied")}</span>
              ) : null}
            </div>
          </section>
        </main>
      </div>

      {historyOpen ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 p-6">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("quick.history.title")}
            className="flex max-h-full w-full max-w-[640px] flex-col overflow-hidden rounded-xl border bg-card shadow-lg"
          >
            <div className="flex items-center justify-between border-b px-3 py-2">
              <h2 className="text-sm font-semibold">{t("quick.history.title")}</h2>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={t("quick.history.closeAria")}
                onClick={() => setHistoryOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="border-b px-3 py-2">
              <input
                type="search"
                value={search}
                placeholder={t("quick.history.searchPlaceholder")}
                aria-label={t("quick.history.searchAria")}
                className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {filteredHistory.length === 0 ? (
                <p className="p-2 text-sm text-muted-foreground">{t("quick.history.empty")}</p>
              ) : (
                filteredHistory.map((entry) => (
                  <div
                    key={entry.id}
                    data-testid="history-entry"
                    className="mb-1 flex items-start gap-2 rounded-md border p-2 text-xs hover:bg-accent"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => {
                        setSource(entry.source);
                        setHistoryOpen(false);
                      }}
                    >
                      <p className="truncate">{entry.source}</p>
                      <p className="truncate text-muted-foreground">{entry.target}</p>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      aria-label={t("quick.history.deleteAria")}
                      onClick={() => {
                        void api.historyDelete?.(entry.id).then(loadHistory);
                      }}
                    >
                      ×
                    </Button>
                  </div>
                ))
              )}
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {`${filteredHistory.length}`}
              </span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={history.length === 0}
                onClick={() => {
                  void api.historyClear?.().then(() => {
                    setHistory([]);
                  });
                }}
              >
                {t("quick.history.clear")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


