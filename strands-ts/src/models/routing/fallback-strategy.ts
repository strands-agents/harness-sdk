import { ContextWindowOverflowError } from '../../errors.js'
import { Model } from '../model.js'
import type { RoutingCandidate } from './router.js'
import type { RoutingAttempt, RoutingContext, RoutingStrategy } from './strategy.js'

/** Options for production failover behavior. */
export interface FallbackStrategyOptions {
  /** Error constructors or predicate that permit failover; omitted preserves all-error failover. */
  readonly failOverOn?: readonly (typeof Error)[] | ((error: Error) => boolean)
  /** Seconds to skip a candidate after it causes failover; zero disables cooldowns. */
  readonly cooldown?: number
}

/** Selects the healthiest candidate not yet tried since the last success. */
export class FallbackStrategy implements RoutingStrategy {
  private readonly _failOverOn: readonly (typeof Error)[] | ((error: Error) => boolean) | undefined
  private readonly _cooldown: number
  private readonly _coolUntil = new Map<RoutingCandidate, number>()

  /**
   * Configure selective failover and cross-invocation cooldowns.
   *
   * @param options - Failover filter and cooldown duration
   * @throws Error if `cooldown` is negative or not finite
   */
  constructor(options: FallbackStrategyOptions = {}) {
    if (options.cooldown !== undefined && (!Number.isFinite(options.cooldown) || options.cooldown < 0)) {
      throw new Error('cooldown must be a finite number greater than or equal to zero')
    }
    this._failOverOn = options.failOverOn
    this._cooldown = options.cooldown ?? 0
  }

  /**
   * Select the least-failed available candidate, breaking ties by declaration order.
   *
   * @param context - Current routing context
   * @returns The selected candidate, or `undefined` when the round is exhausted
   */
  async select(context: RoutingContext): Promise<RoutingCandidate | undefined> {
    const latest = context.attempts.at(-1)
    if (latest?.exception !== undefined) {
      if (!this._shouldFailOver(latest.exception)) return undefined
      if (this._cooldown > 0 && !(latest.exception instanceof ContextWindowOverflowError)) {
        this._coolUntil.set(latest.candidate, monotonicSeconds() + this._cooldown)
      }
    }

    const failures = new Map<RoutingCandidate, number>()
    for (const attempt of context.attempts) {
      if (attempt.exception === undefined) {
        failures.delete(attempt.candidate)
      } else {
        failures.set(attempt.candidate, (failures.get(attempt.candidate) ?? 0) + 1)
      }
    }

    const triedNow = new Set(attemptsSinceSuccess(context.attempts).map((attempt) => attempt.candidate))
    const available = context.candidates.filter((candidate) => !triedNow.has(candidate))
    if (available.length === 0) return undefined

    let eligible = available
    if (latest?.exception instanceof ContextWindowOverflowError) {
      const currentLimit = contextWindowLimit(latest.candidate)
      eligible = available.filter((candidate) => hasLargerContext(candidate, currentLimit))
      if (eligible.length === 0) return undefined
    }

    const now = monotonicSeconds()
    for (const [candidate, deadline] of this._coolUntil) {
      if (deadline <= now) this._coolUntil.delete(candidate)
    }
    const ready = eligible.filter((candidate) => (this._coolUntil.get(candidate) ?? 0) <= now)
    if (ready.length > 0) {
      eligible = ready
    } else {
      const earliest = Math.min(...eligible.map((candidate) => this._coolUntil.get(candidate) ?? 0))
      eligible = eligible.filter((candidate) => (this._coolUntil.get(candidate) ?? 0) === earliest)
    }

    return eligible.reduce((best, candidate) =>
      (failures.get(candidate) ?? 0) < (failures.get(best) ?? 0) ? candidate : best
    )
  }

  private _shouldFailOver(error: Error): boolean {
    if (error instanceof ContextWindowOverflowError || this._failOverOn === undefined) return true
    if (typeof this._failOverOn === 'function') return this._failOverOn(error)
    return this._failOverOn.some((errorType) => error instanceof errorType)
  }
}

function attemptsSinceSuccess(attempts: readonly RoutingAttempt[]): readonly RoutingAttempt[] {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index]!.exception === undefined) return attempts.slice(index + 1)
  }
  return attempts
}

function contextWindowLimit(candidate: RoutingCandidate): number | undefined {
  const model = candidate.model instanceof Model ? candidate.model : candidate.model.defaultModel
  return model.getConfig().contextWindowLimit
}

function hasLargerContext(candidate: RoutingCandidate, currentLimit: number | undefined): boolean {
  const candidateLimit = contextWindowLimit(candidate)
  return currentLimit !== undefined && candidateLimit !== undefined && candidateLimit > currentLimit
}

function monotonicSeconds(): number {
  return globalThis.performance.now() / 1000
}
