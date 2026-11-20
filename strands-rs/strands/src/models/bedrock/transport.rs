//! The Bedrock transport: Converse JSON in, Converse JSON out, over the AWS SDK for Rust.
//!
//! The SDK resolves credentials, region and endpoint, signs, retries and decodes the event
//! stream. The request body is the formatted Converse JSON itself, set just before signing, so the
//! wire keeps the formatter's key order (the SDK's document type is an unordered map, which would
//! reorder tool schemas and break prompt-cache prefixes) and every Converse field reaches Bedrock.
//! Responses are converted back to Converse JSON by [`super::wire`].

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use aws_config::{BehaviorVersion, SdkConfig};
use aws_credential_types::provider::SharedCredentialsProvider;
use aws_sdk_bedrockruntime::Client;
use aws_sdk_bedrockruntime::config::{AppName, Region, StalledStreamProtectionConfig, Token};
use aws_sdk_bedrockruntime::error::{DisplayErrorContext, ProvideErrorMetadata, SdkError};
use aws_smithy_runtime_api::client::auth::http::HTTP_BEARER_AUTH_SCHEME_ID;
use aws_smithy_types::body::SdkBody;
use aws_smithy_types::timeout::TimeoutConfig;
use tokio::sync::OnceCell;

use super::wire;
use crate::error::{BoxError, Error, ModelError, ModelNetworkError, ModelThrottledError};
use crate::models::BoxStream;
use crate::models::defaults::MODEL_DEFAULTS;
use crate::types::{JsonObject, JsonValue};

/// Converse request fields sent in the body; `modelId` is in the path.
const CONVERSE_BODY_KEYS: [&str; 12] = [
    "messages",
    "system",
    "inferenceConfig",
    "toolConfig",
    "guardrailConfig",
    "additionalModelRequestFields",
    "promptVariables",
    "additionalModelResponseFieldPaths",
    "requestMetadata",
    "performanceConfig",
    "serviceTier",
    "outputConfig",
];

const APP_NAME: &str = "strands-agents-rust-sdk";

/// Stream chunks as Converse JSON, each a single-key object such as `{"messageStart": {...}}`.
pub(crate) type ChunkStream = BoxStream<'static, Result<JsonObject, BedrockError>>;

/// What kind of failure a [`BedrockError`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BedrockErrorKind {
    /// Bedrock answered with an error.
    Service,
    /// The request did not complete: connection, timeout or response errors.
    Network,
    /// The request could not be built or sent.
    Other,
}

/// A Bedrock failure with its exception name, such as `ThrottlingException`.
#[derive(Debug, thiserror::Error)]
#[error("{name}: {message}")]
pub(crate) struct BedrockError {
    pub(crate) name: String,
    pub(crate) message: String,
    pub(crate) kind: BedrockErrorKind,
    #[source]
    pub(crate) source: Option<BoxError>,
}

impl BedrockError {
    pub(crate) fn service(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            message: message.into(),
            kind: BedrockErrorKind::Service,
            source: None,
        }
    }

    pub(crate) fn network(message: impl Into<String>) -> Self {
        Self {
            name: "NetworkError".to_owned(),
            message: message.into(),
            kind: BedrockErrorKind::Network,
            source: None,
        }
    }

    fn with_source(mut self, source: impl Into<BoxError>) -> Self {
        self.source = Some(source.into());
        self
    }

    /// Classifies an AWS SDK error, keeping it as the source.
    pub(super) fn from_sdk<E, R>(error: SdkError<E, R>) -> Self
    where
        E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
        R: fmt::Debug + Send + Sync + 'static,
    {
        let message = DisplayErrorContext(&error).to_string();
        let classified = match &error {
            SdkError::ServiceError(context) => {
                let service_error = context.err();
                Self::service(
                    service_error.code().unwrap_or("UnknownError"),
                    service_error.message().unwrap_or(&message),
                )
            }
            SdkError::TimeoutError(_) | SdkError::DispatchFailure(_) | SdkError::ResponseError(_) => {
                Self::network(message)
            }
            _ => Self {
                name: "Error".to_owned(),
                message,
                kind: BedrockErrorKind::Other,
                source: None,
            },
        };
        classified.with_source(error)
    }
}

