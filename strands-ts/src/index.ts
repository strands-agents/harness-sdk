/**
 * Main entry point for the Strands Agents TypeScript SDK.
 *
 * This is the primary export module for the SDK, providing access to all
 * public APIs and functionality.
 */

// Agent class
export { Agent } from './agent/agent.js'

// App state
export { StateStore } from './state-store.js'

// Agent types
export { AgentResult } from './types/agent.js'
export type { AgentConfig, ToolList, ToolExecutorStrategy } from './agent/agent.js'
export type { BackgroundTasksConfig } from './background-tasks/types.js'
export type { AgentAsToolOptions } from './agent/agent-as-tool.js'
export type { ToolCaller, ToolCallerProxy, ToolHandle, DirectToolCallOptions } from './agent/tool-caller.js'
export type { InvocationState, InvokeArgs, InvokeOptions, LocalAgent } from './types/agent.js'
export type { LifecycleObserver } from './types/lifecycle-observer.js'

// Snapshot types
export { SNAPSHOT_SCHEMA_VERSION } from './types/snapshot.js'
export type { Scope, Snapshot } from './types/snapshot.js'
export type { TakeSnapshotOptions, SnapshotField, SnapshotPreset } from './agent/snapshot.js'

// Error types
// Note: CancelledError is intentionally not exported — it is an internal
// control-flow mechanism, never thrown to consumers. See its docstring in errors.ts.
export {
  ModelError,
  ContextWindowOverflowError,
  MaxTokensError,
  JsonValidationError,
  ConcurrentInvocationError,
  ModelThrottledError,
  ToolValidationError,
  StructuredOutputError,
  ToolNotFoundError,
  DefaultNotConfiguredError,
  StorageError,
} from './errors.js'

// Interrupt system
export type { Interrupt, InterruptSource } from './interrupt.js'
export type { InterruptParams, InterruptResponse, InterruptResponseContentData } from './types/interrupt.js'
export { InterruptResponseContent } from './types/interrupt.js'

// Checkpoint APIs are experimental; see '@strands-agents/sdk/experimental'.

// JSON types
export type { JSONSchema, JSONValue } from './types/json.js'

// Message types
export type {
  Role,
  StopReason,
  TextBlockData,
  ToolUseBlockData,
  ToolResultBlockData,
  ReasoningBlockData,
  CachePointBlockData,
  GuardContentBlockData,
  GuardContentText,
  GuardContentImage,
  GuardQualifier,
  GuardImageFormat,
  GuardImageSource,
  ContentBlock,
  ContentBlockData,
  MessageData,
  SystemPrompt,
  SystemPromptData,
  SystemContentBlock,
  ToolResultContent,
} from './types/messages.js'

// Message classes
export {
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ReasoningBlock,
  CachePointBlock,
  GuardContentBlock,
  Message,
  JsonBlock,
  contentBlockFromData,
  toolResultContentFromData,
} from './types/messages.js'

// Citation types
export type {
  CitationsBlockData,
  Citation,
  CitationLocation,
  CitationSourceContent,
  CitationGeneratedContent,
} from './types/citations.js'

// Citation class
export { CitationsBlock } from './types/citations.js'

// Media classes
export { S3Location, AudioBlock, ImageBlock, VideoBlock, DocumentBlock } from './types/media.js'

// Media types
export type {
  LocationData,
  S3LocationData,
  AudioFormat,
  AudioSource,
  AudioSourceData,
  AudioBlockData,
  ImageFormat,
  ImageSource,
  ImageSourceData,
  ImageBlockData,
  VideoFormat,
  VideoSource,
  VideoSourceData,
  VideoBlockData,
  DocumentFormat,
  DocumentSource,
  DocumentSourceData,
  DocumentBlockData,
  DocumentContentBlock,
  DocumentContentBlockData,
} from './types/media.js'

// Tool types
export type { ToolSpec, ToolUse, ToolResultStatus, ToolChoice } from './tools/types.js'

// Tool interface and related types
export type { InvokableTool, ToolContext, ToolStreamEventData, ToolStreamGenerator } from './tools/tool.js'

