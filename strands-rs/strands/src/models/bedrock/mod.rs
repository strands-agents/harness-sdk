//! The Amazon Bedrock model provider, behind the `bedrock` feature (on by default).
//!
//! [`BedrockModel`] talks to the Bedrock Converse and ConverseStream APIs through the AWS SDK for
//! Rust. Requests are built in the Converse JSON shape and converted to the AWS SDK types only at the
//! transport boundary.
//!
//! An agent on a Bedrock model, with credentials and region from the AWS default chain:
//!
//! ```no_run
//! use strands::Agent;
//! use strands::models::bedrock::BedrockModel;
//!
//! # async fn run() -> strands::Result<()> {
//! let model = BedrockModel::builder()
//!     .model_id("global.anthropic.claude-sonnet-4-6")
//!     .max_tokens(4096)
//!     .build();
//! let mut agent = Agent::builder().model(model).build()?;
//! let result = agent.invoke("Why is the sky blue?").await?;
//! println!("{result}");
//! # Ok(())
//! # }
//! ```

mod format;
mod parse;
pub(crate) mod transport;
mod wire;

#[cfg(test)]
mod tests;

use std::fmt;
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;

use self::format::{FormatOptions, Formatter};
use self::parse::{StreamState, map_converse_output};
use self::transport::{BedrockError, BedrockTransport, ChunkStream, SdkTransport};
use super::bedrock_cache::bedrock_cache_model_info;
use super::defaults::{MODEL_DEFAULTS, default_max_tokens_warning_message, default_model_warning_message};
use super::model::{BaseModelConfig, BoxStream, CacheConfig, CacheTtl, CountTokensOptions, Model, ModelRequest};
use super::model::{base_model_info, estimate_tokens, resolve_config_metadata, resolve_max_tokens};
use super::model_info::{DeferredToolLoading, ModelCapabilities, ModelInfo, server_side_summary_off};
use super::native_output::{StructuredOutputMechanism, handle_rejected_mechanism, structured_output_mechanisms};
use super::streaming::ModelStreamEvent;
use crate::error::{ContextWindowOverflowError, Error, ModelError, Result};
use crate::logging::warn_once;
use crate::types::{JsonValue, Message, ToolChoice};

pub use aws_config::SdkConfig;
pub use aws_credential_types::Credentials;
pub use aws_credential_types::provider::SharedCredentialsProvider;

/// Error messages that indicate the input exceeded the model's context window
/// (`BEDROCK_CONTEXT_WINDOW_OVERFLOW_MESSAGES`).
const BEDROCK_CONTEXT_WINDOW_OVERFLOW_MESSAGES: [&str; 6] = [
    "Input is too long for requested model",
    "input length and `max_tokens` exceed context limit",
    "too many total text bytes",
    "prompt is too long",
    "This model's maximum context length is",
    "Input Tokens Exceeded",
];

/// Default per-attempt and stream inactivity timeout (`DEFAULT_REQUEST_TIMEOUT_MS`). The AWS SDK
/// has none, so a stuck connection would otherwise hang forever.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// TTL of a Bedrock prompt-cache checkpoint (`BedrockCacheTTL`), such as `"5m"` or `"1h"`.
///
/// Bedrock validates the value server-side and requires checkpoint TTLs to be non-increasing
/// across tools, system and messages.
pub type BedrockCacheTtl = CacheTtl;

/// Prompt-caching configuration for the Bedrock provider (`BedrockCacheConfig`).
pub type BedrockCacheConfig = CacheConfig;

/// Whether tool results carry their `status` field.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum IncludeToolResultStatus {
    /// Include it for the models Bedrock documents as accepting it (Amazon Nova and Anthropic
    /// Claude).
    #[default]
    Auto,
    /// Always (`true`) or never (`false`) include it.
    Enabled(bool),
}

impl From<bool> for IncludeToolResultStatus {
    fn from(enabled: bool) -> Self {
        Self::Enabled(enabled)
    }
}

/// Guardrail trace mode (`BedrockGuardrailConfig.trace`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum BedrockGuardrailTrace {
    /// `enabled`, the default.
    #[default]
    Enabled,
    /// `disabled`.
    Disabled,
    /// `enabled_full`.
    EnabledFull,
}

impl BedrockGuardrailTrace {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
            Self::EnabledFull => "enabled_full",
        }
    }
}

/// Guardrail stream processing mode (`BedrockGuardrailConfig.streamProcessingMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum BedrockGuardrailStreamProcessingMode {
    /// `sync`.
    Sync,
    /// `async`.
    Async,
}

impl BedrockGuardrailStreamProcessingMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Sync => "sync",
            Self::Async => "async",
        }
    }
}

/// Whether and how content a guardrail blocked is replaced (`BedrockGuardrailRedactionConfig`).
#[derive(Debug, Clone, Default, PartialEq, Eq, bon::Builder)]
pub struct BedrockGuardrailRedactionConfig {
    /// Redact the input when blocked. Default `true`.
    pub input: Option<bool>,
    /// Replacement for redacted input. Default `[User input redacted.]`.
    #[builder(into)]
    pub input_message: Option<String>,
    /// Redact the output when blocked. Default `false`.
    pub output: Option<bool>,
    /// Replacement for redacted output. Default `[Assistant output redacted.]`.
    #[builder(into)]
    pub output_message: Option<String>,
}

/// Bedrock guardrail configuration (`BedrockGuardrailConfig`).
///
/// See <https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html>.
#[derive(Debug, Clone, Default, PartialEq, Eq, bon::Builder)]
pub struct BedrockGuardrailConfig {
    /// Guardrail identifier.
    #[builder(into)]
    pub guardrail_identifier: String,
    /// Guardrail version, such as `"1"` or `"DRAFT"`.
    #[builder(into)]
    pub guardrail_version: String,
    /// Trace mode. Default [`BedrockGuardrailTrace::Enabled`].
    pub trace: Option<BedrockGuardrailTrace>,
    /// Stream processing mode.
    pub stream_processing_mode: Option<BedrockGuardrailStreamProcessingMode>,
    /// Redaction behavior when content is blocked.
    pub redaction: Option<BedrockGuardrailRedactionConfig>,
    /// Evaluate only the latest user message: its text and image content is wrapped in guard
    /// content blocks. The message is the last user message with text or image content, so tool
    /// result turns after it do not move the target. Default `false`.
    pub guard_latest_user_message: Option<bool>,
}

/// Configuration of a [`BedrockModel`] (`BedrockModelConfig`): the [`BaseModelConfig`] fields
/// plus the Bedrock knobs.
///
/// ```
/// use strands::models::bedrock::BedrockModelConfig;
///
/// let config = BedrockModelConfig {
///     model_id: Some("global.anthropic.claude-sonnet-4-6".into()),
///     max_tokens: Some(1024),
///     temperature: Some(0.7),
///     ..Default::default()
/// };
/// assert_eq!(config.to_base().max_tokens, Some(1024));
/// ```
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
pub struct BedrockModelConfig {
    /// The Bedrock model id, inference profile id or ARN. Default
    /// `global.anthropic.claude-sonnet-4-6`.
    #[builder(into)]
    pub model_id: Option<String>,
    /// Maximum number of tokens to generate. Default: the model's output ceiling from the shared
    /// model info when known, otherwise unset so Bedrock's per-model default applies.
    pub max_tokens: Option<u64>,
    /// Controls randomness in generation.
    pub temperature: Option<f64>,
    /// Controls diversity via nucleus sampling.
    pub top_p: Option<f64>,
    /// Context window size in tokens; filled from the shared model info when unset.
    pub context_window_limit: Option<u64>,
    /// Overrides for what the SDK knows about the model.
    pub model_info: Option<ModelInfo>,
    /// Sequences that stop generation.
    pub stop_sequences: Option<Vec<String>>,
    /// Prompt caching. Unset, no cache points are added.
    pub cache_config: Option<BedrockCacheConfig>,
    /// Extra fields for the model (`additionalModelRequestFields`), such as a `thinking` config.
    pub additional_request_fields: Option<JsonValue>,
    /// Paths of extra response fields to return (`additionalModelResponseFieldPaths`).
    pub additional_response_field_paths: Option<Vec<String>>,
    /// Extra top-level Converse request fields, merged over the formatted request (for example
    /// `requestMetadata`, `performanceConfig`, `serviceTier` or `promptVariables`). Keys the
    /// Converse API does not define are ignored with a warning.
    pub additional_args: Option<JsonValue>,
    /// Use ConverseStream (`true`, the default) or Converse (`false`).
    pub stream: Option<bool>,
    /// Whether tool results carry their status. Default [`IncludeToolResultStatus::Auto`].
    #[builder(into)]
    pub include_tool_result_status: Option<IncludeToolResultStatus>,
    /// Guardrail configuration.
    pub guardrail_config: Option<BedrockGuardrailConfig>,
    /// Count tokens with the Bedrock CountTokens API instead of the heuristic estimate. Default
    /// `false`.
    pub use_native_token_count: Option<bool>,
    /// Send every tool with `strict: true` and a closed copy of its input schema, constraining the
    /// model to schema-valid tool calls. Bedrock rejects schemas outside its strict subset. Turns
    /// deferred tool loading off, so `Offload::defer` and the `deferredToolLoading` preset send
    /// every full spec; a `model_info` override of `deferred_tool_loading` still wins. Default
    /// `false`.
    pub strict_tools: Option<bool>,
}

