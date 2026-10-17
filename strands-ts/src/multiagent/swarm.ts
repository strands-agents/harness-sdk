import { logger } from '../logging/logger.js'
import { warnOnce } from '../logging/warn-once.js'
import type { AttributeValue, Span } from '@opentelemetry/api'
import type { InvocationState, InvokableAgent } from '../types/agent.js'
import type { MultiAgentInput, MultiAgentInvokeOptions } from './multiagent.js'
import {
  applyOrchestratorHookResponses,
  dropStaleInterruptedResult,
  extractResumeResponses,
  groupInterruptResponsesByNode,
  recordHookInterrupt,
} from './multiagent.js'
import { InterruptError } from '../interrupt.js'
import { z } from 'zod'
import { HookableEvent } from '../hooks/events.js'
import { HookRegistryImplementation } from '../hooks/registry.js'
import type { HookCallback, HookableEventConstructor, HookCleanup } from '../hooks/types.js'
import type { MultiAgentPlugin } from './plugins.js'
import { MultiAgentPluginRegistry } from './plugins.js'
import type { SessionManager } from '../session/session-manager.js'
import type { ContentBlock } from '../types/messages.js'
import { TextBlock } from '../types/messages.js'
import type { AgentNodeOptions } from './nodes.js'
import { AgentNode } from './nodes.js'
import { MultiAgentState, MultiAgentResult, NodeResult, Status } from './state.js'
import type { MultiAgent } from './multiagent.js'
import type { MultiAgentStreamEvent } from './events.js'
import {
  AfterMultiAgentInvocationEvent,
  AfterNodeCallEvent,
  BeforeMultiAgentInvocationEvent,
  BeforeNodeCallEvent,
  MultiAgentHandoffEvent,
  MultiAgentInitializedEvent,
  MultiAgentResultEvent,
  NodeCancelEvent,
  NodeResultEvent,
} from './events.js'
import { Tracer } from '../telemetry/tracer.js'
import { normalizeError } from '../errors.js'

/**
 * Runtime configuration for swarm execution.
 */
export interface SwarmConfig {
  /** Max total agent executions (including start). Defaults to `Infinity` (no limit). */
  maxSteps?: number
  /** Detection window over completed nodes. Defaults to 0; enable with `repetitiveHandoffMinUniqueAgents`. */
  repetitiveHandoffDetectionWindow?: number
  /** Required unique nodes in the detection window. Defaults to 0; enable with `repetitiveHandoffDetectionWindow`. */
  repetitiveHandoffMinUniqueAgents?: number
  /**
   * Wall-clock ceiling for the entire swarm invocation, in milliseconds. Defaults to `Infinity`
   * (no limit). Composed with each node's cancel signal, so a node that exceeds this bound
   * mid-execution will be aborted (cooperatively).
   */
  timeout?: number
  /**
   * Fallback per-node wall-clock ceiling in milliseconds. Applied to any node that doesn't
   * set its own `timeout`. Defaults to `Infinity` (no limit).
   *
   * Enforced via `AbortSignal` — cancellation is cooperative, so a tool that neither polls
   * its cancel signal nor forwards it to a cancellable API can run past this deadline.
   */
  nodeTimeout?: number
}

/**
 * Structured output each agent produces to decide the next step.
 *
 * When `agentId` is provided, the swarm hands off to that agent with
 * `message` as input. When omitted, `message` becomes the final response.
 */
interface HandoffResult {
  /** Agent id to hand off to. Omit to end the swarm and return `message` as the final response. */
  agentId?: string
  /** Instructions for the next agent, or the final response if no handoff. */
  message: string
  /** Structured data to pass to the next agent. Serialized as a JSON text block alongside the handoff message. */
  context?: Record<string, unknown>
}

/**
 * Input type for swarm nodes. Pass an {@link InvokableAgent} directly for the simple case,
 * or {@link AgentNodeOptions} for per-node config.
 */
export type SwarmNodeDefinition = InvokableAgent | AgentNodeOptions

