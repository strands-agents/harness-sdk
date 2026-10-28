/**
 * Tests for the sandbox-routed read tool.
 *
 * Exercised against a real `NotASandboxLocalEnvironment` (host filesystem) via
 * `invoke`, which surfaces thrown errors directly (wrapping errors into an error
 * status only happens through the tool's `stream` path). Path semantics assume POSIX,
 * so these are skipped on Windows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { Buffer } from 'buffer'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeRead, read } from '../index.js'
import type { ToolContext } from '../../../index.js'
import { ImageBlock, DocumentBlock, TextBlock, ToolResultBlock } from '../../../index.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { collectGenerator } from '../../../__fixtures__/model-test-helpers.js'
import { NotASandboxLocalEnvironment } from '../../../sandbox/not-a-sandbox-local-environment.js'
import type { Sandbox } from '../../../sandbox/base.js'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
const OLE2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
const text = (value: string) => new TextEncoder().encode(value)
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts))

function toolContext(sandbox: Sandbox = new NotASandboxLocalEnvironment()): ToolContext {
  const agent = createMockAgent({ extra: { sandbox } })
  return {
    toolUse: { name: 'read', toolUseId: 'test-id', input: {} },
    agent,
    invocationState: {},
    cancelSignal: agent.cancelSignal,
    interrupt: () => {
      throw new Error('interrupt not available in mock context')
    },
  }
}

describe.skipIf(process.platform === 'win32')('read tool', () => {
  const reader = makeRead(new NotASandboxLocalEnvironment())
  const readerTextOnly = makeRead(new NotASandboxLocalEnvironment(), { media: false })
  const ctx = toolContext()
  let tmpPath: string

  beforeEach(() => {
    tmpPath = mkdtempSync(join(tmpdir(), 'read-tool-test-'))
  })

  afterEach(() => {
    rmSync(tmpPath, { recursive: true, force: true })
  })

  describe('text', () => {
    it('returns numbered lines', async () => {
      const filePath = join(tmpPath, 'f.txt')
      writeFileSync(filePath, 'alpha\nbeta\n')
      const out = await reader.invoke({ path: filePath }, ctx)
      expect(out).toBe('     1\talpha\n     2\tbeta\n     3\t')
    })

    it('offset and limit page through the file', async () => {
      const filePath = join(tmpPath, 'f.txt')
      writeFileSync(filePath, Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join('\n'))
      const out = await reader.invoke({ path: filePath, offset: 3, limit: 2 }, ctx)
      expect(out).toBe('     3\tline3\n     4\tline4\n[Showing lines 3-4 of 10. Use offset/limit to read more.]')
    })

    it('offset past the end returns a message', async () => {
      const filePath = join(tmpPath, 'f.txt')
      writeFileSync(filePath, 'one\ntwo\n')
      const out = await reader.invoke({ path: filePath, offset: 100 }, ctx)
      expect(out).toBe('[File has 3 lines; offset 100 is past the end.]')
    })
  })

  describe('images', () => {
    it('png returns image content', async () => {
      const filePath = join(tmpPath, 'pic.png')
      const bytes = concat(PNG, text('fake'))
      writeFileSync(filePath, bytes)
      const { result } = await collectGenerator(
        reader.stream({ ...ctx, toolUse: { name: 'read', toolUseId: 'test-id', input: { path: filePath } } })
      )
      expect(result).toEqual(
        new ToolResultBlock({
          toolUseId: 'test-id',
          status: 'success',
          content: [new ImageBlock({ format: 'png', source: { bytes: expect.any(Uint8Array) } })],
        })
      )
      expect(Array.from(((result.content[0] as ImageBlock).source as { bytes: Uint8Array }).bytes)).toEqual(
        Array.from(bytes)
      )
    })

    it('jpg extension maps to jpeg format', async () => {
      const filePath = join(tmpPath, 'photo.JPG')
      writeFileSync(filePath, concat(JPEG, text('fake')))
      const result = await reader.invoke({ path: filePath }, ctx)
      expect(result).toBeInstanceOf(ImageBlock)
      expect((result as ImageBlock).format).toBe('jpeg')
    })

    it.each([
      ['a.gif', concat(text('GIF89a fake')), 'gif'],
      ['a.gif', concat(text('GIF87a fake')), 'gif'],
      ['a.webp', concat(text('RIFF'), new Uint8Array(4), text('WEBPVP8 fake')), 'webp'],
      ['photo.jpg', concat(PNG, text('fake')), 'png'],
      ['shot.png', concat(JPEG, text('fake')), 'jpeg'],
    ])('format follows bytes, not extension (%s -> %s)', async (name, data, expected) => {
      const filePath = join(tmpPath, name)
      writeFileSync(filePath, data)
      const result = await reader.invoke({ path: filePath }, ctx)
      expect(result).toBeInstanceOf(ImageBlock)
      expect((result as ImageBlock).format).toBe(expected)
    })

    it.each([
      text('this is plain text\n'),
      new Uint8Array(0),
      concat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x58]), text('truncated signature')),
      concat(text('RIFF'), new Uint8Array(4), text('WAVE')),
    ])('rejects non-image bytes under an image extension (%o)', async (data) => {
      const filePath = join(tmpPath, 'notes.png')
      writeFileSync(filePath, data)
      const message = `${filePath} has a .png extension but its ${data.length} bytes are not a png, jpeg, gif, or webp image. If a shell tool is available, use it to identify or extract text.`
      await expect(reader.invoke({ path: filePath }, ctx)).rejects.toThrow(message)
      await expect(readerTextOnly.invoke({ path: filePath }, ctx)).rejects.toThrow(message)
    })

    it('a rejected non-image surfaces as an error tool result', async () => {
      // A rejected file must reach history as a text error result, not a success image block.
      const filePath = join(tmpPath, 'notes.png')
      writeFileSync(filePath, 'this is plain text\n')
      const { result } = await collectGenerator(
        reader.stream({ ...ctx, toolUse: { name: 'read', toolUseId: 't1', input: { path: filePath } } })
      )
      expect(result.status).toBe('error')
      expect(result.content).toHaveLength(1)
      expect(result.content[0]).toBeInstanceOf(TextBlock)
      expect((result.content[0] as TextBlock).text).toContain('19 bytes are not a png, jpeg, gif, or webp image')
    })
  })

  describe('documents', () => {
    it('pdf returns document content', async () => {
      const filePath = join(tmpPath, 'my report_v2.pdf')
      const bytes = text('%PDF-1.4 fake')
      writeFileSync(filePath, bytes)
      const { result } = await collectGenerator(
        reader.stream({ ...ctx, toolUse: { name: 'read', toolUseId: 'test-id', input: { path: filePath } } })
      )
      expect(result).toEqual(
        new ToolResultBlock({
          toolUseId: 'test-id',
          status: 'success',
          content: [
            new DocumentBlock({ format: 'pdf', name: 'my report v2 pdf', source: { bytes: expect.any(Uint8Array) } }),
          ],
        })
      )
      expect(Array.from(((result.content[0] as DocumentBlock).source as { bytes: Uint8Array }).bytes)).toEqual(
        Array.from(bytes)
      )
    })

    it('text-representable formats stay on the numbered path', async () => {
      const filePath = join(tmpPath, 'data.csv')
      writeFileSync(filePath, 'a,b\n1,2\n')
      const out = await reader.invoke({ path: filePath }, ctx)
      expect(out).toBe('     1\ta,b\n     2\t1,2\n     3\t')
    })

    it.each([
      ['notes.pdf', text('this is plain text\n')],
      ['notes.pdf', concat(ZIP, text('fake'))], // zip bytes under a pdf extension
      ['sheet.xlsx', text('this is plain text\n')], // expected zip
      ['sheet.xlsx', concat(OLE2, text('fake'))], // ole2 bytes under xlsx
      ['legacy.doc', concat(ZIP, text('fake'))], // zip bytes under legacy ole2 extension
    ])('rejects mislabeled document bytes (%s)', async (name, data) => {
      const filePath = join(tmpPath, name)
      writeFileSync(filePath, data)
      const ext = name.split('.').pop()
      const message = `${filePath} has a .${ext} extension but its ${data.length} bytes are not a valid ${ext} document. If a shell tool is available, use it to identify or extract text.`
      await expect(reader.invoke({ path: filePath }, ctx)).rejects.toThrow(message)
      await expect(readerTextOnly.invoke({ path: filePath }, ctx)).rejects.toThrow(message)
    })
  })

  describe('media off', () => {
    it('describes an image as text', async () => {
      const filePath = join(tmpPath, 'shot.png')
      writeFileSync(filePath, concat(PNG, text('fake')))
      const out = await readerTextOnly.invoke({ path: filePath }, ctx)
      expect(out).toBe(
        `[Image file: ${filePath} (png, 12 bytes). This model cannot view image files, so its contents are not shown. If a shell tool is available, use it when the file has a text-extractable form.]`
      )
    })

    it('describes a document as text', async () => {
      const filePath = join(tmpPath, 'spec.pdf')
      writeFileSync(filePath, '%PDF-1.7 fake')
      const out = await readerTextOnly.invoke({ path: filePath }, ctx)
      expect(out).toBe(
        `[Document file: ${filePath} (pdf, 13 bytes). This model cannot view document files, so its contents are not shown. If a shell tool is available, use it when the file has a text-extractable form.]`
      )
    })

    it('leaves text reads untouched', async () => {
      const filePath = join(tmpPath, 'f.txt')
      writeFileSync(filePath, 'alpha\nbeta\n')
      const out = await readerTextOnly.invoke({ path: filePath }, ctx)
      expect(out).toBe('     1\talpha\n     2\tbeta\n     3\t')
    })
  })

  describe('path validation', () => {
    it('rejects a relative path', async () => {
      await expect(reader.invoke({ path: 'relative/path' }, ctx)).rejects.toThrow('not absolute')
    })

    it('rejects path traversal', async () => {
      await expect(reader.invoke({ path: '/tmp/../etc/passwd' }, ctx)).rejects.toThrow('path traversal')
    })
  })

  describe('size caps', () => {
    it('rejects a window exceeding maxBytes', async () => {
      const filePath = join(tmpPath, 'big.txt')
      writeFileSync(filePath, 'x'.repeat(1_048_576 + 1))
      await expect(reader.invoke({ path: filePath }, ctx)).rejects.toThrow('exceeding the 1048576-byte limit')
    })

    it('rejects an oversize image', async () => {
      const filePath = join(tmpPath, 'huge.png')
      writeFileSync(filePath, concat(PNG, text('x'.repeat(10_485_760 + 1))))
      await expect(reader.invoke({ path: filePath }, ctx)).rejects.toThrow(
        'exceeding the 10485760-byte limit for image reads'
      )
    })

    it('rejects an oversize document', async () => {
      const filePath = join(tmpPath, 'huge.pdf')
      writeFileSync(filePath, concat(text('%PDF-'), text('x'.repeat(10_485_760 + 1))))
      await expect(reader.invoke({ path: filePath }, ctx)).rejects.toThrow(
        'exceeding the 10485760-byte limit for document reads'
      )
    })

    it('oversize image returns a placeholder when media is off', async () => {
      const filePath = join(tmpPath, 'huge.png')
      writeFileSync(filePath, concat(PNG, text('x'.repeat(10_485_760 + 1))))
      const out = await readerTextOnly.invoke({ path: filePath }, ctx)
      expect(typeof out).toBe('string')
      expect(out as string).toMatch(/^\[Image file:/)
    })

    it('oversize document returns a placeholder when media is off', async () => {
      const filePath = join(tmpPath, 'huge.pdf')
      writeFileSync(filePath, concat(text('%PDF-'), text('x'.repeat(10_485_760 + 1))))
      const out = await readerTextOnly.invoke({ path: filePath }, ctx)
      expect(typeof out).toBe('string')
      expect(out as string).toMatch(/^\[Document file:/)
    })

    it('maxBytes is configurable', async () => {
      const filePath = join(tmpPath, 'f.txt')
      writeFileSync(filePath, 'x'.repeat(2000)) // one line, 2000 bytes
      const readerSmall = makeRead(new NotASandboxLocalEnvironment(), { maxBytes: 1000 })
      await expect(readerSmall.invoke({ path: filePath }, ctx)).rejects.toThrow('exceeding the 1000-byte limit')
      const readerBig = makeRead(new NotASandboxLocalEnvironment(), { maxBytes: 4096 })
      const out = await readerBig.invoke({ path: filePath }, ctx)
      expect(out).toBe(`     1\t${'x'.repeat(2000)}`)
    })

    it('maxMediaBytes is configurable', async () => {
      const filePath = join(tmpPath, 'pic.png')
      writeFileSync(filePath, concat(PNG, text('x'.repeat(1000))))
      const readerSmall = makeRead(new NotASandboxLocalEnvironment(), { maxMediaBytes: 500 })
      await expect(readerSmall.invoke({ path: filePath }, ctx)).rejects.toThrow(
        'exceeding the 500-byte limit for image reads'
      )
    })
  })

  describe('non-UTF-8', () => {
    it('keeps a leading byte-order mark', async () => {
      const filePath = join(tmpPath, 'bom.txt')
      writeFileSync(filePath, concat(new Uint8Array([0xef, 0xbb, 0xbf]), text('hello\n')))
      const out = await reader.invoke({ path: filePath }, ctx)
      expect(out).toBe('     1\t\uFEFFhello\n     2\t')
    })

    it('raises a clear error', async () => {
      const filePath = join(tmpPath, 'data.txt')
      writeFileSync(filePath, concat(text('valid\n'), new Uint8Array([0xe9, 0xff, 0xfe, 0x0a])))
      await expect(reader.invoke({ path: filePath }, ctx)).rejects.toThrow(
        `${filePath} is not UTF-8 text. If a shell tool is available, inspect it there.`
      )
    })
  })

  describe('offset/limit validation', () => {
    it.each([0, -1, -100])('rejects non-positive offset %i', async (offset) => {
      const filePath = join(tmpPath, 'f.txt')
      writeFileSync(filePath, 'one\n')
      await expect(reader.invoke({ path: filePath, offset }, ctx)).rejects.toThrow(
        'offset must be a positive 1-indexed line number'
      )
    })

    it.each([0, -1, -100])('rejects non-positive limit %i', async (limit) => {
      const filePath = join(tmpPath, 'f.txt')
      writeFileSync(filePath, 'one\n')
      await expect(reader.invoke({ path: filePath, limit }, ctx)).rejects.toThrow('limit must be a positive line count')
    })
  })

  describe('offset/limit must be integers', () => {
    it.each([{ offset: 1.5 }, { limit: 2.5 }])('rejects %o', async (window) => {
      const filePath = join(tmpPath, 'f.txt')
      writeFileSync(filePath, 'one\ntwo\n')
      await expect(reader.invoke({ path: filePath, ...window }, ctx)).rejects.toThrow()
    })
  })

  describe('agent sandbox fallback', () => {
    it('uses the agent sandbox when unbound', async () => {
      const filePath = join(tmpPath, 'f.txt')
      writeFileSync(filePath, 'hello\n')
      const out = await read.invoke({ path: filePath }, toolContext())
      expect(out).toBe('     1\thello\n     2\t')
    })

    it('bound sandbox does not require context', async () => {
      const filePath = join(tmpPath, 'f.txt')
      writeFileSync(filePath, 'hello\n')
      const out = await reader.invoke({ path: filePath })
      expect(out).toBe('     1\thello\n     2\t')
    })

    it('unbound sandbox requires context', async () => {
      const filePath = join(tmpPath, 'f.txt')
      writeFileSync(filePath, 'hello\n')
      await expect(read.invoke({ path: filePath })).rejects.toThrow('Tool context is required for read operations')
    })
  })
})

describe('makeRead description', () => {
  it('default description appends the media suffix', () => {
    expect(makeRead().toolSpec.description).toBe(
      'Read a file. Text returns `cat -n` style numbered lines so you can cite `path:line`. Files must use absolute paths. Images (png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return media you can view directly.'
    )
  })

  it('media-off description omits the media suffix', () => {
    expect(makeRead({ media: false }).toolSpec.description).toBe(
      'Read a file. Text returns `cat -n` style numbered lines so you can cite `path:line`. Files must use absolute paths.'
    )
  })

  it('explicit description wins', () => {
    expect(makeRead({ media: false, description: 'Custom.' }).toolSpec.description).toBe('Custom.')
  })
})
