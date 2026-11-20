//! The [`Model`] trait, its request and result types, and stream aggregation.

use std::pin::Pin;

use async_trait::async_trait;
use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};

use super::model_info::lookup_model_info;
use super::model_info::{ModelCapabilities, ModelInfo, ModelLimits, default_context_window_limit};
use super::streaming::{
    ContentBlockDelta, ContentBlockStart, ModelContentBlockStartEvent, ModelMetadataEvent, ModelRedactionEvent,
    ModelStreamEvent, ReasoningContentDelta,
};
use super::summarize::{SummarizeResult, summarize_client_side};
use crate::cancel::CancelSignal;
use crate::error::{Error, MaxTokensError, ModelError, Result};
use crate::logging::warn_once;
use crate::state_store::StateStore;
use crate::types::{
    AgentMetadata, Citation, CitationGeneratedContent, CitationsBlock, ContentBlock, JsonValue, Message,
    MessageMetadata, ReasoningBlock, Role, StopReason, SystemContentBlock, SystemPrompt, TextBlock, ToolChoice,
    ToolResultContent, ToolSpec, ToolUseBlock,
};

/// A pinned, boxed, `Send` stream, as returned by [`Model::stream`].
pub type BoxStream<'a, T> = Pin<Box<dyn Stream<Item = T> + Send + 'a>>;

/// Configuration every model provider supports (`BaseModelConfig`).
///
/// Providers have their own typed configuration as well; this is the common view returned by
/// [`Model::get_config`].
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
pub struct BaseModelConfig {
    /// The model identifier in the provider's catalog.
    #[builder(into)]
    pub model_id: Option<String>,
    /// Maximum number of tokens to generate in the response.
    pub max_tokens: Option<u64>,
    /// Controls randomness in generation.
    pub temperature: Option<f64>,
    /// Controls diversity via nucleus sampling.
    pub top_p: Option<f64>,
    /// Context window size in tokens. The same fact as `model_info.limits.context_window`: it wins
    /// over the shared model info, and `model_info` wins over it. Vended providers fill it from the
    /// shared model info when unset; [`Model::model_info`] is the resolved view to read.
    pub context_window_limit: Option<u64>,
    /// Overrides for what the SDK knows about the model. Fields set here win over the shared model
    /// info and the provider. An update that sets it replaces the previous override entirely.
    pub model_info: Option<ModelInfo>,
}

impl BaseModelConfig {
    /// Shallow-merges `update` into `self`: every field `update` sets replaces the current value.
    /// Providers implement [`Model::update_config`] with it.
    pub fn merge(&mut self, update: Self) {
        let Self {
            model_id,
            max_tokens,
            temperature,
            top_p,
            context_window_limit,
            model_info,
        } = update;
        self.model_id = model_id.or(self.model_id.take());
        self.max_tokens = max_tokens.or(self.max_tokens);
        self.temperature = temperature.or(self.temperature);
        self.top_p = top_p.or(self.top_p);
        self.context_window_limit = context_window_limit.or(self.context_window_limit);
        self.model_info = model_info.or(self.model_info.take());
    }
}

/// One request to a model: the conversation and its options.
///
/// The request is owned, so a provider can move it into a spawned task.
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct ModelRequest {
    /// The conversation to send.
    #[builder(default)]
    pub messages: Vec<Message>,
    /// System prompt guiding the model's behavior.
    #[builder(into)]
    pub system_prompt: Option<SystemPrompt>,
    /// Tools the model may call.
    #[builder(default)]
    pub tool_specs: Vec<ToolSpec>,
    /// How the model selects tools.
    pub tool_choice: Option<ToolChoice>,
    /// State for providers that keep conversation state server-side, such as a response id for
    /// chaining. The agent passes a copy and keeps the provider's changes only when the call
    /// succeeds.
    #[builder(default)]
    pub model_state: StateStore,
    /// How many trailing blocks of the last user message are rebuilt on every call.
    pub dynamic_trailing_blocks: Option<usize>,
    /// Metadata of the invoking agent.
    pub agent_metadata: Option<AgentMetadata>,
    /// JSON schema this call must produce, set by the agent on its structured output retry. The
    /// response must then call the tool named in `tool_choice`, or be a final text response that is
    /// exactly one JSON object valid against this schema.
    pub structured_output_schema: Option<JsonValue>,
    /// Signal a provider can forward to abort the in-flight request. Support is provider-dependent.
    pub cancel_signal: Option<CancelSignal>,
}

