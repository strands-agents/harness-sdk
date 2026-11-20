//! `web_fetch`: fetch a URL and answer a prompt about its content.
//!
//! The tool fetches the URL, reduces it to text, and asks a small fast summarizer model to answer
//! the prompt over that content, so large pages never reach the main agent's context. By default
//! the request runs as `curl` inside the agent's sandbox (the same seam `shell` and the file tools
//! use), so a sandbox with network isolation or egress rules covers `web_fetch` too;
//! [`WebFetchTransport::Direct`] fetches from the harness process instead. Fetched pages are
//! cached per tool for 15 minutes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use base64::Engine;
use futures::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use strands::models::Model;
use strands::sandbox::{ExecuteOptions, Sandbox, shell_quote};
use strands::tools::{FunctionTool, ToolContext, ToolError};
use strands::types::{JsonSchema, JsonValue};
use strands::{Agent, ModelSource};
use tokio::time::Instant;

use crate::sandbox::{SandboxShell, shell_of};

/// The `User-Agent` of every request.
pub(crate) const USER_AGENT: &str = "strands-harness/1.0";
const TIMEOUT_SECONDS: u64 = 30;
/// The most bytes read from a response body.
pub(crate) const MAX_BYTES: usize = 5 * 1024 * 1024;
/// The most characters of page text kept.
pub(crate) const MAX_CHARS: usize = 50_000;
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);

const SUMMARIZER_PROMPT: &str = concat!(
    "You answer a request about a single fetched web page. Use only the provided content; if it ",
    "does not contain the answer, say so plainly. Be concise and factual, and preserve concrete ",
    "details (names, numbers, quotes, links) relevant to the request."
);

/// The `web_fetch` tool description.
pub(crate) const WEB_FETCH_DESCRIPTION: &str = concat!(
    "Fetch a URL and answer a prompt about its content. Performs an HTTP GET, reduces the ",
    "response to text, and asks a small fast model to answer the prompt using only that content, ",
    "returning the answer rather than the raw page so large pages do not flood the conversation. ",
    "Fetched content is cached for 15 minutes, so repeated fetches of the same URL are fast while ",
    "each prompt is answered fresh."
);

/// How `web_fetch` makes its request (`WebFetchTransport`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum WebFetchTransport {
    /// `curl` inside the agent's sandbox, so the sandbox's network controls apply (the default).
    #[default]
    Curl,
    /// An HTTP client in the harness process, bypassing the sandbox.
    Direct,
}

/// Per-tool config for the `web_fetch` built-in (`WebFetchConfig`).
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct WebFetchConfig {
    /// The model the summarizer runs on: a model instance, a router (its default model is used)
    /// or a `"provider/name"` string. A string is resolved by the harness (`resolve_web_fetch_model`)
    /// before the tool is built; with none the harness picks the small fast model for the main
    /// agent's provider.
    #[builder(into)]
    pub model: Option<ModelSource>,
    /// [`WebFetchTransport::Curl`] (the default) or [`WebFetchTransport::Direct`].
    pub transport: Option<WebFetchTransport>,
}

fn input_schema() -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "The http(s) URL to fetch."},
            "prompt": {
                "description": "What to extract from or answer about the fetched content. Leave empty to get the whole page content back verbatim instead of a model-generated answer.",
                "type": "string"
            }
        },
        "required": ["url"],
        "additionalProperties": false
    })
}

/// A fetched page: the final URL after redirects and the page text.
#[derive(Debug, Clone)]
struct Fetched {
    resolved_url: String,
    text: String,
}

struct Cached {
    expires: Instant,
    page: Fetched,
}

struct Inner {
    summarizer: Option<Arc<dyn Model>>,
    transport: WebFetchTransport,
    cache: Mutex<HashMap<String, Cached>>,
    client: reqwest::Client,
    patterns: Patterns,
}

struct Patterns {
    url_chars: Regex,
    authority: Regex,
    script: Regex,
    style: Regex,
    tag: Regex,
    blanks: Regex,
    paragraphs: Regex,
    charset: Regex,
}