export interface SwarmOptions extends SwarmConfig {
  /** Unique identifier. Defaults to `'swarm'`. */
  id?: string
  /** Swarm agents. Pass agents directly or use {@link AgentNodeOptions} for per-node config. */
  nodes: SwarmNodeDefinition[]
  /** Agent id that receives the initial input. Defaults to the first agent in `nodes`. */
  start?: string
  /** Session manager for saving and restoring swarm sessions. */
  sessionManager?: SessionManager
  /** Plugins for event-driven extensibility. */
  plugins?: MultiAgentPlugin[]
  /** Custom trace attributes to include on all spans. */
  traceAttributes?: Record<string, AttributeValue>
}

/**
 * Swarm multi-agent orchestration pattern.
 *
 * Agents execute sequentially, each deciding whether to hand off to another agent or
 * produce a final response. Routing is driven by structured output: each agent receives
 * a Zod schema with `agentId`, `message`, and optional `context` fields. When `agentId`
 * is present, the swarm hands off to that agent with `message` as input. When omitted,
 * `message` becomes the final response.
 *
 * Key design choices vs the Python SDK:
 * - Handoffs use structured output rather than an injected `handoff_to_agent` tool.
 *   Routing logic stays in the orchestrator, not inside tool callbacks.
 * - Context is passed as serialized JSON text blocks rather than a mutable SharedContext.
 * - A single `maxSteps` limit replaces Python's separate `max_handoffs`/`max_iterations`.
 * - Agent descriptions are embedded in the structured output schema for routing decisions.
 * - Exceeding `maxSteps` throws an exception. Python returns a FAILED result.
 * - Repetitive handoff detection follows Python's soft-stop behavior and returns a FAILED result with an error.
 *
 * @example
 * ```typescript
 * const swarm = new Swarm({
 *   nodes: [researcher, writer],
 *   start: 'researcher',
 *   maxSteps: 10,
 * })
 *
 * const result = await swarm.invoke('Explain quantum computing')
 * ```
 */
export class Swarm implements MultiAgent {
  readonly id: string
  readonly nodes: ReadonlyMap<string, AgentNode>
  readonly config: Required<SwarmConfig>
  private readonly _pluginRegistry: MultiAgentPluginRegistry
  private readonly _hookRegistry: HookRegistryImplementation
  private readonly _tracer: Tracer
  readonly start: AgentNode
  readonly sessionManager?: SessionManager | undefined
  private _initialized: boolean
  /**
   * State retained across invocations when a run ends INTERRUPTED. Lets
   * `swarm.invoke(responses)` resume on the same instance without requiring a
   * SessionManager, mirroring single-agent ergonomics. Cleared when a run
   * terminates in any non-INTERRUPTED state.
   */
  private _pendingInterruptState?: MultiAgentState

  constructor(options: SwarmOptions) {
    const { id, nodes, start, sessionManager, plugins, traceAttributes, ...config } = options

    this.id = id ?? 'swarm'

    this.config = {
      maxSteps: config.maxSteps ?? Infinity,
      repetitiveHandoffDetectionWindow: config.repetitiveHandoffDetectionWindow ?? 0,
      repetitiveHandoffMinUniqueAgents: config.repetitiveHandoffMinUniqueAgents ?? 0,
      timeout: config.timeout ?? Infinity,
      nodeTimeout: config.nodeTimeout ?? Infinity,
    }

    this.nodes = this._resolveNodes(nodes)
    this._validateConfig()

    if (this.config.maxSteps === Infinity && this.config.timeout === Infinity) {
      warnOnce(logger, 'swarm has no maxSteps or timeout set; execution is unbounded')
    }

    this.start = this._resolveStart(start)

    this.sessionManager = sessionManager

    if (sessionManager && plugins?.some((p) => p.name === sessionManager.name)) {
      throw new Error('sessionManager was provided as both a constructor argument and in the plugins array')
    }

    this._hookRegistry = new HookRegistryImplementation()
    this._pluginRegistry = new MultiAgentPluginRegistry([
      ...(plugins ?? []),
      ...(sessionManager ? [sessionManager] : []),
    ])
    this._tracer = new Tracer(traceAttributes)
    this._initialized = false
  }

  /**
   * Initialize the swarm. Invokes the {@link MultiAgentInitializedEvent} callback.
   * Called automatically on first invocation.
   */
  async initialize(): Promise<void> {
    if (this._initialized) return
    await this._pluginRegistry.initialize(this)
    await this._hookRegistry.invokeCallbacks(new MultiAgentInitializedEvent({ orchestrator: this }))
    this._initialized = true
  }

