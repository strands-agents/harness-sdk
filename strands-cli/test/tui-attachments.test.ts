import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { attachmentContent, filePathsFromPaste, loadAttachments } from '../src/tui/attachments.js'
import { splitArguments } from '../src/tui/terminal/arguments.js'
import { temporaryDirectory } from './fixtures/tempdir.js'

describe('chat attachments', () => {
  it('parses quoted, escaped, and Windows paths without invoking a shell', () => {
    expect(splitArguments(`one.png "two words.pdf" three\\ words.md 'four words.txt'`)).toEqual([
      'one.png',
      'two words.pdf',
      'three words.md',
      'four words.txt',
    ])
    expect(splitArguments(`"C:\\Users\\Jane Doe\\frog.png"`)).toEqual(['C:\\Users\\Jane Doe\\frog.png'])
  })

  it('leaves ordinary pasted text alone', async () => {
    const root = await temporaryDirectory()

    await expect(filePathsFromPaste('please review this text', root)).resolves.toBeUndefined()
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