impl Patterns {
    fn new() -> Result<Self, regex::Error> {
        Ok(Self {
            url_chars: Regex::new(r"^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$")?,
            authority: Regex::new(r"(?i)^https?://[^/?#]")?,
            script: Regex::new(r"(?i)<script\b[^>]*>[\s\S]*?</script>")?,
            style: Regex::new(r"(?i)<style\b[^>]*>[\s\S]*?</style>")?,
            tag: Regex::new(r"<[^>]+>")?,
            blanks: Regex::new(r"[ \t]+")?,
            paragraphs: Regex::new(r"\n\s*\n\s*\n+")?,
            charset: Regex::new(r#"(?i)charset=["']?([\w.-]+)"#)?,
        })
    }

    fn html_to_text(&self, html: &str) -> String {
        let text = self.script.replace_all(html, " ");
        let text = self.style.replace_all(&text, " ");
        let text = self.tag.replace_all(&text, " ");
        let text = self.blanks.replace_all(&text, " ");
        self.paragraphs.replace_all(&text, "\n\n").trim().to_owned()
    }

    /// The trimmed `url`, or the error unless it is a well-formed http(s) URL.
    fn validate_url(&self, url: &str) -> Result<String, String> {
        let url = url.trim();
        if !self.url_chars.is_match(url) {
            return Err("web_fetch URLs may only contain the characters RFC 3986 allows; percent-encode spaces and non-ASCII characters (and punycode the host) and retry.".to_owned());
        }
        let quoted = JsonValue::from(url).to_string();
        let parsed = reqwest::Url::parse(url).map_err(|_| format!("web_fetch could not parse the URL {quoted}."))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(format!("web_fetch only supports http(s) URLs, got {quoted}."));
        }
        let has_host = parsed.host_str().is_some_and(|host| !host.is_empty());
        if !has_host || !self.authority.is_match(url) {
            return Err(format!("web_fetch URL has no host: {quoted}."));
        }
        Ok(url.to_owned())
    }

    /// Decodes with the response's charset, falling back to UTF-8 for an unknown one, as the
    /// WHATWG `TextDecoder` does.
    fn decode(&self, data: &[u8], content_type: &str) -> String {
        let encoding = self
            .charset
            .captures(content_type)
            .and_then(|captures| captures.get(1))
            .and_then(|label| encoding_rs::Encoding::for_label(label.as_str().as_bytes()))
            .unwrap_or(encoding_rs::UTF_8);
        encoding.decode_with_bom_removal(data).0.into_owned()
    }

    fn to_text(&self, data: &[u8], content_type: &str, resolved_url: &str, url: &str) -> Fetched {
        let raw = self.decode(data, content_type);
        let text = if content_type.to_lowercase().contains("html") {
            self.html_to_text(&raw)
        } else {
            raw
        };
        let resolved_url = resolved_url.trim();
        Fetched {
            resolved_url: if resolved_url.is_empty() { url } else { resolved_url }.to_owned(),
            text: text.chars().take(MAX_CHARS).collect(),
        }
    }
}

/// The sandbox pipeline for an `sh` sandbox. `-g` keeps `{}`/`[]` in the URL literal;
/// `--proto`/`--proto-redir` keep the request and any redirect on http(s); `--fail` turns HTTP
/// errors into a non-zero exit. The body is spooled to a `mktemp` file (so the path only has to
/// make sense inside the sandbox), truncated there and returned as base64, which survives chunked
/// stdout decoding; stdout is the final hop's content type and URL, then the body.
fn curl_command(url: &str) -> String {
    format!(
        "f=$(mktemp -t strands-web-fetch.XXXXXX) && curl -sSL -g --fail --proto '=http,https' --proto-redir '=http,https' --max-time {TIMEOUT_SECONDS} -A {} -o \"$f\" -w '%{{content_type}}\\n%{{url_effective}}\\n' -- {} && head -c {MAX_BYTES} \"$f\" | base64; s=$?; rm -f \"$f\"; exit $s",
        shell_quote(USER_AGENT),
        shell_quote(url)
    )
}

