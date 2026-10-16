/**
 * Bidirectional agent for real-time streaming conversations.
 *
 * Provides real-time audio and text interaction through persistent streaming connections.
 * Unlike the request/response agent loop, this agent keeps a long-running conversation open
 * where users can barge in, provide additional input, and receive continuous responses
 * including audio output.
 */

import { Agent } from '../../agent/agent.js'
import type { ToolList } from '../../agent/agent.js'
import {
  loadSnapshot as loadSnapshotInternal,
  takeSnapshot as takeSnapshotInternal,
  type SnapshotField,
  type SnapshotPreset,
  type TakeSnapshotOptions,
} from '../../agent/snapshot.js'
import { ToolCaller } from '../../agent/tool-caller.js'
import type { ToolCallerProxy } from '../../agent/tool-caller.js'
import { InitializedEvent, MessageAddedEvent } from '../../hooks/events.js'
import type { HookableEvent } from '../../hooks/events.js'
import type { HookCallback, HookableEventConstructor, HookCallbackOptions, HookCleanup } from '../../hooks/types.js'
import { HookRegistryImplementation } from '../../hooks/registry.js'
import { logger } from '../../logging/logger.js'
import { McpClient } from '../../mcp/client.js'
import { InterruptState } from '../../interrupt.js'
import { MiddlewareRegistry } from '../../middleware/index.js'
import type {
  MiddlewareHandler,
  MiddlewareInputHandler,
  MiddlewareInputPhase,
  MiddlewareOutputHandler,
  MiddlewareOutputPhase,
  MiddlewarePhaseKind,
  MiddlewareStage,
  MiddlewareWrapPhase,
} from '../../middleware/types.js'
import { BedrockModel } from '../../models/bedrock.js'
import type { BaseModelConfig, Model } from '../../models/model.js'
import type { Plugin } from '../../plugins/plugin.js'
import { PluginRegistry } from '../../plugins/registry.js'
import { ToolRegistry } from '../../registry/tool-registry.js'
import { defaultSandbox } from '../../sandbox/default.js'
import type { Sandbox } from '../../sandbox/base.js'
import type { SessionManager } from '../../session/session-manager.js'
import { StateStore } from '../../state-store.js'
import type { Storage } from '../../storage/storage.js'
import type { AgentMetrics } from '../../telemetry/meter.js'
import { Meter } from '../../telemetry/meter.js'
import { Tracer } from '../../telemetry/tracer.js'
import { ConcurrentToolExecutor } from '../../tools/executors/concurrent.js'
import { ToolExecutor } from '../../tools/executors/executor.js'
import type { Tool } from '../../tools/tool.js'
import type { InvocationState, LocalAgent, localAgentSymbol } from '../../types/agent.js'
import type { JSONValue } from '../../types/json.js'
import { ImageBlock } from '../../types/media.js'
import type { ImageBlockData } from '../../types/media.js'
import type { ContextManager } from '../../context-manager/context-manager.js'
import type { MessageData, SystemPrompt, SystemPromptData } from '../../types/messages.js'
import { Message, TextBlock, systemPromptFromData } from '../../types/messages.js'
import type { Snapshot } from '../../types/snapshot.js'
import { TaskGroup } from '../async/task-group.js'
import { stopAll } from '../async/stop-all.js'
import { BedrockNovaSonicModel } from '../models/bedrock.js'
import { BidiModel } from '../models/model.js'
import type { BidiAgentInput } from '../types/agent.js'
import type { BidiMessage } from '../types/content.js'
import type { BidiOutputEvent } from '../types/events.js'
import type { BidiInputStream, BidiOutputStream, BidiRunInput, BidiRunOutput } from '../types/io.js'
import { AudioDelta } from '../types/media.js'
import type { AudioDeltaData } from '../types/media.js'
import { AgentLoop } from './loop.js'

const DEFAULT_AGENT_ID = 'default'
const DEFAULT_AGENT_NAME = 'Strands Agents'
/** Snapshot fields a bidirectional agent can capture. */
const BIDI_SNAPSHOT_FIELDS: readonly SnapshotField[] = ['messages', 'state', 'systemPrompt']

