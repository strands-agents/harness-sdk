//! The Anthropic Messages API provider, behind the `anthropic` feature.
//!
//! [`AnthropicModel`] streams from the Messages API over HTTP, with the official Anthropic SDK's
//! transport behaviour (retries, timeout, error texts). It maps every content block, the system
//! prompt, tool specs and tool choice, prompt caching ([`CacheConfig`]), structured output,
//! extended thinking (through [`AnthropicModelConfig::params`]), Anthropic's server-side tools
//! (such as the native `web_search`, through [`AnthropicModelConfig::anthropic_tools`]) and
//! server-side summaries by on-demand compaction.
//!
//! ```
//! use strands::models::anthropic::AnthropicModel;
//! use strands::models::Model;
//!
//! # fn main() -> strands::Result<()> {
//! let model = AnthropicModel::builder()
//!     .model_id("claude-sonnet-4-6")
//!     .max_tokens(4096)
//!     .api_key("my-api-key")
//!     .build()?;
//! assert_eq!(model.model_id().as_deref(), Some("claude-sonnet-4-6"));
//! # Ok(())
//! # }
//! ```
//!
//! An agent with extended thinking, through `params` (the API key comes from
//! `ANTHROPIC_API_KEY`):
//!
//! ```no_run
//! use serde_json::json;
//! use strands::Agent;
//! use strands::models::anthropic::AnthropicModel;
//!
//! # async fn run() -> strands::Result<()> {
//! let model = AnthropicModel::builder()
//!     .model_id("claude-sonnet-4-6")
//!     .max_tokens(16_000)
//!     .params(json!({"thinking": {"type": "enabled", "budget_tokens": 4096}}))
//!     .build()?;
//! let mut agent = Agent::builder().model(model).build()?;
//! let result = agent.invoke("Why is the sky blue?").await?;
//! println!("{result}");
//! # Ok(())
//! # }
//! ```

#[cfg(feature = "bedrock")]
mod bedrock;
mod client;
mod format;
mod stream;

use std::fmt;
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;

use self::anthropic_model_options_builder::IsComplete;
#[cfg(feature = "bedrock")]
pub use self::bedrock::AnthropicBedrockConfig;
use self::client::{
    AnthropicClient, ApiVersion, ClientRequest, HttpAnthropicClient, header_values, resolve_api_version,
};
use self::format::{FormatOptions, Formatter, from_last_compaction, is_tool_forced, validate_anthropic_tools};
use self::stream::{MessageAccumulator, ResponseState, UsageCounters, format_compaction_usage, stream_usage};
use super::defaults::{MODEL_DEFAULTS, default_max_tokens_warning_message, default_model_warning_message};
use super::http::{HttpError, RedactedHeaders, read_env};
use super::model_info::lookup_model_info;
use super::native_output::to_native_output_schema;
use super::native_output::{StructuredOutputMechanism, handle_rejected_mechanism, structured_output_mechanisms};
use super::streaming::{ModelMessageStopEvent, ModelMetadataEvent, ModelStreamEvent, Usage};
use super::thinking_binding::{is_thinking_binding_error, thinking_with_drop_block};
use super::{
    BaseModelConfig, BoxStream, CacheConfig, CountTokensOptions, Model, ModelCapabilities, ModelInfo, ModelRequest,
    SummarizeOptions, SummarizeResult, base_model_info, estimate_tokens, resolve_config_metadata, resolve_max_tokens,
    summarize_client_side,
};
use crate::error::{ContextWindowOverflowError, Error, ModelError, ModelNetworkError, ModelThrottledError, Result};
use crate::logging::warn_once;
use crate::types::{ContentBlock, JsonObject, JsonValue, Message, StopReason, SummaryBlock, ToolChoice};

/// Phrases of Anthropic context overflow errors, matched case-insensitively.
const CONTEXT_WINDOW_OVERFLOW_ERRORS: [&str; 6] = [
    "prompt is too long",
    "max_tokens exceeded",
    "input too long",
    "input is too long",
    "input length exceeds context window",
    "input and output tokens exceed your context limit",
];

/// How many times a paused server-side tool turn is resumed within one `stream` call.
const MAX_PAUSE_TURN_CONTINUATIONS: u32 = 10;

/// Beta that lets a mid-conversation system message carry `clear_at`.
const TURN_SCOPED_SYSTEM_BETA: &str = "mid-conversation-system-clear-at-2026-08-21";

/// Beta that enables on-demand compaction, and compaction blocks in later requests.
const COMPACTION_BETA: &str = "compact-2026-09-04";

