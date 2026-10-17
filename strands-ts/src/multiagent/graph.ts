import type { AttributeValue } from '@opentelemetry/api'
import type { InvocationState, InvokableAgent } from '../types/agent.js'
import type { MultiAgentContentInput, MultiAgentInput, MultiAgentInvokeOptions } from './multiagent.js'
import {
  applyOrchestratorHookResponses,
  dropStaleInterruptedResult,
  extractResumeResponses,
  groupInterruptResponsesByNode,
  recordHookInterrupt,
} from './multiagent.js'
import type { ContentBlock } from '../types/messages.js'
import { TextBlock, contentBlockFromData } from '../types/messages.js'
import type { InterruptResponseContent } from '../types/interrupt.js'
import { InterruptError } from '../interrupt.js'
import { logger } from '../logging/logger.js'
import { warnOnce } from '../logging/warn-once.js'
import { HookableEvent } from '../hooks/events.js'
import { HookRegistryImplementation } from '../hooks/registry.js'
import type { HookCallback, HookableEventConstructor, HookCleanup } from '../hooks/types.js'
import type { MultiAgentPlugin } from './plugins.js'
import type { SessionManager } from '../session/session-manager.js'
import { MultiAgentPluginRegistry } from './plugins.js'
import type { NodeDefinition } from './nodes.js'
import { AgentNode, MultiAgentNode, Node } from './nodes.js'
import { MultiAgentState, MultiAgentResult, NodeResult, Status } from './state.js'
import type { MultiAgent } from './multiagent.js'
import { Swarm } from './swarm.js'
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
import type { EdgeDefinition } from './edge.js'
import { Edge } from './edge.js'
import { Queue } from '../queue.js'
import { Tracer } from '../telemetry/tracer.js'
import type { Span } from '@opentelemetry/api'
import { normalizeError } from '../errors.js'

/**
 * Data produced by a running node: a streaming event, a completion signal, or an error.
 */
type NodeExecutionOutput =
  | { type: 'event'; node: Node; event: MultiAgentStreamEvent }
  | { type: 'result'; node: Node; result: NodeResult }
  | { type: 'error'; node: Node; error: Error }

/**
 * Runtime configuration for graph execution.
 */
export interface GraphConfig {
  /** Max nodes executing in parallel. Defaults to `Infinity` (no limit). */
  maxConcurrency?: number
  /** Max total steps (prevents infinite loops in cyclic graphs). Defaults to `Infinity` (no limit). */
  maxSteps?: number
  /**
   * Wall-clock ceiling for the entire graph invocation, in milliseconds. Defaults to `Infinity`
   * (no limit).
   *
   * Does not propagate into nested orchestrators wrapped via `MultiAgentNode` — a nested
   * `Swarm`/`Graph` runs to completion under its own timeout config; the parent graph's
   * timeout only fires once the nested node returns.
   */
  timeout?: number
  /**
   * Fallback per-node wall-clock ceiling in milliseconds. Applied to any `AgentNode` that
   * doesn't set its own `timeout`. Defaults to `Infinity` (no limit).
   *
   * Does not apply to `MultiAgentNode`. Set `timeout`/`nodeTimeout` on the nested
   * orchestrator to bound it.
   *
   * Enforced via `AbortSignal` — cancellation is cooperative, so a tool that neither polls
   * its cancel signal nor forwards it to a cancellable API can run past this deadline.
   */
  nodeTimeout?: number
}

/**
 * Options for creating a Graph instance.
 */
export interface GraphOptions extends GraphConfig {
  /** Unique identifier for this graph. Defaults to `'graph'`. */
  id?: string
  /** Node definitions to construct the graph from. */
  nodes: NodeDefinition[]
  /** Edge definitions describing connections between nodes. */
  edges: EdgeDefinition[]
  /** Explicit source node IDs. If omitted, auto-detected from nodes with no incoming edges. */
  sources?: string[]
  /** Session manager for saving and restoring graph sessions. */
  sessionManager?: SessionManager
  /** Plugins for event-driven extensibility. */
  plugins?: MultiAgentPlugin[]
  /** Custom trace attributes to include on all spans. */
  traceAttributes?: Record<string, AttributeValue>
}

