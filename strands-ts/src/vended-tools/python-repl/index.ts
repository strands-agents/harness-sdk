/**
 * Python REPL tool for running Python through the agent's sandbox.
 *
 * A thin shim over `Sandbox.executeCode`. Each call runs in a fresh interpreter,
 * so in-memory state does not persist across calls.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { pythonRepl } from '@strands-agents/sdk/vended-tools/python-repl'
 *
 * const agent = new Agent({ tools: [pythonRepl] })
 * ```
 */

export { makePythonRepl, pythonRepl } from './python-repl.js'
export type { MakePythonReplOptions } from './python-repl.js'
export { PYTHON_REPL_DESCRIPTION, PythonReplError } from './types.js'
export type { PythonReplOutput } from './types.js'
