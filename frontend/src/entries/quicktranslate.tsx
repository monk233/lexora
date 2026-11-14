import { createRoot } from "react-dom/client";
import { QuickTranslateWindow } from "../windows/QuickTranslateWindow";
import "../styles/globals.css";

createRoot(document.getElementById("root")!).render(<QuickTranslateWindow />);
