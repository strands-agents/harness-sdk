import { tool } from '../../tools/tool-factory.js'
import { z } from 'zod'
import { Sandbox } from '../../sandbox/base.js'
import { SandboxPathNotFoundError } from '../../sandbox/errors.js'
import type { InvokableTool } from '../../tools/tool.js'
import type { ToolResultBlockData } from '../../types/messages.js'
import type { DocumentFormat, ImageFormat } from '../../mime.js'
import * as path from 'path'
import { Buffer } from 'buffer'

const MB = 1024 * 1024
const SNIPPET_LINES = 4
const DEFAULT_MAX_FILE_SIZE = 1 * MB
const MAX_DIRECTORY_DEPTH = 2
const MAX_FIND_LINE_HITS = 200
const DEFAULT_MAX_UNDO_ENTRIES = 32
const DEFAULT_MAX_UNDO_BYTES = 32 * MB

// Extension → Bedrock media format. Detection is by extension because the
// sandbox seam exposes no MIME metadata. `csv`, `html`, `txt`, `md` are
// text-representable documents and stay on the numbered-lines path so
// find_line and str_replace still work; only opaque binary documents route
// through the ToolResult document block.
const IMAGE_FORMATS: Record<string, ImageFormat> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
}
const BINARY_DOCUMENT_FORMATS: Record<string, DocumentFormat> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'docx',
  xls: 'xls',
  xlsx: 'xlsx',
}

const fileEditorInputSchema = z.object({
  command: z
    .enum(['view', 'create', 'str_replace', 'insert', 'find_line', 'undo_edit'])
    .describe('The operation to perform: `view`, `create`, `str_replace`, `insert`, `find_line`, or `undo_edit`.'),
  path: z.string().describe('Absolute path to the file or directory.'),
  file_text: z.string().optional().describe('Content for new file (required for create command).'),
  view_range: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe('Line range to view [start, end]. 1-indexed. End can be -1 for end of file.'),
  old_str: z
    .string()
    .optional()
    .describe(
      'Exact string to find and replace (required for str_replace). Must be unique unless replace_all is true.'
    ),
  new_str: z.string().optional().describe('Replacement string (for str_replace and insert commands).'),
  insert_line: z
    .number()
    .optional()
    .describe('Line number where text should be inserted (0-indexed, required for insert command).'),
  search_text: z.string().optional().describe('Text to search for (required for find_line command).'),
  fuzzy: z.boolean().optional().describe('Enable whitespace-tolerant, case-insensitive matching for find_line.'),
  replace_all: z
    .boolean()
    .optional()
    .describe(
      'For str_replace, allow replacing every occurrence. Defaults to false; a match count > 1 is rejected without this flag to prevent silent broad edits.'
    ),
})

/**
 * File editor tool for viewing, creating, and editing files programmatically.
 *
 * Provides commands for viewing files/directories, creating files, string
 * replacement, line insertion, search, and single-step undo. All I/O routes
 * through the agent's configured sandbox.
 *
 * @example
 * ```typescript
 * import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
 * import { Agent } from '@strands-agents/sdk'
 *
 * const agent = new Agent({
 *   model: new BedrockModel({ region: 'us-east-1' }),
 *   tools: [fileEditor],
 * })
 *
 * await agent.invoke('View the file /tmp/test.txt')
 * await agent.invoke('Create a file /tmp/notes.txt with content "Hello World"')
 * await agent.invoke('Replace "Hello" with "Hi" in /tmp/notes.txt')
 * ```
 */
export const DEFAULT_FILE_EDITOR_DESCRIPTION =
  'Filesystem editor for viewing, creating, and editing files. Supports view (text with line ranges; png/jpeg/gif/webp images and pdf/doc/docx/xls/xlsx documents returned as media blocks), create, str_replace (exact match; ambiguous matches must opt in via replace_all), insert, find_line, and undo_edit. Files must use absolute paths.'

export const DEFAULT_UNDO_STATE_KEY = 'file_editor.undo_history'

const MUTATING_COMMANDS = new Set(['create', 'str_replace', 'insert', 'undo_edit'])

