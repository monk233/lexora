//! OpenAI-compatible HTTP helpers.
//!
//! This module is deliberately independent of Tauri and of the local engine
//! manager: it only knows how to normalize a base URL, decode an SSE stream,
//! build/execute a chat request and translate HTTP/network failures into
//! actionable Chinese `EngineError`s. That makes the tricky parts unit
//! testable without a network.
//!
//! Streaming uses byte accumulation: raw HTTP chunks are buffered and only
//! decoded once a full line is available, so a multi-byte UTF-8 character split
//! across two TCP packets is handled correctly.

use std::pin::Pin;
use std::time::Duration;

use futures_util::stream::{self, BoxStream, StreamExt};
use reqwest::header::CONTENT_TYPE;
use serde_json::{json, Value};

use crate::engine::EngineError;
use crate::logger::redact_secrets;

/// A resolved endpoint + credentials for one request.
#[derive(Debug, Clone)]
pub struct OnlineConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub timeout_ms: u64,
    pub temperature: f64,
    pub max_tokens: u32,
    /// `true` when talking to the bundled llama.cpp server (changes wording).
    pub local: bool,
}

impl OnlineConfig {
    pub fn is_configured(&self) -> bool {
        !self.base_url.trim().is_empty() && !self.model.trim().is_empty()
    }

    pub fn header_timeout(&self) -> Duration {
        Duration::from_millis(self.timeout_ms.clamp(2_000, 300_000))
    }
}

/// Normalizes a user supplied base URL.
///
/// Rules (mirrors how every OpenAI-compatible client behaves in practice):
/// * empty stays empty;
/// * a missing scheme gets `https://` (or `http://` for loopback hosts);
/// * trailing slashes are removed;
/// * a pasted `/chat/completions` or `/models` suffix is stripped;
/// * a bare host (`https://api.deepseek.com`) gets `/v1` appended;
/// * an explicit path (`https://host/api/openai`) is preserved.
pub fn normalize_base_url(input: &str) -> String {
    let mut value = input.trim().to_string();
    if value.is_empty() {
        return String::new();
    }
    // A pasted URL may carry query parameters (tokens) or a fragment; those are
    // not part of the API base path.
    if let Some(position) = value.find(['?', '#']) {
        value.truncate(position);
    }
    if value.is_empty() {
        return String::new();
    }
    if !value.contains("://") {
        let lowered = value.to_ascii_lowercase();
        let loopback = lowered.starts_with("localhost")
            || lowered.starts_with("127.")
            || lowered.starts_with("[::1]")
            || lowered.starts_with("0.0.0.0");
        value = format!("{}{}", if loopback { "http://" } else { "https://" }, value);
    }
    let Some((scheme, rest)) = value.split_once("://") else {
        return String::new();
    };
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    if authority.trim().is_empty() {
        return String::new();
    }
    let mut path = path.trim_end_matches('/').to_string();
    for suffix in ["/chat/completions", "/models"] {
        if let Some(stripped) = path.strip_suffix(suffix) {
            path = stripped.to_string();
            break;
        }
    }
    while path.ends_with("/v1/v1") {
        path.truncate(path.len() - 3);
    }
    if path.trim_matches('/').is_empty() {
        path = "/v1".to_string();
    }
    format!("{scheme}://{authority}{path}")
}

/// `POST <base>/chat/completions`.
pub fn chat_url(base_url: &str) -> String {
    format!("{}/chat/completions", normalize_base_url(base_url))
}

/// `GET <base>/models`.
pub fn models_url(base_url: &str) -> String {
    format!("{}/models", normalize_base_url(base_url))
}

// --------------------------------------------------------------------------- //
// SSE decoding
// --------------------------------------------------------------------------- //

/// One decoded piece of an SSE response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseItem {
    /// Incremental assistant text.
    Text(String),
    /// `data: [DONE]` marker.
    Done,
}

const MAX_RAW_FALLBACK_BYTES: usize = 8 * 1024 * 1024;