// Tool base class and event classes
export { Tool, ToolStreamEvent } from './tools/tool.js'

// FunctionTool implementation
export { FunctionTool } from './tools/function-tool.js'
export type { FunctionToolConfig, FunctionToolCallback } from './tools/function-tool.js'

// ZodTool implementation
export { ZodTool } from './tools/zod-tool.js'
export type { ZodToolConfig } from './tools/zod-tool.js'

// Tool factory function
export { tool } from './tools/tool-factory.js'

// Tool executors
export { ConcurrentToolExecutor } from './tools/executors/concurrent.js'
export { SequentialToolExecutor } from './tools/executors/sequential.js'

// Streaming event types
export type {
  Usage,
  Metrics,
  ModelMessageStartEventData,
  ToolUseStart,
  ContentBlockStart,
  ModelContentBlockStartEventData,
  TextDelta,
  ToolUseInputDelta,
  ReasoningContentDelta,
  CitationsDelta,
  ContentBlockDelta,
  ModelContentBlockDeltaEventData,
  ModelMessageStopEventData,
  ModelMetadataEventData,
  RedactInputContent,
  RedactOutputContent,
  ModelRedactionEventData,
  ModelStreamEvent,
} from './models/streaming.js'

// Streaming event classes (value exports for instanceof checks and custom model providers)
export {
  isModelStreamEvent,
  ModelMessageStartEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStopEvent,
  ModelMessageStopEvent,
  ModelMetadataEvent,
  ModelRedactionEvent,
} from './models/streaming.js'

// Model provider types
export type { AgentMetadata, BaseModelConfig, CountTokensOptions, StreamOptions, CacheConfig } from './models/model.js'

export { Model } from './models/model.js'

// Model routing
export { ClassifierStrategy, FallbackStrategy, ModelRouter, RoutingCandidate } from './models/routing/index.js'
export type {
  CandidateInput,
  ClassifierStrategyOptions,
  ModelRouterOptions,
  RoutingAttempt,
  RoutingCandidateOptions,
  RoutingContext,
  RoutingStrategy,
} from './models/routing/index.js'

// Bedrock model provider
export { BedrockModel as BedrockModel } from './models/bedrock.js'
export type {
  BedrockModelConfig,
  BedrockModelOptions,
  BedrockGuardrailConfig,
  BedrockGuardrailRedactionConfig,
  BedrockCacheConfig,
  BedrockCacheTTL,
} from './models/bedrock.js'

// Agent streaming event types
export type { AgentStreamEvent } from './types/agent.js'

// Hooks system
export {
  HookRegistry,
  HookOrder,
  StreamEvent,
  HookableEvent,
  InitializedEvent,
  BeforeInvocationEvent,
  AfterInvocationEvent,
  MessageAddedEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  BeforeModelCallEvent,
  AfterModelCallEvent,
  BeforeToolsEvent,
  AfterToolsEvent,
  ContentBlockEvent,
  ModelMessageEvent,
  ToolResultEvent,
  ToolStreamUpdateEvent,
  AgentResultEvent,
  InterruptEvent,
  ModelStreamUpdateEvent,
} from './hooks/index.js'
export type {
  HookCallback,
  HookableEventConstructor,
  HookCallbackOptions,
  ModelStopResponse,
  Redaction,
  ToolUseData,
} from './hooks/index.js'

// Plugin system
export type { Plugin } from './plugins/index.js'

// Intervention system
export { InterventionHandler, InterventionActions } from './interventions/index.js'
export type { OnError } from './interventions/index.js'

// Retry
export {
  type BackoffContext,
  type BackoffStrategy,
  type JitterKind,
  type ConstantBackoffOptions,
  type LinearBackoffOptions,
  type ExponentialBackoffOptions,
  ConstantBackoff,
  LinearBackoff,
  ExponentialBackoff,
  ModelRetryStrategy,
  DefaultModelRetryStrategy,
  type DefaultModelRetryStrategyOptions,
  type RetryStrategy,
  type RetryDecision,
} from './retry/index.js'