/// Configuration of an [`AnthropicModel`] (`AnthropicModelConfig`): the [`BaseModelConfig`] fields
/// and the Anthropic ones.
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
pub struct AnthropicModelConfig {
    /// The model id, such as `claude-sonnet-4-6`. Defaults to `claude-sonnet-4-6`, which can change
    /// between versions.
    #[builder(into)]
    pub model_id: Option<String>,
    /// Maximum tokens the model may generate. Defaults to the model's output ceiling from the
    /// shared model info, else 64000; both can change between versions.
    pub max_tokens: Option<u64>,
    /// Controls randomness in generation. API version 2026-10-21 rejects it.
    pub temperature: Option<f64>,
    /// Nucleus sampling. API version 2026-10-21 rejects it.
    pub top_p: Option<f64>,
    /// Context window size in tokens; filled from the shared model info when unset.
    pub context_window_limit: Option<u64>,
    /// Overrides for what the SDK knows about the model.
    pub model_info: Option<ModelInfo>,
    /// Sequences that stop generation.
    pub stop_sequences: Option<Vec<String>>,
    /// Extra request fields, merged over the formatted request. Extended thinking goes here, for
    /// example `{"thinking": {"type": "enabled", "budget_tokens": 1024}}` or
    /// `{"thinking": {"type": "adaptive"}}`. Server tools under `tools` are appended like
    /// [`anthropic_tools`](Self::anthropic_tools). Must be a JSON object, such as a `json!({..})`
    /// literal.
    pub params: Option<JsonValue>,
    /// Anthropic server-side tools, such as
    /// `{"type": "web_search_20260318", "name": "web_search"}`, `web_fetch` and `code_execution`,
    /// appended after the agent's function tools. Function tools (with an `input_schema`) are
    /// rejected; use the agent's tools for those. Each entry must be a JSON object.
    pub anthropic_tools: Option<Vec<JsonValue>>,
    /// Beta features to enable through the `anthropic-beta` header, such as
    /// `interleaved-thinking-2025-05-14`. None by default.
    pub betas: Option<Vec<String>>,
    /// Whether [`Model::count_tokens`] calls the token counting API instead of estimating. Default
    /// `false`.
    pub use_native_token_count: Option<bool>,
    /// Prompt caching. Setting it caches the tool definitions, the system prompt and the
    /// conversation up to the last user message; caching is off when unset. `strategy` has no
    /// effect: every active Claude model caches prompts.
    pub cache_config: Option<CacheConfig>,
}

impl AnthropicModelConfig {
    /// Shallow-merges `update` into `self`: every field `update` sets replaces the current value.
    pub fn merge(&mut self, update: Self) {
        let Self {
            model_id,
            max_tokens,
            temperature,
            top_p,
            context_window_limit,
            model_info,
            stop_sequences,
            params,
            anthropic_tools,
            betas,
            use_native_token_count,
            cache_config,
        } = update;
        self.model_id = model_id.or(self.model_id.take());
        self.max_tokens = max_tokens.or(self.max_tokens);
        self.temperature = temperature.or(self.temperature);
        self.top_p = top_p.or(self.top_p);
        self.context_window_limit = context_window_limit.or(self.context_window_limit);
        self.model_info = model_info.or(self.model_info.take());
        self.stop_sequences = stop_sequences.or(self.stop_sequences.take());
        self.params = params.or(self.params.take());
        self.anthropic_tools = anthropic_tools.or(self.anthropic_tools.take());
        self.betas = betas.or(self.betas.take());
        self.use_native_token_count = use_native_token_count.or(self.use_native_token_count);
        self.cache_config = cache_config.or(self.cache_config.take());
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

impl From<BaseModelConfig> for AnthropicModelConfig {
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

/// How the client reaches the Messages API.
///
/// `Debug` redacts the values of credential headers (`authorization`, `proxy-authorization`,
/// `x-api-key`, `api-key`, `cookie`).
#[derive(Clone, Default, PartialEq, Eq, bon::Builder)]
pub struct AnthropicClientConfig {
    /// The API base URL. Defaults to `ANTHROPIC_BASE_URL`, else `https://api.anthropic.com`.
    #[builder(into)]
    pub base_url: Option<String>,
    /// Headers sent with every request, after those in `ANTHROPIC_CUSTOM_HEADERS`; a later header
    /// replaces an earlier one with the same name. Pin the API version with
    /// `("anthropic-version", "2023-06-01")`; betas given as `anthropic-beta` are kept when the
    /// provider adds its own.
    #[builder(default)]
    pub default_headers: Vec<(String, String)>,
    /// Retries on connection errors, timeouts, 408, 409, 429 and 5xx responses. Default 2.
    pub max_retries: Option<u32>,
    /// Time each attempt may wait for the response headers. Default 10 minutes.
    pub timeout: Option<Duration>,
}

impl fmt::Debug for AnthropicClientConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AnthropicClientConfig")
            .field("base_url", &self.base_url)
            .field("default_headers", &RedactedHeaders(&self.default_headers))
            .field("max_retries", &self.max_retries)
            .field("timeout", &self.timeout)
            .finish()
    }
}

/// Options for [`AnthropicModel::new`] (`AnthropicModelOptions`): the [`AnthropicModelConfig`]
/// fields and the client ones.
///
/// [`AnthropicModel::builder`] builds them and the model in one go; the options' own builder ends
/// with [`build_options`](AnthropicModelOptionsBuilder::build_options).
#[derive(Clone, Default, PartialEq, bon::Builder)]
#[builder(finish_fn = build_options)]
pub struct AnthropicModelOptions {
    /// See [`AnthropicModelConfig::model_id`].
    #[builder(into)]
    pub model_id: Option<String>,
    /// See [`AnthropicModelConfig::max_tokens`].
    pub max_tokens: Option<u64>,
    /// See [`AnthropicModelConfig::temperature`].
    pub temperature: Option<f64>,
    /// See [`AnthropicModelConfig::top_p`].
    pub top_p: Option<f64>,
    /// See [`AnthropicModelConfig::context_window_limit`].
    pub context_window_limit: Option<u64>,
    /// See [`AnthropicModelConfig::model_info`].
    pub model_info: Option<ModelInfo>,
    /// See [`AnthropicModelConfig::stop_sequences`].
    pub stop_sequences: Option<Vec<String>>,
    /// See [`AnthropicModelConfig::params`].
    pub params: Option<JsonValue>,
    /// See [`AnthropicModelConfig::anthropic_tools`].
    pub anthropic_tools: Option<Vec<JsonValue>>,
    /// See [`AnthropicModelConfig::betas`].
    pub betas: Option<Vec<String>>,
    /// See [`AnthropicModelConfig::use_native_token_count`].
    pub use_native_token_count: Option<bool>,
    /// See [`AnthropicModelConfig::cache_config`].
    pub cache_config: Option<CacheConfig>,
    /// The API key. Defaults to `ANTHROPIC_API_KEY`.
    #[builder(into)]
    pub api_key: Option<String>,
    /// How the client reaches the API.
    pub client_config: Option<AnthropicClientConfig>,
}

impl fmt::Debug for AnthropicModelOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AnthropicModelOptions")
            .field("config", &self.clone().into_parts().0)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("client_config", &self.client_config)
            .finish()
    }
}

