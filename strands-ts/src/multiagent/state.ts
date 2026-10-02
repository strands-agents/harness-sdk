import { StateStore } from '../state-store.js'
import { type ContentBlock, contentBlockFromData } from '../types/messages.js'
import type { Usage } from '../models/streaming.js'
import { accumulateUsage, createEmptyUsage } from '../models/streaming.js'
import type { z } from 'zod'
import type { JSONValue } from '../types/json.js'
import { normalizeError, serializeError } from '../errors.js'
import { Interrupt } from '../interrupt.js'
import type { MultiAgentInput } from './multiagent.js'
import type { Snapshot } from '../types/snapshot.js'
import {
  loadStateFromJSONSymbol,
  stateToJSONSymbol,
  serializeStateSerializable,
  loadStateSerializable,
  type StateSerializable,
} from '../types/serializable.js'

/**
 * Execution lifecycle status shared across all multi-agent patterns.
 */
export const Status = {
  /** Execution has not yet started. */
  PENDING: 'PENDING',
  /** Execution is currently in progress. */
  EXECUTING: 'EXECUTING',
  /** Execution finished successfully. */
  COMPLETED: 'COMPLETED',
  /** Execution encountered an error. */
  FAILED: 'FAILED',
  /** Execution was cancelled before or during processing. */
  CANCELLED: 'CANCELLED',
  /** Execution paused awaiting an interrupt response; can be resumed. */
  INTERRUPTED: 'INTERRUPTED',
} as const

/**
 * Union of all valid status values.
 */
export type Status = (typeof Status)[keyof typeof Status]

/**
 * Subset of {@link Status} valid for a {@link NodeResult}.
 */
export type ResultStatus =
  typeof Status.COMPLETED | typeof Status.FAILED | typeof Status.CANCELLED | typeof Status.INTERRUPTED

/**
 * Result of executing a single node.
 */
export class NodeResult {
  readonly type = 'nodeResult' as const
  readonly nodeId: string
  readonly status: ResultStatus
  /** Execution time in milliseconds. */
  readonly duration: number
  readonly content: ContentBlock[]
  readonly error?: Error
  /** Validated structured output, if a schema was provided. */
  readonly structuredOutput?: z.output<z.ZodType>
  /** Token usage from the node execution. */
  readonly usage?: Usage
  /** Interrupts raised by the underlying agent/orchestrator. Present iff `status === 'INTERRUPTED'`. */
  readonly interrupts?: Interrupt[]

  constructor(data: {
    nodeId: string
    status: ResultStatus
    duration: number
    content?: ContentBlock[]
    error?: Error
    structuredOutput?: z.output<z.ZodType>
    usage?: Usage
    interrupts?: Interrupt[]
  }) {
    this.nodeId = data.nodeId
    this.status = data.status
    this.duration = data.duration
    this.content = data.content ?? []
    if ('error' in data) this.error = data.error
    if ('structuredOutput' in data) this.structuredOutput = data.structuredOutput
    if ('usage' in data) this.usage = data.usage
    if (data.interrupts && data.interrupts.length > 0) this.interrupts = data.interrupts
  }

  /** Serializes this result to a JSON-compatible value. */
  toJSON(): JSONValue {
    return {
      type: this.type,
      nodeId: this.nodeId,
      status: this.status,
      duration: this.duration,
      content: this.content.map((block) => block.toJSON()),
      ...(this.error && { error: serializeError(this.error) }),
      ...(this.structuredOutput !== undefined && { structuredOutput: this.structuredOutput as JSONValue }),
      ...(this.usage && { usage: { ...this.usage } }),
      ...(this.interrupts && { interrupts: this.interrupts.map((i) => i.toJSON()) }),
    } as JSONValue
  }

  /** Creates a NodeResult from a previously serialized JSON value. */
  static fromJSON(data: JSONValue): NodeResult {
    const json = data as Record<string, JSONValue>
    return new NodeResult({
      nodeId: json.nodeId as string,
      status: json.status as ResultStatus,
      duration: json.duration as number,
      content: (json.content as JSONValue[]).map((c) => contentBlockFromData(c as never)),
      ...(json.error && { error: normalizeError(json.error) }),
      ...(json.structuredOutput !== undefined && { structuredOutput: json.structuredOutput }),
      ...(json.usage && { usage: json.usage as unknown as Usage }),
      ...(json.interrupts && {
        interrupts: (json.interrupts as JSONValue[]).map((i) => Interrupt.fromJSON(i as never)),
      }),
    })
  }
}

/**
 * Partial result returned by {@link Node.handle} implementations.
 *
 * Contains implementer-controlled fields that are merged with
 * framework-managed defaults (nodeId, status, duration, content) to
 * produce the final {@link NodeResult}.
 */
export type NodeResultUpdate = Partial<Omit<NodeResult, 'type'>>

/**
 * Execution state of a single node within a multi-agent orchestration.
 */
