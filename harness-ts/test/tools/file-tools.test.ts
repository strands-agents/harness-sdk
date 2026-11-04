import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { DocumentBlock, ImageBlock } from '@strands-agents/sdk'
import type { Agent, ToolContext } from '@strands-agents/sdk'

import { createHarness } from '../../src/agent.js'
import { edit, makeRead, read, write } from '../../src/tools/file-tools.js'
import { crc32 } from '../../src/tools/media-validation.js'

const bytesOf = (...parts: (Uint8Array | number[] | string)[]): Uint8Array =>
  new Uint8Array(Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p)))))
const b64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'))
const flip = (data: Uint8Array, at: number, count = 1): Uint8Array =>
  data.map((byte, i) => (i >= at && i < at + count ? byte ^ 0x55 : byte))

function pngChunk(kind: string, body: Uint8Array | number[]): Uint8Array {
  const typed = bytesOf(kind, body)
  const header = Buffer.alloc(4)
  header.writeUInt32BE(typed.length - 4)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return bytesOf(header, typed, crc)
}

/** A 2x2 RGB PNG; 14 pixel bytes when not interlaced, 15 when Adam7-interlaced. */
function png({ pixels = new Uint8Array(14), interlace = 0, beforeIdat = new Uint8Array() } = {}): Uint8Array {
  const ihdr = pngChunk('IHDR', [0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, interlace])
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return bytesOf(signature, ihdr, beforeIdat, pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', []))
}

/** A minimal compound file: header, one FAT sector, one directory sector naming `stream`. */
function ole(stream: string): Uint8Array {
  const file = Buffer.alloc(1536)
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(file)
  file.writeUInt16LE(9, 30)
  file.writeUInt32LE(1, 44)
  file.writeUInt32LE(1, 48)
  file.fill(0xff, 76, 512)
  file.writeUInt32LE(0, 76)
  file.fill(0xff, 512, 1024)
  file.writeUInt32LE(0xfffffffd, 512)
  file.writeUInt32LE(0xfffffffe, 516)
  Buffer.from(stream, 'utf16le').copy(file, 1024)
  return new Uint8Array(file)
}

const PNG = png()
const PNG_IDAT = Buffer.from(PNG).indexOf('IDAT') + 4
const JPEG = bytesOf(
  [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10],
  'JFIF',
  [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
  [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00],
  [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xd2, 0xcf, 0x20, 0xff, 0xd9]
)
const GIF = b64('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==')
const WEBP = b64('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==')
const PDF = bytesOf(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\nstartxref\n9\n%%EOF\n'
)
const HTML = '<!DOCTYPE html>\n<html><title>404 Not Found</title>\n<h1>Not Found</h1></html>\n'
// Zips holding [Content_Types].xml plus word/document.xml or xl/workbook.xml (and one without the former).
const DOCX = b64(
  'UEsDBBQAAAAIAAAAIVzHHBc8CgAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbLMJqSxILda3AwBQSwMEFAAAAAgAAAAhXOmJ/j0TAAAA3QAAABEAAAB3b3JkL2RvY3VtZW50LnhtbLNJyU8uzU3NK7GrGCbARh/uJQBQSwECFAMUAAAACAAAACFcxxwXPAoAAAAIAAAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAAAAIVzpif49EwAAAN0AAAARAAAAAAAAAAAAAACAATsAAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAgACAIAAAAB9AAAAAAA='
)
const XLSX = b64(
  'UEsDBBQAAAAIAAAAIVzHHBc8CgAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbLMJqSxILda3AwBQSwMEFAAAAAgAAAAhXOmJ/j0TAAAA3QAAAA8AAAB4bC93b3JrYm9vay54bWyzSclPLs1NzSuxqxgmwEYf7iUAUEsBAhQDFAAAAAgAAAAhXMccFzwKAAAACAAAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACAAAACFc6Yn+PRMAAADdAAAADwAAAAAAAAAAAAAAgAE7AAAAeGwvd29ya2Jvb2sueG1sUEsFBgAAAAACAAIAfgAAAHsAAAAAAA=='
)
const ZIP_WITHOUT_CONTENT_TYPES = b64(
  'UEsDBBQAAAAIAAAAIVzpif49EwAAAN0AAAARAAAAd29yZC9kb2N1bWVudC54bWyzSclPLs1NzSuxqxgmwEYf7iUAUEsBAhQDFAAAAAgAAAAhXOmJ/j0TAAAA3QAAABEAAAAAAAAAAAAAAIABAAAAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAABAAEAPwAAAEIAAAAAAA=='
)
const DOCX_PART = Buffer.from(DOCX).indexOf('word/document.xml') + 'word/document.xml'.length
const DOC = ole('WordDocument')
const XLS = ole('Workbook')
// Some writers mark unused FAT entries ENDOFCHAIN instead of FREE; Bedrock still accepts the file.
const DOC_STALE_FAT = bytesOf(DOC.subarray(0, 532), [0xfe, 0xff, 0xff, 0xff], DOC.subarray(536))

let agent: Agent
let dir: string

function ctx(): ToolContext {
  return { agent } as unknown as ToolContext
}

beforeEach(async () => {
  agent = await createHarness({ skills: false })
  dir = mkdtempSync(join(tmpdir(), 'strands-tools-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('read/write/edit', () => {
  it('writes then reads with numbered lines', async () => {
    const path = join(dir, 'f.txt')
    await write.invoke({ path, content: 'alpha\nbeta\n' }, ctx())
    const out = (await read.invoke({ path }, ctx())) as string
    expect(out).toContain('     1\talpha')
    expect(out).toContain('     2\tbeta')
  })

  it('pages with offset and limit', async () => {
    const path = join(dir, 'f.txt')
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n')
    await write.invoke({ path, content }, ctx())
    const out = (await read.invoke({ path, offset: 3, limit: 2 }, ctx())) as string
    expect(out).toContain('     3\tline3')
    expect(out).toContain('     4\tline4')
    expect(out).not.toContain('line5')
    expect(out).toContain('Showing lines 3-4 of 10')
  })

  it('edits a unique occurrence', async () => {
    const path = join(dir, 'f.txt')
    await write.invoke({ path, content: 'one\ntwo\nthree\n' }, ctx())
    await edit.invoke({ path, old_str: 'two', new_str: 'TWO' }, ctx())
    const out = (await read.invoke({ path }, ctx())) as string
    expect(out).toContain('     2\tTWO')
  })

  it('rejects an edit whose old_str is missing', async () => {
    const path = join(dir, 'f.txt')
    await write.invoke({ path, content: 'hello\n' }, ctx())
    await expect(edit.invoke({ path, old_str: 'missing', new_str: 'x' }, ctx())).rejects.toThrow(
      'did not appear verbatim'
    )
  })

  it('rejects an edit whose old_str is not unique', async () => {
    const path = join(dir, 'f.txt')
    await write.invoke({ path, content: 'dup\ndup\n' }, ctx())
    await expect(edit.invoke({ path, old_str: 'dup', new_str: 'x' }, ctx())).rejects.toThrow('appears 2 times')
  })

  it('returns an ImageBlock for an image extension', async () => {
    const path = join(dir, 'pic.png')
    const bytes = PNG
    writeFileSync(path, bytes)
    const out = await read.invoke({ path }, ctx())
    expect(out).toBeInstanceOf(ImageBlock)
    const image = out as ImageBlock
    expect(image.format).toBe('png')
    const imageSource = image.source as { type: string; bytes: Uint8Array }
    expect(imageSource.type).toBe('imageSourceBytes')
    expect(new Uint8Array(imageSource.bytes)).toEqual(bytes)
  })

  it('maps a jpg extension to the jpeg format', async () => {
    const path = join(dir, 'photo.JPG')
    writeFileSync(path, JPEG)
    const out = await read.invoke({ path }, ctx())
    expect((out as ImageBlock).format).toBe('jpeg')
  })

  it.each([
    ['a.gif', GIF, 'gif'],
    ['a.gif', bytesOf('GIF87a', GIF.subarray(6)), 'gif'],
    ['a.webp', WEBP, 'webp'],
    ['photo.jpg', PNG, 'png'],
    ['shot.png', JPEG, 'jpeg'],
  ])('image format follows the bytes, not the extension (%s)', async (name, bytes, expected) => {
    const path = join(dir, name)
    writeFileSync(path, new Uint8Array(bytes))
    const out = await read.invoke({ path }, ctx())
    expect((out as ImageBlock).format).toBe(expected)
  })

  it.each([
    ['binary', new Uint8Array([0x00, 0x01, 0x62, 0x69, 0x6e, 0xfe])],
    ['empty', new Uint8Array([])],
    ['truncated png signature', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x58])],
    ['riff but not webp', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])],
  ])('rejects non-image bytes under an image extension (%s)', async (_label, bytes) => {
    const path = join(dir, 'notes.png')
    writeFileSync(path, bytes)
    const message = `.png extension but its ${bytes.length} bytes are not`
    await expect(read.invoke({ path }, ctx())).rejects.toThrow(message)
    await expect(makeRead({ media: false }).invoke({ path }, ctx())).rejects.toThrow(message)
  })

  it('surfaces a non-image as an error tool result, never a success image block', async () => {
    const path = join(dir, 'notes.png')
    writeFileSync(path, bytesOf([0xfe, 0xfe], ' not text, not an image'))
    const result = await agent.tool.read!.invoke({ path }, { recordDirectToolCall: false })
    expect(result.status).toBe('error')
    expect(result.content).toHaveLength(1)
    expect((result.content[0] as { text?: string }).text).toContain('25 bytes are not a png, jpeg, gif, or webp image')
  })

  it('returns a DocumentBlock with a sanitized name for a binary document', async () => {
    const path = join(dir, 'my report_v2.pdf')
    const bytes = PDF
    writeFileSync(path, bytes)
    const out = await read.invoke({ path }, ctx())
    expect(out).toBeInstanceOf(DocumentBlock)
    const document = out as DocumentBlock
    expect(document.format).toBe('pdf')
    expect(document.name).toBe('my report v2 pdf')
    const documentSource = document.source as { type: string; bytes: Uint8Array }
    expect(documentSource.type).toBe('documentSourceBytes')
    expect(new Uint8Array(documentSource.bytes)).toEqual(bytes)
  })

  it('keeps text document formats on the numbered-lines path', async () => {
    const path = join(dir, 'data.csv')
    await write.invoke({ path, content: 'a,b\n1,2\n' }, ctx())
    const out = (await read.invoke({ path }, ctx())) as string
    expect(out).toContain('     1\ta,b')
  })

  it('rejects a relative path', async () => {
    await expect(read.invoke({ path: 'relative/path' }, ctx())).rejects.toThrow('not absolute')
  })

  it('rejects path traversal', async () => {
    await expect(read.invoke({ path: '/tmp/../etc/passwd' }, ctx())).rejects.toThrow('path traversal')
  })

  it('accepts Windows drive-letter paths as absolute', async () => {
    const written: string[] = []
    const sandbox = { writeText: async (path: string) => void written.push(path) }
    const winCtx = { agent: { sandbox } } as unknown as ToolContext
    await write.invoke({ path: 'C:\\Users\\me\\novel.json', content: '{}' }, winCtx)
    await write.invoke({ path: 'C:/Users/me/novel.json', content: '{}' }, winCtx)
    await write.invoke({ path: '\\\\server\\share\\novel.json', content: '{}' }, winCtx)
    expect(written).toEqual(['C:\\Users\\me\\novel.json', 'C:/Users/me/novel.json', '\\\\server\\share\\novel.json'])
    // Drive-relative (`C:foo`) is not absolute on either platform.
    await expect(write.invoke({ path: 'C:novel.json', content: '' }, winCtx)).rejects.toThrow('not absolute')
    await expect(write.invoke({ path: 'C:\\Users\\..\\secret', content: '' }, winCtx)).rejects.toThrow('path traversal')
  })
})