/// Incremental Server-Sent-Events decoder.
///
/// Bytes are buffered until a complete line is available; only then is UTF-8
/// decoding attempted, which makes packet boundaries irrelevant. A whole-body
/// JSON response (some proxies strip the `text/event-stream` content type) is
/// supported through [`SseDecoder::finish`].
#[derive(Debug, Default)]
pub struct SseDecoder {
    buffer: Vec<u8>,
    /// Raw bytes kept until the first text chunk, for non-SSE JSON fallback.
    raw: Vec<u8>,
    raw_capped: bool,
    seen_text: bool,
    done: bool,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds one HTTP body chunk and returns all complete events it produced.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseItem> {
        if chunk.is_empty() {
            return Vec::new();
        }
        if !self.seen_text && !self.raw_capped {
            self.raw.extend_from_slice(chunk);
            if self.raw.len() > MAX_RAW_FALLBACK_BYTES {
                self.raw.truncate(MAX_RAW_FALLBACK_BYTES);
                self.raw_capped = true;
            }
        }
        self.buffer.extend_from_slice(chunk);
        let mut items = Vec::new();
        while let Some(index) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=index).collect();
            self.process_line(&line[..line.len() - 1], &mut items);
        }
        items
    }

    /// Flushes the final partial line and, if nothing was decoded as SSE,
    /// retries the whole accumulated body as a single JSON document.
    pub fn finish(&mut self) -> Vec<SseItem> {
        let mut items = Vec::new();
        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
            self.process_line(&line, &mut items);
        }
        if !self.seen_text && !self.raw.is_empty() && !self.raw_capped {
            if let Ok(value) = serde_json::from_slice::<Value>(&self.raw) {
                if let Some(content) = extract_completion_text(&value) {
                    if !content.is_empty() {
                        self.seen_text = true;
                        items.push(SseItem::Text(content));
                    }
                }
            }
        }
        items
    }

    /// `true` once a `[DONE]` marker was seen.
    pub fn is_done(&self) -> bool {
        self.done
    }

    fn process_line(&mut self, line: &[u8], items: &mut Vec<SseItem>) {
        let decoded = String::from_utf8_lossy(line);
        let mut text = decoded.trim_end_matches('\r').trim();
        if text.is_empty() || text.starts_with(':') {
            return;
        }
        if let Some(rest) = text.strip_prefix("data:") {
            text = rest.trim_start();
        } else if text.starts_with("event:")
            || text.starts_with("id:")
            || text.starts_with("retry:")
        {
            // Named event / retry hints do not carry the payload we need.
            return;
        }
        if text.is_empty() {
            return;
        }
        if text == "[DONE]" || text == "DONE" {
            self.done = true;
            items.push(SseItem::Done);
            return;
        }
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            if let Some(content) = extract_content(&value) {
                if !content.is_empty() {
                    self.seen_text = true;
                    self.raw.clear();
                    items.push(SseItem::Text(content));
                }
            }
        }
    }
}

/// Extracts `choices[0].delta.content` (streaming) or a non-streaming message.
pub fn extract_content(value: &Value) -> Option<String> {
    let choices = value.get("choices")?.as_array()?;
    for choice in choices {
        if let Some(content) = choice.pointer("/delta/content").and_then(Value::as_str) {
            return Some(content.to_string());
        }
        if let Some(content) = choice.pointer("/message/content").and_then(Value::as_str) {
            return Some(content.to_string());
        }
        if let Some(content) = choice.get("text").and_then(Value::as_str) {
            return Some(content.to_string());
        }
    }
    None
}

/// Extracts the final assistant text from a non-streaming completion payload.
pub fn extract_completion_text(value: &Value) -> Option<String> {
    if let Some(choices) = value.get("choices").and_then(Value::as_array) {
        for choice in choices {
            if let Some(content) = choice.pointer("/message/content").and_then(Value::as_str) {
                return Some(content.to_string());
            }
            if let Some(content) = choice.pointer("/delta/content").and_then(Value::as_str) {
                return Some(content.to_string());
            }
            if let Some(content) = choice.get("text").and_then(Value::as_str) {
                return Some(content.to_string());
            }
        }
    }
    // Ollama's native generate response (not used for chat, but cheap to accept).
    value
        .get("response")
        .and_then(Value::as_str)
        .map(str::to_string)
}