// Conversation Manager
export {
  ConversationManager,
  type ProactiveCompressionConfig,
  type ConversationManagerReduceOptions,
  type ConversationManagerOptions,
} from './conversation-manager/conversation-manager.js'
export { NullConversationManager } from './conversation-manager/null-conversation-manager.js'
export {
  SlidingWindowConversationManager,
  type SlidingWindowConversationManagerConfig,
} from './conversation-manager/sliding-window-conversation-manager.js'
export {
  SummarizingConversationManager,
  type SummarizingConversationManagerConfig,
} from './conversation-manager/summarizing-conversation-manager.js'

// Logging
export { configureLogging } from './logging/logger.js'
export type { Logger } from './logging/types.js'

// MCP Client types and implementations
export {
  type McpClientOptions,
  type McpListToolsOptions,
  type McpToolFilterCallback,
  type McpToolFilters,
  type McpToolMatcher,
  type McpClientConfig,
  type McpClientCredentials,
  type McpTransport,
  type McpCallToolOptions,
  type TasksConfig,
  type McpConnectionState,
  type McpServerConfig,
  type SerializableMcpToolFilters,
  McpClient,
} from './mcp/index.js'
export type { ElicitationCallback, ElicitationContext } from './types/elicitation.js'

// Session management
export { SessionManager } from './session/session-manager.js'
export type {
  SessionManagerConfig,
  SaveLatestStrategy,
  MultiAgentSaveLatestStrategy,
} from './session/session-manager.js'
export type { SnapshotManifest, SnapshotTriggerCallback, SnapshotTriggerParams } from './session/types.js'
export type { SessionStorage, SnapshotStorage, SnapshotLocation } from './session/storage.js'
export { FileStorage } from './session/file-storage.js'

// Local Traces
export { AgentTrace } from './telemetry/tracer.js'

// Local Metrics
export { AgentMetrics } from './telemetry/meter.js'

// Storage
export type { Storage } from './storage/storage.js'

// Sandbox
export { Sandbox, type ExecuteOptions } from './sandbox/base.js'
export { PosixShellSandbox } from './sandbox/posix-shell.js'
export { SandboxTimeoutError, SandboxAbortError, SandboxPathNotFoundError } from './sandbox/errors.js'
export type { StreamType, StreamChunk, FileInfo, OutputFile, ExecutionResult } from './sandbox/types.js'

// Middleware system
export { InvokeModelStage, ExecuteToolStage } from './middleware/index.js'
export type {
  MiddlewareStage,
  MiddlewareHandler,
  MiddlewareNext,
  MiddlewareHandlerOf,
  MiddlewareNextOf,
  MiddlewareInputHandler,
  MiddlewareOutputHandler,
  InvokeModelContext,
  InvokeModelResult,
  ExecuteToolContext,
  ExecuteToolResult,
  MiddlewareInterruptResult,
  MiddlewareInterruptible,
} from './middleware/index.js'

// Multi-agent orchestration
export { Graph } from './multiagent/index.js'
export { Swarm } from './multiagent/index.js'

// Memory management
export { MemoryManager } from './memory/index.js'
export type {
  MemoryEntry,
  MemoryStore,
  MemoryStoreConfig,
  SearchOptions,
  AddMessagesContext,
  MemorySearchOptions,
  MemoryAddOptions,
  MemoryToolConfig,
  MemoryAddToolConfig,
  MemoryManagerConfig,
  MemoryInjectionConfig,
  InjectionConfig,
  InjectionTrigger,
  InjectionContext,
} from './memory/index.js'
export { ExtractionTrigger, InvocationTrigger, IntervalTrigger, ModelExtractor } from './memory/index.js'
export type {
  ExtractionConfig,
  Extractor,
  ExtractorContext,
  ExtractionResult,
  ExtractionTriggerContext,
  MemoryMessageFilter,
  MemoryContentBlockType,
  IntervalTriggerOptions,
  ModelExtractorOptions,
} from './memory/index.js'
