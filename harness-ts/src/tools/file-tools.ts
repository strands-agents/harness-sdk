/**
 * Filesystem tools: `read`, `write`, `edit`.
 *
 * Thin tools that route file access through the same `context.agent.sandbox` seam the SDK's file
 * editor uses, so they behave identically across host and container filesystems. They are
 * candidates to port into the core SDK later; keep them minimal and SDK-idiomatic.
 */

import { posix, win32 } from 'node:path'
import { TextDecoder } from 'node:util'

import { DocumentBlock, ImageBlock, tool } from '@strands-agents/sdk'
import type { DocumentFormat, ImageFormat, ToolContext } from '@strands-agents/sdk'
import { z } from 'zod'

import { documentProblem, imageProblem, imageSize } from './media-validation.js'

const READ_DEFAULT_LIMIT = 2000

// Media formats the read tool returns as viewable content, selected by file extension because the
// sandbox seam exposes no MIME metadata. Text-representable document formats (csv, html, txt, md)
// stay on the numbered-lines path, which supports citing and paging. Video is omitted: the Python
// SDK's tool results do not accept video content, and the two libraries keep behavior parity.
const IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp']
const DOCUMENT_FORMATS: readonly string[] = ['pdf', 'doc', 'docx', 'xls', 'xlsx']

// For images the extension only selects the media path; the signature decides the format. A non-image or
// mislabeled file sent as a success image block poisons history (every later request fails on it).
const IMAGE_SIGNATURES: readonly [Uint8Array, ImageFormat][] = [
  [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'png'],
  [new Uint8Array([0xff, 0xd8, 0xff]), 'jpeg'],
  [new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]), 'gif'], // GIF87a
  [new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), 'gif'], // GIF89a
]

