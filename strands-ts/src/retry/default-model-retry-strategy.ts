/**
 * Default concrete retry strategy for model invocations.
 *
 * Implements {@link ModelRetryStrategy.computeRetryDecision} to retry failed model
 * calls classified by {@link isRetryable}, bounded by `maxAttempts`, with
 * delays computed by the configured {@link BackoffStrategy}.
 */

import type { AfterModelCallEvent } from '../hooks/events.js'
import { ModelThrottledError } from '../errors.js'
import { logger } from '../logging/logger.js'
import type { BackoffContext, BackoffStrategy } from './backoff-strategy.js'
import { ExponentialBackoff } from './backoff-strategy.js'
import { ModelRetryStrategy } from './model-retry-strategy.js'
import type { RetryDecision } from './retry-strategy.js'

const DEFAULT_MAX_ATTEMPTS = 6
const DEFAULT_BACKOFF_BASE_MS = 4_000
const DEFAULT_BACKOFF_MAX_MS = 240_000

/**
 * Options for {@link DefaultModelRetryStrategy}.
 */
export interface DefaultModelRetryStrategyOptions {
  /**
   * Total model attempts before giving up and re-raising the error.
   * Must be \>= 1. Default {@link DEFAULT_MAX_ATTEMPTS}.
   */
  maxAttempts?: number
  /**
   * Backoff used to compute the delay between retries.
   * Default: `new ExponentialBackoff({ baseMs: DEFAULT_BACKOFF_BASE_MS, maxMs: DEFAULT_BACKOFF_MAX_MS })`.
   */
  backoff?: BackoffStrategy
}

/**
 * Retries failed model calls classified by the SDK as retryable.
 *
 * Today, only {@link ModelThrottledError} is treated as retryable — subclass
 * and override {@link isRetryable} to expand or narrow that set without
 * reimplementing the rest of the retry policy.
 *
 * State is per retry budget: timing state resets in {@link onFirstModelAttempt}, which the base class
 * calls when `event.attemptCount === 1`. A new turn and a router candidate switch each start a fresh
 * budget. The attempt counter itself is owned by the agent loop and read from
 * {@link AfterModelCallEvent.attemptCount}.
 *
 * Hook precedence: {@link AfterModelCallEvent} fires hooks in reverse registration
 * order, so user-registered hooks run before this strategy. If a user hook sets
 * `event.retry = true` first, the base class returns early and does not stack
 * additional backoff on top.
 *
 * Sharing: a given instance tracks its own backoff state and must not be shared
 * across multiple agents. Create a separate instance per agent.
 *
 * @example
 * ```ts
 * const agent = new Agent({
 *   model,
 *   retryStrategy: new DefaultModelRetryStrategy({ maxAttempts: 4 }),
 * })
 * ```
 */
export class DefaultModelRetryStrategy extends ModelRetryStrategy {
  readonly name: string = 'strands:default-model-retry-strategy'

  private readonly _maxAttempts: number
  private readonly _backoff: BackoffStrategy

  private _lastDelayMs: number | undefined
  private _firstFailureAt: number | undefined

  constructor(opts: DefaultModelRetryStrategyOptions = {}) {
    super()
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error(`DefaultModelRetryStrategy: maxAttempts must be an integer >= 1 (got ${maxAttempts})`)
    }
    this._maxAttempts = maxAttempts
    this._backoff =
      opts.backoff ?? new ExponentialBackoff({ baseMs: DEFAULT_BACKOFF_BASE_MS, maxMs: DEFAULT_BACKOFF_MAX_MS })
  }

  /**
   * Whether `error` should be retried. Override to extend or narrow the
   * retryable set (e.g. to also retry transient 5xx errors).
   */
  protected isRetryable(error: Error): boolean {
    return error instanceof ModelThrottledError
  }

  protected override computeRetryDecision(event: AfterModelCallEvent): RetryDecision {
    const error = event.error
    if (error === undefined || !this.isRetryable(error)) {
      return { retry: false }
    }

    if (event.attemptCount >= this._maxAttempts) {
      logger.debug(
        `attempt_count=<${event.attemptCount}> max_attempts=<${this._maxAttempts}> | max retry attempts reached`
      )
      return { retry: false }
    }

    if (this._firstFailureAt === undefined) {
      this._firstFailureAt = Date.now()
    }

    const waitMs = this._backoff.nextDelay(this._buildContext(event.attemptCount))

    logger.debug(
      `retry_delay_ms=<${waitMs}> attempt_count=<${event.attemptCount}> max_attempts=<${this._maxAttempts}> ` +
        `| retryable model error, delaying before retry`
    )

    this._lastDelayMs = waitMs
    return { retry: true, waitMs }
  }

  protected override onFirstModelAttempt(): void {
    this._lastDelayMs = undefined
    this._firstFailureAt = undefined
  }

  private _buildContext(attemptCount: number): BackoffContext {
    const ctx: BackoffContext = {
      attempt: attemptCount,
      elapsedMs: this._firstFailureAt === undefined ? 0 : Date.now() - this._firstFailureAt,
    }
    if (this._lastDelayMs !== undefined) {
      ctx.lastDelayMs = this._lastDelayMs
    }
    return ctx
  }
}