export interface MakeFileEditorOptions {
  name?: string
  description?: string
  /**
   * Optional absolute directory that confines every operation. Paths are
   * normalized (so `..` segments collapse before the containment check) and
   * must sit inside `root`. Confinement is *lexical*: the editor does not
   * follow symlinks itself. Filesystem semantics — including whether a
   * symlink inside `root` can escape it — are governed by the sandbox. On
   * first use, the editor verifies `root` exists in the sandbox via
   * {@link Sandbox.listFiles}; if it does not, the call fails.
   */
  root?: string
  /**
   * Maximum file size (bytes) accepted by view/edit commands. Defaults to
   * 1 MB. Anything larger is rejected with a clean error rather than being
   * loaded into memory.
   */
  maxFileSize?: number
  /**
   * Maximum number of distinct paths retained in the in-memory undo history
   * per calling agent. Oldest entry is evicted on overflow. Defaults to 32.
   */
  maxUndoEntries?: number
  /**
   * Approximate cap on total bytes of file content held in the per-agent undo
   * history (measured as UTF-8 byte length, matching the Python side). Oldest
   * entries are evicted until the cap is met. Defaults to 32 MB.
   */
  maxUndoBytes?: number
  /**
   * Key under which the undo history is stored in `agent.appState`. Two
   * editors sharing the same key on the same agent will share undo history;
   * use distinct keys to isolate them. Defaults to
   * `'file_editor.undo_history'`.
   */
  undoStateKey?: string
}

/**
 * Create a file editor tool. If a sandbox is passed, it's bound at creation
 * time. Otherwise, the tool reads from `context.agent.sandbox` at call time.
 *
 * Undo history is stored in `context.agent.appState` under `undoStateKey`
 * (default `'file_editor.undo_history'`), so two agents sharing one editor
 * factory cannot see or overwrite each other's snapshots and any configured
 * session manager can persist it across restarts.
 */
export function makeFileEditor(
  options?: MakeFileEditorOptions
): InvokableTool<z.infer<typeof fileEditorInputSchema>, string | ToolResultBlockData>
export function makeFileEditor(
  sandbox: Sandbox | undefined,
  options?: MakeFileEditorOptions
): InvokableTool<z.infer<typeof fileEditorInputSchema>, string | ToolResultBlockData>
export function makeFileEditor(
  sandboxOrOptions?: Sandbox | MakeFileEditorOptions,
  maybeOptions?: MakeFileEditorOptions
): InvokableTool<z.infer<typeof fileEditorInputSchema>, string | ToolResultBlockData> {
  const boundSandbox = sandboxOrOptions instanceof Sandbox ? sandboxOrOptions : undefined
  const options = sandboxOrOptions instanceof Sandbox || maybeOptions ? (maybeOptions ?? {}) : (sandboxOrOptions ?? {})
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE
  const maxUndoEntries = options.maxUndoEntries ?? DEFAULT_MAX_UNDO_ENTRIES
  const maxUndoBytes = options.maxUndoBytes ?? DEFAULT_MAX_UNDO_BYTES
  const undoStateKey = options.undoStateKey ?? DEFAULT_UNDO_STATE_KEY

  if (options.root !== undefined && !path.isAbsolute(options.root)) {
    throw new Error(`root must be an absolute path, got: ${options.root}`)
  }
  // Platform-native normalization so a Windows-style `root` (e.g.
  // `C:\Users\...\workspace`) survives round-tripping.
  const normalizedRoot: string | undefined =
    options.root === undefined ? undefined : stripTrailingSep(path.normalize(options.root))

  // Sandboxes already verified to contain `root`. WeakSet so a sandbox that
  // goes out of scope does not pin the cache entry.
  const verifiedSandboxes = new WeakSet<Sandbox>()

  async function verifyRoot(sandbox: Sandbox): Promise<void> {
    if (normalizedRoot === undefined || verifiedSandboxes.has(sandbox)) return
    try {
      await sandbox.listFiles(normalizedRoot)
    } catch (error) {
      if (error instanceof SandboxPathNotFoundError) {
        throw new Error(`Invalid configuration: root ${normalizedRoot} does not exist in the sandbox.`, {
          cause: error,
        })
      }
      throw error
    }
    verifiedSandboxes.add(sandbox)
  }

  const description =
    options.description ??
    (normalizedRoot !== undefined
      ? `${DEFAULT_FILE_EDITOR_DESCRIPTION} All paths must be absolute and inside ${normalizedRoot}.`
      : DEFAULT_FILE_EDITOR_DESCRIPTION)

  return tool({
    name: options.name ?? 'fileEditor',
    description,
    inputSchema: fileEditorInputSchema,
    callback: async (input, context) => {
      if (!context) throw new Error('Tool context is required for fileEditor operations')
      const sandbox = boundSandbox ?? context.agent.sandbox
      await verifyRoot(sandbox)
      const filePath = resolvePath(input.path, normalizedRoot)

      // Only mutating commands touch undo history, so read-only paths skip
      // the state load/save (which deep-copies and JSON-validates).
      const mutatesUndo = MUTATING_COMMANDS.has(input.command)
      const appState = mutatesUndo ? context.agent.appState : undefined
      const undoHistory: Record<string, string> = mutatesUndo
        ? ((appState?.get(undoStateKey) as Record<string, string> | undefined) ?? {})
        : {}

      try {
        switch (input.command) {
          case 'view':
            return await handleView(sandbox, filePath, input.view_range, maxFileSize, context.toolUse.toolUseId)
          case 'create':
            return await handleCreate(sandbox, filePath, input.file_text!, undoHistory, maxFileSize)
          case 'str_replace':
            return await handleStrReplace(
              sandbox,
              filePath,
              input.old_str!,
              input.new_str,
              input.replace_all === true,
              maxFileSize,
              undoHistory,
              maxUndoEntries,
              maxUndoBytes
            )
          case 'insert':
            return await handleInsert(
              sandbox,
              filePath,
              input.insert_line!,
              input.new_str!,
              maxFileSize,
              undoHistory,
              maxUndoEntries,
              maxUndoBytes
            )
          case 'find_line':
            return await handleFindLine(sandbox, filePath, input.search_text!, input.fuzzy === true, maxFileSize)
          case 'undo_edit':
            return await handleUndo(sandbox, filePath, undoHistory)
          default:
            throw new Error(`Unknown command: ${(input as { command: string }).command}`)
        }
      } finally {
        if (appState !== undefined) {
          // Handlers only mutate after a successful sandbox write, so
          // persisting on the exception path is safe.
          appState.set(undoStateKey, undoHistory)
        }
      }
    },
  })
}

