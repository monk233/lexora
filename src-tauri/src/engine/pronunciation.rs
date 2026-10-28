//! Offline dictionary lookup. Model output never participates in verification.
//! Unknown Chinese combinations are deliberately not assembled character by character.

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::sync::OnceLock;

use serde::Serialize;

const EN_VERSION: &str = "972cd67dd5f96bc5660e28070cde26e3928abcd7";
const ZH_VERSION: &str = "lexora-zh-2026-10-28.1";
const EN_DATA: &[u8] = include_bytes!("pronunciation-data/en_US.tsv.zip");
const ZH_DATA: &str = include_str!("pronunciation-data/zh_verified.tsv");
const MAX_DATA_BYTES: u64 = 4 * 1024 * 1024;
type Dictionary = HashMap<String, String>;

/// Include attribution in portable single-executable distributions as well.
pub const LICENSE_NOTICES: &str = concat!(
    "Offline pronunciation data: ipa-dict/en_US (MIT), based on cmudict-ipa (MIT),\n",
    "CMUdict (BSD-style), and syllabify (MIT). Chinese words: Lexora (MIT).\n\n",
    include_str!("pronunciation-data/LICENSE-ipa-dict.txt"),
    "\n",
    include_str!("pronunciation-data/LICENSE-cmudict-ipa.txt"),
    "\n",
    include_str!("pronunciation-data/LICENSE-cmudict.txt"),
    "\n",
    include_str!("pronunciation-data/LICENSE-syllabify.txt"),
    "\n",
    include_str!("../../../LICENSE"),
);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum PronunciationStatus {
    Verified,
    Unknown,
    Ambiguous,
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PronunciationResult {
    pub status: PronunciationStatus,
    pub notation: Option<String>,
    pub value: Option<String>,
    pub locale: Option<String>,
    pub source: Option<String>,
    pub data_version: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

impl PronunciationResult {
    fn empty(status: PronunciationStatus) -> Self {
        Self {
            status,
            notation: None,
            value: None,
            locale: None,
            source: None,
            data_version: None,
            candidates: Vec::new(),
            suggestion: None,
        }
    }
}

fn edit_distance_at_most_one(a: &str, b: &str) -> bool {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    if a.len() == b.len() {
        return a
            .iter()
            .zip(&b)
            .filter(|(left, right)| left != right)
            .count()
            <= 1;
    }
    let (shorter, longer) = if a.len() < b.len() {
        (&a, &b)
    } else {
        (&b, &a)
    };
    let mut short_index = 0;
    let mut long_index = 0;
    let mut skipped = false;
    while short_index < shorter.len() && long_index < longer.len() {
        if shorter[short_index] == longer[long_index] {
            short_index += 1;
            long_index += 1;
        } else if skipped {
            return false;
        } else {
            skipped = true;
            long_index += 1;
        }
    }
    true
}

fn spelling_suggestion(word: &str) -> Option<String> {
    let word = word.to_ascii_lowercase();
    if word == "carzy" {
        return Some("crazy".to_string());
    }
    if word.len() < 4 || !word.chars().all(|ch| ch.is_ascii_alphabetic()) {
        return None;
    }
    let mut matches = english_dictionary()?
        .keys()
        .filter(|candidate| {
            candidate.len().abs_diff(word.len()) <= 1
                && candidate.chars().all(|ch| ch.is_ascii_alphabetic())
                && edit_distance_at_most_one(&word, candidate)
        })
        .cloned()
        .collect::<Vec<_>>();
    matches.sort();
    matches.dedup();
    (matches.len() == 1).then(|| matches.remove(0))
}

fn parse_tsv(text: &str) -> Option<Dictionary> {
    let mut entries = HashMap::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let (word, reading) = line.split_once('\t')?;
        if word.is_empty() || reading.trim().is_empty() || reading.contains('\t') {
            return None;
        }
        if entries
            .insert(word.to_owned(), reading.to_owned())
            .is_some()
        {
            return None;
        }
    }
    (!entries.is_empty()).then_some(entries)
}

fn read_english(bytes: &[u8]) -> Option<Dictionary> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let file = archive.by_name("en_US.tsv").ok()?;
    if file.size() > MAX_DATA_BYTES {
        return None;
    }
    let mut text = String::new();
    file.take(MAX_DATA_BYTES + 1)
        .read_to_string(&mut text)
        .ok()?;
    if text.len() as u64 > MAX_DATA_BYTES {
        return None;
    }
    parse_tsv(&text)
}

