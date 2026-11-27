/**
 * Stable name reported on the raised interrupt (`Interrupt.name`).
 */
export const HANDOFF_INTERRUPT_NAME = 'strands:handoff-to-user'

/**
 * Description for the default handoff_to_user tool.
 */
export const DEFAULT_HANDOFF_TO_USER_DESCRIPTION =
  'Ask the user a question and wait for their answer. Use it only when you cannot proceed ' +
  'without confirmation, approval, or information that only the user has. Do not call it to ' +
  "deliver a final answer or to report progress. The user's reply is returned as the tool result."

/**
 * Input parameters accepted by the handoff_to_user tool.
 */
export interface HandoffToUserInput {
  /**
   * The message to surface to the user. Must be a non-empty (non-whitespace) string.
   */
  message: string
}