impl BedrockModelConfig {
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
            cache_config,
            additional_request_fields,
            additional_response_field_paths,
            additional_args,
            stream,
            include_tool_result_status,
            guardrail_config,
            use_native_token_count,
            strict_tools,
        } = update;
        replace(&mut self.model_id, model_id);
        replace(&mut self.max_tokens, max_tokens);
        replace(&mut self.temperature, temperature);
        replace(&mut self.top_p, top_p);
        replace(&mut self.context_window_limit, context_window_limit);
        replace(&mut self.model_info, model_info);
        replace(&mut self.stop_sequences, stop_sequences);
        replace(&mut self.cache_config, cache_config);
        replace(&mut self.additional_request_fields, additional_request_fields);
        replace(
            &mut self.additional_response_field_paths,
            additional_response_field_paths,
        );
        replace(&mut self.additional_args, additional_args);
        replace(&mut self.stream, stream);
        replace(&mut self.include_tool_result_status, include_tool_result_status);
        replace(&mut self.guardrail_config, guardrail_config);
        replace(&mut self.use_native_token_count, use_native_token_count);
        replace(&mut self.strict_tools, strict_tools);
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

    fn merge_base(&mut self, update: BaseModelConfig) {
        let BaseModelConfig {
            model_id,
            max_tokens,
            temperature,
            top_p,
            context_window_limit,
            model_info,
        } = update;
        self.merge(Self {
            model_id,
            max_tokens,
            temperature,
            top_p,
            context_window_limit,
            model_info,
            ..Self::default()
        });
    }

    fn model_id_or_default(&self) -> &str {
        self.model_id.as_deref().unwrap_or(MODEL_DEFAULTS.bedrock.model_id)
    }
}

fn replace<T>(slot: &mut Option<T>, update: Option<T>) {
    if update.is_some() {
        *slot = update;
    }
}

impl From<BaseModelConfig> for BedrockModelConfig {
    fn from(base: BaseModelConfig) -> Self {
        let mut config = Self::default();
        config.merge_base(base);
        config
    }
}

