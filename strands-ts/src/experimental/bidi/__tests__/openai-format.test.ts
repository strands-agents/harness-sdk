import { describe, expect, it } from 'vitest'
import { formatHistory, formatInput } from '../models/openai-format.js'
import { AudioBlock, ImageBlock } from '../../../types/media.js'
import { Message, TextBlock, ToolUseBlock } from '../../../types/messages.js'

describe('OpenAI Realtime input conversion', () => {
  it('preserves user text and tool schema values in history', () => {
    const events = formatHistory([new Message({ role: 'user', content: [new TextBlock('Hello')] })])
    expect(events).toEqual([
      {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      },
    ])
  })

  it('rejects recorded audio instead of silently dropping history', () => {
    expect(() =>
      formatHistory([
        new Message({
          role: 'user',
          content: [new AudioBlock({ format: 'wav', source: { bytes: new Uint8Array(2) } })],
        }),
      ])
    ).toThrow('Unsupported Realtime history block')
  })

  it('rejects tool requests from user history', () => {
    expect(() =>
      formatHistory([
        new Message({ role: 'user', content: [new ToolUseBlock({ toolUseId: 'call', name: 'lookup', input: {} })] }),
      ])
    ).toThrow('assistant role')
  })

  it('rejects assistant images', () => {
    expect(() =>
      formatHistory([
        new Message({
          role: 'assistant',
          content: [new ImageBlock({ format: 'png', source: { bytes: new Uint8Array(2) } })],
        }),
      ])
    ).toThrow('user-provided PNG or JPEG')
  })

  it('rejects non-PCM live audio', () => {
    expect(() => formatInput({ type: 'audioDelta', format: 'wav', source: { bytes: new Uint8Array(2) } })).toThrow(
      'PCM16'
    )
  })
})
