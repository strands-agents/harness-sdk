/**
 * Sandbox-routed shell tool.
 *
 * `makeShell` builds a stateless tool that routes commands through a
 * [Sandbox](../../sandbox/base.ts), which runs `sh` locally and in Docker or
 * the remote login shell over SSH. Each call runs in a fresh shell; state such
 * as variables and the working directory does not persist across calls.
 *
 * The persistent, host-spawned `bash` tool lives in `../bash`.
 */

export { makeShell, makeBash } from './make-shell.js'
export type { MakeShellOptions, MakeBashOptions } from './make-shell.js'
export { SANDBOX_SHELL_DESCRIPTION, ShellTimeoutError, ShellExecutionError } from './types.js'
export type { ShellOutput } from './types.js'
