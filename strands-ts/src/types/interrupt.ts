/**
 * Interrupt-related type definitions for human-in-the-loop workflows.
 *
 * These types define the data structures used when invoking agents with
 * interrupt responses to resume execution.
 */

import type { JSONValue } from './json.js'
import type { JSONSerializable } from './json.js'

/**
 * Parameters for raising an interrupt.
 */
export interface InterruptParams {
  /**
   * User-defined name for the interrupt.
   * Must be unique within a single hook callback or tool execution.
   */
  name: string

  /**
   * User-provided reason for the interrupt.
   */
  reason?: JSONValue

  /**
   * Preemptive response to use if available.
   * When provided, the interrupt returns this value immediately without
   * halting agent execution. Useful for session-managed trust responses
   * where a previous user response can be reused.
   *
   * @example
   * ```typescript
   * // If user already approved in a previous session, skip the interrupt
   * const approval = context.interrupt({
   *   name: 'confirm_delete',
   *   reason: 'Confirm deletion?',
   *   response: agent.appState['savedApproval'],
   * })
   * ```
   */
  response?: JSONValue
}

/**
 * User response to an interrupt.
 */
export interface InterruptResponse {
  /**
   * Unique identifier of the interrupt being responded to.
   */
  interruptId: string

  /**
   * User's response to the interrupt.
   */
  response: JSONValue
}

/**
 * Data format for a content block containing a user response to an interrupt.
 */
export interface InterruptResponseContentData {
  /**
   * The interrupt response data.
   */
  interruptResponse: InterruptResponse
}

/**
 * Content block containing a user response to an interrupt.
 * Used when invoking an agent to resume from an interrupted state.
 *
 * @example
 * ```typescript
 * const content = new InterruptResponseContent({
 *   interruptId: interrupt.id,
 *   response: 'approved',
 * })
 * ```
 */
export class InterruptResponseContent
  implements InterruptResponseContentData, JSONSerializable<InterruptResponseContentData>
{
  /**
   * Discriminator for interrupt response content blocks.
   */
  readonly type = 'interruptResponseContent' as const

  /**
   * The interrupt response data.
   */
  readonly interruptResponse: InterruptResponse

  constructor(data: InterruptResponse) {
    this.interruptResponse = data
  }

  /**
   * Serializes to a JSON-compatible {@link InterruptResponseContentData} object.
   * Called automatically by `JSON.stringify()`.
   */
  toJSON(): InterruptResponseContentData {
    return { interruptResponse: this.interruptResponse }
  }

  /**
   * Creates an InterruptResponseContent instance from data.
   *
   * @param data - Data to deserialize
   * @returns InterruptResponseContent instance
   */
  static fromJSON(data: InterruptResponseContentData): InterruptResponseContent {
    return new InterruptResponseContent(data.interruptResponse)
  }
}

/**
 * Type guard that checks whether a value is an {@link InterruptResponseContent}.
 *
 * @internal
 */
export function isInterruptResponseContent(value: unknown): value is InterruptResponseContent {
  if (value instanceof InterruptResponseContent) {
    return true
  }
  if (typeof value !== 'object' || value === null || !('interruptResponse' in value)) {
    return false
  }
  const { interruptResponse } = value as InterruptResponseContentData
  return typeof interruptResponse === 'object' && interruptResponse !== null && 'interruptId' in interruptResponse
}
