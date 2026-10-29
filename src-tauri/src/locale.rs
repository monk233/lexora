//! UI language detection: Windows region first, timezone as a secondary hint.
//!
//! The result is one of [`SUPPORTED_LANGUAGES`]. Unknown regions fall back to
//! the timezone mapping and finally to English, which keeps the UI usable on
//! unsupported locales without half-translated strings.

#[cfg(windows)]
use windows::Win32::Globalization::GetUserDefaultLocaleName;
#[cfg(windows)]
use windows::Win32::System::Time::{GetDynamicTimeZoneInformation, DYNAMIC_TIME_ZONE_INFORMATION};

/// Languages shipped with the first localization release.
pub const SUPPORTED_LANGUAGES: [&str; 2] = ["zh", "en"];

/// Normalizes a BCP-47-ish tag (`zh-CN`, `en-US`, …) to a supported language.
pub fn normalize_language(raw: &str) -> Option<&'static str> {
    let value = raw.trim().to_ascii_lowercase();
    if value.starts_with("zh") {
        Some("zh")
    } else if value.starts_with("en") {
        Some("en")
    } else {
        None
    }
}

fn language_from_region(region: &str) -> Option<&'static str> {
    normalize_language(region)
}

fn language_from_timezone(key: &str) -> Option<&'static str> {
    match key.trim().to_ascii_lowercase().as_str() {
        "china standard time"
        | "taipei standard time"
        | "hong kong standard time"
        | "singapore standard time" => Some("zh"),
        "gmt standard time"
        | "utc"
        | "w. europe standard time"
        | "eastern standard time"
        | "central standard time"
        | "mountain standard time"
        | "pacific standard time"
        | "tokyo standard time"
        | "korea standard time" => Some("en"),
        _ => None,
    }
}

/// Region wins over timezone; both unknown -> English.
pub fn resolve_language(region: Option<&str>, timezone: Option<&str>) -> &'static str {
    region
        .and_then(language_from_region)
        .or_else(|| timezone.and_then(language_from_timezone))
        .unwrap_or("en")
}

/// Current Windows user locale, e.g. `zh-CN` / `en-US`; `None` when unavailable.
pub fn system_region() -> Option<String> {
    #[cfg(windows)]
    {
        let mut buffer = [0u16; 85];
        let length = unsafe { GetUserDefaultLocaleName(&mut buffer) };
        if length > 0 {
            let text = String::from_utf16_lossy(&buffer[..(length as usize - 1).min(buffer.len())]);
            let text = text.trim().to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Windows time-zone key name, e.g. `China Standard Time`.
pub fn system_timezone_key() -> Option<String> {
    #[cfg(windows)]
    {
        let mut info = DYNAMIC_TIME_ZONE_INFORMATION::default();
        let result = unsafe { GetDynamicTimeZoneInformation(&mut info) };
        // 0 = unknown, 1 = standard, 2 = daylight; the key name is still valid.
        let _ = result;
        let name = &info.TimeZoneKeyName;
        let length = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        if length == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&name[..length]))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Detected UI language for the `system` setting.
pub fn detect_language() -> &'static str {
    resolve_language(system_region().as_deref(), system_timezone_key().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_languages_cover_zh_and_en() {
        assert_eq!(SUPPORTED_LANGUAGES, ["zh", "en"]);
    }

    #[test]
    fn normalize_language_accepts_aliases_and_rejects_unknown() {
        for value in ["zh", "zh-CN", " zh-hans ", "zh-SG", "ZH-HANT"] {
            assert_eq!(normalize_language(value), Some("zh"), "{value}");
        }
        for value in ["en", "en-US", "EN-GB"] {
            assert_eq!(normalize_language(value), Some("en"), "{value}");
        }
        assert_eq!(normalize_language("ja-JP"), None);
        assert_eq!(normalize_language(""), None);
    }

    #[test]
    fn region_wins_over_timezone_and_unknown_falls_back_to_english() {
        assert_eq!(
            resolve_language(Some("zh-Hant-TW"), Some("Tokyo Standard Time")),
            "zh"
        );
        assert_eq!(
            resolve_language(Some("en-GB"), Some("China Standard Time")),
            "en"
        );
        assert_eq!(resolve_language(None, Some("China Standard Time")), "zh");
        assert_eq!(resolve_language(None, Some("Pacific Standard Time")), "en");
        assert_eq!(resolve_language(None, None), "en");
        assert_eq!(
            resolve_language(Some("ja-JP"), Some("Tokyo Standard Time")),
            "en"
        );
    }

    #[test]
    fn system_probes_are_safe() {
        let language = detect_language();
        assert!(SUPPORTED_LANGUAGES.contains(&language));
        let _ = system_region();
        let _ = system_timezone_key();
    }
}
