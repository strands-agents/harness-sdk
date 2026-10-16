/**
 * Type definitions for the stop tool.
 */

import { z } from 'zod'

/**
 * Default assistant-facing message appended when the loop ends and the model
 * called `stop` without providing its own message.
 */
export const DEFAULT_STOP_MESSAGE = 'Agent loop stopped.'

/**
 * Description shown to the model for the `stop` tool.
 */
export const DEFAULT_STOP_DESCRIPTION =
  'Gracefully ends the agent loop when the task is complete. ' +
  'Call this tool once with an optional final message when no further work is needed. ' +
  'This is a cooperative stop, not an abort: any tools already requested in this turn still run.'

/**
 * Default cap on the optional `message` argument, in characters. The cap
 * exists so a runaway model can't blow the conversation history in one shot;
 * override it via `makeStop({ maxMessageLength: ... })` when a longer summary
 * is legitimate.
 */
export const DEFAULT_MAX_STOP_MESSAGE_LENGTH = 4096

/**
 * Build the Zod schema for the stop tool input at a configured message-length
 * cap. Single source of truth for the input shape; {@link StopInput} is derived
 * from the default-capped schema.
 *
 * `message` is optional and length-capped to keep a runaway model from
 * flooding the conversation with an unbounded final string. It also accepts
 * `null` for providers that serialize omitted fields as JSON null.
 */
export function buildStopInputSchema(maxMessageLength: number): z.ZodObject<{
  message: z.ZodOptional<z.ZodNullable<z.ZodString>>
}> {
  return z.object({
    message: z
      .string()
      .max(maxMessageLength, {
        message: `\`message\` length exceeds the maximum of ${maxMessageLength} characters`,
      })
      .nullable()
      .optional()
      .describe(
        "Optional final message summarizing why the loop is ending. Appears as the loop's last assistant turn."
      ),
  })
}

/**
 * Default Zod schema for the stop tool input, capped at
 * {@link DEFAULT_MAX_STOP_MESSAGE_LENGTH}.
 */
export const stopInputSchema = buildStopInputSchema(DEFAULT_MAX_STOP_MESSAGE_LENGTH)

/**
 * Input parameters for the stop tool. Derived from {@link stopInputSchema}
 * so the two cannot drift.
 */
export type StopInput = z.infer<typeof stopInputSchema>