impl AnthropicModelOptions {
    fn into_parts(self) -> (AnthropicModelConfig, Option<String>, AnthropicClientConfig) {
        let config = AnthropicModelConfig {
            model_id: self.model_id,
            max_tokens: self.max_tokens,
            temperature: self.temperature,
            top_p: self.top_p,
            context_window_limit: self.context_window_limit,
            model_info: self.model_info,
            stop_sequences: self.stop_sequences,
            params: self.params,
            anthropic_tools: self.anthropic_tools,
            betas: self.betas,
            use_native_token_count: self.use_native_token_count,
            cache_config: self.cache_config,
        };
        (config, self.api_key, self.client_config.unwrap_or_default())
    }
}

impl From<AnthropicModelConfig> for AnthropicModelOptions {
    fn from(config: AnthropicModelConfig) -> Self {
        let AnthropicModelConfig {
            model_id,
            max_tokens,
            temperature,
            top_p,
            context_window_limit,
            model_info,
            stop_sequences,
            params,
            anthropic_tools,
            betas,
            use_native_token_count,
            cache_config,
        } = config;
        Self {
            model_id,
            max_tokens,
            temperature,
            top_p,
            context_window_limit,
            model_info,
            stop_sequences,
            params,
            anthropic_tools,
            betas,
            use_native_token_count,
            cache_config,
            ..Self::default()
        }
    }
}

impl<S: IsComplete> AnthropicModelOptionsBuilder<S> {
    /// Builds the model ([`AnthropicModel::new`]).
    ///
    /// # Errors
    ///
    /// See [`AnthropicModel::new`].
    pub fn build(self) -> Result<AnthropicModel> {
        AnthropicModel::new(self.build_options())
    }
}

/// A model on the Anthropic Messages API (`AnthropicModel`).
///
/// Cheap to clone and to share as `Arc<dyn Model>`: clones share one configuration and one HTTP
/// client, so [`update_config`](Self::update_config) on any clone changes them all.
#[derive(Clone)]
pub struct AnthropicModel {
    inner: Arc<Inner>,
}

impl fmt::Debug for AnthropicModel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AnthropicModel")
            .field("config", &self.inner.config())
            .finish_non_exhaustive()
    }
}

struct Inner {
    config: RwLock<AnthropicModelConfig>,
    client: Arc<dyn AnthropicClient>,
    /// Betas from the client's default `anthropic-beta` header.
    client_betas: Vec<String>,
    /// Unknown for a substituted client, whose API version the provider cannot see.
    api_version: Option<ApiVersion>,
    /// Whether requests go to Bedrock's InvokeModel API, which takes its API version in the body.
    bedrock_runtime: bool,
    /// The model a thinking-binding error turned `drop_block` on for.
    drop_stale_thinking_model_id: Mutex<Option<String>>,
}

impl AnthropicModel {
    /// Starts building a model from [`AnthropicModelOptions`] fields.
    pub fn builder() -> AnthropicModelOptionsBuilder {
        AnthropicModelOptions::builder()
    }

    /// Creates the model from options or a bare model configuration.
    ///
    /// Logs a one-time warning when `model_id` or `max_tokens` falls back to its default.
    ///
    /// # Errors
    ///
    /// Fails when `params` is not a JSON object, when `anthropic_tools` holds anything but server
    /// tool objects, when there is no API key in the options or `ANTHROPIC_API_KEY`, or when the
    /// HTTP client cannot be built (an invalid base URL or header).
    pub fn new(options: impl Into<AnthropicModelOptions>) -> Result<Self> {
        Self::with_env(options.into(), &|name| std::env::var(name).ok())
    }