function validatePath(path: string): void {
  // The path belongs to the sandbox, not the host, so accept either platform's notion of absolute. The two
  // libraries disagree only on backslash-rooted-without-drive (`\foo`: Node yes, Python 3.13 no); that
  // divergence is intentional and stdlib-driven, so do not hand-roll the check to make the SDKs agree.
  if (!posix.isAbsolute(path) && !win32.isAbsolute(path)) {
    throw new Error(
      `The path ${path} is not absolute; it should start with '/' (or a drive letter or UNC share on Windows).`
    )
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

function startsWith(data: Uint8Array, prefix: Uint8Array, offset = 0): boolean {
  return data.length >= offset + prefix.length && prefix.every((byte, i) => data[offset + i] === byte)
}

const RIFF = new Uint8Array([0x52, 0x49, 0x46, 0x46])
const WEBP = new Uint8Array([0x57, 0x45, 0x42, 0x50])

function sniffImageFormat(data: Uint8Array): ImageFormat | undefined {
  if (startsWith(data, RIFF) && startsWith(data, WEBP, 8)) return 'webp'
  return IMAGE_SIGNATURES.find(([signature]) => startsWith(data, signature))?.[1]
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

interface MediaCheck {
  kind: 'Image' | 'Document'
  format: string
  /** What the file should be, for the message when it is not. */
  expected: string
  /** Why the file is not usable as media; `undefined` when it is, `''` when there is nothing to add. */
  problem: string | undefined
}

function checkMedia(ext: string, bytes: Uint8Array): MediaCheck {
  if (DOCUMENT_FORMATS.includes(ext)) {
    return { kind: 'Document', format: ext, expected: `a valid ${ext} document`, problem: documentProblem(bytes, ext) }
  }
  const format = sniffImageFormat(bytes)
  if (!format) return { kind: 'Image', format: ext, expected: 'a png, jpeg, gif, or webp image', problem: '' }
  return { kind: 'Image', format, expected: `a valid ${format} image`, problem: imageProblem(bytes, format) }
}

function mediaResult(path: string, check: MediaCheck, bytes: Uint8Array, media: boolean): ReadOutput {
  if (!media) return mediaPlaceholder(path, check.kind, check.format, bytes.length)
  if (check.kind === 'Image') return new ImageBlock({ format: check.format as ImageFormat, source: { bytes } })
  return new DocumentBlock({ name: documentName(path), format: check.format as DocumentFormat, source: { bytes } })
}

function throwIfTooLarge(path: string, format: ImageFormat, bytes: Uint8Array, limits: ImageLimits): void {
  // The model rejects a larger image, and the rejected block stays in history, failing every later turn.
  const { maxImageBytes, maxImageDimension } = limits
  const [width, height] = imageSize(bytes, format) ?? [0, 0]
  const tooHeavy = maxImageBytes !== undefined && bytes.length > maxImageBytes
  const tooWide = maxImageDimension !== undefined && Math.max(width, height) > maxImageDimension
  if (!tooHeavy && !tooWide) return
  const accepted = [maxImageBytes && `${maxImageBytes} bytes`, maxImageDimension && `${maxImageDimension} px per side`]
  throw new Error(
    `${path} is a ${width}x${height} px ${format} image of ${bytes.length} bytes, larger than this model accepts ` +
      `(${accepted.filter(Boolean).join(' and ')}). Write a smaller copy with a shell tool (for example ImageMagick ` +
      '`magick`, macOS `sips`, or Python Pillow) and read that.'
  )
}

function invalidMediaAsText(
  path: string,
  ext: string,
  bytes: Uint8Array,
  expected: string,
  problem: string
): [string, string] {
  // Sending it as media would fail the request and every later one, so show text or throw instead.
  const reason = problem ? `: ${problem}` : ''
  let content = ''
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    // Not UTF-8: falls through to the error below.
  }
  if (!content || content.includes('\0')) {
    throw new Error(
      `${path} has a .${ext} extension but its ${bytes.length} bytes are not ${expected}${reason}. ` +
        'Identify it with `file`.'
    )
  }
  return [`[${path} is not ${expected}${reason}. Showing it as text.]\n`, content]
}

function readCallback(
  media: boolean,
  limits: ImageLimits = {}
): (input: ReadInput, context?: ToolContext) => Promise<ReadOutput> {
  return async (input: ReadInput, context?: ToolContext): Promise<ReadOutput> => {
    if (!context) throw new Error('Tool context is required for read.')
    validatePath(input.path)
    const ext = extension(input.path)

    let note = ''
    let content: string
    if (IMAGE_EXTENSIONS.includes(ext) || DOCUMENT_FORMATS.includes(ext)) {
      const bytes = await context.agent.sandbox.readFile(input.path)
      const check = checkMedia(ext, bytes)
      if (check.problem === undefined) {
        if (media && check.kind === 'Image') throwIfTooLarge(input.path, check.format as ImageFormat, bytes, limits)
        return mediaResult(input.path, check, bytes, media)
      }
      ;[note, content] = invalidMediaAsText(input.path, ext, bytes, check.expected, check.problem)
    } else {
      content = await context.agent.sandbox.readText(input.path)
    }

    const lines = content.split('\n')
    const start = Math.max(0, input.offset ? input.offset - 1 : 0)
    const count = input.limit ?? READ_DEFAULT_LIMIT
    const window = lines.slice(start, start + count)
    if (window.length === 0) {
      return `${note}[File has ${lines.length} lines; offset ${input.offset} is past the end.]`
    }

    let numbered = note + numberLines(window.join('\n'), start + 1)
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

/** The largest image a model accepts; `read` fails the call for a larger one. See `imageLimits` in `models.ts`. */
export interface ImageLimits {
  /** Largest image file, in bytes. */
  maxImageBytes?: number
  /** Largest image width or height, in pixels. */
  maxImageDimension?: number
}

export interface MakeReadOptions extends ImageLimits {
  /** Return images and binary documents as viewable media. Defaults to true. */
  media?: boolean
}

/**
 * Build the `read` tool.
 *
 * Pass `media: false` for a model that rejects image and document blocks, and `read` describes those
 * files in text instead. See `supportsMedia` in `models.ts`.
 */
export function makeRead({ media = true, ...limits }: MakeReadOptions = {}): typeof read {
  return tool({
    name: 'read',
    description: READ_DESCRIPTION,
    inputSchema: READ_SCHEMA,
    callback: readCallback(media, limits),
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
