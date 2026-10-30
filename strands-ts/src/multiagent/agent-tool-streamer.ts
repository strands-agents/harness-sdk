/**
 * Wrapper for streaming agents inside tool calls.
 *
 * Provides common functionality for streaming child agents inside a parent agent's tool calls. This includes
 * session persistence (via the parent agent's interrupt context), interrupt response forwarding, and terminal
 * result mapping. These features are implemented around stream calls and not within them because they require
 * knowledge of the parent agent.
 *
 * @internal
 */

import type { Agent } from '../agent/agent.js'
import { Interrupt, InterruptError, InterruptState, type InterruptStateData } from '../interrupt.js'
import { logger } from '../logging/logger.js'
import type { AgentResult } from '../types/agent.js'
import { InterruptResponseContent } from '../types/interrupt.js'
import { deepCopy, type JSONValue } from '../types/json.js'
import { LIMIT_STOP_REASONS, limitStopMessage, TextBlock, ToolResultBlock } from '../types/messages.js'
import type { ToolResultContent } from '../types/messages.js'
import { loadStateSerializable } from '../types/serializable.js'
import type { Snapshot } from '../types/snapshot.js'
import type { Graph } from './graph.js'
import { loadSnapshot, takeSnapshot } from './snapshot.js'
import { MultiAgentState, Status, type MultiAgentResult } from './state.js'
import type { Swarm } from './swarm.js'

const INTERRUPTED_TURNS_KEY = 'subAgentInterruptedTurns'

/**
 * Provides persistence, interrupt, and result handling that differs between child agent types.
 *
 * @internal
 */
export interface ChildAdapter<TChild, TResult> {
  /** Model-facing name of the child, used in terminal error messages. */
  readonly label: string

  /** Discriminant of the stream event that carries the child's final `TResult`, so the streamer can classify mid-stream — before `stream()`'s finally resets transient state like the cancel signal. */
  readonly resultEventType: string

  /** Capture the snapshot needed to resume the child invocation. */
  takeSnapshot(child: TChild): Snapshot

  /** Restore the snapshot and report whether the child awaits interrupt responses. */
  restore(child: TChild, snapshot: Snapshot | undefined): Promise<boolean>

  /** Return interrupts, a failure message, or `undefined` for a successful result. */
  classify(child: TChild, result: TResult): Interrupt[] | string | undefined

  /**
   * Return the interrupt ids a stored turn awaits, without restoring a child.
   *
   * @throws Error if the turn has no readable interrupt state.
   */
  pendingInterruptIds(turn: JSONValue | undefined): string[]
}

/**
 * Adapts an agent child to the {@link AgentToolStreamer} interface.
 *
 * @internal
 */
export class ChildAgentAdapter implements ChildAdapter<Agent, AgentResult> {
  readonly label: string
  readonly resultEventType = 'agentResultEvent'
  private readonly _name: string

  /**
   * @param config - `label` names the child in error messages; `name` names it in limit-stop messages.
   */
  constructor(config: { label: string; name: string }) {
    this.label = config.label
    this._name = config.name
  }

  takeSnapshot(child: Agent): Snapshot {
    return child.takeSnapshot({ preset: 'session' })
  }

  async restore(child: Agent, snapshot: Snapshot | undefined): Promise<boolean> {
    if (snapshot !== undefined) {
      child.loadSnapshot(snapshot)
    } else {
      // A context-preserving child restores its own turn from its session on initialization.
      await child.initialize()
    }
    return child._interruptState.activated
  }

  classify(child: Agent, result: AgentResult): Interrupt[] | string | undefined {
    if (result.stopReason === 'interrupt') {
      return result.interrupts?.length ? [...result.interrupts] : `${this.label} interrupted without any interrupts`
    }
    if (result.stopReason === 'cancelled') {
      // Called mid-stream on `agentResultEvent`, so the signal is still live:
      // deferred cancel (stop tool) never flips it → success; immediate cancel is an abort.
      return child.cancelSignal.aborted ? `${this.label} cancelled` : undefined
    }
    if (LIMIT_STOP_REASONS.has(result.stopReason)) {
      return limitStopMessage(this._name, result.stopReason)
    }
    return undefined
  }