impl From<BedrockError> for Error {
    fn from(error: BedrockError) -> Self {
        let message = error.message.clone();
        if error.name == "ThrottlingException" {
            return ModelThrottledError::new(message).with_source(error).into();
        }
        match error.kind {
            BedrockErrorKind::Network => ModelNetworkError::new(message).with_source(error).into(),
            BedrockErrorKind::Service | BedrockErrorKind::Other => ModelError::new(message).with_source(error).into(),
        }
    }
}

/// Sends Converse JSON to Bedrock. Tests replace it with a recorder.
#[async_trait]
pub(crate) trait BedrockTransport: Send + Sync + 'static {
    /// Starts a ConverseStream call; the error is the call's rejection, before any chunk.
    async fn converse_stream(&self, request: JsonObject) -> Result<ChunkStream, BedrockError>;

    /// Runs a Converse call and returns its output.
    async fn converse(&self, request: JsonObject) -> Result<JsonObject, BedrockError>;

    /// Counts the input tokens of a Converse input (`messages`, `system`, `toolConfig`).
    async fn count_tokens(&self, model_id: String, input: JsonObject) -> Result<Option<u64>, BedrockError>;
}

/// How the AWS client is built.
#[derive(Clone)]
pub(crate) struct ClientOptions {
    pub(crate) region: Option<String>,
    pub(crate) endpoint_url: Option<String>,
    pub(crate) credentials_provider: Option<SharedCredentialsProvider>,
    pub(crate) sdk_config: Option<SdkConfig>,
    pub(crate) request_timeout: Duration,
    pub(crate) api_key: Option<String>,
}

/// The AWS SDK transport, building its client on first use so construction stays synchronous.
pub(crate) struct SdkTransport {
    options: ClientOptions,
    client: OnceCell<Client>,
}

impl SdkTransport {
    pub(crate) fn new(options: ClientOptions) -> Self {
        Self {
            options,
            client: OnceCell::new(),
        }
    }

    async fn client(&self) -> Client {
        self.client.get_or_init(|| build_client(&self.options)).await.clone()
    }
}

fn inactivity_error(timeout: Duration) -> BedrockError {
    BedrockError::network(format!(
        "stream timed out after {} ms of inactivity",
        timeout.as_millis()
    ))
}

/// Builds the client: the shared config (given, or loaded from the default chain with the region
/// option), then the region (option, shared config, `us-west-2`), endpoint, credentials, the
/// request timeout as each attempt's timeout, stall detection off unless configured, app name and
/// API key.
pub(super) async fn build_client(options: &ClientOptions) -> Client {
    let sdk_config = match &options.sdk_config {
        Some(config) => config.clone(),
        None => {
            let mut loader = aws_config::defaults(BehaviorVersion::latest());
            if let Some(region) = &options.region {
                loader = loader.region(Region::new(region.clone()));
            }
            loader.load().await
        }
    };
    let region = options
        .region
        .clone()
        .map(Region::new)
        .or_else(|| sdk_config.region().cloned())
        .unwrap_or_else(|| Region::from_static(MODEL_DEFAULTS.bedrock.region.unwrap_or("us-west-2")));
    let mut builder = aws_sdk_bedrockruntime::config::Builder::from(&sdk_config).region(region);
    if let Some(endpoint_url) = &options.endpoint_url {
        builder = builder.endpoint_url(endpoint_url);
    }
    if let Some(credentials_provider) = &options.credentials_provider {
        builder = builder.credentials_provider(credentials_provider.clone());
    }
    // `request_timeout` bounds each attempt, so the SDK's retries each get the full time; other
    // timeouts in `sdk_config` stay.
    let timeouts = sdk_config
        .timeout_config()
        .map(TimeoutConfig::to_builder)
        .unwrap_or_default()
        .operation_attempt_timeout(options.request_timeout)
        .build();
    builder = builder.timeout_config(timeouts);
    // The request timeout bounds stream inactivity; the SDK's stall detection would fail a model
    // that pauses before its next event.
    if sdk_config.stalled_stream_protection().is_none() {
        builder = builder.stalled_stream_protection(StalledStreamProtectionConfig::disabled());
    }
    if sdk_config.app_name().is_none()
        && let Ok(app_name) = AppName::new(APP_NAME)
    {
        builder = builder.app_name(app_name);
    }
    if let Some(api_key) = &options.api_key {
        builder = builder
            .bearer_token(Token::new(api_key.clone(), None))
            .auth_scheme_preference([HTTP_BEARER_AUTH_SCHEME_ID]);
    }
    Client::from_conf(builder.build())
}

