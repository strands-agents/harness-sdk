/**
 * Shared types and constants for the Python REPL tool.
 */

export const PYTHON_REPL_DESCRIPTION =
  'Executes Python code and returns output (stdout), error (stderr), and exit_code (non-zero means the ' +
  'code failed). Each call runs in a fresh interpreter; variables, imports, and definitions do not persist ' +
  'across calls. Files written to the working directory persist while the sandbox is alive, so save ' +
  'intermediate results to files when later calls need them. stdin is not available (input() fails). ' +
  'Use print() to surface values.'

/**
 * Error thrown when the sandbox fails to run the Python code.
 *
 * Thrown for sandbox-level failures (for example, an unreachable container), not for
 * errors in the code itself; those are reported through `error` and a non-zero `exit_code`.
 * The underlying sandbox error is available as `cause`.
 */
export class PythonReplError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PythonReplError'
  }
}

/**
 * Output of a Python REPL execution. Mirrors the Python SDK's `PythonReplOutput`.
 */
export interface PythonReplOutput {
  /**
   * Standard output captured from the interpreter.
   */
  output: string

  /**
   * Standard error captured from the interpreter, including tracebacks. Empty when there was none.
   */
  error: string

  /**
   * Exit code of the interpreter. Non-zero means the code failed.
   */
  exit_code: number

  /**
   * Allow indexing with string keys for JSONValue compatibility.
   */
  [key: string]: string | number
}
