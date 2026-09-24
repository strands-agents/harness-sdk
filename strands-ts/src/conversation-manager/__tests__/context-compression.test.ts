import { describe, it, expect, vi } from 'vitest'
import {
  adjustSplitPointForToolPairs,
  asUserSummary,
  findValidTrimPoint,
  generateSummary,
  matchesMessageType,
  DEFAULT_SUMMARIZATION_PROMPT,
} from '../compression/context-compression.js'
import { pinMessage, partitionPinned } from '../compression/pin-message.js'
import { Message, ReasoningBlock, TextBlock, ToolUseBlock, ToolResultBlock } from '../../types/messages.js'
import { CitationsBlock } from '../../types/citations.js'

function textMsg(role: 'user' | 'assistant', text: string): Message {
  return new Message({ role, content: [new TextBlock(text)] })
}

function toolUseMsg(toolUseId: string, name = 'test'): Message {
  return new Message({
    role: 'assistant',
    content: [new ToolUseBlock({ toolUseId, name, input: {} })],
  })
}

function toolResultMsg(toolUseId: string, text = 'result'): Message {
  return new Message({
    role: 'user',
    content: [new ToolResultBlock({ toolUseId, status: 'success', content: [new TextBlock(text)] })],
  })
}

describe('adjustSplitPointForToolPairs', () => {
  it('returns split point when message is plain text', () => {
    const messages = [textMsg('user', 'hello'), textMsg('assistant', 'hi'), textMsg('user', 'bye')]
    expect(adjustSplitPointForToolPairs(messages, 0)).toBe(0)
  })

  it('skips toolResult messages', () => {
    const messages = [toolResultMsg('id-1'), textMsg('user', 'hello')]
    expect(adjustSplitPointForToolPairs(messages, 0)).toBe(1)
  })

  it('skips toolUse without following toolResult', () => {
    const messages = [toolUseMsg('id-1'), textMsg('assistant', 'no result'), textMsg('user', 'hello')]
    expect(adjustSplitPointForToolPairs(messages, 0)).toBe(1)
  })

  it('accepts toolUse when followed by toolResult', () => {
    const messages = [toolUseMsg('id-1'), toolResultMsg('id-1'), textMsg('user', 'hello')]
    expect(adjustSplitPointForToolPairs(messages, 0)).toBe(0)
  })

  it('skips multiple consecutive toolResults', () => {
    const messages = [toolResultMsg('id-1'), toolResultMsg('id-2'), textMsg('user', 'hello')]
    expect(adjustSplitPointForToolPairs(messages, 0)).toBe(2)
  })

  it('throws when no valid split point exists', () => {
    const messages = [toolResultMsg('id-1'), toolResultMsg('id-2')]
    expect(() => adjustSplitPointForToolPairs(messages, 0)).toThrow('Unable to find valid split point')
  })

  it('returns splitPoint as-is when it equals messages.length', () => {
    const messages = [textMsg('user', 'hello'), textMsg('assistant', 'hi')]
    expect(adjustSplitPointForToolPairs(messages, 2)).toBe(2)
  })

  it('returns splitPoint as-is when it exceeds messages.length', () => {
    const messages = [textMsg('user', 'hello')]
    expect(adjustSplitPointForToolPairs(messages, 5)).toBe(5)
  })
})

describe('findValidTrimPoint', () => {
  it('finds plain user message', () => {
    const messages = [textMsg('user', 'hello'), textMsg('assistant', 'hi')]
    expect(findValidTrimPoint(messages, 0)).toBe(0)
  })

  it('skips non-user messages', () => {
    const messages = [textMsg('assistant', 'hi'), textMsg('user', 'hello')]
    expect(findValidTrimPoint(messages, 0)).toBe(1)
  })

  it('skips toolResult user messages', () => {
    const messages = [toolResultMsg('id-1'), textMsg('user', 'hello')]
    expect(findValidTrimPoint(messages, 0)).toBe(1)
  })

  it('returns messages.length when no valid point found', () => {
    const messages = [textMsg('assistant', 'hi'), toolResultMsg('id-1')]
    expect(findValidTrimPoint(messages, 0)).toBe(messages.length)
  })

  it('respects startIndex', () => {
    const messages = [textMsg('user', 'skip'), textMsg('assistant', 'hi'), textMsg('user', 'find')]
    expect(findValidTrimPoint(messages, 1)).toBe(2)
  })

  it('returns 0 for empty messages', () => {
    expect(findValidTrimPoint([], 0)).toBe(0)
  })
})

describe('matchesMessageType', () => {
  it('"all" always matches', () => {
    expect(matchesMessageType(textMsg('user', 'hello'), 'all')).toBe(true)
    expect(matchesMessageType(toolUseMsg('id-1'), 'all')).toBe(true)
    expect(matchesMessageType(toolResultMsg('id-1'), 'all')).toBe(true)
  })

  it('"tools" matches tool messages', () => {
    expect(matchesMessageType(toolUseMsg('id-1'), 'tools')).toBe(true)
    expect(matchesMessageType(toolResultMsg('id-1'), 'tools')).toBe(true)
  })

  it('"tools" does not match plain text', () => {
    expect(matchesMessageType(textMsg('user', 'hello'), 'tools')).toBe(false)
    expect(matchesMessageType(textMsg('assistant', 'hi'), 'tools')).toBe(false)
  })

  it('"messages" matches plain text', () => {
    expect(matchesMessageType(textMsg('user', 'hello'), 'messages')).toBe(true)
    expect(matchesMessageType(textMsg('assistant', 'hi'), 'messages')).toBe(true)
  })

  it('"messages" does not match tool messages', () => {
    expect(matchesMessageType(toolUseMsg('id-1'), 'messages')).toBe(false)
    expect(matchesMessageType(toolResultMsg('id-1'), 'messages')).toBe(false)
  })
})

