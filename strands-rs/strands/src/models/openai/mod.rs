//! The OpenAI provider, behind the `openai` feature.
//!
//! [`OpenAIModel`] streams from the Responses API by default, or from Chat Completions with
//! [`OpenAIApi::Chat`], over HTTP with the official OpenAI SDK's transport behaviour (retries,
//! timeout, error texts). It maps every content block, the system prompt, tool specs and tool
//! choice, prompt caching ([`CacheConfig`]), server-managed conversation state on the Responses API
//! ([`OpenAIModelConfig::stateful`]) and OpenAI's built-in tools, such as the native `web_search`,
//! through [`OpenAIModelConfig::params`]. With the `mantle` feature,
//! [`OpenAIModel::bedrock_mantle`] routes the model through Amazon Bedrock's OpenAI-compatible
//! Mantle endpoint.
//!
//! ```
//! use strands::models::openai::{OpenAIApi, OpenAIModel};
//! use strands::models::Model;
//!
//! # fn main() -> strands::Result<()> {
//! // Responses API (default)
//! let model = OpenAIModel::builder().model_id("gpt-5.4").api_key("sk-...").build()?;
//! assert_eq!(model.model_id().as_deref(), Some("gpt-5.4"));
//!
//! // Chat Completions
//! let chat = OpenAIModel::builder()
//!     .api(OpenAIApi::Chat)
//!     .model_id("gpt-5.4")
//!     .api_key("sk-...")
//!     .build()?;
//! assert_eq!(chat.api(), OpenAIApi::Chat);
//! # Ok(())
//! # }
//! ```
//!
//! An agent on the Responses API with the built-in web search (the API key comes from
//! `OPENAI_API_KEY`):
//!
//! ```no_run
//! use serde_json::json;
//! use strands::Agent;
//! use strands::models::openai::OpenAIModel;
//!
//! # async fn run() -> strands::Result<()> {
//! let model = OpenAIModel::builder()
//!     .model_id("gpt-5.4")
//!     .params(json!({"tools": [{"type": "web_search"}]}))
//!     .build()?;
//! let mut agent = Agent::builder().model(model).build()?;
//! let result = agent.invoke("What changed in the latest Rust release?").await?;
//! println!("{result}");
//! # Ok(())
//! # }
//! ```

mod cache;
mod chat;
mod client;
mod errors;
mod formatting;
#[cfg(feature = "mantle")]
mod mantle;
mod responses;

use std::fmt;
use std::future::Future;
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use futures::future::BoxFuture;

use self::chat::{ChatStreamState, format_chat_request, map_chat_chunk, warn_chat_managed_params};
use self::client::{CHAT_COMPLETIONS_PATH, Env, EventStream, HttpOpenAIClient, OpenAIClient, RESPONSES_PATH};
use self::errors::{OpenAIErrorKind, classify_openai_error};
use self::formatting::{positive_count, token_count};
use self::open_a_i_model_options_builder::IsComplete;

use self::responses::{
    ResponsesStreamError, ResponsesStreamState, finalize_responses_stream, format_responses_request,
    map_responses_event, warn_responses_managed_params,
};
use super::defaults::{MODEL_DEFAULTS, default_model_warning_message};
use super::http::{HttpError, RedactedHeaders, read_env};
use super::model_info::server_side_summary_off;
use super::streaming::{ModelMetadataEvent, ModelStreamEvent, Usage};
use super::{
    BaseModelConfig, BoxStream, CacheConfig, Model, ModelCapabilities, ModelInfo, ModelRequest, base_model_info,
    resolve_config_metadata,
};
use crate::cancel::CancelSignal;
use crate::error::{
    BoxError, ContextWindowOverflowError, Error, ModelError, ModelNetworkError, ModelThrottledError, Result,
};
use crate::logging::warn_once;
use crate::types::JsonValue;

#[cfg(feature = "mantle")]
pub use aws_credential_types::Credentials;
#[cfg(feature = "mantle")]
pub use aws_credential_types::provider::SharedCredentialsProvider;
#[cfg(feature = "mantle")]
pub use mantle::BedrockMantleConfig;