  /**
   * Register a hook callback for a specific swarm event type.
   *
   * @param eventType - The event class constructor to register the callback for
   * @param callback - The callback function to invoke when the event occurs
   * @returns Cleanup function that removes the callback when invoked
   */
  addHook<T extends HookableEvent>(eventType: HookableEventConstructor<T>, callback: HookCallback<T>): HookCleanup {
    return this._hookRegistry.addCallback(eventType, callback)
  }

  /**
   * Invoke swarm and return final result (consumes stream).
   *
   * @param input - The input to pass to the start agent
   * @param options - Optional per-invocation options (e.g., {@link InvocationState})
   * @returns Promise resolving to the final MultiAgentResult
   */
  async invoke(input: MultiAgentInput, options?: MultiAgentInvokeOptions): Promise<MultiAgentResult> {
    const gen = this.stream(input, options)
    let next = await gen.next()
    while (!next.done) {
      next = await gen.next()
    }
    return next.value
  }

  /**
   * Stream swarm execution, yielding events as agents execute.
   * Invokes hook callbacks for each event before yielding.
   *
   * @param input - The input to pass to the start agent
   * @param options - Optional per-invocation options (e.g., {@link InvocationState})
   * @returns Async generator yielding streaming events and returning a MultiAgentResult
   */
  async *stream(
    input: MultiAgentInput,
    options?: MultiAgentInvokeOptions
  ): AsyncGenerator<MultiAgentStreamEvent, MultiAgentResult, undefined> {
    await this.initialize()

    // Shared by reference across every node so mutations in one node's agent
    // are visible to the next.
    const invocationState: InvocationState = options?.invocationState ?? {}

    // Hook invocation lives in `_stream` so hook-raised `InterruptError`s land in the
    // same frame as the execution loop.
    const gen = this._stream(input, invocationState, options?.cancelSignal)
    let next = await gen.next()
    while (!next.done) {
      yield next.value
      next = await gen.next()
    }
    return next.value
  }

