import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { DocumentBlock, ImageBlock } from '@strands-agents/sdk'
import type { Agent, ToolContext } from '@strands-agents/sdk'

import { createHarness } from '../../src/agent.js'
import { edit, makeRead, read, write } from '../../src/tools/file-tools.js'
import { DOCX, GIF, HTML, JPEG, PDF, PNG, WEBP } from './media-fixtures.js'

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
    const bytes = new Uint8Array(PNG)
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
    ['a.gif', Buffer.concat([Buffer.from('GIF87a'), GIF.subarray(6)]), 'gif'],
    ['a.webp', WEBP, 'webp'],
    ['photo.jpg', PNG, 'png'],
    ['shot.png', JPEG, 'jpeg'],
  ])('image format follows the bytes, not the extension (%s)', async (name, bytes, expected) => {
    const path = join(dir, name)
    writeFileSync(path, bytes)
    const out = await read.invoke({ path }, ctx())
    expect((out as ImageBlock).format).toBe(expected)
  })

  it.each([
    ['binary', new Uint8Array([0x00, 0x01, 0x62, 0x69, 0x6e, 0x61, 0x72, 0x79, 0xfe])],
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
    writeFileSync(path, Buffer.from('\xfe\xfe not text, not an image', 'latin1'))
    const result = await agent.tool.read!.invoke({ path }, { recordDirectToolCall: false })
    expect(result.status).toBe('error')
    expect(result.content).toHaveLength(1)
    expect((result.content[0] as { text?: string }).text).toContain('25 bytes are not a png, jpeg, gif, or webp image')
  })

  it('returns a DocumentBlock with a sanitized name for a binary document', async () => {
    const path = join(dir, 'my report_v2.pdf')
    const bytes = new Uint8Array(PDF)
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

describe('read invalid media', () => {
  it.each([
    ['full media', read],
    ['media off', makeRead({ media: false })],
  ])('shows a text file under a media extension as text (%s)', async (_label, tool) => {
    const path = join(dir, 'report.pdf')
    writeFileSync(path, HTML)
    const out = (await tool.invoke({ path }, ctx())) as string
    expect(
      out.startsWith(
        `[${path} is not a valid pdf document: it has no %PDF- header. Showing it as text.]\n     1\t<!DOCTYPE html>`
      )
    ).toBe(true)
  })

  it('pages a text file under a media extension', async () => {
    const path = join(dir, 'notes.png')
    writeFileSync(path, 'one\ntwo\nthree\n')
    const out = await read.invoke({ path, offset: 2, limit: 1 }, ctx())
    expect(out).toBe(
      `[${path} is not a png, jpeg, gif, or webp image. Showing it as text.]\n` +
        '     2\ttwo\n[Showing lines 2-2 of 4. Use offset/limit to read more.]'
    )
    const past = (await read.invoke({ path, offset: 9 }, ctx())) as string
    expect(past.endsWith('[File has 4 lines; offset 9 is past the end.]')).toBe(true)
  })

  it.each([
    ['full media', read],
    ['media off', makeRead({ media: false })],
  ])('fails a broken binary media file (%s)', async (_label, tool) => {
    const path = join(dir, 'chart.png')
    writeFileSync(path, PNG.subarray(0, -12))
    await expect(tool.invoke({ path }, ctx())).rejects.toThrow(
      `${path} has a .png extension but its ${PNG.length - 12} bytes are not a valid png image: it is truncated. ` +
        'Identify it with `file`.'
    )
  })

  it('surfaces a broken document as an error tool result', async () => {
    // Sent as a document block, this would fail the request and every later one.
    const path = join(dir, 'report.docx')
    writeFileSync(path, DOCX.subarray(0, DOCX.length / 2))
    const result = await agent.tool.read!.invoke({ path }, { recordDirectToolCall: false })
    expect(result.status).toBe('error')
    expect(result.content).toHaveLength(1)
    expect((result.content[0] as { text?: string }).text).toContain(
      'not a valid docx document: its zip archive is corrupt or truncated'
    )
  })

  it('fails an empty document', async () => {
    const path = join(dir, 'empty.pdf')
    writeFileSync(path, '')
    await expect(read.invoke({ path }, ctx())).rejects.toThrow(
      'its 0 bytes are not a valid pdf document: it has no %PDF- header.'
    )
  })
})
