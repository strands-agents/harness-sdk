//! Strands Agents SDK for Rust.
//!
//! A model-driven approach to building AI agents: give a model a system prompt and tools, and the
//! agent loop calls the model, runs the tools it asks for and feeds their results back until the
//! model answers.
//!
//! This is a developer preview: the API may change in any 0.x release.
//!
//! # Quick start
//!
//! An agent with a tool, on the default model (Amazon Bedrock, with credentials and region from
//! the AWS default chain), invoked once and then streamed:
//!
//! ```
//! use futures::StreamExt;
//! use strands::{tool, Agent, AgentStreamEvent};
//!
//! /// Get the current weather for a city.
//! #[tool]
//! async fn get_weather(
//!     /// City name, for example "Seattle".
//!     city: String,
//! ) -> Result<String, strands::ToolError> {
//!     Ok(format!("Sunny in {city}"))
//! }
//!
//! #[tokio::main]
//! async fn main() -> Result<(), strands::Error> {
//!     let mut agent = Agent::builder()            // default model: Bedrock
//! #       .model(strands::testing::MockModel::from_turns(["It is sunny.", "It is mild."]))
//! #       .printer(false)
//!         .system_prompt("You are a concise assistant.")
//!         .tools([GetWeather])
//!         .build()?;
//!
//!     let result = agent.invoke("What's the weather in Seattle?").await?;
//!     println!("{result}");
//!
//!     {
//!         let mut stream = agent.stream("And in Lisbon?");
//!         while let Some(event) = stream.next().await {
//!             if let AgentStreamEvent::ModelStreamUpdate(update) = event? {
//!                 if let Some(text) = update.text_delta() {
//!                     print!("{text}");
//!                 }
//!             }
//!         }
//!     }
//!     agent.shutdown().await
//! }
//! ```
//!
//! The [`agent`] module shows the other everyday shapes: the [`AgentConfig`] struct, tools with
//! state through `#[tools]`, hooks, structured output and cancellation. The crate's
//! [`examples/`](https://github.com/strands-agents/harness-sdk/tree/main/strands-rs/strands/examples)
//! directory has a runnable program for each provider and feature.
//!
//! # Features
//!
//! | Feature | Default | Adds |
//! |---|---|---|
//! | `bedrock` | yes | `models::BedrockModel`, the Amazon Bedrock Converse provider, and the default model |
//! | `anthropic` | | `models::anthropic::AnthropicModel`, the Anthropic Messages API provider |
//! | `openai` | | `models::openai::OpenAIModel` (Responses and Chat Completions); it does not need `bedrock` |
//! | `mantle` | | `models::openai::OpenAIModel::bedrock_mantle`, Amazon Bedrock's OpenAI-compatible Mantle endpoint, and `BedrockMantleConfig`; turns on `openai`, adds the AWS signing and credential crates and does not need `bedrock` |
//! | `mcp` | | `mcp::McpClient`, Model Context Protocol clients over stdio, streamable HTTP and SSE, and the `mcp_router` tool |
//! | `otel` | | OpenTelemetry export of the agent's spans and metrics (`telemetry::setup_tracer`, `telemetry::setup_meter`) |
//! | `cedar` | | `CedarAuthorization`, Cedar policy authorization of tool calls |
//!
//! Without `bedrock` an agent needs an explicit model; a Bedrock model id then fails with
//! [`DefaultNotConfiguredError`]. The `otel` feature's `opentelemetry`, `opentelemetry_sdk`,
//! `tracing-opentelemetry` and `tracing-subscriber` versions are part of the public API: moving
//! one to a semver-incompatible version is a breaking strands release.
//!
//! # Modules
//!
//! | Module | Contents |
//! |---|---|
//! | [`agent`] | [`Agent`], its builder and [`AgentConfig`], [`AgentResult`], [`InvokeArgs`], [`InvokeOptions`], [`InvocationState`], the request's [`InvocationContext`] with its [`InvokeLimits`], direct tool calls, agents as tools, and the [`LocalAgent`] and [`ToolAgent`] views |
//! | [`types`] | Messages, the content blocks (Bedrock Converse JSON shape), media, citations, tool specs, stop reasons, snapshots and interrupt responses |
//! | [`models`] | The [`Model`] trait with its [`ModelRequest`], stream aggregation, token counting and summarization, [`ModelInfo`], stream events, [`Usage`] and [`Metrics`], prompt caching, [`ModelRouter`], and the providers |
//! | [`mod@tools`] | The [`Tool`] trait, [`ToolContext`], [`ToolError`], [`tools::FunctionTool`], the [`tools::ToolRegistry`], the executors and structured output |
//! | [`hooks`] | The 17 hook events, [`hooks::HookRegistry`] and [`HookOrder`], and the [`AgentStreamEvent`] records an agent stream yields |
//! | [`plugins`] | The [`plugins::Plugin`] trait |
//! | [`middleware`] | Handlers around the model call and each tool execution |
//! | [`interrupt`] | Human-in-the-loop [`Interrupt`]s |
//! | [`interventions`] | [`InterventionHandler`]s that gate the agent's lifecycle |
//! | [`vended_interventions`] | Human-in-the-loop approval and Cedar policy authorization (feature `cedar`) |
//! | [`conversation_manager`] | Keeping history within the context window |
//! | [`experimental`] | APIs that may change in a minor release: the strategy-driven `ContextManager`, its presets, the stash and message pinning |
//! | [`injection`] | Folding just-in-time text into the latest user message |
//! | [`storage`] | The [`Storage`] trait, `InMemoryStorage`, `LocalFileStorage`, namespaces and keyword search |
//! | [`session`] | [`SessionManager`], saving and restoring agent snapshots in the layout shared with the other Strands SDKs |
//! | [`memory`] | The [`MemoryManager`] plugin, the [`MemoryStore`] trait and extraction |
//! | [`vended_memory_stores`] | `FileMemoryStore` and `TestMemoryStore` |
//! | [`sandbox`] | The [`Sandbox`] trait, where tools run commands and touch files, and `NotASandboxLocalEnvironment` |
//! | [`vended_tools`] | Shell, file, HTTP, notebook, agent-loop and subagent tools, and `mcp_router` (feature `mcp`) |
//! | [`vended_plugins`] | The context injector and [`AgentSkills`](vended_plugins::skills::AgentSkills) |
//! | [`multiagent`] | The authority-mode policies child agents are specified with |
//! | [`background_tasks`] | Running tool calls detached from the turn that requested them |
//! | [`retry`] | [`DefaultModelRetryStrategy`] and the backoff strategies |
//! | [`state_store`] | [`StateStore`], JSON state shared with tools and providers |
//! | [`cancel`] | [`CancelHandle`] and [`CancelSignal`] for cooperative cancellation |
//! | [`telemetry`] | `tracing` spans and metrics, [`AgentMetrics`] and [`AgentTrace`] |
//! | [`error`] | [`Error`], with one variant per error type |
//! | [`testing`] | Fixtures such as [`testing::MockModel`] for testing code built on strands |
//! | `mcp` | Model Context Protocol clients (feature `mcp`) |
//!
//! The crate root re-exports the main public types of these modules.
//!
//! # Wire compatibility
//!
//! Every serializable type writes the JSON shared with the other Strands SDKs: the same keys in the
//! same order, with absent optional fields omitted. Sessions and snapshots that another Strands SDK
//! writes load in Rust and serialize back unchanged, and blocks a newer SDK wrote load as
//! [`UnknownBlock`]:
//!
//! ```
//! use strands::{ContentBlock, Message, Role};
//!
//! let message = Message::new(Role::User, vec![ContentBlock::text("Hello")]);
//! assert_eq!(message.text(), "Hello");
//! let json = serde_json::to_value(&message.content).unwrap();
//! assert_eq!(json, serde_json::json!([{"text": "Hello"}]));
//! ```
//!
//! # Versioning
//!
//! strands follows semver for 0.x crates: a minor release (0.1 to 0.2) may break the API, a patch
//! release does not. The minimum supported Rust version is 1.96; it never drops below what
//! required dependencies declare, and it moves only in minor releases.
//!
//! # Public dependencies
//!
//! These crates appear in the public API, so a semver-incompatible release of any of them is a
//! breaking strands release:
//!
//! | Crate | Where | Feature |
//! |---|---|---|
//! | `serde_json` | [`JsonValue`], [`JsonObject`] | always |
//! | `schemars` 1 | the `JsonSchema` derive that structured output and `#[tool]` inputs use | always |
//! | `futures` | the `Stream` behind [`BoxStream`] | always |
//! | `async-trait` | re-exported as [`async_trait`](macro@async_trait) for extension traits | always |
//! | `aws-credential-types`, `aws-types` | credentials and `SdkConfig` escape hatches on the Bedrock and Mantle configs | `bedrock`, `mantle` |
//! | `regex`, `rmcp` | MCP tool matchers and the raw MCP types of the `McpClient` escape hatches | `mcp` |
//! | `opentelemetry`, `opentelemetry_sdk`, `tracing-opentelemetry`, `tracing-subscriber` | telemetry setup | `otel` |
//!
//! `strands` and `strands-macros` release in lockstep: `strands` depends on an exact
//! `strands-macros` version.

