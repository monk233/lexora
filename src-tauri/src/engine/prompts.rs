//! Prompt construction for translation, summarization and explanation.
//!
//! Everything here is pure: the shell passes user text and a target language
//! code, and gets back the exact `messages` array that is sent to the model.
//! Tests in this module keep the prompt wording and truncation rules locked to
//! the engineering contract (`docs/contracts.md` §6.1).

use crate::engine::EngineError;

/// Free-form summary/explanation prompts get this much input at most.
pub const ASSIST_MAX_CHARS: usize = 8_000;

/// System prompt for translation. `{target}` is replaced by a language name.
pub const TRANSLATE_SYSTEM_PREFIX: &str =
    "你是一名专业的翻译引擎。请把用户提供的文本翻译为目标语言：";
pub const TRANSLATE_SYSTEM_SUFFIX: &str = "。只输出译文本身，不要解释、不要加引号、不要输出原文。";

pub const SUMMARIZE_SYSTEM: &str =
    "你是一名中文写作助手。请用简体中文总结用户提供的文本，输出简洁、准确的要点，不要添加与原文无关的内容。";

pub const EXPLAIN_SYSTEM: &str =
    "你是一名知识助手。请用简体中文解释用户提供的文本，讲清含义、背景和关键概念，必要时举例说明。";

/// Maps a language code to the Chinese name used inside prompts.
pub fn language_name(code: &str) -> String {
    match code.trim().to_ascii_lowercase().as_str() {
        "zh" | "zh-cn" | "zh-hans" => "简体中文".to_string(),
        "en" | "en-us" | "en-gb" => "英语".to_string(),
        "ja" => "日语".to_string(),
        "de" => "德语".to_string(),
        "fr" => "法语".to_string(),
        "es" => "西班牙语".to_string(),
        "ru" => "俄语".to_string(),
        "ko" => "韩语".to_string(),
        // Unknown codes are handed to the model as-is; it usually understands
        // BCP-47 tags and this keeps custom targets working without a schema
        // change.
        other if !other.is_empty() => other.to_string(),
        _ => "简体中文".to_string(),
    }
}

/// Resolves the `auto` target the same way the picker UI does: Chinese source
/// text goes to English, everything else goes to Simplified Chinese.
pub fn resolve_target_lang(target_lang: &str, text: &str) -> String {
    let code = target_lang.trim().to_ascii_lowercase();
    if code != "auto" && !code.is_empty() {
        return code;
    }
    if is_mostly_chinese(text) {
        "en".to_string()
    } else {
        "zh".to_string()
    }
}

/// `true` when more than 30% of the characters are CJK ideographs.
pub fn is_mostly_chinese(text: &str) -> bool {
    let mut total = 0usize;
    let mut cjk = 0usize;
    for character in text.chars() {
        if character.is_whitespace() {
            continue;
        }
        total += 1;
        if is_cjk(character) {
            cjk += 1;
        }
    }
    total > 0 && (cjk as f64) > (total as f64) * 0.3
}

fn is_cjk(character: char) -> bool {
    matches!(character,
        '\u{4e00}'..='\u{9fff}' | '\u{3400}'..='\u{4dbf}' | '\u{f900}'..='\u{faff}')
}

/// Truncates by characters (not bytes) so multi-byte text is never split.
pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    text.chars().take(max_chars).collect()
}

/// Builds the chat messages for a translation request.
pub fn translate_messages(text: &str, target_lang: &str) -> (String, String) {
    let language = language_name(target_lang);
    let system = format!("{TRANSLATE_SYSTEM_PREFIX}{language}{TRANSLATE_SYSTEM_SUFFIX}");
    (system, text.to_string())
}

/// Builds the chat messages for a `summarize` / `explain` request.
pub fn assist_messages(action: &str, text: &str) -> Result<(String, String), EngineError> {
    let system = match action.trim().to_ascii_lowercase().as_str() {
        "summarize" | "summary" | "总结" => SUMMARIZE_SYSTEM,
        "explain" | "解释" => EXPLAIN_SYSTEM,
        _ => {
            return Err(EngineError::new(
                "不支持的技能操作。",
                "目前只支持总结（summarize）和解释（explain）两种操作。",
            ))
        }
    };
    Ok((system.to_string(), text.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_names_cover_all_supported_codes() {
        for code in ["zh", "en", "ja", "de", "fr", "es", "ru", "ko"] {
            let name = language_name(code);
            assert!(!name.is_empty(), "empty name for {code}");
            assert_ne!(name, code, "code {code} should map to a Chinese name");
        }
        assert_eq!(language_name("ZH"), "简体中文");
        assert_eq!(language_name("自定义"), "自定义");
        assert_eq!(language_name(""), "简体中文");
    }

    #[test]
    fn auto_target_follows_picker_heuristics() {
        assert_eq!(
            resolve_target_lang("auto", "这是一段中文文字，需要翻译。"),
            "en"
        );
        assert_eq!(
            resolve_target_lang("auto", "This is an English sentence."),
            "zh"
        );
        assert_eq!(resolve_target_lang("en", "中文"), "en");
        assert_eq!(resolve_target_lang("", "hello"), "zh");
    }

    #[test]
    fn mostly_chinese_ignores_whitespace() {
        assert!(is_mostly_chinese("中文 中文 中文"));
        assert!(!is_mostly_chinese("hello world"));
        assert!(!is_mostly_chinese(""));
    }

    #[test]
    fn truncate_counts_characters_not_bytes() {
        let text = "你好世界abc";
        assert_eq!(truncate_chars(text, 2), "你好");
        assert_eq!(truncate_chars(text, 100), text);
        assert_eq!(truncate_chars(text, 0), "");
        // Cutting must never split a multi-byte character.
        assert_eq!(truncate_chars("아주긴한국어텍스트", 3), "아주긴");
    }

    #[test]
    fn translate_prompt_matches_contract() {
        let (system, user) = translate_messages("hello", "zh");
        assert_eq!(
            system,
            "你是一名专业的翻译引擎。请把用户提供的文本翻译为目标语言：简体中文。只输出译文本身，不要解释、不要加引号、不要输出原文。"
        );
        assert_eq!(user, "hello");
    }

    #[test]
    fn assist_prompts_match_contract() {
        let (summarize, _) = assist_messages("summarize", "text").unwrap();
        assert_eq!(summarize, SUMMARIZE_SYSTEM);
        let (explain, _) = assist_messages("explain", "text").unwrap();
        assert_eq!(explain, EXPLAIN_SYSTEM);
        assert!(assist_messages("read", "text").is_err());
    }

    #[test]
    fn assist_input_limit_is_8000_chars() {
        assert_eq!(ASSIST_MAX_CHARS, 8_000);
    }
}
