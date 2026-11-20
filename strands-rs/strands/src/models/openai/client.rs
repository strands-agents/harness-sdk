//! The HTTP client behind [`OpenAIModel`](super::OpenAIModel): the parts of the official OpenAI SDK
//! the provider uses, on the shared HTTP transport.

use futures::StreamExt;
use reqwest::header::HeaderMap;

use super::{ApiKey, ApiKeySetter, OpenAIClientConfig};
use crate::models::BoxStream;
use crate::models::http::{
    DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT, ErrorPayload, HttpError, HttpTransport, HttpTransportConfig, header_map,
    parse_custom_headers, read_env, sse_events,
};
use crate::models::openai::formatting::is_truthy;
use crate::types::JsonValue;

/// The OpenAI API when neither the config nor `OPENAI_BASE_URL` names another.
pub(super) const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

/// The Chat Completions endpoint, under the base URL.
pub(super) const CHAT_COMPLETIONS_PATH: &str = "/chat/completions";

/// The Responses endpoint, under the base URL.
pub(super) const RESPONSES_PATH: &str = "/responses";

/// The streamed events of one request, each decoded from its event data.
pub(super) type EventStream = BoxStream<'static, Result<JsonValue, HttpError>>;

/// What the provider needs from an OpenAI client (`chat.completions.create` and `responses.create`
/// with `stream: true`). Tests substitute a scripted client.
pub(super) trait OpenAIClient: Send + Sync {
    /// POSTs a streaming request body to `path` and yields each event's data.
    fn stream(&self, path: &'static str, body: JsonValue) -> EventStream;
}

/// Reads environment variables; tests substitute a map.
pub(super) type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

/// The OpenAI API over HTTP.
pub(super) struct HttpOpenAIClient {
    transport: HttpTransport,
    /// Called before each request when the API key comes from a function and no default header
    /// sets `Authorization` itself.
    setter: Option<ApiKeySetter>,
}

impl HttpOpenAIClient {
    /// Builds the client as the official OpenAI SDK does: the base URL
    /// from `base_url`, the config or `OPENAI_BASE_URL`; the key from `api_key` or `OPENAI_API_KEY`;
    /// the organization and project from the config or `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID`;
    /// default headers from `OPENAI_CUSTOM_HEADERS`, then the config's. Environment values are
    /// trimmed, and blank ones count as unset.
    pub(super) fn new(
        api_key: Option<&ApiKey>,
        base_url: Option<String>,
        config: &OpenAIClientConfig,
        env: Env<'_>,
    ) -> Result<Self, HttpError> {
        let env = |name: &str| read_env(env, name);
        let base_url = base_url
            .or_else(|| config.base_url.clone())
            .or_else(|| env("OPENAI_BASE_URL"))
            .filter(|url| !url.is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        let organization = config.organization.clone().or_else(|| env("OPENAI_ORG_ID"));
        let project = config.project.clone().or_else(|| env("OPENAI_PROJECT_ID"));
        let (static_key, setter) = match api_key {
            Some(ApiKey::Key(key)) => (Some(key.clone()), None),
            Some(ApiKey::Setter(setter)) => (None, Some(setter.clone())),
            None => (env("OPENAI_API_KEY"), None),
        };
        let mut default_headers = env("OPENAI_CUSTOM_HEADERS")
            .as_deref()
            .map(parse_custom_headers)
            .unwrap_or_default();
        default_headers.extend(config.default_headers.iter().cloned());
        let user_agent = format!("strands-agents-rust/{}", env!("CARGO_PKG_VERSION"));
        let authorization = static_key.map(|key| format!("Bearer {key}"));
        let mut pairs: Vec<(&str, &str)> = vec![("accept", "application/json"), ("user-agent", &user_agent)];
        pairs.extend(organization.as_deref().map(|value| ("openai-organization", value)));
        pairs.extend(project.as_deref().map(|value| ("openai-project", value)));
        pairs.extend(authorization.as_deref().map(|value| ("authorization", value)));
        pairs.extend(
            default_headers
                .iter()
                .map(|(name, value)| (name.as_str(), value.as_str())),
        );
        let overrides_authorization = default_headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("authorization"));
        let transport = HttpTransport::new(HttpTransportConfig {
            base_url,
            default_headers: header_map(pairs)?,
            max_retries: config.max_retries.unwrap_or(DEFAULT_MAX_RETRIES),
            timeout: config.timeout.unwrap_or(DEFAULT_TIMEOUT),
            error_payload: ErrorPayload::ErrorField,
        })?;
        Ok(Self {
            transport,
            setter: setter.filter(|_| !overrides_authorization),
        })
    }

    #[cfg(test)]
    pub(super) fn with_transport(transport: HttpTransport, setter: Option<ApiKeySetter>) -> Self {
        Self { transport, setter }
    }
}

/// The `Authorization` header from an API key function.
async fn authorization(setter: Option<&ApiKeySetter>) -> Result<HeaderMap, HttpError> {
    let Some(setter) = setter else {
        return Ok(HeaderMap::new());
    };
    let token = match setter().await {
        Ok(token) => token,
        Err(error) => {
            let message = format!("Failed to get token from 'api_key' function: {error}");
            return Err(HttpError::credentials(message, Some(error)));
        }
    };
    if token.is_empty() {
        return Err(HttpError::credentials(
            "Expected 'api_key' function argument to return a string but it returned ",
            None,
        ));
    }
    let value = format!("Bearer {token}");
    header_map([("authorization", value.as_str())])
}

impl OpenAIClient for HttpOpenAIClient {
    fn stream(&self, path: &'static str, body: JsonValue) -> EventStream {
        let transport = self.transport.clone();
        let setter = self.setter.clone();
        Box::pin(async_stream::stream! {
            let headers = match authorization(setter.as_ref()).await {
                Ok(headers) => headers,
                Err(error) => {
                    yield Err(error);
                    return;
                }
            };
            let response = match transport.post(path, &body, &headers).await {
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
                if event.data.starts_with("[DONE]") {
                    return;
                }
                let data: JsonValue = match serde_json::from_str(&event.data) {
                    Ok(data) => data,
                    Err(error) => {
                        yield Err(HttpError::decode(format!("could not parse event data as JSON: {error}"), error));
                        return;
                    }
                };
                if is_truthy(data.get("error")) {
                    yield Err(HttpError::event_error_field(data));
                    return;
                }
                yield Ok(data);
            }
        })
    }
}
