import { LIMITS_KEYS, type InvokeLimits } from '../types/agent.js'
import type { StopReason } from '../types/messages.js'
import { accumulateUsage, createEmptyUsage, type Usage } from '../models/streaming.js'

declare const invocationContextBrand: unique symbol

/**
 * Handle to the request an object belongs to.
 *
 * A top-level `invoke()` / `stream()` call starts a request, and the SDK attaches
 * its handle to the objects it passes to hooks, tools, and extension points and
 * to the call's result. Pass it to {@link InvokeOptions.invocationContext} to run
 * a nested call in the same request, sharing its limits and usage, for example
 * to continue a previous call's budget.
 *
 * Only the SDK can create one; its state is read-only.
 */
export interface InvocationContext {
  readonly [invocationContextBrand]: true

  /** What the work in this context has used so far; it keeps growing while that work runs. */
  readonly usage: Readonly<InvocationContextUsage>
}

/**
 * What the work in an {@link InvocationContext} has used: its turns and the token
 * usage of every model call, including nested and auxiliary calls.
 */
export interface InvocationContextUsage extends Usage {
  /** Turns taken in this context, including its nested calls. */
  turnsTaken: number
}

/**
 * The state behind an {@link InvocationContext}: a request's limits and usage.
 *
 * Every nested call that joins the request shares one instance. A nested call
 * that sets its own limits, and an auxiliary call, get a child instance instead.
 * A child adds its usage to its parent; a nested call's child is also bound by
 * the parent's limits, while no limits apply to an auxiliary call.
 *
 * @internal
 */
export class InvocationContextImpl implements InvocationContext {
  declare readonly [invocationContextBrand]: true

  /** Turns and token usage counted under this instance; see {@link recordTurn} and {@link recordUsage}. */
  readonly usage: InvocationContextUsage = { turnsTaken: 0, ...createEmptyUsage() }

  private _structuredOutputFailures = 0

  /**
   * @param limits - Limits checked against this instance's usage; `undefined` for none
   * @param _parent - The parent instance, which also receives this one's usage, if any
   * @param _auxiliary - Whether this is an auxiliary call: the parent's limits don't apply and its turns don't count toward the parent
   */
  constructor(
    readonly limits?: InvokeLimits,
    private readonly _parent?: InvocationContextImpl,
    private readonly _auxiliary = false
  ) {}

  /** Failed structured output attempts counted under this instance; see {@link recordStructuredOutputFailure}. */
  get structuredOutputFailures(): number {
    return this._structuredOutputFailures
  }

  /** The parent whose limits also apply to this instance, if any. */
  get limitingParent(): InvocationContextImpl | undefined {
    return this._auxiliary ? undefined : this._parent
  }

  /**
   * Adds one model call's usage to this instance and every parent.
   *
   * @param usage - The usage the model call reported
   */
  recordUsage(usage: Usage): void {
    accumulateUsage(this.usage, usage)
    this._parent?.recordUsage(usage)
  }

  /** Counts one turn here and in every parent whose limits apply to this instance. */
  recordTurn(): void {
    this.usage.turnsTaken += 1
    this.limitingParent?.recordTurn()
  }

  /** Counts one failed structured output attempt here and in every parent whose limits apply to this instance. */
  recordStructuredOutputFailure(): void {
    this._structuredOutputFailures += 1
    this.limitingParent?.recordStructuredOutputFailure()
  }

  /**
   * Whether this instance or a parent whose limits apply to it sets the limit named `key`.
   *
   * @param key - The limit to look for
   * @returns `true` if the limit applies to this instance
   */
  hasLimit(key: keyof InvokeLimits): boolean {
    return this.limits?.[key] !== undefined || (this.limitingParent?.hasLimit(key) ?? false)
  }
}

/**
 * Joins the request given in `options.invocationContext`, or starts a new request
 * with the call's limits. A nested call that sets its own `limits` gets child
 * state, bound by both its own limits and the request's.
 *
 * @param options - The call's options, if any
 * @returns The state of the request to run the call in
 * @throws TypeError if `options.limits` is invalid, or the handle was not created by the SDK
 * @internal
 */
