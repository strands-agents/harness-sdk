/**
 * Logger configuration.
 *
 * This module provides simple logging infrastructure for the Strands SDK.
 * Users can inject their own logger implementation to control logging behavior.
 */

import type { Logger } from './types.js'

/**
 * Default logger implementation.
 *
 * Only logs warnings and errors to console. Debug and info are no-ops.
 */
const defaultLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
}

/**
 * Global logger instance.
 */
export let logger: Logger = defaultLogger

/**
 * Configures the global logger.
 *
 * Allows users to inject their own logger implementation (e.g., Pino, Winston)
 * to control logging behavior, levels, and formatting.
 *
 * @param customLogger - The logger implementation to use
 *
 * @example
 * ```typescript
 * import pino from 'pino'
 * import { configureLogging } from '@strands-agents/sdk'
 *
 * const logger = pino({ level: 'debug' })
 * configureLogging(logger)
 * ```
 */
export function configureLogging(customLogger: Logger): void {
  logger = customLogger
}