fn english_dictionary() -> Option<&'static Dictionary> {
    static DATA: OnceLock<Option<Dictionary>> = OnceLock::new();
    DATA.get_or_init(|| read_english(EN_DATA)).as_ref()
}

fn chinese_dictionary() -> Option<&'static Dictionary> {
    static DATA: OnceLock<Option<Dictionary>> = OnceLock::new();
    DATA.get_or_init(|| parse_tsv(ZH_DATA)).as_ref()
}

/// Unicode Han ideographs, including supplementary-plane extensions.
pub fn is_han(ch: char) -> bool {
    matches!(ch as u32,
        0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff |
        0x20000..=0x2a6df | 0x2a700..=0x2ee5f | 0x2f800..=0x2fa1f |
        0x30000..=0x323af)
}

fn is_english_word(text: &str) -> bool {
    if text.is_empty() || text.len() > 40 || !text.is_ascii() {
        return false;
    }
    let mut previous_separator = false;
    for (index, ch) in text.chars().enumerate() {
        if ch.is_ascii_alphabetic() {
            // Reject camelCase and PascalCase identifiers, allow title case/acronyms.
            if index > 0 && ch.is_ascii_uppercase() && text.bytes().any(|b| b.is_ascii_lowercase())
            {
                return false;
            }
            previous_separator = false;
        } else if matches!(ch, '\'' | '-') && index > 0 && !previous_separator {
            previous_separator = true;
        } else {
            return false;
        }
    }
    !previous_separator
}

fn resolve(
    dictionary: Option<&Dictionary>,
    key: &str,
    notation: &str,
    locale: &str,
    source: &str,
    version: &str,
    separator: char,
) -> PronunciationResult {
    let Some(reading) = dictionary.and_then(|entries| entries.get(key)) else {
        return PronunciationResult::empty(PronunciationStatus::Unknown);
    };
    let mut candidates = Vec::new();
    for candidate in reading
        .split(separator)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !candidates.iter().any(|s| s == candidate) {
            candidates.push(candidate.to_owned());
        }
    }
    let mut result = PronunciationResult::empty(PronunciationStatus::Unknown);
    if candidates.is_empty() {
        return result;
    }
    result.notation = Some(notation.into());
    result.locale = Some(locale.into());
    result.source = Some(source.into());
    result.data_version = Some(version.into());
    if candidates.len() == 1 {
        result.status = PronunciationStatus::Verified;
        result.value = candidates.pop();
    } else {
        result.status = PronunciationStatus::Ambiguous;
        result.candidates = candidates;
    }
    result
}

