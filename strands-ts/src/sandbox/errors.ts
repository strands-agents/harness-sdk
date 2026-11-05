/**
 * Error types raised by sandbox execution and file operations.
 *
 * Consumers can branch on them via `instanceof`.
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
 * Thrown by {@link Sandbox.listFiles} and `PosixShellSandbox.readFile` when the path does not exist, distinguishing
 * genuine absence from permission failures ({@link SandboxPermissionError} from `readFile`) and transport failures
 * (plain errors).
 *
 * `code` is `'ENOENT'`, so checks written for Node fs errors also match it.
 */
export class SandboxPathNotFoundError extends Error {
  readonly code = 'ENOENT'

  constructor(path: string) {
    super(`Path not found: ${path}`)
    this.name = 'SandboxPathNotFoundError'
  }
}

/**
 * Thrown by `PosixShellSandbox.readFile` when the path is a directory.
 *
 * `code` is `'EISDIR'`, so checks written for Node fs errors also match it.
 */
export class SandboxIsADirectoryError extends Error {
  readonly code = 'EISDIR'

  constructor(path: string) {
    super(`Is a directory: ${path}`)
    this.name = 'SandboxIsADirectoryError'
  }
}

/**
 * Thrown by `PosixShellSandbox.readFile` when the file, or a directory above it, is not accessible.
 *
 * `code` is `'EACCES'`, so checks written for Node fs errors also match it.
 */
export class SandboxPermissionError extends Error {
  readonly code = 'EACCES'

  constructor(path: string) {
    super(`Permission denied: ${path}`)
    this.name = 'SandboxPermissionError'
  }
}
