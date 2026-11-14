import { createRoot } from "react-dom/client";
import { PickerWindow, type PickerSurface } from "../windows/PickerWindow";
import "../styles/globals.css";

const surface: PickerSurface =
  new URLSearchParams(location.search).get("surface") === "toolbar" ? "toolbar" : "panel";

createRoot(document.getElementById("root")!).render(<PickerWindow surface={surface} />);
