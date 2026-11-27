import { tool } from '../../tools/tool-factory.js'
import { z } from 'zod'
import type { InvokableTool } from '../../tools/tool.js'
import type { JSONValue } from '../../types/json.js'
import type { HandoffToUserInput } from './types.js'
import { DEFAULT_HANDOFF_TO_USER_DESCRIPTION, HANDOFF_INTERRUPT_NAME } from './types.js'

/**
 * Zod schema for handoff_to_user input validation.
 */
const handoffToUserInputSchema = z.object({
  message: z
    .string()
    .refine((value) => value.trim().length > 0, { message: 'message must not be empty' })
    .describe('The message to surface to the user.'),
})

export interface MakeHandoffToUserOptions {
  name?: string
  description?: string
}

/**
 * Creates a handoff tool that pauses the agent loop and surfaces a message to the user. On
 * first call it interrupts via `context.interrupt`; the human's reply is returned as the
 * tool result on resume.
 *
 * The raised interrupt's `name` is always {@link HANDOFF_INTERRUPT_NAME}, held constant even
 * when the tool is renamed via `makeHandoffToUser({ name })`, so consumers can reliably match
 * handoff interrupts in `AgentResult.interrupts`.
 *
 * @example
 * ```typescript
 * const askUser = makeHandoffToUser({ name: 'ask_user' })
 * const agent = new Agent({ tools: [askUser] })
 * ```
 */
export function makeHandoffToUser(
  options: MakeHandoffToUserOptions = {}
): InvokableTool<HandoffToUserInput, JSONValue> {
  return tool({
    name: options.name ?? 'handoff_to_user',
    description: options.description ?? DEFAULT_HANDOFF_TO_USER_DESCRIPTION,
    inputSchema: handoffToUserInputSchema,
    callback: (input, context) => {
      if (!context) {
        throw new Error('Tool context is required for the handoff-to-user tool')
      }
      return context.interrupt({ name: HANDOFF_INTERRUPT_NAME, reason: input.message })
    },
  })
}

/**
 * Default handoff tool. Pauses the agent loop and surfaces a message to the user.
 */
export const handoffToUser = makeHandoffToUser()
