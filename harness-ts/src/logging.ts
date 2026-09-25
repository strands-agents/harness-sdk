/**
 * Minimal logging helper mirroring the SDK's `logger` + `warnOnce`.
 *
 * The SDK keeps `logger` and `warnOnce` internal (only `configureLogging` and the `Logger` type
 * are exported), so the harness carries its own tiny copy: a console-backed default that emits only
 * warnings and errors, and a per-process dedupe so a repeated nudge doesn't flood the logs.
 */

import type { Logger } from '@strands-agents/sdk'

const defaultLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
}

export let logger: Logger = defaultLogger

/** Replace the logger the harness warns through (e.g. to route into a host app's logger). */
export function configureLogging(customLogger: Logger): void {
  logger = customLogger
}

const warned = new Set<string>()

/** Emit a warning at most once per unique message per process. The message is the dedupe key. */
export function warnOnce(msg: string): void {
  if (warned.has(msg)) {
    return
  }
  logger.warn(msg)
  warned.add(msg)
}

/** Clear the warn-once dedupe set. Intended for tests that assert on repeated warnings. */
export function resetWarnOnce(): void {
  warned.clear()
}
