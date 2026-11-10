/**
 * Logging types for the Strands SDK.
 */

/**
 * Logger interface.
 *
 * Compatible with standard logging libraries like Pino, Winston, and console.
 */
export interface Logger {
  /**
   * Log a debug message.
   */
  debug(...args: unknown[]): void

  /**
   * Log an info message.
   */
  info(...args: unknown[]): void

  /**
   * Log a warning message.
   */
  warn(...args: unknown[]): void

  /**
   * Log an error message.
   */
  error(...args: unknown[]): void
}