/// The message of a request cancelled through its signal (the SDK's `APIUserAbortError`).
const ABORTED_MESSAGE: &str = "Request was aborted.";

/// Which OpenAI API a model streams from (`OpenAIApi`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum OpenAIApi {
    /// Chat Completions (`'chat'`), always stateless.
    Chat,
    /// The Responses API (`'responses'`), optionally with server-managed conversation state.
    #[default]
    Responses,
}

impl OpenAIApi {
    /// The API's name: `"chat"` or `"responses"`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Responses => "responses",
        }
    }
}

impl fmt::Display for OpenAIApi {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

crate::callback::callback! {
    /// A function returning an API key, called before each request (the SDK's `ApiKeySetter`).
    pub struct ApiKeySetter(Fn() -> BoxFuture<'static, std::result::Result<String, BoxError>>);
}

/// An OpenAI API key: a fixed key or a function called before each request. Strings convert into
/// [`ApiKey::Key`].
#[derive(Clone)]
#[non_exhaustive]
pub enum ApiKey {
    /// A fixed key.
    Key(String),
    /// A function returning the key, called before each request.
    Setter(ApiKeySetter),
}

impl ApiKey {
    /// An API key resolved by `setter` before each request, such as a short-lived token.
    pub fn setter<F, Fut>(setter: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = std::result::Result<String, BoxError>> + Send + 'static,
    {
        Self::Setter(ApiKeySetter::new(move || Box::pin(setter())))
    }
}

impl From<&str> for ApiKey {
    fn from(key: &str) -> Self {
        Self::Key(key.to_owned())
    }
}

impl From<String> for ApiKey {
    fn from(key: String) -> Self {
        Self::Key(key)
    }
}

impl PartialEq for ApiKey {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Key(left), Self::Key(right)) => left == right,
            (Self::Setter(left), Self::Setter(right)) => Arc::ptr_eq(&left.0, &right.0),
            _ => false,
        }
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Key(_) => f.write_str("Key(<redacted>)"),
            Self::Setter(_) => f.write_str("Setter(<function>)"),
        }
    }
}

/// Configuration of an [`OpenAIModel`] (`OpenAIModelConfig`): the [`BaseModelConfig`] fields and
/// the OpenAI ones, for both APIs.
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
pub struct OpenAIModelConfig {
    /// The model id, such as `gpt-5.4`, `gpt-5.4-mini` or `gpt-4o`. Defaults to `gpt-5.4`, which
    /// can change between versions.
    #[builder(into)]
    pub model_id: Option<String>,
    /// Maximum tokens to generate (`max_completion_tokens` on Chat Completions,
    /// `max_output_tokens` on the Responses API).
    pub max_tokens: Option<u64>,
    /// Controls randomness in generation.
    pub temperature: Option<f64>,
    /// Nucleus sampling.
    pub top_p: Option<f64>,
    /// Context window size in tokens; filled from the shared model info when unset.
    pub context_window_limit: Option<u64>,
    /// Overrides for what the SDK knows about the model.
    pub model_info: Option<ModelInfo>,
    /// Extra request fields, for parameters without a config field. Built-in Responses tools go
    /// here, before the agent's tools: `{"tools": [{"type": "web_search"}]}`. The provider
    /// manages `model`, `messages`, `stream` and `stream_options` (Chat Completions) and `model`,
    /// `input`, `stream` and `store` (Responses); a warning is logged when `params` holds any of
    /// them, and the provider's values win. Must be a JSON object, such as a `json!({..})`
    /// literal.
    pub params: Option<JsonValue>,
    /// Prompt caching. On the Responses API, models whose model info says they take cache points
    /// (GPT-5.6 and later) cache durable conversation prefixes before temporary context;
    /// `messages_ttl: false` turns that off. There, a `"30m"` or `"12h"` `messages_ttl` sets each
    /// checkpoint's `ttl`, and such a `ttl` sets `prompt_cache_options.ttl`. Older models and Chat
    /// Completions cache implicitly. `cache_key` maps to `prompt_cache_key` and the retention
    /// literals (`"in_memory"`, `"24h"`) to `prompt_cache_retention`. Caching fields in `params` win.
    /// Checkpoints do not remove injected content that a stateful server-side conversation keeps.
    pub cache_config: Option<CacheConfig>,
    /// Reduces repetition of token sequences (-2.0 to 2.0). Chat Completions only.
    pub frequency_penalty: Option<f64>,
    /// Encourages the model to talk about new topics (-2.0 to 2.0). Chat Completions only.
    pub presence_penalty: Option<f64>,
    /// Whether the server manages conversation state (Responses API only): requests set
    /// `store: true` and chain turns through `previous_response_id`, and the agent keeps no local
    /// history. Default `false`, which sends the whole history on every turn. Set at construction;
    /// [`OpenAIModel::update_config`] ignores it with a warning.
    pub stateful: Option<bool>,
}

