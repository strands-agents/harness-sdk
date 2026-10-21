import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

import type { ContentBlockData, DocumentFormat, ImageFormat } from '@strands-agents/sdk'

import type { ChatAttachment } from './chat/types.js'
import { splitArguments } from './terminal/arguments.js'
import { sanitizeTerminalText } from './terminal/sanitize.js'

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_ATTACHMENTS = 10
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024

const IMAGE_FORMATS: Readonly<Record<string, ImageFormat>> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
}

const BINARY_DOCUMENT_FORMATS = new Set<DocumentFormat>(['pdf', 'doc', 'docx', 'xls', 'xlsx'])
const TEXT_DOCUMENT_FORMATS = new Set<DocumentFormat>(['csv', 'html', 'txt', 'md', 'json', 'xml'])

export async function filePathsFromPaste(input: string, cwd: string): Promise<string[] | undefined> {
  const candidates = splitArguments(input.trim())
  // A real file-path paste never exceeds the attachment cap; bail before stat-ing every token of an ordinary text paste.
  if (candidates.length === 0 || candidates.length > MAX_ATTACHMENTS) {
    return undefined
  }
  const paths = candidates.map((candidate) => resolveFilePath(candidate, cwd))
  const results = await Promise.all(
    paths.map(async (path) => {
      try {
        return (await stat(path)).isFile()
      } catch {
        return false
      }
    })
  )
  return results.every(Boolean) ? paths : undefined
}

export async function loadAttachments(paths: readonly string[], cwd: string): Promise<ChatAttachment[]> {
  if (paths.length === 0) {
    return []
  }
  if (paths.length > MAX_ATTACHMENTS) {
    throw new Error(`Attach at most ${MAX_ATTACHMENTS} files at a time.`)
  }

  const attachments: ChatAttachment[] = []
  const seen = new Set<string>()
  let totalBytes = 0
  for (const input of paths) {
    const path = resolveFilePath(input, cwd)
    if (seen.has(path)) {
      continue
    }
    seen.add(path)
    const info = await stat(path).catch(() => undefined)
    if (!info?.isFile()) {
      throw new Error(`File not found: ${path}`)
    }
    if (info.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${basename(path)} is larger than the 20 MB attachment limit.`)
    }
    totalBytes += info.size
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error('Attachments exceed the 50 MB total limit.')
    }
    attachments.push(await loadAttachment(path, info.size))
  }
  return attachments
}

export function attachmentContent(text: string, attachments: readonly ChatAttachment[]): ContentBlockData[] {
  return [...(text ? [{ text }] : []), ...attachments.map((attachment) => attachment.content)]
}

function resolveFilePath(input: string, cwd: string): string {
  const decoded = input.startsWith('file://') ? fileURLToPath(input) : input
  return isAbsolute(decoded) ? resolve(decoded) : resolve(cwd, decoded)
}

async function loadAttachment(path: string, size: number): Promise<ChatAttachment> {
  const name = sanitizeTerminalText(basename(path)).replace(/\s+/g, ' ').trim() || 'attachment'
  const extension = extname(path).slice(1).toLowerCase()
  const bytes = new Uint8Array(await readFile(path))
  const imageFormat = IMAGE_FORMATS[extension]
  if (imageFormat) {
    return {
      path,
      name,
      size,
      kind: 'image',
      content: { image: { format: imageFormat, source: { bytes } } },
    }
  }

  if (BINARY_DOCUMENT_FORMATS.has(extension as DocumentFormat)) {
    return {
      path,
      name,
      size,
      kind: 'document',
      content: {
        document: {
          name: documentName(name),
          format: extension as DocumentFormat,
          source: { bytes },
        },
      },
    }
  }

  const text = decodeText(bytes, name)
  const format = TEXT_DOCUMENT_FORMATS.has(extension as DocumentFormat) ? (extension as DocumentFormat) : 'txt'
  return {
    path,
    name,
    size,
    kind: 'document',
    content: {
      document: {
        name: documentName(name),
        format,
        source: { text },
        ...(format === 'txt' && extension !== 'txt' ? { context: `Original filename: ${name}` } : {}),
      },
    },
  }
}

function decodeText(bytes: Uint8Array, name: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`Unsupported file type: ${name}. Attach an image, document, or UTF-8 text file.`)
  }
}

function documentName(name: string): string {
  const sanitized = name
    .replace(/[^a-zA-Z0-9\s\-()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized || 'document'
}
