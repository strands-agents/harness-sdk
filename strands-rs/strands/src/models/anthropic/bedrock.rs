//! Claude on Amazon Bedrock's InvokeModel API: the Messages request body sent through the AWS SDK
//! for Rust, as `@anthropic-ai/bedrock-sdk`'s `AnthropicBedrock` client sends it.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use aws_sdk_bedrockruntime::Client;
use aws_sdk_bedrockruntime::config::http::HttpResponse;
use aws_sdk_bedrockruntime::error::{DisplayErrorContext, ProvideErrorMetadata, SdkError};
use aws_sdk_bedrockruntime::primitives::Blob;
use aws_sdk_bedrockruntime::types::ResponseStream;
use aws_sdk_bedrockruntime::types::error::ResponseStreamError;
use futures::future::BoxFuture;
use tokio::sync::OnceCell;

use super::client::{AnthropicClient, ClientRequest, EventStream};
use super::{AnthropicClientConfig, AnthropicModel, AnthropicModelOptions, client_betas, prepare_config};
use crate::error::{Error, Result};
use crate::models::bedrock::transport::{ClientOptions, build_client};
use crate::models::bedrock::{DEFAULT_REQUEST_TIMEOUT, SdkConfig, SharedCredentialsProvider};
use crate::models::http::{ErrorPayload, HttpError, read_env};
use crate::types::JsonValue;

/// Routes an [`AnthropicModel`] to Claude on Amazon Bedrock's InvokeModel API
/// (`AnthropicBedrock`).
///
/// Passed to [`AnthropicModel::bedrock`]. The AWS SDK for Rust resolves credentials, region and
/// endpoint, signs and retries, as it does for [`BedrockModel`](crate::models::BedrockModel).
#[derive(Clone, Default, bon::Builder)]
pub struct AnthropicBedrockConfig {
    /// AWS region of the Bedrock endpoint; wins over `sdk_config` and the environment. Without one,
    /// the shared AWS config's region, else `us-west-2`.
    #[builder(into)]
    pub region: Option<String>,
    /// Endpoint URL override, such as a VPC endpoint. Defaults to `ANTHROPIC_BEDROCK_BASE_URL`;
    /// without either, the AWS SDK resolves it (including `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` and
    /// `AWS_ENDPOINT_URL`).
    #[builder(into)]
    pub endpoint_url: Option<String>,
    /// Credentials provider, replacing the default chain. This AWS SDK type is part of the public API
    /// as an escape hatch.
    pub credentials_provider: Option<SharedCredentialsProvider>,
    /// Shared AWS configuration to build the client from instead of loading the default chain. This
    /// AWS SDK type is part of the public API as an escape hatch.
    pub sdk_config: Option<SdkConfig>,
    /// Time each attempt may take until the response arrives, and the stream inactivity before a
    /// request is aborted. Default [`DEFAULT_REQUEST_TIMEOUT`].
    pub request_timeout: Option<Duration>,
    /// Amazon Bedrock API key: requests use bearer token authentication instead of SigV4. Without
    /// one, the AWS SDK reads `AWS_BEARER_TOKEN_BEDROCK`.
    #[builder(into)]
    pub api_key: Option<String>,
}

impl fmt::Debug for AnthropicBedrockConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let set = |present: bool| present.then_some("<set>");
        f.debug_struct("AnthropicBedrockConfig")
            .field("region", &self.region)
            .field("endpoint_url", &self.endpoint_url)
            .field("credentials_provider", &set(self.credentials_provider.is_some()))
            .field("sdk_config", &set(self.sdk_config.is_some()))
            .field("request_timeout", &self.request_timeout)
            .field("api_key", &set(self.api_key.is_some()))
            .finish()
    }
}

