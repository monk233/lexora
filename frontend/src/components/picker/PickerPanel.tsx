/* Result panel shell (P3, Task 4).
 *
 * Chrome only: header (title/language/pin/close), body (children), footer
 * actions and the resize grip. Streaming, follow-ups and image payloads plug
 * into `body`/callbacks in later tasks, so this component stays presentation
 * plus the drag/resize wiring.
 */
import { useCallback, useState, type ReactNode } from "react";

import { PanelFooter } from "@/components/picker/PanelFooter";
import { PanelHeader } from "@/components/picker/PanelHeader";
import { ResizeGrip } from "@/components/picker/ResizeGrip";
import type { PickerApi } from "@/hooks/usePickerBridge";

export interface PickerPanelProps {
  api: PickerApi;
  title: string;
  showLanguage: boolean;
  targetLang: string;
  pinned: boolean;
  streaming: boolean;
  canRetry: boolean;
  canCopy: boolean;
  canSpeak: boolean;
  onClose: () => void;
  onPinChange: (pinned: boolean) => void;
  onTargetLangChange: (lang: string) => void;
  onSpeak: () => void;
  onCopy: () => void;
  onRetry: () => void;
  onStop: () => void;
  onResize: (width: number, height: number) => void;
  onResetSize: () => void;
  children?: ReactNode;
}

export function PickerPanel({
  api,
  title,
  showLanguage,
  targetLang,
  pinned,
  streaming,
  canRetry,
  canCopy,
  canSpeak,
  onClose,
  onPinChange,
  onTargetLangChange,
  onSpeak,
  onCopy,
  onRetry,
  onStop,
  onResize,
  onResetSize,
  children,
}: PickerPanelProps) {
  /* Manual resize hides the grip's auto behaviour: the panel keeps the user's
   * size until the grip is double-clicked (contracts §7.1:402). */
  const [manual, setManual] = useState(false);

  const resize = useCallback(
    (width: number, height: number) => {
      setManual(true);
      onResize(width, height);
    },
    [onResize]
  );

  const resetSize = useCallback(() => {
    setManual(false);
    onResetSize();
  }, [onResetSize]);

  return (
    <div
      data-testid="picker-panel"
      className="relative flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-lg"
    >
      <PanelHeader
        api={api}
        title={title}
        showLanguage={showLanguage}
        targetLang={targetLang}
        pinned={pinned}
        onPinChange={onPinChange}
        onClose={onClose}
        onTargetLangChange={onTargetLangChange}
      />
      <div data-testid="panel-body" className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {children}
      </div>
      <PanelFooter
        streaming={streaming}
        canRetry={canRetry}
        canCopy={canCopy}
        canSpeak={canSpeak}
        onSpeak={onSpeak}
        onCopy={onCopy}
        onRetry={onRetry}
        onStop={onStop}
      />
      <ResizeGrip onResize={resize} onReset={resetSize} />
    </div>
  );
}