describe('partitionPinned', () => {
  it('separates pinned and unpinned messages', () => {
    const messages = [textMsg('user', 'a'), textMsg('assistant', 'b'), textMsg('user', 'c')]
    pinMessage(messages, 1)

    const [pinned, unpinned] = partitionPinned(messages, 0, 3)
    expect(pinned).toHaveLength(1)
    expect(unpinned).toHaveLength(2)
  })

  it('respects rangeEnd', () => {
    const messages = [textMsg('user', 'a'), textMsg('assistant', 'b'), textMsg('user', 'c')]
    pinMessage(messages, 0)
    pinMessage(messages, 2)

    const [pinned, unpinned] = partitionPinned(messages, 0, 2)
    expect(pinned).toHaveLength(1)
    expect(unpinned).toHaveLength(1)
  })
})

describe('generateSummary', () => {
  function mockModel(summaryText: string) {
    const message = new Message({ role: 'assistant', content: [new TextBlock(summaryText)] })
    return {
      streamAggregated: vi.fn(() => ({
        next: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: undefined })
          .mockResolvedValueOnce({ done: true, value: { message } }),
        [Symbol.asyncIterator]: vi.fn(),
      })),
    }
  }

  it('returns a user-role message', async () => {
    const model = mockModel('Summary of conversation')
    const messages = [textMsg('user', 'hello'), textMsg('assistant', 'hi')]

    const result = await generateSummary(messages, model as any)

    expect(result.role).toBe('user')
  })

  it('passes the default system prompt', async () => {
    const model = mockModel('Summary')
    await generateSummary([textMsg('user', 'hello')], model as any)

    expect(model.streamAggregated).toHaveBeenCalledWith(expect.any(Array), {
      systemPrompt: DEFAULT_SUMMARIZATION_PROMPT,
    })
  })

  it('passes a custom system prompt', async () => {
    const model = mockModel('Summary')
    await generateSummary([textMsg('user', 'hello')], model as any, 'Custom prompt')

    expect(model.streamAggregated).toHaveBeenCalledWith(expect.any(Array), {
      systemPrompt: 'Custom prompt',
    })
  })

  it('appends summarization request message', async () => {
    const model = mockModel('Summary')
    const original = [textMsg('user', 'hello'), textMsg('assistant', 'hi')]
    await generateSummary(original, model as any)

    const passedMessages = (model.streamAggregated.mock.calls[0] as unknown as [Message[]])[0]
    expect(passedMessages).toHaveLength(3)
    expect((passedMessages[2]!.content[0] as TextBlock).text).toContain('summarize')
  })

  it('does not mutate original messages', async () => {
    const model = mockModel('Summary')
    const original = [textMsg('user', 'hello'), textMsg('assistant', 'hi')]
    await generateSummary(original, model as any)
    expect(original).toHaveLength(2)
  })

  it('throws if model returns no response', async () => {
    const model = {
      streamAggregated: vi.fn(() => ({
        next: vi.fn().mockResolvedValueOnce({ done: true, value: undefined }),
        [Symbol.asyncIterator]: vi.fn(),
      })),
    }

    await expect(generateSummary([textMsg('user', 'hello')], model as any)).rejects.toThrow(
      'Failed to generate summary'
    )
  })

  it('drops reasoning blocks from the summary', async () => {
    // A reasoning model's reply must not leak into the user-role summary;
    // Bedrock rejects it with "User messages cannot contain reasoning content" (#4402).
    const message = new Message({
      role: 'assistant',
      content: [new ReasoningBlock({ text: 'thinking', signature: 'sig' }), new TextBlock('Summary')],
    })
    const model = {
      streamAggregated: vi.fn(() => ({
        next: vi.fn().mockResolvedValueOnce({ done: true, value: { message } }),
        [Symbol.asyncIterator]: vi.fn(),
      })),
    }

    const result = await generateSummary([textMsg('user', 'hello')], model as any)

    expect(result.role).toBe('user')
    expect(result.content).toEqual([new TextBlock('Summary')])
  })
})

describe('asUserSummary', () => {
  it('keeps only text blocks', () => {
    const message = new Message({
      role: 'assistant',
      content: [
        new ReasoningBlock({ text: 'thinking', signature: 'sig' }),
        new TextBlock('Summary'),
        new ToolUseBlock({ toolUseId: 'id-1', name: 'test', input: {} }),
      ],
    })

    const result = asUserSummary(message)

    expect(result.role).toBe('user')
    expect(result.content).toEqual([new TextBlock('Summary')])
  })

  it('unwraps text from citations blocks', () => {
    const message = new Message({
      role: 'assistant',
      content: [new CitationsBlock({ citations: [], content: [{ text: 'Cited summary' }] })],
    })

    const result = asUserSummary(message)

    expect(result.role).toBe('user')
    expect(result.content).toEqual([new TextBlock('Cited summary')])
  })

  it('skips blank cited text', () => {
    const message = new Message({
      role: 'assistant',
      content: [new CitationsBlock({ citations: [], content: [{ text: 'Cited summary' }, { text: '' }] })],
    })

    expect(asUserSummary(message).content).toEqual([new TextBlock('Cited summary')])
  })

  it('throws when the reply has no text', () => {
    const message = new Message({
      role: 'assistant',
      content: [
        new ReasoningBlock({ text: 'thinking' }),
        new CitationsBlock({ citations: [], content: [{ text: '' }] }),
      ],
    })

    expect(() => asUserSummary(message)).toThrow('no text')
  })
})
