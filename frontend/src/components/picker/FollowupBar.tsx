/* Follow-up bar (P3, Task 6).
 *
 * Float layer above the panel body (contracts §7.1:407): an IME-safe input plus
 * dynamically generated suggestion chips (max 3, no fixed presets). Suggestions
 * are fetched after the first non-empty chunk and dropped after a 3s deadline;
 * failures stay silent.
 */
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

export interface FollowupBarProps {
  suggestions: string[];
  busy: boolean;
  onSubmit: (question: string) => void;
  onSuggest?: (question: string) => void;
}

export function FollowupBar({ suggestions, busy, onSubmit, onSuggest }: FollowupBarProps) {
  const { t } = useT();
  const [draft, setDraft] = useState("");
  const composing = useRef(false);

  useEffect(() => {
    setDraft("");
  }, [busy]);

  const submit = (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    onSubmit(text);
  };

  return (
    <div
      data-testid="followup-bar"
      className="absolute inset-x-0 bottom-0 flex flex-col gap-1.5 bg-gradient-to-t from-card via-card/95 to-transparent px-2 pb-2 pt-4"
    >
      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.slice(0, 3).map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              data-testid="followup-chip"
              className="rounded-full border bg-background px-2.5 py-1 text-xs hover:bg-accent"
              disabled={busy}
              onClick={() => {
                onSuggest?.(suggestion);
                submit(suggestion);
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={draft}
          data-testid="followup-input"
          aria-label={t("picker.aria.followup")}
          placeholder={t("picker.placeholder.followup")}
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            /* Never submit while an IME composition is active. */
            if (event.key !== "Enter" || event.shiftKey) return;
            if (composing.current || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit(draft);
          }}
        />
        <Button
          type="button"
          size="sm"
          data-testid="followup-send"
          disabled={busy || draft.trim().length === 0}
          onClick={() => submit(draft)}
        >
          {t("picker.action.send")}
        </Button>
      </div>
    </div>
  );
}
