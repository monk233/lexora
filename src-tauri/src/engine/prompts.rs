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

pub const DEFAULT_POLISH_PROMPT: &str = "You are a professional editor. Polish the user's text so it reads naturally and fluently while keeping the original meaning. Output only the polished text, without explanations, quotes, or the source text.";

/// System prompt template for a single-word dictionary lookup (translate/explain
/// on a single English word). `{target}` is replaced with the request's target
/// language name so the entry is explained in the language the user picked,
/// instead of always being a Chinese-English dictionary entry.
pub const DEFAULT_DICTIONARY_PROMPT: &str = "你是一名严谨的多语言词典助手。用户会给出一个英文单词，请使用目标语言（{target}）输出词典式释义，使用 Markdown 排版，依次包含：\n1. 常见释义：使用目标语言按词性分别列出该词的译法/释义；\n2. 发音：给出该词的英语 IPA 音标（英式/美式，若确定；不确定则省略），并给出目标语言中的常见读法（如适用）；\n3. 核心含义及用法：用目标语言按词性说明，给出常见搭配与例句（英文例句附目标语言翻译）；\n4. 高频场景：用目标语言说明该词最常见的语境或搭配场景。\n不要编造不存在的义项或音标，信息不确定时如实说明。";

/// Dictionary prompt for targets other than Chinese/English: the user asked for
/// the entry in the selected language, so do not force an English IPA
/// pronunciation block (e.g. Japanese uses katakana readings instead).
pub const NON_IPA_DICTIONARY_PROMPT: &str = "你是一名严谨的多语言词典助手。用户会给出一个英文单词，请使用目标语言（{target}）输出词典式释义，使用 Markdown 排版，依次包含：\n1. 常见释义：使用目标语言按词性分别列出该词的译法/释义；\n2. 发音：给出该词在目标语言中的常见读法/转写（如片假名、韩文转写等；若不确定则省略），不要输出英语 IPA 音标；\n3. 核心含义及用法：用目标语言按词性说明，给出常见搭配与例句（英文例句附目标语言翻译）；\n4. 高频场景：用目标语言说明该词最常见的语境或搭配场景。\n不要编造不存在的义项或音标，信息不确定时如实说明。";

/// System prompt for the picker's follow-up ("继续提问") question mode.
pub const FOLLOWUP_SYSTEM_PROMPT: &str = "你是 Lexora AI 助手的继续提问模式。用户先从应用中划选了一段文本，助手已经给出了回答，现在用户想基于这段文本和之前的回答继续提问。请用简体中文回答，聚焦用户当前的问题，可以使用 Markdown 排版；不要复述原文或之前的回答，除非用户明确要求。";

/// Maximum characters of one follow-up context block (原文/回答/问题/问答).
pub const FOLLOWUP_SEGMENT_MAX_CHARS: usize = 4_000;
/// Maximum number of previous Q/A turns included in a follow-up prompt.
pub const FOLLOWUP_HISTORY_MAX_TURNS: usize = 10;
/// Maximum total characters of the composed follow-up user message.
pub const FOLLOWUP_TOTAL_MAX_CHARS: usize = 20_000;

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

