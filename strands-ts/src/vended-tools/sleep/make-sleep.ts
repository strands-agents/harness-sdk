/**
 * Sleep tool factory: pauses execution for a bounded, cooperative duration.
 *
 * The returned tool honors `context.cancelSignal`, so cancelling the current
 * tool call aborts the sleep immediately.
 */

import type { InvokableTool } from '../../tools/tool.js'
import { tool } from '../../tools/tool-factory.js'
import { z } from 'zod'
import type { JSONValue } from '../../types/json.js'
import type { SleepInput } from './types.js'
import { DEFAULT_MAX_DURATION, sleepDescription } from './types.js'

/**
 * Options for {@link makeSleep}.
 */
export interface MakeSleepOptions {
  /**
   * Upper bound on the `duration` input, in seconds. Must be a finite, positive
   * number. Defaults to {@link DEFAULT_MAX_DURATION} (60 s).
   */
  maxDuration?: number
  /**
   * Tool name. Defaults to `"sleep"`.
   */
  name?: string
  /**
   * Tool description shown to the model.
   */
  description?: string
}

/**
 * Creates a sleep tool with a configurable maximum duration.
 *
 * The returned tool pauses for the requested number of seconds. It attaches a
 * one-shot listener to `context.cancelSignal` so that cancellation immediately
 * aborts the sleep with an `AbortError`.
 *
 * @param options - Configuration options.
 * @returns A tool that pauses execution for the requested duration.
 * @throws Error if `maxDuration` is not a finite, positive number.
 *
 * @example
 * ```typescript
 * const shortSleep = makeSleep({ maxDuration: 5 })
 * const agent = new Agent({ tools: [shortSleep] })
 * ```
 */
export function makeSleep(options: MakeSleepOptions = {}): InvokableTool<SleepInput, JSONValue> {
  const maxDuration = options.maxDuration ?? DEFAULT_MAX_DURATION
  if (typeof maxDuration !== 'number' || !Number.isFinite(maxDuration) || maxDuration <= 0) {
    throw new Error(`maxDuration must be a positive, finite number, got ${String(maxDuration)}`)
  }

  const inputSchema = z.object({
    duration: z
      .number()
      .finite('duration must be a finite number')
      .nonnegative('duration must be non-negative')
      .max(maxDuration, `duration exceeds maximum of ${maxDuration} seconds`)
      .describe(`Seconds to pause. Must be finite, non-negative, and no larger than ${maxDuration}.`),
  })

  return tool({
    name: options.name ?? 'sleep',
    description: options.description ?? sleepDescription(maxDuration),
    inputSchema,
    callback: async (input, context) => {
      const { duration } = input

      const cancelSignal = context?.cancelSignal
      if (cancelSignal?.aborted) {
        throw cancelSignal.reason ?? new DOMException('Sleep cancelled before it started', 'AbortError')
      }

      await new Promise<void>((resolve, reject) => {
        function cleanup(): void {
          if (cancelSignal) {
            cancelSignal.removeEventListener('abort', onAbort)
          }
        }
        function onAbort(): void {
          globalThis.clearTimeout(timer)
          cleanup()
          reject(cancelSignal?.reason ?? new DOMException('Sleep cancelled', 'AbortError'))
        }

        const timer = globalThis.setTimeout(() => {
          cleanup()
          resolve()
        }, duration * 1000)

        if (cancelSignal) {
          cancelSignal.addEventListener('abort', onAbort, { once: true })
          // Re-check after attaching: the signal may have aborted between the
          // pre-flight check and here, and abort listeners do not fire for
          // events dispatched before they were added.
          if (cancelSignal.aborted) {
            onAbort()
          }
        }
      })

      return `Slept for ${duration} seconds`
    },
  })
}
