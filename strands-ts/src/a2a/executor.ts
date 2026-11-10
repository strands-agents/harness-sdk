/**
 * A2A executor that bridges a Strands Agent into the A2A protocol.
 *
 * Implements the AgentExecutor interface from `@a2a-js/sdk/server` to allow
 * a Strands Agent to handle A2A JSON-RPC requests.
 */

import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server'
import type { AgentExecutor } from '@a2a-js/sdk/server'
import { A2AError } from '@a2a-js/sdk/server'
import type { InvokableAgent, LocalAgent } from '../types/agent.js'
import type { Snapshot } from '../types/snapshot.js'
import type { ContentBlock } from '../types/messages.js'
import { ModelStreamUpdateEvent, ContentBlockEvent } from '../hooks/events.js'
import { contentBlocksToParts, partsToContentBlocks } from './adapters.js'
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
   * @param context - The A2A request context containing the user message
   * @param eventBus - The event bus for publishing A2A artifact and status events
   */
  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = context
    const contentBlocks = partsToContentBlocks(userMessage.parts)
    if (contentBlocks.length === 0) {
      throw A2AError.invalidRequest('No content blocks available')
    }

    // Register the task with the ResultManager; without this, later events are ignored as "unknown task".
    eventBus.publish({ kind: 'task', id: taskId, contextId, status: { state: 'working' } })

    if (this._agentFactory !== undefined) {
      await this._runWithContextAgent(context, contentBlocks, eventBus)
    } else {
      await this._runWithSharedAgent(context, contentBlocks, eventBus)
    }
  }

  /** Factory mode: run against this context's dedicated agent, serialized only per context. */
  private async _runWithContextAgent(
    context: RequestContext,
    contentBlocks: ContentBlock[],
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const { agent, lock } = this._acquireContextAgent(context.contextId)
    using _release = await lock.acquire()
    await this._streamAgent(agent, context, contentBlocks, eventBus)
  }

  /** Single-agent mode: swap this context's snapshot on/off the shared agent under a lock. */
  private async _runWithSharedAgent(
    context: RequestContext,
    contentBlocks: ContentBlock[],
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const agent = this._agent!
    using _release = await this._sharedAgentLock.acquire()
    this._restoreState(agent, this._snapshots.get(context.contextId) ?? this._templateSnapshot!)
    try {
      await this._streamAgent(agent, context, contentBlocks, eventBus)
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
    contentBlocks: ContentBlock[],
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const { taskId, contextId } = context
    const artifactId = globalThis.crypto.randomUUID()
    let isFirstChunk = true

    try {
      const stream = agent.stream(contentBlocks, {
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

      // Publish final artifact chunk to signal end of artifact
      eventBus.publish({
        kind: 'artifact-update',
        taskId,
        contextId,
        artifact: {
          artifactId,
          // If no deltas were streamed, publish the full result; otherwise empty to close the artifact
          parts: [{ kind: 'text', text: isFirstChunk && next.value ? next.value.toString() : '' }],
        },
        append: !isFirstChunk,
        lastChunk: true,
      })

      eventBus.publish({ kind: 'status-update', taskId, contextId, status: { state: 'completed' }, final: true })
    } catch (error) {
      logger.error(`task_id=<${taskId}> | error in streaming execution`, normalizeError(error))
      throw error
    }
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