/**
 * Directed graph orchestration pattern.
 *
 * Agents execute as nodes in a dependency graph, with edges defining execution order
 * and optional conditions controlling routing. Source nodes (those with no incoming edges)
 * run first, and downstream nodes execute once all their dependencies complete. Parallel
 * execution is supported up to a configurable concurrency limit.
 *
 * Key design choices vs the Python SDK:
 * - Construction uses a declarative options object rather than a mutable GraphBuilder.
 *   Nodes and edges are passed directly to the constructor.
 * - Dependency resolution uses AND semantics: a node runs only when all incoming edges
 *   are satisfied. Python uses OR semantics, firing a node when any single incoming
 *   edge from the completed batch is satisfied.
 * - Nodes are launched individually as they become ready (up to maxConcurrency). Python
 *   executes in discrete batches, waiting for the entire batch to complete before
 *   scheduling the next set of nodes.
 * - Agent nodes are stateless by default (snapshot/restore on each execution). Python
 *   accumulates agent state across executions unless `reset_on_revisit` is enabled.
 * - Node failures produce a FAILED result, allowing parallel paths to continue.
 *   MultiAgent-level limits (maxSteps) throw exceptions. Python does the inverse:
 *   node failures throw exceptions (fail-fast), while limit violations return a
 *   FAILED result.
 *
 * @example
 * ```typescript
 * const graph = new Graph({
 *   nodes: [researcher, writer],
 *   edges: [['researcher', 'writer']],
 * })
 *
 * const result = await graph.invoke('Explain quantum computing')
 * ```
 */
export class Graph implements MultiAgent {
  readonly id: string
  readonly nodes: ReadonlyMap<string, Node>
  readonly edges: readonly Edge[]
  readonly config: Required<GraphConfig>
  private readonly _pluginRegistry: MultiAgentPluginRegistry
  private readonly _hookRegistry: HookRegistryImplementation
  private readonly _sources: Node[]
  /** Whether the topology can ever run two nodes in parallel. Gates per-node printer buffering. */
  private readonly _canRunConcurrently: boolean
  private readonly _tracer: Tracer
  readonly sessionManager?: SessionManager | undefined
  private _initialized: boolean
  /**
   * State retained across invocations when a run ends INTERRUPTED. Lets
   * `graph.invoke(responses)` resume on the same instance without requiring a
   * SessionManager, mirroring single-agent ergonomics. Cleared when a run
   * terminates in any non-INTERRUPTED state.
   */
  private _pendingInterruptState?: MultiAgentState

