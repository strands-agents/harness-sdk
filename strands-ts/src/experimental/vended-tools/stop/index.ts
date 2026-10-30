/**
 * The stop tool has moved to production. Import from
 * `@strands-agents/sdk/vended-tools/stop` instead; this path will be removed.
 */

import {
  stop as _stop,
  makeStop as _makeStop,
  DEFAULT_MAX_STOP_MESSAGE_LENGTH as _DEFAULT_MAX_STOP_MESSAGE_LENGTH,
  DEFAULT_STOP_DESCRIPTION as _DEFAULT_STOP_DESCRIPTION,
  DEFAULT_STOP_MESSAGE as _DEFAULT_STOP_MESSAGE,
} from '../../../vended-tools/stop/index.js'

/** @deprecated Moved to `@strands-agents/sdk/vended-tools/stop`. */
export const stop = _stop
/** @deprecated Moved to `@strands-agents/sdk/vended-tools/stop`. */
export const makeStop = _makeStop
/** @deprecated Moved to `@strands-agents/sdk/vended-tools/stop`. */
export const DEFAULT_MAX_STOP_MESSAGE_LENGTH = _DEFAULT_MAX_STOP_MESSAGE_LENGTH
/** @deprecated Moved to `@strands-agents/sdk/vended-tools/stop`. */
export const DEFAULT_STOP_DESCRIPTION = _DEFAULT_STOP_DESCRIPTION
/** @deprecated Moved to `@strands-agents/sdk/vended-tools/stop`. */
export const DEFAULT_STOP_MESSAGE = _DEFAULT_STOP_MESSAGE
/** @deprecated Moved to `@strands-agents/sdk/vended-tools/stop`. */
export type { MakeStopOptions, StopInput } from '../../../vended-tools/stop/index.js'
