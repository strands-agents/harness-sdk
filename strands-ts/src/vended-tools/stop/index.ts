/**
 * Tool for gracefully ending the agent loop.
 *
 * Provides {@link makeStop} (a factory for customized stop tools) and {@link stop}
 * (the default instance). The tool calls
 * `agent.cancel({ message, afterCurrentTools: true })`: any sibling tools in the
 * same batch run to completion, then the loop exits with
 * `stopReason: 'cancelled'` and the message as the final assistant message.
 * The same message is returned as the tool result the model sees for its stop
 * request.
 */

export { stop, makeStop } from './stop.js'
export type { MakeStopOptions } from './stop.js'
export { DEFAULT_MAX_STOP_MESSAGE_LENGTH, DEFAULT_STOP_DESCRIPTION, DEFAULT_STOP_MESSAGE } from './types.js'
export type { StopInput } from './types.js'
