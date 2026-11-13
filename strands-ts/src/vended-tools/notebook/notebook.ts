import { tool } from '../../index.js'
import { z } from 'zod'
import type { NotebookInput } from './types.js'
import type { InvokableTool } from '../../tools/tool.js'

const DEFAULT_MAX_NOTEBOOK_SIZE_BYTES = 1_048_576 // 1 MiB

/** Modes that mutate `notebooks` state and must be persisted. */
const MUTATING_MODES = new Set(['create', 'write', 'clear'])

/** Modes that can grow state and therefore need size-cap enforcement. */
const GROWING_MODES = new Set(['create', 'write'])

/**
 * Options for {@link makeNotebook}.
 */
export interface MakeNotebookOptions {
  /**
   * Tool name exposed to the model.
   * @defaultValue `"notebook"`
   */
  name?: string
  /**
   * Tool description shown to the model.
   * @defaultValue The built-in notebook description string.
   */
  description?: string
  /**
   * Maximum size of a single notebook's content in bytes (UTF-8 encoded).
   * @defaultValue `1_048_576` (1 MiB)
   */
  maxNotebookSizeBytes?: number
}

/**
 * Creates a notebook tool with a custom name, description, and size cap.
 *
 * @param options - Configuration options for the tool.
 * @returns A tool that manages text notebooks in agent state.
 *
 * @throws Error if `name` is empty or `maxNotebookSizeBytes` is not a positive integer.
 *
 * @example
 * ```typescript
 * const myNotebook = makeNotebook({ name: 'scratchpad', maxNotebookSizeBytes: 65536 })
 * const agent = new Agent({ tools: [myNotebook] })
 * ```
 */
export function makeNotebook({
  name = 'notebook',
  description = 'Manages text notebooks for note-taking and documentation. Supports create, list, read, write (append, replace, or insert), and clear operations. In write mode: newStr alone appends to the end; newStr with oldStr replaces matching text; newStr with insertLine inserts at a position. A write only succeeds on a notebook that already exists: use list to check, or create to start a new one (create replaces any existing content). Notebooks persist within the agent invocation.',
  maxNotebookSizeBytes = DEFAULT_MAX_NOTEBOOK_SIZE_BYTES,
}: MakeNotebookOptions = {}): InvokableTool<NotebookInput, string> {
  if (!name) {
    throw new Error('name must be a non-empty string')
  }
  if (!Number.isInteger(maxNotebookSizeBytes) || maxNotebookSizeBytes < 1) {
    throw new Error('maxNotebookSizeBytes must be a positive integer')
  }

  /**
   * Zod schema for notebook input validation.
   */
  const notebookInputSchema = z
    .object({
      mode: z
        .enum(['create', 'list', 'read', 'write', 'clear'])
        .describe('The operation to perform: `create`, `list`, `read`, `write`, `clear`.'),
      name: z.string().optional().describe('Name of the notebook to operate on. Defaults to "default".'),
      newStr: z
        .string()
        .optional()
        .describe('Text to append, or the new string for replacement and insertion operations.'),
      readRange: z
        .array(z.number())
        .optional()
        .describe('Optional parameter of `read` command. Line range to show [start, end]. Supports negative indices.'),
      oldStr: z.string().optional().describe('String to replace in write mode when doing text replacement.'),
      insertLine: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          'Line number (int) or search text (str) for insertion point in write mode.\nSupports negative indices.'
        ),
    })
    .refine(
      (data) => {
        // Validate write mode requirements
        if (data.mode === 'write') {
          const hasReplacement = data.oldStr !== undefined && data.newStr !== undefined
          const hasInsertion = data.insertLine !== undefined && data.newStr !== undefined
          const hasAppend = data.oldStr === undefined && data.insertLine === undefined && data.newStr !== undefined
          const isAmbiguous = data.oldStr !== undefined && data.insertLine !== undefined
          return (hasReplacement || hasInsertion || hasAppend) && !isAmbiguous
        }
        return true
      },
      {
        message:
          'Write operation requires newStr, optionally with oldStr for replacement or insertLine for insertion; ' +
          'oldStr and insertLine cannot be combined',
      }
    )

  return tool({
    name,
    description,
    inputSchema: notebookInputSchema,
    callback: (input, context) => {
      if (!context) {
        throw new Error('Tool context is required for notebook operations')
      }

      // Get notebooks from state, or initialize if not present
      const notebooksObj = context.agent.appState.get('notebooks')
      let notebooks: Record<string, string>

      if (notebooksObj == null) {
        notebooks = {}
      } else if (typeof notebooksObj === 'object' && !Array.isArray(notebooksObj)) {
        if (Object.values(notebooksObj as object).some((v) => typeof v !== 'string')) {
          throw new Error('Malformed notebooks state: keys and values must be strings')
        }
        notebooks = notebooksObj as Record<string, string>
      } else {
        throw new Error('Malformed notebooks state: expected a plain object')
      }

      // Ensure default notebook exists
      if (Object.keys(notebooks).length === 0) {
        notebooks.default = ''
      }

      let result: string

      switch (input.mode) {
        case 'create':
          result = handleCreate(notebooks, input.name ?? 'default', input.newStr)
          break

        case 'list':
          result = handleList(notebooks)
          break

        case 'read':
          result = handleRead(notebooks, input.name ?? 'default', input.readRange)
          break

        case 'write':
          result = handleWrite(notebooks, input.name ?? 'default', input.oldStr, input.newStr, input.insertLine)
          break

        case 'clear':
          result = handleClear(notebooks, input.name ?? 'default')
          break

        default:
          throw new Error(`Unknown mode: ${input.mode}`)
      }

      if (GROWING_MODES.has(input.mode)) {
        const notebookName = input.name ?? 'default'
        const encoder = new TextEncoder()
        const size = encoder.encode(notebooks[notebookName]).byteLength
        if (size > maxNotebookSizeBytes) {
          throw new Error(
            `Notebook '${notebookName}' content (${size} bytes) would exceed maximum of ${maxNotebookSizeBytes} bytes`
          )
        }
      }

      if (MUTATING_MODES.has(input.mode)) {
        // Persist notebooks back to state
        context.agent.appState.set('notebooks', notebooks)
      }

      return result
    },
  })
}

