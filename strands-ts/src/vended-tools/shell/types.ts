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

/** Description for the shell tool when it returns `{ stdout, stderr, exit_code }`. */
export const SANDBOX_SHELL_STDIO_DESCRIPTION =
  'Executes shell commands and returns stdout, stderr, and exit_code (non-zero means the command failed). ' +
  'Each call runs in a fresh shell; ' +
  'state such as variables and the working directory does not persist across calls.'

/** Key names for the shell tool's result: `{ output, error, exit_code }` or `{ stdout, stderr, exit_code }`. */
export type ShellResultKeys = 'output_error' | 'stdout_stderr'

/**
 * Error thrown when a sandbox-routed shell command exceeds its timeout.
 *
 * Extends {@link BashTimeoutError} so that callers who caught the previous error
 * type keep working; new code should catch this instead.
 */
export class ShellTimeoutError<T extends ShellOutput | ShellStdioOutput = ShellOutput> extends BashTimeoutError {
  /** Output captured before the command was killed, when the sandbox reported it. Keys follow `resultKeys`. */
  readonly partial?: T

  constructor(message: string, partial?: T) {
    super(message)
    this.name = 'ShellTimeoutError'
    if (partial) this.partial = partial
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

/**
 * Output format for shell command execution with `resultKeys: 'stdout_stderr'`. Mirrors the
 * Python SDK's `ShellStdioOutput`.
 */
export interface ShellStdioOutput {
  /**
   * Standard output from the command.
   */
  stdout: string

  /**
   * Standard error from the command. Not a failure signal; check `exit_code`.
   */
  stderr: string

  /**
   * Exit code of the command. Non-zero means the command failed.
   */
  exit_code: number

  /**
   * Allow indexing with string keys for JSONValue compatibility.
   */
  [key: string]: string | number
}
