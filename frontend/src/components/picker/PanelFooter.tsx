/* Panel footer: speak / copy / retry / stop as icon-only buttons (P3, Task 4).
 *
 * Contracts §7.1:400 — the stop button is only enabled while a stream runs, and
 * retry is hidden when there is nothing to retry.
 */
import { Copy, RotateCcw, Square, Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

export interface PanelFooterProps {
  streaming: boolean;
  canRetry: boolean;
  canCopy: boolean;
  canSpeak: boolean;
  onSpeak: () => void;
  onCopy: () => void;
  onRetry: () => void;
  onStop: () => void;
}

export function PanelFooter({
  streaming,
  canRetry,
  canCopy,
  canSpeak,
  onSpeak,
  onCopy,
  onRetry,
  onStop,
}: PanelFooterProps) {
  const { t } = useT();

  const action = (
    key: string,
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    disabled = false
  ) => (
    <Button
      key={key}
      type="button"
      variant="ghost"
      size="icon"
      data-action={key}
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {icon}
    </Button>
  );

  return (
    <div data-testid="panel-footer" className="flex items-center justify-end gap-1 border-t px-2 py-1.5">
      {action("speak", t("picker.action.read"), <Volume2 className="h-4 w-4" />, onSpeak, !canSpeak)}
      {action("copy", t("picker.action.copy"), <Copy className="h-4 w-4" />, onCopy, !canCopy)}
      {canRetry
        ? action("retry", t("picker.action.retry"), <RotateCcw className="h-4 w-4" />, onRetry)
        : null}
      {action(
        "stop",
        t("picker.action.stop"),
        <Square className="h-4 w-4" />,
        onStop,
        !streaming
      )}
    </div>
  );
}
