/* Hotkey helpers (C54–C59, assertions 32–33).
 *
 * Every rule here is a port of `web/settings.js:1451-1619`: the canonical
 * modifier order, the main-key whitelist and the "no modifier / unknown key"
 * split the recorder turns into inline copy.
 */
import { expect, test } from "vitest";

import {
  CAPTURE_FALLBACK,
  HOTKEY_MODIFIER_KEYS,
  HOTKEY_NAMED_KEYS,
  QUICK_FALLBACK,
  comboFromEvent,
  comboIssue,
  formatShortcut,
  isModifierKey,
  keyFromEvent,
  resolveShortcut,
} from "./hotkeys";

type ComboEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

/* Complete event shape with the legacy-relevant modifiers defaulted to false. */
function event(init: Partial<ComboEvent> & { key: string }): ComboEvent {
  return {
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  };
}

test("maps keyboard events to canonical combos", () => {
  expect(
    comboFromEvent(event({ key: "p", code: "KeyP", ctrlKey: true, altKey: true }))
  ).toBe("Ctrl+Alt+P");
  expect(
    comboFromEvent(
      event({
        key: "P",
        code: "KeyP",
        metaKey: true,
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      })
    )
  ).toBe("Win+Ctrl+Alt+Shift+P");
  expect(comboFromEvent(event({ key: " ", code: "Space", ctrlKey: true }))).toBe(
    "Ctrl+Space"
  );
  expect(comboFromEvent(event({ key: "F13", code: "F13", ctrlKey: true }))).toBe(
    "Ctrl+F13"
  );
  expect(comboFromEvent(event({ key: "5", code: "Digit5", altKey: true }))).toBe("Alt+5");
});

test("rejects bare keys, unknown keys and bare modifiers", () => {
  expect(comboFromEvent(event({ key: "p", code: "KeyP" }))).toBe("");
  expect(comboFromEvent(event({ key: "AudioVolumeUp", ctrlKey: true }))).toBe("");
  expect(isModifierKey("Control")).toBe(true);
  expect(isModifierKey("p")).toBe(false);
  expect(keyFromEvent({ key: "Control", code: "ControlLeft" })).toBe("");
});

test("reads the main key from named keys and falls back to the physical code", () => {
  expect(keyFromEvent({ key: " ", code: "Space" })).toBe("Space");
  expect(keyFromEvent({ key: "ArrowUp", code: "ArrowUp" })).toBe("Up");
  expect(keyFromEvent({ key: "PageDown", code: "PageDown" })).toBe("PageDown");
  expect(keyFromEvent({ key: "PrintScreen", code: "PrintScreen" })).toBe("PrintScreen");
  expect(keyFromEvent({ key: "F1", code: "F1" })).toBe("F1");
  expect(keyFromEvent({ key: "F24", code: "F24" })).toBe("F24");
  expect(keyFromEvent({ key: "F25", code: "F25" })).toBe("");
  /* Synthetic/IME events can leave `key` empty: the physical code still works. */
  expect(keyFromEvent({ key: "", code: "KeyP" })).toBe("P");
  expect(keyFromEvent({ key: "", code: "Digit5" })).toBe("5");
  expect(keyFromEvent({ key: "", code: "F13" })).toBe("F13");
});

test("classifies an incomplete recording for the inline error", () => {
  expect(comboIssue(event({ key: "p", code: "KeyP" }))).toBe("modifier-required");
  expect(
    comboIssue(event({ key: "AudioVolumeUp", code: "", ctrlKey: true }))
  ).toBe("unsupported-key");
  expect(comboIssue(event({ key: "p", code: "KeyP", ctrlKey: true }))).toBeNull();
  /* Bare modifiers keep the recorder waiting instead of failing. */
  expect(comboIssue(event({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toBeNull();
});

test("formats only for display", () => {
  expect(formatShortcut("Ctrl+Alt+P")).toBe("Ctrl + Alt + P");
  expect(formatShortcut("Win+Shift+X")).toBe("Win + Shift + X");
  expect(formatShortcut("  Ctrl +  Alt + P ")).toBe("Ctrl + Alt + P");
  expect(formatShortcut("")).toBe("");
  expect(formatShortcut(undefined)).toBe("");
});

test("empty stored values fall back to the per-target default", () => {
  expect(resolveShortcut("", CAPTURE_FALLBACK)).toBe("Win+Shift+X");
  expect(resolveShortcut("   ", QUICK_FALLBACK)).toBe("Alt+Space");
  expect(resolveShortcut(undefined, QUICK_FALLBACK)).toBe("Alt+Space");
  expect(resolveShortcut("Ctrl+P", CAPTURE_FALLBACK)).toBe("Ctrl+P");
});

test("exposes the legacy tables and fallbacks", () => {
  expect(CAPTURE_FALLBACK).toBe("Win+Shift+X");
  expect(QUICK_FALLBACK).toBe("Alt+Space");
  for (const key of ["Control", "Shift", "Alt", "Meta", "OS", "AltGraph"]) {
    expect(HOTKEY_MODIFIER_KEYS[key]).toBe(true);
  }
  expect(HOTKEY_NAMED_KEYS[" "]).toBe("Space");
  expect(HOTKEY_NAMED_KEYS.arrowup).toBe("Up");
  expect(HOTKEY_NAMED_KEYS.printscreen).toBe("PrintScreen");
});
