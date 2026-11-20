//! `web_search`: search the web and return the top results as numbered sources.
//!
//! Two modes serve the `web_search` built-in ([`WebSearchSetting`]):
//!
//! - native: a provider server tool on the model itself (Anthropic `web_search`, the OpenAI
//!   Responses `web_search` tool, Bedrock Mantle's GPT models), with no harness tool. The tool
//!   records for those are [`anthropic_web_search_tool`], [`openai_web_search_tool`] and
//!   [`bedrock_mantle_web_search_tool`]; Bedrock has none, so search stays off there;
//! - Exa (opt-in, feature `mcp`): the `web_search_tool` built here, backed by Exa's hosted MCP
//!   server, a third party that receives the queries. The keyless tier works out of the box and
//!   `EXA_API_KEY` lifts its rate limit.
//!
//! The tool/backend split ([`search_tool`] over a [`SearchBackend`]) keeps the model-facing
//! contract fixed while the provider behind it can change.

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::json;
use strands::tools::{FunctionTool, ToolError};
use strands::types::{JsonSchema, JsonValue};

/// Exa's hosted MCP endpoint.
#[cfg(feature = "mcp")]
pub(crate) const EXA_MCP_URL: &str = "https://mcp.exa.ai/mcp";
/// The Exa MCP tool `web_search` calls.
#[cfg(feature = "mcp")]
pub(crate) const EXA_TOOL: &str = "web_search_exa";
const MAX_RESULTS: i64 = 10;
const DEFAULT_RESULTS: i64 = 5;
#[cfg_attr(not(feature = "mcp"), allow(dead_code, reason = "used by the Exa backend"))]
const SNIPPET_CHARS: usize = 500;

/// The `web_search` tool description.
pub const WEB_SEARCH_DESCRIPTION: &str =
    "Search the web and return the top results as numbered sources with a short excerpt each.";

/// The `web_search` built-in setting (`WebSearchSetting`): on (native search where the model has
/// it), off, or Exa on any model. JSON form: `true`, `false` or `"exa"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum WebSearchSetting {
    /// Off (`false`).
    Off,
    /// The model's native search where it has one (`true`, the default).
    #[default]
    On,
    /// Exa's hosted search on any model, replacing native search (`'exa'`).
    Exa,
}

impl From<bool> for WebSearchSetting {
    fn from(enabled: bool) -> Self {
        if enabled { Self::On } else { Self::Off }
    }
}

impl Serialize for WebSearchSetting {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Off => serializer.serialize_bool(false),
            Self::On => serializer.serialize_bool(true),
            Self::Exa => serializer.serialize_str("exa"),
        }
    }
}

struct SettingVisitor;

impl Visitor<'_> for SettingVisitor {
    type Value = WebSearchSetting;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a boolean or 'exa'")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
        Ok(value.into())
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        if value == "exa" {
            return Ok(WebSearchSetting::Exa);
        }
        Err(E::custom("must be a boolean or 'exa'."))
    }
}

impl<'de> Deserialize<'de> for WebSearchSetting {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(SettingVisitor)
    }
}

/// The Anthropic server tool record for native search (`ANTHROPIC_WEB_SEARCH`), for
/// `AnthropicModelConfig` `anthropic_tools`.
#[must_use]
pub fn anthropic_web_search_tool() -> JsonValue {
    json!({"type": "web_search_20260318", "name": "web_search", "allowed_callers": ["direct"]})
}

/// The OpenAI Responses built-in tool for native search, for the model's `params.tools`.
#[must_use]
pub fn openai_web_search_tool() -> JsonValue {
    json!({"type": "web_search"})
}

/// The Bedrock Mantle (GPT models) built-in tool for native search, for the model's
/// `params.tools`.
#[must_use]
pub fn bedrock_mantle_web_search_tool() -> JsonValue {
    json!({"type": "web_search", "external_web_access": true})
}

/// One search result (`SearchResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct SearchResult {
    /// The page title.
    pub title: String,
    /// The page URL.
    pub url: String,
    /// A short excerpt; may be empty.
    pub snippet: String,
}

impl SearchResult {
    /// A result.
    pub fn new(title: impl Into<String>, url: impl Into<String>, snippet: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            url: url.into(),
            snippet: snippet.into(),
        }
    }
}

/// A backend failure with a message the model can act on (`WebSearchError`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
#[non_exhaustive]
pub struct WebSearchError {
    message: String,
}

impl WebSearchError {
    /// An error with `message`.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// What failed.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

/// Runs a search (`SearchBackend`): the top `max_results` results for `query`.
#[async_trait]
pub trait SearchBackend: Send + Sync + 'static {
    /// Searches.
    ///
    /// # Errors
    ///
    /// When the search fails; the model sees `web_search failed: <message>`.
    async fn search(&self, query: &str, max_results: usize) -> Result<Vec<SearchResult>, WebSearchError>;
}