/// Options for [`Model::count_tokens`] (`CountTokensOptions`).
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
pub struct CountTokensOptions {
    /// System prompt to include in the count.
    #[builder(into)]
    pub system_prompt: Option<SystemPrompt>,
    /// Tool specifications to include in the count.
    #[builder(default)]
    pub tool_specs: Vec<ToolSpec>,
}

/// Options for [`Model::summarize`] (`SummarizeOptions`).
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct SummarizeOptions {
    /// The request's system prompt.
    #[builder(into)]
    pub system_prompt: Option<SystemPrompt>,
    /// The request's tool specifications.
    #[builder(default)]
    pub tool_specs: Vec<ToolSpec>,
    /// Instructions replacing the default ones; `None` or an empty string keeps them. The base
    /// implementation's instruction not to act on the request or call tools is always sent.
    #[builder(into)]
    pub instructions: Option<String>,
    /// Signal that aborts the call.
    pub cancel_signal: Option<CancelSignal>,
    /// Metadata of the invoking agent, as passed to [`Model::stream`]. A provider may derive a
    /// prompt-cache routing key from it, so a replay can share the agent's cache.
    pub agent_metadata: Option<AgentMetadata>,
}

/// Redaction of the user's input when a guardrail blocked it (`Redaction`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Redaction {
    /// The text to replace the last user message with.
    pub user_message: String,
}

impl Redaction {
    /// Creates the redaction.
    pub fn new(user_message: impl Into<String>) -> Self {
        Self {
            user_message: user_message.into(),
        }
    }
}

/// The final value of [`Model::stream_aggregated`] (`StreamAggregatedResult`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct StreamAggregatedResult {
    /// The complete message from the model.
    pub message: Message,
    /// Why the model stopped generating.
    pub stop_reason: StopReason,
    /// The last metadata event, with usage and metrics, if the provider sent one.
    pub metadata: Option<ModelMetadataEvent>,
    /// Input redaction when a guardrail blocked the input. Output redaction replaces the message.
    pub redaction: Option<Redaction>,
}

impl StreamAggregatedResult {
    /// Creates a result without metadata or redaction.
    pub fn new(message: Message, stop_reason: StopReason) -> Self {
        Self {
            message,
            stop_reason,
            metadata: None,
            redaction: None,
        }
    }

    /// Sets the metadata event.
    #[must_use]
    pub fn with_metadata(mut self, metadata: ModelMetadataEvent) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Sets the input redaction.
    #[must_use]
    pub fn with_redaction(mut self, redaction: Redaction) -> Self {
        self.redaction = Some(redaction);
        self
    }
}

/// An item of [`Model::stream_aggregated`]: a raw event, a completed block, or the final result.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
#[allow(clippy::large_enum_variant, reason = "`Done` is the single last item of each stream")]
pub enum AggregatedEvent {
    /// A provider event, passed through unchanged.
    ModelStreamEvent(ModelStreamEvent),
    /// A content block, emitted when the block completes.
    ContentBlock(ContentBlock),
    /// The final message, always the last item of a successful stream.
    Done(StreamAggregatedResult),
}