/// The same contract for a PowerShell sandbox: `curl.exe` (plain `curl` is an alias there), the
/// body truncated and base64-encoded in .NET, errors written through the console handle rather
/// than PowerShell's CLIXML-wrapped error stream, and the temp path taken literally.
fn powershell_curl_command(url: &str) -> String {
    let quoted = format!("'{}'", url.replace('\'', "''"));
    [
        "$f = Join-Path ([IO.Path]::GetTempPath()) \"strands-web-fetch-$([guid]::NewGuid())\"".to_owned(),
        "$s = 127".to_owned(),
        "try {".to_owned(),
        format!(
            "  curl.exe -sSL -g --fail --proto '=http,https' --proto-redir '=http,https' --max-time {TIMEOUT_SECONDS} -A '{USER_AGENT}' -o $f --stderr \"$f.err\" -w '%{{content_type}}\\n%{{url_effective}}\\n' {quoted}"
        ),
        "  $s = $LASTEXITCODE".to_owned(),
        "  if ($s -eq 0) {".to_owned(),
        "    $in = [IO.File]::OpenRead($f)".to_owned(),
        format!(
            "    try {{ $b = (New-Object IO.BinaryReader $in).ReadBytes([Math]::Min($in.Length, {MAX_BYTES})) }} finally {{ $in.Dispose() }}"
        ),
        "    [Convert]::ToBase64String($b)".to_owned(),
        "  } elseif (Test-Path -LiteralPath \"$f.err\") { [Console]::Error.Write([IO.File]::ReadAllText(\"$f.err\")) }"
            .to_owned(),
        "} catch { if ($s -eq 0) { $s = 1 }; [Console]::Error.Write($_.Exception.Message) }".to_owned(),
        "Remove-Item -Force -LiteralPath $f, \"$f.err\" -ErrorAction SilentlyContinue".to_owned(),
        "exit $s".to_owned(),
    ]
    .join("\n")
}

impl Inner {
    async fn fetch_curl(&self, sandbox: &Arc<dyn Sandbox>, url: &str) -> Result<Fetched, String> {
        let shell = shell_of(sandbox).await.map_err(|error| error.to_string())?;
        let command = match shell {
            SandboxShell::PowerShell => powershell_curl_command(url),
            SandboxShell::Sh => curl_command(url),
        };
        let options = ExecuteOptions {
            timeout: Some(Duration::from_secs(TIMEOUT_SECONDS + 5)),
            ..ExecuteOptions::default()
        };
        let result = sandbox
            .execute(&command, options)
            .await
            .map_err(|error| error.to_string())?;
        if result.exit_code != 0 {
            let stderr = result.stderr.trim();
            return Err(if stderr.is_empty() {
                format!("curl exited with code {}", result.exit_code)
            } else {
                stderr.to_owned()
            });
        }
        let mut lines = result.stdout.split('\n');
        let content_type = lines.next().unwrap_or_default().trim().to_owned();
        let resolved_url = lines.next().unwrap_or_default().trim().to_owned();
        let body: String = lines.flat_map(str::chars).filter(|c| !c.is_whitespace()).collect();
        let data = base64::engine::general_purpose::STANDARD
            .decode(body)
            .map_err(|error| error.to_string())?;
        Ok(self.patterns.to_text(&data, &content_type, &resolved_url, url))
    }