fn input_schema() -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "What to search for. A descriptive sentence works better than bare keywords."
            },
            "max_results": {
                "description": "How many results to return, 1-10.",
                "type": "integer",
                "minimum": -9_007_199_254_740_991_i64,
                "maximum": 9_007_199_254_740_991_i64
            }
        },
        "required": ["query"],
        "additionalProperties": false
    })
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "clamped to 1..=10"
)]
fn max_results(input: &JsonValue) -> usize {
    let requested = input
        .get("max_results")
        .and_then(JsonValue::as_i64)
        .unwrap_or(DEFAULT_RESULTS);
    requested.clamp(1, MAX_RESULTS) as usize
}

fn format_results(results: &[SearchResult]) -> String {
    if results.is_empty() {
        return "No results.".to_owned();
    }
    let mut lines = vec!["Sources:".to_owned()];
    for (index, result) in results.iter().enumerate() {
        lines.push(format!(
            "{}. {} \u{2014} {}",
            index + 1,
            one_line(&result.title),
            result.url
        ));
        if !result.snippet.is_empty() {
            lines.push(format!("   {}", one_line(&result.snippet)));
        }
    }
    lines.join("\n")
}

/// Builds a `web_search` tool that formats `backend`'s results as a numbered `Sources:` list.
/// `max_results` is clamped to 1-10 (5 when omitted); failures and empty results come back as text.
#[must_use]
pub fn search_tool(backend: Arc<dyn SearchBackend>) -> FunctionTool {
    FunctionTool::builder("web_search", WEB_SEARCH_DESCRIPTION)
        .input_schema(input_schema())
        .callback(move |input, _context| {
            let backend = backend.clone();
            async move {
                let query = input
                    .get("query")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| ToolError::msg("Invalid input: expected string at \"query\"."))?;
                let text = match backend.search(query, max_results(&input)).await {
                    Ok(results) => format_results(&results),
                    Err(error) => {
                        let reason = if error.message().is_empty() {
                            "Error"
                        } else {
                            error.message()
                        };
                        format!("web_search failed: {reason}")
                    }
                };
                Ok::<JsonValue, ToolError>(text.into())
            }
        })
}

/// Splits Exa's `---`-separated `Title:/URL:/.../Highlights:` blocks into results. Only a block
/// that opens with a `Title:` line directly followed by a `URL:` line counts, so those words
/// inside a page's highlighted text do not start a source.
#[cfg_attr(not(feature = "mcp"), allow(dead_code, reason = "used by the Exa backend"))]
fn parse_exa(text: &str) -> Vec<SearchResult> {
    let mut blocks = Vec::new();
    let mut current = String::new();
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        if bare.starts_with("---") && bare[3..].chars().all(char::is_whitespace) {
            blocks.push(std::mem::take(&mut current));
            continue;
        }
        current.push_str(line);
    }
    blocks.push(current);
    blocks.iter().filter_map(|block| parse_block(block)).collect()
}

#[cfg_attr(not(feature = "mcp"), allow(dead_code, reason = "used by the Exa backend"))]
fn parse_block(block: &str) -> Option<SearchResult> {
    let rest = block.trim_start();
    let rest = rest.strip_prefix("Title: ")?;
    let (title, rest) = rest.split_once('\n')?;
    let title = title.strip_suffix('\r').unwrap_or(title);
    let rest = rest.strip_prefix("URL: ")?;
    let url: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
    if url.is_empty() {
        return None;
    }
    let highlights = block
        .find("Highlights:")
        .map_or("", |index| &block[index + "Highlights:".len()..]);
    let snippet: String = one_line(highlights).chars().take(SNIPPET_CHARS).collect();
    Some(SearchResult::new(title.trim(), url, snippet))
}

#[cfg(feature = "mcp")]
pub use exa::{ExaBackend, web_search_tool};

#[cfg(feature = "mcp")]
mod exa {
    use std::collections::BTreeMap;
    use std::fmt;
    use std::sync::Arc;
    use std::time::Duration;

    use async_trait::async_trait;
    use serde_json::json;
    use strands::Tool;
    use strands::mcp::{McpCallToolOptions, McpClient, McpClientConfig, McpClientOptions, McpToolFilters};
    use strands::tools::FunctionTool;
    use strands::types::JsonValue;

    use super::{EXA_MCP_URL, EXA_TOOL, SearchBackend, SearchResult, WebSearchError, parse_exa, search_tool};

    const TIMEOUT: Duration = Duration::from_secs(30);

    type EnvLookup = Arc<dyn Fn() -> Option<String> + Send + Sync>;

