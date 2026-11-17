import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { attachmentContent, filePathsFromPaste, loadAttachments } from '../../src/ui/chat/attachments.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { splitArguments } from '../../src/terminal/arguments.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

describe('chat attachments', () => {
  it('parses quoted, escaped, and Windows paths without invoking a shell', () => {
    expect(splitArguments(`one.png "two words.pdf" three\\ words.md 'four words.txt'`)).toEqual([
      'one.png',
      'two words.pdf',
      'three words.md',
      'four words.txt',
    ])
    expect(splitArguments(`"C:\\Users\\Jane Doe\\frog.png"`)).toEqual(['C:\\Users\\Jane Doe\\frog.png'])
    expect(splitArguments(`  '' "" one''two ""three  `)).toEqual(['', '', 'onetwo', 'three'])
    expect(() => splitArguments(`one "two`)).toThrow('Close the quoted value and try again.')
  })

  it.each([
    String.raw`\\server\share\frog.png`,
    String.raw`"\\server\share\frog.png"`,
    String.raw`'\\server\share\frog.png'`,
    String.raw`\\\\server\share\frog.png`,
  ])('preserves the network root in %s', (input) => {
    expect(splitArguments(input)).toEqual([String.raw`\\server\share\frog.png`])
  })

  it('preserves quoted UNC spaces and existing quote, whitespace, and backslash escapes', () => {
    expect(splitArguments(String.raw`"\\server\shared folder\frog.png" one\ two \"three\" four\\five`)).toEqual([
      String.raw`\\server\shared folder\frog.png`,
      'one two',
      '"three"',
      String.raw`four\five`,
    ])
    expect(splitArguments(String.raw`"\\"`)).toEqual(['\\'])
    expect(splitArguments(String.raw`\\ `)).toEqual(['\\'])
  })

  it('leaves ordinary pasted text alone', async () => {
    const root = await temporaryDirectory()

    await expect(filePathsFromPaste('please review this text', root)).resolves.toBeUndefined()
  })

  it('resolves relative attachments against the unmodified conversation workspace', async () => {
    const root = join(await temporaryDirectory(), 'team\u007fagent')
    await mkdir(root)
    const path = join(root, 'notes.txt')
    await writeFile(path, 'fixture notes')
    const controller = new ChatController(idleBackend(), { runtime: { cwd: root } })
    try {
      const cwd = controller.getSnapshot().runtime.cwd
      expect(cwd).toBe(root)
      await expect(filePathsFromPaste('notes.txt', cwd)).resolves.toEqual([path])
      await expect(loadAttachments(['notes.txt'], cwd)).resolves.toMatchObject([
        { path, content: { document: { source: { text: 'fixture notes' } } } },
      ])
    } finally {
      await controller.dispose()
    }
  })

  it('loads images, binary documents, and UTF-8 source files as model content', async () => {
    const root = await temporaryDirectory()
    const imagePath = join(root, 'frog.png')
    const documentPath = join(root, 'report.pdf')
    const sourcePath = join(root, 'agent.ts')
    await writeFile(imagePath, new Uint8Array([1, 2, 3]))
    await writeFile(documentPath, new Uint8Array([4, 5]))
    await writeFile(sourcePath, 'export const frog = true\n')

    const attachments = await loadAttachments([imagePath, documentPath, sourcePath], root)

    expect(attachments.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'frog.png', kind: 'image' },
      { name: 'report.pdf', kind: 'document' },
      { name: 'agent.ts', kind: 'document' },
    ])
    expect(attachmentContent('Review these', attachments)).toEqual([
      { text: 'Review these' },
      { image: { format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } } },
      { document: { name: 'report pdf', format: 'pdf', source: { bytes: new Uint8Array([4, 5]) } } },
      {
        document: {
          name: 'agent ts',
          format: 'txt',
          source: { text: 'export const frog = true\n' },
          context: 'Original filename: agent.ts',
        },
      },
    ])
  })

  it('rejects unsupported binary files explicitly', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'archive.zip')
    await writeFile(path, new Uint8Array([0xff, 0xfe, 0xfd]))

    await expect(loadAttachments([path], root)).rejects.toThrow(
      'Unsupported file type: archive.zip. Attach an image, document, or UTF-8 text file.'
    )
  })

  it.each(['constructor', '__proto__'])('loads a UTF-8 .%s file as a document', async (extension) => {
    const root = await temporaryDirectory()
    const path = join(root, `notes.${extension}`)
    await writeFile(path, 'ordinary UTF-8 notes')

    const [attachment] = await loadAttachments([path], root)

    expect(attachment).toMatchObject({
      kind: 'document',
      content: { document: { format: 'txt', source: { text: 'ordinary UTF-8 notes' } } },
    })
  })

  it.skipIf(process.platform === 'win32')(
    'sanitizes draft labels while preserving the actual attachment path',
    async () => {
      const root = await temporaryDirectory()
      const path = join(root, 'frog\u001b]2;changed title\u0007\nphoto.png')
      await writeFile(path, new Uint8Array([1, 2, 3]))

      const [attachment] = await loadAttachments([path], root)

      expect(attachment).toMatchObject({ path, name: 'frog photo.png', kind: 'image' })
    }
  )
})