/// A model provider (`Model`).
///
/// Implement [`stream`](Model::stream), [`get_config`](Model::get_config) and
/// [`update_config`](Model::update_config); everything else has a default. Agents hold models as
/// `Arc<dyn Model>`, so a provider keeps its configuration behind interior locking. A provider that
/// overrides a default and still needs it calls the free function behind it:
/// [`base_model_info`] with [`ModelInfo::merge`](crate::models::ModelInfo::merge) for
/// [`model_info`](Model::model_info), [`estimate_tokens`] for [`count_tokens`](Model::count_tokens)
/// and [`summarize_client_side`](crate::models::summarize_client_side) for
/// [`summarize`](Model::summarize). Use [`macro@crate::async_trait`] on the impl when overriding
/// the async methods.
///
/// ```
/// use std::sync::RwLock;
///
/// use futures::StreamExt;
/// use strands::models::streaming::{
///     ModelContentBlockDeltaEvent, ModelContentBlockStartEvent, ModelContentBlockStopEvent,
///     ModelMessageStartEvent, ModelMessageStopEvent, ModelStreamEvent, TextDelta,
/// };
/// use strands::models::{AggregatedEvent, BaseModelConfig, BoxStream, Model, ModelRequest};
/// use strands::{Message, Role, StopReason};
///
/// /// Replies with the text of the last message.
/// #[derive(Default)]
/// struct EchoModel {
///     config: RwLock<BaseModelConfig>,
/// }
///
/// #[strands::async_trait]
/// impl Model for EchoModel {
///     fn stream(&self, request: ModelRequest) -> BoxStream<'static, strands::Result<ModelStreamEvent>> {
///         let text = request.messages.last().map(Message::text).unwrap_or_default();
///         let events: Vec<ModelStreamEvent> = vec![
///             ModelMessageStartEvent::new(Role::Assistant).into(),
///             ModelContentBlockStartEvent::new().into(),
///             ModelContentBlockDeltaEvent::new(TextDelta::new(text)).into(),
///             ModelContentBlockStopEvent::new().into(),
///             ModelMessageStopEvent::new(StopReason::EndTurn).into(),
///         ];
///         Box::pin(futures::stream::iter(events.into_iter().map(Ok)))
///     }
///
///     fn get_config(&self) -> BaseModelConfig {
///         self.config.read().unwrap().clone()
///     }
///
///     fn update_config(&self, config: BaseModelConfig) -> strands::Result<()> {
///         self.config.write().unwrap().merge(config);
///         Ok(())
///     }
/// }
///
/// let model = EchoModel::default();
/// let request = ModelRequest::builder().messages(vec![Message::user("ping")]).build();
/// futures::executor::block_on(async {
///     let mut stream = model.stream_aggregated(request);
///     while let Some(item) = stream.next().await {
///         if let AggregatedEvent::Done(result) = item.unwrap() {
///             assert_eq!(result.message.text(), "ping");
///         }
///     }
/// });
/// ```
#[async_trait]
pub trait Model: Send + Sync + 'static {
    /// Streams the model's response to `request` as raw events.
    ///
    /// The stream is `'static` so the call can be spawned: clone what the stream needs (a config
    /// snapshot, a client handle) out of `&self`.
    ///
    /// # Errors
    ///
    /// Report failures as stream items, translating provider errors to the SDK's model errors so
    /// the agent can react: [`ModelThrottledError`](crate::ModelThrottledError) and
    /// [`ModelNetworkError`](crate::ModelNetworkError) are retried by the default retry strategy,
    /// and [`ContextWindowOverflowError`](crate::ContextWindowOverflowError) makes the
    /// conversation manager reduce the context. Keep the provider's error as the source.
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelStreamEvent>>;

    /// Streams the response with content blocks and the final message assembled.
    ///
    /// Yields every raw event, then each completed [`ContentBlock`], and ends with
    /// [`AggregatedEvent::Done`]. Errors that are not model errors are wrapped in [`ModelError`];
    /// model errors such as [`ContextWindowOverflowError`](crate::ContextWindowOverflowError),
    /// [`ModelThrottledError`](crate::ModelThrottledError) and [`MaxTokensError`] (which carries the
    /// partial message) pass through.
    fn stream_aggregated(&self, request: ModelRequest) -> BoxStream<'static, Result<AggregatedEvent>> {
        aggregate(self.stream(request))
    }

    /// The current configuration.
    fn get_config(&self) -> BaseModelConfig;

    /// Merges `config` into the configuration: every field it sets replaces the current value
    /// ([`BaseModelConfig::merge`]).
    ///
    /// # Errors
    ///
    /// The provider rejects the update (for example a model id its client cannot be rebuilt
    /// for); the configuration is left unchanged.
    fn update_config(&self, config: BaseModelConfig) -> Result<()>;

    /// The configured model id.
    fn model_id(&self) -> Option<String> {
        self.get_config().model_id
    }

    /// Everything the SDK knows about the configured model, resolved on each call.
    ///
    /// Layers, later ones winning: the shared model info for the model id, `temporary_messages`
    /// off (a provider that supports them turns them back on), the `context_window_limit` config
    /// value, and the `model_info` config override ([`base_model_info`]). A provider that knows
    /// better overrides this method, layering its facts over [`base_model_info`] and the user's
    /// override on top with [`ModelInfo::merge`](crate::models::ModelInfo::merge); it must not call
    /// [`stateful`](Model::stateful), which reads this method.
    fn model_info(&self) -> ModelInfo {
        base_model_info(&self.get_config())
    }

    /// Whether the model keeps conversation state server-side (`stateful`), from
    /// `model_info().capabilities.stateful`; `false` when unknown.
    ///
    /// When `true`, the agent sends only the latest message and clears its local history after each
    /// invocation.
    fn stateful(&self) -> bool {
        self.model_info().capabilities.stateful.unwrap_or(false)
    }

    /// Estimates the input tokens of a request before sending it.
    ///
    /// The default is [`estimate_tokens`], a character heuristic (text length / 4, JSON length / 2)
    /// that counts only the latest user message's injected blocks, the ones a model reads.
    /// Providers with a native counting API override it and fall back to [`estimate_tokens`] on
    /// failure.
    async fn count_tokens(&self, messages: &[Message], options: CountTokensOptions) -> Result<u64> {
        Ok(estimate_tokens(messages, &options))
    }

    /// Summarizes `messages`, a request as the caller would send it to [`stream`](Model::stream)
    /// (`summarize`).
    ///
    /// The default sends that request closed by an instruction not to act on it or call tools,
    /// followed by `instructions` (or the default ones), so a caller replaying its own conversation
    /// can share its prompt cache. The summary is the reply's text, including a reply cut off at the
    /// output limit or a stop sequence; a reply that ends for another reason (a tool call, a
    /// cancellation, a guardrail) or holds no text gives an empty result. Every summary is a
    /// `SummaryBlock`; the default leaves its `provider` unset. A provider whose model info reports
    /// `server_side_summary` overrides this to summarize server-side and sets `provider`, falling
    /// back to [`summarize_client_side`](crate::models::summarize_client_side).
    async fn summarize(&self, messages: Vec<Message>, options: SummarizeOptions) -> Result<SummarizeResult> {
        summarize_client_side(self, messages, options).await
    }

    /// The fraction of the context window that `input_tokens` fills; above 1.0 means overflow.
    ///
    /// Uses `model_info().limits.context_window`, or the default limit with a one-time warning when
    /// it is unknown.
    fn estimate_utilization(&self, input_tokens: u64) -> f64 {
        let limit = self
            .model_info()
            .limits
            .context_window
            .filter(|limit| *limit > 0)
            .unwrap_or_else(|| {
                let default = default_context_window_limit();
                warn_once(&default_context_window_warning(default));
                default
            });
        input_tokens as f64 / limit as f64
    }
}

