/* Global shortcut helpers (C54–C59, assertions 32–33).
 *
 * Verbatim port of the legacy recorder rules in `web/settings.js:1451-1619`:
 * fixed modifier order (Win → Ctrl → Alt → Shift, mirroring Rust
 * `settings::normalize_shortcut`), the main-key whitelist from the contract and
 * the per-target defaults. Pure functions only: the DOM work (capture-phase
 * listener, blur cancel) lives in `HotkeyRecorder`.
 */

/** Named main keys accepted by `normalize_shortcut`, keyed by lowercase event key. */
export const HOTKEY_NAMED_KEYS: Record<string, string> = {
  " ": "Space",
  space: "Space",
  spacebar: "Space",
  tab: "Tab",
  enter: "Enter",
  return: "Enter",
  backspace: "Backspace",
  insert: "Insert",
  ins: "Insert",
  delete: "Delete",
  del: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pgup: "PageUp",
  pagedown: "PageDown",
  pgdn: "PageDown",
  up: "Up",
  arrowup: "Up",
  down: "Down",
  arrowdown: "Down",
  left: "Left",
  arrowleft: "Left",
  right: "Right",
  arrowright: "Right",
  printscreen: "PrintScreen",
  print: "PrintScreen",
  prtsc: "PrintScreen",
};

/** Bare modifier keys never finish a recording; they are swallowed too. */
export const HOTKEY_MODIFIER_KEYS: Record<string, true> = {
  Control: true,
  Shift: true,
  Alt: true,
  Meta: true,
  OS: true,
  AltGraph: true,
};

/** Rust `normalize_shortcut` fallback for `capture.regionShortcut`. */
export const CAPTURE_FALLBACK = "Win+Shift+X";
/** Rust `normalize_quick_shortcut` fallback for `quick.hotkey`. */
export const QUICK_FALLBACK = "Alt+Space";

/** The subset of `KeyboardEvent` the recorder turn into a combo. */
export type HotkeyEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

/** `keyFromEvent` only needs the logical key and the physical code. */
export type HotkeyKeyEvent = Pick<KeyboardEvent, "key" | "code">;

export function isModifierKey(key: string): boolean {
  return HOTKEY_MODIFIER_KEYS[String(key ?? "")] === true;
}

/**
 * Main key from a keyboard event; "" when the key is not allowed.
 *
 * Letters are upper-cased, function keys normalized to `F<n>` and named keys
 * mapped through `HOTKEY_NAMED_KEYS`. A synthetic/IME event with an empty `key`
 * still resolves from the physical `code`.
 */
export function keyFromEvent(event: HotkeyKeyEvent): string {
  if (!event) return "";
  const key = String(event.key ?? "");
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(key);
  if (fn) return `F${fn[1]}`;
  const named = HOTKEY_NAMED_KEYS[key.toLowerCase()];
  if (named) return named;

  const code = String(event.code ?? "");
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return "";
}

/**
 * Canonical combination from an event, "" when it cannot be saved.
 *
 * Modifier order is fixed at Win → Ctrl → Alt → Shift so the value matches what
 * Rust persists; a missing modifier or main key yields "".
 */
export function comboFromEvent(event: HotkeyEvent): string {
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push("Win");
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  const key = keyFromEvent(event);
  if (!key || modifiers.length === 0) return "";
  return [...modifiers, key].join("+");
}

export type HotkeyIssue = "unsupported-key" | "modifier-required";

/**
 * Why an event did not produce a saveable combo; `null` means "keep recording".
 *
 * Mirrors the legacy branch order: an unknown main key is reported as
 * unsupported, a known main key without modifiers as modifier-required, and a
 * bare modifier just keeps waiting.
 */
export function comboIssue(event: HotkeyEvent): HotkeyIssue | null {
  const key = String(event.key ?? "");
  if (isModifierKey(key)) return null;
  if (comboFromEvent(event)) return null;
  return keyFromEvent(event) ? "modifier-required" : "unsupported-key";
}

/** "Ctrl+Alt+P" → "Ctrl + Alt + P" for display only. */
export function formatShortcut(shortcut: string | null | undefined): string {
  return String(shortcut ?? "")
    .split("+")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .join(" + ");
}

/** Stored value for a recorder target; empty/blank falls back to the default. */
export function resolveShortcut(
  value: string | null | undefined,
  fallback: string
): string {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
}
