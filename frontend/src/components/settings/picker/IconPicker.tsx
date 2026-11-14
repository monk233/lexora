/* Icon picker for custom skills (C39, assertion 31, D14).
 *
 * Collapsed: preview + current key + "change icon" toggle. Expanded: an
 * English-key search input over the 202-key static SVG gallery
 * (`skill-icons.ts`, generated from the legacy table), rendered as a
 * `role="radiogroup"` with one `role="radio"` per icon.
 *
 * Esc honours the legacy precedence: a non-empty search clears first and keeps
 * the panel open; an empty search closes the panel. Selecting an icon closes it
 * and returns focus to the toggle. The gallery scrolls internally instead of
 * stretching the card.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { useT } from "@/lib/i18n";
import { CUSTOM_SKILL_ICON_SVGS } from "@/lib/settings/skill-icons";
import { normalizeIconKey } from "@/lib/settings/skills";
import { cn } from "@/lib/utils";

/** Hand-picked friendly names for the legacy v0.1.x icon keys. */
const FRIENDLY_LABEL_KEYS: Record<string, string> = {
  sparkles: "settings.icon.sparkles",
  "wand-sparkles": "settings.icon.wandSparkles",
  languages: "settings.icon.languages",
  "pen-line": "settings.icon.penLine",
  "book-open": "settings.icon.bookOpen",
  earth: "settings.icon.earth",
  code: "settings.icon.code",
  list: "settings.icon.list",
  "message-circle": "settings.icon.messageCircle",
  lightbulb: "settings.icon.lightbulb",
  quote: "settings.icon.quote",
  briefcase: "settings.icon.briefcase",
  star: "settings.icon.star",
  search: "settings.icon.search",
  "circle-help": "settings.icon.circleHelp",
  "volume-2": "settings.icon.volume2",
  copy: "settings.icon.copy",
};

const ICON_KEYS = Object.keys(CUSTOM_SKILL_ICON_SVGS).sort();

export interface IconPickerProps {
  value: string;
  onChange: (icon: string) => void;
  id?: string;
}

export function IconPicker({ value, onChange, id }: IconPickerProps) {
  const { t } = useT();
  const generatedId = useId();
  const baseId = id ?? `icon-picker-${generatedId}`;
  const panelId = `${baseId}-panel`;
  const searchId = `${baseId}-search`;
  const gridId = `${baseId}s`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const selected = normalizeIconKey(value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return ICON_KEYS;
    return ICON_KEYS.filter((key) => key.toLowerCase().includes(needle));
  }, [query]);

  /* Every open starts from the full gallery and focuses the search box. */
  useEffect(() => {
    if (!open) return;
    setQuery("");
    searchRef.current?.focus();
    const current = gridRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    current?.scrollIntoView?.({ block: "nearest" });
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    toggleRef.current?.focus();
  };

  const choose = (key: string) => {
    onChange(normalizeIconKey(key));
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    if (query) {
      setQuery("");
      searchRef.current?.focus();
      return;
    }
    close();
  };

  return (
    <div className="flex flex-col gap-2" onKeyDown={onKeyDown} data-testid="icon-picker">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          data-testid="icon-picker-preview"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground [&_svg]:h-4 [&_svg]:w-4"
          dangerouslySetInnerHTML={{ __html: CUSTOM_SKILL_ICON_SVGS[selected] ?? "" }}
        />
        <span
          className="min-w-0 truncate font-mono text-xs text-muted-foreground"
          title={friendlyTitle(selected, t)}
        >
          {selected}
        </span>
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          className="inline-flex h-8 items-center rounded-md border bg-background px-3 text-xs font-semibold hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            if (open) {
              setOpen(false);
              return;
            }
            setOpen(true);
          }}
        >
          {t(open ? "settings.action.hideIcons" : "settings.action.changeIcon")}
        </button>
      </div>

      {open ? (
        <div id={panelId} className="flex flex-col gap-2 rounded-md border bg-muted/40 p-2">
          <input
            ref={searchRef}
            id={searchId}
            type="search"
            value={query}
            placeholder={t("settings.placeholder.iconSearch")}
            aria-label={t("settings.field.iconSearch")}
            autoComplete="off"
            spellCheck={false}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setQuery(event.target.value)}
          />
          <div
            ref={gridRef}
            id={gridId}
            role="radiogroup"
            aria-label={t("settings.field.iconGrid")}
            className="grid max-h-[200px] grid-cols-8 gap-1 overflow-y-auto overscroll-contain"
          >
            {filtered.map((key) => {
              const checked = key === selected;
              const label = FRIENDLY_LABEL_KEYS[key]
                ? t(FRIENDLY_LABEL_KEYS[key])
                : key;
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={t("settings.aria.icon", { label })}
                  title={key}
                  data-icon-key={key}
                  className={cn(
                    "inline-flex h-9 w-9 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors [&_svg]:h-4 [&_svg]:w-4",
                    "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    checked && "border-primary bg-accent text-foreground"
                  )}
                  onClick={() => choose(key)}
                  dangerouslySetInnerHTML={{ __html: CUSTOM_SKILL_ICON_SVGS[key] }}
                />
              );
            })}
          </div>
          {filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("settings.hint.iconEmpty")}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function friendlyTitle(key: string, t: (key: string, params?: Record<string, string>) => string): string {
  const labelKey = FRIENDLY_LABEL_KEYS[key];
  return labelKey ? t("settings.icon.title", { key, label: t(labelKey) }) : key;
}
