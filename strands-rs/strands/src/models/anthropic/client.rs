//! The Messages API client behind [`AnthropicModel`](super::AnthropicModel): the parts of the
//! official Anthropic SDK the provider uses, on the shared HTTP transport.

use futures::future::BoxFuture;
use futures::{FutureExt, StreamExt};
use reqwest::header::HeaderMap;

use super::AnthropicClientConfig;
use crate::models::BoxStream;
use crate::models::http::{
    DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT, ErrorPayload, HttpError, HttpTransport, HttpTransportConfig, header_map,
    json_body, parse_custom_headers, sse_events,
};
use crate::types::JsonValue;

/// The Anthropic API when neither the config nor `ANTHROPIC_BASE_URL` names another.
const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";

/// The `anthropic-version` sent unless a default header pins one, as `@anthropic-ai/sdk` 1.x does.
pub(super) const DEFAULT_API_VERSION: &str = "2026-10-21";

/// The streamed events of one Messages request, each decoded from its event data.
pub(super) type EventStream = BoxStream<'static, Result<JsonValue, HttpError>>;

/// One request: the JSON body and the `anthropic-beta` header, when betas apply.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ClientRequest {
    pub(super) body: JsonValue,
    pub(super) beta: Option<String>,
}

/// What the provider needs from a Messages API client, including the beta Messages API. Tests
/// substitute a scripted client.
pub(super) trait AnthropicClient: Send + Sync {
    /// Streams a Messages request (`messages.stream`).
    fn stream(&self, request: ClientRequest) -> EventStream;

    /// Streams a beta Messages request (`beta.messages.stream`); `None` when the client has no beta
    /// API.
    fn beta_stream(&self, request: ClientRequest) -> Option<EventStream>;

    /// Counts a request's input tokens (`messages.countTokens`), returning the response body;
    /// `None` when the client cannot count.
    fn count_tokens(&self, request: ClientRequest) -> Option<BoxFuture<'static, Result<JsonValue, HttpError>>>;
}

/// The API version a built client sends and where it comes from, for error messages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ApiVersion {
    pub(super) version: String,
    pub(super) origin: String,
}

/// Reads the values of a header from name and value pairs, matching the name case-insensitively.
pub(super) fn header_values<'a>(headers: &'a [(String, String)], name: &str) -> Vec<&'a str> {
    headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
        .collect()
}

/// The default headers a built client sends: `ANTHROPIC_CUSTOM_HEADERS` first, then the config's,
/// so the config wins over the environment.
pub(super) fn sent_headers(config: &AnthropicClientConfig, custom_headers: Option<&str>) -> Vec<(String, String)> {
    let mut headers = custom_headers.map(parse_custom_headers).unwrap_or_default();
    headers.extend(config.default_headers.iter().cloned());
    headers
}

/// Resolves the `anthropic-version` a built client sends: the last pinned value wins.
pub(super) fn resolve_api_version(config: &AnthropicClientConfig, custom_headers: Option<&str>) -> ApiVersion {
    let sent = sent_headers(config, custom_headers);
    let Some(pinned) = header_values(&sent, "anthropic-version")
        .last()
        .map(|value| (*value).to_owned())
    else {
        return ApiVersion {
            version: DEFAULT_API_VERSION.to_owned(),
            origin: format!("the default for strands {}", env!("CARGO_PKG_VERSION")),
        };
    };
    let from_config = header_values(&config.default_headers, "anthropic-version")
        .last()
        .copied()
        == Some(&pinned);
    let origin = if from_config {
        "pinned by client_config.default_headers['anthropic-version']"
    } else {
        "pinned by the ANTHROPIC_CUSTOM_HEADERS environment variable"
    };
    ApiVersion {
        version: pinned,
        origin: origin.to_owned(),
    }
}

/// The Messages API over HTTP.
pub(super) struct HttpAnthropicClient {
    transport: HttpTransport,
}

impl HttpAnthropicClient {
    /// Builds the client: `api_key`, the base URL from the config or `base_url_env`, and the default
    /// headers from `custom_headers` (`ANTHROPIC_CUSTOM_HEADERS`) and the config.
    pub(super) fn new(
        api_key: &str,
        config: &AnthropicClientConfig,
        base_url_env: Option<String>,
        custom_headers: Option<&str>,
    ) -> Result<Self, HttpError> {
        let base_url = config
            .base_url
            .clone()
            .or(base_url_env)
            .filter(|url| !url.is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        let user_agent = format!("strands-agents-rust/{}", env!("CARGO_PKG_VERSION"));
        let base = [
            ("accept", "application/json"),
            ("user-agent", user_agent.as_str()),
            ("anthropic-version", DEFAULT_API_VERSION),
            ("x-api-key", api_key),
        ];
        let sent = sent_headers(config, custom_headers);
        let default_headers = header_map(
            base.into_iter()
                .chain(sent.iter().map(|(name, value)| (name.as_str(), value.as_str()))),
        )?;
        let transport = HttpTransport::new(HttpTransportConfig {
            base_url,
            default_headers,
            max_retries: config.max_retries.unwrap_or(DEFAULT_MAX_RETRIES),
            timeout: config.timeout.unwrap_or(DEFAULT_TIMEOUT),
            error_payload: ErrorPayload::Body,
        })?;
        Ok(Self { transport })
    }

    #[cfg(test)]
    pub(super) fn with_transport(transport: HttpTransport) -> Self {
        Self { transport }
    }

    fn post_stream(&self, path: &'static str, request: ClientRequest) -> EventStream {
        let transport = self.transport.clone();
        Box::pin(async_stream::stream! {
            let headers = match beta_headers(request.beta.as_deref()) {
                Ok(headers) => headers,
                Err(error) => {
                    yield Err(error);
                    return;
                }
            };
            let response = match transport.post(path, &request.body, &headers).await {
                Ok(response) => response,
                Err(error) => {
                    yield Err(error);
                    return;
                }
            };
            let mut events = sse_events(response);
            while let Some(event) = events.next().await {
                let event = match event {
                    Ok(event) => event,
                    Err(error) => {
                        yield Err(error);
                        return;
                    }
                };
                match event.event.as_str() {
                    "error" => {
                        yield Err(HttpError::event(&event.data));
                        return;
                    }
                    name if STREAMED_EVENTS.contains(&name) => {
                        yield serde_json::from_str(&event.data)
                            .map_err(|error| HttpError::decode(format!("could not parse event data as JSON: {error}"), error));
                    }
                    _ => {}
                }
            }
        })
    }
}

/// The event names whose data the SDK's stream decodes; others (`ping`, unknown ones) are skipped.
const STREAMED_EVENTS: [&str; 7] = [
    "message_start",
    "message_delta",
    "message_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message",
];

fn beta_headers(beta: Option<&str>) -> Result<HeaderMap, HttpError> {
    header_map(beta.map(|beta| ("anthropic-beta", beta)))
}

impl AnthropicClient for HttpAnthropicClient {
    fn stream(&self, request: ClientRequest) -> EventStream {
        self.post_stream("/v1/messages", request)
    }

    fn beta_stream(&self, request: ClientRequest) -> Option<EventStream> {
        Some(self.post_stream("/v1/messages?beta=true", request))
    }

    fn count_tokens(&self, request: ClientRequest) -> Option<BoxFuture<'static, Result<JsonValue, HttpError>>> {
        let transport = self.transport.clone();
        Some(
            async move {
                let headers = beta_headers(request.beta.as_deref())?;
                let response = transport
                    .post("/v1/messages/count_tokens", &request.body, &headers)
                    .await?;
                json_body(response).await
            }
            .boxed(),
        )
    }
}