/**
 * Default file editor tool. Reads the sandbox from the agent's context at call time.
 */
export const fileEditor = makeFileEditor()

/**
 * Normalize a path and enforce lexical confinement.
 *
 * Rejects non-absolute paths. When `root` is set the normalized path must
 * sit inside it. Symlink semantics are the sandbox's responsibility.
 *
 * @throws Error on non-absolute paths or out-of-root resolution.
 */
function resolvePath(filePath: string, root: string | undefined): string {
  // stripTrailingSep preserves a Windows drive root like `C:\` — a naive
  // trailing-separator strip would collapse it to `C:`, which is not absolute.
  const stripped = stripTrailingSep(filePath)

  if (!path.isAbsolute(stripped)) {
    const suggestedPath = path.resolve(stripped)
    throw new Error(
      `The path ${filePath} is not an absolute path, it should start with \`/\` (or a drive letter on Windows). Maybe you meant ${suggestedPath}?`
    )
  }

  // Platform-native normalization so Windows drive-letter paths survive.
  const normalized = stripTrailingSep(path.normalize(stripped))

  if (root !== undefined && !isInsideRoot(normalized, root)) {
    throw new Error(`Invalid path: ${filePath} is outside the configured root ${root}`)
  }

  return normalized
}

function stripTrailingSep(p: string): string {
  // Preserve drive roots (`C:\`, `/`) but drop a trailing separator otherwise.
  if (p.length <= 1) return p
  if (process.platform === 'win32' && /^[A-Za-z]:[\\/]$/.test(p)) return p
  return p.replace(/[\\/]+$/, '') || p
}

function isInsideRoot(target: string, root: string): boolean {
  const t = process.platform === 'win32' ? target.toLowerCase() : target
  const r = process.platform === 'win32' ? stripTrailingSep(root).toLowerCase() : stripTrailingSep(root)
  if (t === r) return true
  // Root can already end in a separator when it is the filesystem root (`/`)
  // or a Windows drive root (`C:\`) — stripTrailingSep preserves those. In
  // that case, concatenating another separator would produce `//` or `C:\\`
  // and every valid in-root path would fail startsWith.
  const rEndsWithSep = r.endsWith('/') || r.endsWith('\\')
  if (rEndsWithSep) return t.startsWith(r)
  // Otherwise, match either separator so a Windows normalized path
  // (`C:\a\b`) matches a root that could be written with either style.
  return t.startsWith(r + path.sep) || t.startsWith(r + '/')
}