/**
 * Notebook tool for managing persistent text notebooks.
 *
 * Notebooks are stored in agent state under the 'notebooks' key and persist within an agent session.
 * Supports create, list, read, write (append/replace/insert), and clear operations.
 *
 * @example
 * ```typescript
 * // With agent
 * const agent = new Agent({ tools: [notebook] })
 * await agent.invoke('Create a notebook called "notes"')
 * await agent.invoke('Add "- Task 1" to notes')
 *
 * // Direct usage
 * await notebook.invoke(
 *   { mode: 'create', name: 'notes', newStr: '# Notes' },
 *   { agent: agent, toolUse: { name: 'notebook', toolUseId: 'test', input: {} } }
 * )
 * ```
 */
export const notebook = makeNotebook()

/**
 * Handles create operation.
 */
function handleCreate(notebooks: Record<string, string>, name: string, newStr?: string): string {
  notebooks[name] = newStr ?? ''
  const message = `Created notebook '${name}'${newStr ? ' with specified content' : ' (empty)'}`
  return message
}

/**
 * Handles list operation.
 */
function handleList(notebooks: Record<string, string>): string {
  const notebookNames = Object.keys(notebooks)
  const details = notebookNames
    .map((name) => {
      const lineCount = notebooks[name] ? notebooks[name].split('\n').length : 0
      const status = lineCount === 0 ? 'Empty' : `${lineCount} lines`
      return `- ${name}: ${status}`
    })
    .join('\n')

  return `Available notebooks:\n${details}`
}

/**
 * Handles read operation.
 */
function handleRead(notebooks: Record<string, string>, name: string, readRange?: number[]): string {
  if (!(name in notebooks)) {
    throw new Error(`Notebook '${name}' not found`)
  }

  const content = notebooks[name]!

  if (!readRange) {
    return content || `Notebook '${name}' is empty`
  }

  // Handle line range reading
  const lines = content.split('\n')
  let start = readRange[0]
  let end = readRange[1]

  if (start === undefined || end === undefined) {
    throw new Error('`readRange` must be a list of two integers: `[start, end]`')
  }

  // Handle negative indices
  if (start < 0) {
    start = lines.length + start + 1
  }
  if (end < 0) {
    end = lines.length + end + 1
  }

  const selectedLines: string[] = []
  for (let lineNum = Math.max(start, 1); lineNum <= Math.min(end, lines.length); lineNum++) {
    selectedLines.push(`${lineNum}: ${lines[lineNum - 1]}`)
  }

  if (selectedLines.length === 0) {
    return `No lines found in range [${readRange[0]}, ${readRange[1]}]. Notebook '${name}' has ${lines.length} line(s).`
  }

  return selectedLines.join('\n')
}

/**
 * Handles write operation (append, string replacement, or line insertion).
 */
function handleWrite(
  notebooks: Record<string, string>,
  name: string,
  oldStr?: string,
  newStr?: string,
  insertLine?: string | number
): string {
  if (!(name in notebooks)) {
    throw new Error(`Notebook '${name}' not found`)
  }

  // Append mode
  if (oldStr === undefined && insertLine === undefined && newStr !== undefined) {
    if (newStr.length === 0) {
      return `No changes made to notebook '${name}'`
    }
    const content = notebooks[name]!
    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
    notebooks[name] = `${content}${separator}${newStr}`
    return `Appended text to notebook '${name}'`
  }

  // String replacement mode
  if (oldStr !== undefined && newStr !== undefined) {
    if (!notebooks[name]!.includes(oldStr)) {
      throw new Error(`String '${oldStr}' not found in notebook '${name}'`)
    }

    notebooks[name] = notebooks[name]!.replace(oldStr, () => newStr)
    return `Replaced text in notebook '${name}'`
  }

  // Line insertion mode
  if (insertLine !== undefined && newStr !== undefined) {
    const lines = notebooks[name]!.split('\n')
    let lineNum: number

    // Handle string search
    if (typeof insertLine === 'string') {
      lineNum = -1
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(insertLine)) {
          lineNum = i
          break
        }
      }
      if (lineNum === -1) {
        throw new Error(`Text '${insertLine}' not found in notebook '${name}'`)
      }
    } else {
      // Handle numeric index with negative support
      if (insertLine < 0) {
        lineNum = lines.length + insertLine
      } else {
        lineNum = insertLine - 1
      }
    }

    // Validate line number range (allow -1 for prepending before first line)
    if (lineNum < -1 || lineNum > lines.length) {
      throw new Error(`Line number out of range`)
    }

    // Insert at the calculated position
    lines.splice(lineNum + 1, 0, newStr)
    const updatedContent = lines.join('\n')
    Object.assign(notebooks, { [name]: updatedContent })

    return `Inserted text at line ${lineNum + 2} in notebook '${name}'`
  }

  throw new Error('Invalid write operation')
}

/**
 * Handles clear operation.
 */
function handleClear(notebooks: Record<string, string>, name: string): string {
  const notebook = notebooks[name]
  if (notebook === undefined) {
    throw new Error(`Notebook '${name}' not found`)
  }

  notebooks[name] = ''
  return `Cleared notebook '${name}'`
}
