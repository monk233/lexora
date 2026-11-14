/* Search skill engine picker (C36, assertion 26).
 *
 * `role="radiogroup"` with three `role="radio"` buttons, mirroring the legacy
 * panel (`web/settings.js:2136-2176`). Selecting an engine saves immediately.
 */
import { useT } from "@/lib/i18n";

export type SearchEngineValue = "google" | "baidu" | "bing";

export const SEARCH_ENGINES: Array<{
  value: SearchEngineValue;
  labelKey: string;
  host: string;
}> = [
  { value: "google", labelKey: "settings.searchEngine.google", host: "google.com" },
  { value: "baidu", labelKey: "settings.searchEngine.baidu", host: "baidu.com" },
  { value: "bing", labelKey: "settings.searchEngine.bing", host: "bing.com" },
];

export function normalizeSearchEngine(value: string): SearchEngineValue {
  const match = SEARCH_ENGINES.find((engine) => engine.value === value);
  return match ? match.value : "google";
}

export interface SearchEnginePanelProps {
  value: string;
  onChange: (engine: SearchEngineValue) => void;
}

export function SearchEnginePanel({ value, onChange }: SearchEnginePanelProps) {
  const { t } = useT();
  const current = normalizeSearchEngine(value);

  return (
    <div className="rounded-md border bg-muted/40 p-3" data-testid="search-engine-panel">
      <div
        role="radiogroup"
        aria-label={t("settings.aria.searchEngine")}
        className="grid gap-1.5 sm:grid-cols-3"
      >
        {SEARCH_ENGINES.map((engine) => {
          const checked = engine.value === current;
          const name = t(engine.labelKey);
          return (
            <button
              key={engine.value}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={t("settings.aria.searchWith", { engine: name })}
              data-search-engine={engine.value}
              className={
                checked
                  ? "flex flex-col items-start rounded-md border border-primary bg-card px-2.5 py-1.5 text-left text-xs font-semibold shadow-sm"
                  : "flex flex-col items-start rounded-md border bg-card px-2.5 py-1.5 text-left text-xs hover:bg-accent"
              }
              onClick={() => onChange(engine.value)}
            >
              <span>{name}</span>
              <span className="text-[11px] font-normal text-muted-foreground">{engine.host}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t("settings.hint.searchEngine")}</p>
    </div>
  );
}