    fn with_env(options: AnthropicModelOptions, env: &dyn Fn(&str) -> Option<String>) -> Result<Self> {
        let env = |name: &str| read_env(env, name);
        let (config, api_key, client_config) = options.into_parts();
        let config = prepare_config(config)?;
        let api_key = api_key
            .filter(|key| !key.is_empty())
            .or_else(|| env("ANTHROPIC_API_KEY"))
            .ok_or_else(|| {
                Error::other(
                    "Anthropic API key is required. Provide it via the 'api_key' option or set the ANTHROPIC_API_KEY environment variable.",
                )
            })?;
        let custom_headers = env("ANTHROPIC_CUSTOM_HEADERS");
        let client = HttpAnthropicClient::new(
            &api_key,
            &client_config,
            env("ANTHROPIC_BASE_URL"),
            custom_headers.as_deref(),
        )
        .map_err(|error| Error::from(ModelError::new(error.to_string()).with_source(error)))?;
        let api_version = resolve_api_version(&client_config, custom_headers.as_deref());
        Ok(Self::from_parts(
            config,
            Arc::new(client),
            client_betas(&client_config),
            Some(api_version),
        ))
    }

    fn from_parts(
        config: AnthropicModelConfig,
        client: Arc<dyn AnthropicClient>,
        client_betas: Vec<String>,
        api_version: Option<ApiVersion>,
    ) -> Self {
        Self::from_client(config, client, client_betas, api_version, false)
    }

    fn from_client(
        config: AnthropicModelConfig,
        client: Arc<dyn AnthropicClient>,
        client_betas: Vec<String>,
        api_version: Option<ApiVersion>,
        bedrock_runtime: bool,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                config: RwLock::new(config),
                client,
                client_betas,
                api_version,
                bedrock_runtime,
                drop_stale_thinking_model_id: Mutex::new(None),
            }),
        }
    }

    /// The configuration, with `model_id`, `max_tokens` and `context_window_limit` resolved to the
    /// values requests use.
    #[must_use]
    pub fn config(&self) -> AnthropicModelConfig {
        self.inner.resolved_config()
    }

    /// Merges `config` into the configuration: every field it sets replaces the current value.
    /// Takes a [`BaseModelConfig`] too.
    ///
    /// # Errors
    ///
    /// Fails, leaving the configuration unchanged, when `params` is not a JSON object or
    /// `anthropic_tools` holds anything but server tool objects.
    pub fn update_config(&self, config: impl Into<AnthropicModelConfig>) -> Result<()> {
        let config = config.into();
        validate_json_fields(&config)?;
        self.inner.write_config().merge(config);
        Ok(())
    }
}

/// Validates the configuration and fills the default model id, warning once about defaults.
fn prepare_config(mut config: AnthropicModelConfig) -> Result<AnthropicModelConfig> {
    validate_json_fields(&config)?;
    let default_model_id = MODEL_DEFAULTS.anthropic.model_id;
    if config.model_id.is_none() {
        warn_once(&default_model_warning_message(default_model_id));
        config.model_id = Some(default_model_id.to_owned());
    }
    let pinned_by_info = config
        .model_info
        .as_ref()
        .is_some_and(|info| info.limits.max_output_tokens.is_some());
    if config.max_tokens.is_none() && !pinned_by_info {
        warn_once(&default_max_tokens_warning_message(resolved_max_tokens(&config)));
    }
    Ok(config)
}

/// Checks that `params` is a JSON object and that `anthropic_tools` holds server tool objects only.
fn validate_json_fields(config: &AnthropicModelConfig) -> Result<()> {
    if config.params.as_ref().is_some_and(|params| !params.is_object()) {
        return Err(Error::other("'params' must be a JSON object"));
    }
    if let Some(tools) = &config.anthropic_tools {
        validate_anthropic_tools(tools)?;
    }
    Ok(())
}

/// The betas in the client's default `anthropic-beta` headers.
fn client_betas(config: &AnthropicClientConfig) -> Vec<String> {
    header_values(&config.default_headers, "anthropic-beta")
        .into_iter()
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|beta| !beta.is_empty())
        .map(str::to_owned)
        .collect()
}

fn model_id_of(config: &AnthropicModelConfig) -> &str {
    config.model_id.as_deref().unwrap_or(MODEL_DEFAULTS.anthropic.model_id)
}

/// The `max_tokens` to send: the configured value, else the model's output ceiling, else the
/// fixed default. Resolved on each read so it follows a model id change.
fn resolved_max_tokens(config: &AnthropicModelConfig) -> u64 {
    resolve_max_tokens(&config.to_base(), model_id_of(config))
        .or(MODEL_DEFAULTS.anthropic.max_tokens)
        .unwrap_or(64_000)
}

/// The configuration with the values requests use filled in.
fn resolve(config: &AnthropicModelConfig) -> AnthropicModelConfig {
    let base = resolve_config_metadata(config.to_base(), model_id_of(config));
    AnthropicModelConfig {
        model_id: Some(model_id_of(config).to_owned()),
        max_tokens: Some(resolved_max_tokens(config)),
        context_window_limit: base.context_window_limit,
        ..config.clone()
    }
}

