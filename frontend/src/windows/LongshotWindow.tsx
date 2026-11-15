/* Long-shot preview window (P5c).
 *
 * Transparent frameless window showing the stitched image inside the same blue
 * frame as the capture selection; the picture scales to fit and "正在拼接…"
 * covers the empty first frames. No header, footer or card (contract §11.14).
 */
import { useEffect, useState } from "react";

import { I18nProvider, normalizeLocale, useT } from "@/lib/i18n";
import { fitWithin } from "@/lib/longshot/model";
import { useLongshotPreview } from "@/hooks/useLongshotBridge";

function firstLocale() {
  if (typeof document === "undefined") return "en";
  return normalizeLocale(document.documentElement.lang || navigator.language);
}

export function LongshotWindow() {
  return (
    <I18nProvider initialLocale={firstLocale()}>
      <LongshotBody />
    </I18nProvider>
  );
}

function LongshotBody() {
  const { t } = useT();
  const bridge = useLongshotPreview();
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const size = fitWithin(bridge.width, bridge.height, viewport.width - 8, viewport.height - 8);

  return (
    <div
      data-testid="longshot-root"
      className="flex h-full w-full items-center justify-center bg-transparent p-1"
    >
      <div className="flex h-full w-full items-center justify-center border-2 border-primary">
        {bridge.dataUrl && !bridge.cancelled ? (
          <img
            src={bridge.dataUrl}
            alt=""
            draggable={false}
            data-testid="longshot-image"
            style={{ width: size.width || "100%", height: size.height || "100%" }}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <span className="rounded bg-card/90 px-3 py-1 text-xs shadow">
            {t("longshot.stitching")}
          </span>
        )}
      </div>
    </div>
  );
}