impl AnthropicModel {
    /// Creates the model on Claude through Amazon Bedrock's InvokeModel API, as an
    /// `AnthropicModel` with an `AnthropicBedrock` client.
    ///
    /// Requests carry `anthropic_version: "bedrock-2023-05-31"` unless `params` sets one, so the
    /// sampling params stay accepted, and betas travel in the body's `anthropic_beta`. Token counts
    /// are estimated: InvokeModel has no Messages token counting.
    ///
    /// ```no_run
    /// use strands::models::anthropic::{AnthropicBedrockConfig, AnthropicModel};
    ///
    /// # fn main() -> strands::Result<()> {
    /// let model = AnthropicModel::bedrock(
    ///     AnthropicModel::builder()
    ///         .model_id("global.anthropic.claude-opus-5-5")
    ///         .max_tokens(32_000)
    ///         .build_options(),
    ///     AnthropicBedrockConfig::builder().region("us-west-2").build(),
    /// )?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Errors
    ///
    /// Fails when `options` sets `api_key` or a `client_config` field other than `anthropic-beta`
    /// default headers, which the AWS SDK and `bedrock_config` replace, when `params` is not a JSON
    /// object, or when `anthropic_tools` holds anything but server tool objects.
    pub fn bedrock(options: impl Into<AnthropicModelOptions>, bedrock_config: AnthropicBedrockConfig) -> Result<Self> {
        Self::bedrock_with_env(options.into(), bedrock_config, &|name| std::env::var(name).ok())
    }

    pub(super) fn bedrock_with_env(
        options: AnthropicModelOptions,
        bedrock_config: AnthropicBedrockConfig,
        env: &dyn Fn(&str) -> Option<String>,
    ) -> Result<Self> {
        let (config, api_key, client_config) = options.into_parts();
        validate_bedrock_client_options(api_key.as_deref(), &client_config)?;
        let config = prepare_config(config)?;
        let AnthropicBedrockConfig {
            region,
            endpoint_url,
            credentials_provider,
            sdk_config,
            request_timeout,
            api_key,
        } = bedrock_config;
        let endpoint_url = endpoint_url.or_else(|| read_env(env, "ANTHROPIC_BEDROCK_BASE_URL"));
        let client = BedrockRuntimeClient::new(ClientOptions {
            region,
            endpoint_url,
            credentials_provider,
            sdk_config,
            request_timeout: request_timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT),
            api_key,
        });
        Ok(Self::from_client(
            config,
            Arc::new(client),
            client_betas(&client_config),
            None,
            true,
        ))
    }
}

fn validate_bedrock_client_options(api_key: Option<&str>, client_config: &AnthropicClientConfig) -> Result<()> {
    if api_key.is_some_and(|key| !key.is_empty()) {
        return Err(Error::other(
            "api_key is not used on Bedrock: set AnthropicBedrockConfig::api_key for an Amazon Bedrock API key",
        ));
    }
    if client_config.base_url.is_some() {
        return Err(Error::other(
            "client_config.base_url is not used on Bedrock: set AnthropicBedrockConfig::endpoint_url",
        ));
    }
    if client_config.max_retries.is_some() || client_config.timeout.is_some() {
        return Err(Error::other(
            "client_config.max_retries and client_config.timeout are not used on Bedrock: the AWS SDK retries, and AnthropicBedrockConfig::request_timeout bounds each attempt",
        ));
    }
    if let Some((name, _)) = client_config
        .default_headers
        .iter()
        .find(|(name, _)| !name.eq_ignore_ascii_case("anthropic-beta"))
    {
        return Err(Error::other(format!(
            "client_config.default_headers['{name}'] is not used on Bedrock: only anthropic-beta is sent, in the request body"
        )));
    }
    Ok(())
}

/// Messages requests over InvokeModel.
struct BedrockRuntimeClient {
    options: ClientOptions,
    client: Arc<OnceCell<Client>>,
}

impl BedrockRuntimeClient {
    fn new(options: ClientOptions) -> Self {
        Self {
            options,
            client: Arc::new(OnceCell::new()),
        }
    }
}

