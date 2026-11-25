/**
 * A2A executor that bridges a Strands Agent into the A2A protocol.
 *
 * Implements the AgentExecutor interface from `@a2a-js/sdk/server` to allow
 * a Strands Agent to handle A2A JSON-RPC requests.
 */

import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server'
import type { AgentExecutor } from '@a2a-js/sdk/server'
import { A2AError } from '@a2a-js/sdk/server'
import type { Part, Task } from '@a2a-js/sdk'
import type { AgentResult, InvokableAgent, LocalAgent } from '../types/agent.js'
import type { Snapshot } from '../types/snapshot.js'
import type { ContentBlock } from '../types/messages.js'
import type { Interrupt, InterruptState } from '../interrupt.js'
import { isInterruptResponseContent, type InterruptResponseContent } from '../types/interrupt.js'
import type { JSONValue } from '../types/json.js'
import { ModelStreamUpdateEvent, ContentBlockEvent } from '../hooks/events.js'
import { INTERRUPTS_KEY, contentBlocksToParts, extractInterruptResponses, partsToContentBlocks } from './adapters.js'
import { normalizeError } from '../errors.js'
import { logger } from '../logging/logger.js'
import { AsyncLock } from './async-lock.js'

/** Builds a fresh agent for a given A2A `contextId`, invoked once per context. */
export type AgentFactory = (contextId: string) => InvokableAgent

/** Default cap on concurrently tracked A2A contexts. */
export const DEFAULT_MAX_CONTEXTS = 1000

/** Factory mode: a context's dedicated agent and the lock serializing its requests. */
interface ContextEntry {
  agent: InvokableAgent
  lock: AsyncLock
}

/**
 * Options for constructing an {@link A2AExecutor}.
 *
 * Provide exactly one of `agent` (deprecated) or `agentFactory`.
 */
export interface A2AExecutorOptions {
  /** @deprecated A single agent reused across contexts. Prefer `agentFactory`. */
  agent?: InvokableAgent
  /** Callable that returns a fresh agent per `contextId`. Recommended. */
  agentFactory?: AgentFactory
  /** Maximum contexts to retain; the least-recently-used is evicted beyond it. Must be at least 1. */
  maxContexts?: number
}

/**
 * What this executor invokes the agent with: fresh conversational content, or interrupt responses
 * resuming a task parked in `input-required`. Each arm stays homogeneous because the agent rejects
 * a prompt whose contents are not all interrupt responses.
 */
type AgentPrompt = ContentBlock[] | InterruptResponseContent[]

/** Whether a prompt carries interrupt responses rather than conversational content. */
function isInterruptResume(prompt: AgentPrompt): prompt is InterruptResponseContent[] {
  return prompt.length > 0 && isInterruptResponseContent(prompt[0])
}

/** Reads the agent's interrupt state, a field not declared on {@link InvokableAgent}. */
function interruptStateOf(agent: InvokableAgent): InterruptState | undefined {
  return (agent as { _interruptState?: InterruptState })._interruptState
}

/**
 * Returns a value unchanged when it can cross the JSON-RPC boundary, `null` for a value JSON drops
 * (a function or a symbol), else its string form.
 *
 * An interrupt reason is user data, typed as JSON only at compile time.
 */
function jsonable(value: JSONValue): JSONValue {
  try {
    return JSON.stringify(value) === undefined ? null : value
  } catch {
    return String(value)
  }
}

/** A full Strands `Agent` that can be both invoked and snapshotted. */
type SnapshotAgent = InvokableAgent & LocalAgent

/** Narrows to a {@link SnapshotAgent}, throwing if the agent lacks snapshot support. */
function asSnapshotAgent(agent: InvokableAgent): SnapshotAgent {
  const candidate = agent as Partial<LocalAgent>
  if (typeof candidate.takeSnapshot !== 'function' || typeof candidate.loadSnapshot !== 'function') {
    throw new Error(
      'A2AExecutor requires an Agent that supports snapshots (takeSnapshot/loadSnapshot). ' +
        'Pass a Strands Agent instance.'
    )
  }
  return agent as unknown as SnapshotAgent
}

