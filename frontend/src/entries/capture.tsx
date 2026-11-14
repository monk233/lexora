import { createRoot } from "react-dom/client";
import { CaptureWindow } from "../windows/CaptureWindow";
import "../styles/globals.css";

createRoot(document.getElementById("root")!).render(<CaptureWindow />);