impl AnthropicClient for BedrockRuntimeClient {
    fn stream(&self, request: ClientRequest) -> EventStream {
        let client = Arc::clone(&self.client);
        let options = self.options.clone();
        Box::pin(async_stream::stream! {
            let (model_id, body) = match invoke_model_request(request) {
                Ok(request) => request,
                Err(error) => {
                    yield Err(error);
                    return;
                }
            };
            let client = client.get_or_init(|| build_client(&options)).await.clone();
            let send = client
                .invoke_model_with_response_stream()
                .model_id(model_id)
                .content_type("application/json")
                .accept("application/json")
                .body(Blob::new(body))
                .send();
            let output = match send.await {
                Ok(output) => output,
                Err(error) => {
                    yield Err(send_error(error));
                    return;
                }
            };
            let timeout = options.request_timeout;
            let mut receiver = output.body;
            loop {
                let Ok(received) = tokio::time::timeout(timeout, receiver.recv()).await else {
                    yield Err(HttpError::timeout());
                    return;
                };
                match received {
                    Ok(Some(ResponseStream::Chunk(part))) => {
                        let bytes = part.bytes.map(Blob::into_inner).unwrap_or_default();
                        match serde_json::from_slice(&bytes) {
                            Ok(event) => yield Ok(event),
                            Err(error) => {
                                yield Err(HttpError::decode(format!("could not decode a Bedrock stream chunk: {error}"), error));
                                return;
                            }
                        }
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => return,
                    Err(error) => {
                        yield Err(stream_error(error));
                        return;
                    }
                }
            }
        })
    }

    fn beta_stream(&self, request: ClientRequest) -> Option<EventStream> {
        Some(self.stream(request))
    }

    fn count_tokens(
        &self,
        _request: ClientRequest,
    ) -> Option<BoxFuture<'static, std::result::Result<JsonValue, HttpError>>> {
        None
    }
}

/// The model id and InvokeModel body of a Messages request: the model moves to the path, `stream`
/// is dropped (the streaming operation implies it), and the betas move into `anthropic_beta`.
fn invoke_model_request(request: ClientRequest) -> std::result::Result<(String, Vec<u8>), HttpError> {
    let JsonValue::Object(mut body) = request.body else {
        return Err(HttpError::request(
            "the Messages request body is not a JSON object",
            None,
        ));
    };
    let model_id = body
        .shift_remove("model")
        .and_then(|model| model.as_str().map(str::to_owned))
        .unwrap_or_default();
    body.shift_remove("stream");
    if let Some(beta) = request.beta.filter(|_| !body.contains_key("anthropic_beta")) {
        let betas = beta.split(',').map(|beta| JsonValue::String(beta.to_owned())).collect();
        body.insert("anthropic_beta".to_owned(), JsonValue::Array(betas));
    }
    let body = serde_json::to_vec(&body)
        .map_err(|error| HttpError::request(format!("could not encode the request: {error}"), Some(error.into())))?;
    Ok((model_id, body))
}

/// An error response as the Anthropic SDK raises it: the status and the body's message.
fn send_error<E>(error: SdkError<E, HttpResponse>) -> HttpError
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
{
    match &error {
        SdkError::ServiceError(context) => {
            let status = context.raw().status().as_u16();
            let body = serde_json::json!({"message": context.err().message().unwrap_or_default()});
            HttpError::status(status, Some(body), "", ErrorPayload::Body)
        }
        SdkError::TimeoutError(_) => HttpError::timeout(),
        SdkError::ConstructionFailure(_) => {
            HttpError::request(DisplayErrorContext(&error).to_string(), Some(error.into()))
        }
        _ => HttpError::connection(error),
    }
}

/// An exception frame in the stream, which has no status: its type and message.
fn stream_error<R>(error: SdkError<ResponseStreamError, R>) -> HttpError
where
    R: fmt::Debug + Send + Sync + 'static,
{
    let SdkError::ServiceError(context) = &error else {
        return HttpError::connection(error);
    };
    let exception = context.err();
    exception_event(exception_type(exception), exception.message().unwrap_or_default())
}

fn exception_event(kind: &str, message: &str) -> HttpError {
    HttpError::event(&serde_json::json!({"type": kind, "message": message}).to_string())
}

/// The exception frame's `:exception-type`.
fn exception_type(error: &ResponseStreamError) -> &str {
    match error {
        ResponseStreamError::InternalServerException(_) => "internalServerException",
        ResponseStreamError::ModelStreamErrorException(_) => "modelStreamErrorException",
        ResponseStreamError::ValidationException(_) => "validationException",
        ResponseStreamError::ThrottlingException(_) => "throttlingException",
        ResponseStreamError::ModelTimeoutException(_) => "modelTimeoutException",
        ResponseStreamError::ServiceUnavailableException(_) => "serviceUnavailableException",
        other => other.code().unwrap_or("unknownException"),
    }
}