/** Whether the agent has a configured `sessionManager` (a field not declared on {@link InvokableAgent}). */
function hasSessionManager(agent: InvokableAgent): boolean {
  return (agent as { sessionManager?: unknown }).sessionManager !== undefined
}

/**
 * Bridges a Strands Agent into the A2A protocol as an AgentExecutor.
 *
 * Converts A2A message parts to Strands content blocks, streams the agent
 * execution, and publishes text deltas as artifact updates through the A2A
 * event bus.
 *
 * Conversation state is isolated per A2A `contextId`. There are two modes:
 *
 * - **`agentFactory`** (recommended): returns a dedicated agent per context. Each
 *   context owns an independent agent under its own lock, so different contexts run
 *   concurrently and never share state. The factory is also where per-context
 *   concerns such as a `sessionManager` are wired.
 * - **`agent`** (deprecated): a single agent reused across contexts, with each
 *   context's state swapped on/off it under a lock. Not multi-tenant safe; prefer
 *   `agentFactory`.
 *
 * `contextId` is client-supplied and is **not** an authentication boundary: a caller
 * that knows another's `contextId` can attach to that conversation. Multi-tenant
 * deployments must enforce authenticated identity at the transport/gateway layer.
 *
 * The incoming {@link RequestContext} is forwarded to the agent's `invocationState`
 * under the reserved key `a2aRequestContext` for hooks and tools to read.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { A2AExecutor } from '@strands-agents/sdk/a2a'
 *
 * const executor = new A2AExecutor({ agentFactory: (contextId) => new Agent({ model: 'my-model' }) })
 * ```
 */
export class A2AExecutor implements AgentExecutor {
  private readonly _agentFactory?: AgentFactory
  private readonly _maxContexts: number

  /** Serializes single-agent mode: only one request may use the shared agent at a time. */
  private readonly _sharedAgentLock = new AsyncLock()

  // Factory mode: a dedicated agent and lock per context.
  private readonly _contexts = new Map<string, ContextEntry>()

  // Single-agent mode: one shared agent, swapping each context's snapshot on/off it.
  private readonly _agent?: SnapshotAgent
  private readonly _templateSnapshot?: Snapshot
  private readonly _snapshots = new Map<string, Snapshot>()

  /**
   * Creates a new A2AExecutor.
   *
   * Provide exactly one of `agent` (deprecated) or `agentFactory`.
   *
   * @param options - Executor options: `agent` or `agentFactory`, plus optional `maxContexts`.
   */
  constructor(options: A2AExecutorOptions = {}) {
    const { agent, agentFactory, maxContexts = DEFAULT_MAX_CONTEXTS } = options

    if (maxContexts < 1) {
      throw new Error(`maxContexts must be at least 1, got ${maxContexts}`)
    }
    if ((agent === undefined) === (agentFactory === undefined)) {
      throw new Error("Provide exactly one of 'agent' or 'agentFactory'.")
    }

    this._maxContexts = maxContexts

    if (agentFactory !== undefined) {
      this._agentFactory = agentFactory
    } else {
      const sharedAgent = asSnapshotAgent(agent!)
      if (hasSessionManager(sharedAgent)) {
        throw new Error(
          "A single 'agent' with a sessionManager is not supported: the session manager " +
            "persists every context's messages into one interleaved session. Use " +
            "'agentFactory' to build a per-context agent with its own sessionManager."
        )
      }
      logger.warn(
        "Passing a single 'agent' to A2AExecutor is deprecated and will be removed in a future " +
          'version. A single agent serializes all requests; pass an agentFactory (a callable taking ' +
          'the contextId) instead to isolate conversations per context.'
      )
      this._agent = sharedAgent
      this._templateSnapshot = this._captureState(sharedAgent)
    }
  }

  /** Snapshot an agent's session state. */
  private _captureState(agent: LocalAgent): Snapshot {
    return agent.takeSnapshot({ preset: 'session' })
  }

  /** Load a snapshot into an agent, restoring its session state. */
  private _restoreState(agent: LocalAgent, snapshot: Snapshot): void {
    agent.loadSnapshot(snapshot)
  }