/// Options for creating a [`BedrockModel`] (`BedrockModelOptions`): the [`BedrockModelConfig`]
/// fields plus how the AWS client is built.
///
/// The client is built on first use from the AWS default chain (environment, shared config and
/// credential files, SSO, IMDS), layered with these options. Without a region from the options,
/// `sdk_config` or the environment, the region is `us-west-2`. An `AWS_BEARER_TOKEN_BEDROCK`
/// environment variable selects API key authentication, as in the AWS SDKs.
///
/// [`BedrockModel::builder`] starts this builder; its `build()` returns the model and
/// `build_options()` the options.
///
/// ```
/// use std::time::Duration;
///
/// use strands::models::bedrock::BedrockModel;
///
/// let model = BedrockModel::builder()
///     .model_id("us.amazon.nova-lite-v1:0")
///     .max_tokens(512)
///     .region("us-east-1")
///     .request_timeout(Duration::from_secs(300))
///     .build();
/// assert_eq!(model.config().model_id.as_deref(), Some("us.amazon.nova-lite-v1:0"));
/// ```
#[derive(Clone, Default, bon::Builder)]
#[builder(finish_fn = build_options)]
pub struct BedrockModelOptions {
    /// [`BedrockModelConfig::model_id`].
    #[builder(into)]
    pub model_id: Option<String>,
    /// [`BedrockModelConfig::max_tokens`].
    pub max_tokens: Option<u64>,
    /// [`BedrockModelConfig::temperature`].
    pub temperature: Option<f64>,
    /// [`BedrockModelConfig::top_p`].
    pub top_p: Option<f64>,
    /// [`BedrockModelConfig::context_window_limit`].
    pub context_window_limit: Option<u64>,
    /// [`BedrockModelConfig::model_info`].
    pub model_info: Option<ModelInfo>,
    /// [`BedrockModelConfig::stop_sequences`].
    pub stop_sequences: Option<Vec<String>>,
    /// [`BedrockModelConfig::cache_config`].
    pub cache_config: Option<BedrockCacheConfig>,
    /// [`BedrockModelConfig::additional_request_fields`].
    pub additional_request_fields: Option<JsonValue>,
    /// [`BedrockModelConfig::additional_response_field_paths`].
    pub additional_response_field_paths: Option<Vec<String>>,
    /// [`BedrockModelConfig::additional_args`].
    pub additional_args: Option<JsonValue>,
    /// [`BedrockModelConfig::stream`].
    pub stream: Option<bool>,
    /// [`BedrockModelConfig::include_tool_result_status`].
    #[builder(into)]
    pub include_tool_result_status: Option<IncludeToolResultStatus>,
    /// [`BedrockModelConfig::guardrail_config`].
    pub guardrail_config: Option<BedrockGuardrailConfig>,
    /// [`BedrockModelConfig::use_native_token_count`].
    pub use_native_token_count: Option<bool>,
    /// [`BedrockModelConfig::strict_tools`].
    pub strict_tools: Option<bool>,
    /// AWS region of the Bedrock endpoint; wins over `sdk_config` and the environment.
    #[builder(into)]
    pub region: Option<String>,
    /// Endpoint URL override, such as a VPC endpoint.
    #[builder(into)]
    pub endpoint_url: Option<String>,
    /// Credentials provider, replacing the default chain. This AWS SDK type is part of the public API
    /// as an escape hatch.
    pub credentials_provider: Option<SharedCredentialsProvider>,
    /// Shared AWS configuration to build the client from instead of loading the default chain: HTTP
    /// client, retry, timeout and stall settings, credentials and region. This AWS SDK type is part of
    /// the public API as an escape hatch.
    pub sdk_config: Option<SdkConfig>,
    /// Time each attempt may take until the response arrives, and the stream inactivity before a
    /// request is aborted. It replaces an operation attempt timeout set in `sdk_config` and keeps its
    /// other timeouts. Default [`DEFAULT_REQUEST_TIMEOUT`].
    pub request_timeout: Option<Duration>,
    /// Amazon Bedrock API key: requests use bearer token authentication instead of SigV4.
    #[builder(into)]
    pub api_key: Option<String>,
}

impl<S: bedrock_model_options_builder::IsComplete> BedrockModelOptionsBuilder<S> {
    /// Builds the [`BedrockModel`].
    #[must_use]
    pub fn build(self) -> BedrockModel {
        BedrockModel::new(self.build_options())
    }
}

impl BedrockModelOptions {
    /// The model configuration part of the options.
    #[must_use]
    pub fn to_config(&self) -> BedrockModelConfig {
        BedrockModelConfig {
            model_id: self.model_id.clone(),
            max_tokens: self.max_tokens,
            temperature: self.temperature,
            top_p: self.top_p,
            context_window_limit: self.context_window_limit,
            model_info: self.model_info.clone(),
            stop_sequences: self.stop_sequences.clone(),
            cache_config: self.cache_config.clone(),
            additional_request_fields: self.additional_request_fields.clone(),
            additional_response_field_paths: self.additional_response_field_paths.clone(),
            additional_args: self.additional_args.clone(),
            stream: self.stream,
            include_tool_result_status: self.include_tool_result_status,
            guardrail_config: self.guardrail_config.clone(),
            use_native_token_count: self.use_native_token_count,
            strict_tools: self.strict_tools,
        }
    }
}

impl From<BedrockModelConfig> for BedrockModelOptions {
    fn from(config: BedrockModelConfig) -> Self {
        let BedrockModelConfig {
            model_id,
            max_tokens,
            temperature,
            top_p,
            context_window_limit,
            model_info,
            stop_sequences,
            cache_config,
            additional_request_fields,
            additional_response_field_paths,
            additional_args,
            stream,
            include_tool_result_status,
            guardrail_config,
            use_native_token_count,
            strict_tools,
        } = config;
        Self {
            model_id,
            max_tokens,
            temperature,
            top_p,
            context_window_limit,
            model_info,
            stop_sequences,
            cache_config,
            additional_request_fields,
            additional_response_field_paths,
            additional_args,
            stream,
            include_tool_result_status,
            guardrail_config,
            use_native_token_count,
            strict_tools,
            ..Self::default()
        }
    }
}

impl fmt::Debug for BedrockModelOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BedrockModelOptions")
            .field("config", &self.to_config())
            .field("region", &self.region)
            .field("endpoint_url", &self.endpoint_url)
            .field(
                "credentials_provider",
                &self.credentials_provider.as_ref().map(|_| "<set>"),
            )
            .field("sdk_config", &self.sdk_config.as_ref().map(|_| "<set>"))
            .field("request_timeout", &self.request_timeout)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// The Amazon Bedrock model provider (`BedrockModel`), on the Converse and ConverseStream APIs.
