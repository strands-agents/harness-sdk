import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentBlock, ImageBlock } from '@strands-agents/sdk'
import type { Agent, ToolContext } from '@strands-agents/sdk'

import { createHarness } from '../../src/agent.js'
import { edit, makeRead, read, write } from '../../src/tools/file-tools.js'

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
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
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
    writeFileSync(path, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
    const out = await read.invoke({ path }, ctx())
    expect((out as ImageBlock).format).toBe('jpeg')
  })

  it('returns a DocumentBlock with a sanitized name for a binary document', async () => {
    const path = join(dir, 'my report_v2.pdf')
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
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
})

describe('read media capability', () => {
  it('returns media for a capable model', async () => {
    const path = join(dir, 'shot.png')
    writeFileSync(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const out = await read.invoke({ path }, ctx())
    expect(out).toBeInstanceOf(ImageBlock)
  })

  it('describes an image in text when media is off', async () => {
    const path = join(dir, 'shot.png')
    writeFileSync(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const out = await makeRead({ media: false }).invoke({ path }, ctx())
    expect(typeof out).toBe('string')
    expect(out).toContain(path)
    expect(out).toContain('png')
    expect(out).toContain('cannot view')
  })

  it('describes a document in text when media is off', async () => {
    const path = join(dir, 'spec.pdf')
    writeFileSync(path, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]))
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
