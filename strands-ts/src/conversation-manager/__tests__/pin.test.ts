import { describe, it, expect } from 'vitest'
import { pinMessage, unpinMessage, isPinned } from '../compression/pin-message.js'
import { Message, TextBlock, ToolUseBlock, ToolResultBlock } from '../../types/messages.js'

function makeMessage(text: string, metadata?: Record<string, unknown>): Message {
  return new Message({
    role: 'user',
    content: [new TextBlock(text)],
    ...(metadata !== undefined ? { metadata: metadata as any } : {}),
  })
}

describe('isPinned', () => {
  it('returns false for message without metadata', () => {
    expect(isPinned([makeMessage('hello')], 0)).toBe(false)
  })

  it('returns false for message with empty custom', () => {
    expect(isPinned([makeMessage('hello', { custom: {} })], 0)).toBe(false)
  })

  it('returns true for message with custom.pinned = true', () => {
    expect(isPinned([makeMessage('hello', { custom: { pinned: true } })], 0)).toBe(true)
  })

  it('returns false for message with custom.pinned = false', () => {
    expect(isPinned([makeMessage('hello', { custom: { pinned: false } })], 0)).toBe(false)
  })
})

describe('pinMessage', () => {
  it('sets pinned = true in custom metadata', () => {
    const messages = [makeMessage('important')]
    pinMessage(messages, 0)

    expect(isPinned(messages, 0)).toBe(true)
    expect(messages[0]!.role).toBe('user')
  })

  it('preserves existing metadata', () => {
    const messages = [makeMessage('important', { usage: { inputTokens: 10, outputTokens: 5 } })]
    pinMessage(messages, 0)

    expect(messages[0]!.metadata?.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(isPinned(messages, 0)).toBe(true)
  })

  it('preserves existing custom fields', () => {
    const messages = [makeMessage('important', { custom: { myField: 'value' } })]
    pinMessage(messages, 0)

    expect(messages[0]!.metadata?.custom?.myField).toBe('value')
    expect(isPinned(messages, 0)).toBe(true)
  })
})

describe('unpinMessage', () => {
  it('removes pinned from custom metadata', () => {
    const messages = [makeMessage('important')]
    pinMessage(messages, 0)
    unpinMessage(messages, 0)

    expect(isPinned(messages, 0)).toBe(false)
  })

  it('preserves other custom fields', () => {
    const messages = [makeMessage('important', { custom: { pinned: true, other: 'keep' } })]
    unpinMessage(messages, 0)

    expect(isPinned(messages, 0)).toBe(false)
    expect(messages[0]!.metadata?.custom?.other).toBe('keep')
  })

  it('removes metadata entirely when nothing remains', () => {
    const messages = [makeMessage('hello')]
    pinMessage(messages, 0)
    unpinMessage(messages, 0)

    expect(messages[0]!.metadata).toBeUndefined()
  })

  it('preserves non-custom metadata fields', () => {
    const messages = [
      makeMessage('important', { usage: { inputTokens: 10, outputTokens: 5 }, custom: { pinned: true } }),
    ]
    unpinMessage(messages, 0)

    expect(messages[0]!.metadata?.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(isPinned(messages, 0)).toBe(false)
  })
})

describe('isPinned with messages array', () => {
  it('returns false for unpinned message', () => {
    const messages = [makeMessage('a'), makeMessage('b')]
    expect(isPinned(messages, 0)).toBe(false)
  })

  it('returns true for pinned message', () => {
    const messages = [makeMessage('a'), makeMessage('b')]
    pinMessage(messages, 0)
    expect(isPinned(messages, 0)).toBe(true)
  })

  it('returns true for toolResult whose toolUse partner is pinned', () => {
    const messages = [
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ toolUseId: 'id-1', name: 'test', input: {} })],
      }),
      new Message({
        role: 'user',
        content: [new ToolResultBlock({ toolUseId: 'id-1', content: [new TextBlock('result')], status: 'success' })],
      }),
      makeMessage('other'),
    ]
    pinMessage(messages, 0)

    expect(isPinned(messages, 1)).toBe(true)
  })

  it('returns true for toolUse whose toolResult partner is pinned', () => {
    const messages = [
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ toolUseId: 'id-1', name: 'test', input: {} })],
      }),
      new Message({
        role: 'user',
        content: [new ToolResultBlock({ toolUseId: 'id-1', content: [new TextBlock('result')], status: 'success' })],
      }),
      makeMessage('other'),
    ]
    pinMessage(messages, 1)

    expect(isPinned(messages, 0)).toBe(true)
  })

  it('returns false for unrelated message next to pinned', () => {
    const messages = [makeMessage('a'), makeMessage('b')]
    pinMessage(messages, 0)
    expect(isPinned(messages, 1)).toBe(false)
  })
})
