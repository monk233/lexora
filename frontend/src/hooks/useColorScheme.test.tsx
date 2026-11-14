import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { useColorScheme } from "./useColorScheme";

/* `prefers-color-scheme` is not implemented by jsdom: the media query object is
 * stubbed with the listener set the hook subscribes to, so the test can drive
 * both the initial value and a live change. */
let dark = false;
const listeners = new Set<(event: { matches: boolean }) => void>();

beforeEach(() => {
  dark = false;
  listeners.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: dark,
    media: query,
    addEventListener: (_: string, cb: (event: { matches: boolean }) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (event: { matches: boolean }) => void) => listeners.delete(cb),
    addListener: () => {},
    removeListener: () => {},
  }));
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
  vi.unstubAllGlobals();
});

test("adds the dark class and reflects media changes", () => {
  const { result, unmount } = renderHook(() => useColorScheme());

  expect(result.current).toBe("light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);

  act(() => {
    dark = true;
    listeners.forEach((cb) => cb({ matches: true }));
  });

  expect(result.current).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);

  unmount();
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

test("starts dark when the media query already matches", () => {
  dark = true;
  const { result } = renderHook(() => useColorScheme());

  expect(result.current).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});
