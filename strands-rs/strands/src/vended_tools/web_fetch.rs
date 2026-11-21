//! The `web_fetch` tool: fetches an HTTP(S) URL and returns its content as markdown, or answers a
//! prompt about it with an analyst agent so the page never enters the calling agent's context.

mod extract;

use std::sync::{Arc, LazyLock};

use regex::Regex;
use serde_json::json;

use super::http_request::LazyClient;
use super::input::InputReader;
use crate::agent::{Agent, InvocationContext, InvokeOptions};
use crate::cancel::CancelSignal;
use crate::error::{Error, Result};
use crate::models::Model;
use crate::tools::{FunctionTool, ToolContext, ToolError};
use crate::types::{ContentBlock, JsonSchema, JsonValue};

/// The charset parameter pattern. Only the ASCII `charset=` is matched case-insensitively.
static CHARSET: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r#"(?i-u:charset=)(?:"([^"]+)"|'([^']+)'|([^;\s]+))"#).ok());

/// The default cap on the response body, in bytes (`DEFAULT_MAX_BYTES`, 5 MiB).
pub(crate) const DEFAULT_MAX_BYTES: usize = 5 * 1024 * 1024;

/// The default cap on the extracted content, in characters (`DEFAULT_MAX_CONTENT_CHARS`).
pub(crate) const DEFAULT_MAX_CONTENT_CHARS: usize = 50_000;

/// The description of the markdown-mode tool (`WEB_FETCH_DESCRIPTION_MARKDOWN`).
pub(crate) const WEB_FETCH_DESCRIPTION_MARKDOWN: &str = concat!(
    "Fetches an HTTP(S) URL and returns its content as clean markdown. ",
    "HTML pages are converted to markdown with scripts, styles, and noise stripped; ",
    "other content types are returned as-is."
);

/// The description of the agentic-mode tool (`WEB_FETCH_DESCRIPTION_AGENTIC`).
pub(crate) const WEB_FETCH_DESCRIPTION_AGENTIC: &str = concat!(
    "Fetches an HTTP(S) URL and answers a prompt about its content. ",
    "The analyst processes the page directly so the full content never enters ",
    "the main agent's context. ",
    "The prompt parameter is required."
);

const USER_AGENT: &str = "strands-agents-web-fetch/1.0";
const ACCEPT: &str = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";
const TRUNCATED: &str = "\n\n[content truncated]";

const ANALYST_PROMPT: &str = concat!(
    "You answer a request about a single fetched web page. Use only the provided ",
    "content; if it does not contain the answer, say so plainly. Be concise and ",
    "factual, and preserve concrete details (names, numbers, quotes, links) ",
    "relevant to the request."
);

/// What the tool returns (`mode`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum WebFetchMode {
    /// The page as markdown (`'markdown'`).
    Markdown,
    /// An analyst agent's answer to `prompt` about the page (`'agentic'`).
    #[default]
    Agentic,
}

/// Options for [`make_web_fetch`] (`MakeWebFetchOptions`).
#[derive(Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakeWebFetchOptions {
    /// The tool name; `web_fetch` when absent.
    pub name: Option<String>,
    /// The tool description; the mode's description when absent.
    pub description: Option<String>,
    /// The largest response body read, in bytes; 5 MiB when absent.
    pub max_bytes: Option<usize>,
    /// The most characters of extracted content delivered (UTF-16 code units);
    /// 50,000 when absent.
    pub max_content_chars: Option<usize>,
    /// The analyst's model in agentic mode. When absent the calling agent's
    /// [`aux_model`](crate::ToolAgent::aux_model) is used, which is its model unless it set one.
    pub model: Option<Arc<dyn Model>>,
    /// What the tool returns; [`WebFetchMode::Agentic`] when absent.
    pub mode: Option<WebFetchMode>,
}

