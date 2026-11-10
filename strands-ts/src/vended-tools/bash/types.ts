/**
 * Type definitions for the persistent bash tool.
 *
 * The sandbox-routed shell tool's types live in `../shell/types.js`; its error
 * classes extend the ones here so pre-rename catch clauses keep matching.
 */

/**
 * Input parameters for execute operation.
 */
export interface ExecuteInput {
  /**
   * Operation mode, must be 'execute'.
   */
  mode: 'execute'

  /**
   * The bash command to execute.
   */
  command: string

  /**
   * Timeout in seconds for the command execution.
   * Defaults to 120 seconds.
   */
  timeout?: number
}

/**
 * Input parameters for restart operation.
 */
export interface RestartInput {
  /**
   * Operation mode, must be 'restart'.
   */
  mode: 'restart'
}

/**
 * Union type of all valid bash tool inputs.
 */
export type BashInput = ExecuteInput | RestartInput

/**
 * Output format for bash command execution.
 */
export interface BashOutput {
  /**
   * Standard output from the command.
   */
  output: string

  /**
   * Standard error from the command.
   * Empty string if no errors occurred.
   */
  error: string

  /**
   * Allow indexing with string keys for JSONValue compatibility.
   */
  [key: string]: string
}

/**
 * Error thrown when a bash command exceeds its timeout.
 */
export class BashTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BashTimeoutError'
  }
}

/**
 * Error thrown when a bash session encounters an error.
 */
export class BashSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BashSessionError'
  }
}
