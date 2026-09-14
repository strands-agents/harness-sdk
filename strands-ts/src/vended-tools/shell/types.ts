/**
 * Type definitions for the sandbox-routed shell tool.
 *
 * The Shell* errors extend the Bash* errors from `../bash/types.js` so that
 * callers who caught the pre-rename error types keep working.
 */

import { BashTimeoutError, BashSessionError } from '../bash/types.js'

export const SANDBOX_SHELL_DESCRIPTION =
  'Executes shell commands and returns output (stdout), error (stderr), and exit_code (non-zero means the ' +
  'command failed). Each call runs in a fresh shell; ' +
  'state such as variables and the working directory does not persist across calls.'

/**
 * Error thrown when a sandbox-routed shell command exceeds its timeout.
 *
 * Extends {@link BashTimeoutError} so that callers who caught the previous error
 * type keep working; new code should catch this instead.
 */
export class ShellTimeoutError extends BashTimeoutError {
  constructor(message: string) {
    super(message)
    this.name = 'ShellTimeoutError'
  }
}

/**
 * Error thrown when a sandbox-routed shell command fails.
 *
 * Extends {@link BashSessionError} so that callers who caught the previous error
 * type keep working; new code should catch this instead.
 */
export class ShellExecutionError extends BashSessionError {
  constructor(message: string) {
    super(message)
    this.name = 'ShellExecutionError'
  }
}

/**
 * Output format for shell command execution. Declared standalone; mirrors the
 * Python SDK's `ShellOutput`.
 */
export interface ShellOutput {
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
   * Exit code of the command. Non-zero means the command failed.
   */
  exit_code: number

  /**
   * Allow indexing with string keys for JSONValue compatibility.
   */
  [key: string]: string | number
}