export function resolveInvocationContext(
  options: { invocationContext?: InvocationContext; limits?: InvokeLimits } | undefined
): InvocationContextImpl {
  validateLimits(options?.limits)
  const inherited = unwrapInvocationContext(options?.invocationContext)
  if (!inherited) return new InvocationContextImpl(options?.limits)
  return options?.limits === undefined ? inherited : new InvocationContextImpl(options.limits, inherited)
}

/**
 * Validates limits so bad input fails fast instead of being silently ignored
 * (`NaN`, `Infinity`) or stopping the call at once (zero, negative). Each limit,
 * when set, must be a positive finite number; fractional values are allowed. An
 * unrecognized key throws, since a mistyped limit name would otherwise apply no
 * limit at all.
 */
function validateLimits(limits: InvokeLimits | undefined): void {
  if (!limits) return
  const recognizedKeys = new Set<string>(LIMITS_KEYS)
  const unrecognizedKeys = Object.keys(limits)
    .filter((key) => !recognizedKeys.has(key))
    .sort()
  if (unrecognizedKeys.length > 0) {
    throw new TypeError(
      `limits keys [${unrecognizedKeys.join(', ')}] are not recognized limits, ` +
        `expected one of ${LIMITS_KEYS.map((key) => `'${key}'`).join(', ')}`
    )
  }
  for (const key of LIMITS_KEYS) {
    const value = limits[key]
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new TypeError(`limits.${key} must be a positive finite number, got ${value}`)
    }
  }
}

/**
 * Creates the {@link InvocationContext} for an auxiliary call: the HITL classifier,
 * steering, goal judge, and web-fetch analyst, and the handle passed to extension
 * points (context strategies, conversation managers, routing strategies, memory
 * extractors). Its tokens add to the request's usage, but no limits apply to it
 * and its turns don't count toward the request. Returns `undefined` outside a
 * request, so the call runs standalone.
 *
 * @param parent - The handle of the request the call is made for, if any
 * @returns A handle whose usage adds to the request's, or `undefined`
 * @internal
 */
export function createAuxiliaryInvocationContext(parent: InvocationContext | undefined): InvocationContext | undefined {
  const parentContext = unwrapInvocationContext(parent)
  return parentContext && new InvocationContextImpl(undefined, parentContext, true)
}

/**
 * Returns the stop reason for the first limit reached, checking this instance's
 * own limits first and then each parent's, or `undefined` if none is reached.
 * Within one instance the order is turns, then totalTokens, then outputTokens, then
 * structuredOutputAttempts.
 *
 * @param invocationContext - The state to check
 * @returns The limit stop reason, or `undefined` while no limit is reached
 * @internal
 */
export function reachedLimit(invocationContext: InvocationContextImpl): StopReason | undefined {
  const parent = invocationContext.limitingParent
  return reachedOwnLimit(invocationContext) ?? (parent && reachedLimit(parent))
}

function reachedOwnLimit(invocationContext: InvocationContextImpl): StopReason | undefined {
  const limits = invocationContext.limits
  if (!limits) return undefined

  const { turnsTaken, outputTokens, totalTokens } = invocationContext.usage
  if (limits.turns !== undefined && turnsTaken >= limits.turns) {
    return 'limitTurns'
  }
  if (limits.totalTokens !== undefined && totalTokens >= limits.totalTokens) {
    return 'limitTotalTokens'
  }
  if (limits.outputTokens !== undefined && outputTokens >= limits.outputTokens) {
    return 'limitOutputTokens'
  }
  if (
    limits.structuredOutputAttempts !== undefined &&
    invocationContext.structuredOutputFailures >= limits.structuredOutputAttempts
  ) {
    return 'limitStructuredOutputAttempts'
  }
  return undefined
}

/**
 * Returns the state behind an {@link InvocationContext} handle.
 *
 * @param invocationContext - A handle the SDK passed out, if any
 * @returns The state behind it, or `undefined` when there is no handle
 * @throws TypeError if the handle was not created by the SDK
 * @internal
 */
export function unwrapInvocationContext(
  invocationContext: InvocationContext | undefined
): InvocationContextImpl | undefined {
  if (invocationContext === undefined) return undefined
  if (!(invocationContext instanceof InvocationContextImpl))
    throw new TypeError('invocationContext was not created by the SDK')
  return invocationContext
}