/** Snapshot presets a bidirectional agent supports. */
const BIDI_SNAPSHOT_PRESETS: Record<SnapshotPreset, readonly SnapshotField[]> = {
  session: ['messages', 'state'],
}

/** Sentinel resolved by {@link whenAborted} so a pending read can be abandoned. */
const ABORTED = Symbol('aborted')

/** One aborted-promise per signal; a loop awaits repeatedly and must not stack `abort` listeners. */
const abortedPromises = new WeakMap<AbortSignal, Promise<typeof ABORTED>>()

/**
 * Resolve once a signal aborts.
 *
 * @param signal - Signal to watch
 * @returns Promise resolving to the {@link ABORTED} sentinel
 */

/** Adapt a `run()` input to the stream protocol; an exhausted iterable parks like an idle device. */
function toInputStream(input: BidiRunInput): BidiInputStream {
  if (!(Symbol.asyncIterator in input)) return input
  const iterator = input[Symbol.asyncIterator]()
  let exhausted: Promise<never> | undefined
  return {
    async read(): Promise<BidiAgentInput> {
      if (exhausted !== undefined) return exhausted
      const next = await iterator.next()
      if (next.done === true) {
        exhausted = new Promise<never>(() => {})
        return exhausted
      }
      return next.value
    },
    async stop(): Promise<void> {
      await iterator.return?.()
    },
  }
}

/** Adapt a `run()` output to the stream protocol. */
function toOutputStream(output: BidiRunOutput): BidiOutputStream {
  if (typeof output !== 'function') return output
  return {
    async write(event: BidiOutputEvent): Promise<void> {
      await output(event)
    },
  }
}

function whenAborted(signal: AbortSignal): Promise<typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED)

  let aborted = abortedPromises.get(signal)
  if (aborted === undefined) {
    aborted = new Promise<typeof ABORTED>((resolve) => {
      signal.addEventListener('abort', () => resolve(ABORTED), { once: true })
    })
    abortedPromises.set(signal, aborted)
  }
  return aborted
}

/**
 * Flatten a tool list into plain tools and MCP clients.
 *
 * @param toolList - Tools, nested tool lists, agents, or MCP clients
 * @returns The flattened tools and the MCP clients to connect on start
 */