/// The model info: the shared data and the base layers, temporary messages back on for the models
/// the shared data lists, and the user's override on top.
fn model_info_of(config: &AnthropicModelConfig) -> ModelInfo {
    let resolved = resolve(config).to_base();
    let temporary_messages = lookup_model_info(model_id_of(config)).capabilities.temporary_messages;
    let provider = ModelInfo {
        capabilities: ModelCapabilities {
            temporary_messages,
            ..ModelCapabilities::default()
        },
        ..ModelInfo::default()
    };
    ModelInfo::merge([
        Some(&base_model_info(&resolved)),
        Some(&provider),
        config.model_info.as_ref(),
    ])
}

/// Why one attempt at a request failed, before translation to SDK errors.
enum AttemptError {
    Http(HttpError),
    Sdk(Error),
}

struct AttemptFailure {
    error: AttemptError,
    continuations: u32,
    thinking: Option<JsonValue>,
    tool_forced: bool,
}

impl AttemptError {
    fn message(&self) -> String {
        match self {
            Self::Http(error) => error.message().to_owned(),
            Self::Sdk(error) => error.to_string(),
        }
    }

    fn status(&self) -> Option<u16> {
        match self {
            Self::Http(error) => error.status_code(),
            Self::Sdk(_) => None,
        }
    }

    /// The provider's error text: the error body's own message when present, since the SDK message
    /// is the JSON-encoded body.
    fn api_message(&self) -> String {
        let Self::Http(error) = self else {
            return self.message();
        };
        error
            .body()
            .and_then(|body| body.get("error"))
            .and_then(|error| error.get("message"))
            .and_then(JsonValue::as_str)
            .map_or_else(|| self.message(), str::to_owned)
    }
}

/// Exception frames Bedrock sends for a throttle that arrives mid-stream, which have no status.
const BEDROCK_THROTTLING_EVENTS: [&str; 2] = ["throttlingException", "serviceUnavailableException"];

fn is_throttle(error: &HttpError) -> bool {
    error.status_code() == Some(429)
        || error
            .body()
            .and_then(|body| body.get("type"))
            .and_then(JsonValue::as_str)
            .is_some_and(|kind| BEDROCK_THROTTLING_EVENTS.contains(&kind))
}

/// Maps a context overflow, a throttle and a transport failure to the SDK's error types.
fn translate_error(error: AttemptError) -> Error {
    let message = error.message();
    let lowered = message.to_lowercase();
    if CONTEXT_WINDOW_OVERFLOW_ERRORS
        .iter()
        .any(|phrase| lowered.contains(phrase))
    {
        return ContextWindowOverflowError::new(message).into();
    }
    match error {
        AttemptError::Http(error) if is_throttle(&error) => {
            tracing::debug!("throttled | error_message=<{message}>");
            ModelThrottledError::new(message).with_source(error).into()
        }
        AttemptError::Http(error) if error.is_network() => ModelNetworkError::new(message).with_source(error).into(),
        AttemptError::Http(error) => ModelError::new(message).with_source(error).into(),
        AttemptError::Sdk(error) => error,
    }
}

fn with_native_output(request: &mut JsonObject, schema: &JsonValue) -> Result<()> {
    let schema = to_native_output_schema(schema)?;
    request.insert("tool_choice".to_owned(), serde_json::json!({"type": "none"}));
    let mut output_config = request
        .get("output_config")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    output_config.insert(
        "format".to_owned(),
        serde_json::json!({"type": "json_schema", "schema": schema}),
    );
    request.insert("output_config".to_owned(), JsonValue::Object(output_config));
    Ok(())
}

impl Inner {
    fn config(&self) -> AnthropicModelConfig {
        self.config.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn write_config(&self) -> std::sync::RwLockWriteGuard<'_, AnthropicModelConfig> {
        self.config.write().unwrap_or_else(PoisonError::into_inner)
    }

    fn resolved_config(&self) -> AnthropicModelConfig {
        resolve(&self.config())
    }

    fn drops_stale_thinking(&self, config: &AnthropicModelConfig) -> bool {
        let model_id = self
            .drop_stale_thinking_model_id
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        model_id.is_some() && model_id.as_deref() == config.model_id.as_deref()
    }

    fn formatter<'a>(&'a self, config: &'a AnthropicModelConfig) -> Formatter<'a> {
        Formatter {
            config,
            model_info: model_info_of(config),
            api_version: self.api_version.as_ref(),
            bedrock_runtime: self.bedrock_runtime,
            drops_stale_thinking: self.drops_stale_thinking(config),
            client_betas: &self.client_betas,
            max_tokens: resolved_max_tokens(config),
        }
    }

    /// The strongest structured output mechanism not yet rejected for this model.
    fn structured_output_mechanism(&self, request: &ModelRequest) -> Option<StructuredOutputMechanism> {
        let schema = request.structured_output_schema.as_ref()?;
        let config = self.config();
        let model_id = config.model_id.as_deref().filter(|id| !id.is_empty())?;
        structured_output_mechanisms(
            "anthropic",
            model_id,
            request.tool_choice.as_ref(),
            schema,
            &model_info_of(&config),
        )
        .first()
        .copied()
    }

