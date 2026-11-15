/* Picker entry: `picker.html` serves both surfaces.
 *
 * `?surface=toolbar` is the standalone capsule shown while a pinned panel is
 * open; otherwise this is the result panel window.
 */
import { createRoot } from "react-dom/client";

import { PickerWindow } from "../windows/PickerWindow";
import { detectSurface } from "../lib/picker/model";
import "../styles/globals.css";

const surface = detectSurface();

createRoot(document.getElementById("root")!).render(<PickerWindow surface={surface} />);
