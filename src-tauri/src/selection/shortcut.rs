//! Parsing and matching of the configurable global hotkey.
//!
//! The settings schema only allows `Ctrl` / `Shift` / `Alt` combined with
//! `A-Z`, `0-9` or `F1-F12`; there is intentionally no general key-code parser.
//! `CommandOrControl` is accepted as an alias for `Ctrl` so shortcuts copied
//! from the Electron version keep working.

use rdev::Key;

/// Non-modifier part of a shortcut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutKey {
    /// `A`-`Z` (upper case).
    Alpha(char),
    /// `0`-`9`.
    Digit(char),
    /// `F1`-`F12`.
    Function(u8),
}

/// A fully parsed shortcut: required modifier set plus the trigger key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShortcutSpec {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub key: ShortcutKey,
}

impl ShortcutSpec {
    /// Matches the exact modifier set (extra modifiers do not count as a hit).
    pub fn matches(&self, ctrl: bool, shift: bool, alt: bool, key: ShortcutKey) -> bool {
        self.ctrl == ctrl && self.shift == shift && self.alt == alt && self.key == key
    }
}

/// Parses strings such as `Ctrl+Shift+D`, `ctrl+alt+f12` or
/// `CommandOrControl+1`. Returns `None` for anything outside the supported
/// subset (including a missing modifier or a missing key).
pub fn parse_shortcut(value: &str) -> Option<ShortcutSpec> {
    let mut ctrl = false;
    let mut shift = false;
    let mut alt = false;
    let mut key: Option<ShortcutKey> = None;

    for raw in value.split('+') {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }
        match token.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" | "cmd" | "command" => {
                ctrl = true;
            }
            "shift" => shift = true,
            "alt" | "option" => alt = true,
            other => {
                if key.is_some() {
                    return None;
                }
                key = Some(parse_key(other)?);
            }
        }
    }

    match key {
        Some(key) if ctrl || shift || alt => Some(ShortcutSpec {
            ctrl,
            shift,
            alt,
            key,
        }),
        _ => None,
    }
}

fn parse_key(token: &str) -> Option<ShortcutKey> {
    let mut chars = token.chars();
    let first = chars.next()?;
    if chars.next().is_none() {
        let upper = first.to_ascii_uppercase();
        if upper.is_ascii_uppercase() {
            return Some(ShortcutKey::Alpha(upper));
        }
        if upper.is_ascii_digit() {
            return Some(ShortcutKey::Digit(upper));
        }
        return None;
    }

    // `F1` .. `F12` (already lower-cased by the caller).
    let rest = token
        .strip_prefix('f')
        .or_else(|| token.strip_prefix('F'))?;
    let number: u8 = rest.parse().ok()?;
    if (1..=12).contains(&number) {
        Some(ShortcutKey::Function(number))
    } else {
        None
    }
}