fn default_context_window_warning(default: u64) -> String {
    format!(
        "contextWindowLimit is not set on the model, using default of {default} for utilization estimate | set contextWindowLimit in your model config for accurate results"
    )
}

/// The default [`Model::model_info`] for a configuration, before any provider facts: the shared model
/// info for the model id, `temporary_messages` off, the `context_window_limit` and the `model_info`
/// override. A provider that overrides [`Model::model_info`] starts from it (see
/// [`ModelInfo::merge`](crate::models::ModelInfo::merge)).
#[must_use]
pub fn base_model_info(config: &BaseModelConfig) -> ModelInfo {
    let shared = lookup_model_info(config.model_id.as_deref().unwrap_or_default());
    let defaults = ModelInfo {
        capabilities: ModelCapabilities {
            temporary_messages: Some(false),
            ..ModelCapabilities::default()
        },
        limits: ModelLimits {
            context_window: config.context_window_limit,
            ..ModelLimits::default()
        },
    };
    ModelInfo::merge([Some(&shared), Some(&defaults), config.model_info.as_ref()])
}

/// Fills `context_window_limit` from the model info when it is unset.
#[allow(dead_code, reason = "providers fill the context window of `get_config` with it")]
pub(crate) fn resolve_config_metadata(mut config: BaseModelConfig, model_id: &str) -> BaseModelConfig {
    if config.context_window_limit.is_some() {
        return config;
    }
    let info = ModelInfo::merge([Some(&lookup_model_info(model_id)), config.model_info.as_ref()]);
    config.context_window_limit = info.limits.context_window;
    config
}