impl std::fmt::Debug for MakeWebFetchOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MakeWebFetchOptions")
            .field("name", &self.name)
            .field("max_bytes", &self.max_bytes)
            .field("max_content_chars", &self.max_content_chars)
            .field("model", &self.model.as_ref().map(|model| model.model_id()))
            .field("mode", &self.mode)
            .finish_non_exhaustive()
    }
}

fn input_schema(mode: WebFetchMode) -> JsonSchema {
    let url = json!({"type": "string", "description": "URL to fetch. Must be http:// or https://."});
    match mode {
        WebFetchMode::Markdown => json!({
            "type": "object",
            "properties": {"url": url},
            "required": ["url"],
            "additionalProperties": false
        }),
        WebFetchMode::Agentic => json!({
            "type": "object",
            "properties": {
                "url": url,
                "prompt": {"type": "string", "description": "Question or instruction about the page content."}
            },
            "required": ["url", "prompt"],
            "additionalProperties": false
        }),
    }
}

struct Settings {
    mode: WebFetchMode,
    max_bytes: usize,
    max_content_chars: usize,
    model: Option<Arc<dyn Model>>,
    client: LazyClient,
}

/// The default `web_fetch` tool, in agentic mode.
#[must_use]
pub fn web_fetch() -> FunctionTool {
    build(
        "web_fetch".to_owned(),
        WEB_FETCH_DESCRIPTION_AGENTIC.to_owned(),
        Settings {
            mode: WebFetchMode::Agentic,
            max_bytes: DEFAULT_MAX_BYTES,
            max_content_chars: DEFAULT_MAX_CONTENT_CHARS,
            model: None,
            client: LazyClient::default(),
        },
    )
}

/// Creates a web fetch tool.
///
/// The tool GETs `url` (http and https only), reads at most `max_bytes` of the body, decodes it
/// with the response charset, converts HTML and XML to markdown and truncates the result to
/// `max_content_chars`. In markdown mode that is the result; in agentic mode a fresh analyst
/// agent answers `prompt` from it. The request is cancelled with the call.
///
/// ```
/// use strands::vended_tools::web_fetch::{MakeWebFetchOptions, WebFetchMode, make_web_fetch};
///
/// let fetch = make_web_fetch(MakeWebFetchOptions::builder().mode(WebFetchMode::Markdown).build())?;
/// assert_eq!(strands::Tool::name(&fetch), "web_fetch");
/// # Ok::<(), strands::Error>(())
/// ```
///
/// # Errors
///
/// When `max_bytes` or `max_content_chars` is 0.
pub fn make_web_fetch(options: MakeWebFetchOptions) -> Result<FunctionTool> {
    make_web_fetch_with(options, LazyClient::default())
}

pub(crate) fn make_web_fetch_with(options: MakeWebFetchOptions, client: LazyClient) -> Result<FunctionTool> {
    let mode = options.mode.unwrap_or_default();
    let max_bytes = options.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    let max_content_chars = options.max_content_chars.unwrap_or(DEFAULT_MAX_CONTENT_CHARS);
    if max_bytes == 0 {
        return Err(Error::other("maxBytes must be a positive number, got 0"));
    }
    if max_content_chars == 0 {
        return Err(Error::other("maxContentChars must be a positive number, got 0"));
    }
    let description = options.description.unwrap_or_else(|| {
        match mode {
            WebFetchMode::Markdown => WEB_FETCH_DESCRIPTION_MARKDOWN,
            WebFetchMode::Agentic => WEB_FETCH_DESCRIPTION_AGENTIC,
        }
        .to_owned()
    });
    let name = options.name.unwrap_or_else(|| "web_fetch".to_owned());
    let settings = Settings {
        mode,
        max_bytes,
        max_content_chars,
        model: options.model,
        client,
    };
    Ok(build(name, description, settings))
}

fn build(name: String, description: String, settings: Settings) -> FunctionTool {
    let schema = input_schema(settings.mode);
    let settings = Arc::new(settings);
    FunctionTool::builder(name, description)
        .input_schema(schema)
        .callback(move |input, context| {
            let settings = settings.clone();
            async move { run(&settings, &input, &context).await.map(JsonValue::String) }
        })
}

