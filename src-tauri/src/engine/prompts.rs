//! Prompt construction for translation, summarization and explanation.
//!
//! Everything here is pure: the shell passes user text and a target language
//! code, and gets back the exact `messages` array that is sent to the model.
//! Each skill prompt can be overridden by the user (`settings.picker.prompts`):
//! an empty custom prompt falls back to the built-in English default, and
//! custom translation prompts may use `{target}` / `{language}` placeholders.
//! Tests in this module keep the prompt wording, placeholder rules and
//! truncation rules locked to the engineering contract (`docs/contracts.md` §6.1).

use crate::engine::EngineError;

/// Free-form summary/explanation prompts get this much input at most.
pub const ASSIST_MAX_CHARS: usize = 8_000;

/// Built-in English default prompts. `{target}` and `{language}` are replaced
/// by the target language name; the same rule applies to custom prompts.
pub const DEFAULT_TRANSLATE_PROMPT: &str = "You are a professional translation engine. Translate the user's text into {target}. Output only the translation, without explanations, quotes, or the source text.";

pub const DEFAULT_SUMMARIZE_PROMPT: &str = "You are a concise Chinese writing assistant. Summarize the user's text in Simplified Chinese and list the key points accurately, without adding anything that is not in the source.";

pub const DEFAULT_EXPLAIN_PROMPT: &str = "You are a knowledge assistant. Explain the user's text in Simplified Chinese, covering its meaning, background and key concepts, with short examples when helpful.";

