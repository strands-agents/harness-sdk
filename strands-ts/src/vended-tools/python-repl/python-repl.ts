/**
 * Python REPL tool: run Python through a sandbox.
 *
 * Provides {@link makePythonRepl} (a factory for a sandbox-routed Python tool) and
 * {@link pythonRepl} (the default instance that uses the agent's sandbox).
 * Each call pipes the code to a fresh interpreter process in the sandbox,
 * so variables, imports, and definitions do not persist across calls.
 * Files written to the sandbox filesystem persist for as long as the sandbox does,
 * so code can checkpoint intermediate results to disk.
 */

import { z } from 'zod'
import { tool } from '../../tools/tool-factory.js'
import { Sandbox } from '../../sandbox/base.js'
import { LANGUAGE_PATTERN } from '../../sandbox/constants.js'
import { SandboxAbortError, SandboxTimeoutError } from '../../sandbox/errors.js'
import { PYTHON_REPL_DESCRIPTION, PythonReplError, type PythonReplOutput } from './types.js'

const DEFAULT_LANGUAGE = 'python3'
const DEFAULT_TIMEOUT = 120

const pythonReplInputSchema = z.object({
  code: z.string().describe('Python source to execute.'),
  timeout: z
    .number()
    .positive({ error: (iss) => `timeout must be a positive number of seconds, got ${String(iss.input)}` })
    .optional()
    .describe('Timeout in seconds (default: 120). Must be positive.'),
})

/**
 * Options for {@link makePythonRepl}.
 */
export interface MakePythonReplOptions {
  /**
   * Tool name. Defaults to `"python_repl"`.
   */
  name?: string

  /**
   * Tool description shown to the model.
   */
  description?: string

  /**
   * Python interpreter used to run the code. Defaults to `"python3"`.
   */
  language?: string
}

/**
 * Resolve the `makePythonRepl` overloads. If a sandbox is passed, it's bound at creation time.
 * Otherwise, the tool reads from `context.agent.sandbox` at call time.
 */
function resolvePythonReplArgs(
  sandboxOrOptions?: Sandbox | MakePythonReplOptions,
  maybeOptions?: MakePythonReplOptions
): { boundSandbox: Sandbox | undefined; options: MakePythonReplOptions } {
  const boundSandbox = sandboxOrOptions instanceof Sandbox ? sandboxOrOptions : undefined
  const options = sandboxOrOptions instanceof Sandbox || maybeOptions ? (maybeOptions ?? {}) : (sandboxOrOptions ?? {})
  return { boundSandbox, options }
}

/**
 * Create a sandbox-routed Python REPL tool.
 *
 * If a sandbox is passed, it is bound at creation time. Otherwise the tool reads
 * `context.agent.sandbox` at call time.
 *
 * The tool throws {@link SandboxTimeoutError} when execution exceeds `timeout`, with the partial
 * output appended to the message as JSON using the success field names and `exit_code` 124,
 * {@link PythonReplError} when the sandbox fails to run the code, and rethrows `SandboxAbortError`
 * when the agent cancels the call.
 *
 * @param sandbox - Sandbox to bind at creation. When omitted, the agent's sandbox is used at call time.
 * @param options - Tool name, description, and interpreter.
 * @returns A tool that executes Python code through the sandbox.
 * @throws Error if `name` is empty or `language` contains invalid characters.
 */
export function makePythonRepl(options?: MakePythonReplOptions): ReturnType<typeof tool>
export function makePythonRepl(sandbox: Sandbox | undefined, options?: MakePythonReplOptions): ReturnType<typeof tool>
export function makePythonRepl(
  sandboxOrOptions?: Sandbox | MakePythonReplOptions,
  maybeOptions?: MakePythonReplOptions
): ReturnType<typeof tool> {
  const { boundSandbox, options } = resolvePythonReplArgs(sandboxOrOptions, maybeOptions)
  const name = options.name ?? 'python_repl'
  const language = options.language ?? DEFAULT_LANGUAGE

  if (!name) {
    throw new Error('name must be a non-empty string')
  }
  // Sandboxes validate this too, but only at call time; fail at construction instead.
  if (!LANGUAGE_PATTERN.test(language)) {
    throw new Error(`language contains invalid characters: ${language}`)
  }

  return tool({
    name,
    description: options.description ?? PYTHON_REPL_DESCRIPTION,
    inputSchema: pythonReplInputSchema,
    callback: async (input, context): Promise<PythonReplOutput> => {
      if (!context) {
        throw new Error('Tool context is required for python_repl operations')
      }

      const sandbox = boundSandbox ?? context.agent.sandbox
      try {
        const result = await sandbox.executeCode(input.code, language, {
          timeout: input.timeout ?? DEFAULT_TIMEOUT,
          signal: context.cancelSignal,
        })
        return { output: result.stdout, error: result.stderr, exit_code: result.exitCode }
      } catch (err) {
        // Let cancellation propagate as-is rather than reporting it as a sandbox failure.
        if (err instanceof SandboxAbortError) throw err
        if (err instanceof SandboxTimeoutError) {
          // Thrown errors reach the model as `Error: <message>`, so the partial output rides in the message.
          const partial: PythonReplOutput = { output: err.stdout, error: err.stderr, exit_code: 124 }
          err.message = `${err.message}\n${JSON.stringify(partial)}`
          throw err
        }
        throw new PythonReplError(err instanceof Error ? err.message : String(err), { cause: err })
      }
    },
  })
}

/**
 * Default Python REPL tool. Reads the sandbox from the agent's context at call time.
 */
export const pythonRepl = makePythonRepl()
