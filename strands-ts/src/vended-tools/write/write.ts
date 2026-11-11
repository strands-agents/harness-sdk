/**
 * Sandbox-routed write tool.
 *
 * Creates or overwrites a text file through a [Sandbox](../../sandbox/base.ts):
 * either one bound at creation (as the built-in Docker/SSH sandboxes do when
 * vending tools) or the agent's configured sandbox read from
 * `context.agent.sandbox` at call time.
 *
 * Pairs with the companion `read` and `edit` vended tools.
 */

import { tool } from '../../tools/tool-factory.js'
import { z } from 'zod'
import { Sandbox } from '../../sandbox/base.js'
import { validateAbsolutePath } from '../paths.js'

/**
 * Default model-facing description of the write tool.
 */
export const DEFAULT_WRITE_DESCRIPTION =
  'Create or overwrite a text file with the full provided content. Files must use absolute paths.'

const writeInputSchema = z.object({
  path: z.string().describe('Absolute path to the file.'),
  content: z.string().describe('The full file content to write.'),
})

/**
 * Options for {@link makeWrite}.
 */
export interface MakeWriteOptions {
  /** Tool name. Defaults to `'write'`. */
  name?: string
  /** Description shown to the model. Defaults to {@link DEFAULT_WRITE_DESCRIPTION}. */
  description?: string
}

/**
 * Create a sandbox-routed write tool that reads the sandbox from `context.agent.sandbox` at call time.
 * The returned tool throws at call time when `path` is not absolute or contains `..` segments.
 *
 * @param options - Tool name and description overrides.
 * @returns A tool that creates or overwrites a file through the sandbox.
 */
export function makeWrite(options?: MakeWriteOptions): ReturnType<typeof tool>
/**
 * Create a write tool bound to a sandbox at creation time. Used by sandbox implementations in
 * `getTools()` and by users who want a customized write tool. The returned tool throws at call time when
 * `path` is not absolute or contains `..` segments.
 *
 * @param sandbox - Sandbox to bind. When `undefined`, the agent's sandbox is used at call time.
 * @param options - Tool name and description overrides.
 * @returns A tool that creates or overwrites a file through the sandbox.
 */
export function makeWrite(sandbox: Sandbox | undefined, options?: MakeWriteOptions): ReturnType<typeof tool>
export function makeWrite(
  sandboxOrOptions?: Sandbox | MakeWriteOptions,
  maybeOptions?: MakeWriteOptions
): ReturnType<typeof tool> {
  const boundSandbox = sandboxOrOptions instanceof Sandbox ? sandboxOrOptions : undefined
  const options = sandboxOrOptions instanceof Sandbox || maybeOptions ? (maybeOptions ?? {}) : (sandboxOrOptions ?? {})

  return tool({
    name: options.name ?? 'write',
    description: options.description ?? DEFAULT_WRITE_DESCRIPTION,
    inputSchema: writeInputSchema,
    callback: async (input, context) => {
      if (!context) throw new Error('Tool context is required for write operations')
      validateAbsolutePath(input.path)
      const sandbox = boundSandbox ?? context.agent.sandbox

      await sandbox.writeText(input.path, input.content)
      const lineCount = input.content === '' ? 0 : input.content.split('\n').length
      const noun = lineCount === 1 ? 'line' : 'lines'
      return `Wrote ${lineCount} ${noun} to ${input.path}.`
    },
  })
}

/**
 * Default write tool. Reads the sandbox from the agent's context at call time.
 */
export const write = makeWrite()