export class NodeState implements StateSerializable {
  readonly type = 'nodeState' as const
  status: Status
  /** Whether this node is a terminal node — one where an execution path ended. */
  terminus: boolean
  /** Node execution start time in milliseconds since epoch. */
  startTime: number
  readonly results: NodeResult[]
  /** Unanswered interrupts raised during this node's most recent run. Populated when `status === 'INTERRUPTED'`. */
  interrupts: Interrupt[]
  /**
   * Snapshot of the node's underlying runnable (Agent or nested orchestrator) captured
   * when the node returned INTERRUPTED. Loaded back into the runnable on resume so it
   * can pick up mid-execution without losing its interrupt bookkeeping. Cleared when
   * the node completes.
   */
  interruptedSnapshot?: Snapshot

  constructor() {
    this.status = Status.PENDING
    this.terminus = false
    this.startTime = Date.now()
    this.results = []
    this.interrupts = []
  }

  /** Content from the most recent result, or empty array if none. */
  get content(): readonly ContentBlock[] {
    const last = this.results[this.results.length - 1]
    return last?.content ?? []
  }

  /** Returns the serialized state as a JSON value. */
  [stateToJSONSymbol](): JSONValue {
    return {
      status: this.status,
      terminus: this.terminus,
      startTime: this.startTime,
      results: this.results.map((res) => res.toJSON()),
      interrupts: this.interrupts.map((i) => i.toJSON()),
      ...(this.interruptedSnapshot && { interruptedSnapshot: { ...this.interruptedSnapshot } }),
    } as JSONValue
  }

  /** Loads state from a previously serialized JSON value. */
  [loadStateFromJSONSymbol](json: JSONValue): void {
    const data = json as Record<string, JSONValue>
    this.status = data.status as Status
    this.terminus = data.terminus as boolean
    this.startTime = data.startTime as number
    this.results.length = 0
    for (const entry of data.results as JSONValue[]) {
      this.results.push(NodeResult.fromJSON(entry))
    }
    this.interrupts = ((data.interrupts as JSONValue[] | undefined) ?? []).map((i) => Interrupt.fromJSON(i as never))
    if (data.interruptedSnapshot) {
      this.interruptedSnapshot = data.interruptedSnapshot as unknown as Snapshot
    } else {
      delete this.interruptedSnapshot
    }
  }
}

/**
 * Aggregate result from a multi-agent execution.
 */
export class MultiAgentResult {
  readonly type = 'multiAgentResult' as const
  readonly status: ResultStatus
  readonly results: NodeResult[]
  /** Combined content from terminus nodes, in completion order. */
  readonly content: ContentBlock[]
  readonly duration: number
  readonly error?: Error
  /** Aggregated token usage across all node results. */
  readonly usage: Usage
  /** Token usage for the whole request this run took part in, including auxiliary calls; see {@link AgentResult.requestUsage}. */
  readonly requestUsage?: Usage
  /** Interrupts aggregated across all node results. Present when any node ended INTERRUPTED. */
  readonly interrupts?: Interrupt[]

  constructor(data: {
    status?: ResultStatus
    results: NodeResult[]
    content?: ContentBlock[]
    duration: number
    error?: Error
    interrupts?: Interrupt[]
    requestUsage?: Usage
  }) {
    this.status = data.status ?? this._resolveStatus(data.results)
    this.results = data.results
    this.content = data.content ?? []
    this.duration = data.duration
    if ('error' in data) this.error = data.error
    this.usage = this._aggregateNodeUsage(data.results)
    if (data.requestUsage !== undefined) this.requestUsage = data.requestUsage
    const interrupts = data.interrupts ?? data.results.flatMap((r) => r.interrupts ?? [])
    if (interrupts.length > 0) this.interrupts = interrupts
  }

  /** Serializes this result to a JSON-compatible value. */
  toJSON(): JSONValue {
    return {
      type: this.type,
      status: this.status,
      results: this.results.map((result) => result.toJSON()),
      content: this.content.map((block) => block.toJSON()),
      duration: this.duration,
      usage: { ...this.usage },
      ...(this.error && { error: serializeError(this.error) }),
      ...(this.interrupts && { interrupts: this.interrupts.map((i) => i.toJSON()) }),
    } as JSONValue
  }

  /** Creates a MultiAgentResult from a previously serialized JSON value. */
  static fromJSON(data: JSONValue): MultiAgentResult {
    const json = data as Record<string, JSONValue>
    return new MultiAgentResult({
      status: json.status as ResultStatus,
      results: (json.results as JSONValue[]).map(NodeResult.fromJSON),
      content: (json.content as JSONValue[]).map((c) => contentBlockFromData(c as never)),
      duration: json.duration as number,
      ...(json.error && { error: normalizeError(json.error) }),
      ...(json.interrupts && {
        interrupts: (json.interrupts as JSONValue[]).map((i) => Interrupt.fromJSON(i as never)),
      }),
    })
  }