async fn run(settings: &Settings, input: &JsonValue, context: &ToolContext) -> std::result::Result<String, ToolError> {
    let mut reader = InputReader::new(input);
    let url = reader.string("url");
    let prompt = match settings.mode {
        WebFetchMode::Agentic => reader.string("prompt"),
        WebFetchMode::Markdown => None,
    };
    reader.finish()?;
    let url = url.unwrap_or_default();
    let signal = context.cancel_signal();
    if settings.mode == WebFetchMode::Markdown {
        return page_content(settings, url, signal).await;
    }
    let prompt = prompt.unwrap_or_default();
    if prompt.trim().is_empty() {
        return Err(ToolError::msg("web_fetch: agentic mode requires a non-empty prompt."));
    }
    let model = settings
        .model
        .clone()
        .unwrap_or_else(|| context.agent().aux_model().clone());
    let content = page_content(settings, url, signal).await?;
    let options = InvokeOptions {
        cancel_signal: Some(signal.clone()),
        invocation_context: InvocationContext::auxiliary(context.invocation_context()),
        ..InvokeOptions::default()
    };
    let invoke_prompt = format!("URL: {url}\n\nRequest: {prompt}\n\n--- Content ---\n{content}");
    analyze(model, invoke_prompt, options)
        .await
        .map_err(|error| ToolError::msg(format!("url=<{url}> | web fetch analyst failed: {error}")))
}

/// Answers with a fresh analyst agent, so no history from one fetch reaches the next.
async fn analyze(model: Arc<dyn Model>, prompt: String, options: InvokeOptions) -> Result<String> {
    let mut analyst = Agent::builder()
        .model(model)
        .system_prompt(ANALYST_PROMPT)
        .printer(false)
        .build()?;
    let result = analyst.invoke_with(prompt, options).await?;
    Ok(result
        .last_message()
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect())
}

async fn page_content(settings: &Settings, url: &str, signal: &CancelSignal) -> std::result::Result<String, ToolError> {
    let (content_type, raw) = tokio::select! {
        fetched = fetch_once(&settings.client, url, settings.max_bytes) => fetched?,
        () = signal.cancelled() => return Err(ToolError::msg("Web fetch tool request cancelled")),
    };
    let content_type = content_type.to_lowercase();
    let content = if content_type.contains("html") || content_type.contains("xml") {
        extract::html_to_markdown(&raw)
    } else {
        raw
    };
    Ok(truncate(content, settings.max_content_chars))
}

/// Cuts `content` to `max_chars` UTF-16 code units, keeping whole characters, and marks the cut.
fn truncate(content: String, max_chars: usize) -> String {
    if content.encode_utf16().count() <= max_chars {
        return content;
    }
    let mut units = 0;
    let end = content
        .char_indices()
        .find(|(_, c)| {
            units += c.len_utf16();
            units > max_chars
        })
        .map_or(content.len(), |(index, _)| index);
    format!("{}{TRUNCATED}", &content[..end])
}

async fn fetch_once(
    client: &LazyClient,
    url: &str,
    max_bytes: usize,
) -> std::result::Result<(String, String), ToolError> {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return Err(ToolError::msg(format!("url=<{url}> | fetch failed: invalid URL")));
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ToolError::msg(format!(
            "url=<{url}> | fetch failed: only http and https URLs are supported"
        )));
    }
    let mut response = client
        .get()?
        .get(parsed)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::ACCEPT, ACCEPT)
        .send()
        .await
        .map_err(|error| ToolError::msg(format!("url=<{url}> | fetch failed: {error}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(ToolError::msg(format!(
            "HTTP {} {}: GET {url}",
            status.as_u16(),
            status.canonical_reason().unwrap_or_default()
        )));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .unwrap_or_default();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| ToolError::msg(format!("url=<{url}> | fetch failed: {error}")))?
    {
        if body.len() + chunk.len() > max_bytes {
            return Err(ToolError::msg(format!(
                "Response body exceeded max_bytes={max_bytes}. Refusing to buffer more."
            )));
        }
        body.extend_from_slice(&chunk);
    }
    let text = decode(&body, &charset(&content_type));
    Ok((content_type, text))
}