/// Maps a language code to the English name used inside prompts. Covers the
/// languages supported by Hy-MT2 (33 languages plus Chinese variants and
/// minority languages).
pub fn language_name(code: &str) -> String {
    match code.trim().to_ascii_lowercase().as_str() {
        "zh" | "zh-cn" | "zh-hans" => "Simplified Chinese".to_string(),
        "zh-hant" | "zh-tw" | "zh-hk" => "Traditional Chinese".to_string(),
        "yue" => "Cantonese".to_string(),
        "en" | "en-us" | "en-gb" => "English".to_string(),
        "ja" => "Japanese".to_string(),
        "ko" => "Korean".to_string(),
        "fr" => "French".to_string(),
        "de" => "German".to_string(),
        "es" => "Spanish".to_string(),
        "pt" => "Portuguese".to_string(),
        "ru" => "Russian".to_string(),
        "ar" => "Arabic".to_string(),
        "it" => "Italian".to_string(),
        "nl" => "Dutch".to_string(),
        "pl" => "Polish".to_string(),
        "tr" => "Turkish".to_string(),
        "th" => "Thai".to_string(),
        "vi" => "Vietnamese".to_string(),
        "id" => "Indonesian".to_string(),
        "ms" => "Malay".to_string(),
        "tl" => "Filipino".to_string(),
        "hi" => "Hindi".to_string(),
        "bn" => "Bengali".to_string(),
        "ta" => "Tamil".to_string(),
        "te" => "Telugu".to_string(),
        "mr" => "Marathi".to_string(),
        "gu" => "Gujarati".to_string(),
        "ur" => "Urdu".to_string(),
        "fa" => "Persian".to_string(),
        "he" => "Hebrew".to_string(),
        "uk" => "Ukrainian".to_string(),
        "cs" => "Czech".to_string(),
        "km" => "Khmer".to_string(),
        "my" => "Burmese".to_string(),
        "bo" => "Tibetan".to_string(),
        "kk" => "Kazakh".to_string(),
        "mn" => "Mongolian".to_string(),
        "ug" => "Uyghur".to_string(),
        // Unknown codes are handed to the model as-is; it usually understands
        // BCP-47 tags and this keeps custom targets working without a schema
        // change.
        other if !other.is_empty() => other.to_string(),
        _ => "Simplified Chinese".to_string(),
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
///
/// `custom_prompt` is trimmed first; when it is empty the built-in English
/// default is used. `{target}` / `{language}` are replaced with the target
/// language name; a custom prompt without any placeholder gets an explicit
/// `Target language: ...` suffix so the target still takes effect.
pub fn translate_messages(text: &str, target_lang: &str, custom_prompt: &str) -> (String, String) {
    let language = language_name(target_lang);
    let custom_prompt = custom_prompt.trim();
    let template = if custom_prompt.is_empty() {
        DEFAULT_TRANSLATE_PROMPT
    } else {
        custom_prompt
    };
    let has_placeholder = template.contains("{target}") || template.contains("{language}");
    let mut system = template
        .replace("{target}", &language)
        .replace("{language}", &language);
    if !has_placeholder {
        system.push_str(&format!("\n\nTarget language: {language}."));
    }
    (system, text.to_string())
}

/// Builds the chat messages for a `summarize` / `explain` request. A non-empty
/// `custom_prompt` replaces the built-in default for that action completely.
pub fn assist_messages(
    action: &str,
    text: &str,
    custom_prompt: &str,
) -> Result<(String, String), EngineError> {
    let default_prompt = match action.trim().to_ascii_lowercase().as_str() {
        "summarize" | "summary" | "总结" => DEFAULT_SUMMARIZE_PROMPT,
        "explain" | "解释" => DEFAULT_EXPLAIN_PROMPT,
        _ => {
            return Err(EngineError::new(
                "不支持的技能操作。",
                "目前只支持总结（summarize）和解释（explain）两种操作。",
            ))
        }
    };
    let custom_prompt = custom_prompt.trim();
    let system = if custom_prompt.is_empty() {
        default_prompt
    } else {
        custom_prompt
    };
    Ok((system.to_string(), text.to_string()))
}

/// Placeholder used in prompts when the source application is unknown.
pub const UNKNOWN_PROGRAM_NAME: &str = "未知应用";

/// Renders a user-defined skill prompt.
///
/// Supported placeholders: `{text}` (selected text), `{target}` / `{language}`
/// (target language name), `{program}` / `{app}` (source application). Unknown
/// placeholders are kept verbatim so a user can talk about JSON or code
/// snippets without escaping; the selected text is inserted verbatim and is
/// never rendered itself.
pub fn render_custom_prompt(
    template: &str,
    text: &str,
    target_lang: &str,
    program: &str,
) -> String {
    let language = language_name(target_lang);
    let program = {
        let trimmed = program.trim();
        if trimmed.is_empty() {
            UNKNOWN_PROGRAM_NAME
        } else {
            trimmed
        }
    };

    let mut rendered = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        rendered.push_str(&rest[..open]);
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find('}') else {
            // Unclosed placeholder: keep the rest untouched.
            rendered.push_str(&rest[open..]);
            rest = "";
            break;
        };
        let name = &after_open[..close];
        let replacement = match name {
            "text" => Some(text),
            "target" | "language" => Some(language.as_str()),
            "program" | "app" => Some(program),
            _ => None,
        };
        match replacement {
            Some(value) => rendered.push_str(value),
            None => {
                // Unknown placeholder stays as-is.
                rendered.push('{');
                rendered.push_str(name);
                rendered.push('}');
            }
        }
        rest = &after_open[close + 1..];
    }
    rendered.push_str(rest);
    rendered.trim().to_string()
}

/// System default prompts exposed to the settings UI (`promptDefaults`).
pub fn default_prompts() -> serde_json::Value {
    serde_json::json!({
        "translate": DEFAULT_TRANSLATE_PROMPT,
        "summarize": DEFAULT_SUMMARIZE_PROMPT,
        "explain": DEFAULT_EXPLAIN_PROMPT,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_names_cover_all_supported_codes() {
        for (code, name) in [
            ("zh", "Simplified Chinese"),
            ("en", "English"),
            ("ja", "Japanese"),
            ("de", "German"),
            ("fr", "French"),
            ("es", "Spanish"),
            ("ru", "Russian"),
            ("ko", "Korean"),
        ] {
            assert_eq!(language_name(code), name, "wrong name for {code}");
        }
        assert_eq!(language_name("ZH"), "Simplified Chinese");
        assert_eq!(language_name("自定义"), "自定义");
        assert_eq!(language_name(""), "Simplified Chinese");
    }

    #[test]
    fn language_names_cover_every_supported_target() {
        for code in crate::settings::TARGET_LANGS {
            if code == "auto" {
                continue;
            }
            let name = language_name(code);
            assert!(!name.is_empty(), "empty name for {code}");
            assert_ne!(name, code, "code {code} should map to an English name");
        }
        assert_eq!(language_name("zh-hant"), "Traditional Chinese");
        assert_eq!(language_name("yue"), "Cantonese");
        assert_eq!(language_name("pt"), "Portuguese");
        assert_eq!(language_name("ug"), "Uyghur");
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
    fn default_prompts_are_english_and_match_constants() {
        assert!(DEFAULT_TRANSLATE_PROMPT.starts_with("You are"));
        assert!(DEFAULT_TRANSLATE_PROMPT.contains("{target}"));
        assert!(DEFAULT_SUMMARIZE_PROMPT.starts_with("You are"));
        assert!(DEFAULT_SUMMARIZE_PROMPT.contains("Simplified Chinese"));
        assert!(DEFAULT_EXPLAIN_PROMPT.starts_with("You are"));
        assert!(DEFAULT_EXPLAIN_PROMPT.contains("Simplified Chinese"));

        let (system, user) = translate_messages("hello", "zh", "");
        assert_eq!(
            system,
            DEFAULT_TRANSLATE_PROMPT.replace("{target}", "Simplified Chinese")
        );
        assert_eq!(user, "hello");

        let (summarize, _) = assist_messages("summarize", "text", "").unwrap();
        assert_eq!(summarize, DEFAULT_SUMMARIZE_PROMPT);
        let (explain, _) = assist_messages("explain", "text", "").unwrap();
        assert_eq!(explain, DEFAULT_EXPLAIN_PROMPT);
    }

    #[test]
    fn default_prompts_json_exposes_the_constants() {
        let defaults = default_prompts();
        assert_eq!(defaults["translate"], DEFAULT_TRANSLATE_PROMPT);
        assert_eq!(defaults["summarize"], DEFAULT_SUMMARIZE_PROMPT);
        assert_eq!(defaults["explain"], DEFAULT_EXPLAIN_PROMPT);
        assert_eq!(defaults.as_object().unwrap().len(), 3);
    }

    #[test]
    fn custom_prompts_override_defaults() {
        let (translated, _) = translate_messages("hello", "en", "  Translate to {target} only.  ");
        assert_eq!(translated, "Translate to English only.");

        let (summarized, _) =
            assist_messages("summarize", "text", "  Be extremely brief.  ").unwrap();
        assert_eq!(summarized, "Be extremely brief.");
        let (explained, _) = assist_messages("explain", "text", "Explain like a teacher.").unwrap();
        assert_eq!(explained, "Explain like a teacher.");
    }

    #[test]
    fn translate_custom_prompt_replaces_placeholders() {
        let (system, _) = translate_messages(
            "hello",
            "ja",
            "Translate into {target}. Reply in {language} only.",
        );
        assert_eq!(system, "Translate into Japanese. Reply in Japanese only.");
        // 有占位符时不再追加目标语言，避免重复。
        assert!(!system.contains("Target language:"));
    }

    #[test]
    fn translate_custom_prompt_without_placeholder_appends_target_language() {
        let (system, _) = translate_messages("hello", "de", "Translate only.");
        assert_eq!(system, "Translate only.\n\nTarget language: German.");
    }

    #[test]
    fn assist_actions_cover_aliases_and_reject_read() {
        for action in ["summarize", "summary", "总结"] {
            let (system, _) = assist_messages(action, "text", "").unwrap();
            assert_eq!(
                system, DEFAULT_SUMMARIZE_PROMPT,
                "wrong prompt for {action}"
            );
        }
        for action in ["explain", "解释"] {
            let (system, _) = assist_messages(action, "text", "").unwrap();
            assert_eq!(system, DEFAULT_EXPLAIN_PROMPT, "wrong prompt for {action}");
        }
        assert!(assist_messages("read", "text", "").is_err());
    }

    #[test]
    fn assist_input_limit_is_8000_chars() {
        assert_eq!(ASSIST_MAX_CHARS, 8_000);
    }

    #[test]
    fn custom_prompt_renders_supported_variables() {
        let rendered = render_custom_prompt(
            "Explain {text} to a {target} speaker ({language}) in {program}. Source: {app}.",
            "hello world",
            "ja",
            "Notepad",
        );
        assert_eq!(
            rendered,
            "Explain hello world to a Japanese speaker (Japanese) in Notepad. Source: Notepad."
        );
    }

    #[test]
    fn custom_prompt_keeps_unknown_placeholders() {
        assert_eq!(
            render_custom_prompt("Use {tone} and {text}.", "hi", "en", "Code"),
            "Use {tone} and hi."
        );
        // An unclosed brace is text, not a placeholder.
        assert_eq!(
            render_custom_prompt("Unclosed {text", "hi", "en", "Code"),
            "Unclosed {text"
        );
    }

    #[test]
    fn custom_prompt_falls_back_to_unknown_program() {
        assert_eq!(
            render_custom_prompt("Selected in {app}.", "hi", "en", "   "),
            "Selected in 未知应用."
        );
        assert_eq!(
            render_custom_prompt("Selected in {program}.", "hi", "en", ""),
            "Selected in 未知应用."
        );
        assert_eq!(
            render_custom_prompt("Selected in {program}.", "hi", "en", " VS Code "),
            "Selected in VS Code."
        );
    }

    #[test]
    fn custom_prompt_trims_and_inserts_text_verbatim() {
        assert_eq!(
            render_custom_prompt("  {text}  ", "  hi  ", "en", "Code"),
            "hi"
        );
        // The selected text is data, never re-rendered as a template.
        assert_eq!(
            render_custom_prompt("{text}", "{target}", "en", "Code"),
            "{target}"
        );
        // Custom skills may use a target/language without a trailing period.
        assert_eq!(
            render_custom_prompt("Translate into {language}", "hi", "de", "Code"),
            "Translate into German"
        );
    }
}
