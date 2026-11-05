/**
 * Error types for sandbox command and code execution.
 *
 * These are runtime throwables raised by sandbox execution; consumers can
 * branch on them via `instanceof` to distinguish timeouts from aborts.
 */

/**
 * Thrown by sandbox execution when the configured `timeout` elapses.
 *
 * `stdout` and `stderr` hold whatever the process wrote before it was killed.
 */
export class SandboxTimeoutError extends Error {
  constructor(
    seconds: number,
    readonly stdout = '',
    readonly stderr = ''
  ) {
    super(`Execution timed out after ${seconds} seconds`)
    this.name = 'SandboxTimeoutError'
  }
}

/**
 * Thrown by sandbox execution when the abort signal fires.
 */
export class SandboxAbortError extends Error {
  constructor() {
    super('Execution aborted')
    this.name = 'SandboxAbortError'
  }
}

/**
 * Thrown by {@link Sandbox.listFiles} when the path does not exist, distinguishing
 * genuine absence from permission or transport failures (which throw plain errors).
 */
export class SandboxPathNotFoundError extends Error {
  constructor(path: string) {
    super(`Path not found: ${path}`)
    this.name = 'SandboxPathNotFoundError'
  }
}
