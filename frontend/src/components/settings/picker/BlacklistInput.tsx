/* Application blacklist chips editor (C46/C47, assertion 28).
 *
 * Legacy rules (`web/settings.js:4629-4666`, `5013-5037`): Enter or blur adds
 * the typed process name, Backspace on an empty input removes the last entry,
 * entries dedupe case-insensitively after dropping a trailing `.exe`, one entry
 * is capped at 120 chars and the list at 200. Blank input never adds.
 */
import { useState, type KeyboardEvent } from "react";

import { toast } from "@/components/ui/use-toast";
import { useT } from "@/lib/i18n";

export const BLACKLIST_ENTRY_MAX = 120;
export const BLACKLIST_MAX = 200;

export interface BlacklistInputProps {
  entries: string[];
  onChange: (next: string[]) => void;
}

/** Lowercase without the trailing `.exe`, for duplicate detection only. */
export function normalizeProcessName(entry: string): string {
  return String(entry ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "");
}

export function BlacklistInput({ entries, onChange }: BlacklistInputProps) {
  const { t } = useT();
  const [draft, setDraft] = useState("");

  const add = (raw: string) => {
    const entry = raw.trim();
    if (!entry) return;
    if (entry.length > BLACKLIST_ENTRY_MAX) {
      toast({ description: t("settings.error.processNameTooLong"), tone: "error" });
      return;
    }
    const normalized = normalizeProcessName(entry);
    if (entries.some((item) => normalizeProcessName(item) === normalized)) {
      setDraft("");
      return;
    }
    if (entries.length >= BLACKLIST_MAX) {
      toast({ description: t("settings.error.blacklistFull"), tone: "error" });
      return;
    }
    onChange([...entries, entry]);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      add(draft);
      return;
    }
    if (event.key === "Backspace" && draft === "" && entries.length > 0) {
      onChange(entries.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5" data-testid="blacklist-chips">
        {entries.map((entry) => (
          <span
            key={entry}
            className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-1 text-xs"
          >
            <span className="max-w-[16rem] truncate">{entry}</span>
            <button
              type="button"
              aria-label={t("settings.aria.removeBlacklist", { name: entry })}
              className="text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => onChange(entries.filter((item) => item !== entry))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        type="text"
        aria-label={t("settings.field.blacklist")}
        placeholder={t("settings.placeholder.blacklist")}
        className="h-9 w-full rounded-md border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (draft.trim()) add(draft);
        }}
      />
    </div>
  );
}
