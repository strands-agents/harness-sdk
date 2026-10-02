import { tool } from '../../../tools/tool-factory.js'
import {
  DEFAULT_MAX_STOP_MESSAGE_LENGTH,
  DEFAULT_STOP_DESCRIPTION,
  DEFAULT_STOP_MESSAGE,
  buildStopInputSchema,
} from './types.js'

/**
 * Options accepted by {@link makeStop}.
 */
export interface MakeStopOptions {
  /**
   * Tool name shown to the model. Defaults to `'stop'`.
   */
  name?: string
  /**
   * Tool description shown to the model. Defaults to {@link DEFAULT_STOP_DESCRIPTION}.
   */
  description?: string
  /**
   * Maximum accepted length for the model-supplied `message` argument, in
   * characters. Must be a positive integer. Defaults to
   * {@link DEFAULT_MAX_STOP_MESSAGE_LENGTH} (4096).
   */
  maxMessageLength?: number
}

/**
 * Create a stop tool that gracefully ends the agent loop.
 *
 * **Experimental** — this tool is subject to change in future revisions without notice.
 *
 * Calls `agent.cancel({ message, afterCurrentTools: true })`, so the rest of the
 * current tool batch runs to completion and the loop then ends with
 * `stopReason: 'cancelled'` and the message as the final assistant message.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { stop } from '@strands-agents/sdk/experimental/vended-tools/stop'
 *
 * const agent = new Agent({ model, tools: [stop] })
 * ```
 */
export function makeStop(options?: MakeStopOptions): ReturnType<typeof tool> {
  const maxMessageLength = options?.maxMessageLength ?? DEFAULT_MAX_STOP_MESSAGE_LENGTH
  if (!Number.isInteger(maxMessageLength) || maxMessageLength <= 0) {
    throw new Error(`maxMessageLength must be a positive integer, got ${String(maxMessageLength)}`)
  }
  return tool({
    name: options?.name ?? 'stop',
    description: options?.description ?? DEFAULT_STOP_DESCRIPTION,
    inputSchema: buildStopInputSchema(maxMessageLength),
    callback: (input, context) => {
      if (!context) {
        throw new Error('Tool context is required for stop operations')
      }

      // Fall back to the default when message is absent (undefined or null,
      // e.g. from providers that serialize omitted fields as null) OR empty.
      // An empty message would leave the loop without a final assistant message.
      const message = input.message != null && input.message.length > 0 ? input.message : DEFAULT_STOP_MESSAGE

      context.agent.cancel({ message, afterCurrentTools: true })

      return message
    },
  })
}

/**
 * Default stop tool.
 *
 * **Experimental** — this tool is subject to change in future revisions without notice.
 *
 * Ends the agent loop cooperatively when called by the model. Any tools the
 * model requested alongside `stop` in the same turn still run to completion —
 * the loop halts after the batch, without calling the model again.
 */
export const stop = makeStop()