impl OpenAIModelConfig {
    /// Shallow-merges `update` into `self`: every field `update` sets replaces the current value.
    pub fn merge(&mut self, update: Self) {
        let Self {
            model_id,
            max_tokens,
            temperature,
            top_p,
            context_window_limit,
            model_info,
            params,
            cache_config,
            frequency_penalty,
            presence_penalty,
            stateful,
        } = update;
        self.model_id = model_id.or(self.model_id.take());
        self.max_tokens = max_tokens.or(self.max_tokens);
        self.temperature = temperature.or(self.temperature);
        self.top_p = top_p.or(self.top_p);
        self.context_window_limit = context_window_limit.or(self.context_window_limit);
        self.model_info = model_info.or(self.model_info.take());
        self.params = params.or(self.params.take());
        self.cache_config = cache_config.or(self.cache_config.take());
        self.frequency_penalty = frequency_penalty.or(self.frequency_penalty);
        self.presence_penalty = presence_penalty.or(self.presence_penalty);
        self.stateful = stateful.or(self.stateful);
    }

    /// The [`BaseModelConfig`] fields of this configuration.
    #[must_use]
    pub fn to_base(&self) -> BaseModelConfig {
        BaseModelConfig {
            model_id: self.model_id.clone(),
            max_tokens: self.max_tokens,
            temperature: self.temperature,
            top_p: self.top_p,
            context_window_limit: self.context_window_limit,
            model_info: self.model_info.clone(),
        }
    }
}

impl From<BaseModelConfig> for OpenAIModelConfig {
    fn from(config: BaseModelConfig) -> Self {
        Self {
            model_id: config.model_id,
            max_tokens: config.max_tokens,
            temperature: config.temperature,
            top_p: config.top_p,
            context_window_limit: config.context_window_limit,
            model_info: config.model_info,
            ..Self::default()
        }
    }
}

/// How the client reaches the OpenAI API.
///
/// `Debug` redacts the values of credential headers (`authorization`, `proxy-authorization`,
/// `x-api-key`, `api-key`, `cookie`).
#[derive(Clone, Default, PartialEq, Eq, bon::Builder)]
pub struct OpenAIClientConfig {
    /// The API base URL. Defaults to `OPENAI_BASE_URL`, else `https://api.openai.com/v1`.
    #[builder(into)]
    pub base_url: Option<String>,
    /// The `OpenAI-Organization` header. Defaults to `OPENAI_ORG_ID`.
    #[builder(into)]
    pub organization: Option<String>,
    /// The `OpenAI-Project` header. Defaults to `OPENAI_PROJECT_ID`.
    #[builder(into)]
    pub project: Option<String>,
    /// Headers sent with every request, after those in `OPENAI_CUSTOM_HEADERS`; a later header
    /// replaces an earlier one with the same name, and these replace the provider's own,
    /// `Authorization` included.
    #[builder(default)]
    pub default_headers: Vec<(String, String)>,
    /// Retries on connection errors, timeouts, 408, 409, 429 and 5xx responses. Default 2.
    pub max_retries: Option<u32>,
    /// Time each attempt may wait for the response headers. Default 10 minutes.
    pub timeout: Option<Duration>,
}

