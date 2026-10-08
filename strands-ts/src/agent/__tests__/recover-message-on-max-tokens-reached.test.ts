import { describe, expect, it } from 'vitest'
import { recoverMessageOnMaxTokensReached } from '../recover-message-on-max-tokens-reached.js'
import { Message, ReasoningBlock, TextBlock, ToolUseBlock } from '../../types/messages.js'
import { ImageBlock } from '../../types/media.js'

describe('recoverMessageOnMaxTokensReached', () => {
  it('replaces every tool use with explanatory text and preserves other blocks in order', () => {
    const image = new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } })
    const reasoning = new ReasoningBlock({ text: 'thinking' })
    const message = new Message({
      role: 'assistant',
      content: [
        new TextBlock('Before'),
        new ToolUseBlock({ name: 'calculator', toolUseId: 'a', input: { expression: '2+2' } }),
        image,
        new ToolUseBlock({ name: 'story_tool', toolUseId: 'b', input: '{"story": "Once upon' }),
        reasoning,
      ],
    })

    const recovered = recoverMessageOnMaxTokensReached(message)

    expect(recovered.content).toStrictEqual([
      new TextBlock('Before'),
      new TextBlock(
        "The selected tool calculator's tool use was incomplete due to maximum token limits being reached."
      ),
      image,
      new TextBlock(
        "The selected tool story_tool's tool use was incomplete due to maximum token limits being reached."
      ),
      reasoning,
    ])
  })

  it('uses <unknown> for a tool use without a name', () => {
    const message = new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ name: '', toolUseId: 'a', input: {} })],
    })

    expect(recoverMessageOnMaxTokensReached(message).content).toStrictEqual([
      new TextBlock("The selected tool <unknown>'s tool use was incomplete due to maximum token limits being reached."),
    ])
  })

  it('preserves role, tracking id, and metadata without mutating the input', () => {
    const toolUse = new ToolUseBlock({ name: 'calculator', toolUseId: 'a', input: {} })
    const metadata = { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }
    const message = new Message({ role: 'assistant', content: [toolUse], trackingId: 'track-1', metadata })

    const recovered = recoverMessageOnMaxTokensReached(message)

    expect(recovered).not.toBe(message)
    expect(recovered.role).toBe('assistant')
    expect(recovered.trackingId).toBe('track-1')
    expect(recovered.metadata).toStrictEqual(metadata)
    expect(message.content).toStrictEqual([toolUse])
  })

  it('returns equivalent content when there are no tool uses', () => {
    const message = new Message({ role: 'assistant', content: [new TextBlock('Partial')] })

    expect(recoverMessageOnMaxTokensReached(message).content).toStrictEqual([new TextBlock('Partial')])
    expect(recoverMessageOnMaxTokensReached(new Message({ role: 'assistant', content: [] })).content).toStrictEqual([])
  })
})