  /** Evict least-recently-used contexts beyond `maxContexts`. */
  private _evictExcessContexts(): void {
    const contexts: Map<string, unknown> = this._agentFactory !== undefined ? this._contexts : this._snapshots
    while (contexts.size > this._maxContexts) {
      const evictedId = contexts.keys().next().value as string
      contexts.delete(evictedId)
      logger.debug(`context_id=<${evictedId}> | evicted least-recently-used A2A context`)
    }
  }

  /** Return the dedicated agent and lock for a context, creating it on first use (factory mode). */
  private _acquireContextAgent(contextId: string): ContextEntry {
    let entry = this._contexts.get(contextId)
    if (entry === undefined) {
      entry = { agent: this._agentFactory!(contextId), lock: new AsyncLock() }
      this._contexts.set(contextId, entry)
      this._evictExcessContexts()
    } else {
      // Move to most-recently-used end.
      this._contexts.delete(contextId)
      this._contexts.set(contextId, entry)
    }
    return entry
  }

  /**
   * Executes the agent in response to an A2A message.
   *
   * A message refused while its task waits in `input-required` leaves the task waiting, with the
   * reason for the refusal, instead of rejecting.
   *
   * @param context - The A2A request context containing the user message
   * @param eventBus - The event bus for publishing A2A artifact and status events
   */
  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    try {
      await this._executeMessage(context, eventBus)
    } catch (error) {
      // The request handler would turn a rejection into a terminal failed task.
      const { task } = context
      if (!(error instanceof A2AError) || task?.status.state !== 'input-required') {
        throw error
      }
      this._publishRefusal(task, error.message, eventBus)
    }
  }

  /**
   * Converts the inbound message to a prompt and runs the agent serving its context.
   *
   * @param context - The A2A request context containing the user message
   * @param eventBus - The event bus for publishing A2A artifact and status events
   */
  private async _executeMessage(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, task, userMessage } = context

    // The generic conversion would flatten interrupt responses into text.
    const prompt: AgentPrompt = extractInterruptResponses(userMessage.parts) ?? partsToContentBlocks(userMessage.parts)
    if (prompt.length === 0) {
      throw A2AError.invalidRequest('No content blocks available')
    }

    if (task === undefined) {
      // Register the task with the ResultManager; without this, later events are ignored as "unknown task".
      eventBus.publish({ kind: 'task', id: taskId, contextId, status: { state: 'working' } })
    }

    if (this._agentFactory !== undefined) {
      await this._runWithContextAgent(context, prompt, eventBus)
    } else {
      await this._runWithSharedAgent(context, prompt, eventBus)
    }
  }

  /** Factory mode: run against this context's dedicated agent, serialized only per context. */
  private async _runWithContextAgent(
    context: RequestContext,
    prompt: AgentPrompt,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const { agent, lock } = this._acquireContextAgent(context.contextId)
    using _release = await lock.acquire()
    await this._streamAgent(agent, context, prompt, eventBus)
  }

  /** Single-agent mode: swap this context's snapshot on/off the shared agent under a lock. */
  private async _runWithSharedAgent(
    context: RequestContext,
    prompt: AgentPrompt,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const agent = this._agent!
    using _release = await this._sharedAgentLock.acquire()
    this._restoreState(agent, this._snapshots.get(context.contextId) ?? this._templateSnapshot!)
    try {
      await this._streamAgent(agent, context, prompt, eventBus)
    } finally {
      // Persist updated history (even on error), evict, then reset the agent for the next caller.
      this._snapshots.delete(context.contextId)
      this._snapshots.set(context.contextId, this._captureState(agent))
      this._evictExcessContexts()
      this._restoreState(agent, this._templateSnapshot!)
    }
  }

  /** Streams one agent invocation and translates its events to A2A artifact updates. */
  private async _streamAgent(
    agent: InvokableAgent,
    context: RequestContext,
    prompt: AgentPrompt,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const { taskId, contextId } = context
    const artifactId = globalThis.crypto.randomUUID()
    let isFirstChunk = true

    this._validatePrompt(agent, prompt)
    this._publishWorking(context, eventBus)

    try {
      const stream = agent.stream(prompt, {
        invocationState: { a2aRequestContext: context },
      })
      let next = await stream.next()

      while (!next.done) {
        const event = next.value

        // Stream text deltas incrementally into the text artifact
        if (
          event instanceof ModelStreamUpdateEvent &&
          event.event.type === 'modelContentBlockDeltaEvent' &&
          event.event.delta.type === 'textDelta'
        ) {
          eventBus.publish({
            kind: 'artifact-update',
            taskId,
            contextId,
            artifact: {
              artifactId,
              parts: [{ kind: 'text', text: event.event.delta.text }],
            },
            append: !isFirstChunk,
          })
          isFirstChunk = false
        }

        // Publish non-text content blocks (images, videos, documents) as separate artifacts
        if (event instanceof ContentBlockEvent && event.contentBlock.type !== 'textBlock') {
          const parts = contentBlocksToParts([event.contentBlock])
          if (parts.length > 0) {
            eventBus.publish({
              kind: 'artifact-update',
              taskId,
              contextId,
              artifact: { artifactId: globalThis.crypto.randomUUID(), parts },
              append: false,
              lastChunk: true,
            })
          }
        }

        next = await stream.next()
      }

      this._publishResult(next.value, artifactId, isFirstChunk, taskId, contextId, eventBus)
    } catch (error) {
      logger.error(`task_id=<${taskId}> | error in streaming execution`, normalizeError(error))
      throw error
    }
  }

  /**
   * Refuses a prompt the agent cannot take, before the agent runs.
   *
   * @param agent - The agent serving this context
   * @param prompt - The content or interrupt responses the agent would be invoked with
   * @throws A2AError when interrupt responses do not bind to a parked interrupt, or when new content
   *   arrives while an interrupt is parked
   */
  private _validatePrompt(agent: InvokableAgent, prompt: AgentPrompt): void {
    if (isInterruptResume(prompt)) {
      this._validateInterruptResume(agent, prompt)
      return
    }
    if (interruptStateOf(agent)?.activated === true) {
      throw A2AError.invalidParams('Task is awaiting an interrupt response and cannot accept a new message')
    }
  }

  /**
   * Verifies interrupt responses bind to interrupts actually parked on this context's agent.
   *
   * @param agent - The agent serving this context, with its interrupt state already restored
   * @param responses - Interrupt responses extracted from the inbound message
   * @throws A2AError when the agent holds no parked interrupts, or a response names an interrupt
   *   the agent is not waiting on
   */
  private _validateInterruptResume(agent: InvokableAgent, responses: InterruptResponseContent[]): void {
    const state = interruptStateOf(agent)
    if (state?.activated !== true) {
      throw A2AError.invalidParams('Received interrupt responses but no interrupt is pending')
    }

    const unknownIds = responses
      .map((content) => content.interruptResponse.interruptId)
      .filter((id) => !Object.hasOwn(state.interrupts, id))
      .sort()
    if (unknownIds.length > 0) {
      throw A2AError.invalidParams(`No pending interrupt matches id(s): ${unknownIds.join(', ')}`)
    }
  }

  /**
   * Moves a task that already exists to `working` once the request is known to be servable.
   *
   * The request handler stores a `task` event as the whole task, so the task moves by a status update
   * instead, which keeps its history and artifacts.
   *
   * @param context - The A2A request context, holding the stored task when the message continues one
   * @param eventBus - The event bus for publishing status events
   */
  private _publishWorking(context: RequestContext, eventBus: ExecutionEventBus): void {
    const { taskId, contextId, task } = context
    if (task === undefined) {
      return
    }
    eventBus.publish({ kind: 'status-update', taskId, contextId, status: { state: 'working' }, final: false })
  }

  /**
   * Publishes how a run ended: `input-required` when the agent stopped on an interrupt, otherwise the
   * closing artifact chunk and `completed`.
   *
   * @param result - The result the agent returned
   * @param artifactId - The text artifact the run streamed into
   * @param isFirstChunk - Whether no text delta was streamed into the artifact
   * @param taskId - The A2A task the run belongs to
   * @param contextId - The A2A context the task belongs to
   * @param eventBus - The event bus for publishing artifact and status events
   */
  private _publishResult(
    result: AgentResult | undefined,
    artifactId: string,
    isFirstChunk: boolean,
    taskId: string,
    contextId: string,
    eventBus: ExecutionEventBus
  ): void {
    // Checked before the closing artifact, which could carry the raw interrupt list.
    if (result?.stopReason === 'interrupt') {
      this._publishInputRequired(result.interrupts ?? [], taskId, contextId, eventBus)
      return
    }

    // Publish final artifact chunk to signal end of artifact
    eventBus.publish({
      kind: 'artifact-update',
      taskId,
      contextId,
      artifact: {
        artifactId,
        // If no deltas were streamed, publish the full result; otherwise empty to close the artifact
        parts: [{ kind: 'text', text: isFirstChunk && result ? result.toString() : '' }],
      },
      append: !isFirstChunk,
      lastChunk: true,
    })

    eventBus.publish({ kind: 'status-update', taskId, contextId, status: { state: 'completed' }, final: true })
  }

  /**
   * Moves the task to `input-required` and tells the client which interrupts are waiting.
   *
   * The interrupts are published twice: a text part for people, and a data part with each
   * `interruptId`, which a client sends back to answer.
   *
   * @param interrupts - The unanswered interrupts that stopped the agent
   * @param taskId - The A2A task being paused
   * @param contextId - The A2A context the task belongs to
   * @param eventBus - The event bus for publishing status events
   */
  private _publishInputRequired(
    interrupts: Interrupt[],
    taskId: string,
    contextId: string,
    eventBus: ExecutionEventBus
  ): void {
    // `reason` is always present, null when the interrupt has none, the same as on the Python server.
    const pending = interrupts.map((interrupt) => ({
      interruptId: interrupt.id,
      name: interrupt.name,
      reason: jsonable(interrupt.reason ?? null),
    }))
    const descriptions = pending.map(({ name, reason }) =>
      reason === null ? `- ${name}` : `- ${name}: ${JSON.stringify(reason)}`
    )
    const text =
      descriptions.length > 0
        ? `Agent requires input:\n${descriptions.join('\n')}`
        : 'Agent requires additional input to continue'

    // The text part stays first so clients that only read prose are unaffected.
    const parts: Part[] = [{ kind: 'text', text }]
    if (pending.length > 0) {
      parts.push({ kind: 'data', data: { [INTERRUPTS_KEY]: pending } })
    }

    this._parkTask(parts, taskId, contextId, eventBus)
  }

  /**
   * Keeps a task in `input-required` after refusing a message sent to it.
   *
   * The data part the task advertised follows the reason, so the client can answer again without
   * fetching the task.
   *
   * @param task - The waiting task the refused message was sent to
   * @param reason - Why the message was refused
   * @param eventBus - The event bus for publishing status events
   */
  private _publishRefusal(task: Task, reason: string, eventBus: ExecutionEventBus): void {
    const advertised = (task.status.message?.parts ?? []).filter((part) => part.kind === 'data')
    this._parkTask(
      [{ kind: 'text', text: `Message refused: ${reason}` }, ...advertised],
      task.id,
      task.contextId,
      eventBus
    )
  }

  /**
   * Publishes the final `input-required` status of a task.
   *
   * @param parts - The parts of the status message
   * @param taskId - The A2A task waiting for input
   * @param contextId - The A2A context the task belongs to
   * @param eventBus - The event bus for publishing status events
   */
  private _parkTask(parts: Part[], taskId: string, contextId: string, eventBus: ExecutionEventBus): void {
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: {
        state: 'input-required',
        message: {
          kind: 'message',
          role: 'agent',
          messageId: globalThis.crypto.randomUUID(),
          taskId,
          contextId,
          parts,
        },
      },
      final: true,
    })
  }

  /**
   * Cancels a running task. Not supported by this executor.
   *
   * @param taskId - The ID of the task to cancel
   * @param eventBus - The event bus for publishing status events
   */
  async cancelTask(_taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    throw A2AError.unsupportedOperation('Task cancellation is not supported')
  }
}