  pendingInterruptIds(turn: JSONValue | undefined): string[] {
    const data = (turn as unknown as Snapshot).data.interrupts as unknown as InterruptStateData
    return Object.keys(InterruptState.fromJSON(data).interrupts)
  }
}

/**
 * Adapts a multi-agent child to the {@link AgentToolStreamer} interface.
 *
 * @internal
 */
export class ChildMultiAgentAdapter implements ChildAdapter<Swarm | Graph, MultiAgentResult> {
  readonly label: string
  readonly resultEventType = 'multiAgentResultEvent'
  private readonly _render: (result: MultiAgentResult) => string

  /**
   * @param config - `label` names the child in error messages; `render` formats the partial output of an
   * incomplete result.
   */
  constructor(config: { label: string; render: (result: MultiAgentResult) => string }) {
    this.label = config.label
    this._render = config.render
  }

  takeSnapshot(child: Swarm | Graph): Snapshot {
    return takeSnapshot(
      child,
      (child as unknown as { _pendingInterruptState?: MultiAgentState })._pendingInterruptState
    )
  }

  async restore(child: Swarm | Graph, snapshot: Snapshot | undefined): Promise<boolean> {
    const holder = child as unknown as { _pendingInterruptState?: MultiAgentState }
    if (snapshot !== undefined) {
      const state = new MultiAgentState({ nodeIds: [...child.nodes.keys()] })
      loadSnapshot(child, snapshot, state)
      const missing = [...state.nodes.keys()].filter((id) => !child.nodes.has(id))
      if (missing.length > 0) {
        throw new Error(
          `node_ids=<${missing.join(',')}> | rebuilt ${this.label} lacks nodes from the stored turn; builder must give each spec the same agent id`
        )
      }
      holder._pendingInterruptState = state
    }
    const nodes = holder._pendingInterruptState?.nodes.values() ?? []
    return [...nodes].some((node) => node.status === Status.INTERRUPTED)
  }

  classify(_child: Swarm | Graph, result: MultiAgentResult): Interrupt[] | string | undefined {
    if (result.status === Status.INTERRUPTED && result.interrupts?.length) {
      return [...result.interrupts]
    }
    if (result.status !== Status.COMPLETED) {
      // A limit stop fails the node, not the orchestrator, so fall back to the first failed node's error.
      const error = result.error ?? result.results.find((nodeResult) => nodeResult.status === Status.FAILED)?.error
      const reason = error ? `: ${error.message}` : ''
      return `${this.label} stopped before completing (status=${result.status}${reason}). Partial output:\n${this._render(result)}`
    }
    return undefined
  }

  pendingInterruptIds(turn: JSONValue | undefined): string[] {
    const state = new MultiAgentState()
    loadStateSerializable(state, (turn as unknown as Snapshot).data.state!)
    return [...state.nodes.values()].flatMap((node) => node.interrupts.map((interrupt) => interrupt.id))
  }
}

/**
 * Streams a child invocation through the parent tool lifecycle.
 *
 * Child interrupts are raised on the parent with ids namespaced to the tool call
 * (`<namespace>:<toolUseId>:<childInterruptId>`), and the child's interrupted turn is stored in the
 * parent's interrupt context so it can be resumed after the parent is restored from a snapshot.
 *
 * @internal
 */
export class AgentToolStreamer<TResult = unknown> {
  /** The child's result, once {@link stream} has finished. */
  result: TResult | undefined
  /** Interrupts to raise on the parent, if the child stopped on interrupts. */
  interrupts: Interrupt[] | undefined
  /** Error message for the tool result, if the child did not complete. */
  error: string | undefined

  private readonly _interruptState: InterruptState | undefined
  private readonly _toolUseId: string
  private readonly _prefix: string
  private readonly _persistInterruptedTurn: boolean
  private readonly _raiseUnfinished: boolean

