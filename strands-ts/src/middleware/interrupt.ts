import { Interrupt, InterruptError } from '../interrupt.js'

import type { InterruptState } from '../interrupt.js'
import type { InterruptParams } from '../types/interrupt.js'
import type { JSONValue } from '../types/json.js'
import type { MiddlewareInterruptResult } from './stages.js'

/**
 * Creates a non-mutating interrupt function backed by the provided interrupt state.
 *
 * Existing responses are read from state, but new interrupts remain local until
 * the caller handles the thrown {@link InterruptError}.
 *
 * @param interruptState - State used to resolve prior responses
 * @param idPrefix - Prefix used to construct the interrupt identifier
 * @param priorResponses - Optional snapshot of interrupts to resolve prior responses from,
 *   instead of the live `interruptState.interrupts`.
 * @returns Interrupt function for a middleware context
 *
 * @internal
 */
export function createMiddlewareInterrupt(
  interruptState: InterruptState,
  idPrefix: string,
  priorResponses?: Readonly<Record<string, Interrupt>>
): <T = JSONValue>(params: InterruptParams) => MiddlewareInterruptResult<T> {
  return <T = JSONValue>(params: InterruptParams): MiddlewareInterruptResult<T> => {
    const interruptId = `${idPrefix}:${params.name}`
    const existing = (priorResponses ?? interruptState.interrupts)[interruptId]
    if (existing?.response !== undefined) {
      return { response: existing.response as T }
    }
    if (params.response !== undefined) {
      return { response: params.response as T }
    }
    const interrupt = new Interrupt({
      id: interruptId,
      name: params.name,
      ...(params.reason !== undefined && { reason: params.reason }),
      source: 'middleware',
    })
    throw new InterruptError(interrupt)
  }
}
