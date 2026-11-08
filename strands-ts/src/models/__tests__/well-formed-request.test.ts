import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  JsonBlock,
  Message,
  ReasoningBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  type ContentBlock,
} from '../../types/messages.js'
import { ImageBlock } from '../../types/media.js'
import { buildPreview } from '../../context-manager/methods/truncate.js'
import { warnOnce } from '../../logging/warn-once.js'
import { wellFormedRequest } from '../well-formed-request.js'

vi.mock('../../logging/warn-once.js', () => ({
  warnOnce: vi.fn(),
}))

const LONE_HIGH = '\ud83d'
const LONE_LOW = '\ude02'
const REPLACEMENT = '\ufffd'

function userMessage(...content: ContentBlock[]): Message {
  return new Message({ role: 'user', content })
}

function jsonToolResult(json: JsonBlock['json']): Message {
  return userMessage(new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new JsonBlock({ json })] }))
}

// https://github.com/strands-agents/harness-sdk/issues/5937: a lone surrogate must never reach a provider
describe('wellFormedRequest', () => {
  beforeEach(() => {
    vi.mocked(warnOnce).mockClear()
  })

  describe('when the request contains lone surrogates', () => {
    it('replaces them in text and keeps intact pairs', () => {
      const [messages] = wellFormedRequest([userMessage(new TextBlock(`a${LONE_HIGH}b😂c${LONE_LOW}`))])

      expect(messages[0]!.content).toEqual([new TextBlock(`a${REPLACEMENT}b😂c${REPLACEMENT}`)])
    })

    it('repairs a preview whose truncation split a surrogate pair', () => {
      // previewTokens 750 keeps 1800 head chars, and the last of them is the high surrogate of 😂
      const preview = buildPreview('a'.repeat(1799) + '😂' + 'b'.repeat(5000), 1, { previewTokens: 750 })

      const [messages] = wellFormedRequest([userMessage(new TextBlock(preview))])

      expect(messages[0]!.content).toEqual([
        new TextBlock(
          '[Truncated: 1 block, ~1,701 tokens]\n\n' +
            'a'.repeat(1799) +
            `${REPLACEMENT}\n\n[... 3,801 chars elided ...]\n\n` +
            'b'.repeat(1200)
        ),
      ])
    })

    it('reaches text and JSON nested in tool results', () => {
      const block = new ToolResultBlock({
        toolUseId: 't1',
        status: 'success',
        content: [new TextBlock(`x${LONE_HIGH}`), new JsonBlock({ json: { nested: [`y${LONE_LOW}`] } })],
      })

      const [messages] = wellFormedRequest([userMessage(block)])

      expect(messages[0]!.content).toEqual([
        new ToolResultBlock({
          toolUseId: 't1',
          status: 'success',
          content: [new TextBlock(`x${REPLACEMENT}`), new JsonBlock({ json: { nested: [`y${REPLACEMENT}`] } })],
        }),
      ])
    })

    it('reaches tool use input', () => {
      const block = new ToolUseBlock({ name: 'lookup', toolUseId: 't1', input: { query: `q${LONE_HIGH}` } })

      const [messages] = wellFormedRequest([new Message({ role: 'assistant', content: [block] })])

      expect(messages[0]!.content).toEqual([
        new ToolUseBlock({ name: 'lookup', toolUseId: 't1', input: { query: `q${REPLACEMENT}` } }),
      ])
    })

    it('repairs object keys', () => {
      const [messages] = wellFormedRequest([jsonToolResult({ [`k${LONE_HIGH}`]: 1 })])

      expect(messages[0]!.content).toEqual(jsonToolResult({ [`k${REPLACEMENT}`]: 1 }).content)
    })

    it('keeps an own __proto__ key as data', () => {
      const json = JSON.parse('{"__proto__":{"inherited":1},"s":"\\ud83d"}') as JsonBlock['json']

      const [messages] = wellFormedRequest([jsonToolResult(json)])

      const [block] = (messages[0]!.content[0] as ToolResultBlock).content
      expect(JSON.stringify(block)).toBe(`{"json":{"__proto__":{"inherited":1},"s":"${REPLACEMENT}"}}`)
    })

    it('covers block types it has no specific knowledge of', () => {
      class UnknownBlock {
        readonly type = 'unknownBlock'
        constructor(readonly text: string) {}
      }

      const [messages] = wellFormedRequest([userMessage(new UnknownBlock(`a${LONE_HIGH}`) as unknown as ContentBlock)])

      expect(messages[0]!.content).toStrictEqual([new UnknownBlock(`a${REPLACEMENT}`)])
    })

    it('replaces them in the system prompt and tool specs and keeps other options', () => {
      const cancelSignal = new AbortController().signal
      const toolSpecs = [{ name: 'lookup', description: `d${LONE_LOW}`, inputSchema: { type: 'object' as const } }]

      const [, fromString] = wellFormedRequest([], { cancelSignal, systemPrompt: `s${LONE_HIGH}`, toolSpecs })
      const [, fromBlocks] = wellFormedRequest([], { systemPrompt: [new TextBlock(`s${LONE_HIGH}`)] })

      expect(fromString).toEqual({
        cancelSignal,
        systemPrompt: `s${REPLACEMENT}`,
        toolSpecs: [{ name: 'lookup', description: `d${REPLACEMENT}`, inputSchema: { type: 'object' } }],
      })
      expect(fromBlocks).toEqual({ systemPrompt: [new TextBlock(`s${REPLACEMENT}`)] })
    })

    it('keeps the identity of a repaired message and leaves the original untouched', () => {
      const original = new Message({
        role: 'user',
        content: [new TextBlock(`a${LONE_HIGH}`)],
        trackingId: 'tracking-1',
        metadata: { custom: { key: 'value' } },
      })

      const [messages] = wellFormedRequest([original])

      expect(messages).toStrictEqual([
        new Message({
          role: 'user',
          content: [new TextBlock(`a${REPLACEMENT}`)],
          trackingId: 'tracking-1',
          metadata: { custom: { key: 'value' } },
        }),
      ])
      expect(original.content).toEqual([new TextBlock(`a${LONE_HIGH}`)])
    })

    it('repairs unsigned reasoning', () => {
      const [messages] = wellFormedRequest([userMessage(new ReasoningBlock({ text: `r${LONE_HIGH}` }))])

      expect(messages[0]!.content).toEqual([new ReasoningBlock({ text: `r${REPLACEMENT}` })])
    })

    it('leaves signed reasoning, binary content, and error objects as they are', () => {
      const reasoning = new ReasoningBlock({ text: `r${LONE_HIGH}`, signature: 'signature' })
      const image = new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2]) } })
      const cyclicError = Object.assign(new Error('failed'), { self: {} })
      cyclicError.self = cyclicError
      const failure = new ToolResultBlock({
        toolUseId: 't1',
        status: 'error',
        content: [new TextBlock(`x${LONE_HIGH}`)],
        error: cyclicError,
      })

      const [messages] = wellFormedRequest([userMessage(reasoning, image, failure)])

      const [sentReasoning, sentImage, sentFailure] = messages[0]!.content
      expect(sentReasoning).toBe(reasoning)
      expect(sentImage).toBe(image)
      expect((sentFailure as ToolResultBlock).error).toBe(cyclicError)
      expect((sentFailure as ToolResultBlock).content).toEqual([new TextBlock(`x${REPLACEMENT}`)])
    })

    it('warns when messages were repaired', () => {
      wellFormedRequest([userMessage(new TextBlock(`a${LONE_HIGH}`))])

      expect(warnOnce).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'replaced lone surrogates in model request')
    })

    it('warns when only the options were repaired', () => {
      wellFormedRequest([], { systemPrompt: `s${LONE_HIGH}` })

      expect(warnOnce).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'replaced lone surrogates in model request')
    })
  })

  describe('when the request is well-formed', () => {
    it('returns the same messages and options without copying or warning', () => {
      const messages = [userMessage(new TextBlock('plain 😂'))]
      const options = { systemPrompt: 'plain 😂', toolSpecs: [] }

      const [sentMessages, sentOptions] = wellFormedRequest(messages, options)

      expect(sentMessages).toBe(messages)
      expect(sentOptions).toBe(options)
      expect(warnOnce).not.toHaveBeenCalled()
    })

    it('does not treat NaN as a change', () => {
      const messages = [jsonToolResult({ score: Number.NaN })]

      expect(wellFormedRequest(messages)[0]).toBe(messages)
    })

    it('ignores message metadata, which is never sent', () => {
      const messages = [
        new Message({
          role: 'user',
          content: [new TextBlock('plain')],
          metadata: { custom: { key: `v${LONE_HIGH}` } },
        }),
      ]

      expect(wellFormedRequest(messages)[0]).toBe(messages)
      expect(warnOnce).not.toHaveBeenCalled()
    })

    it('returns undefined options when there are none', () => {
      expect(wellFormedRequest([])[1]).toBeUndefined()
    })
  })
})
