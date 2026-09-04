import {
  AgentResult,
  type AgentStreamEvent,
  type InvocationState,
  type InvokableAgent,
  type InvokeArgs,
  type InvokeOptions,
  type LocalAgent,
  type localAgentSymbol,
} from '../types/agent.js'
import { BedrockModel } from '../models/bedrock.js'
import {
  contentBlockFromData,
  type ContentBlock,
  type ContentBlockData,
  Message,
  type MessageData,
  type StopReason,
  type SystemPrompt,
  type SystemPromptData,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../types/messages.js'
import { deepCopy } from '../types/json.js'
import type { JSONValue } from '../types/json.js'
import { McpClient } from '../mcp/index.js'
import { isValidToolName, type Tool } from '../tools/tool.js'
import type { ToolChoice, ToolSpec } from '../tools/types.js'
import { cloneSystemPrompt, systemPromptFromData } from '../types/messages.js'
import { normalizeError, ConcurrentInvocationError, StructuredOutputError } from '../errors.js'
import { Model } from '../models/model.js'
import { ModelRouter } from '../models/routing/router.js'
import type { BaseModelConfig, StreamAggregatedResult, StreamOptions } from '../models/model.js'
import { ModelPlugin } from '../plugins/model-plugin.js'
import { totalPromptTokens, isModelStreamEvent } from '../models/streaming.js'
import { ToolRegistry } from '../registry/tool-registry.js'
import { StateStore } from '../state-store.js'
import { serializeStateSerializable, loadStateSerializable } from '../types/serializable.js'
import { AgentPrinter, getDefaultAppender, type Printer } from './printer.js'
import type { Plugin } from '../plugins/plugin.js'
import type { InterventionHandler } from '../interventions/handler.js'
import { InterventionRegistry } from '../interventions/registry.js'
import type { LifecycleObserver } from '../types/lifecycle-observer.js'
import { PluginRegistry } from '../plugins/registry.js'
import { SlidingWindowConversationManager } from '../conversation-manager/sliding-window-conversation-manager.js'
import { SummarizingConversationManager } from '../conversation-manager/summarizing-conversation-manager.js'
import { NullConversationManager } from '../conversation-manager/null-conversation-manager.js'
import { ConversationManager } from '../conversation-manager/conversation-manager.js'
import { ContextOffloader } from '../vended-plugins/context-offloader/plugin.js'
import { PendingInvocations } from '../vended-plugins/pending-invocations/plugin.js'
import {
  CONCURRENT_INVOCATION_MODES,
  InvocationQueue,
  type ConcurrentInvocationMode,
  type PendingInvocation,
} from './invocation-queue.js'
import { AgentDelegation } from './agent-delegation.js'
import type { Storage } from '../storage/storage.js'
import { HookRegistryImplementation } from '../hooks/registry.js'
import { createMiddlewareInterrupt } from '../middleware/interrupt.js'
import { MiddlewareRegistry, InvokeModelStage, AgentStreamStage } from '../middleware/index.js'
import type {
  MiddlewareStage,
  MiddlewareHandler,
  MiddlewareInputHandler,
  MiddlewareOutputHandler,
  MiddlewareInputPhase,
  MiddlewareWrapPhase,
  MiddlewareOutputPhase,
  MiddlewarePhaseKind,
} from '../middleware/index.js'
import type {
  InvokeModelContext,
  InvokeModelResult,
  AgentStreamContext,
  AgentStreamResult,
} from '../middleware/index.js'
import type { HookableEventConstructor, HookCallback, HookCallbackOptions, HookCleanup } from '../hooks/types.js'
import {
  InitializedEvent,
  AfterInvocationEvent,
  AfterModelCallEvent,
  AfterToolsEvent,
  BeforeInvocationEvent,
  BeforeModelCallEvent,
  BeforeToolsEvent,
  HookableEvent,
  MessageAddedEvent,
  ModelStreamUpdateEvent,
  ContentBlockEvent,
  ModelMessageEvent,
  ToolResultEvent,
  AgentResultEvent,
  InterruptEvent,
  type ModelStopData,
} from '../hooks/events.js'
import { StructuredOutputTool, STRUCTURED_OUTPUT_TOOL_NAME } from '../tools/structured-output-tool.js'
import { ConcurrentToolExecutor } from '../tools/executors/concurrent.js'
import { SequentialToolExecutor } from '../tools/executors/sequential.js'
import { AgentAsTool } from './agent-as-tool.js'
import type { AgentAsToolOptions } from './agent-as-tool.js'
import { ToolCaller } from './tool-caller.js'
import type { ToolCallerProxy } from './tool-caller.js'
import { continuations } from './continuation.js'

import type { z } from 'zod'
import { MemoryManager } from '../memory/memory-manager.js'
import type { MemoryManagerConfig } from '../memory/index.js'
import { SessionManager } from '../session/session-manager.js'
import { Tracer } from '../telemetry/tracer.js'
import { AgentMetrics, Meter } from '../telemetry/meter.js'
import type { AttributeValue } from '@opentelemetry/api'
import { logger } from '../logging/logger.js'
import { CancelledError, CheckpointError } from '../errors.js'
import { DefaultModelRetryStrategy } from '../retry/default-model-retry-strategy.js'
import type { RetryStrategy } from '../retry/retry-strategy.js'
import { warnOnDuplicateRetryStrategyTypes } from '../retry/retry-strategy.js'
import { InterruptError, InterruptState } from '../interrupt.js'
import { Checkpoint, type CheckpointPosition, type CheckpointResumeContent } from '../experimental/checkpoint.js'
import { isInterruptResponseContent, type InterruptResponseContent } from '../types/interrupt.js'
import { takeSnapshot as takeSnapshotInternal, loadSnapshot as loadSnapshotInternal } from './snapshot.js'
import type { TakeSnapshotOptions } from './snapshot.js'
import type { Snapshot } from '../types/snapshot.js'
import type { Sandbox } from '../sandbox/base.js'
import { defaultSandbox } from '../sandbox/default.js'
import {
  summarizeContextTool,
  truncateContextTool,
  pinContextTool,
  createTokenUsageMiddleware,
} from '../context-manager/modes/agentic/agentic-context.js'
import { ContextManager } from '../context-manager/context-manager.js'
import { BackgroundTasks } from '../background-tasks/background-tasks.js'
import type { BackgroundTasksConfig } from '../background-tasks/types.js'

/**
 * Recursive type definition for nested tool arrays.
 * Allows tools to be organized in nested arrays of any depth.
 *
 * {@link Agent} instances in the array are automatically wrapped via
 * {@link Agent.asTool}, so they can be passed directly without calling
 * `.asTool()` explicitly.
 */
export type ToolList = (Tool | McpClient | Agent | ToolList)[]

/**
 * Strategy for executing tool calls that the model emits in a single assistant turn.
 *
 * - `'concurrent'` (default) — runs all tool calls from a single turn in parallel. Per-tool event
 *   order (`BeforeToolCallEvent` → `ToolStreamUpdateEvent*` → `AfterToolCallEvent` →
 *   `ToolResultEvent`) is preserved, while cross-tool events may interleave.
 * - `'sequential'` — runs tool calls one at a time
 *
 * Cancellation works identically in both modes: {@link Agent.cancel} flips
 * {@link Agent.cancelSignal}, which SDK-managed tool contexts expose as `context.cancelSignal`.
 * In concurrent mode, prompt batch-wide cancellation requires every in-flight tool
 * to honor the signal.
 */
export type ToolExecutorStrategy = 'sequential' | 'concurrent'

/**
 * Supported string presets for the `contextManager` parameter.
 */
export const CONTEXT_MANAGER_STRATEGIES = ['auto', 'agentic'] as const
type ContextManagerPreset = (typeof CONTEXT_MANAGER_STRATEGIES)[number]

/**
 * Supported values for the `contextManager` parameter.
 *
 * - `"auto"`: Managed context with proactive compression + offloading.
 * - `"agentic"`: Model-driven context management via injected tools.
 * - `ContextManager` instance: Full control over strategy-driven offloading.
 * - `false`: Explicitly disable all context management (no compression, no offloading).
 */
export type ContextManagerStrategy = ContextManagerPreset | ContextManager | false

/** Benchmark-validated token threshold for offloading tool results. */
const CONTEXT_MANAGER_MAX_RESULT_TOKENS = 1_500
/** Higher offload threshold for agentic mode — the model manages its own context, so we preserve more inline. */
const AGENTIC_CONTEXT_MANAGER_MAX_RESULT_TOKENS = 8_000
/** Benchmark-validated preview token count for offloaded results. */
const CONTEXT_MANAGER_PREVIEW_TOKENS = 750
/** Benchmark-validated ratio of messages to summarize on overflow. */
const CONTEXT_MANAGER_SUMMARY_RATIO = 0.3
/** Benchmark-validated context window ratio that triggers proactive compression. */
const CONTEXT_MANAGER_COMPRESSION_THRESHOLD = 0.85

/**
 * Configuration object for creating a new Agent.
 */
export type AgentConfig = {
  /**
   * The model instance or router that the agent will use to make decisions.
   * Accepts a Model, ModelRouter, or a string representing a Bedrock model ID.
   * When a router is provided, `agent.model` remains its default concrete model.
   *
   * @example
   * ```typescript
   * // Using a string model ID (creates BedrockModel)
   * const agent = new Agent({
   *   model: 'global.anthropic.claude-sonnet-4-6'
   * })
   *
   * // Using an explicit BedrockModel instance with configuration
   * const agent = new Agent({
   *   model: new BedrockModel({
   *     modelId: 'global.anthropic.claude-sonnet-4-6',
   *     temperature: 0.7,
   *     maxTokens: 2048
   *   })
   * })
   * ```
   */
  model?: Model<BaseModelConfig> | ModelRouter | string
  /** An initial set of messages to seed the agent's conversation history. */
  messages?: Message[] | MessageData[]
  /**
   * An initial set of tools to register with the agent.
   * Accepts nested arrays of tools at any depth, which will be flattened automatically.
   * {@link Agent} instances are automatically wrapped as tools via {@link Agent.asTool}.
   */
  tools?: ToolList
  /**
   * A system prompt which guides model behavior.
   */
  systemPrompt?: SystemPrompt | SystemPromptData
  /** Optional initial state values for the agent. */
  appState?: Record<string, JSONValue>
  /**
   * Optional initial model-provider state (e.g., restoring `responseId` from a
   * prior session). Typically only set when hydrating from a snapshot.
   */
  modelState?: Record<string, JSONValue>
  /**
   * Enable automatic printing of agent output to console.
   * When true, prints text generation, reasoning, and tool usage as they occur.
   * Defaults to true.
   */
  printer?: boolean
  /**
   * Conversation manager for handling message history and context overflow.
   * Defaults to SlidingWindowConversationManager with windowSize of 40.
   */
  conversationManager?: ConversationManager
  /**
   * Context management strategy that controls how messages are compressed and offloaded.
   *
   * - `"auto"`: SummarizingConversationManager with proactive compression + ContextOffloader.
   * - `"agentic"`: (Experimental) Lets the model drive context management via injected tools.
   *   This mode may change in future versions.
   * - `ContextManager` instance: Strategy-driven offloading with overflow recovery.
   * - `false`: Explicitly disable context management (no compression, no offloading).
   *
   * When a `ContextManager` instance is provided, any co-provided `conversationManager` is ignored.
   * Defaults to undefined (SlidingWindowConversationManager, no offloader).
   *
   * @remarks The offloader uses in-memory storage by default. When an agent-level
   * `storage` is provided, the offloader uses that instead. Alternatively, provide
   * an explicit `ContextOffloader` with its own storage via the `plugins` parameter.
   */
  contextManager?: ContextManagerStrategy
  /**
   * Plugins to register with the agent.
   */
  plugins?: Plugin[]
  /** Background tool execution configuration. */
  backgroundTasks?: boolean | BackgroundTasksConfig
  /**
   * Retry strategy (or strategies) for failed model/tool calls.
   *
   * - Omitted: a sensible default {@link DefaultModelRetryStrategy} with exponential backoff is used.
   * - Single strategy: the given strategy is used.
   * - Array of strategies: all are registered, in the given order. Passing two
   *   instances of the same concrete class logs a warning — they will collide
   *   on `plugin.name` when the plugin registry initializes.
   * - `null` or `[]`: retries are explicitly disabled; failures propagate to the caller.
   */
  retryStrategy?: RetryStrategy | RetryStrategy[] | null
  /**
   * Intervention handlers evaluated in registration order at each lifecycle point.
   */
  interventions?: InterventionHandler[]
  /**
   * Zod schema for structured output validation.
   */
  structuredOutputSchema?: z.ZodSchema
  /**
   * Session manager for saving and restoring agent sessions
   */
  sessionManager?: SessionManager
  /**
   * Memory manager for cross-session memory retrieval and storage.
   * Manages one or more memory stores and exposes search/add tools.
   * Accepts a {@link MemoryManager} instance or a {@link MemoryManagerConfig} object (auto-wrapped).
   */
  memoryManager?: MemoryManager | MemoryManagerConfig
  /**
   * Custom trace attributes to include in all spans.
   * These attributes are merged with standard attributes in telemetry spans.
   * Telemetry must be enabled globally via telemetry.setupTracer() for these to take effect.
   */
  traceAttributes?: Record<string, AttributeValue>
  /**
   * Optional name for the agent. Defaults to "Strands Agent".
   */
  name?: string
  /**
   * Optional description of what the agent does.
   */
  description?: string
  /**
   * Optional unique identifier for the agent. Defaults to "agent".
   */
  id?: string
  /**
   * Executor for tool calls from a single assistant turn.
   *
   * Accepts a {@link ConcurrentToolExecutor}, a {@link SequentialToolExecutor},
   * or the corresponding {@link ToolExecutorStrategy} string shorthand.
   * Defaults to concurrent execution.
   */
  toolExecutor?: ConcurrentToolExecutor | SequentialToolExecutor | ToolExecutorStrategy
  /**
   * When `true`, the agent loop pauses at cycle boundaries (`afterModel`,
   * `afterTools`) and returns `stopReason: 'checkpoint'` with a populated
   * `checkpoint` field. Resume by passing the checkpoint back as
   * `{ checkpointResume: { checkpoint: ... } }`.
   *
   * The SDK does not capture conversation state in the checkpoint; pair with a
   * `SessionManager` for cross-process state continuity. Defaults to `false`.
   * See the experimental checkpoint module.
   *
   * @experimental
   */
  checkpointing?: boolean
  /**
   * Execution environment for running commands, code, and file operations.
   * When provided, sandbox-aware tools route operations through it.
   *
   * Two distinct intents, even though they resolve to the same host execution
   * in Node today:
   * - Omitted: use the environment's default sandbox (host execution in Node).
   *   This default is the slot reserved for richer behavior later.
   * - `false`: explicitly opt out of a managed sandbox and run on the host.
   *
   * Keep `false` distinct from omitting so the opt-out stays stable even if the
   * default changes.
   */
  sandbox?: Sandbox | false
  /**
   * Default storage backend for agent subsystems.
   *
   * When provided, subsystems that do not have their own explicit storage
   * (e.g., SessionManager, ContextOffloader) resolve from this value. Each
   * subsystem auto-namespaces under its own prefix (`session/`, `offloader/`)
   * to avoid key collisions. Storage specified directly on a subsystem always
   * takes precedence over this agent-level default.
   */
  storage?: Storage

  /**
   * Behavior when `invoke()` or `stream()` is called while an invocation is already
   * in progress.
   *
   * - `'throw'` (default): reject the new call with {@link ConcurrentInvocationError}.
   * - `'enqueue'`: queue the new call FIFO; it runs as its own invocation when the
   *   current one finishes. The queue is unbounded — bound it host-side by checking
   *   `pendingInvocations.length` before submitting.
   * - `'cancelPrevious'`: latest wins — cancel the running invocation and displace any
   *   queued `'cancelPrevious'` predecessors (they reject with
   *   {@link PendingInvocationCancelledError}); the new call runs next. Callers queued
   *   with `'enqueue'` are never displaced and run afterwards.
   *
   * Callers can override per call via {@link InvokeOptions.ifBusy}. Under `'enqueue'`
   * and `'cancelPrevious'`, a tool or hook of the running invocation must not `await`
   * its own agent's `invoke()`/`stream()` — the inner call would wait for the
   * invocation it is part of (cancellation is cooperative and cannot rescue it) and
   * deadlock.
   */
  concurrentInvocationMode?: ConcurrentInvocationMode
}

/**
 * Resolve the contextManager facade into a concrete ConversationManager.
 *
 * When contextManager is undefined, falls back to the default SlidingWindowConversationManager.
 * When "auto", uses SummarizingConversationManager with proactive compression.
 * When "agentic", uses SummarizingConversationManager without proactive compression
 * (the agent manages its context via tools; the context manager is only a reactive safety net).
 * When a ContextManager instance, uses NullConversationManager — the ContextManager owns
 * overflow recovery via apply().
 */
function resolveConversationManager(
  contextManager: ContextManagerStrategy | undefined,
  conversationManager: ConversationManager | undefined
): ConversationManager {
  if (contextManager === false) {
    return conversationManager ?? new NullConversationManager()
  }
  if (contextManager instanceof ContextManager) {
    return new NullConversationManager()
  }
  if (contextManager === 'agentic') {
    return (
      conversationManager ??
      new SummarizingConversationManager({
        summaryRatio: CONTEXT_MANAGER_SUMMARY_RATIO,
      })
    )
  }
  if (contextManager === 'auto') {
    return (
      conversationManager ??
      new SummarizingConversationManager({
        summaryRatio: CONTEXT_MANAGER_SUMMARY_RATIO,
        proactiveCompression: { compressionThreshold: CONTEXT_MANAGER_COMPRESSION_THRESHOLD },
      })
    )
  }
  if (contextManager !== undefined) {
    throw new Error(
      `Unsupported contextManager value: "${contextManager}". Supported values: ${CONTEXT_MANAGER_STRATEGIES.map((s) => `"${s}"`).join(', ')}`
    )
  }
  return conversationManager ?? new SlidingWindowConversationManager({ windowSize: 40 })
}

/**
 * Resolves a tool executor instance from an executor or string shorthand.
 */
function resolveToolExecutor(
  toolExecutor: ConcurrentToolExecutor | SequentialToolExecutor | ToolExecutorStrategy | undefined
): ConcurrentToolExecutor | SequentialToolExecutor {
  switch (toolExecutor) {
    case 'sequential':
      return new SequentialToolExecutor()
    case 'concurrent':
    case undefined:
      return new ConcurrentToolExecutor()
    default:
      if (typeof toolExecutor === 'string') {
        throw new Error(`Unknown toolExecutor: ${toolExecutor}`)
      }
      return toolExecutor
  }
}

/** Default name assigned to agents when none is provided. */
const DEFAULT_AGENT_NAME = 'Strands Agent'

/** Default identifier assigned to agents when none is provided. */
const DEFAULT_AGENT_ID = 'agent'

/** Result returned by tool-execution generators, threading the AfterToolsEvent back to the main loop. */
type ToolsExecutionResult = { message: Message; afterToolsEvent: AfterToolsEvent; toolsSkipped: boolean }

/** Model reached by the middleware terminal; empty when the chain short-circuits or fails before reaching it. */
type InvokedModelRef = { model?: Model }

/**
 * Orchestrates the interaction between a model, a set of tools, and MCP clients.
 * The Agent is responsible for managing the lifecycle of tools and clients
 * and invoking the core decision-making loop.
 */
export class Agent implements LocalAgent, InvokableAgent {
  /** @internal */
  declare readonly [localAgentSymbol]: true

  /**
   * The conversation history of messages between user and assistant.
   */
  public messages: Message[]
  /**
   * App state storage accessible to tools and application logic.
   * State is not passed to the model during inference.
   */
  public readonly appState: StateStore
  /**
   * Runtime state for the model provider. Used by stateful models to persist
   * provider-specific data (e.g., response IDs for conversation chaining)
   * across invocations.
   */
  public readonly modelState: StateStore
  private readonly _conversationManager: ConversationManager

  /**
   * The model provider used by the agent for inference.
   */
  public model: Model
  private readonly _modelRouter?: ModelRouter

  /**
   * The system prompt to pass to the model provider.
   */
  public systemPrompt?: SystemPrompt

  /**
   * The name of the agent.
   */
  public readonly name: string

  /**
   * The unique identifier of the agent instance.
   */
  public readonly id: string

  /**
   * Optional description of what the agent does.
   */
  public readonly description?: string

  /**
   * The context manager for strategy-driven offloading, if configured.
   */
  public readonly contextManager?: ContextManager | undefined
  /**
   * The session manager for saving and restoring agent sessions, if configured.
   */
  public readonly sessionManager?: SessionManager | undefined

  private _sessionId?: string
  /**
   * The memory manager for cross-session memory retrieval and storage, if configured.
   */
  public readonly memoryManager?: MemoryManager | undefined

  /**
   * Default storage backend for agent subsystems.
   */
  public readonly storage?: Storage | undefined

  private readonly _sandbox: Sandbox | false | undefined

  /**
   * Execution environment for running commands, code, and file operations.
   *
   * @throws DefaultNotConfiguredError if no sandbox is configured for this
   * environment (e.g. browsers, where no host default is registered).
   */
  get sandbox(): Sandbox {
    return this._sandbox || defaultSandbox.get()
  }

  /**
   * A stable, unique identifier for the current conversation session.
   *
   * If a SessionManager is attached, delegates to its sessionId.
   * Otherwise, lazily generates and caches a random 8-character hex string.
   */
  get sessionId(): string {
    if (this.sessionManager) return this.sessionManager.sessionId
    if (!this._sessionId) {
      this._sessionId = globalThis.crypto.randomUUID().slice(0, 8)
    }
    return this._sessionId
  }

  private readonly _hooksRegistry: HookRegistryImplementation
  private readonly _middlewareRegistry: MiddlewareRegistry
  private readonly _pluginRegistry: PluginRegistry
  private readonly _interventionRegistry: InterventionRegistry
  private _toolRegistry: ToolRegistry
  private _mcpClients: McpClient[]
  private _initialized: boolean
  private _isInvoking: boolean = false
  private _invocationSeq: number = 0
  /** Id of the invocation holding the turn. A resume keeps the interrupted invocation's id. @internal */
  _invocationId: number = 0
  private readonly _concurrentInvocationMode: ConcurrentInvocationMode
  private readonly _invocationQueue: InvocationQueue
  private _abortController = new AbortController()
  private _abortSignal: AbortSignal = this._abortController.signal
  private _printer?: Printer
  private _structuredOutputSchema?: z.ZodSchema | undefined
  /** Tracer instance for creating and managing OpenTelemetry spans. */
  private _tracer: Tracer
  /** Meter instance for accumulating loop metrics during invocation. */
  private _meter: Meter
  /** Interrupt state for human-in-the-loop workflows. */
  _interruptState: InterruptState
  /** Executor for tool calls from a single assistant turn. */
  private _toolExecutor: ConcurrentToolExecutor | SequentialToolExecutor
  /** When true, the agent loop pauses at cycle boundaries for durable execution. */
  private readonly _checkpointing: boolean
  /** Direct tool caller — created via {@link ToolCaller.create} factory. */
  private readonly _toolCaller: ToolCallerProxy
  private readonly _backgroundTasks: BackgroundTasks | undefined

  /**
   * Creates an instance of the Agent.
   * @param config - The configuration for the agent.
   */
  constructor(config?: AgentConfig) {
    // Initialize public fields
    this.messages = (config?.messages ?? []).map((msg) => (msg instanceof Message ? msg : Message.fromMessageData(msg)))
    this.appState = new StateStore(config?.appState)
    this.modelState = new StateStore(config?.modelState)
    this.name = config?.name ?? DEFAULT_AGENT_NAME
    this.id = config?.id ?? DEFAULT_AGENT_ID
    if (config?.description !== undefined) this.description = config.description
    this.contextManager = config?.contextManager instanceof ContextManager ? config.contextManager : undefined
    this.sessionManager = config?.sessionManager
    this.storage = config?.storage
    this.memoryManager =
      config?.memoryManager instanceof MemoryManager
        ? config.memoryManager
        : config?.memoryManager
          ? new MemoryManager(config.memoryManager)
          : undefined
    this._sandbox = config?.sandbox

    const configuredModel = config?.model
    if (typeof configuredModel === 'string') {
      this.model = new BedrockModel({ modelId: configuredModel })
    } else if (configuredModel instanceof ModelRouter) {
      this._modelRouter = configuredModel
      this.model = configuredModel.defaultModel
    } else {
      this.model = configuredModel ?? new BedrockModel()
    }

    if (config?.plugins?.some((plugin) => plugin instanceof ModelRouter)) {
      throw new Error('ModelRouter must be passed through Agent({ model }), not plugins')
    }

    // Validate and assign conversation manager
    if (this.model.stateful) {
      if (config?.conversationManager || config?.contextManager) {
        throw new Error(
          'contextManager and conversationManager cannot be used with a stateful model. The model manages conversation state server-side.'
        )
      }
      this._conversationManager = new NullConversationManager()
    } else {
      this._conversationManager = resolveConversationManager(config?.contextManager, config?.conversationManager)
    }

    const { tools, mcpClients } = flattenTools(config?.tools ?? [])
    if (config?.contextManager === 'agentic') {
      tools.push(summarizeContextTool, truncateContextTool, pinContextTool)
    }
    this._toolRegistry = new ToolRegistry(tools)
    this._mcpClients = mcpClients

    // Initialize hooks registry
    this._hooksRegistry = new HookRegistryImplementation()

    this._interventionRegistry = new InterventionRegistry(config?.interventions ?? [], this._hooksRegistry)

    // Initialize middleware registry
    this._middlewareRegistry = new MiddlewareRegistry()
    this._modelRouter?.attachToAgent(this)

    if (config?.contextManager === 'agentic') {
      this._middlewareRegistry.addInput(InvokeModelStage.Input, createTokenUsageMiddleware())
    }

    // `undefined` (omitted) → install the default; `null`/`[]` → explicit opt-out.
    const retryStrategies: RetryStrategy[] =
      config?.retryStrategy === null
        ? []
        : config?.retryStrategy === undefined
          ? [new DefaultModelRetryStrategy()]
          : Array.isArray(config.retryStrategy)
            ? config.retryStrategy
            : [config.retryStrategy]
    warnOnDuplicateRetryStrategyTypes(retryStrategies)

    // Initialize plugin registry with all plugins to be initialized during initialize().
    // Ordering notes:
    // - ModelPlugin is registered last so that on AfterInvocationEvent (which uses
    //   reverse callback ordering), it runs first — clearing messages before
    //   SessionManager saves.
    // - Retry-strategy ordering is not load-bearing for correctness: `DefaultModelRetryStrategy`
    //   guards on `event.retry`, so a user hook that already set it short-circuits
    //   the strategy regardless of registration order.
    const hasOffloader = (config?.plugins ?? []).some((p) => p.name === 'strands:context-offloader')
    // Always register AgentDelegation so delegation semantics work regardless of
    // when a delegate tool is added (construction, plugin getTools, MCP, runtime).
    // The plugin is a no-op when no delegation tools fire.
    const hasAgentDelegation = (config?.plugins ?? []).some((p) => p.name === 'strands:agent-delegation')

    // Validated at runtime so an unrecognized value from an untyped (JS) caller fails loudly.
    const concurrentInvocationMode = config?.concurrentInvocationMode ?? 'throw'
    if (!CONCURRENT_INVOCATION_MODES.includes(concurrentInvocationMode)) {
      throw new Error(
        `Unsupported concurrentInvocationMode value: ${JSON.stringify(concurrentInvocationMode)}. Supported values: ${CONCURRENT_INVOCATION_MODES.map((m) => `"${m}"`).join(', ')}`
      )
    }
    this._concurrentInvocationMode = concurrentInvocationMode
    this._invocationQueue = new InvocationQueue()
    const hasPendingInvocations = (config?.plugins ?? []).some((p) => p.name === 'strands:pending-invocations')

    const contextManagerPlugin = config?.contextManager instanceof ContextManager ? config.contextManager : undefined
    this._backgroundTasks = config?.backgroundTasks
      ? new BackgroundTasks(
          config.backgroundTasks === true ? {} : config.backgroundTasks,
          (tool, context, middlewareInterrupt) =>
            this._toolExecutor.executeBackground(
              {
                agent: this,
                middlewareRegistry: this._middlewareRegistry,
                // Isolate mutable local trace state from overlapping agent work. OTel spans
                // still use the global provider; local traces are not added to AgentResult.traces.
                tracer: new Tracer(config?.traceAttributes),
                meter: this._meter,
                cancelSignal: context.cancelSignal,
                toolInterrupt: context.interrupt,
                middlewareInterrupt,
                toolGuard: (selectedTool) => this._backgroundTasks!.assertToolCanRun(selectedTool),
              },
              context.toolUse,
              tool,
              context.invocationState,
              (event) => this._invokeCallbacks(event)
            )
        )
      : undefined

    this._pluginRegistry = new PluginRegistry([
      ...(this._modelRouter ? [this._modelRouter] : []),
      this._conversationManager,
      ...retryStrategies,
      ...(config?.plugins ?? []),
      ...(this._backgroundTasks ? [this._backgroundTasks] : []),
      ...(!hasAgentDelegation ? [new AgentDelegation()] : []),
      ...(concurrentInvocationMode !== 'throw' && !hasPendingInvocations ? [new PendingInvocations()] : []),
      ...((config?.contextManager === 'auto' || config?.contextManager === 'agentic') && !hasOffloader
        ? [
            new ContextOffloader({
              maxResultTokens:
                config?.contextManager === 'agentic'
                  ? AGENTIC_CONTEXT_MANAGER_MAX_RESULT_TOKENS
                  : CONTEXT_MANAGER_MAX_RESULT_TOKENS,
              previewTokens: CONTEXT_MANAGER_PREVIEW_TOKENS,
            }),
          ]
        : []),
      ...(this.memoryManager ? [this.memoryManager] : []),
      ...(contextManagerPlugin ? [contextManagerPlugin] : []),
      ...(config?.sessionManager ? [config.sessionManager] : []),
      new ModelPlugin(this.model),
    ])

    if (config?.systemPrompt !== undefined) {
      this.systemPrompt = systemPromptFromData(config.systemPrompt)
    }

    // Create printer if printer is enabled (default: true)
    const printer = config?.printer ?? true
    if (printer) {
      this._printer = new AgentPrinter(getDefaultAppender())
    }

    // Store structured output schema
    this._structuredOutputSchema = config?.structuredOutputSchema

    // Initialize tracer - OTEL returns no-op tracer if not configured
    this._tracer = new Tracer(config?.traceAttributes)

    // Initialize meter for local metrics accumulation
    this._meter = new Meter()

    // Initialize interrupt state for human-in-the-loop workflows
    this._interruptState = new InterruptState()

    this._toolExecutor = resolveToolExecutor(config?.toolExecutor)
    this._checkpointing = config?.checkpointing ?? false
    // Pass a private helper into ToolCaller so message append + hook firing
    // remains an internal concern of Agent (not exposed as a public method).
    this._toolCaller = ToolCaller.create(this, (message, invocationState) =>
      this._appendMessageAndFireHooks(message, invocationState)
    )

    this._initialized = false
  }

  /**
   * Register a hook callback for a specific event type.
   *
   * @param eventType - The event class constructor to register the callback for
   * @param callback - The callback function to invoke when the event occurs
   * @param options - Optional configuration including execution order
   * @returns Cleanup function that removes the callback when invoked
   *
   * @example
   * ```typescript
   * const agent = new Agent({ model })
   *
   * const cleanup = agent.addHook(BeforeInvocationEvent, (event) => {
   *   console.log('Invocation started')
   * })
   *
   * // Later, to remove the hook:
   * cleanup()
   * ```
   */
  addHook<T extends HookableEvent>(
    eventType: HookableEventConstructor<T>,
    callback: HookCallback<T>,
    options?: HookCallbackOptions
  ): HookCleanup {
    return this._hooksRegistry.addCallback(eventType, callback, options)
  }

  /**
   * Register an Input phase handler that transforms context before execution.
   * Input handlers run before Wrap and Output handlers.
   *
   * @example
   * ```typescript
   * agent.addMiddleware(InvokeModelStage.Input, async (context) => ({
   *   ...context,
   *   systemPrompt: injectToSystemPrompt(context),
   * }))
   * ```
   */
  addMiddleware<TContext, TResult, TEvent>(
    phase: MiddlewareInputPhase<TContext, TResult, TEvent>,
    handler: MiddlewareInputHandler<TContext>
  ): () => void
  /**
   * Register a Wrap phase handler via the explicit `.Wrap` sub-token.
   * Equivalent to passing the stage token directly.
   */
  addMiddleware<TContext, TResult, TEvent>(
    phase: MiddlewareWrapPhase<TContext, TResult, TEvent>,
    handler: MiddlewareHandler<TContext, TResult, TEvent>
  ): () => void
  /**
   * Register an Output phase handler that transforms the result after execution.
   * Output handlers see the result after Wrap handlers complete.
   * Execution order: Input → Wrap → Output.
   *
   * @example
   * ```typescript
   * agent.addMiddleware(InvokeModelStage.Output, async (result) => {
   *   log(`Model returned stopReason=${result.result.stopReason}`)
   *   return result
   * })
   * ```
   */
  addMiddleware<TContext, TResult, TEvent>(
    phase: MiddlewareOutputPhase<TContext, TResult, TEvent>,
    handler: MiddlewareOutputHandler<TResult>
  ): () => void
  /**
   * Register a middleware handler for a given stage (Wrap phase).
   * Middleware wraps stage execution and can intercept, transform, or short-circuit operations.
   *
   * @param stage - The stage token identifying the interception point
   * @param handler - The middleware handler function (async generator)
   * @returns A cleanup function that removes the middleware when called
   *
   * @example
   * ```typescript
   * const cleanup = agent.addMiddleware(InvokeModelStage, async function* (context, next) {
   *   const start = Date.now()
   *   const result = yield* next(context)
   *   console.log(`Model call took ${Date.now() - start}ms`)
   *   return result
   * })
   *
   * // Later, remove the middleware:
   * cleanup()
   * ```
   */
  addMiddleware<TContext, TResult, TEvent>(
    stage: MiddlewareStage<TContext, TResult, TEvent>,
    handler: MiddlewareHandler<TContext, TResult, TEvent>
  ): () => void
  addMiddleware<TContext, TResult, TEvent>(
    stageOrPhase:
      | MiddlewareStage<TContext, TResult, TEvent>
      | MiddlewareInputPhase<TContext, TResult, TEvent>
      | MiddlewareWrapPhase<TContext, TResult, TEvent>
      | MiddlewareOutputPhase<TContext, TResult, TEvent>,
    handler:
      MiddlewareHandler<TContext, TResult, TEvent> | MiddlewareInputHandler<TContext> | MiddlewareOutputHandler<TResult>
  ): () => void {
    if ('_phase' in stageOrPhase) {
      const phase = stageOrPhase as { _phase: MiddlewarePhaseKind; _stage: MiddlewareStage<TContext, TResult, TEvent> }
      const stage = phase._stage
      switch (phase._phase) {
        case 'input': {
          const adapted = this._middlewareRegistry.addInput(
            stageOrPhase as MiddlewareInputPhase<TContext, TResult, TEvent>,
            handler as MiddlewareInputHandler<TContext>
          )
          return () => this._middlewareRegistry.remove(stage, adapted)
        }
        case 'output': {
          const adapted = this._middlewareRegistry.addOutput(
            stageOrPhase as MiddlewareOutputPhase<TContext, TResult, TEvent>,
            handler as MiddlewareOutputHandler<TResult>
          )
          return () => this._middlewareRegistry.remove(stage, adapted)
        }
        case 'wrap': {
          const wrapHandler = handler as MiddlewareHandler<TContext, TResult, TEvent>
          this._middlewareRegistry.add(stage, wrapHandler)
          return () => this._middlewareRegistry.remove(stage, wrapHandler)
        }
        default:
          throw new Error(`Unknown middleware phase: ${(phase as { _phase: string })._phase}`)
      }
    }
    const stage = stageOrPhase as MiddlewareStage<TContext, TResult, TEvent>
    const wrapHandler = handler as MiddlewareHandler<TContext, TResult, TEvent>
    this._middlewareRegistry.add(stage, wrapHandler)
    return () => this._middlewareRegistry.remove(stage, wrapHandler)
  }

  public async initialize(): Promise<void> {
    if (this._initialized) {
      return
    }

    // Initialize MCP clients and register their tools
    await Promise.all(
      this._mcpClients.map(async (client) => {
        const tools = await client.listTools()
        this._toolRegistry.add(tools)
        client.onToolsChanged = (oldTools, newTools): void => {
          oldTools.forEach((name) => this._toolRegistry.remove(name))
          this._toolRegistry.addOrReplace(newTools)
        }
      })
    )

    // Register tools vended by the sandbox. The host default vends nothing. A tool
    // is skipped if the user already registered one with that name.
    if (this._sandbox) {
      for (const sandboxTool of this._sandbox.getTools()) {
        if (this._toolRegistry.get(sandboxTool.name)) {
          logger.debug(
            `tool_name=<${sandboxTool.name}> | sandbox-vended tool skipped, user already registered a tool with this name`
          )
        } else {
          this._toolRegistry.add(sandboxTool)
        }
      }
    }

    await this._pluginRegistry.initialize(this)

    for (const handler of this._interventionRegistry.handlers) {
      const observer = handler as Partial<LifecycleObserver>
      if (typeof observer.observeAgent === 'function') {
        await observer.observeAgent(this)
      }
    }

    await this._hooksRegistry.invokeCallbacks(new InitializedEvent({ agent: this }))

    this._initialized = true
  }

  /**
   * Acquires the invocation turn, following `options.ifBusy` (falling back to the
   * agent's `concurrentInvocationMode`) when the agent is busy. Callers must release
   * via try/finally with {@link _releaseTurn}.
   */
  private async _acquireTurn(args: InvokeArgs, options?: InvokeOptions): Promise<void> {
    if (options?.ifBusy !== undefined && !CONCURRENT_INVOCATION_MODES.includes(options.ifBusy)) {
      throw new Error(
        `Unsupported ifBusy value: ${JSON.stringify(options.ifBusy)}. Supported values: ${CONCURRENT_INVOCATION_MODES.map((v) => `"${v}"`).join(', ')}`
      )
    }
    if (!this._isInvoking) {
      this._isInvoking = true
      this._installTurnController()
      return
    }
    const strategy = options?.ifBusy ?? this._concurrentInvocationMode
    switch (strategy) {
      case 'throw':
        throw new ConcurrentInvocationError(
          "Agent is already processing an invocation. Wait for the current invoke() or stream() call to complete, or set concurrentInvocationMode / ifBusy to 'enqueue' to queue instead."
        )
      case 'enqueue':
      case 'cancelPrevious': {
        const turn = this._invocationQueue.wait(args, {
          supersede: strategy === 'cancelPrevious',
          ...(options?.cancelSignal !== undefined && { cancelSignal: options.cancelSignal }),
        })
        // An already-aborted caller never enters the queue; don't cancel the running
        // invocation on its behalf.
        if (strategy === 'cancelPrevious' && options?.cancelSignal?.aborted !== true) {
          this.cancel()
        }
        await turn
        return
      }
      default: {
        const exhaustive: never = strategy
        throw new Error(`Unsupported concurrency mode: ${String(exhaustive)}`)
      }
    }
  }

  /**
   * Registers a listener invoked whenever an invocation enters the pending queue.
   *
   * @returns A function that detaches the listener
   * @internal
   */
  _onInvocationEnqueued(listener: () => void): () => void {
    return this._invocationQueue.onEnqueue(listener)
  }

  /**
   * Releases the invocation turn: hands the lock to the next queued invocation, or
   * clears the busy flag when the queue is empty.
   */
  private _releaseTurn(): void {
    if (this._invocationQueue.handoff()) {
      // Install the successor's controller synchronously so a cancel() arriving before
      // its first loop pass targets the successor, not the predecessor's stale controller.
      this._installTurnController()
    } else {
      this._isInvoking = false
    }
  }

  /** Installs a fresh AbortController for the invocation that now owns the turn. */
  private _installTurnController(): void {
    this._abortController = new AbortController()
    this._abortSignal = this._abortController.signal
  }

  /**
   * Throws {@link CancelledError} if cancellation has been requested.
   * Called at cancellation checkpoints within the agent loop.
   */
  private _throwIfCancelled(): void {
    if (this.isCancelled) {
      throw new CancelledError()
    }
  }

  /**
   * Validates the per-invocation budget caps in {@link InvokeOptions.limits}.
   * Called once at the top of `_stream` so bad inputs fail fast with a clear
   * error instead of silently no-op'ing (`NaN`, `Infinity`) or tripping
   * pathologically (zero swallows the user input; negative trips immediately).
   *
   * Each cap, when set, must be a positive finite number. Fractional values
   * are accepted — harmless, and useful for token budgets derived from
   * arithmetic.
   */
  private _validateLimits(options: InvokeOptions | undefined): void {
    if (!options?.limits) return
    const assertPositive = (name: string, value: number | undefined): void => {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        throw new TypeError(`${name} must be a positive finite number, got ${value}`)
      }
    }
    assertPositive('limits.turns', options.limits.turns)
    assertPositive('limits.outputTokens', options.limits.outputTokens)
    assertPositive('limits.totalTokens', options.limits.totalTokens)
  }

  /**
   * Evaluates the per-invocation budget caps in {@link InvokeOptions.limits}
   * against the current invocation's metrics. Called at the top of each
   * agent-loop iteration, after `_throwIfCancelled` and before `startCycle`.
   *
   * Reads from {@link AgentMetrics.latestAgentInvocation} (scoped to the
   * current invocation) — not `cycleCount` / `accumulatedUsage`, which are
   * lifetime accumulators that would cause caps to fire prematurely on the
   * second `invoke()` call against a reused agent.
   *
   * Priority on simultaneous trip: turns → totalTokens → outputTokens.
   *
   * Returns the {@link StopReason} the loop should terminate with, or
   * `undefined` if every configured cap is still within budget.
   */
  private _checkLimits(options: InvokeOptions | undefined): StopReason | undefined {
    const limits = options?.limits
    if (!limits) return undefined
    const invocation = this._meter.metrics.latestAgentInvocation
    if (!invocation) return undefined

    const cycleCount = invocation.cycles.length
    const { outputTokens, totalTokens } = invocation.usage

    if (limits.turns !== undefined && cycleCount >= limits.turns) {
      return 'limitTurns'
    }
    if (limits.totalTokens !== undefined && totalTokens >= limits.totalTokens) {
      return 'limitTotalTokens'
    }
    if (limits.outputTokens !== undefined && outputTokens >= limits.outputTokens) {
      return 'limitOutputTokens'
    }
    return undefined
  }

  /**
   * The tools this agent can use.
   */
  get tools(): Tool[] {
    return this._toolRegistry.list()
  }

  /**
   * The tool registry for managing the agent's tools.
   */
  get toolRegistry(): ToolRegistry {
    return this._toolRegistry
  }

  /**
   * Executor for tool calls from a single assistant turn.
   *
   * Reading always yields the resolved executor instance. Assigning accepts an
   * executor instance or a {@link ToolExecutorStrategy} string shorthand, which is
   * resolved to the matching instance on write.
   *
   * @throws Error if assigned an unrecognized string shorthand.
   */
  get toolExecutor(): ConcurrentToolExecutor | SequentialToolExecutor {
    return this._toolExecutor
  }

  set toolExecutor(toolExecutor: ConcurrentToolExecutor | SequentialToolExecutor | ToolExecutorStrategy) {
    this._toolExecutor = resolveToolExecutor(toolExecutor)
  }

  /**
   * Read-only snapshot of accumulated agent metrics (cycles, token usage, tool stats).
   */
  get metrics(): AgentMetrics {
    return this._meter.metrics
  }

  /**
   * Whether the agent is currently processing an invocation.
   */
  get isInvoking(): boolean {
    return this._isInvoking
  }

  /** The agent-level concurrency mode ({@link AgentConfig.concurrentInvocationMode}). */
  get concurrentInvocationMode(): ConcurrentInvocationMode {
    return this._concurrentInvocationMode
  }

  /** Point-in-time snapshot of invocations waiting in the agent's queue, in run order. */
  get pendingInvocations(): readonly PendingInvocation[] {
    return this._invocationQueue.list()
  }

  /**
   * Removes a queued invocation before it runs; its caller rejects with
   * {@link PendingInvocationCancelledError}. Use {@link cancel} for the running invocation.
   *
   * @param id - The queue id from {@link pendingInvocations}
   * @returns `true` when the entry was found and removed
   */
  public cancelPending(id: string): boolean {
    return this._invocationQueue.cancel(id)
  }

  /**
   * Direct tool calling accessor.
   *
   * Returns a proxy where each property is a {@link ToolHandle} with
   * `.invoke()` and `.stream()` methods:
   * ```typescript
   * const result = await agent.tool.calculator!.invoke({ a: 5, b: 3 })
   *
   * for await (const event of agent.tool.calculator!.stream({ a: 5, b: 3 })) {
   *   console.log('progress:', event)
   * }
   * ```
   *
   * Supports underscore-to-hyphen and case-insensitive name resolution.
   * Results are recorded in message history by default (pass
   * `{ recordDirectToolCall: false }` to skip).
   */
  get tool(): ToolCallerProxy {
    return this._toolCaller
  }

  /**
   * The cancellation signal for the current invocation.
   *
   * SDK-managed tool contexts receive this as `context.cancelSignal` for cancellable operations.
   * Hooks can check `event.agent.cancelSignal.aborted` to detect cancellation.
   */
  get cancelSignal(): AbortSignal {
    return this._abortSignal
  }

  /**
   * Cancels the current agent invocation cooperatively.
   *
   * The agent will stop at the next cancellation-safe point:
   * - During model response streaming
   * - Before tool execution
   * - Between sequential tool executions
   * - At the top of each agent loop cycle
   *
   * If a tool is already executing, it will run to completion unless
   * the tool checks `context.cancelSignal` internally.
   *
   * Hook callbacks can check `event.agent.cancelSignal.aborted` to detect
   * cancellation and adjust their behavior accordingly.
   *
   * The stream/invoke call will return an AgentResult with `stopReason: 'cancelled'`,
   * or `stopReason: 'endTurn'` when the final model pass had already completed and the
   * invocation was only awaiting end-of-invocation work (e.g. background-task
   * settlement). If the agent is not currently invoking, this is a no-op.
   *
   * Only the *running* invocation is cancelled; use {@link cancelPending} to remove a
   * queued invocation.
   *
   * @example
   * ```typescript
   * const agent = new Agent({ model, tools })
   *
   * // Cancel after 5 seconds
   * setTimeout(() => agent.cancel(), 5000)
   * const result = await agent.invoke('Do something')
   * console.log(result.stopReason) // 'cancelled'
   * ```
   */
  public cancel(): void {
    if (this._isInvoking) {
      this._abortController.abort()
    }
  }

  /**
   * Whether the current invocation has been cancelled.
   * Returns `false` when the agent is idle.
   */
  private get isCancelled(): boolean {
    return this._abortSignal.aborted
  }

  /**
   * Invokes the agent and returns the final result.
   *
   * This is a convenience method that consumes the stream() method and returns
   * only the final AgentResult. Use stream() if you need access to intermediate
   * streaming events.
   *
   * @param args - Arguments for invoking the agent
   * @param options - Optional per-invocation options
   * @returns Promise that resolves to the final AgentResult
   *
   * @example
   * ```typescript
   * const agent = new Agent({ model, tools })
   * const result = await agent.invoke('What is 2 + 2?')
   * console.log(result.lastMessage) // Agent's response
   * ```
   */
  public async invoke(args: InvokeArgs, options?: InvokeOptions): Promise<AgentResult> {
    const gen = this.stream(args, options)
    let result = await gen.next()
    while (!result.done) {
      result = await gen.next()
    }
    return result.value
  }

  /**
   * Streams the agent execution, yielding events and returning the final result.
   *
   * The agent loop manages the conversation flow by:
   * 1. Streaming model responses and yielding all events
   * 2. Executing tools when the model requests them
   * 3. Continuing the loop until the model completes without tool use
   *
   * Use this method when you need access to intermediate streaming events.
   * For simple request/response without streaming, use invoke() instead.
   *
   * An explicit goal of this method is to always leave the message array in a way that
   * the agent can be reinvoked with a user prompt after this method completes. To that end
   * assistant messages containing tool uses are only added after tool execution succeeds
   * with valid toolResponses
   *
   * Generators are lazy: the invocation starts (and, under queueing concurrency,
   * enters the invocation queue) at the first iteration, not when stream() returns.
   *
   * @param args - Arguments for invoking the agent
   * @param options - Optional per-invocation options
   * @returns Async generator that yields AgentStreamEvent objects and returns AgentResult
   *
   * @example
   * ```typescript
   * const agent = new Agent({ model, tools })
   *
   * for await (const event of agent.stream('Hello')) {
   *   console.log('Event:', event.type)
   * }
   * // Messages array is mutated in place and contains the full conversation
   * ```
   */
  public async *stream(
    args: InvokeArgs,
    options?: InvokeOptions
  ): AsyncGenerator<AgentStreamEvent, AgentResult, undefined> {
    await this._acquireTurn(args, options)
    let continuationEvent: AfterInvocationEvent | undefined
    try {
      await this.initialize()

      // A resume continues the interrupted request, so it keeps that invocation's id.
      if (!this._interruptState.activated) {
        this._invocationId = ++this._invocationSeq
      }

      // Thread the resolved invocationState so all layers share the same reference.
      const invocationState = options?.invocationState ?? {}
      const resolvedOptions: InvokeOptions = options?.invocationState ? options : { ...options, invocationState }

      let currentArgs: InvokeArgs = args
      let firstPass = true

      while (true) {
        // Fresh AbortController per iteration, composed with any external signal. The
        // first pass adopts the controller installed at turn acquisition, so a cancel
        // that landed between acquiring the turn and this point is observed, not wiped.
        if (!firstPass) {
          this._abortController = new AbortController()
        }
        firstPass = false
        this._abortSignal = resolvedOptions?.cancelSignal
          ? AbortSignal.any([this._abortController.signal, resolvedOptions.cancelSignal])
          : this._abortController.signal

        // Process interrupt responses before middleware runs so context.interrupt() can find them
        const interruptResponses = this._extractInterruptResponses(currentArgs)
        if (interruptResponses.length > 0) {
          this._interruptState.resume(interruptResponses)
        }

        // Hooks fire outside middleware — always, even on short-circuit.
        const beforeInvocationEvent = new BeforeInvocationEvent({ agent: this, invocationState })
        yield await this._invokeCallbacks(beforeInvocationEvent)

        if (beforeInvocationEvent.cancel) {
          const cancelText =
            typeof beforeInvocationEvent.cancel === 'string'
              ? beforeInvocationEvent.cancel
              : 'invocation denied by hook'
          const message = new Message({ role: 'assistant', content: [new TextBlock(cancelText)] })
          yield this._appendMessage(message, invocationState)
          const afterEvent = new AfterInvocationEvent({ agent: this, invocationState })
          await continuations.abandon(
            continuationEvent,
            new Error('Continuation was not incorporated into agent history')
          )
          continuationEvent = afterEvent
          await this._invokeCallbacks(afterEvent)
          yield afterEvent
          return new AgentResult({
            stopReason: 'endTurn',
            lastMessage: message,
            traces: this._tracer.localTraces,
            metrics: this._meter.metrics,
            invocationState,
          })
        }

        let result: AgentResult | undefined
        let caughtError: Error | undefined
        const afterInvocationEvent = new AfterInvocationEvent({ agent: this, invocationState })
        try {
          result = yield* this._streamWithMiddleware(currentArgs, resolvedOptions, invocationState, continuationEvent)
        } catch (error) {
          caughtError = error as Error
        } finally {
          // AfterInvocationEvent always fires — even on error or consumer break. Outside middleware.
          // Invoke hooks (so .resume can be set) but don't yield in finally (yields in finally
          // suspend the generator on consumer break instead of completing cleanup).
          await continuations.abandon(
            continuationEvent,
            new Error('Continuation was not incorporated into agent history')
          )
          continuationEvent = afterInvocationEvent
          await this._invokeCallbacks(afterInvocationEvent)
        }

        // Yield outside finally — in JS, a `yield` inside `finally` suspends the generator
        // mid-cleanup when the consumer breaks, preventing subsequent cleanup code from running.
        // This line is only reached on normal completion or caught error, never on consumer break.
        yield afterInvocationEvent

        // Re-throw after hooks have fired
        if (caughtError) {
          throw caughtError
        }

        const stopReason = result!.stopReason
        const allowsContinuation = stopReason === 'endTurn' || stopReason === 'stopSequence'
        if (!allowsContinuation && stopReason !== 'interrupt') {
          await continuations.abandon(afterInvocationEvent, new Error(`Continuation abandoned after ${stopReason}`))
        }

        const hasContinuation =
          (await continuations.prepare(
            afterInvocationEvent,
            (continuationArgs) => this._normalizeInput(continuationArgs),
            stopReason
          )) !== undefined
        continuationEvent = hasContinuation ? afterInvocationEvent : undefined

        // Don't let a continuation swallow an abort that arrived during AfterInvocation:
        // return the completed result instead; abandoned inputs re-deliver in a later
        // invocation. `resume` is not gated — its passes terminate promptly.
        const cancelledAfterFinalPass = hasContinuation && this._abortSignal.aborted

        if ((hasContinuation && !cancelledAfterFinalPass) || afterInvocationEvent.resume !== undefined) {
          currentArgs = afterInvocationEvent.resume ?? []
          continue
        }

        // Only emit AgentResultEvent on the final iteration (not on resumed ones).
        yield await this._invokeCallbacks(
          new AgentResultEvent({
            agent: this,
            result: result!,
            invocationState,
          })
        )
        return result!
      }
    } finally {
      await continuations.abandon(
        continuationEvent,
        new Error('Agent stream closed before continuation input was incorporated into agent history')
      )
      this._releaseTurn()
    }
  }

  /**
   * Invokes the AgentStreamStage middleware chain.
   * Hooks fire outside this method (in stream()'s resume loop).
   */
  private async *_streamWithMiddleware(
    args: InvokeArgs,
    options: InvokeOptions,
    invocationState: InvocationState,
    continuationEvent?: AfterInvocationEvent
  ): AsyncGenerator<AgentStreamEvent, AgentResult, undefined> {
    // Snapshot so a gate that re-reads its response after next() still resolves even if a tool cycle called deactivate().
    const interruptsSnapshot = { ...this._interruptState.interrupts }
    const context: AgentStreamContext = {
      agent: this,
      args,
      ...(options !== undefined && { options }),
      interrupt: createMiddlewareInterrupt(this._interruptState, 'middleware:agentStream', interruptsSnapshot),
    }

    // async function* doesn't bind lexical `this`; capture for the terminal callback.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    try {
      const { result } = yield* this._middlewareRegistry.invoke(
        AgentStreamStage,
        context,
        async function* (ctx: AgentStreamContext): AsyncGenerator<AgentStreamEvent, AgentStreamResult, undefined> {
          const streamArgs = continuations.combine(continuationEvent, ctx.args, (continuationArgs) =>
            self._normalizeInput(continuationArgs)
          )
          const result = yield* self._streamCore(
            streamArgs,
            ctx.options,
            streamArgs === ctx.args ? undefined : continuationEvent
          )
          return { result }
        }
      )
      if (
        this._interruptState.activated &&
        result.stopReason !== 'interrupt' &&
        !this._interruptState.pendingToolExecution
      ) {
        this._interruptState.deactivate()
      }
      return result
    } catch (error) {
      if (error instanceof InterruptError) {
        for (const interrupt of error.interrupts) {
          this._interruptState.registerInterrupt(interrupt)
        }
        this._interruptState.activate()
        for (const interrupt of error.interrupts) {
          yield new InterruptEvent({ agent: this, interrupt, invocationState })
        }
        return new AgentResult({
          stopReason: 'interrupt',
          lastMessage:
            this.messages.length > 0
              ? this.messages[this.messages.length - 1]!
              : new Message({ role: 'assistant', content: [new TextBlock('Interrupted')] }),
          traces: this._tracer.localTraces,
          metrics: this._meter.metrics,
          interrupts: this._interruptState.getUnansweredInterrupts(),
          invocationState,
        })
      }
      throw error
    }
  }

  /**
   * Single-pass stream through _stream() with event processing.
   * No resume loop, no lifecycle events — those are handled by stream()'s resume loop.
   */
  private async *_streamCore(
    args: InvokeArgs,
    options?: InvokeOptions,
    continuationEvent?: AfterInvocationEvent
  ): AsyncGenerator<AgentStreamEvent, AgentResult, undefined> {
    const streamGenerator = this._stream(args, options, continuationEvent)
    let caughtError: Error | undefined
    let iterationResult: IteratorResult<AgentStreamEvent, AgentResult>
    try {
      iterationResult = await streamGenerator.next()

      while (!iterationResult.done) {
        try {
          const processed = await this._invokeCallbacks(iterationResult.value)
          yield processed
          iterationResult = await streamGenerator.next()
        } catch (error) {
          // Throw interrupt errors back into _stream so executeTools can store the
          // assistant message as pending execution state for resume.
          if (error instanceof InterruptError) {
            iterationResult = await streamGenerator.throw(error)
          } else {
            throw error
          }
        }
      }
    } catch (error) {
      caughtError = error as Error
      throw error
    } finally {
      // Drain _stream() so cleanup hooks and printer still fire.
      // Yield only on error (consumer may still be iterating); on a consumer
      // break, yielding would suspend the generator and leak the lock.
      let drainResult = await streamGenerator.return(undefined as never)
      while (!drainResult.done) {
        try {
          if (caughtError) {
            yield await this._invokeCallbacks(drainResult.value)
          } else {
            await this._invokeCallbacks(drainResult.value)
          }
        } catch (error) {
          logger.warn(
            `event_type=<${drainResult.value.type}>, error=<${error}> | error invoking callbacks during cleanup`
          )
        }
        drainResult = await streamGenerator.next()
      }

      // Reset controller and signal for next iteration / invocation
      this._abortController = new AbortController()
      this._abortSignal = this._abortController.signal
    }

    return iterationResult.value
  }

  /**
   * Returns a {@link Tool} that wraps this agent, allowing it to be used
   * as a tool by another agent.
   *
   * The returned tool accepts a single `input` string parameter, invokes
   * this agent, and returns the text response as a tool result.
   *
   * **Note:** You can also pass an Agent directly in another agent's
   * {@link AgentConfig.tools | tools} array — it will be wrapped
   * automatically via this method.
   *
   * @param options - Optional configuration for the tool name, description, and context preservation
   * @returns A Tool wrapping this agent
   *
   * @example
   * ```typescript
   * const researcher = new Agent({ name: 'researcher', description: 'Finds info', printer: false })
   *
   * // Explicit wrapping
   * const writer = new Agent({ tools: [researcher.asTool()] })
   *
   * // Automatic wrapping (equivalent)
   * const writer = new Agent({ tools: [researcher] })
   * ```
   */
  public asTool(options?: AgentAsToolOptions): Tool {
    return new AgentAsTool({ agent: this, ...options })
  }

  /**
   * Captures a point-in-time snapshot of the agent's current state.
   *
   * Use snapshots to checkpoint agent state for later restoration, enabling
   * use cases like undo/redo, branching conversations, and session persistence.
   * Queued invocations ({@link pendingInvocations}) are not captured — they belong
   * to the live process.
   *
   * Fields are selected via a preset/include/exclude model:
   * 1. Start with preset fields (e.g. `'session'` captures all fields)
   * 2. Add any `include` fields
   * 3. Remove any `exclude` fields
   *
   * @param options - Controls which fields to capture and optional app data to store
   * @returns A {@link Snapshot} containing the captured agent state
   * @throws Error if no fields would be included after applying options
   *
   * @example
   * ```typescript
   * // Capture all session-relevant state
   * const snapshot = agent.takeSnapshot({ preset: 'session' })
   *
   * // Capture only messages and state
   * const partial = agent.takeSnapshot({ include: ['messages', 'state'] })
   *
   * // Capture session state but exclude interrupts
   * const noInterrupts = agent.takeSnapshot({ preset: 'session', exclude: ['interrupts'] })
   *
   * // Attach application-owned metadata
   * const withMeta = agent.takeSnapshot({ preset: 'session', appData: { userId: 'u-123' } })
   * ```
   */
  public takeSnapshot(options: TakeSnapshotOptions): Snapshot {
    return takeSnapshotInternal(this, options)
  }

  /**
   * Restores agent state from a previously captured snapshot.
   *
   * Only fields present in `snapshot.data` are restored; absent fields are left
   * unchanged. This allows partial snapshots to update specific aspects of state
   * without affecting others.
   *
   * @param snapshot - The snapshot to restore from
   * @throws Error if `snapshot.schemaVersion` is incompatible or scope is wrong
   *
   * @example
   * ```typescript
   * // Save and restore a conversation checkpoint
   * const checkpoint = agent.takeSnapshot({ preset: 'session' })
   *
   * // ... agent continues processing ...
   *
   * // Restore to the checkpoint
   * agent.loadSnapshot(checkpoint)
   *
   * // Restore from a JSON-serialized snapshot (e.g. from storage)
   * const stored = JSON.parse(savedSnapshotJson)
   * agent.loadSnapshot(stored)
   * ```
   */
  public loadSnapshot(snapshot: Snapshot): void {
    if (this._initialized) this._backgroundTasks?.assertCanLoadSnapshot()
    loadSnapshotInternal(this, snapshot)
    if (this._initialized && 'state' in snapshot.data) this._backgroundTasks?._loadAppState()
  }

  /**
   * Invokes hook callbacks and printer for a stream event.
   *
   * @param event - The event to process
   * @returns The event after processing
   */
  private async _invokeCallbacks(event: AgentStreamEvent): Promise<AgentStreamEvent> {
    if (event instanceof HookableEvent) {
      await this._hooksRegistry.invokeCallbacks(event)
    }
    this._printer?.processEvent(event)
    return event
  }

  /**
   * Internal implementation of the agent streaming logic.
   * Separated to centralize printer event processing in the public stream method.
   *
   * @param args - Arguments for invoking the agent
   * @param options - Optional per-invocation options
   * @returns Async generator that yields AgentStreamEvent objects and returns AgentResult
   */
  private async *_stream(
    args: InvokeArgs,
    options?: InvokeOptions,
    continuationEvent?: AfterInvocationEvent
  ): AsyncGenerator<AgentStreamEvent, AgentResult, undefined> {
    let currentArgs: InvokeArgs | undefined = args
    let result: AgentResult | undefined

    this._validateLimits(options)

    // Checkpoint resume: consume a { checkpointResume: { checkpoint } } arg.
    // On resume we append no new input and re-derive the cycle position from the
    // checkpoint. `cycleIndex` and `resumePosition` are loop-local, so a stale
    // position never leaks from a prior invocation.
    const resumeCheckpoint = this._extractCheckpointResume(args)
    let cycleIndex = 0
    let resumePosition: CheckpointPosition | undefined
    if (resumeCheckpoint) {
      // afterTools means the cycle finished; the next afterModel checkpoint
      // belongs to the following cycle.
      cycleIndex =
        resumeCheckpoint.position === 'afterTools' ? resumeCheckpoint.cycleIndex + 1 : resumeCheckpoint.cycleIndex
      resumePosition = resumeCheckpoint.position
      currentArgs = undefined
    }

    // Resolve structured output schema from per-invocation options or constructor config
    const structuredOutputSchema = options?.structuredOutputSchema ?? this._structuredOutputSchema
    const structuredOutputTool = structuredOutputSchema ? new StructuredOutputTool(structuredOutputSchema) : undefined
    let structuredOutputChoice: ToolChoice | undefined

    // Resolve per-invocation state once. The same object is threaded through
    // every lifecycle hook event, every tool context, and is surfaced on the
    // AgentResult. Mutations by hooks/tools are visible across all recursive
    // agent loop cycles within this invocation.
    const invocationState: InvocationState = options?.invocationState ?? {}

    // Interrupt responses are already consumed in stream() before middleware
    // runs (so middleware-level interrupt() can find them). Re-extract here
    // to gate the "non-interrupt input while interrupted" check below.
    const interruptResponses = this._extractInterruptResponses(args)

    // Reject non-interrupt input while in interrupted state
    if (this._interruptState.activated && interruptResponses.length === 0) {
      throw new TypeError('Agent is in an interrupted state. Resume by invoking with interruptResponse content blocks.')
    }

    // Normalize input to get the user messages for telemetry
    const inputMessages = this._normalizeInput(args)

    // Start agent trace span
    this._meter.startNewInvocation()
    const agentModelId = this.model.modelId
    const agentSpanOptions: Parameters<Tracer['startAgentSpan']>[0] = {
      messages: inputMessages,
      agentName: this.name,
      agentId: this.id,
      tools: this.tools,
    }
    if (agentModelId) agentSpanOptions.modelId = agentModelId
    if (this.systemPrompt !== undefined) agentSpanOptions.systemPrompt = this.systemPrompt
    const agentSpan = this._tracer.startAgentSpan(agentSpanOptions)

    let caughtError: Error | undefined
    try {
      // Register structured output tool if schema provided
      if (structuredOutputTool) {
        this._toolRegistry.add(structuredOutputTool)
      }

      // Main agent loop - continues until model stops without requesting tools
      while (true) {
        this._throwIfCancelled()

        const limitStopReason = this._checkLimits(options)
        if (limitStopReason) {
          result = new AgentResult({
            stopReason: limitStopReason,
            lastMessage: this.messages.at(-1)!,
            traces: this._tracer.localTraces,
            metrics: this._meter.metrics,
            invocationState,
          })
          return result
        }

        // Start metrics cycle tracking
        const { cycleId, startTime: cycleStartTime } = this._meter.startCycle()

        // Create agent loop cycle span within agent span context
        const cycleSpan = this._tracer.startAgentLoopSpan({
          cycleId,
          messages: this.messages,
        })

        // Closes cycle telemetry exactly once, however the cycle exits: return,
        // continue, throw, or the consumer closing the public iterator (which
        // resumes the generator at the suspended yield and runs the finally).
        // Called before building an AgentResult so its metrics include this cycle.
        let cycleClosed = false
        const closeCycle = (error?: Error): void => {
          if (cycleClosed) {
            return
          }
          cycleClosed = true
          this._meter.endCycle(cycleStartTime)
          if (error) {
            this._tracer.endAgentLoopSpan(cycleSpan, { error })
          } else {
            this._tracer.endAgentLoopSpan(cycleSpan)
          }
        }

        try {
          // Normalize input and append user messages on first invocation only
          if (currentArgs !== undefined) {
            const messagesToAppend = this._normalizeInput(currentArgs)
            if (continuationEvent) {
              yield* await this._appendContinuationMessages(messagesToAppend, continuationEvent, invocationState)
            } else {
              for (const message of messagesToAppend) {
                yield this._appendMessage(message, invocationState)
              }
            }
            currentArgs = undefined
          }

          // Check if we're resuming from a tool interrupt
          const pendingExecution = this._interruptState.getPendingExecution()
          let assistantMessage: Message
          let completedToolResults: Map<string, ToolResultBlock> | undefined

          if (pendingExecution) {
            // Resume from stored state - skip model call.
            assistantMessage = pendingExecution.assistantMessage
            completedToolResults = pendingExecution.completedToolResults
          } else {
            const modelResult = yield* this._invokeModel(invocationState, structuredOutputChoice)

            if (modelResult.stopReason !== 'toolUse') {
              // Schema set, we already forced, and the model still refused.
              // Throw before closing the span so the cycle span records the error.
              if (structuredOutputTool && structuredOutputChoice) {
                throw new StructuredOutputError(
                  'The model failed to invoke the structured output tool even after it was forced.'
                )
              }

              closeCycle()

              // Schema set, model ignored the tool — drop the response and force the tool next cycle.
              // Appending the plain-text turn here would leave the conversation ending on an
              // assistant message, which providers like Bedrock reject as assistant prefill.
              if (structuredOutputTool) {
                structuredOutputChoice = { tool: { name: STRUCTURED_OUTPUT_TOOL_NAME } }
                logger.debug(
                  'structured output schema set but model responded with plain text; forcing tool use on next cycle'
                )
                continue
              }

              // Normal end of turn.
              yield this._appendMessage(modelResult.message, invocationState)
              result = new AgentResult({
                stopReason: modelResult.stopReason,
                lastMessage: modelResult.message,
                traces: this._tracer.localTraces,
                metrics: this._meter.metrics,
                invocationState,
              })
              return result
            }

            // Cancel before tool execution: create error results for all pending tools
            if (this.isCancelled) {
              const toolUseBlocks = modelResult.message.content.filter(
                (block): block is ToolUseBlock => block.type === 'toolUseBlock'
              )
              const cancelBlocks = toolUseBlocks.map(
                (block) =>
                  new ToolResultBlock({
                    toolUseId: block.toolUseId,
                    status: 'error',
                    content: [new TextBlock('Tool execution cancelled')],
                  })
              )
              const toolResultMessage = new Message({ role: 'user', content: cancelBlocks })

              yield this._appendMessage(modelResult.message, invocationState)
              yield this._appendMessage(toolResultMessage, invocationState)

              closeCycle()

              result = new AgentResult({
                stopReason: 'cancelled',
                lastMessage: modelResult.message,
                traces: this._tracer.localTraces,
                metrics: this._meter.metrics,
                invocationState,
              })
              return result
            }

            // afterModel checkpoint: model returned tool use, tools have not run
            // yet. Skipped when resuming from an afterModel checkpoint: the
            // assistant tool-use message was not persisted (deferred append), so
            // this cycle re-invoked the model to regenerate it — now fall through
            // to run the tools. Cancel wins — the isCancelled branch above returns
            // before we reach here.
            if (this._checkpointing) {
              const priorResumePosition = resumePosition
              resumePosition = undefined
              if (priorResumePosition !== 'afterModel') {
                closeCycle()
                result = new AgentResult({
                  stopReason: 'checkpoint',
                  lastMessage: modelResult.message,
                  traces: this._tracer.localTraces,
                  metrics: this._meter.metrics,
                  invocationState,
                  checkpoint: new Checkpoint({ position: 'afterModel', cycleIndex }),
                })
                return result
              }
            }

            assistantMessage = modelResult.message
          }

          // Execute tools
          const toolsResult = yield* this.executeTools(assistantMessage, invocationState, completedToolResults)

          // Reached when the consumer breaks the stream during tool execution.
          // _streamCore's drain loop calls .return(), which runs the finally in
          // executeTools and yields its AfterToolsEvent, and the drain's next()
          // then completes the closed generator, so this yield* evaluates to
          // undefined instead of unwinding.
          if (!toolsResult) {
            continue
          }
          const toolResultMessage = toolsResult.message

          // Tools were skipped (not executed) — preserve pending state so the next resume
          // can run them.
          if (this.isCancelled && toolsResult.toolsSkipped && this._interruptState.pendingToolExecution) {
            continue
          }

          /**
           * Deferred append: both messages are added AFTER tool execution completes.
           * This keeps agent.messages in a valid, reinvokable state at all times.
           * If interrupted during tool execution, messages has no dangling toolUse
           * without a matching toolResult, so the agent can be reinvoked cleanly.
           */
          yield this._appendMessage(assistantMessage, invocationState)
          yield this._appendMessage(toolResultMessage, invocationState)

          // Both messages are in history, so any stored pending execution is now stale.
          this._interruptState.clearPendingToolExecution()

          // Deactivate interrupt state after successful tool execution so the next
          // cycle starts with a clean slate (new interrupts can be raised again).
          if (this._interruptState.activated) {
            this._interruptState.deactivate()
          }

          closeCycle()

          // Hook requested halt with content: exit without calling the model again.
          const { afterToolsEvent } = toolsResult
          const endTurnValue = afterToolsEvent.endTurn
          if (endTurnValue === true || (endTurnValue !== false && endTurnValue.length > 0)) {
            const endTurnContent: ContentBlock[] = Array.isArray(endTurnValue)
              ? [...endTurnValue]
              : [
                  new TextBlock(
                    typeof endTurnValue === 'string' ? endTurnValue : 'Turn ended early by hook after tool execution'
                  ),
                ]
            const lastMessage = new Message({ role: 'assistant', content: endTurnContent })
            yield this._appendMessage(lastMessage, invocationState)

            result = new AgentResult({
              stopReason: 'endTurn',
              lastMessage,
              traces: this._tracer.localTraces,
              metrics: this._meter.metrics,
              invocationState,
            })
            return result
          }

          // Structured output captured: exit
          const structuredOutput = structuredOutputTool
            ? this._extractStructuredOutput(assistantMessage, toolResultMessage)
            : undefined
          if (structuredOutput !== undefined) {
            result = new AgentResult({
              stopReason: 'toolUse',
              lastMessage: assistantMessage,
              traces: this._tracer.localTraces,
              structuredOutput,
              metrics: this._meter.metrics,
              invocationState,
            })
            return result
          }

          // afterTools checkpoint: tools finished, next model call pending. Placed
          // after the endTurn / structured-output returns so it only fires when the
          // loop would continue. Cancel wins: skip when cancelled and let the next
          // iteration's cancellation check return `cancelled`.
          if (this._checkpointing && !this.isCancelled) {
            result = new AgentResult({
              stopReason: 'checkpoint',
              lastMessage: assistantMessage,
              traces: this._tracer.localTraces,
              metrics: this._meter.metrics,
              invocationState,
              checkpoint: new Checkpoint({ position: 'afterTools', cycleIndex }),
            })
            return result
          }
        } catch (error) {
          closeCycle(error as Error)
          throw error
        } finally {
          closeCycle()
        }
      }
    } catch (error) {
      if (error instanceof CancelledError) {
        // Cancelled during model streaming or at the top of a cycle.
        // No partial messages have been appended (deferred append pattern).
        const cancelMessage = new Message({
          role: 'assistant',
          content: [new TextBlock('Cancelled by user')],
        })
        if (this._hasOpenUserTurn()) {
          yield this._appendMessage(cancelMessage, invocationState)
        }

        result = new AgentResult({
          stopReason: 'cancelled',
          lastMessage: cancelMessage,
          traces: this._tracer.localTraces,
          metrics: this._meter.metrics,
          invocationState,
        })
        return result
      }
      if (error instanceof InterruptError) {
        // Handles interrupts from tools/hooks that propagated up through the agent loop.
        // AgentStreamStage middleware interrupts are caught separately in _streamWithMiddleware().
        for (const interrupt of error.interrupts) {
          this._interruptState.registerInterrupt(interrupt)
        }
        // Fan out one event per interrupt. Each event exposes `interrupt.source` so
        // consumers can filter by origin (tool callback vs hook callback) without
        // subscribing to separate event types.
        for (const interrupt of error.interrupts) {
          yield new InterruptEvent({ agent: this, interrupt, invocationState })
        }
        result = this._createInterruptResult(invocationState)
        return result
      }
      caughtError = error as Error
      throw error
    } finally {
      // If cancelled but the catch block was bypassed (generator terminated
      // via .return() when the consumer breaks out of for-await), close an
      // existing user turn so the agent can be reinvoked.
      if (!caughtError && !result && this.isCancelled) {
        const cancelMessage = new Message({
          role: 'assistant',
          content: [new TextBlock('Cancelled by user')],
        })
        if (this._hasOpenUserTurn()) {
          yield this._appendMessage(cancelMessage, invocationState)
        }
      }

      this._tracer.endAgentSpan(agentSpan, {
        ...(caughtError && { error: caughtError }),
        ...(result?.lastMessage && { response: result.lastMessage }),
        accumulatedUsage: this._meter.metrics.accumulatedUsage,
        ...(result?.stopReason && { stopReason: result.stopReason }),
      })

      // Cleanup structured output tool
      if (structuredOutputTool) {
        this._toolRegistry.remove(STRUCTURED_OUTPUT_TOOL_NAME)
      }
    }
  }

  /**
   * Extracts the validated structured output result from tool execution.
   *
   * @param toolUseMessage - The assistant message containing tool use blocks
   * @param toolResultMessage - The message containing tool results
   * @returns The parsed structured output, or undefined if not found
   */
  private _extractStructuredOutput(toolUseMessage: Message, toolResultMessage: Message): unknown | undefined {
    const toolUse = toolUseMessage.content.find(
      (block): block is ToolUseBlock => block.type === 'toolUseBlock' && block.name === STRUCTURED_OUTPUT_TOOL_NAME
    )
    if (!toolUse) return undefined

    const toolResult = toolResultMessage.content.find(
      (block): block is ToolResultBlock =>
        block.type === 'toolResultBlock' && block.toolUseId === toolUse.toolUseId && block.status === 'success'
    )
    if (!toolResult) return undefined

    const firstContent = toolResult.content[0]
    return firstContent?.type === 'jsonBlock' ? firstContent.json : undefined
  }

  /**
   * Creates an AgentResult for an interrupt stop.
   *
   * @param invocationState - The current invocation state
   * @returns AgentResult with stopReason 'interrupt'
   */
  private _createInterruptResult(invocationState: InvocationState): AgentResult {
    this._interruptState.activate()
    return new AgentResult({
      stopReason: 'interrupt',
      lastMessage:
        this.messages.length > 0
          ? this.messages[this.messages.length - 1]!
          : new Message({ role: 'assistant', content: [new TextBlock('Interrupted')] }),
      traces: this._tracer.localTraces,
      metrics: this._meter.metrics,
      interrupts: this._interruptState.getUnansweredInterrupts(),
      invocationState,
    })
  }

  /**
   * Extracts interrupt response content blocks from invocation args.
   *
   * @param args - The invocation arguments
   * @returns Array of InterruptResponseContent blocks, empty if none found
   * @throws TypeError if args mix interrupt responses with other content
   */
  private _extractInterruptResponses(args: InvokeArgs): InterruptResponseContent[] {
    if (!Array.isArray(args) || args.length === 0) {
      return []
    }

    const responses: InterruptResponseContent[] = []
    let hasNonInterrupt = false

    for (const item of args) {
      if (isInterruptResponseContent(item)) {
        responses.push(item)
      } else {
        hasNonInterrupt = true
      }
    }

    if (responses.length > 0 && hasNonInterrupt) {
      throw new TypeError('Must resume from interrupt with a list of interruptResponse content blocks only')
    }

    return responses
  }

  /**
   * Consumes a `{ checkpointResume: { checkpoint } }` invocation argument,
   * returning the reconstructed {@link Checkpoint} or `undefined` when the args
   * are not a checkpoint-resume payload.
   *
   * @throws CheckpointError if a checkpointResume block is passed but the agent
   *   was created with `checkpointing: false`, if the block is missing its
   *   `checkpoint` key, or if the checkpoint schema version is incompatible.
   */
  private _extractCheckpointResume(args: InvokeArgs): Checkpoint | undefined {
    if (typeof args !== 'object' || args === null || Array.isArray(args) || !('checkpointResume' in args)) {
      return undefined
    }

    if (!this._checkpointing) {
      throw new CheckpointError(
        'Received a checkpointResume block but the agent was created with checkpointing: false. ' +
          'Pass checkpointing: true when constructing the Agent.'
      )
    }

    const payload = (args as CheckpointResumeContent).checkpointResume
    if (typeof payload !== 'object' || payload === null || !('checkpoint' in payload)) {
      throw new CheckpointError('The checkpointResume block is missing its required "checkpoint" key.')
    }

    return Checkpoint.fromJSON(payload.checkpoint)
  }

  /**
   * Normalizes agent invocation input into an array of messages to append.
   *
   * @param args - Optional arguments for invoking the model
   * @returns Array of messages to append to the conversation
   */
  private _normalizeInput(args?: InvokeArgs): Message[] {
    if (args !== undefined) {
      if (typeof args === 'string') {
        // String input: wrap in TextBlock and create user Message
        return [
          new Message({
            role: 'user',
            content: [new TextBlock(args)],
          }),
        ]
      } else if (Array.isArray(args) && args.length > 0) {
        const firstElement = args[0]!

        // Check if it's interrupt responses - skip creating messages for these
        if (isInterruptResponseContent(firstElement)) {
          // Pure interrupt responses: no messages to add
          return []
        }

        // Check if it's Message[] or MessageData[]
        if ('role' in firstElement && typeof firstElement.role === 'string') {
          // Check if it's a Message instance or MessageData
          if (firstElement instanceof Message) {
            // Message[] input: return all messages
            return args as Message[]
          } else {
            // MessageData[] input: convert to Message[]
            return (args as MessageData[]).map((data) => Message.fromMessageData(data))
          }
        } else {
          // It's ContentBlock[] or ContentBlockData[]
          // Check if it's ContentBlock instances or ContentBlockData
          let contentBlocks: ContentBlock[]
          if ('type' in firstElement && typeof firstElement.type === 'string') {
            // ContentBlock[] input: use as-is
            contentBlocks = args as ContentBlock[]
          } else {
            // ContentBlockData[] input: convert using helper function
            contentBlocks = (args as ContentBlockData[]).map(contentBlockFromData)
          }

          return [
            new Message({
              role: 'user',
              content: contentBlocks,
            }),
          ]
        }
      }
    }
    // undefined or empty array: no messages to append
    return []
  }

  /**
   * Invokes the model provider and streams all events.
   *
   * @param args - Optional arguments for invoking the model
   * @param toolChoice - Optional tool choice to force specific tool usage
   * @returns Object containing the assistant message, stop reason, and optional redaction message
   */
  private async *_invokeModel(
    invocationState: InvocationState,
    toolChoice?: ToolChoice
  ): AsyncGenerator<AgentStreamEvent, StreamAggregatedResult, undefined> {
    const toolSpecs = this._toolRegistry.list().map((tool) => tool.toolSpec)
    const streamOptions: StreamOptions = { toolSpecs, modelState: this.modelState }
    if (this.systemPrompt !== undefined) {
      streamOptions.systemPrompt = this.systemPrompt
    }
    if (toolChoice) {
      streamOptions.toolChoice = toolChoice
    }

    let attemptCount = 1
    while (true) {
      const selectedModel = this._modelForAttempt(invocationState)
      let projectedInputTokens: number | undefined
      try {
        // Context management continues to size against the agent's default model.
        projectedInputTokens = await this._estimateInputTokens(streamOptions)
      } catch (error) {
        logger.debug(`error=<${error}> | token estimation failed, proceeding without estimate`)
      }

      const beforeModelCallEvent = new BeforeModelCallEvent({
        agent: this,
        model: selectedModel,
        invocationState,
        ...(projectedInputTokens !== undefined && { projectedInputTokens }),
      })
      let modelContinuation: readonly Message[] | undefined
      try {
        yield beforeModelCallEvent
        modelContinuation = await continuations.prepare(beforeModelCallEvent, (continuationArgs) =>
          this._normalizeInput(continuationArgs)
        )
      } finally {
        if (modelContinuation === undefined) {
          await continuations.abandon(
            beforeModelCallEvent,
            new Error('Agent stream closed before continuation input was incorporated into agent history')
          )
        }
      }

      if (beforeModelCallEvent.cancel) {
        await continuations.abandon(beforeModelCallEvent, new Error('Continuation abandoned by BeforeModelCallEvent'))
        const cancelText =
          typeof beforeModelCallEvent.cancel === 'string' ? beforeModelCallEvent.cancel : 'model call denied by hook'
        const message = new Message({ role: 'assistant', content: [new TextBlock(cancelText)] })
        const stopData: ModelStopData = { message, stopReason: 'endTurn' }
        const afterModelCallEvent = new AfterModelCallEvent({
          agent: this,
          model: selectedModel,
          attemptCount,
          stopData,
          invocationState,
        })
        yield afterModelCallEvent

        if (afterModelCallEvent.retry) {
          attemptCount = this._nextAttemptCount(selectedModel, invocationState, attemptCount)
          continue
        }

        return { message, stopReason: 'endTurn' }
      }

      yield* await this._appendContinuationMessages(modelContinuation ?? [], beforeModelCallEvent, invocationState)

      if (modelContinuation !== undefined) {
        try {
          projectedInputTokens = await this._estimateInputTokens(streamOptions)
        } catch (error) {
          projectedInputTokens = undefined
          logger.debug(
            `error=<${error}> | token estimation failed after continuation input, proceeding without estimate`
          )
        }
      }

      const invokedModelRef: InvokedModelRef = {}
      try {
        const result = yield* this._invokeModelWithMiddleware(
          invocationState,
          selectedModel,
          invokedModelRef,
          toolChoice,
          projectedInputTokens
        )
        const routedModel = this._modelRouter?.getRoutedModel(this, invocationState) ?? selectedModel
        const model = invokedModelRef.model ?? selectedModel

        this._meter.updateCycle(result.metadata)

        yield new ModelMessageEvent({
          agent: this,
          message: result.message,
          stopReason: result.stopReason,
          invocationState,
        })

        if (result.redaction?.userMessage) {
          this._redactLastMessage(result.redaction.userMessage)
        }

        const stopData: ModelStopData = {
          message: result.message,
          stopReason: result.stopReason,
          ...(result.redaction && { redaction: result.redaction }),
        }

        const afterModelCallEvent = new AfterModelCallEvent({
          agent: this,
          model,
          attemptCount,
          stopData,
          invocationState,
        })
        yield afterModelCallEvent

        if (afterModelCallEvent.retry) {
          attemptCount = this._nextAttemptCount(routedModel, invocationState, attemptCount)
          continue
        }

        return result
      } catch (error) {
        const routedModel = this._modelRouter?.getRoutedModel(this, invocationState) ?? selectedModel
        // A failure before the terminal ran (e.g. in input middleware) is attributed to the routed model.
        const failedModel = invokedModelRef.model ?? routedModel
        const modelError = normalizeError(error)
        const errorEvent = new AfterModelCallEvent({
          agent: this,
          model: failedModel,
          attemptCount,
          error: modelError,
          invocationState,
        })
        yield errorEvent

        // Preserve the Before/After event pair, but never retry cancellation.
        if (error instanceof CancelledError) {
          throw error
        }

        if (errorEvent.retry) {
          attemptCount = this._nextAttemptCount(routedModel, invocationState, attemptCount)
          continue
        }

        throw error
      }
    }
  }

  private _modelForAttempt(invocationState: InvocationState): Model {
    return this._modelRouter?.getRoutedModel(this, invocationState) ?? this.model
  }

  private _nextAttemptCount(model: Model, invocationState: InvocationState, attemptCount: number): number {
    const nextModel = this._modelRouter?.getRoutedModel(this, invocationState)
    return nextModel !== undefined && nextModel !== model ? 1 : attemptCount + 1
  }

  /**
   * Invokes the model through the InvokeModelStage middleware chain.
   * Builds an InvokeModelContext from current agent state and composes the
   * middleware chain with a terminal function that calls _streamFromModel
   * using context fields directly (not re-derived from the agent).
   *
   * @param invocationState - Per-invocation state shared across hooks and tools
   * @param selectedModel - Model the chain starts with; middleware may replace it
   * @param invokedModelRef - Slot filled with the model the terminal actually invoked
   * @param toolChoice - Optional tool choice to force specific tool usage
   * @returns StreamAggregatedResult from the model (or middleware short-circuit)
   */
  private async *_invokeModelWithMiddleware(
    invocationState: InvocationState,
    selectedModel: Model,
    invokedModelRef: InvokedModelRef,
    toolChoice?: ToolChoice,
    projectedInputTokens?: number
  ): AsyncGenerator<AgentStreamEvent, StreamAggregatedResult, undefined> {
    const context: InvokeModelContext = {
      agent: this,
      model: selectedModel,
      messages: this.messages.map((msg) => msg.clone()),
      ...(this.systemPrompt !== undefined && { systemPrompt: cloneSystemPrompt(this.systemPrompt) }),
      toolSpecs: deepCopy(this._toolRegistry.list().map((tool) => tool.toolSpec)) as unknown as ToolSpec[],
      ...(toolChoice !== undefined && { toolChoice: deepCopy(toolChoice) as unknown as ToolChoice }),
      invocationState,
      ...(projectedInputTokens !== undefined && { projectedInputTokens }),
    }

    // Snapshot model state before middleware runs so concurrent mutations don't leak in.
    // The writeback happens after the entire middleware chain completes, so middleware
    // cannot affect modelState at any point (before or after next()).
    const modelStateSnapshot = this.modelState.getAll()
    let tempModelState: StateStore | undefined

    // async function* doesn't bind lexical `this`; capture for the terminal callback.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    const middlewareResult = yield* this._middlewareRegistry.invoke(
      InvokeModelStage,
      context,
      async function* (ctx: InvokeModelContext): AsyncGenerator<AgentStreamEvent, InvokeModelResult, undefined> {
        invokedModelRef.model = ctx.model
        const modelId = ctx.model.modelId
        const modelSpan = self._tracer.startModelInvokeSpan({
          messages: ctx.messages as Message[],
          ...(modelId && { modelId }),
          ...(ctx.systemPrompt !== undefined && { systemPrompt: ctx.systemPrompt }),
        })

        let modelSpanEnded = false
        try {
          // Wrap the snapshot into a StateStore for the model provider, which expects
          // get/set methods.
          tempModelState = new StateStore(modelStateSnapshot)
          const streamOptions: StreamOptions = {
            cancelSignal: self._abortSignal,
            toolSpecs: ctx.toolSpecs as ToolSpec[],
            modelState: tempModelState,
            ...(ctx.systemPrompt !== undefined && { systemPrompt: ctx.systemPrompt }),
            ...(ctx.toolChoice && { toolChoice: ctx.toolChoice }),
            // Omitted when zero, so an ordinary call's options are unchanged.
            ...(ctx.dynamicTrailingBlocks ? { dynamicTrailingBlocks: ctx.dynamicTrailingBlocks } : {}),
          }
          const gen = self._streamFromModel(ctx.model, ctx.messages as Message[], streamOptions, ctx.invocationState)
          let iterResult = await gen.next()
          while (!iterResult.done) {
            yield iterResult.value
            iterResult = await gen.next()
          }

          const usage = iterResult.value.metadata?.usage
          const metrics = iterResult.value.metadata?.metrics
          self._tracer.endModelInvokeSpan(modelSpan, {
            output: iterResult.value.message,
            stopReason: iterResult.value.stopReason,
            ...(usage && { usage }),
            ...(metrics && { metrics }),
          })
          modelSpanEnded = true

          return { result: iterResult.value }
        } catch (error) {
          self._tracer.endModelInvokeSpan(modelSpan, { error: normalizeError(error) })
          modelSpanEnded = true
          throw error
        } finally {
          // A consumer break closes this generator via .return(): finally runs but catch does not,
          // so neither end call above fires and the span would stay open.
          if (!modelSpanEnded) {
            self._tracer.endModelInvokeSpan(modelSpan)
          }
        }
      }
    )

    // Sync model state after the entire middleware chain has completed, so no
    // middleware mutation to agent.modelState (before or after next()) takes effect.
    // Intentionally skipped on error — partial provider writes should not persist.
    if (tempModelState) {
      loadStateSerializable(this.modelState, serializeStateSerializable(tempModelState))
    }

    return middlewareResult.result
  }

  /**
   * Streams events from the model and dispatches appropriate events for each.
   *
   * The model's `streamAggregated()` yields two kinds of output:
   * - **ModelStreamEvent**: Transient streaming deltas (partial data while generating).
   *   Wrapped in {@link ModelStreamUpdateEvent} before yielding.
   * - **ContentBlock**: Fully assembled results (after all deltas accumulate).
   *   Wrapped in {@link ContentBlockEvent} before yielding.
   *
   * These are separate event classes because they represent different granularities
   * (partial deltas vs finished blocks). Both are yielded in the stream and hookable.
   *
   * @param model - Model selected for this call
   * @param messages - Messages to send to the model
   * @param streamOptions - Options for streaming
   * @returns StreamAggregatedResult containing message, stop reason, and optional redaction message
   */
  private async *_streamFromModel(
    model: Model,
    messages: Message[],
    streamOptions: StreamOptions,
    invocationState: InvocationState
  ): AsyncGenerator<AgentStreamEvent, StreamAggregatedResult, undefined> {
    messages = normalizeToolUseNames(messages)
    const streamGenerator = model.streamAggregated(messages, streamOptions)
    try {
      let result = await streamGenerator.next()

      while (!result.done) {
        this._throwIfCancelled()

        const event = result.value

        if (isModelStreamEvent(event)) {
          // ModelStreamEvent: wrap in ModelStreamUpdateEvent
          yield new ModelStreamUpdateEvent({ agent: this, event, invocationState })
        } else {
          // ContentBlock: wrap in ContentBlockEvent
          yield new ContentBlockEvent({ agent: this, contentBlock: event, invocationState })
        }
        result = await streamGenerator.next()
      }

      // result.done is true, result.value contains the return value
      return result.value
    } catch (error) {
      // Provider transports typically surface cancellation as AbortError.
      // Preserve the Agent cancellation contract when the shared signal fired.
      this._throwIfCancelled()
      throw error
    }
  }

  /**
   * Emits `BeforeToolsEvent`, handles the pre-launch cancel paths, then
   * delegates per-tool execution to the configured executor.
   * Always pairs `BeforeToolsEvent` with a terminal `AfterToolsEvent`, even on
   * the invariant-violation throw path.
   *
   * @param assistantMessage - The assistant message containing tool use blocks
   * @returns Tool-result message and the dispatched AfterToolsEvent
   */
  private async *executeTools(
    assistantMessage: Message,
    invocationState: InvocationState,
    completedToolResults?: Map<string, ToolResultBlock>
  ): AsyncGenerator<AgentStreamEvent, ToolsExecutionResult, undefined> {
    const beforeToolsEvent = new BeforeToolsEvent({ agent: this, message: assistantMessage, invocationState })
    try {
      yield beforeToolsEvent
    } catch (error) {
      // Store pending state before re-throwing so the agent can resume from this point.
      // The error must still propagate to _stream which handles the interrupt stop.
      if (error instanceof InterruptError) {
        this._interruptState.setPendingToolExecution({
          assistantMessageData: assistantMessage.toJSON(),
          completedToolResults: {},
        })
      }
      throw error
    }

    const toolUseBlocks = assistantMessage.content.filter(
      (block): block is ToolUseBlock => block.type === 'toolUseBlock'
    )
    const toolResultBlocks: ToolResultBlock[] = []
    let toolResultMessage: Message
    let afterToolsEvent: AfterToolsEvent
    let toolsSkipped = false

    try {
      if (toolUseBlocks.length === 0) {
        throw new Error('Model indicated toolUse but no tool use blocks found in message')
      }

      // Pre-launch cancellation is executor-independent.
      const cancelMessage = beforeToolsEvent.cancel
        ? typeof beforeToolsEvent.cancel === 'string'
          ? beforeToolsEvent.cancel
          : 'Tool cancelled by hook'
        : this.isCancelled
          ? 'Tool execution cancelled'
          : undefined

      if (cancelMessage) {
        toolsSkipped = true
        toolResultBlocks.push(...this._cancelAllAsResults(toolUseBlocks, cancelMessage))
        for (const result of toolResultBlocks) {
          yield new ToolResultEvent({ agent: this, result, invocationState })
        }
      } else {
        yield* this._toolExecutor.execute(
          {
            agent: this,
            middlewareRegistry: this._middlewareRegistry,
            tracer: this._tracer,
            meter: this._meter,
            cancelSignal: this._abortSignal,
            ...(this._backgroundTasks && {
              backgroundTasks: this._backgroundTasks,
              backgroundTaskPassId: assistantMessage.trackingId,
            }),
          },
          {
            toolUseBlocks,
            toolResultBlocks,
            invocationState,
            assistantMessage,
            ...(completedToolResults && { completedToolResults }),
          }
        )
      }
    } finally {
      toolResultMessage = new Message({ role: 'user', content: toolResultBlocks })
      afterToolsEvent = new AfterToolsEvent({ agent: this, message: toolResultMessage, invocationState })
      yield afterToolsEvent
    }

    return { message: toolResultMessage, afterToolsEvent, toolsSkipped }
  }

  /**
   * Produces one error ToolResultBlock per tool use block, each carrying
   * `message` as its error text. Shared by pre-launch cancel paths.
   */
  private _cancelAllAsResults(toolUseBlocks: ToolUseBlock[], message: string): ToolResultBlock[] {
    return toolUseBlocks.map(
      (block) =>
        new ToolResultBlock({
          toolUseId: block.toolUseId,
          status: 'error',
          content: [new TextBlock(message)],
        })
    )
  }

  /**
   * Redacts the last message in the conversation history.
   * Called when guardrails block user input and redaction is enabled.
   *
   * Follows the redaction strategy:
   * - If the message contains at least one toolResult block, all toolResult blocks
   *   are kept with redacted content, and all other blocks are discarded.
   * - Otherwise, the entire content is replaced with a single text block containing
   *   the redaction message.
   *
   * @param redactMessage - The redaction message to replace the content with
   */
  private _redactLastMessage(redactMessage: string): void {
    // Find and redact the last message
    const lastIndex = this.messages.length - 1
    if (lastIndex >= 0) {
      const lastMessage = this.messages[lastIndex]
      if (lastMessage && lastMessage.role === 'user') {
        // Collect only tool result blocks with redacted content
        const redactedContent: ContentBlock[] = []
        for (const block of lastMessage.content) {
          if (block.type === 'toolResultBlock') {
            // Preserve tool result block structure, only redact its content
            redactedContent.push(
              new ToolResultBlock({
                toolUseId: block.toolUseId,
                status: block.status,
                content: [new TextBlock(redactMessage)],
              })
            )
          }
        }

        // If no tool result blocks were found, replace entire content with redaction message
        if (redactedContent.length === 0) {
          redactedContent.push(new TextBlock(redactMessage))
        }

        this.messages[lastIndex] = new Message({
          role: 'user',
          content: redactedContent,
          // Redaction rewrites content but it's the same logical message, so keep its tracking id.
          trackingId: lastMessage.trackingId,
        })
      } else if (lastMessage) {
        // Unexpected state: redaction requested but last message is not from user
        logger.warn(
          `role=<${lastMessage.role}> | received input redaction but last message is not from user | redaction skipped`
        )
      }
    }
  }

  /**
   * Estimate the input token count for the next model call.
   *
   * Uses the token counting strategy: reads the total prompt the model processed (including cached
   * tokens) plus outputTokens from the last assistant message's metadata as a known baseline, then
   * estimates only new messages added after it. Falls back to full estimation when no metadata is
   * available (cold start or first call).
   *
   * @param streamOptions - The stream options containing system prompt and tool specs
   * @returns Estimated input token count
   */
  private async _estimateInputTokens(streamOptions: StreamOptions): Promise<number> {
    // Find the last assistant message with usage metadata
    let lastAssistantIdx = -1
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!.role === 'assistant' && this.messages[i]!.metadata?.usage) {
        lastAssistantIdx = i
        break
      }
    }

    let estimate: number
    if (lastAssistantIdx >= 0) {
      const usage = this.messages[lastAssistantIdx]!.metadata!.usage!
      const knownBaseline = totalPromptTokens(usage) + usage.outputTokens
      const newMessages = this.messages.slice(lastAssistantIdx + 1)
      if (newMessages.length === 0) {
        estimate = knownBaseline
      } else {
        // System prompt and tool spec tokens are already included in the baseline from the prior model call
        estimate = knownBaseline + (await this.model.countTokens(newMessages))
      }
    } else {
      estimate = await this.model.countTokens(this.messages, {
        ...(streamOptions.systemPrompt !== undefined && { systemPrompt: streamOptions.systemPrompt }),
        ...(streamOptions.toolSpecs !== undefined && { toolSpecs: streamOptions.toolSpecs }),
      })
    }

    return estimate
  }

  /**
   * Appends a message to the conversation history and fires MessageAddedEvent hooks.
   *
   * Used by {@link ToolCaller} (via the helper passed to `ToolCaller.create`) for
   * direct tool calls that cannot yield events into the agent stream. This stays
   * private — callers outside the agent should never directly mutate messages.
   */
  private async _appendMessageAndFireHooks(message: Message, invocationState: InvocationState = {}): Promise<void> {
    this.messages.push(message)
    await this._hooksRegistry.invokeCallbacks(new MessageAddedEvent({ agent: this, message, invocationState }))
  }

  /**
   * Appends a message to the conversation history and returns the event for yielding.
   *
   * @param message - The message to append
   * @returns MessageAddedEvent to be yielded
   */
  private _appendMessage(message: Message, invocationState: InvocationState): MessageAddedEvent {
    this.messages.push(message)
    return new MessageAddedEvent({ agent: this, message, invocationState })
  }

  private async _appendContinuationMessages(
    messages: readonly Message[],
    continuationEvent: AfterInvocationEvent | BeforeModelCallEvent,
    invocationState: InvocationState
  ): Promise<MessageAddedEvent[]> {
    const events: MessageAddedEvent[] = []
    for (const message of messages) {
      const lastMessage = this.messages.at(-1)
      if (lastMessage?.role !== message.role) {
        events.push(this._appendMessage(message, invocationState))
        continue
      }

      const appendedMessage = new Message({
        role: message.role,
        content: [...lastMessage.content, ...message.content],
        trackingId: lastMessage.trackingId,
        ...(lastMessage.metadata !== undefined && { metadata: lastMessage.metadata }),
      })
      this.messages[this.messages.length - 1] = appendedMessage

      const messageEvent = new MessageAddedEvent({ agent: this, message: appendedMessage, invocationState })
      if (events.at(-1)?.message === lastMessage) {
        events[events.length - 1] = messageEvent
      } else {
        events.push(messageEvent)
      }
    }
    await continuations.markAppended(continuationEvent)
    return events
  }

  private _hasOpenUserTurn(): boolean {
    const lastMessage = this.messages[this.messages.length - 1]
    return lastMessage?.role === 'user'
  }
}