/// Maps a physical key reported by `rdev` to the shortcut representation.
/// Layout-dependent characters are deliberately ignored; only the keys the
/// settings schema supports have a mapping.
pub fn key_from_rdev(key: Key) -> Option<ShortcutKey> {
    use Key::*;
    let key = match key {
        KeyA => ShortcutKey::Alpha('A'),
        KeyB => ShortcutKey::Alpha('B'),
        KeyC => ShortcutKey::Alpha('C'),
        KeyD => ShortcutKey::Alpha('D'),
        KeyE => ShortcutKey::Alpha('E'),
        KeyF => ShortcutKey::Alpha('F'),
        KeyG => ShortcutKey::Alpha('G'),
        KeyH => ShortcutKey::Alpha('H'),
        KeyI => ShortcutKey::Alpha('I'),
        KeyJ => ShortcutKey::Alpha('J'),
        KeyK => ShortcutKey::Alpha('K'),
        KeyL => ShortcutKey::Alpha('L'),
        KeyM => ShortcutKey::Alpha('M'),
        KeyN => ShortcutKey::Alpha('N'),
        KeyO => ShortcutKey::Alpha('O'),
        KeyP => ShortcutKey::Alpha('P'),
        KeyQ => ShortcutKey::Alpha('Q'),
        KeyR => ShortcutKey::Alpha('R'),
        KeyS => ShortcutKey::Alpha('S'),
        KeyT => ShortcutKey::Alpha('T'),
        KeyU => ShortcutKey::Alpha('U'),
        KeyV => ShortcutKey::Alpha('V'),
        KeyW => ShortcutKey::Alpha('W'),
        KeyX => ShortcutKey::Alpha('X'),
        KeyY => ShortcutKey::Alpha('Y'),
        KeyZ => ShortcutKey::Alpha('Z'),
        Num0 => ShortcutKey::Digit('0'),
        Num1 => ShortcutKey::Digit('1'),
        Num2 => ShortcutKey::Digit('2'),
        Num3 => ShortcutKey::Digit('3'),
        Num4 => ShortcutKey::Digit('4'),
        Num5 => ShortcutKey::Digit('5'),
        Num6 => ShortcutKey::Digit('6'),
        Num7 => ShortcutKey::Digit('7'),
        Num8 => ShortcutKey::Digit('8'),
        Num9 => ShortcutKey::Digit('9'),
        F1 => ShortcutKey::Function(1),
        F2 => ShortcutKey::Function(2),
        F3 => ShortcutKey::Function(3),
        F4 => ShortcutKey::Function(4),
        F5 => ShortcutKey::Function(5),
        F6 => ShortcutKey::Function(6),
        F7 => ShortcutKey::Function(7),
        F8 => ShortcutKey::Function(8),
        F9 => ShortcutKey::Function(9),
        F10 => ShortcutKey::Function(10),
        F11 => ShortcutKey::Function(11),
        F12 => ShortcutKey::Function(12),
        _ => return None,
    };
    Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_default_shortcut() {
        let spec = parse_shortcut("Ctrl+Shift+D").unwrap();
        assert!(spec.ctrl);
        assert!(spec.shift);
        assert!(!spec.alt);
        assert_eq!(spec.key, ShortcutKey::Alpha('D'));
        assert!(spec.matches(true, true, false, ShortcutKey::Alpha('D')));
        assert!(!spec.matches(true, false, false, ShortcutKey::Alpha('D')));
        assert!(!spec.matches(true, true, true, ShortcutKey::Alpha('D')));
    }

    #[test]
    fn parsing_is_case_insensitive_and_order_independent() {
        let lower = parse_shortcut("ctrl+shift+d").unwrap();
        let reordered = parse_shortcut("  SHIFT + ctrl + D  ").unwrap();
        assert_eq!(lower, reordered);
        assert_eq!(lower.key, ShortcutKey::Alpha('D'));
    }

    #[test]
    fn command_or_control_is_treated_as_ctrl() {
        let spec = parse_shortcut("CommandOrControl+Alt+1").unwrap();
        assert!(spec.ctrl);
        assert!(spec.alt);
        assert!(!spec.shift);
        assert_eq!(spec.key, ShortcutKey::Digit('1'));
    }

    #[test]
    fn supports_digits_and_function_keys() {
        assert_eq!(
            parse_shortcut("Ctrl+F12").unwrap().key,
            ShortcutKey::Function(12)
        );
        assert_eq!(
            parse_shortcut("Alt+Shift+0").unwrap().key,
            ShortcutKey::Digit('0')
        );
    }

    #[test]
    fn rejects_unsupported_shortcuts() {
        for invalid in [
            "",
            "Ctrl",
            "Ctrl+Shift",
            "D",
            "Ctrl+Shift+?",
            "Ctrl+Shift+Q+W",
            "Ctrl+F0",
            "Ctrl+F13",
            "Hyper+D",
            "Ctrl+Shift+Space",
        ] {
            assert!(
                parse_shortcut(invalid).is_none(),
                "expected {invalid:?} to be rejected"
            );
        }
    }

    #[test]
    fn maps_rdev_keys() {
        assert_eq!(key_from_rdev(Key::KeyD), Some(ShortcutKey::Alpha('D')));
        assert_eq!(key_from_rdev(Key::Num7), Some(ShortcutKey::Digit('7')));
        assert_eq!(key_from_rdev(Key::F9), Some(ShortcutKey::Function(9)));
        assert_eq!(key_from_rdev(Key::Space), None);
        assert_eq!(key_from_rdev(Key::Escape), None);
    }
}
