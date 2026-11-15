/* Quick-translate entry (P4). */
import { createRoot } from "react-dom/client";

import { QuickTranslateWindow } from "../windows/QuickTranslateWindow";
import "../styles/globals.css";

document.body.dataset.window = "quicktranslate";

createRoot(document.getElementById("root")!).render(<QuickTranslateWindow />);