///
/// Supports streaming and non-streaming responses, tool use, reasoning, citations, documents and
/// media, prompt caching ([`BedrockCacheConfig`]), guardrails ([`BedrockGuardrailConfig`]),
/// native token counting and structured output.
///
/// Cheap to clone and to share as `Arc<dyn Model>`: clones share one configuration and one AWS
/// client, so [`update_config`](Self::update_config) on any clone changes them all.
///
/// ```no_run
/// use strands::models::bedrock::{BedrockModel, BedrockModelConfig};
/// use strands::models::{Model, ModelRequest};
/// use strands::{AggregatedEvent, Message};
/// use futures::StreamExt;
///
/// # async fn run() -> strands::Result<()> {
/// let model = BedrockModel::new(BedrockModelConfig {
///     model_id: Some("global.anthropic.claude-sonnet-4-6".into()),
///     max_tokens: Some(1024),
///     ..Default::default()
/// });
/// let request = ModelRequest::builder().messages(vec![Message::user("Hello!")]).build();
/// let mut stream = model.stream_aggregated(request);
/// while let Some(item) = stream.next().await {
///     if let AggregatedEvent::Done(result) = item? {
///         println!("{}", result.message.text());
///     }
/// }
/// # Ok(())
/// # }
/// ```
#[derive(Clone)]
pub struct BedrockModel {
    inner: Arc<Inner>,
}

struct Inner {
    config: RwLock<BedrockModelConfig>,
    transport: Arc<dyn BedrockTransport>,
    drop_stale_thinking_model_id: Arc<RwLock<Option<String>>>,
}

impl fmt::Debug for BedrockModel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BedrockModel")
            .field("config", &self.config())
            .finish_non_exhaustive()
    }
}

impl Default for BedrockModel {
    fn default() -> Self {
        Self::new(BedrockModelOptions::default())
    }
}

impl From<BedrockModelOptions> for BedrockModel {
    fn from(options: BedrockModelOptions) -> Self {
        Self::new(options)
    }
}

impl BedrockModel {
    /// Creates the provider from options or a bare [`BedrockModelConfig`]. The AWS client is built
    /// on first use.
    #[must_use]
    pub fn new(options: impl Into<BedrockModelOptions>) -> Self {
        let options = options.into();
        let config = options.to_config();
        let transport = SdkTransport::new(client_options(options));
        Self::with_transport(config, Arc::new(transport))
    }

    /// Starts a [`BedrockModelOptions`] builder whose `build()` returns the provider.
    pub fn builder() -> BedrockModelOptionsBuilder {
        BedrockModelOptions::builder()
    }

    pub(crate) fn with_transport(config: BedrockModelConfig, transport: Arc<dyn BedrockTransport>) -> Self {
        for warning in construction_warnings(&config) {
            warn_once(&warning);
        }
        let mut stored = config;
        stored
            .model_id
            .get_or_insert_with(|| MODEL_DEFAULTS.bedrock.model_id.to_owned());
        Self {
            inner: Arc::new(Inner {
                config: RwLock::new(stored),
                transport,
                drop_stale_thinking_model_id: Arc::default(),
            }),
        }
    }

    /// The configuration with the defaults the provider applies filled in: the model id,
    /// `max_tokens` from the model's output ceiling and `context_window_limit` from the model info.
    #[must_use]
    pub fn config(&self) -> BedrockModelConfig {
        resolve_config(&self.raw_config())
    }

    /// Shallow-merges `config` into the configuration: every field it sets replaces the current
    /// value. Takes a [`BedrockModelConfig`] or a [`BaseModelConfig`]; on the concrete type it
    /// shadows [`Model::update_config`], which does the same.
    ///
    /// # Errors
    ///
    /// None today; the `Result` matches the other providers' `update_config`, which validate.
    pub fn update_config(&self, config: impl Into<BedrockModelConfig>) -> Result<()> {
        self.inner
            .config
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .merge(config.into());
        Ok(())
    }

