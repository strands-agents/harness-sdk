/**
 * Shared experimental warning for A2A protocol modules.
 */

import { logger } from '../logging/logger.js'

let _logged = false

/**
 * Logs a one-time warning that the A2A protocol is experimental.
 */
export function logExperimentalWarning(): void {
  if (!_logged) {
    _logged = true
    logger.warn(
      'protocol=<a2a> | experimental, breaking changes in the underlying sdk may require breaking changes in this module'
    )
  }
}
