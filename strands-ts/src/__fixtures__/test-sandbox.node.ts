import { buildShellEnvPrefix, PosixShellSandbox } from '../sandbox/posix-shell.js'
import { shellQuote } from '../sandbox/constants.js'
import { streamProcess } from '../sandbox/stream-process.js'
import type { ExecuteOptions } from '../sandbox/base.js'
import type { ExecutionResult, StreamChunk } from '../sandbox/types.js'

/**
 * Test sandbox that executes commands within a specific working directory.
 *
 * Extends PosixShellSandbox so it exercises the same code paths real sandboxes
 * use: base64 file encoding, shell quoting, ls parsing, etc.
 */
export class TestSandbox extends PosixShellSandbox {
  readonly workingDir: string

  constructor(workingDir: string) {
    super()
    this.workingDir = workingDir
  }

  async *executeStreaming(
    command: string,
    options?: ExecuteOptions
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    const cwd = options?.cwd ?? this.workingDir
    const envPrefix = buildShellEnvPrefix(options?.env)
    const fullCommand = `cd ${shellQuote(cwd)} && ${envPrefix}${command}`
    yield* streamProcess('sh', ['-c', fullCommand], { timeout: options?.timeout, signal: options?.signal })
  }
}