// --------------------------------------------------------------------------- //
// Error mapping
// --------------------------------------------------------------------------- //

fn label(local: bool) -> &'static str {
    if local {
        "本地引擎"
    } else {
        "在线服务"
    }
}

/// Collapses and truncates a response body so it can be shown in a hint.
pub fn snippet(body: &str, max_chars: usize) -> String {
    let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return String::new();
    }
    let redacted = redact_secrets(&collapsed);
    let mut truncated: String = redacted.chars().take(max_chars).collect();
    if redacted.chars().count() > max_chars {
        truncated.push('…');
    }
    truncated
}

fn with_snippet(mut error: EngineError, body: &str) -> EngineError {
    let detail = snippet(body, 160);
    if !detail.is_empty() {
        if !error.hint.is_empty() {
            error.hint.push(' ');
        }
        error.hint.push_str(&format!("服务返回：{detail}"));
    }
    error
}

/// Maps a non-success HTTP status to a user facing Chinese error.
pub fn map_http_status(status: u16, body: &str, local: bool) -> EngineError {
    let who = label(local);
    let error = match status {
        400 => EngineError::new(
            format!("{who}拒绝了请求（HTTP 400）。"),
            "可能是模型名、请求参数或上下文长度不被支持，请检查模型名后重试。",
        ),
        401 => EngineError::new(
            format!("{who}认证失败（HTTP 401）。"),
            "请检查 API Key 是否正确、是否已过期，可在「设置 → 翻译服务」中重新填写。",
        ),
        403 => EngineError::new(
            format!("{who}拒绝访问（HTTP 403）。"),
            "API Key 没有调用权限或账户被限制，请到服务商控制台检查配额与权限。",
        ),
        404 => EngineError::new(
            format!("{who}接口或模型不存在（HTTP 404）。"),
            "请检查服务地址（通常以 /v1 结尾）以及模型名是否正确。",
        ),
        408 => EngineError::new(
            format!("{who}响应超时（HTTP 408）。"),
            "请检查网络连接，或在设置中适当增大超时时间后重试。",
        ),
        413 => EngineError::new(
            format!("{who}拒绝了过大的请求（HTTP 413）。"),
            "选中文本过长，请减少内容后重试，或使用上下文更大的模型。",
        ),
        429 => EngineError::new(
            format!("{who}请求过于频繁或额度不足（HTTP 429）。"),
            "请稍后重试，并检查账户余额与速率限制。",
        ),
        500..=599 => EngineError::new(
            format!("{who}暂时不可用（HTTP {status}）。"),
            "服务商临时故障，请稍后重试；本地引擎可查看 logs/llama.log 排查。",
        ),
        _ => EngineError::new(
            format!("{who}返回错误（HTTP {status}）。"),
            "请重试；若持续失败，请检查服务地址、网络代理与日志。",
        ),
    };
    with_snippet(error, body)
}

/// Maps transport failures (timeout / connect / bad URL) to Chinese errors.
pub fn map_reqwest_error(error: reqwest::Error, local: bool) -> EngineError {
    let who = label(local);
    if error.is_timeout() {
        return EngineError::new(
            format!("{who}请求超时。"),
            "网络较慢或服务无响应：请检查网络与代理，或在设置中增大超时时间。",
        );
    }
    if error.is_connect() {
        return EngineError::new(
            format!("无法连接到{who}。"),
            "请检查网络、代理和防火墙设置，以及服务地址是否正确；本地模式请先启动本地引擎。",
        );
    }
    if error.is_builder() {
        return EngineError::new(
            "服务地址格式无效。",
            "请填写完整的 http(s) 地址，例如 https://api.deepseek.com/v1。",
        );
    }
    if error.is_request() {
        return EngineError::new(
            format!("{who}请求发送失败。"),
            "请检查服务地址是否为有效的 http(s) 地址，以及网络是否可用。",
        );
    }
    if error.is_body() {
        return EngineError::new(
            format!("读取{who}响应失败。"),
            "连接可能中断，请重试；若持续失败请检查网络代理。",
        );
    }
    let detail = snippet(&error.to_string(), 120);
    EngineError::new(
        format!("{who}请求失败。"),
        format!("请检查网络与服务地址后重试。详细信息：{detail}"),
    )
}