    /// Records a structured output rejection; `true` when the request should be resent with the
    /// next mechanism.
    fn record_rejected_mechanism(
        &self,
        error: &AttemptError,
        mechanism: Option<StructuredOutputMechanism>,
        request: &ModelRequest,
    ) -> bool {
        let config = self.config();
        let (Some(mechanism), Some(schema), Some(model_id)) = (
            mechanism,
            request.structured_output_schema.as_ref(),
            config.model_id.as_deref().filter(|id| !id.is_empty()),
        ) else {
            return false;
        };
        error.status() == Some(400)
            && handle_rejected_mechanism("anthropic", model_id, mechanism, schema, &error.api_message())
    }

    /// The request body and beta header for `request` with `mechanism`.
    fn prepare(
        &self,
        request: &ModelRequest,
        mechanism: Option<StructuredOutputMechanism>,
    ) -> Result<(JsonObject, Option<String>)> {
        let config = self.config();
        let formatter = self.formatter(&config);
        let forces_auto = matches!(
            mechanism,
            Some(StructuredOutputMechanism::Native | StructuredOutputMechanism::Auto)
        );
        let options = FormatOptions {
            system_prompt: request.system_prompt.as_ref(),
            tool_specs: &request.tool_specs,
            tool_choice: if forces_auto {
                Some(&ToolChoice::Auto)
            } else {
                request.tool_choice.as_ref()
            },
            dynamic_trailing_blocks: request.dynamic_trailing_blocks.unwrap_or_default(),
        };
        let mut body = formatter.format_request(&request.messages, &options)?;
        if let (Some(StructuredOutputMechanism::Native), Some(schema)) =
            (mechanism, request.structured_output_schema.as_ref())
        {
            with_native_output(&mut body, schema)?;
        }
        let beta = formatter.request_beta(&body, &formatter.compaction_betas(&request.messages));
        Ok((body, beta))
    }