/**
 * Reject a replacement payload whose UTF-8 length would exceed `maxSize`.
 * Mirrors the read-side cap on the write side so a model cannot ship an
 * unbounded `new_str` or `file_text` through the tool.
 */
function rejectOversizeReplacement(text: string | undefined, maxSize: number, label = 'new_str'): void {
  if (text === undefined) return
  const bytes = Buffer.byteLength(text, 'utf-8')
  if (bytes > maxSize) {
    throw new Error(`${label} (${bytes} bytes) exceeds maximum allowed size (${maxSize} bytes)`)
  }
}

/**
 * Reject a `str_replace` whose projected UTF-8 output would exceed `maxSize`.
 *
 * The projected size is exact — `String.prototype.replace` never re-runs
 * itself — so rejection happens before V8 allocates the substituted string.
 * Guards against a pathological `replace_all` (many small matches, large
 * replacement) trying to allocate a multi-terabyte buffer.
 */
function preflightStrReplaceOutputSize(
  originalContent: string,
  oldStr: string,
  newStrValue: string,
  replaceAll: boolean,
  occurrences: number,
  maxSize: number,
  filePath: string
): void {
  const oldBytes = Buffer.byteLength(oldStr, 'utf-8')
  const newBytes = Buffer.byteLength(newStrValue, 'utf-8')
  const count = replaceAll ? occurrences : 1
  const projected = Buffer.byteLength(originalContent, 'utf-8') + count * (newBytes - oldBytes)
  if (projected > maxSize) {
    throw new Error(
      `The edit would produce a ${projected}-byte file at ${filePath}, exceeding the maximum allowed size of ${maxSize} bytes.`
    )
  }
}

/**
 * Reject an `insert` whose projected UTF-8 output would exceed `maxSize`.
 */
function preflightInsertOutputSize(originalContent: string, newStr: string, maxSize: number, filePath: string): void {
  const projected = Buffer.byteLength(originalContent, 'utf-8') + Buffer.byteLength(newStr, 'utf-8')
  if (projected > maxSize) {
    throw new Error(
      `The edit would produce a ${projected}-byte file at ${filePath}, exceeding the maximum allowed size of ${maxSize} bytes.`
    )
  }
}

/**
 * Slice file content to a 1-indexed `[start, end]` range (end `-1` means end of file).
 */
function applyViewRange(
  fileContent: string,
  viewRange: [number, number] | undefined
): { content: string; initLine: number } {
  if (!viewRange) {
    return { content: fileContent, initLine: 1 }
  }
  const lines = fileContent.split('\n')
  const nLines = lines.length
  const [start, end] = viewRange

  if (start < 1 || start > nLines) {
    throw new Error(
      `Invalid \`view_range\`: [${start}, ${end}]. Its first element \`${start}\` should be within the range of lines of the file: [1, ${nLines}]`
    )
  }
  if (end !== -1 && end > nLines) {
    throw new Error(
      `Invalid \`view_range\`: [${start}, ${end}]. Its second element \`${end}\` should be smaller than the number of lines in the file: \`${nLines}\``
    )
  }
  if (end !== -1 && end < start) {
    throw new Error(
      `Invalid \`view_range\`: [${start}, ${end}]. Its second element \`${end}\` should be larger or equal than its first \`${start}\``
    )
  }

  const content = end === -1 ? lines.slice(start - 1).join('\n') : lines.slice(start - 1, end).join('\n')
  return { content, initLine: start }
}

/**
 * Perform a `str_replace` and return `{ newContent, snippet, startLine, count }`.
 *
 * Requires exactly one match unless `replaceAll` is true, and runs a
 * projected-size preflight before allocating the substituted string.
 *
 * @throws Error when `oldStr` does not appear, appears more than once
 *   without `replaceAll`, or the substitution would exceed `maxSize`.
 */