    fn raw_config(&self) -> BedrockModelConfig {
        self.inner.config.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn call(&self) -> Call {
        let config = self.raw_config();
        Call {
            model_info: bedrock_model_info(&config),
            config,
            transport: Arc::clone(&self.inner.transport),
            drop_stale_thinking_model_id: Arc::clone(&self.inner.drop_stale_thinking_model_id),
        }
    }
}

/// How the AWS client is built from the options; `request_timeout` falls back to
/// [`DEFAULT_REQUEST_TIMEOUT`].
fn client_options(options: BedrockModelOptions) -> transport::ClientOptions {
    let BedrockModelOptions {
        region,
        endpoint_url,
        credentials_provider,
        sdk_config,
        request_timeout,
        api_key,
        ..
    } = options;
    transport::ClientOptions {
        region,
        endpoint_url,
        credentials_provider,
        sdk_config,
        request_timeout: request_timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT),
        api_key,
    }
}

/// The provider behind an agent built without a model.
pub(crate) fn default_bedrock_model() -> Arc<dyn Model> {
    Arc::new(BedrockModel::default())
}

/// The warnings a new provider logs once: the default model id, and a `max_tokens` that comes
/// from the shared model info rather than the user (through `max_tokens` or `model_info`).
fn construction_warnings(config: &BedrockModelConfig) -> Vec<String> {
    let mut warnings = Vec::new();
    if config.model_id.is_none() {
        warnings.push(default_model_warning_message(MODEL_DEFAULTS.bedrock.model_id));
    }
    let pinned = config.max_tokens.is_some()
        || config
            .model_info
            .as_ref()
            .is_some_and(|info| info.limits.max_output_tokens.is_some());
    if let Some(max_tokens) = resolve_config(config).max_tokens.filter(|_| !pinned) {
        warnings.push(default_max_tokens_warning_message(max_tokens));
    }
    warnings
}

fn resolve_config(raw: &BedrockModelConfig) -> BedrockModelConfig {
    let model_id = raw.model_id_or_default().to_owned();
    let base = raw.to_base();
    let max_tokens = resolve_max_tokens(&base, &model_id);
    let resolved = resolve_config_metadata(base, &model_id);
    let mut config = raw.clone();
    config.model_id = Some(model_id);
    config.context_window_limit = resolved.context_window_limit;
    config.max_tokens = config.max_tokens.or(max_tokens);
    config
}

/// Bedrock's model info: the shared info, server-side summary off, how Converse caches the model
/// where that differs from the shared info, and the user's override on top.
fn bedrock_model_info(config: &BedrockModelConfig) -> ModelInfo {
    let mut base = config.to_base();
    base.model_id
        .get_or_insert_with(|| MODEL_DEFAULTS.bedrock.model_id.to_owned());
    let caching = bedrock_cache_model_info(config.model_id_or_default());
    // Strict mode needs each tool's full input schema, so it can't take a deferred tool as a stub.
    let strict = (config.strict_tools == Some(true)).then(|| ModelInfo {
        capabilities: ModelCapabilities {
            deferred_tool_loading: Some(DeferredToolLoading::Unsupported),
            ..ModelCapabilities::default()
        },
        ..ModelInfo::default()
    });
    ModelInfo::merge([
        Some(&base_model_info(&base)),
        Some(&server_side_summary_off()),
        caching.as_ref(),
        strict.as_ref(),
        config.model_info.as_ref(),
    ])
}

/// What one model call needs, cloned out of the provider so the stream is `'static`.
struct Call {
    config: BedrockModelConfig,
    model_info: ModelInfo,
    transport: Arc<dyn BedrockTransport>,
    drop_stale_thinking_model_id: Arc<RwLock<Option<String>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Api {
    ConverseStream,
    Converse,
}

enum Response {
    Stream(ChunkStream),
    Converse(crate::types::JsonObject),
}

impl Call {
    fn formatter(&self) -> Formatter<'_> {
        Formatter::new(&self.config, &self.model_info)
    }

