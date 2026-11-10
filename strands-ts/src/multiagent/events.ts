import { HookableEvent, StreamEvent } from '../hooks/events.js'
import type { AgentStreamEvent, InvocationState } from '../types/agent.js'
import type { MultiAgentResult, MultiAgentState, NodeResult } from './state.js'
import type { MultiAgent } from './multiagent.js'
import type { NodeType } from './nodes.js'
import type { Interruptible } from '../interrupt.js'
import { interruptFromMultiAgentNode } from '../interrupt.js'
import type { InterruptParams } from '../types/interrupt.js'
import type { JSONValue } from '../types/json.js'

/**
 * Event triggered when a multi-agent orchestrator has finished initialization.
 */
export class MultiAgentInitializedEvent extends HookableEvent {
  readonly type = 'multiAgentInitializedEvent' as const
  readonly orchestrator: MultiAgent

  constructor(data: { orchestrator: MultiAgent }) {
    super()
    this.orchestrator = data.orchestrator
  }

  toJSON(): Pick<MultiAgentInitializedEvent, 'type'> {
    return { type: this.type }
  }
}

/**
 * Event triggered before orchestrator execution starts.
 */
export class BeforeMultiAgentInvocationEvent extends HookableEvent {
  readonly type = 'beforeMultiAgentInvocationEvent' as const
  readonly orchestrator: MultiAgent
  readonly state: MultiAgentState
  readonly invocationState: InvocationState

  constructor(data: { orchestrator: MultiAgent; state: MultiAgentState; invocationState: InvocationState }) {
    super({ invocationContext: data.state.invocationContext })
    this.orchestrator = data.orchestrator
    this.state = data.state
    this.invocationState = data.invocationState
  }

  toJSON(): Pick<BeforeMultiAgentInvocationEvent, 'type'> {
    return { type: this.type }
  }
}

/**
 * Event triggered after orchestrator execution completes.
 */
export class AfterMultiAgentInvocationEvent extends HookableEvent {
  readonly type = 'afterMultiAgentInvocationEvent' as const
  readonly orchestrator: MultiAgent
  readonly state: MultiAgentState
  readonly invocationState: InvocationState

  constructor(data: { orchestrator: MultiAgent; state: MultiAgentState; invocationState: InvocationState }) {
    super({ invocationContext: data.state.invocationContext })
    this.orchestrator = data.orchestrator
    this.state = data.state
    this.invocationState = data.invocationState
  }

  override _shouldReverseCallbacks(): boolean {
    return true
  }

  toJSON(): Pick<AfterMultiAgentInvocationEvent, 'type'> {
    return { type: this.type }
  }
}

/**
 * Event triggered before a node begins execution.
 * Hook callbacks can set {@link cancel} to prevent the node from executing.
 */
export class BeforeNodeCallEvent extends HookableEvent implements Interruptible {
  readonly type = 'beforeNodeCallEvent' as const
  readonly orchestrator: MultiAgent
  readonly state: MultiAgentState
  readonly nodeId: string
  readonly invocationState: InvocationState

  /**
   * Set by hook callbacks to cancel node execution.
   * When set to `true`, a default cancel message is used.
   * When set to a string, that string is used as the cancel message.
   */
  cancel: boolean | string = false

  constructor(data: {
    orchestrator: MultiAgent
    state: MultiAgentState
    nodeId: string
    invocationState: InvocationState
  }) {
    super({ invocationContext: data.state.invocationContext })
    this.orchestrator = data.orchestrator
    this.state = data.state
    this.nodeId = data.nodeId
    this.invocationState = data.invocationState
  }