function buildStrReplaceResult(
  originalContent: string,
  oldStr: string,
  newStr: string | undefined,
  filePath: string,
  replaceAll: boolean,
  maxSize: number
): { newContent: string; snippet: string; startLine: number; count: number } {
  const newStrValue = newStr ?? ''

  const occurrences = (originalContent.match(new RegExp(escapeRegExp(oldStr), 'g')) || []).length
  if (occurrences === 0) {
    throw new Error(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${filePath}.`)
  }
  if (occurrences > 1 && !replaceAll) {
    // Walk the file with indexOf so multi-line old_str matches report the
    // line each occurrence starts on; splitting per-line-and-checking `.includes`
    // never matches an old_str that spans a newline.
    const lineNumbers: number[] = []
    let cursor = 0
    while (true) {
      const found = originalContent.indexOf(oldStr, cursor)
      if (found === -1) break
      lineNumbers.push(originalContent.slice(0, found).split('\n').length)
      cursor = found + oldStr.length
    }
    throw new Error(
      `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines ${JSON.stringify(lineNumbers)}. Pass replace_all=true to replace every occurrence, or make old_str unique.`
    )
  }

  preflightStrReplaceOutputSize(originalContent, oldStr, newStrValue, replaceAll, occurrences, maxSize, filePath)

  const count = replaceAll ? occurrences : 1
  // Single replacement uses a replacer function so `$&`/`$1`/`$$` in newStr
  // survive verbatim (String.prototype.replace with a string would interpret
  // them). replace_all is a plain split/join for the same reason.
  const newContent = replaceAll
    ? originalContent.split(oldStr).join(newStrValue)
    : originalContent.replace(oldStr, () => newStrValue)
  const replacementLine = originalContent.substring(0, originalContent.indexOf(oldStr)).split('\n').length - 1
  const insertedLines = newStrValue.split('\n').length
  const originalLines = oldStr.split('\n').length
  const lineDifference = insertedLines - originalLines

  const newLines = newContent.split('\n')
  const startLine = Math.max(0, replacementLine - SNIPPET_LINES)
  const endLine = Math.min(newLines.length, replacementLine + SNIPPET_LINES + lineDifference + 1)
  const snippet = newLines.slice(startLine, endLine).join('\n')

  return { newContent, snippet, startLine, count }
}

/**
 * Insert text at a 0-indexed line and return `{ newContent, snippet, startLine }`.
 *
 * @throws Error when `insertLine` is out of bounds.
 */
function buildInsertResult(
  originalContent: string,
  insertLine: number,
  newStr: string
): { newContent: string; snippet: string; startLine: number } {
  const fileTextLines = originalContent.split('\n')
  const nLines = fileTextLines.length

  if (insertLine < 0 || insertLine > nLines) {
    throw new Error(
      `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${nLines}]`
    )
  }

  const newStrLines = newStr.split('\n')
  const newFileTextLines =
    originalContent === ''
      ? newStrLines
      : [...fileTextLines.slice(0, insertLine), ...newStrLines, ...fileTextLines.slice(insertLine)]

  const newContent = newFileTextLines.join('\n')
  const snippetStartLine = Math.max(0, insertLine - SNIPPET_LINES)
  const snippetEndLine = Math.min(newFileTextLines.length, insertLine + newStrLines.length + SNIPPET_LINES)
  const snippet = newFileTextLines.slice(snippetStartLine, snippetEndLine).join('\n')

  return { newContent, snippet, startLine: snippetStartLine }
}

/**
 * Format file content with cat-n-style line numbers.
 */
function makeOutput(fileContent: string, fileDescriptor: string, initLine: number = 1): string {
  const expandedContent = fileContent.replace(/\t/g, '        ')

  const numberedLines = expandedContent.split('\n').map((line, index) => {
    const lineNum = index + initLine
    return `${lineNum.toString().padStart(6)}  ${line}`
  })

  return `Here's the result of running \`cat -n\` on ${fileDescriptor}:\n${numberedLines.join('\n')}\n`
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Return every 0-indexed line where `searchText` matches, capped at `cap` hits.
 *
 * When `fuzzy` is true, whitespace between tokens is collapsed and matching
 * is case-insensitive.
 */
function findLineNumbers(content: string, searchText: string, fuzzy: boolean, cap: number): number[] {
  const lines = content.split('\n')
  const hits: number[] = []
  if (fuzzy) {
    // Whitespace-tolerant, case-insensitive: match tokens in order using a
    // linear ordered-subsequence scan. A previous implementation joined
    // tokens with a regex `.*` chain, which is O(line_length**tokens)
    // against long single-line content and cannot be interrupted because
    // V8 has no in-exec regex timeout and holds the event loop.
    const tokens = searchText
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => token.toLowerCase())
    if (tokens.length === 0) return hits
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (line === undefined) continue
      const lowered = line.toLowerCase()
      let position = 0
      let matched = true
      for (const token of tokens) {
        const found = lowered.indexOf(token, position)
        if (found === -1) {
          matched = false
          break
        }
        position = found + token.length
      }
      if (matched) {
        hits.push(index)
        if (hits.length >= cap) break
      }
    }
  } else {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (line !== undefined && line.includes(searchText)) {
        hits.push(index)
        if (hits.length >= cap) break
      }
    }
  }
  return hits
}

