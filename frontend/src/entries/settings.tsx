import { createRoot } from "react-dom/client";
import { SettingsWindow } from "../windows/SettingsWindow";
import "../styles/globals.css";

createRoot(document.getElementById("root")!).render(<SettingsWindow />);