  /**
   * Raises an orchestrator-level interrupt that pauses the run before this node
   * executes. If a prior resume has answered the interrupt, returns the response;
   * otherwise throws an `InterruptError` and the orchestrator produces an
   * INTERRUPTED result with the pending interrupt.
   *
   * The interrupt is stored on the target node's `NodeState.interrupts`, so resume
   * via `InterruptResponseContent[]` routes through the same machinery as child-
   * agent interrupts.
   */
  interrupt<T = JSONValue>(params: InterruptParams): T {
    const nodeState = this.state.node(this.nodeId)
    if (!nodeState) {
      throw new Error(`node_id=<${this.nodeId}> | node state not found`)
    }
    return interruptFromMultiAgentNode<T>(
      nodeState.interrupts,
      `multiagent-hook:beforeNodeCall:${this.nodeId}:${params.name}`,
      params,
      'multiagent-hook'
    )
  }

  toJSON(): Pick<BeforeNodeCallEvent, 'type' | 'nodeId'> {
    return { type: this.type, nodeId: this.nodeId }
  }
}

/**
 * Event triggered after a node completes execution.
 */
export class AfterNodeCallEvent extends HookableEvent {
  readonly type = 'afterNodeCallEvent' as const
  readonly orchestrator: MultiAgent
  readonly state: MultiAgentState
  readonly nodeId: string
  readonly invocationState: InvocationState
  readonly error?: Error

  constructor(data: {
    orchestrator: MultiAgent
    state: MultiAgentState
    nodeId: string
    invocationState: InvocationState
    error?: Error
  }) {
    super({ invocationContext: data.state.invocationContext })
    this.orchestrator = data.orchestrator
    this.state = data.state
    this.nodeId = data.nodeId
    this.invocationState = data.invocationState
    if (data.error !== undefined) {
      this.error = data.error
    }
  }

  override _shouldReverseCallbacks(): boolean {
    return true
  }

  toJSON(): Pick<AfterNodeCallEvent, 'type' | 'nodeId'> & { error?: { message?: string } } {
    return {
      type: this.type,
      nodeId: this.nodeId,
      ...(this.error !== undefined && { error: { message: this.error.message } }),
    }
  }
}

/**
 * Tagged inner event from a node, discriminated by {@link source}.
 *
 * Use `inner.source` to determine the event origin, then `inner.event`
 * to access the underlying event and switch on its `type`.
 *
 * Sources:
 * - `'agent'` — the node wraps an {@link Agent} instance. The event is an
 *   {@link AgentStreamEvent} and can be narrowed via `event.type`.
 * - `'multiAgent'` — the node wraps a nested orchestrator (e.g. {@link Graph}
 *   or {@link Swarm}). The event is a {@link MultiAgentStreamEvent} (excluding
 *   {@link NodeStreamUpdateEvent}, which passes through directly).
 * - `'custom'` — the node wraps an {@link InvokableAgent} that is not an
 *   {@link Agent} instance (e.g. {@link A2AAgent} or a third-party implementation).
 *   The event is a {@link StreamEvent} with no further type narrowing available.
 */
export type NodeStreamUpdateInnerEvent =
  | { readonly source: 'agent'; readonly event: AgentStreamEvent }
  | { readonly source: 'multiAgent'; readonly event: Exclude<MultiAgentStreamEvent, NodeStreamUpdateEvent> }
  | { readonly source: 'custom'; readonly event: StreamEvent }

/**
 * Wraps an inner streaming event from a node with the node's identity.
 * Emitted during node execution to propagate agent-level or nested
 * multi-agent events up to the orchestration layer.
 */
export class NodeStreamUpdateEvent extends HookableEvent {
  readonly type = 'nodeStreamUpdateEvent' as const
  readonly nodeId: string
  readonly nodeType: NodeType
  readonly state: MultiAgentState
  readonly inner: NodeStreamUpdateInnerEvent
  readonly invocationState: InvocationState

  constructor(data: {
    nodeId: string
    nodeType: NodeType
    state: MultiAgentState
    inner: NodeStreamUpdateInnerEvent
    invocationState: InvocationState
  }) {
    super({ invocationContext: data.state.invocationContext })
    this.nodeId = data.nodeId
    this.nodeType = data.nodeType
    this.state = data.state
    this.inner = data.inner
    this.invocationState = data.invocationState
  }

