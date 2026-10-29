/**
 * Sandbox-routed read tool.
 *
 * Reads a file through a [Sandbox](../../sandbox/base.ts): either one bound at
 * creation via {@link makeRead} or the agent's configured sandbox read from
 * `context.agent.sandbox` at call time. Text files return `cat -n` style
 * numbered lines so the model can cite `path:line`; images (png/jpg/jpeg/gif/webp)
 * and binary documents (pdf/doc/docx/xls/xlsx) return as media content blocks
 * when `media` is on.
 */

import { tool } from '../../tools/tool-factory.js'
import type { InvokableTool } from '../../tools/tool.js'
import { z } from 'zod'
import { Sandbox } from '../../sandbox/base.js'
import { DocumentBlock, ImageBlock } from '../../types/media.js'
import type { DocumentFormat, ImageFormat } from '../../mime.js'
import { validateAbsolutePath } from '../paths.js'

const READ_DEFAULT_LIMIT = 2000
const READ_MAX_BYTES = 1_048_576 // 1MB — mirrors fileEditor so a few long lines cannot blow out model context
const READ_MAX_MEDIA_BYTES = 10_485_760 // 10MB — guards memory + provider payload limits

// Media formats the SDK accepts in tool results, selected by file extension because the sandbox seam
// exposes no MIME metadata. Text-representable document formats (csv, html, txt, md) stay on the
// numbered-lines path, which supports citing and paging. Video is omitted: the SDK's tool results do
// not accept video content.
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
const RIFF = new Uint8Array([0x52, 0x49, 0x46, 0x46])
const WEBP = new Uint8Array([0x57, 0x45, 0x42, 0x50])

// Documents are picked by extension but checked by magic bytes before shipping as a document block, for
// the same history-poisoning reason as images. Legacy .doc/.xls are OLE2 compound files; .docx/.xlsx are
// ZIP containers.
const OLE2_SIGNATURE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ZIP_SIGNATURE = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
const DOCUMENT_SIGNATURES: Record<string, readonly Uint8Array[]> = {
  pdf: [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], // %PDF-
  doc: [OLE2_SIGNATURE],
  xls: [OLE2_SIGNATURE],
  docx: [ZIP_SIGNATURE],
  xlsx: [ZIP_SIGNATURE],
}

/**
 * Default model-facing description of the read tool. {@link makeRead} appends a media sentence when `media` is on.
 */
export const DEFAULT_READ_DESCRIPTION =
  'Read a file. Text returns `cat -n` style numbered lines so you can cite `path:line`. Files must use absolute paths.'
const MEDIA_DESCRIPTION_SUFFIX =
  ' Images (png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return media you can view directly.'

const readInputSchema = z.object({
  path: z.string().describe('Absolute path to the file.'),
  offset: z
    .number()
    .int()
    .min(1, 'offset must be a positive 1-indexed line number')
    .optional()
    .describe('1-indexed line to start from. Defaults to the first line. Text files only.'),
  limit: z
    .number()
    .int()
    .min(1, 'limit must be a positive line count')
    .optional()
    .describe('Maximum number of lines to return. Defaults to 2000. Text files only.'),
})

/**
 * Options for {@link makeRead}.
 */
export interface MakeReadOptions {
  /**
   * Return images and binary documents as viewable media. Set to `false` for a model that rejects
   * media blocks, and `read` describes those files in text instead. Defaults to `true`.
   */
  media?: boolean
  /** Tool name. Defaults to `'read'`. */
  name?: string
  /**
   * Description shown to the model. Defaults to {@link DEFAULT_READ_DESCRIPTION}, plus a sentence about
   * media when `media` is on.
   */
  description?: string
  /**
   * Maximum size of the returned text window in bytes. The 1MB default keeps a 1-line minified JSON file
   * from exhausting the model's context; raise it when the agent needs to read bigger single-line payloads.
   */
  maxBytes?: number
  /**
   * Maximum byte size for image and document reads. Defaults to 10MB, above Anthropic's 5MB image and
   * Bedrock's 4.5MB document limits.
   */
  maxMediaBytes?: number
}

type ReadTool = InvokableTool<z.infer<typeof readInputSchema>, string | ImageBlock | DocumentBlock>

/**
 * Create a sandbox-routed read tool that reads the sandbox from `context.agent.sandbox` at call time.
 * The returned tool throws at call time when `path` is not absolute or contains `..` segments.
 *
 * @param options - Media handling, size caps, and name/description overrides.
 * @returns A tool that reads files through the sandbox.
 */
export function makeRead(options?: MakeReadOptions): ReadTool
/**
 * Create a read tool bound to a sandbox at creation time. Used by users who want a customized read
 * tool. The returned tool throws at call time when `path` is not absolute or contains `..` segments.
 *
 * @param sandbox - Sandbox to bind. When `undefined`, the agent's sandbox is used at call time.
 * @param options - Media handling, size caps, and name/description overrides.
 * @returns A tool that reads files through the sandbox.
 */
