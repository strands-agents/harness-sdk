import type { RoutingCandidate } from './router.js'
import type { RoutingAttempt, RoutingContext, RoutingStrategy } from './strategy.js'

/** Selects the healthiest candidate not yet tried since the last success. */
export class FallbackStrategy implements RoutingStrategy {
  /**
   * Select the least-failed available candidate, breaking ties by declaration order.
   *
   * @param context - Current routing context
   * @returns The selected candidate, or `undefined` when the round is exhausted
   */
  async select(context: RoutingContext): Promise<RoutingCandidate | undefined> {
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

    return available.reduce((best, candidate) =>
      (failures.get(candidate) ?? 0) < (failures.get(best) ?? 0) ? candidate : best
    )
  }
}

function attemptsSinceSuccess(attempts: readonly RoutingAttempt[]): readonly RoutingAttempt[] {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index]!.exception === undefined) return attempts.slice(index + 1)
  }
  return attempts
}