/// The `max_tokens` to send: the configured value, else the model's output ceiling from the
/// shared model info with the override applied.
#[allow(dead_code, reason = "providers that need a max_tokens resolve it with this")]
pub(crate) fn resolve_max_tokens(config: &BaseModelConfig, model_id: &str) -> Option<u64> {
    config.max_tokens.or_else(|| {
        ModelInfo::merge([Some(&lookup_model_info(model_id)), config.model_info.as_ref()])
            .limits
            .max_output_tokens
    })
}

/// Index of the latest user message, `None` when there is none.
pub(crate) fn latest_user_index(messages: &[Message]) -> Option<usize> {
    messages.iter().rposition(|message| message.role == Role::User)
}

/// Whether caching skips models that are not known to support it (`CacheConfig.strategy`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum CacheStrategy {
    /// Cache only when the model is known to support it.
    #[default]
    Auto,
    /// Cache without that check, for model identifiers the SDK cannot inspect (an application
    /// inference profile, for example).
    Anthropic,
}

/// TTL of a cache entry (`CacheTTL`), such as `"5m"` or `"1h"`. Providers validate it server-side.
pub type CacheTtl = String;

/// Whether a cache section is cached, and for how long.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum CacheSectionSetting {
    /// `true` caches the section with the shared TTL; `false` disables it.
    Enabled(bool),
    /// Caches the section with this TTL.
    Ttl(CacheTtl),
}

impl From<bool> for CacheSectionSetting {
    fn from(enabled: bool) -> Self {
        Self::Enabled(enabled)
    }
}

impl From<&str> for CacheSectionSetting {
    fn from(ttl: &str) -> Self {
        Self::Ttl(ttl.to_owned())
    }
}

impl From<String> for CacheSectionSetting {
    fn from(ttl: String) -> Self {
        Self::Ttl(ttl)
    }
}

/// The prompt-cache routing key for providers that route by key.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum CacheKey {
    /// Use this key.
    Key(String),
    /// Opt out of routing.
    Disabled,
}

impl From<&str> for CacheKey {
    fn from(key: &str) -> Self {
        Self::Key(key.to_owned())
    }
}

impl From<String> for CacheKey {
    fn from(key: String) -> Self {
        Self::Key(key)
    }
}

/// Prompt caching configuration (`CacheConfig`). Providers consume only the fields they support.
#[derive(Debug, Clone, Default, PartialEq, Eq, bon::Builder)]
pub struct CacheConfig {
    /// Whether to skip caching for models that do not support it. Default [`CacheStrategy::Auto`].
    pub strategy: Option<CacheStrategy>,
    /// TTL for every cache point, overridden by a per-section TTL; the provider default when unset.
    ///
    /// Bedrock requires checkpoint TTLs to be non-increasing across tools, system and messages, so
    /// this TTL also fills in for a cache point placed by hand in the system prompt that carries
    /// none. A TTL written on such a point is left as written.
    #[builder(into)]
    pub ttl: Option<CacheTtl>,
    /// Cache the tool definitions. A TTL sets this section's duration; `false` disables it.
    /// Default `true`.
    #[builder(into)]
    pub tools_ttl: Option<CacheSectionSetting>,
    /// Cache the system prompt, adding a cache point at its end. A TTL sets this section's
    /// duration; `true` uses `ttl`; `false` disables it. Default `true`.
    #[builder(into)]
    pub system_prompt_ttl: Option<CacheSectionSetting>,
    /// Cache the conversation prefix, on the last user message. A TTL sets this section's
    /// duration; `false` disables it. Default `true`.
    #[builder(into)]
    pub messages_ttl: Option<CacheSectionSetting>,
    /// Stable identity a prompt-cache-routing provider (OpenAI) uses as its cache key. Unset, it
    /// is derived per request as `strands-<sessionId>` when the agent has a session manager. The
    /// resolved key is sent to the provider.
    #[builder(into)]
    pub cache_key: Option<CacheKey>,
}

/// A cache section resolved to the values a provider emits (`ResolvedCacheSection`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedCacheSection {
    /// Whether this section carries a cache point.
    pub(crate) enabled: bool,
    /// The TTL to emit, absent when no TTL applies.
    pub(crate) ttl: Option<CacheTtl>,
}

