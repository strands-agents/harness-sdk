import type { InvokeLimits } from '../types/agent.js'
import type { StopReason } from '../types/messages.js'
import { createEmptyUsage, type Usage } from '../models/streaming.js'

declare const invocationBrand: unique symbol

/**
 * Opaque handle to the request an object belongs to.
 *
 * The root `invoke()` / `stream()` call creates one and the SDK attaches it to
 * the objects it hands to extension code (hook events, tool context, model-call
 * and strategy contexts). Pass it to {@link InvokeOptions.invocation} to run a
 * nested agent as part of the same request, sharing its limits and usage total.
 *
 * Only the SDK can create one; it carries no readable state.
 */
export interface Invocation {
  readonly [invocationBrand]: true
}

/**
 * Request-scoped state threaded through one invocation, behind the public
 * {@link Invocation} handle.
 *
 * The root {@link Agent.stream} call creates one and shares it by reference
 * across every agent the request reaches. Sub-agents invoked as tools and
 * multi-agent nodes see the same instance.
 *
 * @internal
 */
export class InternalInvocation implements Invocation {
  declare readonly [invocationBrand]: true

  /** Count of agent-loop turns taken so far, across the whole request. */
  turns = 0

  /**
   * @param limits - Limits inherited from the root request; `undefined` for none
   * @param usage - Running token usage for the whole request, accumulated in place across every model call
   */
  constructor(
    readonly limits: InvokeLimits | undefined,
    readonly usage: Usage = createEmptyUsage()
  ) {}
}

/**
 * Creates a fresh {@link InternalInvocation} with a zeroed usage total and no
 * turns taken yet.
 *
 * @param limits - Limits for the request, or `undefined` for none
 * @returns A new request-scoped state object
 * @internal
 */
export function createInvocation(limits?: InvokeLimits): InternalInvocation {
  return new InternalInvocation(limits)
}

/**
 * Creates the {@link Invocation} for an auxiliary call the SDK makes on a
 * request's behalf (HITL classifier, steering, goal judge, web-fetch analyst).
 * The call's tokens count toward the request's usage, but the request's limits
 * do not apply to it and its turns do not count against them. Returns
 * `undefined` when there is no enclosing request, so the call runs standalone.
 *
 * @param parent - The enclosing request's invocation, if any
 * @returns An invocation sharing the request's usage, or `undefined`
 * @internal
 */
export function createAuxiliaryInvocation(parent: Invocation | undefined): Invocation | undefined {
  const internal = toInternal(parent)
  return internal && new InternalInvocation(undefined, internal.usage)
}

/**
 * Returns the stop reason for the first of the request's limits that has been
 * reached, or `undefined` if none has. Priority when several are reached:
 * turns, then totalTokens, then outputTokens.
 *
 * @param invocation - The request-scoped state to check
 * @returns The limit stop reason, or `undefined` while within limits
 * @internal
 */
export function reachedLimit(invocation: InternalInvocation): StopReason | undefined {
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
