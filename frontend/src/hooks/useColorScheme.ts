/* Dark mode follows the operating system, never `app.theme` (no UI in P2).
 *
 * The hook mirrors the legacy page's `prefers-color-scheme` handling: the
 * `dark` class on `<html>` is the only switch, so every Tailwind `dark:` token
 * and the `html.dark` CSS variable block resolve together. It stays
 * subscription-only (no polling) and restores the light document on unmount.
 */
import { useEffect, useState } from "react";

export type ColorScheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function matchesDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(DARK_QUERY).matches;
}

export function useColorScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(() => (matchesDark() ? "dark" : "light"));

  useEffect(() => {
    /* jsdom and very old webviews lack matchMedia; the light scheme is the
     * documented fallback and no listener is registered. */
    if (typeof window.matchMedia !== "function") return;

    const query = window.matchMedia(DARK_QUERY);
    const apply = (dark: boolean) => {
      document.documentElement.classList.toggle("dark", dark);
      setScheme(dark ? "dark" : "light");
    };

    /* Sync on mount: the media query may already match while the lazy state
     * initializer in a StrictMode double-render runs before the DOM exists. */
    apply(query.matches);

    const onChange = (event: { matches: boolean }) => apply(event.matches);
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
    } else if (typeof query.addListener === "function") {
      /* Safari < 14 uses the deprecated pair. */
      query.addListener(onChange);
    }

    return () => {
      if (typeof query.removeEventListener === "function") {
        query.removeEventListener("change", onChange);
      } else if (typeof query.removeListener === "function") {
        query.removeListener(onChange);
      }
      document.documentElement.classList.remove("dark");
    };
  }, []);

  return scheme;
}