impl fmt::Debug for OpenAIClientConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAIClientConfig")
            .field("base_url", &self.base_url)
            .field("organization", &self.organization)
            .field("project", &self.project)
            .field("default_headers", &RedactedHeaders(&self.default_headers))
            .field("max_retries", &self.max_retries)
            .field("timeout", &self.timeout)
            .finish()
    }
}

/// Options for [`OpenAIModel::new`] (`OpenAIModelOptions`): the API, the [`OpenAIModelConfig`]
/// fields and the client ones.
///
/// [`OpenAIModel::builder`] builds them and the model in one go; the options' own builder ends
/// with [`build_options`](OpenAIModelOptionsBuilder::build_options).
#[derive(Clone, Default, bon::Builder)]
#[builder(finish_fn = build_options)]
pub struct OpenAIModelOptions {
    /// The API to stream from. Default [`OpenAIApi::Responses`]. Set at construction only.
    #[builder(default)]
    pub api: OpenAIApi,
    /// See [`OpenAIModelConfig::model_id`].
    #[builder(into)]
    pub model_id: Option<String>,
    /// See [`OpenAIModelConfig::max_tokens`].
    pub max_tokens: Option<u64>,
    /// See [`OpenAIModelConfig::temperature`].
    pub temperature: Option<f64>,
    /// See [`OpenAIModelConfig::top_p`].
    pub top_p: Option<f64>,
    /// See [`OpenAIModelConfig::context_window_limit`].
    pub context_window_limit: Option<u64>,
    /// See [`OpenAIModelConfig::model_info`].
    pub model_info: Option<ModelInfo>,
    /// See [`OpenAIModelConfig::params`].
    pub params: Option<JsonValue>,
    /// See [`OpenAIModelConfig::cache_config`].
    pub cache_config: Option<CacheConfig>,
    /// See [`OpenAIModelConfig::frequency_penalty`].
    pub frequency_penalty: Option<f64>,
    /// See [`OpenAIModelConfig::presence_penalty`].
    pub presence_penalty: Option<f64>,
    /// See [`OpenAIModelConfig::stateful`].
    pub stateful: Option<bool>,
    /// The API key, fixed or from a function called before each request. Defaults to
    /// `OPENAI_API_KEY`.
    #[builder(into)]
    pub api_key: Option<ApiKey>,
    /// How the client reaches the API.
    pub client_config: Option<OpenAIClientConfig>,
}

impl fmt::Debug for OpenAIModelOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut debug = f.debug_struct("OpenAIModelOptions");
        debug
            .field("api", &self.api)
            .field("config", &self.clone().into_parts().config)
            .field("api_key", &self.api_key)
            .field("client_config", &self.client_config);
        debug.finish()
    }
}

/// The options split into what the model keeps and what builds its client.
struct OptionParts {
    api: OpenAIApi,
    config: OpenAIModelConfig,
    api_key: Option<ApiKey>,
    client_config: OpenAIClientConfig,
}

impl OpenAIModelOptions {
    fn into_parts(self) -> OptionParts {
        let config = OpenAIModelConfig {
            model_id: self.model_id,
            max_tokens: self.max_tokens,
            temperature: self.temperature,
            top_p: self.top_p,
            context_window_limit: self.context_window_limit,
            model_info: self.model_info,
            params: self.params,
            cache_config: self.cache_config,
            frequency_penalty: self.frequency_penalty,
            presence_penalty: self.presence_penalty,
            stateful: self.stateful,
        };
        OptionParts {
            api: self.api,
            config,
            api_key: self.api_key,
            client_config: self.client_config.unwrap_or_default(),
        }
    }
}

impl From<OpenAIModelConfig> for OpenAIModelOptions {
    fn from(config: OpenAIModelConfig) -> Self {
        let OpenAIModelConfig {
            model_id,
            max_tokens,
            temperature,
            top_p,
            context_window_limit,
            model_info,
            params,
            cache_config,
            frequency_penalty,
            presence_penalty,
            stateful,
        } = config;
        Self {
            model_id,
            max_tokens,
            temperature,
            top_p,
            context_window_limit,
            model_info,
            params,
            cache_config,
            frequency_penalty,
            presence_penalty,
            stateful,
            ..Self::default()
        }
    }
}