  /**
   * @param config - The parent's interrupt state, the tool call id, the interrupt id namespace, whether to
   * store the child's interrupted turn on the parent, and whether {@link stream} and {@link resume} throw the
   * recorded interrupts or error, for tools that do not build their result with {@link terminalResult}.
   */
  constructor(config: {
    interruptState: InterruptState | undefined
    toolUseId: string
    namespace: string
    persistInterruptedTurn?: boolean
    raiseUnfinished?: boolean
  }) {
    this._interruptState = config.interruptState
    this._toolUseId = config.toolUseId
    this._prefix = `${config.namespace}:${encodeURIComponent(config.toolUseId)}:`
    this._persistInterruptedTurn = config.persistInterruptedTurn ?? true
    this._raiseUnfinished = config.raiseUnfinished ?? false
  }

  /**
   * Yields the child's progress events and retains its terminal state for the tool.
   *
   * @param adapter - Child-specific persistence and result handling.
   * @param child - The child being streamed.
   * @param events - The child's stream, returning its result.
   * @throws InterruptError or Error if the child did not complete and `raiseUnfinished` is set.
   */
  async *stream<TChild, TEvent>(
    adapter: ChildAdapter<TChild, TResult>,
    child: TChild,
    events: AsyncGenerator<TEvent, TResult | undefined, undefined>
  ): AsyncGenerator<TEvent, void, undefined> {
    let next = await events.next()
    // Classify on the result event (while transient state like the child's cancel signal is still
    // live), falling back to a post-stream classify if that event never arrived.
    let outcome: Interrupt[] | string | undefined
    let classified = false
    while (!next.done) {
      const event = next.value as { type?: string; result?: TResult }
      if (!classified && event.type === adapter.resultEventType && event.result !== undefined) {
        outcome = adapter.classify(child, event.result)
        classified = true
      }
      yield next.value
      next = await events.next()
    }

    this.result = next.value
    if (!classified && this.result !== undefined) {
      outcome = adapter.classify(child, this.result)
    }
    const state = this._interruptState
    if (this.result === undefined) {
      this.error = `${adapter.label} did not produce a result.`
    } else if (!Array.isArray(outcome)) {
      delete this._turns()?.[this._toolUseId]
      this.error = outcome
    } else if (state === undefined) {
      // Without a parent interrupt state there is nothing to resume against, so ids pass through raw.
      this.interrupts = outcome
    } else {
      if (this._persistInterruptedTurn) {
        const turns = (state.context[INTERRUPTED_TURNS_KEY] ??= {}) as Record<string, JSONValue>
        turns[this._toolUseId] = deepCopy(adapter.takeSnapshot(child) as unknown as JSONValue)
      }
      // Registered here, not only when the orchestrator catches the error: the concurrent executor keeps
      // one InterruptError per batch, so a second interrupting child would otherwise be dropped.
      this.interrupts = outcome.map((interrupt) =>
        state.registerInterrupt(
          new Interrupt({
            id: `${this._prefix}${interrupt.id}`,
            name: interrupt.name,
            ...(interrupt.reason !== undefined && { reason: interrupt.reason }),
            source: 'tool',
          })
        )
      )
    }
    this._raiseIfUnfinished()
  }

  /**
   * Returns the terminal tool result for the child invocation.
   *
   * @param renderSuccess - Renders a completed result. Defaults to the result's text.
   * @returns The tool result.
   * @throws InterruptError if the child stopped on interrupts.
   */
  terminalResult(renderSuccess?: (result: TResult) => ToolResultContent[]): ToolResultBlock {
    if (this.interrupts !== undefined) {
      throw new InterruptError(this.interrupts)
    }
    if (this.error !== undefined) {
      return new ToolResultBlock({ toolUseId: this._toolUseId, status: 'error', content: [new TextBlock(this.error)] })
    }
    return new ToolResultBlock({
      toolUseId: this._toolUseId,
      status: 'success',
      content: renderSuccess ? renderSuccess(this.result as TResult) : [new TextBlock(String(this.result))],
    })
  }

  /** Whether this tool call has a child turn to resume. */
  isResuming(): boolean {
    const state = this._interruptState
    return (
      state !== undefined && state.activated && Object.keys(state.interrupts).some((id) => id.startsWith(this._prefix))
    )
  }

