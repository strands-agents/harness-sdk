import { describe, expect, it } from 'vitest'
import { partsToContentBlocks, contentBlocksToParts } from '../adapters.js'
import { TextBlock, ToolUseBlock, ReasoningBlock } from '../../types/messages.js'
import type { ContentBlock } from '../../types/messages.js'
import { ImageBlock, VideoBlock, DocumentBlock, encodeBase64 } from '../../types/media.js'
import type { Part } from '@a2a-js/sdk'

describe('adapters', () => {
  describe('partsToContentBlocks', () => {
    it('converts text parts to TextBlocks', () => {
      const parts: Part[] = [
        { kind: 'text', text: 'Hello' },
        { kind: 'text', text: 'World' },
      ]

      const blocks = partsToContentBlocks(parts)

      expect(blocks).toHaveLength(2)
      expect(blocks[0]).toBeInstanceOf(TextBlock)
      expect((blocks[0] as TextBlock).text).toBe('Hello')
      expect((blocks[1] as TextBlock).text).toBe('World')
    })

    it.each([
      { mimeType: 'image/png', BlockClass: ImageBlock, format: 'png' },
      { mimeType: 'image/jpeg', BlockClass: ImageBlock, format: 'jpeg' },
      { mimeType: 'video/mp4', BlockClass: VideoBlock, format: 'mp4' },
      { mimeType: 'application/pdf', BlockClass: DocumentBlock, format: 'pdf' },
      { mimeType: 'application/vnd.ms-excel', BlockClass: DocumentBlock, format: 'xls' },
      { mimeType: 'application/octet-stream', BlockClass: DocumentBlock, format: 'octet-stream' },
    ])(
      'converts file with bytes and MIME $mimeType to correct block with format $format',
      ({ mimeType, BlockClass, format }) => {
        const parts: Part[] = [{ kind: 'file', file: { bytes: encodeBase64('fake-data'), mimeType, name: 'test' } }]

        const blocks = partsToContentBlocks(parts)

        expect(blocks).toHaveLength(1)
        expect(blocks[0]).toBeInstanceOf(BlockClass)
        expect((blocks[0] as ImageBlock | VideoBlock | DocumentBlock).format).toBe(format)
      }
    )

    it.each([
      {
        desc: 'with name',
        file: { uri: 'https://example.com/file.txt', name: 'readme.txt' },
        expected: '[File: readme.txt (https://example.com/file.txt)]',
      },
      {
        desc: 'without name (defaults to "file")',
        file: { uri: 'https://example.com/file.txt' },
        expected: '[File: file (https://example.com/file.txt)]',
      },
    ])('converts file with URI to TextBlock — $desc', ({ file, expected }) => {
      const blocks = partsToContentBlocks([{ kind: 'file', file }])

      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toBeInstanceOf(TextBlock)
      expect((blocks[0] as TextBlock).text).toBe(expected)
    })

    it('converts data parts to TextBlock with JSON', () => {
      const parts: Part[] = [{ kind: 'data', data: { key: 'value', count: 42 } }]

      const blocks = partsToContentBlocks(parts)

      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toBeInstanceOf(TextBlock)
      const text = (blocks[0] as TextBlock).text
      expect(text).toContain('[Structured Data]')
      expect(text).toContain('"key": "value"')
    })

    it('handles mixed part types', () => {
      const parts: Part[] = [
        { kind: 'text', text: 'Hello' },
        { kind: 'file', file: { uri: 'file://test.txt' } },
        { kind: 'data', data: { foo: 'bar' } },
      ]

      const blocks = partsToContentBlocks(parts)

      expect(blocks).toHaveLength(3)
      expect(blocks[0]).toBeInstanceOf(TextBlock)
      expect(blocks[1]).toBeInstanceOf(TextBlock) // URI file → text fallback
      expect(blocks[2]).toBeInstanceOf(TextBlock) // data → text
    })

    it('returns empty array for empty input', () => {
      expect(partsToContentBlocks([])).toStrictEqual([])
    })
  })

  describe('contentBlocksToParts', () => {
    it('converts text blocks to text parts', () => {
      const blocks: ContentBlock[] = [new TextBlock('Hello'), new TextBlock('World')]

      expect(contentBlocksToParts(blocks)).toStrictEqual([
        { kind: 'text', text: 'Hello' },
        { kind: 'text', text: 'World' },
      ])
    })

    it.each([
      {
        desc: 'ImageBlock with bytes',
        block: new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([137, 80, 78, 71]) } }),
        expected: {
          kind: 'file',
          file: { bytes: encodeBase64(new Uint8Array([137, 80, 78, 71])), mimeType: 'image/png' },
        },
      },
      {
        desc: 'ImageBlock with URL',
        block: new ImageBlock({ format: 'jpeg', source: { url: 'https://example.com/img.jpg' } }),
        expected: { kind: 'file', file: { uri: 'https://example.com/img.jpg', mimeType: 'image/jpeg' } },
      },
      {
        desc: 'VideoBlock with bytes',
        block: new VideoBlock({ format: 'mp4', source: { bytes: new Uint8Array([0, 0, 0]) } }),
        expected: { kind: 'file', file: { bytes: encodeBase64(new Uint8Array([0, 0, 0])), mimeType: 'video/mp4' } },
      },
      {
        desc: 'DocumentBlock with bytes',
        block: new DocumentBlock({ name: 'doc.pdf', format: 'pdf', source: { bytes: new Uint8Array([37, 80]) } }),
        expected: {
          kind: 'file',
          file: { bytes: encodeBase64(new Uint8Array([37, 80])), mimeType: 'application/pdf', name: 'doc.pdf' },
        },
      },
      {
        desc: 'DocumentBlock with text source',
        block: new DocumentBlock({ name: 'readme', format: 'txt', source: { text: 'Hello doc' } }),
        expected: { kind: 'text', text: 'Hello doc' },
      },
    ])('converts $desc to file part', ({ block, expected }) => {
      expect(contentBlocksToParts([block])).toStrictEqual([expected])
    })

    it('handles mixed text and media blocks', () => {
      const blocks: ContentBlock[] = [
        new TextBlock('Caption'),
        new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2]) } }),
        new TextBlock('End'),
      ]

      const parts = contentBlocksToParts(blocks)

      expect(parts).toHaveLength(3)
      expect(parts[0]).toStrictEqual({ kind: 'text', text: 'Caption' })
      expect(parts[1]).toStrictEqual({
        kind: 'file',
        file: { bytes: encodeBase64(new Uint8Array([1, 2])), mimeType: 'image/png' },
      })
      expect(parts[2]).toStrictEqual({ kind: 'text', text: 'End' })
    })

    it('skips unsupported block types', () => {
      const blocks: ContentBlock[] = [
        new TextBlock('Hello'),
        new ToolUseBlock({ name: 'test', toolUseId: 'id-1', input: {} }),
        new ReasoningBlock({ text: 'thinking' }),
      ]

      expect(contentBlocksToParts(blocks)).toStrictEqual([{ kind: 'text', text: 'Hello' }])
    })

    it.each([
      { desc: 'empty input', blocks: [] as ContentBlock[] },
      {
        desc: 'no convertible blocks',
        blocks: [new ToolUseBlock({ name: 'test', toolUseId: 'id-1', input: {} })] as ContentBlock[],
      },
    ])('returns empty array for $desc', ({ blocks }) => {
      expect(contentBlocksToParts(blocks)).toStrictEqual([])
    })
  })
})
