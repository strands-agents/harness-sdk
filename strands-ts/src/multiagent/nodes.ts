import { Agent } from '../agent/agent.js'
import { AgentPrinter, type Printer } from '../agent/printer.js'
import type { InvocationState, InvokableAgent, InvokeOptions, AgentStreamEvent } from '../types/agent.js'
import type { Invocation } from '../agent/invocation.js'
import type { MultiAgentInput, MultiAgentInvokeOptions } from './multiagent.js'
import { dropStaleInterruptedResult } from './multiagent.js'
import type { MultiAgentStreamEvent } from './events.js'
import { NodeStreamUpdateEvent, NodeResultEvent } from './events.js'
import { NodeResult, Status } from './state.js'
import type { MultiAgentState, NodeResultUpdate } from './state.js'
import type { MultiAgent } from './multiagent.js'
import { logger } from '../logging/logger.js'
import type { z } from 'zod'
import { normalizeError } from '../errors.js'
import { omitUndefined } from '../types/json.js'
import { LIMIT_STOP_REASONS, limitStopMessage } from '../types/messages.js'

/**
 * Known node type identifiers with extensibility for custom nodes.
 */
export type NodeType = 'agentNode' | 'multiAgentNode' | (string & {})

/**
 * Configuration for a node execution.
 */
export interface NodeConfig {
  /**
   * Optional description of what this node does.
   */
  description?: string
}

/**
 * Per-invocation options passed from the orchestrator to a node.
 */
export interface NodeInputOptions {
  /**
   * Structured output schema for this node invocation.
   */
  structuredOutputSchema?: z.ZodSchema

  /**
   * Per-invocation state forwarded to the node's underlying agent. See
   * {@link InvocationState}. Shared by reference across all nodes so one node's
   * hooks/tools can read state written by a previous node.
   */
  invocationState?: InvocationState

  /**
   * Cancellation signal forwarded to the node's underlying agent. Used by
   * orchestrators to enforce per-node timeouts or propagate external cancellation.
   */
  cancelSignal?: AbortSignal

  /**
   * Buffer the agent's printer output and flush it on completion so concurrent siblings
   * don't interleave on stdout.
   */
  bufferOutput?: boolean

  /** The request this node runs as part of, forwarded to its underlying agent or orchestrator. */
  invocation?: Invocation
}

/**
 * Abstract base class for all multi-agent orchestration nodes.
 *
 * Uses the template method pattern: {@link stream} handles orchestration
 * boilerplate (duration measurement, status tracking, error capture) and
 * delegates to {@link handle} for node-specific execution logic.
 */
export abstract class Node {
  readonly type: string = 'node'
  /** Unique identifier for this node within the orchestration. */
  readonly id: string
  /** Per-node configuration. */
  readonly config: NodeConfig

  /**
   * @param id - Unique identifier for this node within the orchestration
   * @param config - Per-node configuration
   */
  constructor(id: string, config: NodeConfig) {
    this.id = id
    this.config = config
  }

