/**
 * Persistent bash tool for Node.js environments.
 *
 * `bash` spawns a persistent bash process on the host and keeps state across
 * calls. The stateless, sandbox-routed shell tool lives in `../shell`; its
 * names are re-exported here so pre-rename imports through this path keep
 * working until v2.0.0.
 */

import { SANDBOX_SHELL_DESCRIPTION } from '../shell/types.js'

export { bash } from './bash.js'
export { BashTimeoutError, BashSessionError } from './types.js'
export type { BashInput, BashOutput, ExecuteInput, RestartInput } from './types.js'

export { makeShell, makeBash } from '../shell/make-shell.js'
export type { MakeShellOptions, MakeBashOptions } from '../shell/make-shell.js'
export { SANDBOX_SHELL_DESCRIPTION, ShellTimeoutError, ShellExecutionError } from '../shell/types.js'

/**
 * @deprecated SANDBOX_BASH_DESCRIPTION is deprecated and will be removed in v2.0.0. Use SANDBOX_SHELL_DESCRIPTION instead. The tool routes commands through the sandbox, which runs sh or the remote login shell rather than bash specifically.
 */
export const SANDBOX_BASH_DESCRIPTION = SANDBOX_SHELL_DESCRIPTION