impl<S: IsComplete> OpenAIModelOptionsBuilder<S> {
    /// Builds the model ([`OpenAIModel::new`]).
    ///
    /// # Errors
    ///
    /// See [`OpenAIModel::new`].
    pub fn build(self) -> Result<OpenAIModel> {
        OpenAIModel::new(self.build_options())
    }
}

/// A model on the OpenAI Responses or Chat Completions API (`OpenAIModel`).
///
/// Cheap to clone and to share as `Arc<dyn Model>`: clones share one configuration and one HTTP
/// client, so [`update_config`](Self::update_config) on any clone changes them all.
#[derive(Clone)]
pub struct OpenAIModel {
    inner: Arc<Inner>,
}

impl fmt::Debug for OpenAIModel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAIModel")
            .field("api", &self.inner.api)
            .field("config", &self.inner.config())
            .finish_non_exhaustive()
    }
}

struct Inner {
    api: OpenAIApi,
    config: RwLock<OpenAIModelConfig>,
    client: RwLock<Arc<dyn OpenAIClient>>,
    #[cfg(feature = "mantle")]
    mantle: Option<RwLock<mantle::MantleRoute>>,
}

impl OpenAIModel {
    /// Starts building a model from [`OpenAIModelOptions`] fields.
    pub fn builder() -> OpenAIModelOptionsBuilder {
        OpenAIModelOptions::builder()
    }

    /// Creates the model from options or a bare model configuration.
    ///
    /// Logs a one-time warning when `model_id` falls back to its default, and a warning for each
    /// provider-managed key in `params`.
    ///
    /// # Errors
    ///
    /// Fails when `params` is not a JSON object, when there is no API key in the options or
    /// `OPENAI_API_KEY`, or when the HTTP client cannot be built (an invalid base URL or header).
    pub fn new(options: impl Into<OpenAIModelOptions>) -> Result<Self> {
        Self::with_env(options.into(), &|name| std::env::var(name).ok())
    }

    fn with_env(options: OpenAIModelOptions, env: Env<'_>) -> Result<Self> {
        let parts = options.into_parts();
        let config = prepare_config(parts.api, parts.config)?;
        let has_key = match &parts.api_key {
            Some(ApiKey::Key(key)) => !key.is_empty(),
            Some(ApiKey::Setter(_)) => true,
            None => false,
        };
        let has_env_key = read_env(env, "OPENAI_API_KEY").is_some();
        if !has_key && !has_env_key {
            return Err(Error::other(
                "OpenAI API key is required. Provide it via the 'api_key' option (string or function) or set the OPENAI_API_KEY environment variable.",
            ));
        }
        let api_key = parts.api_key.filter(|_| has_key);
        let client = HttpOpenAIClient::new(api_key.as_ref(), None, &parts.client_config, env).map_err(model_error)?;
        Ok(Self::from_parts(parts.api, config, Arc::new(client)))
    }

    fn from_parts(api: OpenAIApi, config: OpenAIModelConfig, client: Arc<dyn OpenAIClient>) -> Self {
        Self::from_inner(Inner {
            api,
            config: RwLock::new(config),
            client: RwLock::new(client),
            #[cfg(feature = "mantle")]
            mantle: None,
        })
    }

    fn from_inner(inner: Inner) -> Self {
        Self { inner: Arc::new(inner) }
    }

    /// The API this model streams from, set at construction.
    #[must_use]
    pub fn api(&self) -> OpenAIApi {
        self.inner.api
    }

    /// The configuration, with `context_window_limit` filled from the model info when unset.
    /// `model_id` stays unset when the default is used; [`Model::model_id`] reports the id requests
    /// send.
    #[must_use]
    pub fn config(&self) -> OpenAIModelConfig {
        resolve(&self.inner.config())
    }