  toJSON(): Pick<NodeStreamUpdateEvent, 'type' | 'nodeId' | 'nodeType' | 'inner'> {
    return { type: this.type, nodeId: this.nodeId, nodeType: this.nodeType, inner: this.inner }
  }
}

/**
 * Event triggered when a node finishes execution.
 * Wraps the {@link NodeResult} for the completed node.
 */
export class NodeResultEvent extends HookableEvent {
  readonly type = 'nodeResultEvent' as const
  readonly nodeId: string
  readonly nodeType: NodeType
  readonly state: MultiAgentState
  readonly result: NodeResult
  readonly invocationState: InvocationState

  constructor(data: {
    nodeId: string
    nodeType: NodeType
    state: MultiAgentState
    result: NodeResult
    invocationState: InvocationState
  }) {
    super({ invocationContext: data.state.invocationContext })
    this.nodeId = data.nodeId
    this.nodeType = data.nodeType
    this.state = data.state
    this.result = data.result
    this.invocationState = data.invocationState
  }

  toJSON(): Pick<NodeResultEvent, 'type' | 'nodeId' | 'nodeType' | 'result'> {
    return { type: this.type, nodeId: this.nodeId, nodeType: this.nodeType, result: this.result }
  }
}

/**
 * Event triggered when execution transitions between nodes.
 */
export class MultiAgentHandoffEvent extends HookableEvent {
  readonly type = 'multiAgentHandoffEvent' as const
  readonly source: string
  readonly targets: string[]
  readonly state: MultiAgentState
  readonly invocationState: InvocationState

  constructor(data: { source: string; targets: string[]; state: MultiAgentState; invocationState: InvocationState }) {
    super({ invocationContext: data.state.invocationContext })
    this.source = data.source
    this.targets = data.targets
    this.state = data.state
    this.invocationState = data.invocationState
  }

  toJSON(): Pick<MultiAgentHandoffEvent, 'type' | 'source' | 'targets'> {
    return { type: this.type, source: this.source, targets: this.targets }
  }
}

/**
 * Event triggered when a node is cancelled via {@link BeforeNodeCallEvent.cancel}.
 */
export class NodeCancelEvent extends HookableEvent {
  readonly type = 'nodeCancelEvent' as const
  readonly nodeId: string
  readonly state: MultiAgentState
  readonly message: string
  readonly invocationState: InvocationState

  constructor(data: { nodeId: string; state: MultiAgentState; message: string; invocationState: InvocationState }) {
    super({ invocationContext: data.state.invocationContext })
    this.nodeId = data.nodeId
    this.state = data.state
    this.message = data.message
    this.invocationState = data.invocationState
  }

  toJSON(): Pick<NodeCancelEvent, 'type' | 'nodeId' | 'message'> {
    return { type: this.type, nodeId: this.nodeId, message: this.message }
  }
}

/**
 * Event triggered as the final event in the multi-agent stream.
 * Wraps the {@link MultiAgentResult} containing the aggregate outcome.
 */
export class MultiAgentResultEvent extends HookableEvent {
  readonly type = 'multiAgentResultEvent' as const
  readonly result: MultiAgentResult
  readonly invocationState: InvocationState

  constructor(data: { result: MultiAgentResult; invocationState: InvocationState }) {
    super({ invocationContext: data.result.invocationContext })
    this.result = data.result
    this.invocationState = data.invocationState
  }

  toJSON(): Pick<MultiAgentResultEvent, 'type' | 'result'> {
    return { type: this.type, result: this.result }
  }
}

/**
 * Union of all multi-agent streaming events.
 */
export type MultiAgentStreamEvent =
  | BeforeMultiAgentInvocationEvent
  | AfterMultiAgentInvocationEvent
  | BeforeNodeCallEvent
  | AfterNodeCallEvent
  | NodeStreamUpdateEvent
  | NodeResultEvent
  | NodeCancelEvent
  | MultiAgentHandoffEvent
  | MultiAgentResultEvent