/// `true` when `text` is a single Latin word worth a dictionary lookup:
/// 1–40 characters, letters plus optional `'` / `-`, at least one letter.
/// Chinese text, multiple words, numbers and punctuation return `false`.
pub fn is_single_word(text: &str) -> bool {
    let trimmed = text.trim();
    if !(1..=40).contains(&trimmed.chars().count()) {
        return false;
    }
    let mut letters = 0usize;
    for character in trimmed.chars() {
        if character.is_ascii_alphabetic() {
            letters += 1;
        } else if character != '\'' && character != '-' {
            return false;
        }
    }
    letters > 0
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

/// Builds the chat messages for a `polish` request. A non-empty `custom_prompt`
/// replaces [`DEFAULT_POLISH_PROMPT`] completely.
pub fn polish_messages(text: &str, custom_prompt: &str) -> (String, String) {
    let custom_prompt = custom_prompt.trim();
    let system = if custom_prompt.is_empty() {
        DEFAULT_POLISH_PROMPT
    } else {
        custom_prompt
    };
    (system.to_string(), text.to_string())
}

/// Builds the chat messages for a single-word dictionary lookup. The word is
/// also the user message; the system prompt asks for a Markdown dictionary
/// entry (meanings, IPA, usage, common contexts).
pub fn dictionary_messages(word: &str, target_lang: &str) -> (String, String) {
    let target_name = language_name(target_lang);
    let code = target_lang.trim().to_ascii_lowercase();
    let keep_ipa = code.is_empty()
        || code == "yue"
        || code.starts_with("zh")
        || code == "en"
        || code.starts_with("en-");
    let template = if keep_ipa {
        DEFAULT_DICTIONARY_PROMPT
    } else {
        NON_IPA_DICTIONARY_PROMPT
    };
    (
        template.replace("{target}", &target_name),
        word.trim().to_string(),
    )
}

/// Translation entry point: single words become dictionary entries, everything
/// else uses [`translate_messages`]. Used by `EngineService::translate_stream`.
pub fn translate_or_dictionary_messages(
    text: &str,
    target_lang: &str,
    custom_prompt: &str,
) -> (String, String) {
    if is_single_word(text) {
        dictionary_messages(text, target_lang)
    } else {
        translate_messages(text, target_lang, custom_prompt)
    }
}

/// Explain entry point: `explain` on a single word becomes a dictionary entry
/// (custom explain prompts are ignored there), everything else keeps
/// [`assist_messages`]. Used by `EngineService::assist_stream`.
pub fn assist_or_dictionary_messages(
    action: &str,
    text: &str,
    custom_prompt: &str,
) -> Result<(String, String), EngineError> {
    let is_explain = matches!(
        action.trim().to_ascii_lowercase().as_str(),
        "explain" | "解释"
    );
    if is_explain && is_single_word(text) {
        return Ok(dictionary_messages(text, "zh"));
    }
    assist_messages(action, text, custom_prompt)
}

/// Builds the chat messages for a follow-up question about the original
/// selection and the previous AI answer.
///
/// The user message combines the original selection, the previous answer, up
/// to [`FOLLOWUP_HISTORY_MAX_TURNS`] earlier Q/A turns and the current
/// question. Every block is capped at [`FOLLOWUP_SEGMENT_MAX_CHARS`]; the
/// current question is always kept and older context is dropped first so the
/// whole message stays within [`FOLLOWUP_TOTAL_MAX_CHARS`].
pub fn followup_messages(
    text: &str,
    previous_answer: &str,
    question: &str,
    history: &[(String, String)],
) -> (String, String) {
    let selection = truncate_chars(text.trim(), FOLLOWUP_SEGMENT_MAX_CHARS);
    let previous = truncate_chars(previous_answer.trim(), FOLLOWUP_SEGMENT_MAX_CHARS);
    let current = truncate_chars(question.trim(), FOLLOWUP_SEGMENT_MAX_CHARS);

    let recent = if history.len() > FOLLOWUP_HISTORY_MAX_TURNS {
        &history[history.len() - FOLLOWUP_HISTORY_MAX_TURNS..]
    } else {
        history
    };
    let mut turns: Vec<String> = Vec::new();
    for (turn_question, turn_answer) in recent {
        turns.push(format!(
            "Q: {}\nA: {}",
            truncate_chars(turn_question.trim(), FOLLOWUP_SEGMENT_MAX_CHARS),
            truncate_chars(turn_answer.trim(), FOLLOWUP_SEGMENT_MAX_CHARS)
        ));
    }

    let mut prefix: Vec<String> = Vec::new();
    if !selection.is_empty() {
        prefix.push(format!("【用户选中的原文】\n{selection}"));
    }
    if !previous.is_empty() {
        prefix.push(format!("【之前的回答】\n{previous}"));
    }
    if !turns.is_empty() {
        prefix.push(format!("【历史问答】\n{}", turns.join("\n\n")));
    }

    // The current question is mandatory; prepend context newest-first until the
    // character budget is used up.
    let mut user = format!("【当前问题】\n{current}");
    for section in prefix.into_iter().rev() {
        let extra = section.chars().count() + 2; // "\n\n" separator
        if user.chars().count() + extra > FOLLOWUP_TOTAL_MAX_CHARS {
            break;
        }
        user = format!("{section}\n\n{user}");
    }
    (FOLLOWUP_SYSTEM_PROMPT.to_string(), user)
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
        "polish": DEFAULT_POLISH_PROMPT,
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
        assert!(DEFAULT_POLISH_PROMPT.starts_with("You are"));
        assert!(DEFAULT_POLISH_PROMPT.contains("professional editor"));

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
        let (polish, _) = polish_messages("text", "");
        assert_eq!(polish, DEFAULT_POLISH_PROMPT);
    }

    #[test]
    fn default_prompts_json_exposes_the_constants() {
        let defaults = default_prompts();
        assert_eq!(defaults["translate"], DEFAULT_TRANSLATE_PROMPT);
        assert_eq!(defaults["summarize"], DEFAULT_SUMMARIZE_PROMPT);
        assert_eq!(defaults["explain"], DEFAULT_EXPLAIN_PROMPT);
        assert_eq!(defaults["polish"], DEFAULT_POLISH_PROMPT);
        assert_eq!(defaults.as_object().unwrap().len(), 4);
    }

    #[test]
    fn polish_messages_use_default_or_custom_prompt() {
        let (system, user) = polish_messages("  hello  ", "");
        assert_eq!(system, DEFAULT_POLISH_PROMPT);
        assert_eq!(user, "  hello  ");

        let (system, user) = polish_messages("hello", "  Make it formal.  ");
        assert_eq!(system, "Make it formal.");
        assert_eq!(user, "hello");
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

    #[test]
    fn single_word_detection_covers_boundaries() {
        for word in [
            "hello",
            "a",
            "don't",
            "well-known",
            "rock'n'roll",
            "  hello  ",
            "cafe",
        ] {
            assert!(is_single_word(word), "should accept {word:?}");
        }
        let longest = "a".repeat(40);
        assert!(is_single_word(&longest));
        for not_word in [
            "",
            "   ",
            "hello world",
            "hello,world",
            "hello!",
            "hello.",
            "中文",
            "hello中文",
            "123",
            "hello123",
            "'",
            "-",
            "hello_world",
            "hello\nworld",
        ] {
            assert!(!is_single_word(not_word), "should reject {not_word:?}");
        }
        let too_long = "a".repeat(41);
        assert!(!is_single_word(&too_long));
    }

    #[test]
    fn dictionary_messages_follow_the_requested_target_language() {
        let (system, user) = dictionary_messages("  serendipity ", "zh");
        assert_eq!(
            system,
            DEFAULT_DICTIONARY_PROMPT.replace("{target}", "Simplified Chinese")
        );
        assert_eq!(user, "serendipity");
        for expected in ["词典", "释义", "音标", "用法", "场景", "Markdown"] {
            assert!(
                system.contains(expected),
                "dictionary prompt must mention {expected}"
            );
        }

        // The dictionary entry must be localized to the selected target
        // language instead of always being a Chinese/English entry.
        let (japanese, _) = dictionary_messages("minutes", "ja");
        assert!(japanese.contains("Japanese"));
        assert!(!japanese.contains("{target}"));
        assert!(japanese.contains("不要输出英语 IPA"));
        assert!(!japanese.contains("给出该词的英语 IPA"));
        assert!(japanese.contains("片假名"));
        let (english, _) = dictionary_messages("minutes", "en");
        assert!(english.contains("English"));
        assert!(english.contains("英语 IPA"));
    }

    #[test]
    fn single_words_use_the_dictionary_prompt() {
        let expected_zh = DEFAULT_DICTIONARY_PROMPT.replace("{target}", "Simplified Chinese");
        let (translated, user) = translate_or_dictionary_messages("hello", "zh", "custom");
        assert_eq!(translated, expected_zh);
        assert_eq!(user, "hello");

        let (translated_ja, _) = translate_or_dictionary_messages("hello", "ja", "custom");
        assert!(translated_ja.contains("Japanese"));
        assert!(!translated_ja.contains("{target}"));

        let (explained, _) =
            assist_or_dictionary_messages("explain", "hello", "custom explain").unwrap();
        assert_eq!(explained, expected_zh);
        let (explained_zh, _) = assist_or_dictionary_messages("解释", "hello", "").unwrap();
        assert_eq!(explained_zh, expected_zh);
    }

    #[test]
    fn multiple_words_keep_the_normal_prompts() {
        let (system, _) =
            translate_or_dictionary_messages("hello world", "zh", "Translate into {target}.");
        assert_eq!(system, "Translate into Simplified Chinese.");

        let (summarized, _) = assist_or_dictionary_messages("summarize", "hello", "").unwrap();
        assert_eq!(summarized, DEFAULT_SUMMARIZE_PROMPT);
        let (explained, _) = assist_or_dictionary_messages("explain", "hello world", "").unwrap();
        assert_eq!(explained, DEFAULT_EXPLAIN_PROMPT);
        let (custom, _) =
            assist_or_dictionary_messages("explain", "two words", "Be brief.").unwrap();
        assert_eq!(custom, "Be brief.");
    }

    #[test]
    fn followup_messages_combine_the_context_in_order() {
        let history = vec![
            ("第一问".to_string(), "第一答".to_string()),
            ("第二问".to_string(), "第二答".to_string()),
        ];
        let (system, user) = followup_messages("选中的原文", "上一轮回答", "为什么？", &history);
        assert_eq!(system, FOLLOWUP_SYSTEM_PROMPT);
        assert!(system.contains("简体中文"));
        assert!(system.contains("Markdown"));
        let positions = [
            user.find("【用户选中的原文】")
                .expect("original text block"),
            user.find("【之前的回答】").expect("previous answer block"),
            user.find("【历史问答】").expect("history block"),
            user.find("【当前问题】").expect("question block"),
        ];
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(user.contains("选中的原文"));
        assert!(user.contains("上一轮回答"));
        assert!(user.contains("第一问"));
        assert!(user.contains("第二答"));
        assert!(user.ends_with("为什么？"));
    }

    #[test]
    fn followup_omits_empty_context_blocks() {
        let (_, user) = followup_messages("", "", "只有问题", &[]);
        assert_eq!(user, "【当前问题】\n只有问题");
        let (_, user) = followup_messages("原文", "", "问题", &[]);
        assert!(!user.contains("【之前的回答】"));
        assert!(!user.contains("【历史问答】"));
    }

    #[test]
    fn followup_history_is_capped_to_the_last_ten_turns() {
        let history: Vec<(String, String)> = (0..15)
            .map(|index| (format!("问题{index}"), format!("回答{index}")))
            .collect();
        let (_, user) = followup_messages("原文", "", "当前", &history);
        assert_eq!(user.matches("Q: ").count(), FOLLOWUP_HISTORY_MAX_TURNS);
        assert!(!user.contains("问题4"), "older turns must be dropped");
        assert!(user.contains("问题5"));
        assert!(user.contains("问题14"));
    }

    #[test]
    fn followup_truncates_segments_and_keeps_within_the_total_budget() {
        // "字" never appears in the section labels, so it counts text only.
        let long_text = "字".repeat(5_000);
        let (_, user) = followup_messages(&long_text, "", "问题", &[]);
        assert_eq!(user.matches('字').count(), FOLLOWUP_SEGMENT_MAX_CHARS);
        assert!(user.ends_with("【当前问题】\n问题"));

        let long_history: Vec<(String, String)> = (0..10)
            .map(|index| (format!("问{index}"), "答".repeat(5_000)))
            .collect();
        let (_, user) =
            followup_messages(&long_text, &"回".repeat(5_000), "关键问题", &long_history);
        assert!(
            user.chars().count() <= FOLLOWUP_TOTAL_MAX_CHARS,
            "user message too long: {}",
            user.chars().count()
        );
        // The current question always survives the budget trimming.
        assert!(user.contains("关键问题"));
        assert!(user.contains("【当前问题】"));
    }

    #[test]
    fn followup_prompt_requires_chinese_markdown_and_no_repetition() {
        assert!(FOLLOWUP_SYSTEM_PROMPT.contains("简体中文"));
        assert!(FOLLOWUP_SYSTEM_PROMPT.contains("Markdown"));
        assert!(FOLLOWUP_SYSTEM_PROMPT.contains("不要复述"));
    }
}