/// Resolves whether a cache section is enabled and which TTL it carries.
///
/// `ttl_fallbacks` are tried in order after the section's own TTL; an empty TTL counts as unset.
#[allow(dead_code, reason = "providers place cache points with it")]
pub(crate) fn resolve_cache_section(
    section: Option<&CacheSectionSetting>,
    ttl_fallbacks: &[Option<&str>],
) -> ResolvedCacheSection {
    let enabled = !matches!(section, Some(CacheSectionSetting::Enabled(false)));
    let section_ttl = match section {
        Some(CacheSectionSetting::Ttl(ttl)) => Some(ttl.as_str()),
        _ => None,
    };
    let ttl = std::iter::once(section_ttl)
        .chain(ttl_fallbacks.iter().copied())
        .flatten()
        .find(|ttl| !ttl.is_empty())
        .map(str::to_owned);
    ResolvedCacheSection { enabled, ttl }
}

/// Wraps an error that is not a model error in a [`ModelError`] carrying it as the source.
fn into_model_error(error: Error) -> Error {
    if error.is_model_error() {
        return error;
    }
    ModelError::new(error.to_string()).with_source(error).into()
}

/// Turns a raw event stream into the [`Model::stream_aggregated`] stream.
pub(crate) fn aggregate(
    mut events: BoxStream<'static, Result<ModelStreamEvent>>,
) -> BoxStream<'static, Result<AggregatedEvent>> {
    Box::pin(async_stream::stream! {
        let mut aggregator = Aggregator::default();
        while let Some(event) = events.next().await {
            let event = match event {
                Ok(event) => event,
                Err(error) => {
                    yield Err(into_model_error(error));
                    return;
                }
            };
            let block = aggregator.apply(&event);
            yield Ok(AggregatedEvent::ModelStreamEvent(event));
            if let Some(block) = block {
                yield Ok(AggregatedEvent::ContentBlock(block));
            }
        }
        yield aggregator.finish().map(AggregatedEvent::Done);
    })
}

/// Whitespace for trimming: Unicode `White_Space` without U+0085 (next line), plus the byte order mark.
pub(crate) fn is_js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

#[derive(Default)]
struct Aggregator {
    role: Option<Role>,
    blocks: Vec<ContentBlock>,
    text: String,
    tool_input: String,
    tool_name: String,
    tool_use_id: String,
    tool_signature: String,
    reasoning: ReasoningBlock,
    citations: Vec<Citation>,
    citation_content: Vec<CitationGeneratedContent>,
    stopped: Option<Message>,
    stop_reason: Option<StopReason>,
    metadata: Option<ModelMetadataEvent>,
    redaction: Option<String>,
    parse_error: Option<serde_json::Error>,
}

impl Aggregator {
    fn apply(&mut self, event: &ModelStreamEvent) -> Option<ContentBlock> {
        match event {
            ModelStreamEvent::MessageStart(start) => {
                self.role = Some(start.role);
                self.blocks.clear();
            }
            ModelStreamEvent::ContentBlockStart(start) => self.start_block(start),
            ModelStreamEvent::ContentBlockDelta(delta) => self.add_delta(&delta.delta),
            ModelStreamEvent::ContentBlockStop(_) => return self.finish_block(),
            ModelStreamEvent::MessageStop(stop) => {
                let content = self
                    .blocks
                    .iter()
                    .filter(|block| !matches!(block, ContentBlock::Text(text) if text.text.trim_matches(is_js_whitespace).is_empty()))
                    .cloned()
                    .collect();
                self.stopped = Some(Message::new(self.role.unwrap_or(Role::Assistant), content));
                self.stop_reason = Some(stop.stop_reason.clone());
            }
            ModelStreamEvent::Metadata(metadata) => self.metadata = Some(metadata.clone()),
            ModelStreamEvent::Redaction(redaction) => self.redact(redaction),
        }
        None
    }

    fn start_block(&mut self, start: &ModelContentBlockStartEvent) {
        if let Some(ContentBlockStart::ToolUse(tool_use)) = &start.start {
            self.tool_name.clone_from(&tool_use.name);
            self.tool_use_id.clone_from(&tool_use.tool_use_id);
            self.tool_signature = tool_use.reasoning_signature.clone().unwrap_or_default();
        }
        self.tool_input.clear();
        self.text.clear();
        self.reasoning = ReasoningBlock::default();
        self.reset_citations();
    }

