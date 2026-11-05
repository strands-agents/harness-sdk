/**
 * Docker sandbox — executes commands in a Docker container via `docker exec`.
 */

import type { ExecuteOptions } from './base.js'
import { PosixShellSandbox, validateEnvKeys } from './posix-shell.js'
import { streamProcess } from './stream-process.js'
import type { ExecutionResult, StreamChunk } from './types.js'
import type { Tool } from '../tools/tool.js'
import { makeFileEditor, DEFAULT_FILE_EDITOR_DESCRIPTION } from '../vended-tools/file-editor/index.js'
import { makeShell, SANDBOX_SHELL_DESCRIPTION } from '../vended-tools/shell/index.js'

/**
 * Options for constructing a {@link DockerSandbox}.
 */
export interface DockerSandboxOptions {
  /** ID or name of a running Docker container. */
  container: string
  /**
   * Working directory for executed commands. If omitted, no `-w` flag is set and
   * commands run in the container's configured working directory.
   *
   * Set this to run elsewhere; the path must exist and be writable by the effective {@link user}.
   */
  workingDir?: string
  /**
   * User to run commands as, in `"uid"`, `"uid:gid"`, or `"name"` form. If omitted,
   * no `--user` flag is set and commands run as the container's configured user.
   *
   * Set this to override the container's identity, e.g. `"root"` or `"1000:1000"`.
   */
  user?: string
}

/** Execute commands in a Docker container via `docker exec`. */
export class DockerSandbox extends PosixShellSandbox {
  readonly container: string
  readonly workingDir: string | undefined
  private readonly _user: string | undefined

  constructor(options: DockerSandboxOptions) {
    super()
    this.container = options.container
    this.workingDir = options.workingDir
    this._user = options.user
  }

  async *executeStreaming(
    command: string,
    options?: ExecuteOptions
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    const args = ['exec']

    // Unset user/cwd defer to the container's own configuration.
    if (this._user !== undefined) args.push('--user', this._user)

    const cwd = options?.cwd ?? this.workingDir
    if (cwd !== undefined) args.push('-w', cwd)

    if (options?.env) {
      validateEnvKeys(options.env)
      for (const [key, val] of Object.entries(options.env)) {
        // Values are passed as process argv (not through a shell), so no escaping is
        // needed -- Docker stores them verbatim. This is why values aren't shell-quoted
        // here, unlike the SSH backend which builds a shell command string.
        args.push('-e', `${key}=${val}`)
      }
    }

    // docker exec requires the container and command after all flags. Furthermore, '--'
    // terminates flag parsing so the container is always treated as a positional argument.
    // Without this, a name like '--privileged' would be parsed as a flag, overriding the
    // exec options above.
    args.push('--', this.container, 'sh', '-c', command)

    yield* streamProcess('docker', args, {
      timeout: options?.timeout,
      signal: options?.signal,
      enoentMessage: 'docker is not installed or not on PATH',
    })
  }

  override getTools(): Tool[] {
    const cwd = this.workingDir ? ` Working directory: ${this.workingDir}.` : ''
    return [
      makeFileEditor(this, {
        name: 'sandbox_file_editor',
        description: `${DEFAULT_FILE_EDITOR_DESCRIPTION} Files are in Docker container "${this.container}".`,
      }),
      makeShell(this, {
        name: 'sandbox_shell',
        description: `${SANDBOX_SHELL_DESCRIPTION} Runs in Docker container "${this.container}".${cwd}`,
      }),
    ]
  }
}