describe('read media capability', () => {
  it('returns media for a capable model', async () => {
    const path = join(dir, 'shot.png')
    writeFileSync(path, PNG)
    const out = await read.invoke({ path }, ctx())
    expect(out).toBeInstanceOf(ImageBlock)
  })

  it('describes an image in text when media is off', async () => {
    const path = join(dir, 'shot.png')
    writeFileSync(path, PNG)
    const out = await makeRead({ media: false }).invoke({ path }, ctx())
    expect(typeof out).toBe('string')
    expect(out).toContain(path)
    expect(out).toContain('png')
    expect(out).toContain('cannot view')
  })

  it('describes a document in text when media is off', async () => {
    const path = join(dir, 'spec.pdf')
    writeFileSync(path, PDF)
    const out = await makeRead({ media: false }).invoke({ path }, ctx())
    expect(typeof out).toBe('string')
    expect(out).toContain('pdf')
  })

  it('leaves text reads untouched when media is off', async () => {
    const path = join(dir, 'f.txt')
    await write.invoke({ path, content: 'alpha\nbeta\n' }, ctx())
    const out = await makeRead({ media: false }).invoke({ path }, ctx())
    expect(out).toContain('     1\talpha')
  })
})

describe('read media validation', () => {
  it.each([
    ['pic.png', PNG.subarray(0, PNG.length / 2)],
    ['pic.png', PNG.subarray(0, -12)],
    ['pic.png', flip(PNG, PNG_IDAT)],
    ['pic.png', png({ pixels: new Uint8Array(7) })],
    ['pic.png', png({ pixels: new Uint8Array(14), interlace: 1 })],
    ['pic.png', bytesOf(PNG.subarray(0, PNG_IDAT - 8), pngChunk('IDAT', bytesOf('not deflate')), pngChunk('IEND', []))],
    ['pic.jpg', JPEG.subarray(0, Buffer.from(JPEG).indexOf(Buffer.from([0xff, 0xda])))],
    ['pic.gif', GIF.subarray(0, 30)],
    ['pic.gif', GIF.subarray(0, 19)],
    ['pic.webp', WEBP.subarray(0, 24)],
    ['report.pdf', bytesOf('%PDF-1.4\n%', [0xe2, 0xe3, 0xcf, 0xd3], '\n1 0 obj\n<< /Type /Catalog >>\n')],
    ['report.docx', DOCX.subarray(0, DOCX.length / 2)],
    ['report.docx', bytesOf(DOCX.subarray(0, 4), DOCX.subarray(9))],
    ['report.docx', flip(DOCX, DOCX_PART, 20)],
    ['report.docx', ZIP_WITHOUT_CONTENT_TYPES],
    ['report.docx', XLSX],
    ['report.xls', DOC],
    ['report.doc', DOC.subarray(0, -512)],
  ])('rejects a truncated, corrupt, or mislabeled media file (%s #%#)', async (name, bytes) => {
    // Each of these fails the Bedrock request as a media block, and the history with it.
    const path = join(dir, name)
    writeFileSync(path, bytes)
    const message = new RegExp(`its ${bytes.length} bytes are not a valid \\w+ (image|document): \\w`)
    await expect(read.invoke({ path }, ctx())).rejects.toThrow(message)
    await expect(makeRead({ media: false }).invoke({ path }, ctx())).rejects.toThrow('are not a valid')
  })

  it.each([
    ['pic.png', bytesOf(PNG, 'trailing junk')],
    ['pic.png', png({ beforeIdat: bytesOf([0, 0, 0, 2], 'tEXtab', [0, 0, 0, 0]) })],
    ['pic.png', png({ pixels: new Uint8Array(15), interlace: 1 })],
    ['pic.jpg', JPEG.subarray(0, -2)],
    ['pic.gif', GIF.subarray(0, -1)],
    ['pic.webp', bytesOf(WEBP, 'trailing junk')],
    ['report.pdf', bytesOf('junk\n', PDF.subarray(0, Buffer.from(PDF).indexOf('%%EOF')))],
    ['report.docx', DOCX],
    ['report.doc', DOCX],
    ['report.xlsx', XLSX],
    ['report.xls', XLSX],
    ['report.doc', DOC],
    ['report.xls', XLS],
    ['report.docx', DOC],
    ['report.xls', ole('WORKBOOK')],
    ['report.xls', ole('Workbook\0WordDocument')],
    ['report.doc', ole('Workbook\0WordDocument')],
    ['report.doc', DOC_STALE_FAT],
  ])('returns media that Bedrock accepts (%s #%#)', async (name, bytes) => {
    // Imperfect but renderable files (as observed against Bedrock) stay media blocks.
    const path = join(dir, name)
    writeFileSync(path, bytes)
    const out = (await read.invoke({ path }, ctx())) as ImageBlock | DocumentBlock
    expect(out).toBeInstanceOf(name.startsWith('pic') ? ImageBlock : DocumentBlock)
    expect(new Uint8Array((out.source as { bytes: Uint8Array }).bytes)).toEqual(bytes)
  })

  it.each([true, false])('shows text saved under a media extension as text (media: %s)', async (media) => {
    const path = join(dir, 'report.pdf')
    writeFileSync(path, HTML)
    const out = (await makeRead({ media }).invoke({ path }, ctx())) as string
    expect(out.startsWith(`[${path} is not a valid pdf document: it has no %PDF- header. Showing it as text.]\n`)).toBe(
      true
    )
    expect(out).toContain('     3\t<h1>Not Found</h1></html>')
    const paged = (await read.invoke({ path, offset: 2, limit: 1 }, ctx())) as string
    expect(paged).toContain('     2\t<html><title>404 Not Found</title>')
    expect(paged).toContain('[Showing lines 2-2 of 4.')
  })

  it('rejects an empty media file', async () => {
    const path = join(dir, 'report.pdf')
    writeFileSync(path, '')
    await expect(read.invoke({ path }, ctx())).rejects.toThrow('its 0 bytes are not a valid pdf document')
  })

  it('surfaces an invalid document as an error tool result', async () => {
    const path = join(dir, 'report.pdf')
    writeFileSync(path, bytesOf('%PDF-1.7\n', [0xe2, 0xe3, 0xcf, 0xd3], ' cut off'))
    const result = await agent.tool.read!.invoke({ path }, { recordDirectToolCall: false })
    expect(result.status).toBe('error')
    expect(result.content).toHaveLength(1)
    expect((result.content[0] as { text?: string }).text).toContain(
      'not a valid pdf document: it has no cross-reference trailer'
    )
  })
})