    fn add_delta(&mut self, delta: &ContentBlockDelta) {
        match delta {
            ContentBlockDelta::Text(text) => self.text.push_str(&text.text),
            ContentBlockDelta::ToolUseInput(input) => self.tool_input.push_str(&input.input),
            ContentBlockDelta::ReasoningContent(reasoning) => self.add_reasoning(reasoning),
            ContentBlockDelta::Citations(citations) => {
                self.citations.extend(citations.citations.iter().cloned());
                self.citation_content.extend(citations.content.iter().cloned());
            }
        }
    }

    fn add_reasoning(&mut self, delta: &ReasoningContentDelta) {
        if let Some(text) = delta.text.as_deref().filter(|text| !text.is_empty()) {
            self.reasoning.text.get_or_insert_with(String::new).push_str(text);
        }
        if let Some(signature) = delta.signature.as_deref().filter(|signature| !signature.is_empty()) {
            self.reasoning.signature = Some(signature.to_owned());
        }
        if let Some(redacted) = &delta.redacted_content {
            self.reasoning.redacted_content = Some(redacted.clone());
        }
    }

    fn has_reasoning(&self) -> bool {
        self.reasoning.text.is_some() || self.reasoning.signature.is_some() || self.reasoning.redacted_content.is_some()
    }

    fn reset_citations(&mut self) {
        self.citations.clear();
        self.citation_content.clear();
    }

    /// Completes the current block; `None` when its tool input is not valid JSON.
    fn finish_block(&mut self) -> Option<ContentBlock> {
        let block = if !self.tool_use_id.is_empty() {
            self.finish_tool_use()?
        } else if self.has_reasoning() {
            ContentBlock::Reasoning(std::mem::take(&mut self.reasoning))
        } else if !self.citations.is_empty() {
            self.finish_citations()
        } else {
            ContentBlock::Text(TextBlock::new(std::mem::take(&mut self.text)))
        };
        self.blocks.push(block.clone());
        Some(block)
    }

    fn finish_tool_use(&mut self) -> Option<ContentBlock> {
        let name = std::mem::take(&mut self.tool_name);
        let tool_use_id = std::mem::take(&mut self.tool_use_id);
        let signature = std::mem::take(&mut self.tool_signature);
        let input = if self.tool_input.is_empty() {
            Ok(JsonValue::Object(serde_json::Map::new()))
        } else {
            serde_json::from_str(&self.tool_input)
        };
        let input = match input {
            Ok(input) => input,
            Err(error) => {
                tracing::error!("error=<{error}> | unable to parse tool input JSON");
                self.parse_error = Some(error);
                return None;
            }
        };
        let mut block = ToolUseBlock::new(name, tool_use_id, input);
        if !signature.is_empty() {
            block = block.with_reasoning_signature(signature);
        }
        Some(ContentBlock::ToolUse(block))
    }

    fn finish_citations(&mut self) -> ContentBlock {
        let text = std::mem::take(&mut self.text);
        let mut content = std::mem::take(&mut self.citation_content);
        if content.is_empty() && !text.is_empty() {
            content.push(CitationGeneratedContent::new(text));
        }
        let citations = std::mem::take(&mut self.citations);
        ContentBlock::Citations(CitationsBlock::new(citations, content))
    }

    fn redact(&mut self, redaction: &ModelRedactionEvent) {
        if let Some(input) = &redaction.input_redaction {
            self.redaction = Some(input.replace_content.clone());
        }
        if let Some(output) = &redaction.output_redaction {
            self.stopped = Some(Message::assistant(output.replace_content.clone()));
        }
    }

    fn finish(self) -> Result<StreamAggregatedResult> {
        let (Some(mut message), Some(stop_reason)) = (self.stopped, self.stop_reason) else {
            let mut error = ModelError::new("Stream ended without completing a message");
            if let Some(parse_error) = self.parse_error {
                error = error.with_source(parse_error);
            }
            return Err(error.into());
        };
        let usage = self.metadata.as_ref().and_then(|metadata| metadata.usage);
        let metrics = self.metadata.as_ref().and_then(|metadata| metadata.metrics);
        if usage.is_some() || metrics.is_some() {
            message = message.with_metadata(MessageMetadata {
                usage,
                metrics,
                ..MessageMetadata::default()
            });
        }
        if stop_reason == StopReason::MaxTokens {
            return Err(MaxTokensError::new(
                "Model reached maximum token limit. This is an unrecoverable state that requires intervention.",
                message,
            )
            .into());
        }
        if let Some(parse_error) = self.parse_error {
            return Err(ModelError::new("unable to parse tool input JSON")
                .with_source(parse_error)
                .into());
        }
        Ok(StreamAggregatedResult {
            message,
            stop_reason,
            metadata: self.metadata,
            redaction: self.redaction.map(Redaction::new),
        })
    }
}