    async fn fetch_direct(&self, url: &str) -> Result<Fetched, String> {
        let response = self
            .client
            .get(url)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .timeout(Duration::from_secs(TIMEOUT_SECONDS))
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    format!("web_fetch gave up after {TIMEOUT_SECONDS}s.")
                } else {
                    error.to_string()
                }
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "HTTP {} {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or_default()
            ));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let resolved_url = response.url().to_string();
        let data = read_capped(response).await?;
        Ok(self.patterns.to_text(&data, &content_type, &resolved_url, url))
    }

    async fn fetch_text(&self, sandbox: &Arc<dyn Sandbox>, url: &str) -> Result<Fetched, String> {
        let url = self.patterns.validate_url(url)?;
        match self.transport {
            WebFetchTransport::Direct => self.fetch_direct(&url).await,
            _ => self.fetch_curl(sandbox, &url).await,
        }
    }

    fn cached(&self, url: &str) -> Option<Fetched> {
        let cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        cache
            .get(url)
            .filter(|entry| entry.expires > Instant::now())
            .map(|entry| entry.page.clone())
    }

    fn store(&self, url: &str, page: Fetched) {
        let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        cache.retain(|_, entry| entry.expires > Instant::now());
        cache.insert(
            url.to_owned(),
            Cached {
                expires: Instant::now() + CACHE_TTL,
                page,
            },
        );
    }

    async fn run(&self, input: JsonValue, context: ToolContext) -> Result<JsonValue, ToolError> {
        let url = input
            .get("url")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| ToolError::msg("Invalid input: expected string at \"url\"."))?;
        let prompt = input.get("prompt").and_then(JsonValue::as_str).unwrap_or_default();
        let page = match self.cached(url) {
            Some(page) => page,
            None => match self.fetch_text(context.agent().sandbox(), url).await {
                Ok(page) => {
                    self.store(url, page.clone());
                    page
                }
                Err(error) => return Ok(format!("Failed to fetch {url}: {error}").into()),
            },
        };
        if prompt.trim().is_empty() {
            return Ok(page.text.into());
        }
        let model = self
            .summarizer
            .clone()
            .unwrap_or_else(|| context.agent().aux_model().clone());
        let mut summarizer = Agent::builder()
            .model(model)
            .system_prompt(SUMMARIZER_PROMPT)
            .printer(false)
            .build()?;
        let result = summarizer
            .invoke(format!(
                "Fetched URL: {}\n\nRequest: {prompt}\n\n--- Content ---\n{}",
                page.resolved_url, page.text
            ))
            .await?;
        Ok(result.to_string().into())
    }
}

/// Reads at most [`MAX_BYTES`] of the (decoded) body, then drops the stream rather than buffering
/// the rest.
async fn read_capped(response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut stream = response.bytes_stream();
    let mut data = Vec::new();
    while data.len() < MAX_BYTES {
        let Some(chunk) = stream.next().await else {
            break;
        };
        let chunk = chunk.map_err(|error| error.to_string())?;
        let room = MAX_BYTES - data.len();
        data.extend_from_slice(&chunk[..chunk.len().min(room)]);
    }
    Ok(data)
}

/// Builds the `web_fetch` tool.
///
/// `summarizer` is the model that answers the prompt over the fetched page; the harness passes
/// the one it resolved from `config.model` and the main model. When it
/// is `None`, a model instance or router in `config.model` is used, and otherwise the calling
/// agent's [`aux_model`](strands::ToolAgent::aux_model) (the agent's model unless one is set):
/// this model > `agent.aux_model` > `agent.model`.
///
/// ```
/// use strands::Tool;
/// use strands_harness::tools::web_fetch::{WebFetchConfig, web_fetch_tool};
///
/// let tool = web_fetch_tool(WebFetchConfig::default(), None)?;
/// assert_eq!(tool.name(), "web_fetch");
/// # Ok::<(), strands::Error>(())
/// ```
///
/// # Errors
///
/// When the HTTP client for the direct transport cannot be built.
pub fn web_fetch_tool(config: WebFetchConfig, summarizer: Option<Arc<dyn Model>>) -> strands::Result<FunctionTool> {
    let summarizer = summarizer.or(match config.model {
        Some(ModelSource::Model(model)) => Some(model),
        Some(ModelSource::Router(router)) => Some(router.default_model()),
        _ => None,
    });
    let patterns = Patterns::new().map_err(strands::Error::other)?;
    let client = reqwest::Client::builder().build().map_err(strands::Error::other)?;
    let inner = Arc::new(Inner {
        summarizer,
        transport: config.transport.unwrap_or_default(),
        cache: Mutex::new(HashMap::new()),
        client,
        patterns,
    });
    Ok(FunctionTool::builder("web_fetch", WEB_FETCH_DESCRIPTION)
        .input_schema(input_schema())
        .callback(move |input, context| {
            let inner = inner.clone();
            async move { inner.run(input, context).await }
        }))
}

#[cfg(test)]
mod tests;