export function makeRead(sandbox: Sandbox | undefined, options?: MakeReadOptions): ReadTool
export function makeRead(sandboxOrOptions?: Sandbox | MakeReadOptions, maybeOptions?: MakeReadOptions): ReadTool {
  const boundSandbox = sandboxOrOptions instanceof Sandbox ? sandboxOrOptions : undefined
  const options = sandboxOrOptions instanceof Sandbox || maybeOptions ? (maybeOptions ?? {}) : (sandboxOrOptions ?? {})
  const media = options.media ?? true
  const maxBytes = options.maxBytes ?? READ_MAX_BYTES
  const maxMediaBytes = options.maxMediaBytes ?? READ_MAX_MEDIA_BYTES

  return tool({
    name: options.name ?? 'read',
    description: options.description ?? DEFAULT_READ_DESCRIPTION + (media ? MEDIA_DESCRIPTION_SUFFIX : ''),
    inputSchema: readInputSchema,
    callback: async (input, context): Promise<string | ImageBlock | DocumentBlock> => {
      validateAbsolutePath(input.path)
      if (!boundSandbox && !context) throw new Error('Tool context is required for read operations')
      const sandbox = boundSandbox ?? context!.agent.sandbox
      const ext = extension(input.path)

      if (IMAGE_EXTENSIONS.includes(ext)) {
        const bytes = await sandbox.readFile(input.path)
        const imageFormat = sniffImageFormat(bytes)
        if (!imageFormat) {
          throw new Error(
            `${input.path} has a .${ext} extension but its ${bytes.length} bytes are not a png, jpeg, gif, ` +
              'or webp image. If a shell tool is available, use it to identify or extract text.'
          )
        }
        if (!media) return mediaPlaceholder(input.path, 'Image', imageFormat, bytes.length)
        assertMediaWithinSizeLimit(input.path, 'image', bytes.length, maxMediaBytes)
        return new ImageBlock({ format: imageFormat, source: { bytes } })
      }

      if (DOCUMENT_FORMATS.includes(ext)) {
        const bytes = await sandbox.readFile(input.path)
        if (!DOCUMENT_SIGNATURES[ext]!.some((signature) => startsWith(bytes, signature))) {
          throw new Error(
            `${input.path} has a .${ext} extension but its ${bytes.length} bytes are not a valid ${ext} ` +
              'document. If a shell tool is available, use it to identify or extract text.'
          )
        }
        if (!media) return mediaPlaceholder(input.path, 'Document', ext, bytes.length)
        assertMediaWithinSizeLimit(input.path, 'document', bytes.length, maxMediaBytes)
        return new DocumentBlock({ format: ext as DocumentFormat, name: documentName(input.path), source: { bytes } })
      }

      const bytes = await sandbox.readFile(input.path)
      let content: string
      try {
        // ignoreBOM keeps a leading U+FEFF in line 1, matching Python's bytes.decode('utf-8').
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch (error) {
        throw new Error(`${input.path} is not UTF-8 text. If a shell tool is available, inspect it there.`, {
          cause: error,
        })
      }

      const lines = content.split('\n')
      const start = input.offset ? input.offset - 1 : 0
      const count = input.limit ?? READ_DEFAULT_LIMIT
      const window = lines.slice(start, start + count)
      if (window.length === 0) {
        return `[File has ${lines.length} lines; offset ${input.offset} is past the end.]`
      }

      const windowBytes = new TextEncoder().encode(window.join('\n')).length
      if (windowBytes > maxBytes) {
        throw new Error(
          `Read window from ${input.path} is ${windowBytes} bytes (${window.length} lines), exceeding the ` +
            `${maxBytes}-byte limit. Reduce \`limit\` or shift \`offset\` to read a smaller slice.`
        )
      }

      let numbered = window.map((line, index) => `${String(index + start + 1).padStart(6)}\t${line}`).join('\n')
      if (start > 0 || start + count < lines.length) {
        const shownEnd = start + window.length
        numbered += `\n[Showing lines ${start + 1}-${shownEnd} of ${lines.length}. Use offset/limit to read more.]`
      }
      return numbered
    },
  })
}

/**
 * Default read tool. Reads the sandbox from the agent's context at call time.
 */
export const read = makeRead()

function extension(filePath: string): string {
  const name = filePath.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

// Bedrock accepts only alphanumerics, whitespace, hyphens, parentheses, and square brackets in document
// names, with no consecutive whitespace.
function documentName(filePath: string): string {
  const name = filePath.split(/[/\\]/).pop() ?? ''
  return (
    name
      .replace(/[^a-zA-Z0-9\s\-()[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'document'
  )
}

function startsWith(data: Uint8Array, prefix: Uint8Array, offset = 0): boolean {
  return data.length >= offset + prefix.length && prefix.every((byte, index) => data[offset + index] === byte)
}

function sniffImageFormat(data: Uint8Array): ImageFormat | undefined {
  if (startsWith(data, RIFF) && startsWith(data, WEBP, 8)) return 'webp'
  return IMAGE_SIGNATURES.find(([signature]) => startsWith(data, signature))?.[1]
}

function assertMediaWithinSizeLimit(filePath: string, kind: string, size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new Error(
      `${filePath} is ${size} bytes, exceeding the ${maxBytes}-byte limit for ${kind} reads. ` +
        'If a shell tool is available, use it to extract a smaller representation.'
    )
  }
}

function mediaPlaceholder(filePath: string, kind: string, mediaFormat: string, size: number): string {
  return (
    `[${kind} file: ${filePath} (${mediaFormat}, ${size} bytes). This model cannot view ` +
    `${kind.toLowerCase()} files, so its contents are not shown. If a shell tool is available, use it ` +
    'when the file has a text-extractable form.]'
  )
}