    /// Merges `config` into the configuration: every field it sets replaces the current value.
    /// Takes a [`BaseModelConfig`] too.
    ///
    /// `stateful` is construction-only: it is ignored with a warning, since changing it would break
    /// the agent's history handling and `previous_response_id` chaining. On a
    /// [`bedrock_mantle`](Self::bedrock_mantle) model, a `model_id` on the other base path rebuilds
    /// the client against the new base URL.
    ///
    /// # Errors
    ///
    /// Fails, leaving the configuration unchanged, when `params` is not a JSON object or the
    /// rebuilt Mantle client cannot be built.
    pub fn update_config(&self, config: impl Into<OpenAIModelConfig>) -> Result<()> {
        let mut config = config.into();
        if let Some(stateful) = config.stateful.take() {
            tracing::warn!(
                "stateful=<{stateful}> | 'stateful' is construction-only and cannot be changed via update_config — ignoring"
            );
        }
        #[cfg(feature = "mantle")]
        if let Some(model_id) = &config.model_id {
            self.inner.reroute_mantle(model_id)?;
        }
        validate_params(&config)?;
        warn_managed_params(self.inner.api, config.params.as_ref());
        self.inner.write_config().merge(config);
        Ok(())
    }
}

fn model_error(error: HttpError) -> Error {
    ModelError::new(error.to_string()).with_source(error).into()
}

fn warn_managed_params(api: OpenAIApi, params: Option<&JsonValue>) {
    let params = params.and_then(JsonValue::as_object);
    match api {
        OpenAIApi::Chat => warn_chat_managed_params(params),
        OpenAIApi::Responses => warn_responses_managed_params(params),
    }
}

/// Checks that `params` is a JSON object.
fn validate_params(config: &OpenAIModelConfig) -> Result<()> {
    if config.params.as_ref().is_some_and(|params| !params.is_object()) {
        return Err(Error::other("'params' must be a JSON object"));
    }
    Ok(())
}

/// Validates the configuration and warns once about the default model id and about
/// provider-managed `params` keys.
fn prepare_config(api: OpenAIApi, config: OpenAIModelConfig) -> Result<OpenAIModelConfig> {
    validate_params(&config)?;
    if config.model_id.is_none() {
        warn_once(&default_model_warning_message(MODEL_DEFAULTS.openai.model_id));
    }
    warn_managed_params(api, config.params.as_ref());
    Ok(config)
}

fn model_id_of(config: &OpenAIModelConfig) -> &str {
    config.model_id.as_deref().unwrap_or(MODEL_DEFAULTS.openai.model_id)
}

/// The configuration with the context window filled in.
fn resolve(config: &OpenAIModelConfig) -> OpenAIModelConfig {
    let base = resolve_config_metadata(config.to_base(), model_id_of(config));
    OpenAIModelConfig {
        context_window_limit: base.context_window_limit,
        ..config.clone()
    }
}

/// The model info: the base layers for the id requests send, server-side summaries off, whether
/// the model is stateful (Responses with `stateful` only), and the user's override on top.
fn model_info_of(api: OpenAIApi, config: &OpenAIModelConfig) -> ModelInfo {
    let mut base = resolve(config).to_base();
    base.model_id = Some(model_id_of(config).to_owned());
    let stateful = ModelInfo {
        capabilities: ModelCapabilities {
            stateful: Some(api == OpenAIApi::Responses && config.stateful == Some(true)),
            ..ModelCapabilities::default()
        },
        ..ModelInfo::default()
    };
    ModelInfo::merge([
        Some(&base_model_info(&base)),
        Some(&server_side_summary_off()),
        Some(&stateful),
        config.model_info.as_ref(),
    ])
}

/// Why a request failed, before translation to SDK errors.
enum StreamFailure {
    Http(HttpError),
    Response(ResponsesStreamError),
    Aborted,
}

impl StreamFailure {
    fn message(&self) -> String {
        match self {
            Self::Http(error) => error.message().to_owned(),
            Self::Response(error) => error.message.clone(),
            Self::Aborted => ABORTED_MESSAGE.to_owned(),
        }
    }

    /// The error's `code`: the error object's in an error body or event, the response error's.
    fn code(&self) -> Option<JsonValue> {
        match self {
            Self::Http(error) => error
                .body()
                .and_then(|body| body.get("error"))
                .and_then(|error| error.get("code"))
                .cloned(),
            Self::Response(error) => error.code.clone().map(JsonValue::String),
            Self::Aborted => None,
        }
    }
}