  /**
   * Derives the aggregate status from individual node results.
   *
   * Precedence: FAILED \> INTERRUPTED \> CANCELLED \> COMPLETED. INTERRUPTED outranks
   * CANCELLED because parallel-graph short-circuit aborts siblings as CANCELLED when
   * one node interrupts — the actionable "resume me" signal should surface over the
   * collateral cancellations.
   */
  private _resolveStatus(results: NodeResult[]): ResultStatus {
    if (results.some((result) => result.status === Status.FAILED)) return Status.FAILED
    if (results.some((result) => result.status === Status.INTERRUPTED)) return Status.INTERRUPTED
    if (results.some((result) => result.status === Status.CANCELLED)) return Status.CANCELLED
    return Status.COMPLETED
  }

  /** Sums token usage across all node results. */
  private _aggregateNodeUsage(results: NodeResult[]): Usage {
    const usage = createEmptyUsage()
    for (const result of results) {
      if (!result.usage) continue
      accumulateUsage(usage, result.usage)
    }
    return usage
  }
}

/**
 * Rehydrates a serialized `_pendingInput` back to its runtime shape. `string` round-trips
 * as-is; array inputs (which serialize as `ContentBlockData[]` via each block's `toJSON`)
 * are mapped through `contentBlockFromData` so downstream callers see `ContentBlock[]`
 * instead of raw data objects.
 */
function rehydratePendingInput(value: JSONValue): MultiAgentInput {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return (value as JSONValue[]).map((entry) => contentBlockFromData(entry as never)) as ContentBlock[]
  }
  // Unexpected shape — pass through so callers see the exact value and can diagnose.
  return value as unknown as MultiAgentInput
}

/**
 * Per-execution state for multi-agent orchestration, created fresh each invocation.
 */
export class MultiAgentState implements StateSerializable {
  /** Execution start time in milliseconds since epoch. */
  readonly startTime: number
  /** Number of node executions started so far. */
  steps: number
  /** All node results in completion order. */
  readonly results: NodeResult[]
  /** App-level key-value state accessible from hooks, edge handlers, and custom nodes. */
  readonly app: StateStore
  /**
   * The invocation's input, carried through an interrupt pause so that resuming a
   * run (on the same instance, or via a SessionManager) can re-enter nodes that
   * never ran (hook-gated source/start nodes) with the original content. Cleared
   * when the invocation terminates in any non-INTERRUPTED state.
   *
   * @internal — not part of the public state shape; orchestrator-owned.
   */
  _pendingInput?: MultiAgentInput
  private readonly _nodes: Map<string, NodeState>

  constructor(data?: { nodeIds?: string[] }) {
    this.startTime = Date.now()
    this.steps = 0
    this.results = []
    this.app = new StateStore()
    this._nodes = new Map()
    for (const id of data?.nodeIds ?? []) {
      this._nodes.set(id, new NodeState())
    }
  }

  /**
   * Get the state of a specific node by ID.
   *
   * @param id - The node identifier
   * @returns The node's state, or undefined if the node is not tracked
   */
  node(id: string): NodeState | undefined {
    return this._nodes.get(id)
  }

  /**
   * All tracked node states.
   */
  get nodes(): ReadonlyMap<string, NodeState> {
    return this._nodes
  }

  /** Returns the serialized state as a JSON value. */
  [stateToJSONSymbol](): JSONValue {
    const nodes: Record<string, JSONValue> = {}
    for (const [id, nodeState] of this._nodes) {
      nodes[id] = serializeStateSerializable(nodeState)
    }
    return {
      startTime: this.startTime,
      steps: this.steps,
      results: this.results.map((result) => result.toJSON()),
      app: serializeStateSerializable(this.app),
      nodes,
      ...(this._pendingInput !== undefined && { _pendingInput: this._pendingInput as unknown as JSONValue }),
    } as JSONValue
  }

  /** Loads state from a previously serialized JSON value. */
  [loadStateFromJSONSymbol](json: JSONValue): void {
    const data = json as Record<string, JSONValue>
    ;(this as { startTime: number }).startTime = data.startTime as number
    this.steps = data.steps as number
    this.results.length = 0
    for (const entry of data.results as JSONValue[]) {
      this.results.push(NodeResult.fromJSON(entry))
    }
    loadStateSerializable(this.app, data.app as JSONValue)
    this._nodes.clear()
    const nodes = data.nodes as Record<string, JSONValue> | undefined
    if (nodes) {
      for (const [id, nodeData] of Object.entries(nodes)) {
        const nodeState = new NodeState()
        loadStateSerializable(nodeState, nodeData)
        this._nodes.set(id, nodeState)
      }
    }
    if (data._pendingInput !== undefined) {
      this._pendingInput = rehydratePendingInput(data._pendingInput)
    } else {
      delete this._pendingInput
    }
  }
}
