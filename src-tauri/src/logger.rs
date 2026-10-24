//! Minimal rolling file logger.
//!
//! The app runs without a console (``windows_subsystem = "windows"``), so all
//! diagnostics go to ``<data>/logs/main.log``. API keys are redacted before
//! anything is written.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone)]
pub struct Logger {
    file: Arc<Mutex<PathBuf>>,
}

impl Logger {
    pub fn new(logs_dir: &Path, name: &str) -> Self {
        let _ = fs::create_dir_all(logs_dir);
        Self {
            file: Arc::new(Mutex::new(logs_dir.join(format!("{name}.log")))),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.file.lock().map(|p| p.clone()).unwrap_or_default()
    }

    pub fn info(&self, message: &str) {
        self.write("INFO", message);
    }

    pub fn warn(&self, message: &str) {
        self.write("WARN", message);
    }

    pub fn error(&self, message: &str) {
        self.write("ERROR", message);
    }

    fn write(&self, level: &str, message: &str) {
        let Ok(path) = self.file.lock().map(|p| p.clone()) else {
            return;
        };
        let line = format!(
            "{}  {:5}  {}\n",
            timestamp(),
            level,
            redact_secrets(message)
        );
        if let Err(error) = append_rotating(&path, line.as_bytes()) {
            let _ = error;
        }
    }
}

fn append_rotating(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() > MAX_LOG_BYTES {
            let rotated = path.with_extension("log.1");
            let _ = fs::remove_file(&rotated);
            let _ = fs::rename(path, &rotated);
        }
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(bytes)
}

/// Hides API keys / bearer tokens before they reach the log file.
///
/// Tokens are separated on whitespace and common JSON/punctuation delimiters, so
/// `key=sk-...`, `"apiKey":"..."` and `Bearer abc...` are all caught while normal
/// log lines stay unchanged.
pub fn redact_secrets(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut token = String::new();
    for character in input.chars() {
        if character.is_whitespace()
            || matches!(
                character,
                '"' | ',' | ';' | '=' | ':' | '(' | ')' | '[' | ']'
            )
        {
            output.push_str(&redact_token(&token));
            token.clear();
            output.push(character);
        } else {
            token.push(character);
        }
    }
    output.push_str(&redact_token(&token));
    output
}

fn redact_token(token: &str) -> String {
    if token.len() <= 8 {
        return token.to_string();
    }
    let lowered = token.to_ascii_lowercase();
    let sensitive = lowered.starts_with("sk-")
        || lowered.starts_with("bearer")
        || lowered.contains("apikey")
        || lowered.contains("api_key")
        || lowered.contains("authorization");
    if sensitive {
        "***redacted***".to_string()
    } else {
        token.to_string()
    }
}

fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // Seconds are enough for a desktop tool; keep it dependency free.
    format!("{}.{:03}", now.as_secs(), now.subsec_millis())
}

#[cfg(test)]
mod tests {
    use super::redact_secrets;

    #[test]
    fn redacts_api_keys() {
        let text = "request to https://api.example.com key=sk-1234567890abcdef";
        let result = redact_secrets(text);
        assert!(result.contains("***redacted***"));
        assert!(!result.contains("sk-1234567890abcdef"));
    }

    #[test]
    fn keeps_normal_logs_intact() {
        let text = "translation finished in 120 ms";
        assert_eq!(redact_secrets(text), text);
    }
}
