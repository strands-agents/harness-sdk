/**
 * Type definitions and constants for the sleep tool.
 */

/**
 * Default upper bound on `duration` (seconds) accepted by `makeSleep`.
 */
export const DEFAULT_MAX_DURATION = 60

/**
 * Build the model-facing description with the configured maximum interpolated
 * so the model knows the exact ceiling.
 */
export function sleepDescription(maxDuration: number): string {
  return (
    `Pauses execution for a specified number of seconds (max ${maxDuration}). ` +
    'Cooperative and cancellable: the sleep aborts immediately when the agent ' +
    'invocation is cancelled. Rejects negative, NaN, infinite, or non-numeric ' +
    `durations, and durations above ${maxDuration}.`
  )
}

/**
 * Description for the default sleep tool (60-second cap).
 */
export const SLEEP_DESCRIPTION = sleepDescription(DEFAULT_MAX_DURATION)

/**
 * Input parameters accepted by the sleep tool.
 *
 * The Zod schema in `make-sleep.ts` is the single source of truth for the
 * validated input shape (it also enforces the configured maximum); this type
 * describes the pre-refinement shape callers can pass directly.
 */
export interface SleepInput {
  /**
   * Seconds to pause. Must be a finite, non-negative number and no larger than
   * the tool's configured maximum.
   */
  duration: number
}
