/**
 * Proactive restart timer for bidirectional streaming.
 *
 * `RestartTimer` fires a warning then a deadline callback at caller-supplied offsets; it holds no
 * restart policy. `resolveDeadlineMs` reads the deadline from a provider's declared
 * `ConnectionConfig`.
 *
 * @internal
 */

import { logger } from '../../logging/index.js'
import type { ConnectionConfig } from '../models/configs.js'

/** Injectable async sleep, in milliseconds. */
export type SleepFn = (milliseconds: number) => Promise<void>

/**
 * Resolve the proactive restart deadline in milliseconds from a connection config.
 *
 * @param connectionConfig - Provider-declared restart timing.
 * @returns `restartAfterMs` if declared and positive, else `undefined` (no proactive timer).
 * @internal
 */
export function resolveDeadlineMs(connectionConfig: ConnectionConfig): number | undefined {
  const restartAfterMs = connectionConfig.restartAfterMs
  if (restartAfterMs === undefined || restartAfterMs <= 0) {
    return undefined
  }
  return restartAfterMs
}

/** Default sleep backed by `setTimeout`, abortable through the supplied signal. */
function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    function onAbort(): void {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Fire a warning then a deadline callback ahead of a provider's connection limit.
 *
 * The clock is injectable so tests can drive timing without wall time.
 *
 * @internal
 */
export class RestartTimer {
  private readonly _onWarning: (timeLeftMs: number) => Promise<void>
  private readonly _onDeadline: () => Promise<void>
  private readonly _sleep: SleepFn | undefined
  private _controller: AbortController | undefined
  /** The in-flight cycle, exposed for tests to await. */
  private _task: Promise<void> | undefined

  /**
   * @param onWarning - Called with milliseconds-left when the warning lead elapses.
   * @param onDeadline - Called when the restart deadline elapses.
   * @param sleep - Injectable async sleep (for tests). Defaults to a `setTimeout` sleep.
   */
  constructor(onWarning: (timeLeftMs: number) => Promise<void>, onDeadline: () => Promise<void>, sleep?: SleepFn) {
    this._onWarning = onWarning
    this._onDeadline = onDeadline
    this._sleep = sleep
  }

  /**
   * Arm the warning and deadline timers, cancelling any previously armed cycle.
   *
   * @param deadlineMs - Milliseconds from now until the deadline callback fires.
   * @param warningLeadMs - Milliseconds before the deadline to fire the warning callback.
   */
  arm(deadlineMs: number, warningLeadMs: number): void {
    this.cancel()
    const controller = new AbortController()
    this._controller = controller
    this._task = this._run(deadlineMs, warningLeadMs, controller)
    logger.debug(
      `deadline_ms=<${deadlineMs.toFixed(0)}>, warning_lead_ms=<${warningLeadMs.toFixed(0)}> | proactive restart timer armed`
    )
  }

  /** Cancel the armed timer, if any. Safe to call when idle. */
  cancel(): void {
    if (this._controller !== undefined) {
      this._controller.abort(new Error('restart timer cancelled'))
      this._controller = undefined
    }
  }

  /**
   * Sleep until the warning lead, fire the warning, then fire the deadline.
   *
   * The warning fires `warningLeadMs` before the deadline. When the lead is zero or exceeds the
   * deadline, the warning is emitted immediately and the remaining wait runs down to the deadline.
   * The deadline countdown continues while warning delivery is backpressured, but the deadline
   * callback still follows the warning.
   */
  private async _run(deadlineMs: number, warningLeadMs: number, controller: AbortController): Promise<void> {
    const sleep = (milliseconds: number): Promise<void> =>
      this._sleep ? this._sleep(milliseconds) : defaultSleep(milliseconds, controller.signal)
    const warningAtMs = Math.max(deadlineMs - warningLeadMs, 0)

    try {
      await sleep(warningAtMs)
      if (controller.signal.aborted) return

      const timeLeftMs = deadlineMs - warningAtMs
      // Start the deadline countdown before awaiting the warning so backpressure on warning
      // delivery does not push the deadline out.
      const deadlineSleep = sleep(timeLeftMs)
      deadlineSleep.catch(() => {})

      await this._onWarning(timeLeftMs)
      await deadlineSleep
      if (controller.signal.aborted) return

      // Detach before the callback re-arms this timer; cancelling a live self-reference
      // would abort the restart the callback runs.
      this._controller = undefined
      await this._onDeadline()
    } catch (error) {
      if (controller.signal.aborted) return
      logger.warn(`error=<${String(error)}> | proactive restart timer failed`)
    }
  }
}