#[cfg(test)]
mod tests {
    use aws_sdk_bedrockruntime::types::error::{ModelStreamErrorException, ThrottlingException};
    use serde_json::json;

    use super::*;

    fn body(bytes: &[u8]) -> JsonValue {
        serde_json::from_slice(bytes).unwrap()
    }

    #[test]
    fn moves_the_model_to_the_path_drops_stream_and_sends_the_betas_in_the_body() {
        let request = ClientRequest {
            body: json!({"model": "global.anthropic.claude-opus-5-5", "max_tokens": 10, "messages": [], "stream": true, "anthropic_version": "bedrock-2023-05-31"}),
            beta: Some("a,thinking-binding-controls-2026-08-01".to_owned()),
        };
        let (model_id, bytes) = invoke_model_request(request).unwrap();
        assert_eq!(model_id, "global.anthropic.claude-opus-5-5");
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            r#"{"max_tokens":10,"messages":[],"anthropic_version":"bedrock-2023-05-31","anthropic_beta":["a","thinking-binding-controls-2026-08-01"]}"#
        );
    }

    #[test]
    fn keeps_anthropic_beta_set_in_the_body() {
        let request = ClientRequest {
            body: json!({"model": "m", "anthropic_beta": ["own"]}),
            beta: Some("other".to_owned()),
        };
        let (_, bytes) = invoke_model_request(request).unwrap();
        assert_eq!(body(&bytes), json!({"anthropic_beta": ["own"]}));
    }

    #[test]
    fn maps_exception_frames_to_their_type_and_message() {
        let throttle =
            ResponseStreamError::ThrottlingException(ThrottlingException::builder().message("Too many tokens").build());
        let stream = ResponseStreamError::ModelStreamErrorException(
            ModelStreamErrorException::builder().message("broken").build(),
        );
        assert_eq!(exception_type(&throttle), "throttlingException");
        assert_eq!(exception_type(&stream), "modelStreamErrorException");
        let error = exception_event(exception_type(&throttle), "Too many tokens");
        assert_eq!(error.message(), "Too many tokens");
        assert_eq!(
            error.body(),
            Some(&json!({"type": "throttlingException", "message": "Too many tokens"}))
        );
    }

    #[test]
    fn rejects_client_options_bedrock_does_not_use() {
        let env = |_: &str| None;
        let reject = |options: AnthropicModelOptions, expected: &str| {
            let error = AnthropicModel::bedrock_with_env(options, AnthropicBedrockConfig::default(), &env).unwrap_err();
            assert!(error.to_string().contains(expected), "{error}");
        };
        reject(
            AnthropicModel::builder().api_key("key").build_options(),
            "api_key is not used on Bedrock",
        );
        let base_url = AnthropicClientConfig {
            base_url: Some("https://example.com".to_owned()),
            ..Default::default()
        };
        reject(
            AnthropicModel::builder().client_config(base_url).build_options(),
            "client_config.base_url",
        );
        let header = AnthropicClientConfig {
            default_headers: vec![("anthropic-version".to_owned(), "2023-06-01".to_owned())],
            ..Default::default()
        };
        reject(
            AnthropicModel::builder().client_config(header).build_options(),
            "default_headers['anthropic-version']",
        );
        let betas = AnthropicClientConfig {
            default_headers: vec![("anthropic-beta".to_owned(), "a".to_owned())],
            ..Default::default()
        };
        AnthropicModel::bedrock_with_env(
            AnthropicModel::builder()
                .model_id("m")
                .client_config(betas)
                .build_options(),
            AnthropicBedrockConfig::default(),
            &env,
        )
        .unwrap();
    }

    #[test]
    fn redacts_credentials_in_debug_output() {
        let config = AnthropicBedrockConfig::builder()
            .region("us-west-2")
            .api_key("secret")
            .build();
        let debug = format!("{config:?}");
        assert!(
            debug.contains("us-west-2") && debug.contains("<set>") && !debug.contains("secret"),
            "{debug}"
        );
    }
}
