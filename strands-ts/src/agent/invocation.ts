import type { InvokeLimits } from '../types/agent.js'
import type { StopReason } from '../types/messages.js'
import { accumulateUsage, createEmptyUsage, type Usage } from '../models/streaming.js'

declare const invocationBrand: unique symbol

/**
 * Opaque handle to the request an object belongs to.
 *
 * The root `invoke()` / `stream()` call creates one and the SDK attaches it to
 * the objects it hands to extension code (hook events, tool context, model-call
 * and strategy contexts). Pass it to {@link InvokeOptions.invocation} to run a
 * nested agent as part of the same request, sharing its limits and usage total.
 *
 * Only the SDK can create one, and its type exposes no state.
 */
export interface Invocation {
  readonly [invocationBrand]: true
}

/**
 * Request-scoped state behind the public {@link Invocation} handle.
 *
 * The root {@link Agent.stream} call creates one, and every agent that joins the
 * request (sub-agents invoked as tools, multi-agent nodes, callers forwarding the
 * handle) shares it. A nested call with its own limits gets a child instance
 * bounded by both its own limits and its parent's; an auxiliary call gets a child
 * instance that no limits apply to. Every child's usage also counts toward its parent.
 *
 * @internal
 */
export class InternalInvocation implements Invocation {
  declare readonly [invocationBrand]: true

  /** Agent-loop turns taken under this invocation. */
  turns = 0

  /** Token usage of every model call made under this invocation, children included. */
  readonly usage: Usage = createEmptyUsage()

  /**
   * @param limits - Limits checked against this invocation's own turns and usage; `undefined` for none
   * @param _parent - The enclosing invocation that also counts this one's usage, if any
   * @param _auxiliary - Whether the parent's limits skip this invocation and its turns stay out of the parent's count
   */
  constructor(
    readonly limits: InvokeLimits | undefined,
    private readonly _parent?: InternalInvocation,
    private readonly _auxiliary = false
  ) {}

  /** The enclosing invocation whose limits also bound this one, if any. */
  get limitingParent(): InternalInvocation | undefined {
    return this._auxiliary ? undefined : this._parent
  }

  /** Usage of the whole request: the outermost invocation's total. */
  get requestUsage(): Usage {
    return this._parent?.requestUsage ?? this.usage
  }

  /**
   * Adds one model call's usage to this invocation and every enclosing one.
   *
   * @param usage - The usage the model call reported
   */
  recordUsage(usage: Usage): void {
    accumulateUsage(this.usage, usage)
    this._parent?.recordUsage(usage)
  }

  /** Counts one agent-loop turn here and in every enclosing invocation whose limits bound this one. */
  recordTurn(): void {
    this.turns += 1
    this.limitingParent?.recordTurn()
  }
}

/**
 * Creates a fresh {@link InternalInvocation} with a zeroed usage total and no
 * turns taken yet. Given a parent, it is a nested invocation: its usage and
 * turns also count toward the parent, and the parent's limits also bound it.
 *
 * @param limits - Limits for the invocation, or `undefined` for none
 * @param parent - The enclosing invocation, if any
 * @returns A new request-scoped state object
 * @internal
 */
export function createInvocation(limits?: InvokeLimits, parent?: InternalInvocation): InternalInvocation {
  return new InternalInvocation(limits, parent)
}

/**
 * Creates the {@link Invocation} for an auxiliary call made on a request's
 * behalf: the HITL classifier, steering, goal judge and web-fetch analyst, and
 * the handle given to context strategies, conversation managers, routing
 * strategies and memory extractors. The call's tokens count toward every
 * enclosing invocation's usage, but no enclosing limits apply to it and its
 * turns do not count against them. Returns `undefined` when there is no
 * enclosing request, so the call runs standalone.
 *
 * @param parent - The enclosing request's invocation, if any
 * @returns An invocation sharing the request's usage, or `undefined`
 * @internal
 */
export function createAuxiliaryInvocation(parent: Invocation | undefined): Invocation | undefined {
  const internal = toInternal(parent)
  return internal && new InternalInvocation(undefined, internal, true)
}

/**
 * Returns the stop reason for the first limit reached on this invocation or on
 * any enclosing invocation whose limits bound it, innermost first, or
 * `undefined` if none has. Priority within one invocation when several are
 * reached: turns, then totalTokens, then outputTokens.
 *
 * @param invocation - The request-scoped state to check
 * @returns The limit stop reason, or `undefined` while within limits
 * @internal
 */
export function reachedLimit(invocation: InternalInvocation): StopReason | undefined {
  const parent = invocation.limitingParent
  return reachedOwnLimit(invocation) ?? (parent && reachedLimit(parent))
}

function reachedOwnLimit(invocation: InternalInvocation): StopReason | undefined {
  const limits = invocation.limits
  if (!limits) return undefined

  const { outputTokens, totalTokens } = invocation.usage
  if (limits.turns !== undefined && invocation.turns >= limits.turns) {
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
 * Unwraps a public {@link Invocation} handle to its request-scoped state.
 *
 * @param invocation - A handle the SDK attached to an object, if any
 * @returns The request-scoped state, or `undefined` when there is none
 * @throws TypeError if the handle was not created by the SDK
 * @internal
 */
export function toInternal(invocation: Invocation | undefined): InternalInvocation | undefined {
  if (invocation === undefined) return undefined
  if (!(invocation instanceof InternalInvocation)) throw new TypeError('invocation was not created by the SDK')
  return invocation
}
