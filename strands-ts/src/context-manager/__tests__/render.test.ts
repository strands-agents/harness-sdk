import { describe, expect, it } from 'vitest'
import { renderHistory } from '../render.js'
import { Message, TextBlock, ToolUseBlock } from '../../types/messages.js'
import type { MessageData, Role } from '../../types/messages.js'
import { planCut } from '../summarizers/cut.js'

const text = (role: Role, value: string): Message => new Message({ role, content: [new TextBlock(value)] })
const baseSummary = (): Message =>
  new Message({
    role: 'assistant',
    content: [
      new TextBlock('S', { metadata: { offloaded: { method: 'summarize', removedMessages: 4, removedTokens: 1234 } } }),
    ],
  })
const nativeSummary = (): Message =>
  new Message({
    role: 'assistant',
    content: [
      new TextBlock('N', {
        metadata: { offloaded: { method: 'summarize', removedMessages: 5 } },
        providerData: { provider: 'anthropic', data: { type: 'compaction', signature: 'sig' } },
      }),
    ],
  })

const wire = (messages: Message[]): unknown[] =>
  messages.map((message) => ({ role: message.role, content: message.content.map((block) => block.toJSON()) }))

describe('renderHistory', () => {
  it('sends a client-side summary with the [Summarized] header and without metadata', () => {
    const rendered = renderHistory([text('user', 'task'), baseSummary(), text('user', 'next')])
    expect(wire(rendered)).toStrictEqual([
      { role: 'user', content: [{ text: 'task' }] },
      { role: 'assistant', content: [{ text: '[Summarized: 4 messages, ~1,234 tokens]\n\nS' }] },
      { role: 'user', content: [{ text: 'next' }] },
    ])
  })

  it('sends a native summary as stored, with no header', () => {
    const native = nativeSummary()
    const rendered = renderHistory([native, text('user', 'next')])
    expect(rendered[0]!.content[0]).toBe(native.content[0])
  })

  it('sends a summary after the content of a following message of the same role', () => {
    const kept = new Message({
      role: 'assistant',
      content: [new TextBlock('kept'), new ToolUseBlock({ name: 't', toolUseId: '1', input: {} })],
    })
    const rendered = renderHistory([text('user', 'task'), baseSummary(), kept, text('user', 'u')])
    expect(rendered).toHaveLength(3)
    expect(rendered[1]!.trackingId).toBe(kept.trackingId)
    expect(wire(rendered)[1]).toStrictEqual({
      role: 'assistant',
      content: [
        { text: 'kept' },
        { toolUse: { name: 't', toolUseId: '1', input: {} } },
        { text: '[Summarized: 4 messages, ~1,234 tokens]\n\nS' },
      ],
    })
  })

  it('keeps a native summary in its own message, ahead of the kept turn', () => {
    const native = nativeSummary()
    const kept = new Message({
      role: 'assistant',
      content: [new TextBlock('kept'), new ToolUseBlock({ name: 't', toolUseId: '1', input: {} })],
    })
    const rendered = renderHistory([native, kept, text('user', 'u')])
    expect(rendered).toHaveLength(3)
    expect(rendered[0]).toBe(native)
    expect(rendered[1]).toBe(kept)
  })

  it('leaves adjacent same-role messages without a summary as they are', () => {
    const messages = [text('user', 'a'), text('user', 'b'), text('assistant', 'c'), text('assistant', 'd')]
    const rendered = renderHistory(messages)
    expect(rendered).toStrictEqual(messages)
    rendered.forEach((message, index) => expect(message).toBe(messages[index]))
  })

  it('never modifies the stored messages or blocks', () => {
    const messages = [
      text('user', 'task'),
      baseSummary(),
      text('assistant', 'kept'),
      nativeSummary(),
      text('user', 'u'),
    ]
    const before = JSON.stringify(messages)
    const contents = messages.map((message) => [...message.content])
    renderHistory(messages)
    expect(JSON.stringify(messages)).toBe(before)
    messages.forEach((message, index) => expect(message.content).toStrictEqual(contents[index]))
  })

  // A session saved before summaries carried metadata stored the header in the text, appended to an assistant turn.
  describe('saved sessions with a [Summarized] header in the text', () => {
    const saved: MessageData[] = [
      { role: 'user', content: [{ text: 'TASK' }] },
      {
        role: 'assistant',
        content: [{ text: 'A3' }, { text: '[Summarized: 2 messages, ~60 tokens]\n\nSUMMARY OF EARLIER TURNS' }],
      },
      { role: 'user', content: [{ text: 'next' }] },
      { role: 'assistant', content: [{ text: 'a' }] },
      { role: 'user', content: [{ text: 'u' }] },
    ]

    it('loads and renders the history exactly as saved, without a second header', () => {
      const messages = saved.map((data) => Message.fromMessageData(data))
      expect(wire(renderHistory(messages))).toStrictEqual(saved)
    })

    it('summarizes the old summary again as an ordinary message', () => {
      const messages = saved.map((data) => Message.fromMessageData(data))
      expect(planCut(messages, 1, 2)!.body).toStrictEqual(messages.slice(1, 3))
    })
  })
})