  private async *_stream(
    input: MultiAgentInput,
    invocationState: InvocationState,
    externalCancelSignal?: AbortSignal
  ): AsyncGenerator<MultiAgentStreamEvent, MultiAgentResult, undefined> {
    // Reuse state from a prior INTERRUPTED run so `swarm.invoke(responses)` can
    // resume on the same instance without a SessionManager.
    const state =
      this._pendingInterruptState ??
      new MultiAgentState({
        nodeIds: [...this.nodes.keys()],
      })
    delete this._pendingInterruptState

    const multiAgentSpan = this._tracer.startMultiAgentSpan({
      orchestratorId: this.id,
      orchestratorType: 'swarm',
      input,
    })

    // SessionManager (or plugins) may restore state.results here via the hook
    yield* this._emit(new BeforeMultiAgentInvocationEvent({ orchestrator: this, state, invocationState }))

    // Resume input bypasses handoff-derived resume (goes straight to the interrupted
    // node). On fresh runs, stash the input for replay if a hook-gate pauses before
    // the node runs.
    const resumeResponses = extractResumeResponses(input)
    const interruptResponsesByNode = resumeResponses ? groupInterruptResponsesByNode(resumeResponses, state) : undefined
    if (!resumeResponses) {
      state._pendingInput = input
    }

    let node: AgentNode
    let handoff: HandoffResult | undefined
    let nextInput: MultiAgentInput = input
    if (interruptResponsesByNode) {
      // Swarm runs sequentially, so at most one node can be INTERRUPTED per run.
      // Assert the invariant so a future change that accidentally produces multiple
      // interrupted nodes surfaces loudly rather than silently taking the first.
      if (interruptResponsesByNode.size > 1) {
        throw new Error(
          `swarm_id=<${this.id}>, interrupted_nodes=<${[...interruptResponsesByNode.keys()].join(',')}> | swarm cannot have multiple interrupted nodes simultaneously`
        )
      }
      const entry = interruptResponsesByNode.entries().next().value
      if (!entry) throw new Error(`swarm_id=<${this.id}> | no interrupt responses to route`)
      const [nodeId, responses] = entry
      const resolvedNode = this.nodes.get(nodeId)
      if (!resolvedNode) {
        throw new Error(
          `node_id=<${nodeId}>, swarm_id=<${this.id}> | resume response targets a node missing from the swarm; topology changed between save and resume?`
        )
      }
      node = resolvedNode
      const resolvedNodeState = state.node(nodeId)
      if (!resolvedNodeState) {
        throw new Error(
          `node_id=<${nodeId}>, swarm_id=<${this.id}> | routed interrupt response targets a node missing from state; topology changed between save and resume?`
        )
      }

      // Orchestrator hooks consume matching responses; leftovers go to the child
      // agent. If the hook consumed everything, replay the original invocation input.
      const forwarded = applyOrchestratorHookResponses(resolvedNodeState, responses)
      nextInput = forwarded.length > 0 ? forwarded : (state._pendingInput ?? '')
    } else {
      const resumeNode = this._findResumeNode(state)
      node = resumeNode?.node ?? this.start
      handoff = resumeNode?.lastHandoff
    }

    let caughtError: Error | undefined
    let result: MultiAgentResult | undefined
    let repetitiveHandoffReason: string | undefined
    const invocationNodeHistory: string[] = []

    // Swarm-level timeout composes with each node's signal so a hung node still gets
    // aborted. Timer starts fresh per invocation; human response time between resumes
    // is not deducted.
    const execController = Number.isFinite(this.config.timeout) ? new AbortController() : undefined
    const execTimeoutHandle = execController ? setTimeout(() => execController.abort(), this.config.timeout) : undefined

    const nodeCancelSignal =
      execController && externalCancelSignal
        ? AbortSignal.any([execController.signal, externalCancelSignal])
        : (execController?.signal ?? externalCancelSignal)

    try {
      while (state.steps < this.config.maxSteps) {
        repetitiveHandoffReason = this._checkRepetitiveHandoff(invocationNodeHistory)
        if (repetitiveHandoffReason) {
          logger.debug(`reason=<${repetitiveHandoffReason}> | stopping swarm execution`)
          break
        }

        if (execController?.signal.aborted) {
          throw new Error(`timeout=<${this.config.timeout}>, swarm_id=<${this.id}> | swarm exceeded wall-clock budget`)
        }
        if (externalCancelSignal?.aborted) {
          throw new Error(`swarm_id=<${this.id}> | swarm cancelled by external signal`)
        }
        state.steps++

        // After the first step (which may use routed resume responses), revert to the
        // original input so post-handoff nodes see fresh content.
        const nodeResult = yield* this._streamNode(
          node,
          nextInput,
          state,
          handoff,
          multiAgentSpan,
          invocationState,
          nodeCancelSignal
        )
        nextInput = input
        handoff = nodeResult.structuredOutput as HandoffResult | undefined
        if (nodeResult.status === Status.COMPLETED) {
          invocationNodeHistory.push(nodeResult.nodeId)
        }

        if (execController?.signal.aborted) {
          throw new Error(
            `timeout=<${this.config.timeout}>, swarm_id=<${this.id}>, node_id=<${node.id}> | swarm exceeded wall-clock budget during node execution`
          )
        }

        // Check for terminal conditions
        if (nodeResult.status === Status.FAILED || nodeResult.status === Status.INTERRUPTED || !handoff?.agentId) {
          break
        }

        // Hand off to next agent
        const target = this.nodes.get(handoff.agentId)!
        yield* this._emit(new MultiAgentHandoffEvent({ source: node.id, targets: [target.id], state, invocationState }))
        logger.debug(`source=<${node.id}>, target=<${target.id}> | swarm handoff`)
        node = target
      }

      this._checkSteps(state, handoff)

      result = new MultiAgentResult({
        ...(repetitiveHandoffReason && { status: Status.FAILED, error: new Error(repetitiveHandoffReason) }),
        results: state.results,
        content: this._resolveContent(state),
        duration: Date.now() - state.startTime,
      })
      // Stash on interrupt so same-instance resume has state; otherwise start fresh.
      if (result.status === Status.INTERRUPTED) {
        this._pendingInterruptState = state
      } else {
        delete this._pendingInterruptState
        delete state._pendingInput
      }
    } catch (error) {
      caughtError = normalizeError(error)
      throw caughtError
    } finally {
      if (execTimeoutHandle !== undefined) clearTimeout(execTimeoutHandle)
      this._tracer.endMultiAgentSpan(multiAgentSpan, {
        duration: Date.now() - state.startTime,
        ...(result && { usage: result.usage, status: result.status }),
        ...(caughtError && { error: caughtError }),
      })

      yield* this._emit(new AfterMultiAgentInvocationEvent({ orchestrator: this, state, invocationState }))
    }

    yield* this._emit(new MultiAgentResultEvent({ result, invocationState }))
    return result
  }