  /**
   * Restores the child invocation and returns its scoped interrupt responses.
   *
   * An `undefined` child (it could not be rebuilt) is handled like a failed restore. When the child cannot be
   * resumed, {@link interrupts} or {@link error} is set and `undefined` is returned.
   *
   * @param adapter - Child-specific persistence handling.
   * @param child - The child to restore, or `undefined` if it could not be rebuilt.
   * @param unavailableMessage - Error message for a turn that cannot be resumed.
   * @returns The responses to resume the child with, or `undefined` if it cannot be resumed.
   * @throws InterruptError if none of this call's interrupts were answered.
   * @throws InterruptError or Error if the child cannot be resumed and `raiseUnfinished` is set.
   */
  async resume<TChild>(
    adapter: ChildAdapter<TChild, TResult>,
    child: TChild | undefined,
    unavailableMessage: string
  ): Promise<InterruptResponseContent[] | undefined> {
    const state = this._interruptState
    if (state === undefined || !this.isResuming()) {
      return undefined
    }

    const responses = (state.resumeResponses ?? []).filter((r) =>
      r.interruptResponse.interruptId.startsWith(this._prefix)
    )
    if (responses.length === 0) {
      throw new InterruptError(
        Object.values(state.interrupts).filter((i) => i.id.startsWith(this._prefix) && i.response === undefined)
      )
    }

    const turn = this._turns()?.[this._toolUseId]
    let restored = false
    let awaitingResponses = false
    if (child !== undefined) {
      try {
        awaitingResponses = await adapter.restore(child, turn as unknown as Snapshot | undefined)
        restored = true
      } catch (error) {
        logger.error(
          `tool_use_id=<${this._toolUseId}>, error=<${String(error)}> | failed to restore interrupted sub-agent turn`
        )
      }
    }
    if (!restored) {
      this._handleFailedRestore(adapter, unavailableMessage)
    } else {
      // The restored child owns its turn now; an interrupt stores it again. Clearing before the child runs is what
      // lets a re-interrupt persist, at the cost of losing the turn if the child throws.
      delete this._turns()?.[this._toolUseId]
      if (!awaitingResponses) {
        logger.error(`tool_use_id=<${this._toolUseId}> | interrupted sub-agent turn is not available to resume`)
        this.error = unavailableMessage
      }
    }
    this._raiseIfUnfinished()
    if (!awaitingResponses) {
      return undefined
    }
    return responses.map(
      (r) =>
        new InterruptResponseContent({
          interruptId: r.interruptResponse.interruptId.slice(this._prefix.length),
          response: r.interruptResponse.response,
        })
    )
  }

  /** Throws the recorded interrupts or error when `raiseUnfinished` is set. */
  private _raiseIfUnfinished(): void {
    if (!this._raiseUnfinished) return
    if (this.interrupts?.length) {
      throw new InterruptError(this.interrupts)
    }
    if (this.error !== undefined) {
      throw new Error(this.error)
    }
  }

  /** Re-raises the interrupts the stored turn still awaits when the child cannot be restored. */
  private _handleFailedRestore<TChild>(adapter: ChildAdapter<TChild, TResult>, unavailableMessage: string): void {
    let pending: string[]
    try {
      pending = adapter.pendingInterruptIds(this._turns()?.[this._toolUseId])
    } catch {
      logger.error(`tool_use_id=<${this._toolUseId}> | stored turn has no readable interrupt state`)
      this.error = unavailableMessage
      return
    }
    const interrupts = Object.values(this._interruptState!.interrupts).filter(
      (i) => i.id.startsWith(this._prefix) && pending.includes(i.id.slice(this._prefix.length))
    )
    if (interrupts.length === 0) {
      this.error = unavailableMessage
      return
    }
    // The answer could not be applied, so the interrupts are unanswered again and the turn stays stored.
    for (const interrupt of interrupts) delete interrupt.response
    this.interrupts = interrupts
  }

  private _turns(): Record<string, JSONValue> | undefined {
    return this._interruptState?.context[INTERRUPTED_TURNS_KEY] as Record<string, JSONValue> | undefined
  }
}