// ---- Undo history bookkeeping ----

/**
 * Record a pre-edit snapshot in the LRU undo history, evicting oldest on overflow.
 *
 * `Map` iteration follows insertion order; a re-inserted key after `delete` moves
 * to the end. `keys().next()` therefore yields the oldest entry for eviction.
 *
 * Callers must invoke this only *after* the corresponding write has succeeded
 * so a failed write does not overwrite a still-valid earlier snapshot.
 */
function storeUndoSnapshot(
  undoHistory: Record<string, string>,
  filePath: string,
  content: string,
  maxEntries: number,
  maxBytes: number
): void {
  // Delete-then-set so a repeat path moves to the end of insertion order. Path
  // keys are absolute (start with `/` or a drive letter), so no integer-key
  // reordering applies and iteration order equals insertion order.
  if (filePath in undoHistory) delete undoHistory[filePath]
  undoHistory[filePath] = content
  let totalBytes = 0
  for (const value of Object.values(undoHistory)) totalBytes += Buffer.byteLength(value, 'utf-8')
  let keys = Object.keys(undoHistory)
  while (keys.length > 0 && (keys.length > maxEntries || totalBytes > maxBytes)) {
    const oldestKey = keys[0]!
    const evicted = undoHistory[oldestKey]!
    delete undoHistory[oldestKey]
    totalBytes -= Buffer.byteLength(evicted, 'utf-8')
    keys = Object.keys(undoHistory)
  }
}

// ---- Sandbox-routed I/O helpers ----

/**
 * Return `{ exists, isDir }` for a path by listing its parent through the sandbox.
 *
 * A missing parent or entry becomes `{ exists: false }`; other listing
 * errors (permission, transport) propagate so they are not disguised as
 * non-existence.
 */
async function probeSandboxPath(sandbox: Sandbox, filePath: string): Promise<{ exists: boolean; isDir: boolean }> {
  const normalized = filePath.replaceAll('\\', '/')
  const parent = normalized.split('/').slice(0, -1).join('/') || '/'
  const name = normalized.split('/').pop()!
  try {
    const entry = (await sandbox.listFiles(parent)).find((e) => e.name === name)
    if (!entry) {
      return { exists: false, isDir: false }
    }
    return { exists: true, isDir: entry.isDir ?? false }
  } catch (err) {
    if (err instanceof SandboxPathNotFoundError) {
      return { exists: false, isDir: false }
    }
    throw err
  }
}

/**
 * Read text through the sandbox, rejecting binary files and oversize inputs.
 *
 * Reads raw bytes first so the size cap and encoding detection run before
 * UTF-8 decoding — a corrupted UTF-8 error is worse than a clean rejection.
 * UTF-16 BOMs are detected up front so a valid UTF-16 file is reported as an
 * unsupported encoding rather than misclassified as binary. Otherwise the
 * classic NUL-in-first-8-KB heuristic identifies binary content.
 */
async function readTextOrRejectBinary(sandbox: Sandbox, filePath: string, maxSize: number): Promise<string> {
  const raw = await sandbox.readFile(filePath)
  if (raw.byteLength > maxSize) {
    throw new Error(`File size (${raw.byteLength} bytes) exceeds maximum allowed size (${maxSize} bytes)`)
  }
  if (raw.byteLength >= 2 && ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff))) {
    throw new Error(`Refusing to read non-UTF-8 file (detected UTF-16 BOM): ${filePath}`)
  }
  const scanLen = Math.min(raw.byteLength, 8192)
  for (let i = 0; i < scanLen; i++) {
    if (raw[i] === 0) {
      throw new Error(`Refusing to read binary file: ${filePath}`)
    }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    return decoder.decode(raw)
  } catch {
    throw new Error(`Refusing to read non-UTF-8 file: ${filePath}`)
  }
}

/**
 * List directory contents up to 2 levels deep through the sandbox, excluding hidden files.
 */
async function listDirectory(sandbox: Sandbox, dirPath: string): Promise<string> {
  const items: string[] = []

  async function walk(currentPath: string, prefix: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await sandbox.listFiles(currentPath)
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue

      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      items.push(relativePath)

      if (entry.isDir && depth < MAX_DIRECTORY_DEPTH) {
        await walk(`${currentPath}/${entry.name}`, relativePath, depth + 1)
      }
    }
  }

  await walk(dirPath, '', 0)

  const result = items.sort().join('\n')
  return `Here's the files and directories up to 2 levels deep in ${dirPath}, excluding hidden items:\n${result}\n`
}