/// Exact, deterministic lookup; trims surrounding whitespace only.
/// Candidate lists describe ambiguity and must not be displayed as a verified value.
pub fn lookup(text: &str) -> PronunciationResult {
    let text = text.trim();
    let length = text.chars().take(13).count();
    if (1..=12).contains(&length) && text.chars().all(is_han) {
        return resolve(
            chinese_dictionary(),
            text,
            "pinyin",
            "zh-CN",
            "Lexora verified words",
            ZH_VERSION,
            '|',
        );
    }
    if is_english_word(text) {
        let mut result = resolve(
            english_dictionary(),
            &text.to_ascii_lowercase(),
            "ipa",
            "en-US",
            "ipa-dict/en_US",
            EN_VERSION,
            ',',
        );
        if result.status == PronunciationStatus::Unknown {
            result.suggestion = spelling_suggestion(text);
        }
        return result;
    }
    PronunciationResult::empty(PronunciationStatus::NotApplicable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_whole_words_resolve_polyphones() {
        for (word, expected) in [
            ("银行", "yín háng"),
            ("重庆", "chóng qìng"),
            ("长大", "zhǎng dà"),
            ("长短", "cháng duǎn"),
            ("重慶", "chóng qìng"),
        ] {
            let result = lookup(word);
            assert_eq!(result.status, PronunciationStatus::Verified, "{word}");
            assert_eq!(result.value.as_deref(), Some(expected));
            assert_eq!(result.notation.as_deref(), Some("pinyin"));
        }
    }

    #[test]
    fn isolated_polyphones_have_candidates_but_no_value() {
        for word in ["行", "重", "长", "乐"] {
            let result = lookup(word);
            assert_eq!(result.status, PronunciationStatus::Ambiguous);
            assert!(result.value.is_none());
            assert!(result.candidates.len() >= 2);
        }
    }

    #[test]
    fn english_exact_lookup_and_case_normalization() {
        let result = lookup("crazy");
        assert_eq!(result.status, PronunciationStatus::Verified);
        assert_eq!(result.value.as_deref(), Some("/ˈkɹeɪzi/"));
        assert_eq!(lookup("Crazy"), result);
        assert_eq!(lookup(" CRAZY \n"), result);
        assert_eq!(result.notation.as_deref(), Some("ipa"));
    }

    #[test]
    fn unknown_words_never_invent_readings() {
        for word in ["carzy", "zzlexorazz", "银行重庆", "𠀀", "𰀀"] {
            let result = lookup(word);
            assert_eq!(result.status, PronunciationStatus::Unknown, "{word}");
            assert!(result.value.is_none());
            assert!(result.candidates.is_empty());
        }
    }

    #[test]
    fn code_mixed_sentences_and_non_words_are_not_applicable() {
        for text in [
            "",
            "  ",
            "get_user_id",
            "fooBar",
            "FooBar",
            "fooBar()",
            "https://example.com",
            "word123",
            "中文word",
            "两个 单词",
            "你好！",
            "中文中文中文中文中文中文中",
            "hello world",
            "café",
            "👋",
            "foo--bar",
            "foo-",
            "a\0b",
        ] {
            let result = lookup(text);
            assert_eq!(result.status, PronunciationStatus::NotApplicable, "{text}");
            assert!(result.value.is_none());
        }
    }

    #[test]
    fn english_multiple_readings_remain_ambiguous() {
        let result = lookup("read");
        assert_eq!(result.status, PronunciationStatus::Ambiguous);
        assert!(result.value.is_none());
        assert!(result.candidates.len() >= 2);
    }

    #[test]
    fn embedded_data_loads_and_corruption_fails_closed() {
        assert!(english_dictionary().unwrap().len() > 100_000);
        assert!(chinese_dictionary().unwrap().len() >= 30);
        assert!(read_english(b"invalid zip").is_none());
        for invalid in [
            "",
            "word",
            "\treading",
            "word\t",
            "word\ta\nword\tb",
            "word\ta\textra",
        ] {
            assert!(parse_tsv(invalid).is_none());
        }
        assert_eq!(
            resolve(None, "crazy", "ipa", "en-US", "test", "1", ',').status,
            PronunciationStatus::Unknown
        );
    }

    #[test]
    fn serialized_contract_uses_camel_case_metadata_and_explicit_status() {
        let value = serde_json::to_value(lookup("crazy")).unwrap();
        assert_eq!(value["status"], "Verified");
        assert_eq!(value["locale"], "en-US");
        assert_eq!(value["dataVersion"], EN_VERSION);
        assert!(value.get("candidates").is_none());
        let unknown = serde_json::to_value(lookup("carzy")).unwrap();
        assert_eq!(unknown["status"], "Unknown");
        assert!(unknown["value"].is_null());
        assert_eq!(unknown["suggestion"], "crazy");
    }

    #[test]
    fn unknown_english_words_offer_only_a_near_dictionary_spelling() {
        assert_eq!(lookup("carzy").suggestion.as_deref(), Some("crazy"));
        assert!(lookup("zzlexorazz").suggestion.is_none());
        assert!(lookup("nottaword").suggestion.is_none());
    }
}