  constructor(options: GraphOptions) {
    const { id, nodes, edges, sources, sessionManager, plugins, traceAttributes, ...config } = options

    this.id = id ?? 'graph'

    this.config = {
      maxConcurrency: config.maxConcurrency ?? Infinity,
      maxSteps: config.maxSteps ?? Infinity,
      timeout: config.timeout ?? Infinity,
      nodeTimeout: config.nodeTimeout ?? Infinity,
    }
    this._validateConfig()

    if (this.config.maxSteps === Infinity && this.config.timeout === Infinity) {
      warnOnce(logger, 'graph has no maxSteps or timeout set; execution is unbounded')
    }

    this.nodes = this._resolveNodes(nodes)
    this.edges = this._resolveEdges(edges)
    this._sources = this._resolveSources(sources)
    this._validateSources()
    this._canRunConcurrently = this._computeCanRunConcurrently()

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
   * Initialize the graph. Invokes the {@link MultiAgentInitializedEvent} callback.
   * Called automatically on first invocation.
   */
  async initialize(): Promise<void> {
    if (this._initialized) return
    await this._pluginRegistry.initialize(this)
    await this._hookRegistry.invokeCallbacks(new MultiAgentInitializedEvent({ orchestrator: this }))
    this._initialized = true
  }

  /**
   * Invoke graph and return final result (consumes stream).
   *
   * @param input - The input to pass to entry point nodes
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
   * Register a hook callback for a specific graph event type.
   *
   * @param eventType - The event class constructor to register the callback for
   * @param callback - The callback function to invoke when the event occurs
   * @returns Cleanup function that removes the callback when invoked
   */
  addHook<T extends HookableEvent>(eventType: HookableEventConstructor<T>, callback: HookCallback<T>): HookCleanup {
    return this._hookRegistry.addCallback(eventType, callback)
  }

  /**
   * Stream graph execution, yielding events as nodes execute.
   * Invokes hook callbacks for each event before yielding.
   *
   * @param input - The input to pass to entry nodes
   * @param options - Optional per-invocation options (e.g., {@link InvocationState})
   * @returns Async generator yielding streaming events and returning a MultiAgentResult
   */
  async *stream(
    input: MultiAgentInput,
    options?: MultiAgentInvokeOptions
  ): AsyncGenerator<MultiAgentStreamEvent, MultiAgentResult, undefined> {
    await this.initialize()

    // Resolve invocationState once; the same object is threaded to every node's
    // child agent so mutations in one node are visible in the next.
    const invocationState: InvocationState = options?.invocationState ?? {}

    // Hook invocation lives in `_stream` so hook-raised `InterruptError`s land in the
    // same frame as the execution loop.
    const gen = this._stream(input, invocationState, options?.cancelSignal)
    try {
      let next = await gen.next()
      while (!next.done) {
        yield next.value
        next = await gen.next()
      }
      return next.value
    } finally {
      await gen.return(undefined as never)
    }
  }

  private async *_stream(
    input: MultiAgentInput,
    invocationState: InvocationState,
    externalCancelSignal?: AbortSignal
  ): AsyncGenerator<MultiAgentStreamEvent, MultiAgentResult, undefined> {
    // Reuse state from a prior INTERRUPTED run so `graph.invoke(responses)` can
    // resume on the same instance without a SessionManager.
    const state = this._pendingInterruptState ?? new MultiAgentState({ nodeIds: [...this.nodes.keys()] })
    delete this._pendingInterruptState

    const queue = new Queue<NodeExecutionOutput>()
    const streams = new Map<string, Promise<void>>()

    const multiAgentSpan = this._tracer.startMultiAgentSpan({
      orchestratorId: this.id,
      orchestratorType: 'graph',
      input,
    })

    // SessionManager (or plugins) may restore state.results here via the hook
    yield* this._emit(new BeforeMultiAgentInvocationEvent({ orchestrator: this, state, invocationState }))

    // Resume input bypasses dependency resolution (routed by interrupt id). On fresh
    // runs, stash the input so resume can replay it to hook-gated nodes that never ran.
    //
    // Example: Source node A has a `BeforeNodeCallEvent` hook that interrupts. The user
    // calls `graph.invoke('original task')`, the hook fires before A executes, the run
    // pauses with status INTERRUPTED. On resume, `graph.invoke([response])` only carries
    // the response — A still needs `'original task'` as its input because A never ran
    // and has no snapshot or upstream results to fall back on. `state._pendingInput`
    // carries `'original task'` across the pause so resume can replay it.
    const resumeResponses = extractResumeResponses(input)
    const interruptResponsesByNode = resumeResponses ? groupInterruptResponsesByNode(resumeResponses, state) : undefined
    let contentInput: MultiAgentContentInput | undefined
    if (resumeResponses) {
      contentInput = state._pendingInput as MultiAgentContentInput | undefined
    } else {
      contentInput = input as MultiAgentContentInput
      state._pendingInput = contentInput
    }

    const targets = interruptResponsesByNode
      ? [...interruptResponsesByNode.keys()].map((id) => {
          const node = this.nodes.get(id)
          if (!node) {
            throw new Error(
              `node_id=<${id}>, graph_id=<${this.id}> | resume response targets a node missing from the graph; topology changed between save and resume?`
            )
          }
          return node
        })
      : ((await this._findResumeTargets(state)) ?? [...this._sources])

    // Wall-clock timeout for the whole graph invocation. External cancellation is kept
    // on its own signal so the loop's abort checks below can distinguish the two causes
    // and produce the right error message.
    const execController = new AbortController()
    const execTimeoutHandle = Number.isFinite(this.config.timeout)
      ? setTimeout(() => execController.abort(), this.config.timeout)
      : undefined

    const cancelSignal = externalCancelSignal
      ? AbortSignal.any([execController.signal, externalCancelSignal])
      : execController.signal

    let interrupted = false
    let caughtError: Error | undefined
    let result: MultiAgentResult | undefined
    try {
      while (targets.length > 0 || streams.size > 0) {
        if (execTimeoutHandle !== undefined && execController.signal.aborted) {
          throw new Error(`timeout=<${this.config.timeout}>, graph_id=<${this.id}> | graph exceeded wall-clock budget`)
        }
        if (externalCancelSignal?.aborted) {
          throw new Error(`graph_id=<${this.id}> | graph cancelled by external signal`)
        }
        while (!interrupted && targets.length > 0 && streams.size < this.config.maxConcurrency) {
          const node = targets.shift()!

          this._checkSteps(state)
          state.steps++

          // Resolve input first so `applyOrchestratorHookResponses` has populated the
          // stored `Interrupt.response` entries before the BeforeNodeCall hook reads them.
          const nodeInput = this._resolveInputForScheduling(
            node,
            interruptResponsesByNode?.get(node.id),
            contentInput,
            state
          )

          const nodeSpan = this._tracer.withSpanContext(multiAgentSpan, () =>
            this._tracer.startNodeSpan({ nodeId: node.id, nodeType: node.type })
          )

          const preResult = yield* this._runBeforeNodeCall(node, nodeSpan, state, invocationState)
          if (preResult !== undefined) {
            // Hook gated the node before it could run; surface the synthetic result
            // through the queue so the main loop handles short-circuit and downstream
            // scheduling uniformly with normal node results.
            queue.push({ type: 'result', node, result: preResult })
            continue
          }

          streams.set(node.id, this._streamNode(node, nodeInput, state, queue, nodeSpan, invocationState, cancelSignal))
        }

        await queue.wait()
        while (queue.size > 0) {
          const { data, ack } = queue.shift()!

          if (data.type === 'event') {
            await this._hookRegistry.invokeCallbacks(data.event)
            yield data.event
            ack()
            continue
          }

          if (data.type === 'error') {
            streams.delete(data.node.id)
            ack()
            throw data.error
          }

          const { node, result: nodeResult } = data
          streams.delete(node.id)
          ack()

          state.results.push(nodeResult)

          if (interrupted) continue

          // Stop scheduling new nodes once any node has interrupted; in-flight siblings
          // run to completion on their own.
          if (nodeResult.status === Status.INTERRUPTED) {
            interrupted = true
            continue
          }

          const ready = await this._findReady(node, state, streams, targets)
          if (ready.length > 0) {
            yield* this._emit(
              new MultiAgentHandoffEvent({
                source: node.id,
                targets: ready.map((n) => n.id),
                state,
                invocationState,
              })
            )
            targets.push(...ready)
          }
        }
      }

      result = new MultiAgentResult({
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
      queue.dispose()
      await Promise.allSettled(streams.values())

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

  /**
   * Invokes hook callbacks on an event, then yields it.
   */
  private async *_emit<T extends HookableEvent>(event: T): AsyncGenerator<T, void, undefined> {
    await this._hookRegistry.invokeCallbacks(event)
    yield event
  }

  /**
   * Fires `BeforeNodeCallEvent` and handles hook-raised interrupts or cancels inline.
   * Returns a synthetic NodeResult (INTERRUPTED or CANCELLED) when a hook gates the
   * node, in which case the caller skips `_streamNode` and surfaces the result directly.
   * Returns `undefined` when no hook gated the node and execution should proceed.
   *
   * Owns the `nodeSpan` on gated paths — `_streamNode` owns it on the ungated path.
   * Yields the `NodeResultEvent` + `AfterNodeCallEvent` lifecycle pair on gated paths
   * so observers see the same event sequence regardless of how the node terminated.
   */
  private async *_runBeforeNodeCall(
    node: Node,
    nodeSpan: Span | null,
    state: MultiAgentState,
    invocationState: InvocationState
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResult | undefined, undefined> {
    const nodeState = state.node(node.id)!
    const beforeEvent = new BeforeNodeCallEvent({ orchestrator: this, state, nodeId: node.id, invocationState })
    try {
      await this._hookRegistry.invokeCallbacks(beforeEvent)
    } catch (error) {
      if (error instanceof InterruptError) {
        const result = recordHookInterrupt(node.id, nodeState)
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
      yield* this._emit(new NodeCancelEvent({ nodeId: node.id, state, message, invocationState }))
      yield* this._emit(new AfterNodeCallEvent({ orchestrator: this, state, nodeId: node.id, invocationState }))
      this._tracer.endNodeSpan(nodeSpan, { status: Status.CANCELLED, duration: 0 })
      return result
    }

    return undefined
  }

  /**
   * Runs a node whose `BeforeNodeCallEvent` already fired without a hook gating it
   * (interrupt or cancel are handled by `_runBeforeNodeCall` before this coroutine
   * is spawned). Takes ownership of the already-started `nodeSpan` and ends it.
   */
  private async _streamNode(
    node: Node,
    input: MultiAgentInput,
    state: MultiAgentState,
    queue: Queue<NodeExecutionOutput>,
    nodeSpan: Span | null,
    invocationState: InvocationState,
    executionSignal?: AbortSignal
  ): Promise<void> {
    // Per-node timeout only applies to AgentNode; a nested MultiAgentNode manages
    // its own node-level timeouts.
    const nodeTimeout = node instanceof AgentNode ? (node.timeout ?? this.config.nodeTimeout) : Infinity
    const nodeTimeoutController = Number.isFinite(nodeTimeout) ? new AbortController() : undefined
    const nodeTimeoutHandle = nodeTimeoutController
      ? setTimeout(() => nodeTimeoutController.abort(), nodeTimeout)
      : undefined
    const signals = [executionSignal, nodeTimeoutController?.signal].filter((s): s is AbortSignal => s !== undefined)
    const cancelSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined

    try {
      const gen = this._tracer.withSpanContext(nodeSpan, () =>
        node.stream(input, state, {
          invocationState,
          ...(cancelSignal && { cancelSignal }),
          ...(this._canRunConcurrently && { bufferOutput: true }),
        })
      )
      let next = await this._tracer.withSpanContext(nodeSpan, () => gen.next())
      while (!next.done) {
        await queue.send({ type: 'event', node, event: next.value })
        next = await this._tracer.withSpanContext(nodeSpan, () => gen.next())
      }

      if (nodeTimeoutController?.signal.aborted) {
        throw new Error(
          `node_timeout=<${nodeTimeout}>, node_id=<${node.id}>, graph_id=<${this.id}> | node exceeded wall-clock budget`
        )
      }

      const result = next.value
      this._tracer.endNodeSpan(nodeSpan, {
        status: result.status,
        duration: result.duration,
        usage: result.usage,
        ...(result.status === Status.FAILED && result.error ? { error: result.error } : {}),
      })
      queue.push({ type: 'result', node, result })

      await queue.send({
        type: 'event',
        node,
        event: new AfterNodeCallEvent({ orchestrator: this, state, nodeId: node.id, invocationState }),
      })
    } catch (error) {
      const nodeError = normalizeError(error)
      this._tracer.endNodeSpan(nodeSpan, { error: nodeError })

      await queue.send({
        type: 'event',
        node,
        event: new AfterNodeCallEvent({
          orchestrator: this,
          state,
          nodeId: node.id,
          invocationState,
          error: nodeError,
        }),
      })
      queue.push({
        type: 'error',
        node,
        error: nodeError,
      })
    } finally {
      if (nodeTimeoutHandle !== undefined) clearTimeout(nodeTimeoutHandle)
    }
  }

  private _validateConfig(): void {
    if (this.config.maxConcurrency < 1) {
      throw new Error(`max_concurrency=<${this.config.maxConcurrency}> | must be at least 1`)
    }
    if (this.config.maxSteps < 1) {
      throw new Error(`max_steps=<${this.config.maxSteps}> | must be at least 1`)
    }
    if (this.config.timeout < 1) {
      throw new Error(`timeout=<${this.config.timeout}> | must be at least 1`)
    }
    if (this.config.nodeTimeout < 1) {
      throw new Error(`node_timeout=<${this.config.nodeTimeout}> | must be at least 1`)
    }
  }

  private _validateSources(): void {
    if (this._sources.length === 0) {
      throw new Error('graph has no source nodes')
    }

    const visited = new Set<string>()
    const adjacency = new Map<string, string[]>()
    for (const edge of this.edges) {
      const targets = adjacency.get(edge.source.id) ?? []
      targets.push(edge.target.id)
      adjacency.set(edge.source.id, targets)
    }

    const queue = this._sources.map((n) => n.id)
    while (queue.length > 0) {
      const id = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      for (const target of adjacency.get(id) ?? []) {
        queue.push(target)
      }
    }

    for (const id of this.nodes.keys()) {
      if (!visited.has(id)) {
        throw new Error(`node_id=<${id}> | unreachable from any source node`)
      }
    }
  }

  private _resolveNodes(definitions: NodeDefinition[]): Map<string, Node> {
    const nodes = new Map<string, Node>()

    for (const definition of definitions) {
      let node: Node

      if (definition instanceof Node) {
        node = definition
      } else if ('orchestrator' in definition) {
        node = new MultiAgentNode(definition)
      } else if ('agent' in definition) {
        node = new AgentNode(definition)
      } else if (definition instanceof Graph || definition instanceof Swarm) {
        node = new MultiAgentNode({ orchestrator: definition })
      } else {
        node = new AgentNode({ agent: definition as InvokableAgent })
      }

      if (nodes.has(node.id)) {
        throw new Error(`node_id=<${node.id}> | duplicate node id`)
      }
      nodes.set(node.id, node)
    }

    return nodes
  }

  private _resolveEdges(definitions: EdgeDefinition[]): Edge[] {
    const edges: Edge[] = []
    for (const definition of definitions) {
      const [sourceId, targetId, handler] = Array.isArray(definition)
        ? [definition[0], definition[1], undefined]
        : [definition.source, definition.target, definition.handler]

      const source = this.nodes.get(sourceId)
      const target = this.nodes.get(targetId)
      if (!source) {
        throw new Error(`source=<${sourceId}> | edge references unknown source node`)
      }
      if (!target) {
        throw new Error(`target=<${targetId}> | edge references unknown target node`)
      }
      edges.push(new Edge({ source, target, ...(handler && { handler }) }))
    }
    return edges
  }

  private _resolveSources(sourceIds?: string[]): Node[] {
    if (sourceIds) {
      const sources: Node[] = []
      for (const id of sourceIds) {
        const node = this.nodes.get(id)
        if (!node) {
          throw new Error(`source=<${id}> | source references unknown node`)
        }
        sources.push(node)
      }
      return sources
    }

    const targetIds = new Set(this.edges.map((e) => e.target.id))
    return [...this.nodes.values()].filter((node) => !targetIds.has(node.id))
  }

  /**
   * Static check: can two nodes ever run in parallel? False when `maxConcurrency` is 1,
   * there's a single source, and no node has more than one outgoing edge.
   */
  private _computeCanRunConcurrently(): boolean {
    if (this.config.maxConcurrency < 2) return false
    if (this._sources.length > 1) return true
    const fanOut = new Map<string, number>()
    for (const e of this.edges) fanOut.set(e.source.id, (fanOut.get(e.source.id) ?? 0) + 1)
    return [...fanOut.values()].some((count) => count > 1)
  }

  /**
   * Identifies terminus nodes and returns their combined content.
   * A terminus node is where an execution path ended: completed with no
   * downstream progress, or failed/cancelled.
   */
  private _resolveContent(state: MultiAgentState): ContentBlock[] {
    for (const [id, ns] of state.nodes.entries()) {
      if (ns.status === Status.FAILED || ns.status === Status.CANCELLED) {
        ns.terminus = true
      } else if (ns.status === Status.COMPLETED) {
        ns.terminus = !this.edges
          .filter((e) => e.source.id === id)
          .some((e) => state.node(e.target.id)?.status !== Status.PENDING)
      }
    }
    return [...state.nodes.values()].filter((ns) => ns.terminus).flatMap((ns) => ns.content)
  }

  /**
   * Chooses the input for a node about to be scheduled, handling the three resume cases:
   * routed orchestrator-hook responses (forward leftovers to the agent), routed responses
   * fully consumed by the hook (replay the original invocation input), and fresh runs
   * (dependency-merged). Falls back to an empty input with a warning if a custom
   * SessionManager dropped `_pendingInput`.
   */
  private _resolveInputForScheduling(
    node: Node,
    routed: InterruptResponseContent[] | undefined,
    contentInput: MultiAgentContentInput | undefined,
    state: MultiAgentState
  ): MultiAgentInput {
    if (routed) {
      const nodeState = state.node(node.id)
      if (!nodeState) {
        throw new Error(
          `node_id=<${node.id}>, graph_id=<${this.id}> | routed interrupt response targets a node missing from state; topology changed between save and resume?`
        )
      }
      const forwarded = applyOrchestratorHookResponses(nodeState, routed)
      if (forwarded.length > 0) return forwarded
    }
    if (contentInput === undefined) {
      logger.warn(`node_id=<${node.id}>, graph_id=<${this.id}> | no pending input on resume; using empty`)
      return this._resolveNodeInput(node, '', state)
    }
    return this._resolveNodeInput(node, contentInput, state)
  }

  /**
   * Builds the input for a node by combining the original task with dependency outputs.
   *
   * Only called for non-resume executions: the caller routes resume responses directly
   * to interrupted nodes without going through dependency resolution, so this helper
   * never sees `InterruptResponseContent[]`.
   */
  private _resolveNodeInput(node: Node, input: MultiAgentContentInput, state: MultiAgentState): MultiAgentInput {
    const deps: ContentBlock[] = []
    for (const edge of this.edges.filter((e) => e.target.id === node.id)) {
      const ns = state.node(edge.source.id)!
      if (ns.content.length > 0) {
        const content = ns.content.filter((block) => block.type !== 'reasoningBlock')
        if (content.length > 0) {
          deps.push(new TextBlock(`[node: ${edge.source.id}]`), ...content)
        }
      }
    }

    if (deps.length === 0) return input

    const blocks =
      typeof input === 'string'
        ? [new TextBlock(input)]
        : input.map((b) => ('type' in b ? (b as ContentBlock) : contentBlockFromData(b)))
    return [...blocks, ...deps]
  }

  /**
   * Finds nodes that should execute on resume from a restored {@link MultiAgentState}.
   *
   * Any node that did not complete is a candidate for re-execution, provided its
   * dependencies are all COMPLETED and edge conditions are satisfied. This covers:
   * - PENDING nodes that never started
   * - EXECUTING/FAILED/CANCELLED nodes from the previous run
   * - Source nodes (no incoming edges) that are not COMPLETED
   *
   * Works for all node types including {@link AgentNode} and {@link MultiAgentNode}
   * (subgraphs/swarms). A `MultiAgentNode` that didn't complete will be re-executed
   * from scratch — its inner orchestrator manages its own state independently.
   *
   * @returns Array of ready nodes, or `undefined` if state was not restored (fresh start)
   */
  private async _findResumeTargets(state: MultiAgentState): Promise<Node[] | undefined> {
    // No completed nodes in state means fresh start (state was not restored)
    const hasCompletedNodes = [...state.nodes.values()].some((ns) => ns.status === Status.COMPLETED)
    if (!hasCompletedNodes) return undefined

    const ready: Node[] = []
    for (const [id, node] of this.nodes) {
      if (state.node(id)?.status === Status.COMPLETED) continue

      const incoming = this.edges.filter((e) => e.target.id === id)
      if (incoming.length === 0) {
        // Source node that hasn't completed
        ready.push(node)
      } else if (await this._allDependenciesSatisfied(incoming, state)) {
        ready.push(node)
      }
    }

    if (ready.length > 0) {
      logger.debug(
        `resume_targets=<${ready.map((n) => n.id).join(', ')}>, prior_steps=<${state.steps}> | resuming graph from restored state`
      )
      return ready
    }

    logger.debug('all nodes completed in restored state | starting fresh')
    return undefined
  }

  /**
   * Checks whether all incoming edges have completed sources with satisfied conditions.
   */
  private async _allDependenciesSatisfied(incoming: Edge[], state: MultiAgentState): Promise<boolean> {
    for (const edge of incoming) {
      if (state.node(edge.source.id)?.status !== Status.COMPLETED) return false
      if (!(await edge.handler(state))) return false
    }
    return true
  }

  private _checkSteps(state: MultiAgentState): void {
    if (state.steps >= this.config.maxSteps) {
      throw new Error(`steps=<${state.steps}> | max steps reached`)
    }
  }

  /**
   * Finds downstream nodes that are ready to execute after a node completes.
   * A target is ready when all its incoming edge sources are COMPLETED and all edge handlers return true.
   *
   * @param node - The node that just completed execution.
   * @param state - Current multi-agent execution state.
   * @param streams - Map of node IDs to their in-flight execution promises.
   * @param targets - Nodes already queued for execution.
   * @returns Nodes that are ready to execute.
   */
  private async _findReady(
    node: Node,
    state: MultiAgentState,
    streams: ReadonlyMap<string, Promise<void>>,
    targets: readonly Node[]
  ): Promise<Node[]> {
    if (state.node(node.id)?.status !== Status.COMPLETED) return []

    const ready: Node[] = []

    for (const edge of this.edges.filter((e) => e.source.id === node.id)) {
      // skip if the target is already running or queued
      if (streams.has(edge.target.id) || targets.some((n) => n.id === edge.target.id)) continue

      const incoming = this.edges.filter((e) => e.target.id === edge.target.id)
      if (await this._allDependenciesSatisfied(incoming, state)) {
        ready.push(edge.target)
      }
    }

    return ready
  }
}