  /** Invokes hook callbacks on an event, then yields it. */
  private async *_emit<T extends HookableEvent>(event: T): AsyncGenerator<T, void, undefined> {
    await this._hookRegistry.invokeCallbacks(event)
    yield event
  }

  private async *_streamNode(
    node: AgentNode,
    input: MultiAgentInput,
    state: MultiAgentState,
    handoff: HandoffResult | undefined,
    multiAgentSpan: Span | null,
    invocationState: InvocationState,
    executionSignal?: AbortSignal
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResult, undefined> {
    const nodeState = state.node(node.id)!
    const handoffSchema = this._buildHandoffSchema(node.id)
    const nodeSpan = this._tracer.withSpanContext(multiAgentSpan, () =>
      this._tracer.startNodeSpan({ nodeId: node.id, nodeType: node.type })
    )

    const beforeEvent = new BeforeNodeCallEvent({ orchestrator: this, state, nodeId: node.id, invocationState })
    try {
      await this._hookRegistry.invokeCallbacks(beforeEvent)
    } catch (error) {
      if (error instanceof InterruptError) {
        const result = recordHookInterrupt(node.id, nodeState)
        state.results.push(result)
        yield beforeEvent
        yield* this._emit(new NodeResultEvent({ nodeId: node.id, nodeType: node.type, state, result, invocationState }))
        yield* this._emit(new AfterNodeCallEvent({ orchestrator: this, state, nodeId: node.id, invocationState }))
        this._tracer.endNodeSpan(nodeSpan, { status: Status.INTERRUPTED, duration: result.duration })
        return result
      }
      throw error
    }
    yield beforeEvent

    if (beforeEvent.cancel) {
      const message = typeof beforeEvent.cancel === 'string' ? beforeEvent.cancel : 'node cancelled by hook'
      // Cancel path doesn't go through Node.stream, so do its INTERRUPTED cleanup here.
      dropStaleInterruptedResult(node.id, nodeState, state)
      const result = new NodeResult({ nodeId: node.id, status: Status.CANCELLED, duration: 0 })
      nodeState.status = Status.CANCELLED
      nodeState.results.push(result)
      state.results.push(result)
      yield* this._emit(new NodeCancelEvent({ nodeId: node.id, state, message, invocationState }))
      yield* this._emit(new AfterNodeCallEvent({ orchestrator: this, state, nodeId: node.id, invocationState }))
      this._tracer.endNodeSpan(nodeSpan, { status: Status.CANCELLED, duration: 0 })
      return result
    }

    const nodeInput = this._resolveNodeInput(input, handoff)

    const nodeTimeout = node.timeout ?? this.config.nodeTimeout
    const timeoutController = Number.isFinite(nodeTimeout) ? new AbortController() : undefined
    const timeoutHandle = timeoutController ? setTimeout(() => timeoutController.abort(), nodeTimeout) : undefined
    const signals = [executionSignal, timeoutController?.signal].filter((s): s is AbortSignal => s !== undefined)
    const cancelSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined

    try {
      const gen = this._tracer.withSpanContext(nodeSpan, () =>
        node.stream(nodeInput, state, {
          structuredOutputSchema: handoffSchema,
          invocationState,
          ...(cancelSignal && { cancelSignal }),
        })
      )
      let next = await this._tracer.withSpanContext(nodeSpan, () => gen.next())
      while (!next.done) {
        if (next.value instanceof HookableEvent) {
          yield* this._emit(next.value)
        } else {
          yield next.value
        }
        next = await this._tracer.withSpanContext(nodeSpan, () => gen.next())
      }

      if (timeoutController?.signal.aborted) {
        throw new Error(
          `node_timeout=<${nodeTimeout}>, node_id=<${node.id}>, swarm_id=<${this.id}> | node exceeded wall-clock budget`
        )
      }

      const result = next.value
      this._tracer.endNodeSpan(nodeSpan, {
        status: result.status,
        duration: result.duration,
        usage: result.usage,
        ...(result.status === Status.FAILED && result.error ? { error: result.error } : {}),
      })
      state.results.push(result)

      yield* this._emit(new AfterNodeCallEvent({ orchestrator: this, state, nodeId: node.id, invocationState }))
      return result
    } catch (error) {
      const nodeError = normalizeError(error)
      this._tracer.endNodeSpan(nodeSpan, { error: nodeError })

      yield* this._emit(
        new AfterNodeCallEvent({ orchestrator: this, state, nodeId: node.id, invocationState, error: nodeError })
      )
      throw nodeError
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    }
  }

  private _validateConfig(): void {
    if (this.config.maxSteps < 1) {
      throw new Error(`max_steps=<${this.config.maxSteps}> | must be at least 1`)
    }
    if (this.config.timeout < 1) {
      throw new Error(`timeout=<${this.config.timeout}> | must be at least 1`)
    }
    if (this.config.nodeTimeout < 1) {
      throw new Error(`node_timeout=<${this.config.nodeTimeout}> | must be at least 1`)
    }

    this._validateRepetitiveHandoffConfig()
  }

  /**
   * Validates the repetitive-handoff detection pair. Both settings must be 0
   * (disabled) or both positive, and the uniqueness threshold must fit within
   * both the detection window and the number of nodes in the swarm.
   */
  private _validateRepetitiveHandoffConfig(): void {
    const window = this.config.repetitiveHandoffDetectionWindow
    const minimumUniqueAgents = this.config.repetitiveHandoffMinUniqueAgents
    if (!Number.isInteger(window) || window < 0) {
      throw new Error(`repetitive_handoff_detection_window=<${window}> | must be a non-negative integer`)
    }
    if (!Number.isInteger(minimumUniqueAgents) || minimumUniqueAgents < 0) {
      throw new Error(`repetitive_handoff_min_unique_agents=<${minimumUniqueAgents}> | must be a non-negative integer`)
    }
    if ((window === 0) !== (minimumUniqueAgents === 0)) {
      throw new Error(
        `repetitive_handoff_detection_window=<${window}>, repetitive_handoff_min_unique_agents=<${minimumUniqueAgents}> | must both be 0 or both be positive`
      )
    }
    if (minimumUniqueAgents > window) {
      throw new Error(
        `repetitive_handoff_min_unique_agents=<${minimumUniqueAgents}>, repetitive_handoff_detection_window=<${window}> | minimum unique agents cannot exceed detection window`
      )
    }
    if (minimumUniqueAgents > this.nodes.size) {
      throw new Error(
        `repetitive_handoff_min_unique_agents=<${minimumUniqueAgents}>, nodes=<${this.nodes.size}> | minimum unique agents cannot exceed node count`
      )
    }
  }

  private _resolveNodes(definitions: SwarmNodeDefinition[]): Map<string, AgentNode> {
    if (definitions.length === 0) {
      throw new Error('nodes list is empty')
    }

    const nodes = new Map<string, AgentNode>()
    for (const definition of definitions) {
      const node = 'agent' in definition ? new AgentNode(definition) : new AgentNode({ agent: definition })
      if (nodes.has(node.id)) {
        throw new Error(`agent_id=<${node.id}> | duplicate agent id`)
      }
      nodes.set(node.id, node)
    }
    return nodes
  }

  private _resolveStart(start: string | undefined): AgentNode {
    if (start === undefined) {
      return this.nodes.values().next().value!
    }

    const node = this.nodes.get(start)
    if (!node) {
      throw new Error(`start=<${start}> | start references unknown agent`)
    }
    return node
  }

  private _resolveContent(state: MultiAgentState): ContentBlock[] {
    const last = state.results[state.results.length - 1]!
    state.node(last.nodeId)!.terminus = true

    const handoff = last.structuredOutput as HandoffResult | undefined
    if (handoff?.message) {
      return [new TextBlock(handoff.message)]
    }

    return [...last.content]
  }

  /**
   * Builds the input for the next node after a handoff, or returns the input as-is
   * when there is no handoff (initial or resume invocation). The caller passes the
   * original `MultiAgentInput` through; resume responses flow through here untouched
   * so the underlying agent sees them directly.
   */
  private _resolveNodeInput(input: MultiAgentInput, handoff?: HandoffResult): MultiAgentInput {
    if (!handoff) return input

    const blocks: ContentBlock[] = [new TextBlock(handoff.message)]
    if (handoff.context) {
      blocks.push(new TextBlock('Context:\n' + JSON.stringify(handoff.context, null, 2)))
    }
    return blocks
  }

  /**
   * Checks whether the swarm has exceeded its step limit with work still pending.
   *
   * This is only an error when the loop exhausted its step budget while the last agent
   * still requested a handoff (i.e. there was more work to do). If the swarm completed
   * normally on its final allowed step (no pending handoff), no error is thrown.
   *
   * @param state - Current swarm execution state
   * @param handoff - The last handoff result from the most recent agent execution
   * @throws Error when step limit is reached with a pending handoff
   */
  private _checkSteps(state: MultiAgentState, handoff?: HandoffResult): void {
    if (handoff?.agentId && state.steps >= this.config.maxSteps) {
      throw new Error(`max_steps=<${this.config.maxSteps}> | swarm reached step limit`)
    }
  }

  /**
   * Checks node executions from the current invocation for a handoff loop.
   *
   * @param nodeHistory - Completed node ids from the current invocation
   * @returns A diagnostic reason when the configured uniqueness threshold is not met.
   */
  private _checkRepetitiveHandoff(nodeHistory: string[]): string | undefined {
    const window = this.config.repetitiveHandoffDetectionWindow
    if (window <= 0 || nodeHistory.length < window) return undefined

    const recentNodeIds = nodeHistory.slice(-window)
    const uniqueNodes = new Set(recentNodeIds).size
    if (uniqueNodes < this.config.repetitiveHandoffMinUniqueAgents) {
      return `Repetitive handoff: ${uniqueNodes} unique nodes out of ${window} recent iterations`
    }

    return undefined
  }

  /**
   * Finds the next node to execute from a restored {@link MultiAgentState}.
   *
   * When the session manager restores state from a snapshot, `state.results`
   * contains results from the previous invocation in completion order. The last
   * result's structured output contains the handoff decision — if it has an
   * `agentId`, that is the node the previous run intended to hand off to but
   * never executed (e.g. due to a crash). We resume from that handoff target.
   *
   * If the last result has no `agentId`, the previous run completed normally
   * and there is nothing to resume.
   *
   * @returns The handoff target node and its handoff context, or `undefined` for a fresh start
   */
  private _findResumeNode(state: MultiAgentState): { node: AgentNode; lastHandoff: HandoffResult } | undefined {
    const lastResult = state.results[state.results.length - 1]
    if (!lastResult) return undefined

    const lastNodeHandoff = lastResult.structuredOutput as HandoffResult | undefined
    if (!lastNodeHandoff?.agentId) return undefined

    const nextNode = this.nodes.get(lastNodeHandoff.agentId)
    if (!nextNode) {
      logger.warn(`node_id=<${lastNodeHandoff.agentId}> | resume target not found in swarm, starting fresh`)
      return undefined
    }

    logger.debug(`node_id=<${nextNode.id}>, prior_steps=<${state.steps}> | resuming swarm from restored state`)
    return { node: nextNode, lastHandoff: lastNodeHandoff }
  }

  private _buildHandoffSchema(nodeId: string): z.ZodType<HandoffResult> {
    const handoffIds = [...this.nodes.keys()].filter((id) => id !== nodeId)
    const handoffDescriptions = handoffIds
      .map((id) => {
        const desc = this.nodes.get(id)!.config.description
        return desc ? `- ${id}: ${desc}` : `- ${id}`
      })
      .join('\n')

    return z
      .object({
        agentId:
          handoffIds.length > 0
            ? z
                .enum(handoffIds as [string, ...string[]])
                .optional()
                .describe(
                  `Target agent to hand off to. Omit to end the conversation.\n\nAvailable agents:\n${handoffDescriptions}`
                )
            : z.never().optional().describe('No other agents available. Omit this field to end the conversation.'),
        message: z.string().describe('Instructions for the next agent, or the final response if no handoff.'),
        context: z.record(z.string(), z.unknown()).optional().describe('Structured data to pass to the next agent.'),
      })
      .describe('Decide whether to hand off to another agent or produce a final response.') as z.ZodType<HandoffResult>
  }
}