// ---- Sandbox-path handlers ----

async function handleView(
  sandbox: Sandbox,
  filePath: string,
  viewRange: [number, number] | undefined,
  maxSize: number,
  toolUseId: string
): Promise<string | ToolResultBlockData> {
  const { exists, isDir } = await probeSandboxPath(sandbox, filePath)
  if (!exists) {
    throw new Error(`The path ${filePath} does not exist. Please provide a valid path.`)
  }

  if (isDir) {
    if (viewRange) {
      throw new Error('The `view_range` parameter is not allowed when `path` points to a directory.')
    }
    return listDirectory(sandbox, filePath)
  }

  const extension = path.extname(filePath).replace(/^\./, '').toLowerCase()
  const imageFormat = IMAGE_FORMATS[extension]
  const documentFormat = BINARY_DOCUMENT_FORMATS[extension]

  if (imageFormat !== undefined || documentFormat !== undefined) {
    if (viewRange) {
      throw new Error('The `view_range` parameter is not allowed for image or binary document files.')
    }
    const raw = await sandbox.readFile(filePath)
    if (raw.byteLength > maxSize) {
      throw new Error(`File size (${raw.byteLength} bytes) exceeds maximum allowed size (${maxSize} bytes)`)
    }
    if (imageFormat !== undefined) {
      return {
        toolUseId,
        status: 'success',
        content: [{ image: { format: imageFormat, source: { bytes: raw } } }],
      }
    }
    return {
      toolUseId,
      status: 'success',
      content: [
        {
          document: {
            format: documentFormat!,
            name: path.basename(filePath),
            source: { bytes: raw },
          },
        },
      ],
    }
  }

  const fileContent = await readTextOrRejectBinary(sandbox, filePath, maxSize)
  const { content, initLine } = applyViewRange(fileContent, viewRange)
  return makeOutput(content, filePath, initLine)
}

async function handleCreate(
  sandbox: Sandbox,
  filePath: string,
  fileText: string,
  undoHistory: Record<string, string>,
  maxSize: number
): Promise<string> {
  if (fileText === undefined) {
    throw new Error('Parameter `file_text` is required for command: create')
  }
  const writeBytes = Buffer.byteLength(fileText, 'utf-8')
  if (writeBytes > maxSize) {
    throw new Error(`file_text (${writeBytes} bytes) exceeds maximum allowed size (${maxSize} bytes)`)
  }

  const { exists } = await probeSandboxPath(sandbox, filePath)
  if (exists) {
    throw new Error(`File already exists at: ${filePath}. Cannot overwrite files using command \`create\`.`)
  }

  await sandbox.writeText(filePath, fileText)
  // `create` is intentionally not snapshotted for undo: rolling back a create
  // means deleting the file, which is a different operation from "restore
  // prior content" and is easy for the caller to do themselves.
  delete undoHistory[filePath]
  return `File created successfully at: ${filePath}`
}

async function handleStrReplace(
  sandbox: Sandbox,
  filePath: string,
  oldStr: string,
  newStr: string | undefined,
  replaceAll: boolean,
  maxSize: number,
  undoHistory: Record<string, string>,
  maxUndoEntries: number,
  maxUndoBytes: number
): Promise<string> {
  if (oldStr === undefined) {
    throw new Error('Parameter `old_str` is required for command: str_replace')
  }
  if (oldStr === '') {
    throw new Error('Parameter `old_str` must not be empty for command: str_replace')
  }
  if (newStr !== undefined) rejectOversizeReplacement(newStr, maxSize, 'new_str')

  const { exists, isDir } = await probeSandboxPath(sandbox, filePath)
  if (!exists) {
    throw new Error(`The path ${filePath} does not exist. Please provide a valid path.`)
  }
  if (isDir) {
    throw new Error(`The path ${filePath} is a directory and only the \`view\` command can be used on directories`)
  }

  const fileContent = await readTextOrRejectBinary(sandbox, filePath, maxSize)

  const { newContent, snippet, startLine, count } = buildStrReplaceResult(
    fileContent,
    oldStr,
    newStr,
    filePath,
    replaceAll,
    maxSize
  )

  // Snapshot only after the write commits so a failed write leaves the
  // previous entry — which still reflects on-disk state — valid to undo.
  await sandbox.writeText(filePath, newContent)
  storeUndoSnapshot(undoHistory, filePath, fileContent, maxUndoEntries, maxUndoBytes)

  const suffix = replaceAll && count > 1 ? ` (${count} occurrences replaced)` : ''
  return `The file ${filePath} has been edited.${suffix} ${makeOutput(snippet, `a snippet of ${filePath}`, startLine + 1)}Review the changes and make sure they are as expected. Edit the file again if necessary.`
}

