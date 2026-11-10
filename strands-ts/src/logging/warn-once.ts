import type { Logger } from './types.js'

const warned = new Set<string>()

/**
 * Emits a warning log at most once per unique message per process.
 *
 * Subsequent calls with the same message are no-ops, which prevents
 * repeated nudges (e.g. "using default modelId") from flooding logs
 * when many instances are constructed.
 *
 * @param logger - Logger to emit the warning on
 * @param msg - Warning message; also used as the dedupe key
 */
export function warnOnce(logger: Logger, msg: string): void {
  if (warned.has(msg)) return
  logger.warn(msg)
  warned.add(msg)
}
