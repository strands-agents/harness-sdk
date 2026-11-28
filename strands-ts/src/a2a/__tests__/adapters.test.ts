import { describe, expect, it } from 'vitest'
import { A2AError } from '@a2a-js/sdk/server'
import { extractInterruptResponses, partsToContentBlocks, contentBlocksToParts } from '../adapters.js'
import { TextBlock, ToolUseBlock, ReasoningBlock, OffloadedBlock } from '../../types/messages.js'
import type { ContentBlock } from '../../types/messages.js'
import { ImageBlock, VideoBlock, DocumentBlock, encodeBase64 } from '../../types/media.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import type { Part } from '@a2a-js/sdk'

describe('adapters', () => {
  describe('extractInterruptResponses', () => {
    it('returns undefined when no part carries an interrupt response', () => {
      const parts: Part[] = [
        { kind: 'text', text: 'Hello' },
        { kind: 'data', data: { campaign: 'spring', budget: 100 } },
      ]

      expect(extractInterruptResponses(parts)).toBeUndefined()
    })

    it.each([null, 5, 'text', true])('leaves a data part holding %s to the generic content path', (data) => {
      const parts = [{ kind: 'data', data } as unknown as Part]

      expect(extractInterruptResponses(parts)).toBeUndefined()
    })

    it('refuses a non-object data part sent next to an interrupt response', () => {
      const parts = [
        { kind: 'data', data: null } as unknown as Part,
        { kind: 'data', data: { interruptResponse: { interruptId: 'int-1', response: 'yes' } } } as Part,
      ]

      expect(() => extractInterruptResponses(parts)).toThrow(
        A2AError.invalidParams('A message carrying interrupt responses must not contain other content parts')
      )
    })

    it('extracts one response per part, in order', () => {
      const parts: Part[] = [
        { kind: 'data', data: { interruptResponse: { interruptId: 'int-1', response: { approved: true } } } },
        { kind: 'data', data: { interruptResponse: { interruptId: 'int-2', response: 'no' } } },
      ]

      expect(extractInterruptResponses(parts)).toStrictEqual([
        new InterruptResponseContent({ interruptId: 'int-1', response: { approved: true } }),
        new InterruptResponseContent({ interruptId: 'int-2', response: 'no' }),
      ])
    })

    it.each([
      { desc: 'false', response: false },
      { desc: 'zero', response: 0 },
      { desc: 'an empty string', response: '' },
    ])('accepts a falsy answer: $desc', ({ response }) => {
      const parts: Part[] = [{ kind: 'data', data: { interruptResponse: { interruptId: 'int-1', response } } }]

      expect(extractInterruptResponses(parts)).toStrictEqual([
        new InterruptResponseContent({ interruptId: 'int-1', response }),
      ])
    })

    it.each([
      {
        desc: 'a payload that is not an object',
        data: { interruptResponse: 'not-an-object' },
        message: "'interruptResponse' must be an object with 'interruptId' and 'response'",
      },
      {
        desc: 'a payload that is an array',
        data: { interruptResponse: [] },
        message: "'interruptResponse' must be an object with 'interruptId' and 'response'",
      },
      {
        desc: 'a missing interruptId',
        data: { interruptResponse: { response: 'yes' } },
        message: "Interrupt response is missing a non-empty 'interruptId'",
      },
      {
        desc: 'an empty interruptId',
        data: { interruptResponse: { interruptId: '', response: 'yes' } },
        message: "Interrupt response is missing a non-empty 'interruptId'",
      },
      {
        desc: 'an interruptId that is not a string',
        data: { interruptResponse: { interruptId: 42, response: 'yes' } },
        message: "Interrupt response is missing a non-empty 'interruptId'",
      },
      {
        desc: 'a missing response',
        data: { interruptResponse: { interruptId: 'int-1' } },
        message: "Interrupt response for 'int-1' must provide a non-null 'response'",
      },
      {
        desc: 'a null response',
        data: { interruptResponse: { interruptId: 'int-1', response: null } },
        message: "Interrupt response for 'int-1' must provide a non-null 'response'",
      },
    ])('rejects $desc', ({ data, message }) => {
      expect(() => extractInterruptResponses([{ kind: 'data', data }])).toThrow(A2AError.invalidParams(message))
    })

    it('rejects two answers for the same interrupt', () => {
      const parts: Part[] = [
        { kind: 'data', data: { interruptResponse: { interruptId: 'int-1', response: { approved: true } } } },
        { kind: 'data', data: { interruptResponse: { interruptId: 'int-1', response: { approved: false } } } },
      ]

      expect(() => extractInterruptResponses(parts)).toThrow(
        A2AError.invalidParams("Duplicate interrupt response for 'int-1'")
      )
    })

    it('rejects an answer sent together with other content', () => {
      const parts: Part[] = [
        { kind: 'data', data: { interruptResponse: { interruptId: 'int-1', response: { approved: true } } } },
        { kind: 'text', text: 'and also do something else' },
      ]

      expect(() => extractInterruptResponses(parts)).toThrow(
        A2AError.invalidParams('A message carrying interrupt responses must not contain other content parts')
      )
    })
  })

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

    it('converts an offloaded block to the text the model receives', () => {
      const blocks: ContentBlock[] = [
        new OffloadedBlock({ text: '[Dropped] [ref: tu-1]', method: 'drop', ref: 'tu-1' }),
      ]

      expect(contentBlocksToParts(blocks)).toStrictEqual([{ kind: 'text', text: '[Dropped] [ref: tu-1]' }])
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