    fn events(self, request: ModelRequest) -> BoxStream<'static, Result<ModelStreamEvent>> {
        Box::pin(async_stream::try_stream! {
            let api = if self.config.stream == Some(false) { Api::Converse } else { Api::ConverseStream };
            match self.send_request(&request, api).await.map_err(Error::from)? {
                Response::Stream(mut chunks) => {
                    let mut state = StreamState::new(self.config.guardrail_config.as_ref());
                    while let Some(chunk) = chunks.next().await {
                        let chunk = chunk.map_err(Error::from)?;
                        for event in state.apply(&chunk)? {
                            yield event;
                        }
                    }
                    for event in state.finish() {
                        yield event;
                    }
                }
                Response::Converse(output) => {
                    for event in map_converse_output(&output, self.config.guardrail_config.as_ref())? {
                        yield event;
                    }
                }
            }
        })
    }

    /// Formats and sends the request, with the strongest structured output mechanism the model
    /// accepts when the call must produce a schema. Rejected mechanisms are
    /// remembered for the process.
    async fn send_request(&self, request: &ModelRequest, api: Api) -> Result<Response, SendError> {
        let options = FormatOptions::from_request(request);
        let Some(schema) = request.structured_output_schema.as_ref() else {
            return self
                .send(self.formatter().format_request(&request.messages, &options)?, api)
                .await;
        };
        let model_id = self.config.model_id_or_default().to_owned();
        let mechanisms = structured_output_mechanisms(
            "bedrock",
            &model_id,
            request.tool_choice.as_ref(),
            schema,
            &self.model_info,
        );
        let (fallback, attempts) = mechanisms
            .split_last()
            .map_or((StructuredOutputMechanism::Auto, &[][..]), |(last, rest)| (*last, rest));
        for mechanism in attempts {
            let formatted = self.structured_output_request(&request.messages, &options, *mechanism, schema)?;
            match self.send(formatted, api).await {
                Ok(response) => return Ok(response),
                Err(SendError::Bedrock(error)) if record_rejected_mechanism(&error, *mechanism, &model_id, schema) => {}
                Err(error) => return Err(error),
            }
        }
        let formatted = self.structured_output_request(&request.messages, &options, fallback, schema)?;
        self.send(formatted, api).await
    }

    /// Formats the request for a structured output mechanism.
    fn structured_output_request(
        &self,
        messages: &[Message],
        options: &FormatOptions<'_>,
        mechanism: StructuredOutputMechanism,
        schema: &JsonValue,
    ) -> Result<crate::types::JsonObject> {
        let formatter = self.formatter();
        if mechanism == StructuredOutputMechanism::Forced {
            return formatter.format_request(messages, options);
        }
        let auto = ToolChoice::Auto;
        let mut request = formatter.format_request(messages, &options.with_tool_choice(Some(&auto)))?;
        if mechanism == StructuredOutputMechanism::Native {
            format::apply_native_output_config(&mut request, schema)?;
        }
        Ok(request)
    }

    /// Sends the request, retrying once with `drop_block` when an edit before replayed thinking
    /// made it stale (`_send`). An accepted retry turns `drop_block` on for later requests to this
    /// model.
    async fn send(&self, request: crate::types::JsonObject, api: Api) -> Result<Response, SendError> {
        let model_id = request
            .get("modelId")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_owned();
        let drops_stale = self
            .drop_stale_thinking_model_id
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .as_deref()
            == Some(model_id.as_str());
        let sent = drops_stale
            .then(|| format::request_with_drop_block(&request))
            .flatten()
            .unwrap_or(request);
        let error = match self.send_once(sent.clone(), api).await {
            Ok(response) => return Ok(response),
            Err(error) => error,
        };
        let binding_error =
            error.name == "ValidationException" && super::thinking_binding::is_thinking_binding_error(&error.message);
        let Some(retry) = binding_error.then(|| format::request_with_drop_block(&sent)).flatten() else {
            return Err(error.into());
        };
        tracing::warn!(
            "model_id=<{model_id}> | history edit invalidated replayed thinking blocks, retrying with drop_block"
        );
        let response = self.send_once(retry, api).await?;
        // Latched only once the retry is accepted, so a rejected retry does not alter later requests.
        *self
            .drop_stale_thinking_model_id
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Some(model_id);
        Ok(response)
    }

    async fn send_once(&self, request: crate::types::JsonObject, api: Api) -> Result<Response, BedrockError> {
        match api {
            Api::ConverseStream => self.transport.converse_stream(request).await.map(Response::Stream),
            Api::Converse => self.transport.converse(request).await.map(Response::Converse),
        }
    }

    async fn count_tokens(self, messages: &[Message], options: &CountTokensOptions) -> Result<u64, SendError> {
        let format_options = FormatOptions {
            system_prompt: options.system_prompt.as_ref(),
            tool_specs: &options.tool_specs,
            ..FormatOptions::default()
        };
        let request = self.formatter().format_request(messages, &format_options)?;
        let input: crate::types::JsonObject = ["messages", "system", "toolConfig"]
            .into_iter()
            .filter_map(|key| request.get(key).map(|value| (key.to_owned(), value.clone())))
            .collect();
        let model_id = self.config.model_id_or_default().to_owned();
        let tokens = self.transport.count_tokens(model_id, input).await?;
        let Some(tokens) = tokens else {
            return Err(Error::from(ModelError::new(
                "Bedrock CountTokens returned undefined for inputTokens",
            ))
            .into());
        };
        tracing::debug!("total_tokens=<{tokens}> | native token count");
        Ok(tokens)
    }
}