/// Maps throttling and context overflow to the SDK's error types, transport failures to
/// `ModelNetworkError` and the rest to `ModelError`, keeping the original as source.
fn translate_error(failure: StreamFailure) -> Error {
    let message = failure.message();
    let status = match &failure {
        StreamFailure::Http(error) => error.status_code(),
        _ => None,
    };
    let code = failure.code();
    match classify_openai_error(&message, status, code.as_ref()) {
        Some(OpenAIErrorKind::Throttling) => {
            tracing::debug!("throttled | error_message=<{message}>");
            let throttled = ModelThrottledError::new(message);
            return match failure {
                StreamFailure::Http(error) => throttled.with_source(error).into(),
                StreamFailure::Response(error) => throttled.with_source(error).into(),
                StreamFailure::Aborted => throttled.into(),
            };
        }
        Some(OpenAIErrorKind::ContextOverflow) => return ContextWindowOverflowError::new(message).into(),
        None => {}
    }
    match failure {
        StreamFailure::Http(error) if error.is_network() => ModelNetworkError::new(message).with_source(error).into(),
        StreamFailure::Http(error) => ModelError::new(message).with_source(error).into(),
        StreamFailure::Response(error) => ModelError::new(message).with_source(error).into(),
        StreamFailure::Aborted => ModelError::new(message).into(),
    }
}

/// The next event, or `None` once `cancel` fires, which drops the in-flight request.
async fn next_event(
    events: &mut EventStream,
    cancel: Option<&CancelSignal>,
) -> Option<Option<std::result::Result<JsonValue, HttpError>>> {
    let Some(cancel) = cancel else {
        return Some(events.next().await);
    };
    tokio::select! {
        biased;
        () = cancel.cancelled() => None,
        event = events.next() => Some(event),
    }
}

/// The usage of a Chat Completions chunk, with prompt-cache reads and writes.
fn chat_usage(usage: &JsonValue) -> Usage {
    let count = |key| token_count(usage.get(key)).unwrap_or_default();
    let mut mapped = Usage::new(
        count("prompt_tokens"),
        count("completion_tokens"),
        count("total_tokens"),
    );
    let details = usage.get("prompt_tokens_details");
    if let Some(cached) = positive_count(details.and_then(|details| details.get("cached_tokens"))) {
        mapped = mapped.with_cache_read_input_tokens(cached);
    }
    if let Some(written) = positive_count(details.and_then(|details| details.get("cache_write_tokens"))) {
        mapped = mapped.with_cache_write_input_tokens(written);
    }
    mapped
}

impl Inner {
    fn config(&self) -> OpenAIModelConfig {
        self.config.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn write_config(&self) -> std::sync::RwLockWriteGuard<'_, OpenAIModelConfig> {
        self.config.write().unwrap_or_else(PoisonError::into_inner)
    }

    fn client(&self) -> Arc<dyn OpenAIClient> {
        Arc::clone(&self.client.read().unwrap_or_else(PoisonError::into_inner))
    }

    fn stateful(&self) -> bool {
        model_info_of(self.api, &self.config()).capabilities.stateful == Some(true)
    }