  /**
   * Execute the node. Handles duration measurement, error capture,
   * and delegates to handle() for node-specific logic.
   *
   * @param input - Input to pass to the node (string or content blocks)
   * @param state - The current multi-agent state
   * @param options - Per-invocation options from the orchestrator
   * @returns Async generator yielding streaming events and returning a NodeResult
   */
  async *stream(
    input: MultiAgentInput,
    state: MultiAgentState,
    options?: NodeInputOptions
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResult, undefined> {
    const nodeState = state.node(this.id)!

    // Resuming from INTERRUPTED: drop the stale result so the fresh one replaces it.
    dropStaleInterruptedResult(this.id, nodeState, state)

    nodeState.status = Status.EXECUTING
    nodeState.startTime = Date.now()

    // Resolve invocationState once — the same reference is threaded into handle()
    // and into NodeResultEvent so callbacks see one object for the whole node run.
    const invocationState: InvocationState = options?.invocationState ?? {}
    const resolvedOptions: NodeInputOptions = { ...options, invocationState }

    let result: NodeResult
    try {
      const update = yield* this.handle(input, state, resolvedOptions)
      const defaultStatus = update.interrupts && update.interrupts.length > 0 ? Status.INTERRUPTED : Status.COMPLETED
      result = new NodeResult({
        nodeId: this.id,
        status: defaultStatus,
        duration: Date.now() - nodeState.startTime,
        content: [],
        ...update,
      })
    } catch (error) {
      // Orchestrator cancellation (short-circuit or external) maps thrown errors to
      // CANCELLED — node was stopped, not broken.
      const status = options?.cancelSignal?.aborted ? Status.CANCELLED : Status.FAILED
      result = new NodeResult({
        nodeId: this.id,
        status,
        duration: Date.now() - nodeState.startTime,
        error: normalizeError(error),
      })
      if (status === Status.FAILED) {
        logger.warn(`node_id=<${this.id}>, error=<${result.error?.message}> | node execution failed`)
      }
    } finally {
      nodeState.status = result!.status
      nodeState.results.push(result!)
      nodeState.interrupts = result!.interrupts ?? []
      // Clear the stored snapshot on non-INTERRUPTED terminal states; `handle()`
      // repopulates it above if this run itself interrupted.
      if (result!.status !== Status.INTERRUPTED) {
        delete nodeState.interruptedSnapshot
      }
    }

    yield new NodeResultEvent({
      nodeId: this.id,
      nodeType: this.type,
      state,
      result,
      invocationState,
    })
    return result
  }

  /**
   * Node-specific execution logic implemented by subclasses.
   *
   * @param input - Input to process (string or content blocks)
   * @param state - The current multi-agent state
   * @param options - Per-invocation options from the orchestrator
   * @returns Async generator yielding streaming events and returning a partial result
   */
  abstract handle(
    input: MultiAgentInput,
    state: MultiAgentState,
    options?: NodeInputOptions
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined>
}

/**
 * Options for creating an {@link AgentNode}.
 */
export interface AgentNodeOptions {
  /** The agent to wrap as a node. */
  agent: InvokableAgent
  /**
   * Per-node wall-clock ceiling in milliseconds. Overrides the orchestrator's
   * default node timeout. Cancellation is cooperative — a tool that neither
   * polls its cancel signal nor forwards it to a cancellable API can run past
   * this deadline.
   */
  timeout?: number
  /**
   * When `true`, the wrapped agent accumulates state (messages, appState,
   * modelState) across node executions. Useful for graph patterns where a
   * node is revisited and should build on its previous work (e.g., an
   * analyst that accumulates findings, or iterative refinement).
   *
   * When `false` (default), the agent's state is snapshotted before each
   * execution and restored in `finally`, so the node is stateless across
   * visits.
   *
   * Throws at construction time when set to `true` with a non-`Agent`
   * `InvokableAgent`, since snapshot/restore only applies to `Agent` instances.
   */
  preserveContext?: boolean
}

/**
 * Node that wraps an {@link InvokableAgent} instance for multi-agent orchestration.
 *
 * By default, when the wrapped agent is an {@link Agent} instance, its internal
 * state is snapshot/restored around each execution so it remains unchanged
 * after the node completes. Pass `preserveContext: true` to opt out and let the
 * wrapped agent accumulate state across node executions.
 */
export class AgentNode extends Node {
  readonly type = 'agentNode' as const
  private readonly _agent: InvokableAgent
  /**
   * Per-node wall-clock ceiling in milliseconds. When set, overrides the orchestrator's
   * `nodeTimeout` for this node. Undefined means "fall back to the orchestrator's setting."
   * See {@link AgentNodeOptions.timeout}.
   */
  readonly timeout?: number
  /**
   * Whether the wrapped agent retains state across node executions.
   * See {@link AgentNodeOptions.preserveContext}.
   */
  readonly preserveContext: boolean

  constructor(options: AgentNodeOptions) {
    const { agent, timeout, preserveContext, ...config } = options

    super(agent.id, {
      ...config,
      ...(agent.description !== undefined && { description: agent.description }),
    })

    this._agent = agent
    if (timeout !== undefined) {
      if (timeout < 1) {
        throw new Error(`timeout=<${timeout}>, node_id=<${agent.id}> | must be at least 1`)
      }
      this.timeout = timeout
    }
    if (preserveContext && !(agent instanceof Agent)) {
      throw new Error(
        `node_id=<${agent.id}> | preserveContext=true requires an Agent instance; non-Agent InvokableAgents cannot be snapshotted`
      )
    }
    this.preserveContext = preserveContext ?? false
  }

  get agent(): InvokableAgent {
    return this._agent
  }

  /**
   * Executes the wrapped agent, yielding each agent streaming event
   * wrapped in a {@link NodeStreamUpdateEvent}.
   *
   * @param input - Input to pass to the agent
   * @param state - The current multi-agent state
   * @param options - Per-invocation options from the orchestrator
   * @returns Async generator yielding streaming events and returning the agent's content blocks
   */
  async *handle(
    input: MultiAgentInput,
    state: MultiAgentState,
    options?: NodeInputOptions
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined> {
    // Resolve once per handle() call — Node.stream() normally supplies this;
    // handle() is public API, so direct callers get per-call state.
    const invocationState: InvocationState = options?.invocationState ?? {}
    const invocation = options?.invocation

    // Only Agent instances support snapshot/restore for state isolation.
    // When `preserveContext` is set, skip the snapshot/restore cycle so the agent
    // accumulates state across node executions.
    const isAgent = this._agent instanceof Agent
    const preRunSnapshot =
      !this.preserveContext && isAgent ? this._agent.takeSnapshot({ preset: 'session' }) : undefined

    // Rehydrate agent state from a prior INTERRUPTED run (messages + interrupt state).
    // Independent of `preserveContext`: a paused run always resumes from where it left off.
    const nodeState = state.node(this.id)
    if (isAgent && nodeState?.interruptedSnapshot) {
      this._agent.loadSnapshot(nodeState.interruptedSnapshot)
    }

    // Swap the agent's printer for a buffer so concurrent siblings don't interleave on stdout.
    const agentInternals =
      options?.bufferOutput && isAgent ? (this._agent as unknown as { _printer?: Printer }) : undefined
    const originalPrinter = agentInternals?._printer
    let buffered = ''
    if (agentInternals && originalPrinter) {
      agentInternals._printer = new AgentPrinter((text) => {
        buffered += text
      })
    }

    try {
      // Join the request's shared state so this node's usage folds
      // into the whole run's total rather than opening a fresh per-agent one.
      const invokeOptions: InvokeOptions = {
        ...(options?.structuredOutputSchema && { structuredOutputSchema: options.structuredOutputSchema }),
        ...(options?.cancelSignal && { cancelSignal: options.cancelSignal }),
        ...(invocation && { invocation }),
        invocationState,
      }

      const gen = this._agent.stream(input, invokeOptions)
      let next = await gen.next()
      while (!next.done) {
        yield new NodeStreamUpdateEvent({
          nodeId: this.id,
          nodeType: this.type,
          state,
          inner: isAgent
            ? { source: 'agent', event: next.value as AgentStreamEvent }
            : { source: 'custom', event: next.value },
          invocationState,
        })
        next = await gen.next()
      }

      const agentResult = next.value
      // Fail the node so the orchestrator doesn't treat a truncated answer as complete.
      if (LIMIT_STOP_REASONS.has(agentResult.stopReason)) {
        throw new Error(limitStopMessage(this.id, agentResult.stopReason))
      }
      const interrupted =
        agentResult.stopReason === 'interrupt' && agentResult.interrupts && agentResult.interrupts.length > 0

      // Capture post-interrupt state for the next resume cycle. Only Agent instances
      // are snapshottable.
      if (interrupted && isAgent && nodeState) {
        nodeState.interruptedSnapshot = this._agent.takeSnapshot({ preset: 'session' })
      }

      return omitUndefined({
        content: agentResult.lastMessage.content,
        structuredOutput: 'structuredOutput' in agentResult ? agentResult.structuredOutput : undefined,
        usage: agentResult.metrics?.accumulatedUsage,
        interrupts: interrupted ? agentResult.interrupts : undefined,
      })
    } finally {
      // Restore pre-run state — keeps the agent observably unchanged across runs.
      if (preRunSnapshot) {
        ;(this._agent as Agent).loadSnapshot(preRunSnapshot)
      }
      if (agentInternals && originalPrinter) {
        agentInternals._printer = originalPrinter
        if (buffered.length > 0) originalPrinter.write(buffered)
      }
    }
  }
}

/**
 * Options for creating a {@link MultiAgentNode}.
 */
export interface MultiAgentNodeOptions extends NodeConfig {
  /** The orchestrator to wrap as a node. */
  orchestrator: MultiAgent
}

/**
 * Node that wraps a multi-agent orchestrator (e.g. Graph) for nested composition.
 *
 * Inner {@link NodeStreamUpdateEvent}s pass through to preserve the original
 * node's identity. All other events are wrapped in a new {@link NodeStreamUpdateEvent}
 * tagged with this node's identity.
 */
export class MultiAgentNode extends Node {
  readonly type = 'multiAgentNode' as const
  private readonly _orchestrator: MultiAgent

  constructor(options: MultiAgentNodeOptions) {
    const { orchestrator, ...config } = options
    super(orchestrator.id, config)
    this._orchestrator = orchestrator
  }

  get orchestrator(): MultiAgent {
    return this._orchestrator
  }

  /**
   * Executes the wrapped orchestrator. Inner {@link NodeStreamUpdateEvent}s
   * pass through as-is; all other events are wrapped in a new
   * {@link NodeStreamUpdateEvent} tagged with this node's identity.
   *
   * @param input - Input to pass to the orchestrator
   * @param state - The current multi-agent state
   * @param options - Per-invocation options. `invocationState` is forwarded to the
   *   nested orchestrator; `structuredOutputSchema` is not applicable here.
   * @returns Async generator yielding streaming events and returning the orchestrator's content
   */
  async *handle(
    input: MultiAgentInput,
    state: MultiAgentState,
    options?: NodeInputOptions
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined> {
    // Resolve once per handle() call — Node.stream() normally supplies this;
    // handle() is public API, so direct callers get per-call state.
    const invocationState: InvocationState = options?.invocationState ?? {}
    const invocation = options?.invocation

    const nestedOptions: MultiAgentInvokeOptions = {
      invocationState,
      ...(options?.cancelSignal && { cancelSignal: options.cancelSignal }),
      ...(invocation && { invocation }),
    }
    const gen = this._orchestrator.stream(input, nestedOptions)
    let next = await gen.next()
    while (!next.done) {
      const event = next.value
      if (event.type === 'nodeStreamUpdateEvent') {
        yield event
      } else {
        yield new NodeStreamUpdateEvent({
          nodeId: this.id,
          nodeType: this.type,
          state,
          inner: { source: 'multiAgent', event },
          invocationState,
        })
      }
      next = await gen.next()
    }
    const innerResult = next.value
    const interrupted = innerResult.interrupts && innerResult.interrupts.length > 0

    return omitUndefined({
      content: innerResult.content,
      usage: innerResult.usage,
      status: innerResult.status !== Status.COMPLETED ? innerResult.status : undefined,
      error: innerResult.error,
      interrupts: interrupted ? innerResult.interrupts : undefined,
    })
  }
}

/**
 * A node definition accepted by orchestration constructors.
 *
 * Pass an {@link InvokableAgent} or {@link MultiAgent} directly for the simple case,
 * use typed options objects for per-node configuration, or provide pre-built
 * {@link Node} instances for full control.
 */
export type NodeDefinition = InvokableAgent | MultiAgent | Node | AgentNodeOptions | MultiAgentNodeOptions