/// The request body: the Converse fields Bedrock defines, in the formatter's order.
fn converse_body(request: &JsonObject) -> Vec<u8> {
    let body: JsonObject = request
        .iter()
        .filter(|(key, _)| {
            let known = CONVERSE_BODY_KEYS.contains(&key.as_str());
            if !known && key.as_str() != "modelId" {
                tracing::warn!("key=<{key}> | ignoring request field the converse api does not define");
            }
            known
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    JsonValue::Object(body).to_string().into_bytes()
}

fn model_id(request: &JsonObject) -> String {
    request
        .get("modelId")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// A request mutation that replaces the serialized body with `body`.
fn with_body(
    body: Vec<u8>,
) -> impl Fn(&mut aws_smithy_runtime_api::client::orchestrator::HttpRequest) + Send + Sync + 'static {
    let body = Arc::new(body);
    move |request| {
        *request.body_mut() = SdkBody::from(body.as_slice());
        request.headers_mut().insert("content-length", body.len().to_string());
    }
}

#[async_trait]
impl BedrockTransport for SdkTransport {
    async fn converse_stream(&self, request: JsonObject) -> Result<ChunkStream, BedrockError> {
        let client = self.client().await;
        let send = client
            .converse_stream()
            .model_id(model_id(&request))
            .customize()
            .mutate_request(with_body(converse_body(&request)))
            .send();
        let output = send.await.map_err(BedrockError::from_sdk)?;
        let timeout = self.options.request_timeout;
        let mut receiver = output.stream;
        Ok(Box::pin(async_stream::stream! {
            loop {
                let Ok(received) = tokio::time::timeout(timeout, receiver.recv()).await else {
                    yield Err(inactivity_error(timeout));
                    return;
                };
                match received {
                    Ok(Some(event)) => yield Ok(wire::stream_event_to_json(&event)),
                    Ok(None) => return,
                    Err(error) => {
                        yield wire::stream_error_to_chunk(error);
                        return;
                    }
                }
            }
        }))
    }

    async fn converse(&self, request: JsonObject) -> Result<JsonObject, BedrockError> {
        let client = self.client().await;
        let send = client
            .converse()
            .model_id(model_id(&request))
            .customize()
            .mutate_request(with_body(converse_body(&request)))
            .send();
        let output = send.await.map_err(BedrockError::from_sdk)?;
        Ok(wire::converse_output_to_json(&output))
    }

    async fn count_tokens(&self, model_id: String, input: JsonObject) -> Result<Option<u64>, BedrockError> {
        let client = self.client().await;
        let body = serde_json::json!({"input": {"converse": input}})
            .to_string()
            .into_bytes();
        let send = client
            .count_tokens()
            .model_id(model_id)
            .customize()
            .mutate_request(with_body(body))
            .send();
        let output = send.await.map_err(BedrockError::from_sdk)?;
        Ok(u64::try_from(output.input_tokens).ok())
    }
}