async function handleInsert(
  sandbox: Sandbox,
  filePath: string,
  insertLine: number,
  newStr: string,
  maxSize: number,
  undoHistory: Record<string, string>,
  maxUndoEntries: number,
  maxUndoBytes: number
): Promise<string> {
  if (insertLine === undefined || newStr === undefined) {
    throw new Error('Parameters `insert_line` and `new_str` are required for command: insert')
  }
  rejectOversizeReplacement(newStr, maxSize, 'new_str')

  const { exists, isDir } = await probeSandboxPath(sandbox, filePath)
  if (!exists) {
    throw new Error(`The path ${filePath} does not exist. Please provide a valid path.`)
  }
  if (isDir) {
    throw new Error(`The path ${filePath} is a directory and only the \`view\` command can be used on directories`)
  }

  const fileText = await readTextOrRejectBinary(sandbox, filePath, maxSize)

  preflightInsertOutputSize(fileText, newStr, maxSize, filePath)
  const { newContent, snippet, startLine } = buildInsertResult(fileText, insertLine, newStr)

  await sandbox.writeText(filePath, newContent)
  storeUndoSnapshot(undoHistory, filePath, fileText, maxUndoEntries, maxUndoBytes)

  return `The file ${filePath} has been edited. ${makeOutput(snippet, 'a snippet of the edited file', startLine + 1)}Review the changes and make sure they are as expected (correct indentation, no duplicate lines, etc). Edit the file again if necessary.`
}

async function handleFindLine(
  sandbox: Sandbox,
  filePath: string,
  searchText: string,
  fuzzy: boolean,
  maxSize: number
): Promise<string> {
  if (searchText === undefined) {
    throw new Error('Parameter `search_text` is required for command: find_line')
  }

  const { exists, isDir } = await probeSandboxPath(sandbox, filePath)
  if (!exists) {
    throw new Error(`The path ${filePath} does not exist. Please provide a valid path.`)
  }
  if (isDir) {
    throw new Error(`The path ${filePath} is a directory and only the \`view\` command can be used on directories`)
  }

  const fileContent = await readTextOrRejectBinary(sandbox, filePath, maxSize)

  const hits = findLineNumbers(fileContent, searchText, fuzzy, MAX_FIND_LINE_HITS)
  if (hits.length === 0) {
    return `No matches for \`${searchText}\` in ${filePath}.`
  }

  const lineNumbers = hits.map((index) => index + 1)
  const truncatedNote = hits.length === MAX_FIND_LINE_HITS ? ` (truncated to first ${MAX_FIND_LINE_HITS} hits)` : ''

  const first = hits[0]!
  const lines = fileContent.split('\n')
  const startLine = Math.max(0, first - SNIPPET_LINES)
  const endLine = Math.min(lines.length, first + SNIPPET_LINES + 1)
  const snippet = lines.slice(startLine, endLine).join('\n')
  return `Found \`${searchText}\` at line(s) ${JSON.stringify(lineNumbers)}${truncatedNote} of ${filePath}.\n${makeOutput(snippet, `a snippet around line ${first + 1} of ${filePath}`, startLine + 1)}`
}

/**
 * Restores the last in-memory snapshot for `filePath`. The snapshot is
 * unconditionally written back through the sandbox: if the file was deleted
 * (or moved) outside the tool since the snapshot was captured, `undo_edit`
 * will re-create it at that path. Undo tracks content-per-path, not the
 * file's presence.
 *
 * The snapshot stays in history until the restoring write succeeds so a
 * transient sandbox failure leaves undo retryable.
 */
async function handleUndo(sandbox: Sandbox, filePath: string, undoHistory: Record<string, string>): Promise<string> {
  const previous = undoHistory[filePath]
  if (previous === undefined) {
    throw new Error(`No undo history available for ${filePath} in this session.`)
  }
  await sandbox.writeText(filePath, previous)
  delete undoHistory[filePath]
  return `Reverted ${filePath} to its previous in-memory snapshot.`
}
