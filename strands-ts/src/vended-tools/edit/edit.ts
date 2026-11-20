/**
 * Sandbox-routed edit tool.
 *
 * Replaces an exact, unique string in a text file through a
 * [Sandbox](../../sandbox/base.ts): either one bound at creation (as the
 * built-in Docker/SSH sandboxes do when vending tools) or the agent's
 * configured sandbox read from `context.agent.sandbox` at call time.
 */

import { tool } from '../../tools/tool-factory.js'
import { z } from 'zod'
import { Sandbox } from '../../sandbox/base.js'
import { validateAbsolutePath } from '../paths.js'

/**
 * Default model-facing description of the edit tool.
 */
export const DEFAULT_EDIT_DESCRIPTION =
  'Replace an exact string in a text file. `old_str` must appear in the file exactly once. Files must use absolute paths.'

// The model writes LF and cannot see a file's CRLF, so any line break matches either.
const LINE_BREAK = /\r?\n/g

/**
 * Return the ending of the line containing `index`, or of the last line break before it.
 */
function lineEndingAt(content: string, index: number): string {
  let newline = content.indexOf('\n', index)
  if (newline === -1) newline = content.lastIndexOf('\n')
  return newline > 0 && content[newline - 1] === '\r' ? '\r\n' : '\n'
}

const editInputSchema = z.object({
  path: z.string().describe('Absolute path to the file.'),
  old_str: z.string().describe('Exact text to find. Must be unique within the file.'),
  new_str: z.string().describe('Replacement text.'),
})

/**
 * Options for {@link makeEdit}.
 */
export interface MakeEditOptions {
  /** Tool name. Defaults to `'edit'`. */
  name?: string
  /** Description shown to the model. Defaults to {@link DEFAULT_EDIT_DESCRIPTION}. */
  description?: string
}

/**
 * Create a sandbox-routed edit tool that reads the sandbox from `context.agent.sandbox` at call time.
 *
 * @param options - Tool name and description overrides.
 * @returns A tool that replaces an exact, unique `old_str` with `new_str` through the sandbox.
 */
export function makeEdit(options?: MakeEditOptions): ReturnType<typeof tool>
/**
 * Create an edit tool bound to a sandbox at creation time. Used by sandbox implementations in
 * `getTools()` and by users who want a customized edit tool.
 *
 * @param sandbox - Sandbox to bind. When `undefined`, the agent's sandbox is used at call time.
 * @param options - Tool name and description overrides.
 * @returns A tool that replaces an exact, unique `old_str` with `new_str` through the sandbox.
 */
export function makeEdit(sandbox: Sandbox | undefined, options?: MakeEditOptions): ReturnType<typeof tool>
export function makeEdit(
  sandboxOrOptions?: Sandbox | MakeEditOptions,
  maybeOptions?: MakeEditOptions
): ReturnType<typeof tool> {
  const boundSandbox = sandboxOrOptions instanceof Sandbox ? sandboxOrOptions : undefined
  const options = sandboxOrOptions instanceof Sandbox || maybeOptions ? (maybeOptions ?? {}) : (sandboxOrOptions ?? {})

  return tool({
    name: options.name ?? 'edit',
    description: options.description ?? DEFAULT_EDIT_DESCRIPTION,
    inputSchema: editInputSchema,
    callback: async (input, context) => {
      if (!context) throw new Error('Tool context is required for edit operations')
      validateAbsolutePath(input.path)
      if (input.old_str === '') throw new Error('old_str must not be empty.')
      const sandbox = boundSandbox ?? context.agent.sandbox

      const content = await sandbox.readText(input.path)
      const pattern = input.old_str
        .split(LINE_BREAK)
        .map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\r?\\n')
      const matches = [...content.matchAll(new RegExp(pattern, 'g'))]
      const match = matches[0]
      if (!match) throw new Error(`old_str did not appear verbatim in ${input.path}.`)
      if (matches.length > 1)
        throw new Error(`old_str appears ${matches.length} times in ${input.path}; make it unique.`)
      const [matched] = match
      const replacement = input.new_str.replace(LINE_BREAK, lineEndingAt(content, match.index))
      await sandbox.writeText(
        input.path,
        content.slice(0, match.index) + replacement + content.slice(match.index + matched.length)
      )
      return `Edited ${input.path}.`
    },
  })
}

/**
 * Default sandbox-routed edit tool. Reads the sandbox from the agent's context at call time.
 */
export const edit = makeEdit()