    /// The search backend over Exa's hosted MCP server. Each search opens its own
    /// MCP session and closes it.
    #[derive(Clone)]
    pub struct ExaBackend {
        api_key: Option<String>,
        url: String,
        env: EnvLookup,
    }

    impl fmt::Debug for ExaBackend {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("ExaBackend")
                .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
                .field("url", &self.url)
                .finish_non_exhaustive()
        }
    }

    impl Default for ExaBackend {
        fn default() -> Self {
            Self::new(None)
        }
    }

    impl ExaBackend {
        /// A backend sending `api_key` as `x-api-key`. `None` reads `EXA_API_KEY` on every
        /// search; an empty key (or variable) searches keyless.
        #[must_use]
        pub fn new(api_key: Option<String>) -> Self {
            Self {
                api_key,
                url: EXA_MCP_URL.to_owned(),
                env: Arc::new(|| std::env::var("EXA_API_KEY").ok()),
            }
        }

        /// Uses another MCP endpoint, such as a proxy in front of Exa.
        #[must_use]
        pub fn with_url(mut self, url: impl Into<String>) -> Self {
            self.url = url.into();
            self
        }

        #[cfg(test)]
        pub(super) fn with_env(mut self, env: impl Fn() -> Option<String> + Send + Sync + 'static) -> Self {
            self.env = Arc::new(env);
            self
        }

        async fn call(&self, query: &str, max_results: usize, key: &str) -> Result<Vec<SearchResult>, WebSearchError> {
            let headers = (!key.is_empty()).then(|| BTreeMap::from([("x-api-key".to_owned(), key.to_owned())]));
            let config = McpClientConfig {
                url: Some(self.url.clone()),
                headers,
                options: McpClientOptions {
                    tool_filters: Some(McpToolFilters {
                        allowed: Some(vec![EXA_TOOL.into()]),
                        rejected: None,
                    }),
                    ..McpClientOptions::default()
                },
                ..McpClientConfig::default()
            };
            let client = McpClient::new(config).map_err(|error| WebSearchError::new(error.to_string()))?;
            let result = self.call_with(&client, query, max_results).await;
            if let Err(error) = client.disconnect().await {
                tracing::debug!("error=<{error}> | exa mcp session teardown failed");
            }
            let result = result?;
            let text = result
                .get("content")
                .and_then(JsonValue::as_array)
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|block| block.get("text").and_then(JsonValue::as_str))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            if result.get("isError").and_then(JsonValue::as_bool) == Some(true) {
                let message = if text.is_empty() {
                    "Exa reported an error".to_owned()
                } else {
                    text
                };
                return Err(WebSearchError::new(message));
            }
            Ok(parse_exa(&text))
        }

        async fn call_with(
            &self,
            client: &McpClient,
            query: &str,
            max_results: usize,
        ) -> Result<JsonValue, WebSearchError> {
            let tools = client.list_tools().await.map_err(|error| {
                WebSearchError::new(format!("could not reach Exa's MCP server at {} ({error})", self.url))
            })?;
            let Some(exa) = tools.iter().find(|tool| tool.name() == EXA_TOOL) else {
                return Err(WebSearchError::new(format!(
                    "Exa's MCP server does not offer {EXA_TOOL}"
                )));
            };
            let options = McpCallToolOptions {
                timeout: Some(TIMEOUT),
                ..McpCallToolOptions::default()
            };
            client
                .call_tool(exa, json!({"query": query, "numResults": max_results}), options)
                .await
                .map_err(|error| WebSearchError::new(error.to_string()))
        }
    }

    #[async_trait]
    impl SearchBackend for ExaBackend {
        async fn search(&self, query: &str, max_results: usize) -> Result<Vec<SearchResult>, WebSearchError> {
            let key = self.api_key.clone().or_else(|| (self.env)()).unwrap_or_default();
            match self.call(query, max_results, &key).await {
                Ok(results) => Ok(results),
                Err(error) if !key.is_empty() => Err(error),
                Err(error) => Err(WebSearchError::new(format!(
                    "{} (Exa's keyless tier is rate limited; set EXA_API_KEY to lift it.)",
                    error.message()
                ))),
            }
        }
    }

    /// The `web_search` tool served by Exa; `EXA_API_KEY` is read on every
    /// call. The harness builds it when `web_search` is set to [`WebSearchSetting::Exa`](super::WebSearchSetting::Exa).
    ///
    /// ```
    /// use strands::Tool;
    ///
    /// let tool = strands_harness::tools::web_search::web_search_tool();
    /// assert_eq!(tool.name(), "web_search");
    /// ```
    #[must_use]
    pub fn web_search_tool() -> FunctionTool {
        search_tool(Arc::new(ExaBackend::default()))
    }
}

#[cfg(test)]
mod tests;
