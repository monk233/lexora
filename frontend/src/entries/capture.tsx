/* Capture overlay entry (P5). */
import { createRoot } from "react-dom/client";

import { CaptureWindow } from "../windows/CaptureWindow";
import "../styles/globals.css";

document.body.dataset.window = "capture";

createRoot(document.getElementById("root")!).render(<CaptureWindow />);