const INVALID_TOOL_NAME_PLACEHOLDER = 'INVALID_TOOL_NAME'

/**
 * Replaces invalid tool-use names on assistant messages with `INVALID_TOOL_NAME`
 * so providers that reject malformed names don't fail the whole request.
 * Returns the input unchanged (same reference) when nothing needs replacing.
 */
function normalizeToolUseNames(messages: Message[]): Message[] {
  let replaced = false
  const next = messages.map((message) => {
    if (!message || message.role !== 'assistant') return message

    let messageReplaced = false
    const content = message.content.map((block) => {
      if (block.type !== 'toolUseBlock') return block
      if (isValidToolName(block.name)) return block
      messageReplaced = true
      logger.debug(`tool_name=<${block.name}> | replacing invalid tool name with ${INVALID_TOOL_NAME_PLACEHOLDER}`)
      return new ToolUseBlock({
        name: INVALID_TOOL_NAME_PLACEHOLDER,
        toolUseId: block.toolUseId,
        input: block.input,
        ...(block.reasoningSignature !== undefined && { reasoningSignature: block.reasoningSignature }),
      })
    })

    if (!messageReplaced) return message
    replaced = true
    return new Message({
      role: message.role,
      content,
      ...(message.metadata !== undefined && { metadata: message.metadata }),
    })
  })

  return replaced ? next : messages
}

/**
 * Recursively flattens nested arrays of tools into a single flat array.
 * @param tools - Tools or nested arrays of tools
 * @returns Flat array of tools and MCP clients
 */
function flattenTools(toolList: ToolList): { tools: Tool[]; mcpClients: McpClient[] } {
  const tools: Tool[] = []
  const mcpClients: McpClient[] = []

  for (const item of toolList) {
    if (Array.isArray(item)) {
      const { tools: nestedTools, mcpClients: nestedMcpClients } = flattenTools(item)
      tools.push(...nestedTools)
      mcpClients.push(...nestedMcpClients)
    } else if (item instanceof Agent) {
      tools.push(item.asTool())
    } else if (item instanceof McpClient) {
      mcpClients.push(item)
    } else {
      tools.push(item)
    }
  }

  return { tools, mcpClients }
}
