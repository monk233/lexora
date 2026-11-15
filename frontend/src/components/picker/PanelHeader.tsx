/* Panel header: title, target-language selector, pin and close (P3, Task 4).
 *
 * The blank area of the header drags the whole picker window; the server owns
 * the actual move (`picker_drag_panel`, logical-pixel deltas), so the header
 * only streams deltas while the pointer is down. Buttons and the language
 * selector are excluded from the drag area.
 */
import { useCallback, useRef } from "react";
import { Pin, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PickerApi } from "@/hooks/usePickerBridge";
import { useT } from "@/lib/i18n";
import { LANGUAGES } from "@/lib/constants";

export interface PanelHeaderProps {
  api: PickerApi;
  title: string;
  showLanguage: boolean;
  targetLang: string;
  pinned: boolean;
  onPinChange: (pinned: boolean) => void;
  onClose: () => void;
  onTargetLangChange: (lang: string) => void;
}

const NO_DRAG = "button, select, input, a, textarea, [data-no-drag]";

export function PanelHeader({
  api,
  title,
  showLanguage,
  targetLang,
  pinned,
  onPinChange,
  onClose,
  onTargetLangChange,
}: PanelHeaderProps) {
  const { t } = useT();
  const drag = useRef<{ x: number; y: number } | null>(null);

  const onMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(NO_DRAG)) return;
      drag.current = { x: event.clientX, y: event.clientY };
      const move = (next: MouseEvent) => {
        const start = drag.current;
        if (!start) return;
        const dx = next.clientX - start.x;
        const dy = next.clientY - start.y;
        start.x = next.clientX;
        start.y = next.clientY;
        void api.dragPanel?.(dx, dy);
      };
      const up = () => {
        drag.current = null;
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [api]
  );

  return (
    <div
      data-testid="panel-header"
      role="presentation"
      className="flex cursor-move items-center justify-between gap-2 rounded-t-xl border-b px-3 py-2"
      onMouseDown={onMouseDown}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span data-testid="panel-title" className="truncate text-sm font-semibold">
          {title}
        </span>
        {showLanguage ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{t("picker.lang.auto")}</span>
            <span aria-hidden="true">→</span>
            <Select value={targetLang} onValueChange={onTargetLangChange}>
              <SelectTrigger
                data-no-drag
                aria-label={t("picker.aria.targetLanguage")}
                className="h-7 w-[120px] text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.filter((language) => language.value !== "auto").map((language) => (
                  <SelectItem key={language.value} value={language.value}>
                    {language.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-no-drag
          aria-pressed={pinned}
          aria-label={t("picker.action.pin")}
          title={t("picker.action.pin")}
          onClick={() => onPinChange(!pinned)}
        >
          <Pin className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-no-drag
          aria-label={t("picker.action.close")}
          title={t("picker.action.close")}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