// --------------------------------------------------------------------------- //
// Requests
// --------------------------------------------------------------------------- //

fn build_headers(request: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
    let key = api_key.trim();
    if key.is_empty() {
        request
    } else {
        request.bearer_auth(key)
    }
}

fn chat_payload(
    config: &OnlineConfig,
    messages: Vec<Value>,
    stream: bool,
    max_tokens: u32,
) -> Value {
    json!({
        "model": if config.model.trim().is_empty() { "local" } else { config.model.trim() },
        "messages": messages,
        "stream": stream,
        "temperature": config.temperature.clamp(0.0, 2.0),
        "max_tokens": max_tokens.clamp(1, 32_768),
    })
}

/// Non-streaming chat request used by `assist` and the connection test.
pub async fn chat_completion(
    http: &reqwest::Client,
    config: &OnlineConfig,
    messages: Vec<Value>,
    max_tokens: u32,
    timeout: Duration,
) -> Result<String, EngineError> {
    if !config.is_configured() {
        return Err(EngineError::new(
            "服务尚未配置完整。",
            "请填写服务地址和模型名后重试。",
        ));
    }
    let request = http
        .post(chat_url(&config.base_url))
        .timeout(timeout)
        .json(&chat_payload(config, messages, false, max_tokens));
    let response = build_headers(request, &config.api_key)
        .send()
        .await
        .map_err(|error| map_reqwest_error(error, config.local))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(map_http_status(status.as_u16(), &body, config.local));
    }
    let body = response
        .text()
        .await
        .map_err(|error| map_reqwest_error(error, config.local))?;
    let value: Value = serde_json::from_str(&body).map_err(|_| {
        EngineError::new(
            "服务返回了无法解析的内容。",
            format!(
                "请确认服务地址指向 OpenAI 兼容接口（…/v1/chat/completions）。返回片段：{}",
                snippet(&body, 200)
            ),
        )
    })?;
    let content = extract_completion_text(&value).ok_or_else(|| {
        EngineError::new(
            "服务返回的结果缺少文本内容。",
            format!(
                "可能是模型名不被支持或服务返回了错误结构。返回片段：{}",
                snippet(&body, 200)
            ),
        )
    })?;
    Ok(content.trim().to_string())
}

/// Fetches the model id list from `<base>/models`.
pub async fn list_models(
    http: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    timeout: Duration,
) -> Result<Vec<String>, EngineError> {
    let base = normalize_base_url(base_url);
    if base.is_empty() {
        return Err(EngineError::new(
            "服务地址不能为空。",
            "请填写完整的 http(s) 地址，例如 https://api.deepseek.com/v1。",
        ));
    }
    let request = http.get(models_url(&base)).timeout(timeout);
    let response = build_headers(request, api_key)
        .send()
        .await
        .map_err(|error| map_reqwest_error(error, false))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(map_http_status(status.as_u16(), &body, false));
    }
    let body = response
        .text()
        .await
        .map_err(|error| map_reqwest_error(error, false))?;
    let value: Value = serde_json::from_str(&body).map_err(|_| {
        EngineError::new(
            "模型列表不是有效的 JSON。",
            format!(
                "请确认服务地址（通常以 /v1 结尾）。返回片段：{}",
                snippet(&body, 200)
            ),
        )
    })?;
    let mut models: Vec<String> = Vec::new();
    let items = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.as_array());
    if let Some(items) = items {
        for item in items {
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| item.get("name").and_then(Value::as_str))
                .or_else(|| item.as_str())
                .map(str::trim)
                .unwrap_or_default();
            if !id.is_empty() && !models.iter().any(|existing| existing == id) {
                models.push(id.to_string());
            }
        }
    }
    models.sort_by_key(|model| model.to_ascii_lowercase());
    Ok(models)
}