    /// Streams `request`, retrying once with `drop_block` after a thinking-binding error and with
    /// the next structured output mechanism after a rejection.
    fn stream(self: Arc<Self>, request: ModelRequest) -> BoxStream<'static, Result<ModelStreamEvent>> {
        Box::pin(async_stream::stream! {
            // Set while a drop_block retry has yielded nothing: the model it was latched over.
            let mut latched_over = None;
            loop {
                let mechanism = self.structured_output_mechanism(&request);
                let mut attempt = Arc::clone(&self).attempt(request.clone(), mechanism);
                let mut failure = None;
                while let Some(item) = attempt.next().await {
                    match item {
                        Ok(event) => {
                            latched_over = None;
                            yield Ok(event);
                        }
                        Err(error) => {
                            failure = Some(error);
                            break;
                        }
                    }
                }
                drop(attempt);
                let Some(failure) = failure else {
                    return;
                };
                if let Some(previous) = self.retry_with_drop_block(&failure) {
                    latched_over = Some(previous);
                    continue;
                }
                // A mechanism is rejected on a turn's first request, before any event; continuations
                // reuse an accepted one.
                if failure.continuations == 0
                    && self.record_rejected_mechanism(&failure.error, mechanism, &request)
                {
                    continue;
                }
                // A rejected retry must not leave drop_block on for later requests.
                if let Some(previous) = latched_over {
                    *self.drop_stale_thinking_model_id.lock().unwrap_or_else(PoisonError::into_inner) = previous;
                }
                yield Err(translate_error(failure.error));
                return;
            }
        })
    }

    /// Turns `drop_block` on for the model after a thinking-binding error on a turn's first
    /// request, returning the model it was on for before; stale blocks stay in history, so it stays
    /// on for every later request to the model.
    fn retry_with_drop_block(&self, failure: &AttemptFailure) -> Option<Option<String>> {
        let binding = failure.continuations == 0
            && failure.error.status() == Some(400)
            && is_thinking_binding_error(&failure.error.message())
            && thinking_with_drop_block(failure.thinking.as_ref(), failure.tool_forced).is_some();
        if !binding {
            return None;
        }
        let model_id = self.config().model_id;
        tracing::warn!(
            "model_id=<{}> | history edit invalidated replayed thinking blocks, retrying with drop_block",
            model_id.as_deref().unwrap_or_default()
        );
        let mut latched = self
            .drop_stale_thinking_model_id
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        Some(std::mem::replace(&mut latched, model_id))
    }

    /// One request, resuming a paused server-side tool turn with follow-up requests, so an error
    /// from one of those can come after earlier events.
    fn attempt(
        self: Arc<Self>,
        request: ModelRequest,
        mechanism: Option<StructuredOutputMechanism>,
    ) -> BoxStream<'static, std::result::Result<ModelStreamEvent, AttemptFailure>> {
        Box::pin(async_stream::stream! {
            let (mut body, beta) = match self.prepare(&request, mechanism) {
                Ok(prepared) => prepared,
                Err(error) => {
                    yield Err(AttemptFailure { error: AttemptError::Sdk(error), continuations: 0, thinking: None, tool_forced: false });
                    return;
                }
            };
            let thinking = body.get("thinking").cloned();
            let tool_forced = is_tool_forced(&body);
            let mut continuations = 0;
            let mut total = UsageCounters::default();
            loop {
                let client_request = ClientRequest { body: JsonValue::Object(body.clone()), beta: beta.clone() };
                let mut events = self.client.stream(client_request);
                let mut state = ResponseState::default();
                while let Some(event) = events.next().await {
                    let event = match event {
                        Ok(event) => event,
                        Err(error) => {
                            yield Err(AttemptFailure { error: AttemptError::Http(error), continuations, thinking: thinking.clone(), tool_forced });
                            return;
                        }
                    };
                    for output in state.handle(&event, continuations == 0) {
                        yield Ok(output);
                    }
                }
                drop(events);
                // A stream that ends without message_stop is incomplete; no stop event lets the
                // caller tell.
                if !state.stopped {
                    return;
                }
                add_response_usage(&mut total, &state.usage);
                if state.stop_reason == StopReason::PauseTurn {
                    if continuations >= MAX_PAUSE_TURN_CONTINUATIONS {
                        let error = ModelError::new(format!(
                            "server-side tool turn did not complete after {continuations} continuations"
                        ));
                        yield Err(AttemptFailure { error: AttemptError::Sdk(error.into()), continuations, thinking: thinking.clone(), tool_forced });
                        return;
                    }
                    continuations += 1;
                    let paused = serde_json::json!({"role": "assistant", "content": state.message.content()});
                    if let Some(JsonValue::Array(messages)) = body.get_mut("messages") {
                        messages.push(paused);
                    }
                    tracing::debug!("continuation=<{continuations}> | resuming paused server-side tool turn");
                    continue;
                }
                yield Ok(ModelMetadataEvent::new().with_usage(stream_usage(total)).into());
                yield Ok(ModelMessageStopEvent::new(state.stop_reason).into());
                return;
            }
        })
    }

    async fn count_tokens(&self, messages: &[Message], options: CountTokensOptions) -> Result<u64> {
        let config = self.config();
        let formatter = self.formatter(&config);
        // Count what a request sends, which starts at the last compaction block.
        let compacted;
        let messages = if formatter.server_side_summary() {
            compacted = from_last_compaction(messages);
            compacted.as_slice()
        } else {
            messages
        };
        if config.use_native_token_count != Some(true) {
            return Ok(estimate_tokens(messages, &options));
        }
        let format_options = FormatOptions {
            system_prompt: options.system_prompt.as_ref(),
            tool_specs: &options.tool_specs,
            ..FormatOptions::default()
        };
        let request = match formatter.format_request(messages, &format_options) {
            Ok(request) => request,
            Err(error) => {
                tracing::debug!("error=<{error}> | native token counting failed, falling back to estimation");
                return Ok(estimate_tokens(messages, &options));
            }
        };
        let mut params = JsonObject::new();
        for key in ["model", "messages", "system", "tools", "tool_choice"] {
            if let Some(value) = request.get(key) {
                params.insert(key.to_owned(), value.clone());
            }
        }
        let beta = formatter.request_beta(&request, &formatter.compaction_betas(messages));
        let client_request = ClientRequest {
            body: JsonValue::Object(params),
            beta,
        };
        // A substituted client may have no token counting API.
        let Some(response) = self.client.count_tokens(client_request) else {
            return Ok(estimate_tokens(messages, &options));
        };
        let counted = response.await.map_err(|error| error.to_string()).and_then(|body| {
            body.get("input_tokens")
                .and_then(JsonValue::as_u64)
                .ok_or_else(|| "response has no input_tokens".to_owned())
        });
        match counted {
            Ok(tokens) => {
                tracing::debug!("total_tokens=<{tokens}> | native token count");
                Ok(tokens)
            }
            Err(error) => {
                tracing::debug!("error=<{error}> | native token counting failed, falling back to estimation");
                Ok(estimate_tokens(messages, &options))
            }
        }
    }

    /// Sends `messages` as a compaction request; the result is empty when the response holds no
    /// compaction.
    async fn compact(&self, messages: &[Message], options: &SummarizeOptions) -> Result<SummarizeResult> {
        let config = self.config();
        let formatter = self.formatter(&config);
        let model_id = formatter.model_id().to_owned();
        let format_options = FormatOptions {
            system_prompt: options.system_prompt.as_ref(),
            tool_specs: &options.tool_specs,
            ..FormatOptions::default()
        };
        let mut params = formatter.format_request(messages, &format_options)?;
        let beta = formatter.request_beta(&params, &[COMPACTION_BETA]);
        // The API rejects these on a compaction request.
        params.shift_remove("stop_sequences");
        params.shift_remove("context_management");
        let mut compaction = serde_json::json!({"type": "summarize"});
        if let (Some(instructions), JsonValue::Object(map)) = (
            options
                .instructions
                .as_ref()
                .filter(|instructions| !instructions.is_empty()),
            &mut compaction,
        ) {
            map.insert("instructions".to_owned(), instructions.clone().into());
        }
        params.insert("compaction".to_owned(), compaction);
        let client_request = ClientRequest {
            body: JsonValue::Object(params),
            beta,
        };
        // On-demand compaction is only on the beta endpoint, which a substituted client may lack.
        let Some(mut events) = self.client.beta_stream(client_request) else {
            tracing::warn!("model_id=<{model_id}> | client has no beta messages API | summarizing client-side");
            return Ok(SummarizeResult::new(Vec::new()));
        };
        let mut response = MessageAccumulator::default();
        while let Some(event) = events.next().await {
            match event {
                Ok(event) => response.apply(&event),
                Err(error) if error.is_api_error() => {
                    tracing::warn!(
                        "model_id=<{model_id}>, error=<{error}> | compaction request failed | summarizing client-side"
                    );
                    return Ok(SummarizeResult::new(Vec::new()));
                }
                Err(error) => return Err(translate_error(AttemptError::Http(error))),
            }
        }
        let usage = response.usage().map(|usage| format_compaction_usage(&usage));
        let with_usage = |result: SummarizeResult| match usage {
            Some(usage) => result.with_usage(usage),
            None => result,
        };
        let block = response
            .content()
            .iter()
            .find(|block| block.get("type").and_then(JsonValue::as_str) == Some("compaction"));
        let text = block
            .and_then(|block| block.get("content"))
            .and_then(JsonValue::as_str)
            .filter(|text| !text.is_empty());
        let (Some("compaction"), Some(text), Some(block)) = (response.stop_reason(), text, block) else {
            tracing::debug!(
                "model_id=<{model_id}>, stop_reason=<{}> | compaction returned no summary | summarizing client-side",
                response.stop_reason().unwrap_or("undefined")
            );
            return Ok(with_usage(SummarizeResult::new(Vec::new())));
        };
        let mut summary = SummaryBlock::new(text).with_provider("anthropic");
        if let Some(signature) = block.get("signature").and_then(JsonValue::as_str) {
            summary = summary.with_signature(signature);
        }
        Ok(with_usage(SummarizeResult::new(vec![ContentBlock::Summary(summary)])))
    }
}