#![cfg_attr(docsrs, feature(doc_cfg))]

/// Compiles the README's code blocks as doctests.
#[cfg(doctest)]
#[doc = include_str!("../README.md")]
struct ReadmeDoctests;

#[doc(hidden)]
pub mod __private;
pub mod agent;
pub mod background_tasks;
mod callback;
pub mod cancel;
mod clock;
pub mod conversation_manager;
pub mod error;
pub mod experimental;
pub mod hooks;
pub mod injection;
pub mod interrupt;
pub mod interventions;
mod logging;
#[cfg(feature = "mcp")]
pub mod mcp;
pub mod memory;
pub mod middleware;
mod mime;
pub mod models;
pub mod multiagent;
pub mod plugins;
pub mod retry;
pub mod sandbox;
pub mod session;
pub mod state_store;
pub mod storage;
pub mod telemetry;
#[cfg(test)]
mod test_support;
pub mod testing;
pub mod tools;
pub mod types;
pub mod vended_interventions;
pub mod vended_memory_stores;
pub mod vended_plugins;
pub mod vended_tools;

pub use agent::{
    Agent, AgentAsTool, AgentAsToolOptions, AgentBuilder, AgentConfig, AgentResult, AgentStream, DirectToolCallOptions,
    InvocationContext, InvocationContextUsage, InvocationState, InvokeArgs, InvokeLimits, InvokeOptions, LocalAgent,
    ModelSource, RefusedCall, SnapshotField, SnapshotPreset, TakeSnapshotOptions, ToolAgent, ToolHandle,
};
pub use async_trait::async_trait;
pub use background_tasks::BackgroundTasksConfig;
pub use cancel::{CancelHandle, CancelOptions, CancelSignal};
pub use conversation_manager::{
    ConversationManager, ConversationManagerReduceOptions, NullConversationManager, ProactiveCompression,
    SlidingWindowConversationManager, SlidingWindowConversationManagerConfig, SummarizingConversationManager,
    SummarizingConversationManagerConfig,
};
pub use error::{
    BoxError, ContextWindowOverflowError, DefaultNotConfiguredError, Error, JsonValidationError, MaxTokensError,
    ModelError, ModelNetworkError, ModelThrottledError, Result, SandboxAbortError, SandboxIsADirectoryError,
    SandboxPathNotFoundError, SandboxPermissionError, SandboxTimeoutError, SessionError, StorageError,
    StructuredOutputError, ToolNotFoundError, ToolValidationError,
};
pub use hooks::{
    AfterInvocationEvent, AfterModelCallEvent, AfterToolCallEvent, AfterToolsEvent, AgentResultEvent, AgentStreamEvent,
    BeforeInvocationEvent, BeforeModelCallEvent, BeforeToolCallEvent, BeforeToolsEvent, Cancel, ContentBlockEvent,
    EndTurn, Hook, HookCallbackOptions, HookCleanup, HookOrder, HookRegistry, InitializedEvent, InterruptEvent,
    MessageAddedEvent, ModelMessageEvent, ModelStopResponse, ModelStreamUpdateEvent, ToolResultEvent,
    ToolStreamUpdateEvent, ToolUseData,
};
pub use interrupt::{Interrupt, InterruptError, InterruptSource};
pub use interventions::{InterventionAction, InterventionHandler, InterventionResult, OnError};
#[cfg(feature = "mcp")]
pub use mcp::{
    ElicitationCallback, ElicitationContext, McpCallToolOptions, McpClient, McpClientConfig, McpClientCredentials,
    McpClientOptions, McpConnectionState, McpListOptions, McpListToolsOptions, McpLoadServersOptions, McpProgress,
    McpProgressCallback, McpServerConfig, McpTool, McpToolFilterCallback, McpToolFilters, McpToolMatcher, McpTransport,
    SerializableMcpToolFilters,
};
pub use memory::{
    AddMessagesContext, ExtractionConfig, ExtractionResult, ExtractionTrigger, ExtractionTriggerContext, Extractor,
    ExtractorContext, InjectionConfig, InjectionContext, InjectionTrigger, IntervalTrigger, IntervalTriggerOptions,
    InvocationTrigger, MemoryAddOptions, MemoryAddToolConfig, MemoryContentBlockType, MemoryEntry,
    MemoryInjectionConfig, MemoryManager, MemoryManagerConfig, MemoryMessageFilter, MemorySearchOptions, MemoryStore,
    MemoryToolConfig, ModelExtractor, ModelExtractorOptions, SearchOptions,
};
pub use middleware::{
    ExecuteToolContext, ExecuteToolResult, ExecuteToolStage, InvokeModelContext, InvokeModelResult, InvokeModelStage,
    Middleware, MiddlewareCleanup, MiddlewareError, MiddlewareInterruptResult, MiddlewareNext, MiddlewarePhase,
    MiddlewareStage, StageItem, StageResult, StageStream,
};
#[cfg(feature = "bedrock")]
pub use models::bedrock::{
    BedrockCacheConfig, BedrockCacheTtl, BedrockGuardrailConfig, BedrockGuardrailRedactionConfig, BedrockModel,
    BedrockModelConfig, BedrockModelOptions,
};
pub use models::routing::{
    CandidateModel, ClassifierStrategy, ClassifierStrategyOptions, FallbackStrategy, ModelRouter, ModelRouterOptions,
    RoutingAttempt, RoutingCandidate, RoutingCandidateOptions, RoutingContext, RoutingFailure, RoutingStrategy,
};
pub use models::streaming::{
    CitationsDelta, ContentBlockDelta, ContentBlockStart, Metrics, ModelContentBlockDeltaEvent,
    ModelContentBlockStartEvent, ModelContentBlockStopEvent, ModelMessageStartEvent, ModelMessageStopEvent,
    ModelMetadataEvent, ModelRedactionEvent, ModelStreamEvent, ReasoningContentDelta, RedactInputContent,
    RedactOutputContent, TextDelta, ToolUseInputDelta, ToolUseStart, Usage,
};
pub use models::{
    AggregatedEvent, BaseModelConfig, BoxStream, CacheConfig, CacheKey, CacheSectionSetting, CacheStrategy, CacheTtl,
    CountTokensOptions, Model, ModelCapabilities, ModelInfo, ModelLimits, ModelRequest, PromptCaching, Redaction,
    StreamAggregatedResult, SummarizeOptions, SummarizeResult,
};
pub use plugins::Plugin;
pub use retry::{
    BackoffContext, BackoffStrategy, ConstantBackoff, ConstantBackoffOptions, DefaultModelRetryStrategy,
    DefaultModelRetryStrategyOptions, ExponentialBackoff, ExponentialBackoffOptions, IsRetryable, JitterKind,
    LinearBackoff, LinearBackoffOptions, ModelRetryContext, ModelRetryStrategy, RetryDecision, RetryStrategy,
};
pub use sandbox::{
    ExecuteOptions, ExecutionResult, ExecutionStream, ExecutionStreamItem, FileInfo, OutputFile, PosixShellSandbox,
    Sandbox, StreamChunk, StreamType,
};
pub use session::{
    SaveLatestStrategy, SessionManager, SessionManagerConfig, SnapshotManifest, SnapshotTriggerCallback,
    SnapshotTriggerParams,
};
pub use state_store::StateStore;
pub use storage::Storage;
pub use strands_macros::{tool, tools};
pub use telemetry::{AgentMetrics, AgentTrace};
pub use tools::{
    ConcurrentToolExecutor, FunctionTool, SequentialToolExecutor, Tool, ToolContext, ToolError, ToolExecutorStrategy,
    ToolOutcome, ToolSource, ToolStream, ToolStreamEvent, ToolStreamItem,
};
pub use types::{
    AgentMetadata, AudioBlock, AudioFormat, AudioSource, CachePointBlock, CacheType, Citation,
    CitationGeneratedContent, CitationLocation, CitationSourceContent, CitationsBlock, ContentBlock, DocumentBlock,
    DocumentCharLocation, DocumentChunkLocation, DocumentCitations, DocumentContentBlock, DocumentFormat,
    DocumentPageLocation, DocumentSource, GuardContentBlock, GuardContentImage, GuardContentText, GuardImageFormat,
    GuardImageSource, GuardQualifier, ImageBlock, ImageFormat, ImageSource, InjectedBlock, InterruptParams,
    InterruptResponse, InterruptResponseContent, JsonBlock, JsonObject, JsonValue, Message, MessageMetadata,
    ReasoningBlock, Role, S3Location, SNAPSHOT_SCHEMA_VERSION, Scope, SearchResultLocation, Snapshot, StopReason,
    SummaryBlock, SystemContentBlock, SystemPrompt, TextBlock, Toggle, ToolChoice, ToolResultBlock, ToolResultContent,
    ToolResultError, ToolResultStatus, ToolSpec, ToolUse, ToolUseBlock, UnknownBlock, UnknownStopReason, VideoBlock,
    VideoFormat, VideoSource, WebLocation,
};