/// Streaming chat request. Returns incremental text pieces.
///
/// Cancellation is achieved by dropping the returned stream (`reqwest` closes
/// the connection); the shell additionally aborts the consuming task.
pub async fn stream_chat(
    http: &reqwest::Client,
    config: &OnlineConfig,
    messages: Vec<Value>,
    header_timeout: Duration,
) -> Result<BoxStream<'static, Result<String, EngineError>>, EngineError> {
    if !config.is_configured() {
        return Err(EngineError::new(
            "服务尚未配置完整。",
            "请填写服务地址和模型名后重试。",
        ));
    }
    let request = http.post(chat_url(&config.base_url)).json(&chat_payload(
        config,
        messages,
        true,
        config.max_tokens,
    ));
    let response = match tokio::time::timeout(
        header_timeout,
        build_headers(request, &config.api_key).send(),
    )
    .await
    {
        Err(_) => {
            return Err(EngineError::new(
                format!("{}响应超时。", label(config.local)),
                format!(
                    "超过 {} 秒没有收到响应：请检查网络，或在设置中增大超时时间。",
                    header_timeout.as_secs()
                ),
            ))
        }
        Ok(Err(error)) => return Err(map_reqwest_error(error, config.local)),
        Ok(Ok(response)) => response,
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(map_http_status(status.as_u16(), &body, config.local));
    }

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    let is_sse = content_type.contains("text/event-stream");

    if !is_sse {
        // Fall back to a buffered body: either a plain JSON completion, or an
        // SSE payload served with the wrong content type.
        let body = response
            .text()
            .await
            .map_err(|error| map_reqwest_error(error, config.local))?;
        if let Ok(value) = serde_json::from_str::<Value>(body.trim()) {
            if let Some(content) = extract_completion_text(&value) {
                if !content.trim().is_empty() {
                    let text = content.trim().to_string();
                    return Ok(stream::once(async move { Ok::<String, EngineError>(text) }).boxed());
                }
            }
        }
        let mut decoder = SseDecoder::new();
        let mut pieces: Vec<String> = Vec::new();
        for item in decoder.push(body.as_bytes()) {
            if let SseItem::Text(text) = item {
                pieces.push(text);
            }
        }
        for item in decoder.finish() {
            if let SseItem::Text(text) = item {
                pieces.push(text);
            }
        }
        let joined = pieces.concat();
        if joined.trim().is_empty() {
            return Err(EngineError::new(
                "服务返回了无法解析的内容。",
                format!(
                    "请确认服务地址指向 OpenAI 兼容接口（…/v1/chat/completions）。返回片段：{}",
                    snippet(&body, 200)
                ),
            ));
        }
        let text = joined.trim().to_string();
        return Ok(stream::once(async move { Ok::<String, EngineError>(text) }).boxed());
    }

    Ok(sse_stream(response.bytes_stream().boxed(), config.local))
}

/// State of the incremental SSE stream.
struct SseStreamState<S> {
    body: Pin<Box<S>>,
    decoder: SseDecoder,
    finished: bool,
    emitted: bool,
}