/// A send failure: the request could not be formatted, or Bedrock rejected it.
enum SendError {
    Format(Error),
    Bedrock(BedrockError),
}

impl From<Error> for SendError {
    fn from(error: Error) -> Self {
        Self::Format(error)
    }
}

impl From<BedrockError> for SendError {
    fn from(error: BedrockError) -> Self {
        Self::Bedrock(error)
    }
}

impl From<SendError> for Error {
    fn from(error: SendError) -> Self {
        match error {
            SendError::Format(error) => error,
            SendError::Bedrock(error) => error.into(),
        }
    }
}

/// Records a structured output rejection, so the request is resent with the next mechanism.
fn record_rejected_mechanism(
    error: &BedrockError,
    mechanism: StructuredOutputMechanism,
    model_id: &str,
    schema: &JsonValue,
) -> bool {
    error.name == "ValidationException"
        && handle_rejected_mechanism("bedrock", model_id, mechanism, schema, &error.message)
}

/// Turns any error whose message names a context overflow into a [`ContextWindowOverflowError`].
fn map_stream_error(error: Error) -> Error {
    let message = error.to_string();
    if BEDROCK_CONTEXT_WINDOW_OVERFLOW_MESSAGES
        .iter()
        .any(|pattern| message.contains(pattern))
    {
        return ContextWindowOverflowError::new(message).into();
    }
    error
}

/// Model ids whose CountTokens calls are skipped for the life of the process
/// (`SKIP_COUNT_TOKENS_MODELS`).
static SKIP_COUNT_TOKENS_MODELS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(Default::default);

fn skip_count_tokens(model_id: &str) -> bool {
    SKIP_COUNT_TOKENS_MODELS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .contains(model_id)
}

fn remember_skip_count_tokens(model_id: &str) {
    SKIP_COUNT_TOKENS_MODELS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(model_id.to_owned());
}

#[async_trait]
impl Model for BedrockModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelStreamEvent>> {
        let cancel_signal = request.cancel_signal.clone();
        let mut events = self.call().events(request);
        Box::pin(async_stream::stream! {
            loop {
                let next = match &cancel_signal {
                    Some(signal) => tokio::select! {
                        biased;
                        () = signal.cancelled() => {
                            // Closes the connection before the consumer sees the abort.
                            drop(events);
                            yield Err(ModelError::new("Request aborted").into());
                            return;
                        }
                        next = events.next() => next,
                    },
                    None => events.next().await,
                };
                match next {
                    Some(Ok(event)) => yield Ok(event),
                    Some(Err(error)) => {
                        drop(events);
                        yield Err(map_stream_error(error));
                        return;
                    }
                    None => return,
                }
            }
        })
    }

    fn get_config(&self) -> BaseModelConfig {
        self.config().to_base()
    }

    fn update_config(&self, config: BaseModelConfig) -> Result<()> {
        Self::update_config(self, config)
    }

    fn model_info(&self) -> ModelInfo {
        bedrock_model_info(&self.raw_config())
    }

    async fn count_tokens(&self, messages: &[Message], options: CountTokensOptions) -> Result<u64> {
        let call = self.call();
        if call.config.use_native_token_count != Some(true) {
            return Ok(estimate_tokens(messages, &options));
        }
        let model_id = call.config.model_id_or_default().to_owned();
        if skip_count_tokens(&model_id) {
            return Ok(estimate_tokens(messages, &options));
        }
        let error = match call.count_tokens(messages, &options).await {
            Ok(tokens) => return Ok(tokens),
            Err(error) => error,
        };
        let (name, message) = match &error {
            SendError::Bedrock(error) => (error.name.as_str(), error.message.as_str()),
            SendError::Format(_) => ("", ""),
        };
        if name == "AccessDeniedException" {
            warn_once(&format!(
                "model_id=<{model_id}> | bedrock:CountTokens permission denied, falling back to heuristic estimation"
            ));
            remember_skip_count_tokens(&model_id);
        } else if name == "ValidationException" && message.contains("doesn't support counting tokens") {
            tracing::debug!(
                "model_id=<{model_id}> | model does not support CountTokens, caching for future calls, falling back to estimation"
            );
            remember_skip_count_tokens(&model_id);
        } else {
            let error = Error::from(error);
            tracing::debug!("error=<{error}> | native token counting failed, falling back to estimation");
        }
        Ok(estimate_tokens(messages, &options))
    }
}