/// The `charset` parameter of a content type, lowercased; `utf-8` when absent.
fn charset(content_type: &str) -> String {
    CHARSET
        .as_ref()
        .and_then(|pattern| pattern.captures(content_type))
        .and_then(|captures| captures.get(1).or_else(|| captures.get(2)).or_else(|| captures.get(3)))
        .map_or_else(|| "utf-8".to_owned(), |value| value.as_str().to_lowercase())
}

/// The WHATWG labels of `windows-1252`, which also covers the Latin-1 and ASCII labels.
const WINDOWS_1252_LABELS: [&str; 17] = [
    "ansi_x3.4-1968",
    "ascii",
    "cp1252",
    "cp819",
    "csisolatin1",
    "ibm819",
    "iso-8859-1",
    "iso-ir-100",
    "iso8859-1",
    "iso88591",
    "iso_8859-1",
    "iso_8859-1:1987",
    "l1",
    "latin1",
    "us-ascii",
    "windows-1252",
    "x-cp1252",
];

/// The WHATWG labels of `UTF-16LE`.
const UTF_16LE_LABELS: [&str; 7] = [
    "csunicode",
    "iso-10646-ucs-2",
    "ucs-2",
    "unicode",
    "unicodefeff",
    "utf-16",
    "utf-16le",
];

/// The WHATWG labels of `UTF-16BE`.
const UTF_16BE_LABELS: [&str; 2] = ["unicodefffe", "utf-16be"];

/// The Windows-1252 characters of bytes 0x80 to 0x9F; the other bytes map to the same code point.
const WINDOWS_1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{81}', '\u{201A}', '\u{192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}', '\u{2C6}', '\u{2030}',
    '\u{160}', '\u{2039}', '\u{152}', '\u{8D}', '\u{17D}', '\u{8F}', '\u{90}', '\u{2018}', '\u{2019}', '\u{201C}',
    '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}', '\u{2DC}', '\u{2122}', '\u{161}', '\u{203A}', '\u{153}', '\u{9D}',
    '\u{17E}', '\u{178}',
];

/// Decodes the body as `TextDecoder(charset)`: UTF-8 (BOM dropped, invalid bytes as U+FFFD), the
/// WHATWG labels of UTF-16LE and UTF-16BE, and those of Windows-1252 (Latin-1 and ASCII
/// included). Other labels decode as UTF-8.
fn decode(bytes: &[u8], charset: &str) -> String {
    match charset {
        label if WINDOWS_1252_LABELS.contains(&label) => bytes
            .iter()
            .map(|&byte| match byte {
                0x80..=0x9F => WINDOWS_1252_HIGH[usize::from(byte - 0x80)],
                _ => char::from(byte),
            })
            .collect(),
        label if UTF_16LE_LABELS.contains(&label) || UTF_16BE_LABELS.contains(&label) => {
            let big_endian = UTF_16BE_LABELS.contains(&label);
            let units: Vec<u16> = bytes
                .chunks(2)
                .map(|pair| {
                    let pair = [pair[0], pair.get(1).copied().unwrap_or_default()];
                    if big_endian {
                        u16::from_be_bytes(pair)
                    } else {
                        u16::from_le_bytes(pair)
                    }
                })
                .collect();
            let text = String::from_utf16_lossy(&units);
            text.strip_prefix('\u{FEFF}').map(str::to_owned).unwrap_or(text)
        }
        _ => {
            let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
            String::from_utf8_lossy(bytes).into_owned()
        }
    }
}

#[cfg(test)]
mod tests;