/// Builds the incremental stream for an SSE body. Generic over the body item so
/// the `bytes::Bytes` type never has to be named (it is not a direct dep).
fn sse_stream<S, B>(body: S, local: bool) -> BoxStream<'static, Result<String, EngineError>>
where
    S: futures_util::Stream<Item = reqwest::Result<B>> + Send + 'static,
    B: AsRef<[u8]> + 'static,
{
    let state = SseStreamState {
        body: Box::pin(body),
        decoder: SseDecoder::new(),
        finished: false,
        emitted: false,
    };
    stream::unfold(state, move |mut state| async move {
        if state.finished {
            return None;
        }
        loop {
            if state.decoder.is_done() {
                return None;
            }
            match state.body.next().await {
                Some(Ok(bytes)) => {
                    let mut text = String::new();
                    for item in state.decoder.push(bytes.as_ref()) {
                        if let SseItem::Text(piece) = item {
                            text.push_str(&piece);
                        }
                    }
                    if !text.is_empty() {
                        state.emitted = true;
                        return Some((Ok(text), state));
                    }
                    if state.decoder.is_done() {
                        return None;
                    }
                }
                Some(Err(error)) => {
                    state.finished = true;
                    return Some((Err(map_reqwest_error(error, local)), state));
                }
                None => {
                    state.finished = true;
                    let mut text = String::new();
                    for item in state.decoder.finish() {
                        if let SseItem::Text(piece) = item {
                            text.push_str(&piece);
                        }
                    }
                    if !text.is_empty() {
                        state.emitted = true;
                        return Some((Ok(text), state));
                    }
                    if !state.emitted {
                        // Empty but successful response: report it instead of
                        // silently finishing with no output.
                        return Some((
                            Err(EngineError::new(
                                "服务返回了空结果。",
                                "模型没有输出任何内容：请重试，或检查模型名是否可用。",
                            )),
                            state,
                        ));
                    }
                    return None;
                }
            }
        }
    })
    .boxed()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(decoder: &mut SseDecoder, chunks: &[&[u8]]) -> String {
        let mut text = String::new();
        for chunk in chunks {
            for item in decoder.push(chunk) {
                if let SseItem::Text(piece) = item {
                    text.push_str(&piece);
                }
            }
        }
        for item in decoder.finish() {
            if let SseItem::Text(piece) = item {
                text.push_str(&piece);
            }
        }
        text
    }

    #[test]
    fn normalizes_base_urls() {
        assert_eq!(
            normalize_base_url("https://api.deepseek.com"),
            "https://api.deepseek.com/v1"
        );
        assert_eq!(
            normalize_base_url("https://api.deepseek.com/"),
            "https://api.deepseek.com/v1"
        );
        assert_eq!(
            normalize_base_url("https://api.deepseek.com/v1/"),
            "https://api.deepseek.com/v1"
        );
        assert_eq!(
            normalize_base_url("https://api.deepseek.com/v1/chat/completions"),
            "https://api.deepseek.com/v1"
        );
        assert_eq!(
            normalize_base_url("https://api.deepseek.com/v1/models"),
            "https://api.deepseek.com/v1"
        );
        assert_eq!(
            normalize_base_url("http://127.0.0.1:1234"),
            "http://127.0.0.1:1234/v1"
        );
        assert_eq!(
            normalize_base_url("localhost:11434/v1"),
            "http://localhost:11434/v1"
        );
        assert_eq!(
            normalize_base_url("api.example.com/api/openai"),
            "https://api.example.com/api/openai"
        );
        assert_eq!(normalize_base_url(""), "");
        assert_eq!(normalize_base_url("   "), "");
        assert_eq!(
            normalize_base_url("https://api.example.com/v1/v1"),
            "https://api.example.com/v1"
        );
        assert_eq!(
            normalize_base_url("https://api.example.com/v1?token=abc"),
            "https://api.example.com/v1"
        );
        assert_eq!(normalize_base_url("?token=abc"), "");
    }

    #[test]
    fn builds_endpoint_urls() {
        assert_eq!(
            chat_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            models_url("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/models"
        );
        assert_eq!(
            chat_url("http://127.0.0.1:8080/v1"),
            "http://127.0.0.1:8080/v1/chat/completions"
        );
    }

    #[test]
    fn decodes_sse_events() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n",
            ": keep-alive\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let mut decoder = SseDecoder::new();
        assert_eq!(collect(&mut decoder, &[body.as_bytes()]), "你好");
        assert!(decoder.is_done());
    }

    #[test]
    fn decodes_utf8_split_across_chunks() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"你好世界\"}}]}\n\n"
            .as_bytes()
            .to_vec();
        // Split at every possible byte boundary: each run must decode the same.
        for split in 0..=body.len() {
            let mut decoder = SseDecoder::new();
            let text = collect(&mut decoder, &[&body[..split], &body[split..]]);
            assert_eq!(text, "你好世界", "split at byte {split}");
        }
    }

    #[test]
    fn decodes_multiple_events_per_chunk_and_partial_lines() {
        let first =
            b"data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\ndata: {\"choices\":[{\"del";
        let rest = b"ta\":{\"content\":\"B\"}}]}\n\n";
        let mut decoder = SseDecoder::new();
        let mut text = String::new();
        for item in decoder.push(first) {
            if let SseItem::Text(piece) = item {
                text.push_str(&piece);
            }
        }
        for item in decoder.push(rest) {
            if let SseItem::Text(piece) = item {
                text.push_str(&piece);
            }
        }
        assert_eq!(text, "AB");
    }

    #[test]
    fn decodes_line_without_trailing_newline() {
        let body: &[u8] = b"data: {\"choices\":[{\"delta\":{\"content\":\"tail\"}}]}";
        let mut decoder = SseDecoder::new();
        assert_eq!(collect(&mut decoder, &[body]), "tail");
    }

    #[test]
    fn falls_back_to_whole_json_body() {
        // JSON \u escapes keep the literal ASCII while still exercising CJK
        // content after decoding.
        let body: &[u8] =
            br#"{"id":"x","choices":[{"index":0,"message":{"role":"assistant","content":"\u5b8c\u6574\u8bd1\u6587"}}]}"#;
        let mut decoder = SseDecoder::new();
        assert_eq!(collect(&mut decoder, &[body]), "完整译文");
    }

    #[test]
    fn ignores_malformed_and_empty_lines() {
        let body = "\n\ndata: not-json\n\n: comment\nevent: ping\ndata: \n\n";
        let mut decoder = SseDecoder::new();
        assert_eq!(collect(&mut decoder, &[body.as_bytes()]), "");
        assert!(!decoder.is_done());
    }

    #[test]
    fn extracts_content_variants() {
        let streaming = json!({"choices":[{"delta":{"content":"流式"}}]});
        assert_eq!(extract_content(&streaming).as_deref(), Some("流式"));
        let final_message = json!({"choices":[{"message":{"content":"非流式"}}]});
        assert_eq!(extract_content(&final_message).as_deref(), Some("非流式"));
        assert_eq!(
            extract_completion_text(&final_message).as_deref(),
            Some("非流式")
        );
        assert_eq!(extract_content(&json!({"choices":[]})), None);
        assert_eq!(extract_content(&json!({"error":"x"})), None);
        assert_eq!(
            extract_completion_text(&json!({"response":"ollama"})).as_deref(),
            Some("ollama")
        );
    }

    #[test]
    fn maps_http_status_codes_to_actionable_errors() {
        let cases = [
            (400u16, "HTTP 400"),
            (401, "HTTP 401"),
            (403, "HTTP 403"),
            (404, "HTTP 404"),
            (408, "HTTP 408"),
            (429, "HTTP 429"),
            (500, "HTTP 500"),
            (502, "HTTP 502"),
            (418, "HTTP 418"),
        ];
        for (status, needle) in cases {
            let error = map_http_status(status, "", false);
            assert!(
                error.message.contains(needle),
                "status {status}: {}",
                error.message
            );
            assert!(!error.hint.is_empty(), "missing hint for status {status}");
        }
        let auth = map_http_status(401, "{\"error\":\"bad key\"}", false);
        assert!(auth.hint.contains("API Key"));
        assert!(auth.hint.contains("服务返回"));
        let local = map_http_status(500, "", true);
        assert!(local.message.contains("本地引擎"));
        assert!(local.hint.contains("llama.log"));
    }

    #[test]
    fn snippet_is_bounded_and_redacts_keys() {
        let long = "x".repeat(500);
        assert!(snippet(&long, 20).chars().count() <= 21);
        let key_text = "Authorization: Bearer sk-1234567890abcdef";
        let redacted = snippet(key_text, 160);
        assert!(!redacted.contains("sk-1234567890abcdef"));
    }

    #[test]
    fn config_reports_configured_state() {
        let config = OnlineConfig {
            base_url: " https://api.deepseek.com ".to_string(),
            api_key: String::new(),
            model: "deepseek-chat".to_string(),
            timeout_ms: 60_000,
            temperature: 0.2,
            max_tokens: 1024,
            local: false,
        };
        assert!(config.is_configured());
        assert_eq!(config.header_timeout(), Duration::from_secs(60));
        let empty = OnlineConfig {
            base_url: String::new(),
            ..config
        };
        assert!(!empty.is_configured());
    }
}