    fn stream(self: Arc<Self>, request: ModelRequest) -> BoxStream<'static, Result<ModelStreamEvent>> {
        if request.messages.is_empty() {
            return Box::pin(futures::stream::once(async {
                Err(Error::other("At least one message is required"))
            }));
        }
        match self.api {
            OpenAIApi::Chat => self.stream_chat(request),
            OpenAIApi::Responses => self.stream_responses(request),
        }
    }

    fn stream_chat(self: Arc<Self>, request: ModelRequest) -> BoxStream<'static, Result<ModelStreamEvent>> {
        Box::pin(async_stream::stream! {
            let config = self.config();
            let body = match format_chat_request(&config, &request) {
                Ok(body) => body,
                Err(error) => {
                    yield Err(error);
                    return;
                }
            };
            let cancel = request.cancel_signal.as_ref();
            let mut events = self.client().stream(CHAT_COMPLETIONS_PATH, JsonValue::Object(body));
            let mut state = ChatStreamState::default();
            let mut buffered_usage: Option<Usage> = None;
            loop {
                let Some(event) = next_event(&mut events, cancel).await else {
                    // Closes the connection before the consumer sees the abort.
                    drop(events);
                    yield Err(translate_error(StreamFailure::Aborted));
                    return;
                };
                let Some(event) = event else {
                    break;
                };
                let chunk = match event {
                    Ok(chunk) => chunk,
                    Err(error) => {
                        drop(events);
                        yield Err(translate_error(StreamFailure::Http(error)));
                        return;
                    }
                };
                // OpenAI sends usage on a trailing chunk without choices; some compatible
                // providers (OpenRouter) put it on the chunk with the finish reason.
                if let Some(usage) = chunk.get("usage").filter(|usage| usage.is_object()) {
                    buffered_usage = Some(chat_usage(usage));
                }
                for event in map_chat_chunk(&chunk, &mut state) {
                    if matches!(event, ModelStreamEvent::MessageStop(_))
                        && let Some(usage) = buffered_usage.take()
                    {
                        yield Ok(ModelMetadataEvent::new().with_usage(usage).into());
                    }
                    yield Ok(event);
                }
            }
            drop(events);
            if cancel.is_some_and(CancelSignal::is_cancelled) {
                yield Err(translate_error(StreamFailure::Aborted));
                return;
            }
            if let Some(usage) = buffered_usage {
                yield Ok(ModelMetadataEvent::new().with_usage(usage).into());
            }
        })
    }

    fn stream_responses(self: Arc<Self>, request: ModelRequest) -> BoxStream<'static, Result<ModelStreamEvent>> {
        Box::pin(async_stream::stream! {
            let config = self.config();
            let stateful = self.stateful();
            let model_info = model_info_of(self.api, &config);
            let body = format_responses_request(&config, &request, stateful, &model_info);
            let cancel = request.cancel_signal.as_ref();
            let mut events = self.client().stream(RESPONSES_PATH, JsonValue::Object(body));
            let mut state = ResponsesStreamState::default();
            loop {
                let Some(event) = next_event(&mut events, cancel).await else {
                    // Closes the connection before the consumer sees the abort.
                    drop(events);
                    yield Err(translate_error(StreamFailure::Aborted));
                    return;
                };
                let Some(event) = event else {
                    break;
                };
                let event = match event {
                    Ok(event) => event,
                    Err(error) => {
                        drop(events);
                        yield Err(translate_error(StreamFailure::Http(error)));
                        return;
                    }
                };
                match map_responses_event(&event, &mut state, stateful, &request.model_state) {
                    Ok(mapped) => {
                        for event in mapped {
                            yield Ok(event);
                        }
                    }
                    Err(error) => {
                        drop(events);
                        yield Err(translate_error(StreamFailure::Response(error)));
                        return;
                    }
                }
            }
            drop(events);
            if cancel.is_some_and(CancelSignal::is_cancelled) {
                yield Err(translate_error(StreamFailure::Aborted));
                return;
            }
            for event in finalize_responses_stream(state) {
                yield Ok(event);
            }
        })
    }
}

#[async_trait]
impl Model for OpenAIModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelStreamEvent>> {
        Arc::clone(&self.inner).stream(request)
    }

    fn get_config(&self) -> BaseModelConfig {
        self.config().to_base()
    }

    fn update_config(&self, config: BaseModelConfig) -> Result<()> {
        OpenAIModel::update_config(self, config)
    }

    /// The configured model id, else the default one requests send.
    fn model_id(&self) -> Option<String> {
        Some(model_id_of(&self.inner.config()).to_owned())
    }

    /// The shared model info with server-side summaries off and `stateful` set for a Responses
    /// model built with `stateful: true`; the `model_info` override wins.
    fn model_info(&self) -> ModelInfo {
        model_info_of(self.inner.api, &self.inner.config())
    }
}

#[cfg(test)]
mod tests;