/// Adds one response's usage to the running total across paused-turn continuations.
fn add_response_usage(total: &mut UsageCounters, response: &UsageCounters) {
    let add = |current: Option<u64>, value: Option<u64>| Some(current.unwrap_or_default() + value.unwrap_or_default());
    total.input_tokens = add(total.input_tokens, response.input_tokens);
    total.output_tokens = add(total.output_tokens, response.output_tokens);
    if response.cache_creation_input_tokens.is_some() {
        total.cache_creation_input_tokens =
            add(total.cache_creation_input_tokens, response.cache_creation_input_tokens);
    }
    if response.cache_read_input_tokens.is_some() {
        total.cache_read_input_tokens = add(total.cache_read_input_tokens, response.cache_read_input_tokens);
    }
}

/// Returns the combined usage of two calls, or whichever one reported usage.
fn sum_usage(first: Option<Usage>, second: Option<Usage>) -> Option<Usage> {
    match (first, second) {
        (Some(mut first), Some(second)) => {
            first.accumulate(&second);
            Some(first)
        }
        (first, second) => first.or(second),
    }
}

#[async_trait]
impl Model for AnthropicModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelStreamEvent>> {
        Arc::clone(&self.inner).stream(request)
    }

    fn get_config(&self) -> BaseModelConfig {
        self.inner.resolved_config().to_base()
    }

    fn update_config(&self, config: BaseModelConfig) -> Result<()> {
        self.inner.write_config().merge(config.into());
        Ok(())
    }

    fn model_id(&self) -> Option<String> {
        Some(model_id_of(&self.inner.config()).to_owned())
    }

    fn model_info(&self) -> ModelInfo {
        model_info_of(&self.inner.config())
    }

    /// Counts with the token counting API when `use_native_token_count` is on, falling back to
    /// [`estimate_tokens`] on failure; estimates otherwise. With server-side summaries the count
    /// starts at the last compaction block, as a request does.
    async fn count_tokens(&self, messages: &[Message], options: CountTokensOptions) -> Result<u64> {
        self.inner.count_tokens(messages, options).await
    }

    /// Summarizes with Anthropic on-demand compaction (beta `compact-2026-09-04`) when the model
    /// info reports `server_side_summary`, returning a summary block with provider `anthropic`.
    /// Falls back to [`summarize_client_side`] without the capability, when the compaction request
    /// fails with an API error (a rejection, an overload, a timeout or a connection error) or when
    /// the response holds no compaction block.
    async fn summarize(&self, messages: Vec<Message>, options: SummarizeOptions) -> Result<SummarizeResult> {
        if self.model_info().capabilities.server_side_summary != Some(true) {
            return summarize_client_side(self, messages, options).await;
        }
        let result = self.inner.compact(&messages, &options).await?;
        if !result.content.is_empty() {
            return Ok(result);
        }
        let fallback = summarize_client_side(self, messages, options).await?;
        let usage = sum_usage(result.usage, fallback.usage);
        let fallback = SummarizeResult::new(fallback.content);
        Ok(match usage {
            Some(usage) => fallback.with_usage(usage),
            None => fallback,
        })
    }
}

#[cfg(test)]
mod tests;
