/**
 * Filesystem tools: `read`, `write`, `edit`.
 *
 * Thin tools that route file access through the same `context.agent.sandbox` seam the SDK's file
 * editor uses, so they behave identically across host and container filesystems. They are
 * candidates to port into the core SDK later; keep them minimal and SDK-idiomatic.
 */

import { DocumentBlock, ImageBlock, tool } from '@strands-agents/sdk'
import type { DocumentFormat, ImageFormat, ToolContext } from '@strands-agents/sdk'
import { z } from 'zod'

const READ_DEFAULT_LIMIT = 2000

// Media formats the read tool returns as viewable content, keyed by file extension. Detection is
// by extension because the sandbox seam exposes no MIME metadata. Text-representable document
// formats (csv, html, txt, md) stay on the numbered-lines path, which supports citing and paging.
// Video is omitted: the Python SDK's tool results do not accept video content, and the two
// libraries keep behavior parity.
const IMAGE_FORMATS: Record<string, ImageFormat> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' }
const DOCUMENT_FORMATS: readonly string[] = ['pdf', 'doc', 'docx', 'xls', 'xlsx']

function validatePath(path: string): void {
  if (!path.startsWith('/')) {
    throw new Error(`The path ${path} is not absolute; it should start with '/'.`)
  }
  if (path.split(/[/\\]/).includes('..')) {
    throw new Error('Invalid path: path traversal is not allowed.')
  }
}

function numberLines(content: string, start: number): string {
  return content
    .split('\n')
    .map((line, i) => `${String(i + start).padStart(6)}\t${line}`)
    .join('\n')
}

function extension(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Sanitizes a filename into a model-safe document name. Bedrock accepts only alphanumerics,
 * whitespace, hyphens, parentheses, and square brackets in document names, with no consecutive
 * whitespace.
 */
function documentName(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? ''
  const sanitized = name
    .replace(/[^a-zA-Z0-9\s\-()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized || 'document'
}

function mediaPlaceholder(path: string, kind: string, mediaFormat: string, size: number): string {
  return (
    `[${kind} file: ${path} (${mediaFormat}, ${size} bytes). This model cannot view ` +
    `${kind.toLowerCase()} files, so its contents are not shown. Use shell tools if the file has a ` +
    'text-extractable form.]'
  )
}

const READ_SCHEMA = z.object({
  path: z.string().describe('Absolute path to the file.'),
  offset: z.number().optional().describe('1-indexed line to start from. Defaults to the first line. Text files only.'),
  limit: z.number().optional().describe('Maximum number of lines to return. Defaults to 2000. Text files only.'),
})

const READ_DESCRIPTION =
  'Read a file. Text returns `cat -n` style numbered lines so you can cite `path:line`; images ' +
  '(png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return media you can view directly. ' +
  'Text defaults to the first 2000 lines; use offset/limit to page through larger files.'

type ReadInput = z.infer<typeof READ_SCHEMA>
type ReadOutput = string | ImageBlock | DocumentBlock

function readCallback(media: boolean): (input: ReadInput, context?: ToolContext) => Promise<ReadOutput> {
  return async (input: ReadInput, context?: ToolContext): Promise<ReadOutput> => {
    if (!context) throw new Error('Tool context is required for read.')
    validatePath(input.path)
    const ext = extension(input.path)

    const imageFormat = IMAGE_FORMATS[ext]
    if (imageFormat) {
      const bytes = await context.agent.sandbox.readFile(input.path)
      if (!media) {
        return mediaPlaceholder(input.path, 'Image', imageFormat, bytes.length)
      }
      return new ImageBlock({ format: imageFormat, source: { bytes } })
    }

    if (DOCUMENT_FORMATS.includes(ext)) {
      const bytes = await context.agent.sandbox.readFile(input.path)
      if (!media) {
        return mediaPlaceholder(input.path, 'Document', ext, bytes.length)
      }
      return new DocumentBlock({ name: documentName(input.path), format: ext as DocumentFormat, source: { bytes } })
    }

    const content = await context.agent.sandbox.readText(input.path)

    const lines = content.split('\n')
    const start = Math.max(0, input.offset ? input.offset - 1 : 0)
    const count = input.limit ?? READ_DEFAULT_LIMIT
    const window = lines.slice(start, start + count)
    if (window.length === 0) {
      return `[File has ${lines.length} lines; offset ${input.offset} is past the end.]`
    }

    let numbered = numberLines(window.join('\n'), start + 1)
    if (start > 0 || start + count < lines.length) {
      const shownEnd = start + window.length
      numbered += `\n[Showing lines ${start + 1}-${shownEnd} of ${lines.length}. Use offset/limit to read more.]`
    }
    return numbered
  }
}

export const read = tool({
  name: 'read',
  description: READ_DESCRIPTION,
  inputSchema: READ_SCHEMA,
  callback: readCallback(true),
})

export interface MakeReadOptions {
  /** Return images and binary documents as viewable media. Defaults to true. */
  media?: boolean
}

/**
 * Build the `read` tool.
 *
 * Pass `media: false` for a model that rejects image and document blocks, and `read` describes those
 * files in text instead. See `supportsMedia` in `models.ts`.
 */
export function makeRead({ media = true }: MakeReadOptions = {}): typeof read {
  return tool({
    name: 'read',
    description: READ_DESCRIPTION,
    inputSchema: READ_SCHEMA,
    callback: readCallback(media),
  })
}

export const write = tool({
  name: 'write',
  description: 'Write a file, creating it or overwriting it. Use `edit` for surgical changes to a large file.',
  inputSchema: z.object({
    path: z.string().describe('Absolute path to the file.'),
    content: z.string().describe('The full file content to write.'),
  }),
  callback: async (input, context) => {
    if (!context) throw new Error('Tool context is required for write.')
    validatePath(input.path)
    await context.agent.sandbox.writeText(input.path, input.content)
    const lineCount = input.content === '' ? 0 : input.content.split('\n').length
    return `Wrote ${lineCount} lines to ${input.path}.`
  },
})

export const edit = tool({
  name: 'edit',
  description: 'Replace an exact string in a file. `old_str` must appear exactly once.',
  inputSchema: z.object({
    path: z.string().describe('Absolute path to the file.'),
    old_str: z.string().describe('Exact text to find. Must be unique within the file.'),
    new_str: z.string().describe('Replacement text.'),
  }),
  callback: async (input, context) => {
    if (!context) throw new Error('Tool context is required for edit.')
    validatePath(input.path)
    const sandbox = context.agent.sandbox
    const content = await sandbox.readText(input.path)

    const occurrences = content.split(input.old_str).length - 1
    if (occurrences === 0) {
      throw new Error(`old_str did not appear verbatim in ${input.path}.`)
    }
    if (occurrences > 1) {
      throw new Error(`old_str appears ${occurrences} times in ${input.path}; make it unique.`)
    }

    await sandbox.writeText(input.path, content.replace(input.old_str, input.new_str))
    return `Edited ${input.path}.`
  },
})