function flattenTools(toolList: ToolList): { tools: Tool[]; mcpClients: McpClient[] } {
  const tools: Tool[] = []
  const mcpClients: McpClient[] = []

  for (const item of toolList) {
    if (Array.isArray(item)) {
      const nested = flattenTools(item)
      tools.push(...nested.tools)
      mcpClients.push(...nested.mcpClients)
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

/**
 * Configuration for a {@link BidiAgent}.
 */
export interface BidiAgentConfig {
  /**
   * The bidirectional model instance the agent will use.
   * Accepts a BidiModel or a string representing a Bedrock Nova Sonic model ID
   * (creates `BedrockNovaSonicModel`). Defaults to Nova Sonic 2.5.
   *
   * @example
   * ```typescript
   * // Using a string model ID (creates BedrockNovaSonicModel)
   * const agent = new BidiAgent({
   *   model: 'amazon.nova-2-5-sonic'
   * })
   *
   * // Using an explicit BedrockNovaSonicModel instance with configuration
   * const agent = new BidiAgent({
   *   model: new BedrockNovaSonicModel({
   *     modelId: 'amazon.nova-2-5-sonic',
   *     region: 'us-east-1'
   *   })
   * })
   * ```
   */
  model?: BidiModel | string

  /** Tools made available to the model. */
  tools?: ToolList

  /**
   * System prompt for conversations as a string or structured content blocks.
   * Structured blocks are retained, while their text is passed to bidirectional models
   * as a string.
   */
  systemPrompt?: SystemPrompt | SystemPromptData

  /** Conversation history to initialize with. */
  messages?: (Message | MessageData)[]

  /** Unique identifier of the agent instance. Defaults to `"default"`. */
  id?: string

  /** Name of the agent. Defaults to `"Strands Agents"`. */
  name?: string

  /** Description of what the agent does. */
  description?: string

  /** Plugins to register with the agent. */
  plugins?: Plugin[]

  /** Initial app state accessible to tools and application logic. */
  appState?: Record<string, JSONValue>

  /** Initial runtime state for the model provider. */
  modelState?: Record<string, JSONValue>

  /**
   * Manager for agent sessions including conversation history and state.
   * When provided, enables session-based persistence and state management.
   */
  sessionManager?: SessionManager

  /**
   * Default storage backend for agent subsystems. Subsystems that do not have their own
   * explicit storage resolve from this value.
   */
  storage?: Storage

  /**
   * Execution environment for running commands, code, and file operations.
   * When provided, sandbox-aware tools route operations through it.
   *
   * - Omitted: use the environment's default sandbox (host execution in Node; none in browsers).
   * - `false`: explicitly opt out of a managed sandbox.
   */
  sandbox?: Sandbox | false

  /**
   * Model for auxiliary side calls. Defaults to a {@link BedrockModel} — bidirectional models
   * cannot serve auxiliary calls, so unlike `AgentConfig.auxModel` this does not default to
   * `model`. Accepts a Model or a string representing a Bedrock model ID.
   */
  auxModel?: Model<BaseModelConfig> | string
}

/**
 * Options for {@link BidiAgent.start}.
 */
export interface BidiStartOptions {
  /**
   * Context shared by reference with tools and hooks until stop(), including across connection
   * restarts. Defaults to a new empty object.
   */
  invocationState?: InvocationState

  /**
   * External cancellation signal composed with the agent's own. Aborting it is equivalent to
   * calling {@link BidiAgent.cancel}.
   */
  cancelSignal?: AbortSignal
}

/**
 * Agent for bidirectional streaming conversations.
 *
 * Enables real-time audio and text interaction with AI models through persistent
 * connections. Supports concurrent tool execution and barge-in handling.
 *
 * @example
 * ```typescript
 * const agent = new BidiAgent({ model, tools: [calculator] })
 *
 * await agent.start()
 * await agent.send('Hello')
 * for await (const event of agent.receive()) {
 *   console.log(event)
 * }
 * await agent.stop()
 * ```
 */
export class BidiAgent implements LocalAgent {
  /** @internal */
  declare readonly [localAgentSymbol]: true

  /** The conversation history of messages between user and assistant. */
  public messages: Message[]

  /**
   * The system prompt as a string or structured content blocks. Structured blocks are
   * retained; bidirectional models receive their text as a string.
   */
  public systemPrompt?: SystemPrompt

  /** App state storage accessible to tools and application logic. */
  public readonly appState: StateStore

  /** Runtime state for the model provider. */
  public readonly modelState: StateStore

  /** The bidirectional model used by the agent. */
  public readonly model: BidiModel

  /** The unique identifier of the agent instance. */
  public readonly id: string

  /** The name of the agent. */
  public readonly name: string

  /** Optional description of what the agent does. */
  public readonly description?: string

  /** The session manager for saving and restoring agent sessions, if configured. */
  public readonly sessionManager?: SessionManager | undefined

  /** Default storage backend for agent subsystems. */
  public readonly storage?: Storage | undefined

  private readonly _sandbox: Sandbox | false | undefined
  private readonly _toolRegistry: ToolRegistry
  private readonly _mcpClients: McpClient[]
  private readonly _hooksRegistry: HookRegistryImplementation
  private readonly _pluginRegistry: PluginRegistry

  /**
   * Middleware registry supplied to the shared tool executor.
   *
   * @internal
   */
  readonly _middlewareRegistry: MiddlewareRegistry

  /**
   * Meter recording tool-call metrics.
   *
   * @internal
   */
  readonly _meter: Meter

  /**
   * Tracer recording tool-call spans.
   *
   * @internal
   */
  readonly _tracer: Tracer

  /**
   * Interrupt state read by the shared tool executor. Bidirectional agents never resume from
   * an interrupt; the loop rejects any interrupt a tool raises.
   *
   * @internal
   */
  readonly _interruptState: InterruptState = new InterruptState()

  /**
   * Executor running the tool calls of one model turn concurrently.
   *
   * @internal
   */
  readonly _toolExecutor: ToolExecutor = new ConcurrentToolExecutor()
  private readonly _toolCaller: ToolCallerProxy
  private readonly _loop: AgentLoop
  private readonly _initialized: Promise<void>
  private _auxModel: Model | undefined
  private _sessionId?: string
  private _abortController = new AbortController()
  private _cancelSignal: AbortSignal = this._abortController.signal
  private _started = false
  /** Serializes history mutations so paired messages stay adjacent. */
  private _messageLock: Promise<void> = Promise.resolve()

  /**
   * Creates an instance of the bidirectional agent.
   *
   * @param config - The configuration for the agent.
   * @throws {@link Error} If the model is not a BidiModel, string, or undefined.
   */
  constructor(config?: BidiAgentConfig) {
    const configuredModel = config?.model
    if (configuredModel instanceof BidiModel) {
      this.model = configuredModel
    } else if (typeof configuredModel === 'string') {
      this.model = new BedrockNovaSonicModel({ modelId: configuredModel })
    } else if (configuredModel === undefined) {
      this.model = new BedrockNovaSonicModel()
    } else {
      throw new Error('model must be a BidiModel, string, or undefined')
    }

    if (config?.systemPrompt !== undefined) {
      this.systemPrompt = systemPromptFromData(config.systemPrompt)
    }
    this.messages = (config?.messages ?? []).map((message) =>
      message instanceof Message ? message : Message.fromMessageData(message)
    )
    this.storage = config?.storage
    this._sandbox = config?.sandbox

    // Agent identification
    this.id = config?.id ?? DEFAULT_AGENT_ID
    this.name = config?.name ?? DEFAULT_AGENT_NAME
    if (config?.description !== undefined) this.description = config.description

    this.appState = new StateStore(config?.appState)
    this.modelState = new StateStore(config?.modelState)

    const { tools, mcpClients } = flattenTools(config?.tools ?? [])
    this._toolRegistry = new ToolRegistry(tools)
    this._mcpClients = mcpClients

    this._auxModel =
      typeof config?.auxModel === 'string' ? new BedrockModel({ modelId: config.auxModel }) : config?.auxModel

    this._hooksRegistry = new HookRegistryImplementation()
    this._middlewareRegistry = new MiddlewareRegistry()
    this._meter = new Meter()
    this._tracer = new Tracer()

    this.sessionManager = config?.sessionManager
    this._pluginRegistry = new PluginRegistry([
      ...(config?.plugins ?? []),
      ...(this.sessionManager ? [this.sessionManager] : []),
    ])

    this._toolCaller = ToolCaller.create(this, (message) => this._appendMessages(message))
    this._loop = new AgentLoop(this)

    // Plugin initialization is async in TypeScript, so the constructor kicks it off and
    // start() awaits it; the initialized hook fires once plugins are attached.
    this._initialized = this._initialize()
  }

  /** Attach plugins and fire the initialized hook. */
  private async _initialize(): Promise<void> {
    await this._pluginRegistry.initialize(this)
    await this._hooksRegistry.invokeCallbacks(new InitializedEvent({ agent: this }))
  }

  /**
   * Direct tool calling accessor.
   *
   * Returns a proxy where each property is a tool handle with `.invoke()` and `.stream()`:
   * ```typescript
   * const result = await agent.tool.calculator!.invoke({ expression: '2+2' })
   * ```
   */
  get tool(): ToolCallerProxy {
    return this._toolCaller
  }

  /** The tool registry holding the tools available to this agent. */
  get toolRegistry(): ToolRegistry {
    return this._toolRegistry
  }

  /** Names of all tools available to this agent. */
  get toolNames(): string[] {
    return this._toolRegistry.list().map((tool) => tool.name)
  }

  /**
   * A stable, unique identifier for the current conversation session.
   *
   * Delegates to the session manager when one is attached. Otherwise, lazily generates and
   * caches a random 8-character hex string.
   */
  get sessionId(): string {
    if (this.sessionManager) return this.sessionManager.sessionId
    this._sessionId ??= globalThis.crypto.randomUUID().slice(0, 8)
    return this._sessionId
  }

  /**
   * Execution environment for running commands, code, and file operations.
   *
   * @throws DefaultNotConfiguredError if no sandbox is configured for this
   * environment (e.g. browsers, where no host default is registered).
   */
  get sandbox(): Sandbox {
    return this._sandbox || defaultSandbox.get()
  }

  /** The context manager plugin; always undefined because bidirectional agents have none. */
  get contextManager(): ContextManager | undefined {
    return undefined
  }

  /**
   * Model for auxiliary side calls (summarization, memory extraction, classification).
   *
   * Bidirectional models cannot serve request/response calls, so this falls back to a default
   * {@link BedrockModel} rather than to {@link BidiAgent.model}.
   */
  get auxModel(): Model {
    this._auxModel ??= new BedrockModel()
    return this._auxModel
  }

  set auxModel(auxModel: Model | string | undefined) {
    this._auxModel = typeof auxModel === 'string' ? new BedrockModel({ modelId: auxModel }) : auxModel
  }

  /** Read-only snapshot of accumulated agent metrics. */
  get metrics(): AgentMetrics {
    return this._meter.metrics
  }

  /**
   * The cancellation signal for the current conversation.
   *
   * Treat as read-only; call {@link BidiAgent.cancel} to request cancellation.
   */
  get cancelSignal(): AbortSignal {
    return this._cancelSignal
  }

  /**
   * Whether a conversation connection is open.
   *
   * @internal Consumed by {@link ToolCaller} to reject recorded direct tool calls mid-conversation.
   */
  get isInvoking(): boolean {
    return this._started
  }

  /**
   * Request cancellation of the current conversation.
   *
   * Idempotent. Cancellation takes effect only after a tool group completes.
   */
  cancel(): void {
    this._abortController.abort()
  }

  /**
   * Register a hook callback for a specific event type.
   *
   * @param eventType - The event class constructor to register the callback for
   * @param callback - The callback function to invoke when the event occurs
   * @param options - Optional configuration including execution order
   * @returns Cleanup function that removes the callback when invoked
   */
  addHook<T extends HookableEvent>(
    eventType: HookableEventConstructor<T>,
    callback: HookCallback<T>,
    options?: HookCallbackOptions
  ): HookCleanup {
    return this._hooksRegistry.addCallback(eventType, callback, options)
  }

  /**
   * Register a middleware handler for a given stage or phase.
   *
   * Bidirectional agents keep an empty registry so the shared tool executor can invoke the
   * tool stage uniformly; with no handlers registered the chain fast-paths to the terminal.
   *
   * @param stageOrPhase - A stage token (Around) or phase sub-token (.Input / .Output)
   * @param handler - Async generator for Around, plain async function for Input/Output
   * @returns A cleanup function that removes the middleware when called
   */
  addMiddleware<TContext, TResult, TEvent>(
    phase: MiddlewareInputPhase<TContext, TResult, TEvent>,
    handler: MiddlewareInputHandler<TContext>
  ): () => void
  addMiddleware<TContext, TResult, TEvent>(
    phase: MiddlewareWrapPhase<TContext, TResult, TEvent>,
    handler: MiddlewareHandler<TContext, TResult, TEvent>
  ): () => void
  addMiddleware<TContext, TResult, TEvent>(
    phase: MiddlewareOutputPhase<TContext, TResult, TEvent>,
    handler: MiddlewareOutputHandler<TResult>
  ): () => void
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

  /**
   * Start a persistent bidirectional conversation connection.
   *
   * Initializes the streaming connection and starts background tasks for processing model
   * events, tool execution, and connection management.
   *
   * @param options - Invocation state and an optional external cancellation signal
   * @throws {@link Error} If the agent is already started.
   */
  async start(options?: BidiStartOptions): Promise<void> {
    if (this._started) {
      throw new Error('agent already started | call stop before starting again')
    }

    await this._initialized
    await Promise.all(
      this._mcpClients.map(async (client) => {
        this._toolRegistry.add(await client.listTools())
      })
    )

    logger.debug('agent starting')
    // Compose the external signal with the agent's own, as Agent.stream does.
    this._cancelSignal =
      options?.cancelSignal !== undefined
        ? AbortSignal.any([this._abortController.signal, options.cancelSignal])
        : this._abortController.signal
    await this._loop.start(options?.invocationState)
    this._started = true
  }

  /**
   * Send user content to the model.
   *
   * Strings are shorthand for text blocks. Lists of text and image blocks form one user
   * message, preserving block order. Audio deltas are sent individually and are not added to
   * conversation history. Tool results are sent by the agent's tool runner.
   *
   * @param input - A string, text/image/audio-delta block, their JSON forms, or a nonempty
   *   list of strings and text/image blocks.
   * @throws {@link Error} If start has not been called, the input list is empty, or the input
   *   has an unsupported type or more than one supported key.
   */
  async send(input: BidiAgentInput): Promise<void> {
    if (!this._started) {
      throw new Error('agent not started | call start before sending')
    }

    if (input instanceof AudioDelta) {
      await this._loop.send(input)
      return
    }
    if (hasOnlyKey(input, 'audioDelta')) {
      await this._loop.send(new AudioDelta(input.audioDelta as AudioDeltaData))
      return
    }

    const inputs = Array.isArray(input) ? input : [input]
    const message: BidiMessage = { content: [] }
    for (const item of inputs) {
      if (item instanceof TextBlock || item instanceof ImageBlock) {
        message.content.push(item)
      } else if (typeof item === 'string') {
        message.content.push(new TextBlock(item))
      } else if (hasOnlyKey(item, 'text')) {
        message.content.push(new TextBlock(item.text as string))
      } else if (hasOnlyKey(item, 'image')) {
        message.content.push(new ImageBlock(item.image as ImageBlockData))
      } else if (isRecord(item)) {
        throw new Error('invalid input | expected one text or image key')
      } else {
        throw new Error('invalid input | expected a string, TextBlock, or ImageBlock')
      }
    }

    if (message.content.length === 0) {
      throw new Error('invalid input | input list cannot be empty')
    }

    await this._loop.send(message)
  }

  /**
   * Receive events from the model including audio, text, and tool calls.
   *
   * @returns Generator of model output events processed by background tasks, including audio
   *   output, text responses, tool calls, and connection updates.
   * @throws {@link Error} If start has not been called.
   */
  async *receive(): AsyncGenerator<BidiOutputEvent> {
    if (!this._started) {
      throw new Error('agent not started | call start before receiving')
    }

    yield* this._loop.receive()
  }

  /**
   * End the conversation connection and clean up background tasks.
   *
   * Terminates the streaming connection, cancels background tasks, and closes the connection
   * to the model provider.
   */
  async stop(): Promise<void> {
    this._started = false
    try {
      await this._loop.stop()
    } finally {
      this._abortController = new AbortController()
      this._cancelSignal = this._abortController.signal
    }
  }

  /**
   * Capture current agent state as an in-memory snapshot.
   *
   * Captures committed conversation history and application state. Live connection state,
   * in-progress responses, and pending tool calls are not included.
   *
   * @param options - Controls which fields to capture and optional app data to store
   * @returns A snapshot containing the captured agent state
   * @throws {@link Error} If a requested field is invalid or unsupported.
   */
  takeSnapshot(options: TakeSnapshotOptions = {}): Snapshot {
    for (const field of [...(options.include ?? []), ...(options.exclude ?? [])]) {
      if (!BIDI_SNAPSHOT_FIELDS.includes(field)) {
        throw new Error(
          `Invalid snapshot field: '${field}'. Valid fields: ${[...BIDI_SNAPSHOT_FIELDS].sort().join(', ')}`
        )
      }
    }

    const presetFields = options.preset !== undefined ? BIDI_SNAPSHOT_PRESETS[options.preset] : []
    return takeSnapshotInternal(this, {
      include: [...presetFields, ...(options.include ?? [])],
      ...(options.exclude !== undefined && { exclude: options.exclude }),
      ...(options.appData !== undefined && { appData: options.appData }),
    })
  }

  /**
   * Restore agent state from a previously captured snapshot.
   *
   * Only fields present in `snapshot.data` are restored; absent fields are left unchanged and
   * fields this agent does not support are ignored. The restored history is sent to the model
   * on the next start().
   *
   * @param snapshot - The snapshot to restore from
   * @throws {@link Error} If the agent is started, or the snapshot scope or schema version is
   *   unsupported.
   */
  loadSnapshot(snapshot: Snapshot): void {
    if (this._started) {
      throw new Error('agent started | call stop before loading a snapshot')
    }

    const supported = Object.fromEntries(
      Object.entries(snapshot.data).filter(([field]) => BIDI_SNAPSHOT_FIELDS.includes(field as SnapshotField))
    )
    loadSnapshotInternal(this, { ...snapshot, data: supported })
  }

  /**
   * Run the agent using the provided I/O streams for bidirectional communication.
   *
   * @param options - Inputs (streams or async iterables), outputs (streams or callbacks), invocation
   *   state, and an optional external cancellation signal. Aborting the signal cancels the
   *   conversation and ends the run.
   *
   * @example
   * ```typescript
   * const audioIo = new AudioIO()
   * const agent = new BidiAgent({ model, tools: [calculator] })
   * await agent.run({ inputs: [audioIo.input()], outputs: [audioIo.output()] })
   *
   * // Async iterables and callbacks work too
   * await agent.run({ inputs: [micChunks()], outputs: [(event) => console.log(event.type)] })
   * ```
   */
  async run(options: {
    inputs: BidiRunInput[]
    outputs: BidiRunOutput[]
    invocationState?: InvocationState
    cancelSignal?: AbortSignal
  }): Promise<void> {
    const { invocationState, cancelSignal } = options
    const inputs = options.inputs.map(toInputStream)
    const outputs = options.outputs.map(toOutputStream)
    const inputsController = new AbortController()

    let inputsTask: Promise<void> | undefined
    let outputsTask: Promise<void> | undefined
    try {
      await this.start({
        ...(invocationState !== undefined && { invocationState }),
        ...(cancelSignal !== undefined && { cancelSignal }),
      })

      for (const stream of [...inputs, ...outputs]) {
        await stream.start?.(this)
      }

      // A task group, like Python's: a failure on either side cancels the sibling before teardown.
      const taskGroup = new TaskGroup()
      inputsTask = taskGroup.createTask((taskSignal) =>
        this._runInputs(inputs, AbortSignal.any([inputsController.signal, taskSignal]))
      )
      outputsTask = taskGroup
        .createTask((taskSignal) => this._runOutputs(outputs, taskSignal))
        .finally(() => inputsController.abort())

      const streamTasks = taskGroup.join()
      if (cancelSignal !== undefined) {
        // Abandoning the joined promise on abort would otherwise reject unhandled.
        streamTasks.catch(() => {})
        await Promise.race([streamTasks, whenAborted(cancelSignal)])
      } else {
        await streamTasks
      }
    } finally {
      inputsController.abort()
      // A read already in flight cannot be cancelled in JavaScript, so it is abandoned.
      inputsTask?.catch(() => {})
      outputsTask?.catch(() => {})

      const stops = [...inputs, ...outputs].flatMap((stream) => (stream.stop ? [stream.stop.bind(stream)] : []))
      await stopAll(...stops, () => this.stop())
    }
  }

  /** Read every input stream concurrently and forward what it yields to the model. */
  private async _runInputs(inputs: BidiInputStream[], signal: AbortSignal): Promise<void> {
    const taskGroup = new TaskGroup()
    for (const input of inputs) {
      taskGroup.createTask(async (taskSignal) => {
        const stop = AbortSignal.any([signal, taskSignal])
        while (!stop.aborted) {
          const event = await Promise.race([input.read(), whenAborted(stop)])
          if (event === ABORTED) return
          await this.send(event)
        }
      })
    }
    await taskGroup.join()
  }

  /** Fan each output event out to every output stream. */
  private async _runOutputs(outputs: BidiOutputStream[], signal: AbortSignal): Promise<void> {
    // Driven as a raw iterator so a sibling failure can abandon a `receive()` that is parked on
    // the event queue instead of leaving it to block teardown.
    const reader = this.receive()[Symbol.asyncIterator]()
    let pendingNext: Promise<IteratorResult<BidiOutputEvent, unknown>> | undefined

    try {
      while (!signal.aborted) {
        pendingNext = reader.next()
        const next = await Promise.race([pendingNext, whenAborted(signal)])
        if (next === ABORTED || signal.aborted) return
        pendingNext = undefined
        if (next.done === true) return

        const taskGroup = new TaskGroup()
        for (const output of outputs) {
          taskGroup.createTask(() => output.write(next.value))
        }
        await taskGroup.join()
      }
    } finally {
      // An abandoned `next()` keeps the generator busy, so the close request is fired, not awaited.
      pendingNext?.catch(() => {})
      void reader.return?.(undefined).catch(() => {})
    }
  }

  /**
   * Stop the agent when it leaves an `await using` scope, on normal exit and on throw.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    logger.debug('context_manager=<exit> | stopping agent')
    await this.stop()
  }

  /**
   * Invoke the registered hook callbacks for an event.
   *
   * @param event - Event to dispatch to the hook registry
   * @internal
   */
  async _invokeCallbacks<T extends HookableEvent>(event: T): Promise<T> {
    return this._hooksRegistry.invokeCallbacks(event)
  }

  /**
   * Append messages to history in sequence without interference.
   *
   * The message lock ensures that paired messages are added to history in sequence without
   * interference. For example, tool use and tool result messages must be added adjacent to
   * each other.
   *
   * @param messages - Messages to add into history
   * @internal
   */
  async _appendMessages(...messages: Message[]): Promise<void> {
    await this._withMessageLock(async () => {
      for (const message of messages) {
        this.messages.push(message)
        await this._hooksRegistry.invokeCallbacks(new MessageAddedEvent({ agent: this, message, invocationState: {} }))
      }
    })
  }

  /**
   * Replace a message by its tracking ID, searching newest messages first.
   *
   * @param message - Replacement message carrying the original tracking ID
   * @param options - Set `strict` to false to log instead of throwing when the message is gone
   * @throws {@link Error} If the message is missing and `strict` is true.
   * @internal
   */
  async _updateMessage(message: Message, options?: { strict?: boolean }): Promise<void> {
    const strict = options?.strict ?? true
    let found = false
    await this._withMessageLock(() => {
      for (let index = this.messages.length - 1; index >= 0; index--) {
        if (this.messages[index]?.trackingId !== message.trackingId) continue
        this.messages[index] = message
        found = true
        break
      }
    })

    if (!found) {
      if (strict) {
        throw new Error(`tracking_id=<${message.trackingId}> | message not found in history`)
      }
      logger.warn(`tracking_id=<${message.trackingId}> | message not found in history`)
    }
  }

  /** Run a history mutation with exclusive access to the message list. */
  private async _withMessageLock(mutate: () => void | Promise<void>): Promise<void> {
    const previous = this._messageLock
    let release: () => void = () => {}
    this._messageLock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      await mutate()
    } finally {
      release()
    }
  }
}

/** Whether a value is a plain object, the analog of Python's `case dict()`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Whether a value is a record whose only key is `key`.
 *
 * @param value - Value to test
 * @param key - The single key the record must carry
 * @returns true if the value has exactly that one key
 */
function hasOnlyKey<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return isRecord(value) && Object.keys(value).length === 1 && key in value
}