fn utf16_len(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

fn heuristic_text(text: &str) -> u64 {
    utf16_len(text).div_ceil(4)
}

/// Rewrites whole-number floats as integers, so `1.0` counts as `1`.
fn normalize_js_numbers(value: &mut JsonValue) {
    match value {
        JsonValue::Number(number) => {
            let Some(float) = number.as_f64().filter(|_| number.is_f64()) else {
                return;
            };
            if float.fract() == 0.0 && float.abs() <= MAX_SAFE_INTEGER {
                *value = JsonValue::from(float as i64);
            }
        }
        JsonValue::Array(items) => items.iter_mut().for_each(normalize_js_numbers),
        JsonValue::Object(map) => map.values_mut().for_each(normalize_js_numbers),
        _ => {}
    }
}

/// 2^53 - 1, the largest integer below which a 64-bit float holds every integer exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn heuristic_json(value: &impl Serialize) -> u64 {
    let Ok(mut json) = serde_json::to_value(value) else {
        tracing::debug!("unable to serialize object for token estimation, skipping");
        return 0;
    };
    normalize_js_numbers(&mut json);
    utf16_len(&json.to_string()).div_ceil(2)
}

fn estimate_content_block_tokens(block: &ContentBlock) -> u64 {
    match block {
        ContentBlock::Text(text) => heuristic_text(&text.text),
        ContentBlock::ToolUse(tool_use) => heuristic_text(&tool_use.name) + heuristic_json(&tool_use.input),
        ContentBlock::ToolResult(result) => result
            .content
            .iter()
            .map(|item| match item {
                ToolResultContent::Text(text) => heuristic_text(&text.text),
                ToolResultContent::Json(json) => heuristic_json(&json.json),
                _ => 0,
            })
            .sum(),
        ContentBlock::Reasoning(reasoning) => reasoning.text.as_deref().map_or(0, heuristic_text),
        ContentBlock::GuardContent(guard) => guard.text().map_or(0, |text| heuristic_text(&text.text)),
        ContentBlock::Citations(citations) => citations.content.iter().map(|item| heuristic_text(&item.text)).sum(),
        ContentBlock::Injected(injected) => heuristic_text(&injected.text),
        ContentBlock::Summary(summary) => heuristic_text(&summary.text),
        _ => 0,
    }
}

fn estimate_system_prompt_tokens(system_prompt: &SystemPrompt) -> u64 {
    match system_prompt {
        SystemPrompt::Text(text) => heuristic_text(text),
        SystemPrompt::Blocks(blocks) => blocks
            .iter()
            .map(|block| match block {
                SystemContentBlock::Text(text) => heuristic_text(&text.text),
                SystemContentBlock::GuardContent(guard) => guard.text().map_or(0, |text| heuristic_text(&text.text)),
                _ => 0,
            })
            .sum(),
    }
}

/// Counts the messages, with only the latest user message's injected blocks, the ones a model reads.
fn estimate_message_tokens(messages: &[Message]) -> u64 {
    let latest_user = latest_user_index(messages);
    messages
        .iter()
        .enumerate()
        .flat_map(|(index, message)| {
            let keep_injected = Some(index) == latest_user;
            message
                .content
                .iter()
                .filter(move |block| keep_injected || !matches!(block, ContentBlock::Injected(_)))
        })
        .map(estimate_content_block_tokens)
        .sum()
}

/// The default [`Model::count_tokens`] estimate: text length / 4 and JSON length / 2, in UTF-16 code
/// units, with only the latest user message's injected blocks.
///
/// Providers with a native counting API fall back to it on failure.
#[must_use]
pub fn estimate_tokens(messages: &[Message], options: &CountTokensOptions) -> u64 {
    let system = options.system_prompt.as_ref().map_or(0, estimate_system_prompt_tokens);
    let tools: u64 = options.tool_specs.iter().map(heuristic_json).sum();
    system + estimate_message_tokens(messages) + tools
}

/// Tests the provider-independent model behaviour, including cache config portability.
#[cfg(test)]
mod tests;
