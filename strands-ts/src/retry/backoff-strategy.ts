/**
 * Backoff strategies for computing delay between retry attempts.
 *
 * A `BackoffStrategy` is pure delay math: given a `BackoffContext`, it returns
 * how long to wait before the next attempt. Policy concerns — whether to retry,
 * whether to honor a server-provided `Retry-After` hint, max attempts, total
 * time budgets — live in the retry orchestration layer, not here.
 */

/**
 * Context passed to a {@link BackoffStrategy} for each retry decision.
 *
 * Treated as an open, additive-only contract: new optional fields may be added
 * over time, but existing fields will not be removed or repurposed.
 */
export interface BackoffContext {
  /** 1-based index of the attempt that just failed. Must be \>= 1. */
  attempt: number
  /** Total milliseconds elapsed since the first attempt started. */
  elapsedMs: number
  /** Previously computed delay, if any. Absent before the first retry. */
  lastDelayMs?: number
}

/**
 * Computes the delay before the next retry attempt.
 */
export interface BackoffStrategy {
  /**
   * Returns the delay in milliseconds before the next attempt.
   *
   * Must be a non-negative finite number. Implementations should treat
   * `ctx.attempt < 1` as a programmer error.
   */
  nextDelay(ctx: BackoffContext): number
}

/**
 * Supported jitter modes.
 *
 * - `none`: return the raw delay unchanged
 * - `full`: uniform random in `[0, raw]`
 * - `equal`: `raw/2 + uniform(0, raw/2)` (half fixed, half random)
 * - `decorrelated`: `uniform(baseMs, lastDelayMs * 3)`, capped at `maxMs`;
 *   falls back to `full` on the first retry when `lastDelayMs` is unavailable
 *
 * For jitter outside these modes, implement {@link BackoffStrategy} directly.
 */
export type JitterKind = 'none' | 'full' | 'equal' | 'decorrelated'

function validateAttempt(attempt: number, className: string): void {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`${className}: attempt must be an integer >= 1 (got ${attempt})`)
  }
}

/**
 * Options for {@link ConstantBackoff}.
 */
export interface ConstantBackoffOptions {
  /** Delay in ms returned for every retry. Default 1000. */
  delayMs?: number
}

/**
 * Constant backoff: returns the same delay for every retry.
 */
export class ConstantBackoff implements BackoffStrategy {
  private readonly _delayMs: number

  constructor(opts: ConstantBackoffOptions = {}) {
    this._delayMs = opts.delayMs ?? 1000
  }

  nextDelay(ctx: BackoffContext): number {
    validateAttempt(ctx.attempt, 'ConstantBackoff')
    return this._delayMs
  }
}

/**
 * Options for {@link LinearBackoff}.
 */
export interface LinearBackoffOptions {
  /** Base delay in ms. Delay grows as `baseMs * attempt`. Default 1000. */
  baseMs?: number
  /** Upper bound applied before jitter. Default 30_000. */
  maxMs?: number
  /** Jitter mode. Default 'full'. */
  jitter?: JitterKind
}

/**
 * Linear backoff: delay grows as `baseMs * attempt`, capped at `maxMs`, then jittered.
 */
export class LinearBackoff implements BackoffStrategy {
  private readonly _baseMs: number
  private readonly _maxMs: number
  private readonly _jitter: JitterKind

  constructor(opts: LinearBackoffOptions = {}) {
    this._baseMs = opts.baseMs ?? 1000
    this._maxMs = opts.maxMs ?? 30_000
    this._jitter = opts.jitter ?? 'full'
  }

  nextDelay(ctx: BackoffContext): number {
    validateAttempt(ctx.attempt, 'LinearBackoff')
    const raw = Math.min(this._maxMs, this._baseMs * ctx.attempt)
    return jitter(raw, this._jitter, this._baseMs, this._maxMs, ctx.lastDelayMs)
  }
}

/**
 * Options for {@link ExponentialBackoff}.
 */
export interface ExponentialBackoffOptions {
  /** Base delay in ms. Delay grows as `baseMs * multiplier^(attempt-1)`. Default 1000. */
  baseMs?: number
  /** Upper bound applied before jitter. Default 30_000. */
  maxMs?: number
  /** Growth factor per attempt. Default 2. */
  multiplier?: number
  /** Jitter mode. Default 'full'. */
  jitter?: JitterKind
}

/**
 * Exponential backoff: delay grows as `baseMs * multiplier^(attempt-1)`,
 * capped at `maxMs`, then jittered.
 */
export class ExponentialBackoff implements BackoffStrategy {
  private readonly _baseMs: number
  private readonly _maxMs: number
  private readonly _multiplier: number
  private readonly _jitter: JitterKind

  constructor(opts: ExponentialBackoffOptions = {}) {
    this._baseMs = opts.baseMs ?? 1000
    this._maxMs = opts.maxMs ?? 30_000
    this._multiplier = opts.multiplier ?? 2
    this._jitter = opts.jitter ?? 'full'
  }

  nextDelay(ctx: BackoffContext): number {
    validateAttempt(ctx.attempt, 'ExponentialBackoff')
    const raw = Math.min(this._maxMs, this._baseMs * this._multiplier ** (ctx.attempt - 1))
    return jitter(raw, this._jitter, this._baseMs, this._maxMs, ctx.lastDelayMs)
  }
}

function jitter(raw: number, kind: JitterKind, baseMs: number, maxMs: number, lastDelayMs?: number): number {
  switch (kind) {
    case 'none':
      return raw
    case 'full':
      return Math.random() * raw
    case 'equal':
      return raw / 2 + Math.random() * (raw / 2)
    case 'decorrelated': {
      if (lastDelayMs === undefined) {
        return Math.random() * raw
      }
      // Standard decorrelated jitter: uniform(baseMs, min(maxMs, lastDelay * 3)).
      // The max() guards against the degenerate case where maxMs < baseMs,
      // which would otherwise produce an inverted range.
      const upper = Math.max(baseMs, Math.min(maxMs, lastDelayMs * 3))
      return baseMs + Math.random() * (upper - baseMs)
    }
  }
}
