//! The `http_request` tool: makes HTTP requests to external APIs from the host.

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

use serde_json::json;

use super::input::InputReader;
use super::{js_number_text, seconds};
use crate::cancel::CancelSignal;
use crate::tools::{FunctionTool, ToolError};
use crate::types::{JsonSchema, JsonValue};

const DEFAULT_TIMEOUT: f64 = 30.0;
const METHODS: [&str; 7] = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

/// The description of the `http_request` tool shown to the model.
pub(crate) const HTTP_REQUEST_DESCRIPTION: &str = "Makes HTTP requests to external APIs. Supports GET, POST, PUT, DELETE, PATCH, HEAD, and OPTIONS methods. Returns response with status, headers, and body.";

fn input_schema() -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "method": {"type": "string", "enum": METHODS, "description": "HTTP method to use for the request"},
            "url": {"type": "string", "format": "uri", "description": "URL to send the request to"},
            "headers": {
                "description": "Optional HTTP headers as key-value pairs",
                "type": "object",
                "propertyNames": {"type": "string"},
                "additionalProperties": {"type": "string"}
            },
            "body": {"description": "Optional request body as a string", "type": "string"},
            "timeout": {
                "description": "Optional timeout in seconds (default: 30)",
                "type": "number",
                "exclusiveMinimum": 0
            }
        },
        "required": ["method", "url"],
        "additionalProperties": false
    })
}

/// The redirects a request follows, as `fetch` does.
const MAX_REDIRECTS: usize = 20;

/// The `fetch` message for a GET or HEAD request with a body.
const GET_HEAD_BODY_MESSAGE: &str = "Request with GET/HEAD method cannot have body.";

/// The client configuration of the HTTP tools, matching `fetch`: up to 20 redirects and
/// gzip, deflate and brotli responses decompressed. Proxies come from the environment
/// (DIVERGENCES.md).
pub(crate) fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
}

/// A lazily built HTTP client; the tool fails at call time when it cannot be built.
#[derive(Default)]
pub(crate) struct LazyClient {
    client: OnceLock<reqwest::Client>,
}

impl LazyClient {
    #[cfg(test)]
    pub(crate) fn with(client: reqwest::Client) -> Self {
        Self {
            client: OnceLock::from(client),
        }
    }

    pub(crate) fn get(&self) -> Result<&reqwest::Client, ToolError> {
        if let Some(client) = self.client.get() {
            return Ok(client);
        }
        let client = client_builder()
            .build()
            .map_err(|error| ToolError::msg(format!("failed to create the HTTP client: {error}")))?;
        Ok(self.client.get_or_init(|| client))
    }
}

/// The `http_request` tool: sends `method` to `url` with optional `headers` and
/// `body`, and returns `{status, statusText, headers, body}` as JSON.
///
/// A status outside 2xx fails with `HTTP <status> <statusText>: <method> <url>`. The request
/// fails after `timeout` seconds (30 when absent) and when the call is cancelled. Redirects are
/// followed.
///
/// ```
/// let agent = strands::Agent::builder()
///     .tools([strands::vended_tools::http_request::http_request()])
///     .printer(false)
///     .build()?;
/// assert!(agent.tool_registry().get("http_request").is_some());
/// # Ok::<(), strands::Error>(())
/// ```
#[must_use]
pub fn http_request() -> FunctionTool {
    with_client(LazyClient::default())
}

pub(crate) fn with_client(client: LazyClient) -> FunctionTool {
    let client = Arc::new(client);
    FunctionTool::builder("http_request", HTTP_REQUEST_DESCRIPTION)
        .input_schema(input_schema())
        .callback(move |input, context| {
            let client = client.clone();
            let signal = context.cancel_signal().clone();
            async move { run(&client, &input, &signal).await }
        })
}

struct Request<'a> {
    method: &'a str,
    url: &'a str,
    headers: Vec<(&'a str, &'a str)>,
    body: Option<&'a str>,
    timeout: f64,
}

fn parse(input: &JsonValue) -> Result<Request<'_>, ToolError> {
    let mut reader = InputReader::new(input);
    let method = reader.one_of("method", &METHODS);
    let url = reader.string("url");
    if url.is_some_and(|url| reqwest::Url::parse(url).is_err()) {
        reader.issue("url", "Invalid URL");
    }
    let headers = match reader.get("headers") {
        None => Vec::new(),
        Some(JsonValue::Object(headers)) => {
            let pairs: Option<Vec<(&str, &str)>> = headers
                .iter()
                .map(|(name, value)| value.as_str().map(|value| (name.as_str(), value)))
                .collect();
            pairs.unwrap_or_else(|| {
                reader.issue("headers", "Invalid input: expected record of strings");
                Vec::new()
            })
        }
        Some(_) => {
            reader.issue("headers", "Invalid input: expected record of strings");
            Vec::new()
        }
    };
    let body = reader.optional_string("body");
    let timeout = reader.optional_positive("timeout", |_| "Too small: expected number to be >0".to_owned());
    reader.finish()?;
    if body.is_some() && matches!(method, Some("GET" | "HEAD")) {
        return Err(ToolError::msg(GET_HEAD_BODY_MESSAGE));
    }
    Ok(Request {
        method: method.unwrap_or_default(),
        url: url.unwrap_or_default(),
        headers,
        body,
        timeout: timeout.unwrap_or(DEFAULT_TIMEOUT),
    })
}

enum Failure {
    Timeout,
    Cancelled,
    Error(ToolError),
}

async fn run(client: &LazyClient, input: &JsonValue, signal: &CancelSignal) -> Result<JsonValue, ToolError> {
    let request = parse(input)?;
    let client = client.get()?;
    let send = send(client, &request);
    let limit = seconds(request.timeout);
    let outcome = tokio::select! {
        result = async {
            match limit {
                Some(limit) => tokio::time::timeout(limit, send).await.unwrap_or(Err(Failure::Timeout)),
                None => send.await,
            }
        } => result,
        () = signal.cancelled() => Err(Failure::Cancelled),
    };
    let (method, url) = (request.method, request.url);
    match outcome {
        Ok(value) => Ok(value),
        Err(Failure::Timeout) => Err(ToolError::msg(format!(
            "Request timed out after {} seconds: {method} {url}",
            js_number_text(request.timeout)
        ))),
        Err(Failure::Cancelled) => Err(ToolError::msg(format!("Request cancelled: {method} {url}"))),
        Err(Failure::Error(error)) => Err(error),
    }
}

async fn send(client: &reqwest::Client, request: &Request<'_>) -> Result<JsonValue, Failure> {
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|error| Failure::Error(ToolError::new(error)))?;
    let mut builder = client.request(method, request.url);
    for (name, value) in &request.headers {
        builder = builder.header(*name, *value);
    }
    if let Some(body) = request.body {
        builder = builder.body(body.to_owned());
    }
    let response = builder
        .send()
        .await
        .map_err(|error| Failure::Error(ToolError::new(error)))?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or_default();
    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    for (name, value) in response.headers() {
        let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
        headers
            .entry(name.as_str().to_owned())
            .and_modify(|joined| {
                joined.push_str(", ");
                joined.push_str(&value);
            })
            .or_insert(value);
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| Failure::Error(ToolError::new(error)))?;
    if !status.is_success() {
        return Err(Failure::Error(ToolError::msg(format!(
            "HTTP {} {status_text}: {} {}",
            status.as_u16(),
            request.method,
            request.url
        ))));
    }
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    Ok(json!({
        "status": status.as_u16(),
        "statusText": status_text,
        "headers": headers,
        "body": String::from_utf8_lossy(body),
    }))
}

#[cfg(test)]
mod tests;
