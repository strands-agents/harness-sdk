import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Offload } from '../offload/index.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import type { Agent } from '../../../agent/agent.js'
import type { ContextState } from '../../types.js'
import { isPinned, pinMessage } from '../../../conversation-manager/compression/pin-message.js'

const summarizeContent = vi.hoisted(() => vi.fn())

vi.mock('../../methods/summarize.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, summarizeContent }
})

const SUMMARY_TEXT = 'condensed summary'

function countTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block instanceof TextBlock) total += Math.ceil(block.text.length / 4)
    }
  }
  return total
}

function textOf(message: Message): string {
  return message.content.map((block) => (block instanceof TextBlock ? block.text : '')).join('\n')
}

function summaryBlocks(message: Message): TextBlock[] {
  return message.content.filter(
    (block): block is TextBlock => block instanceof TextBlock && block.text.startsWith('[Summarized:')
  )
}

function toolPair(id: string): Message[] {
  return [
    new Message({ role: 'assistant', content: [new ToolUseBlock({ name: 'read', toolUseId: id, input: {} })] }),
    new Message({
      role: 'user',
      content: [new ToolResultBlock({ toolUseId: id, status: 'success', content: [new TextBlock(`result ${id}`)] })],
    }),
  ]
}

function makeContext(messages: Message[]): ContextState {
  const model = { stream: vi.fn(), countTokens: async (msgs: Message[]) => countTokens(msgs) }
  const agent = createMockAgent({ messages, extra: { model } as unknown as Partial<Agent> })
  return { messages, agent, utilization: 0.95 }
}

describe('Offload.summarize accumulation in message 0', () => {
  beforeEach(() => {
    summarizeContent.mockReset()
    summarizeContent.mockResolvedValue(SUMMARY_TEXT)
  })

  it('keeps a single summary block in message 0 across many cycles', async () => {
    const messages = [new Message({ role: 'user', content: [new TextBlock('original question')] })]
    const strategy = Offload.summarize('*').when({ utilization: 0.8, preserveRecent: 2 })

    for (let i = 0; i < 40; i++) {
      messages.push(...toolPair(`t${i}`))
      await strategy.apply(makeContext(messages))
    }

    const head = messages[0]!
    expect(head.content[0]).toBeInstanceOf(TextBlock)
    expect((head.content[0] as TextBlock).text).toBe('original question')
    expect(summaryBlocks(head)).toHaveLength(1)
    expect(textOf(head).length).toBeLessThan(400)
  })

  it('feeds the prior summary into the same summarization pass', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('original question')] }),
      ...toolPair('a'),
      ...toolPair('b'),
    ]
    const strategy = Offload.summarize('*').when({ utilization: 0.8, preserveRecent: 2 })
    await strategy.apply(makeContext(messages))
    messages.push(...toolPair('c'))
    summarizeContent.mockClear()
    await strategy.apply(makeContext(messages))

    expect(summarizeContent).toHaveBeenCalledTimes(1)
    const input = summarizeContent.mock.calls[0]![0] as TextBlock[]
    const joined = input.map((block) => (block instanceof TextBlock ? block.text : '')).join('\n')
    expect(joined).toContain(SUMMARY_TEXT)
    expect(joined).toContain('result b')
    expect(joined).not.toContain('original question')
  })

  it('leaves message 0 untouched when summarization fails', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('original question')] }),
      ...toolPair('a'),
      ...toolPair('b'),
    ]
    const strategy = Offload.summarize('*').when({ utilization: 0.8, preserveRecent: 2 })
    await strategy.apply(makeContext(messages))
    messages.push(...toolPair('c'))
    const before = messages.map((message) => message.content.slice())
    const head = messages[0]
    summarizeContent.mockResolvedValue(null)

    expect(await strategy.apply(makeContext(messages))).toBe(false)

    expect(messages[0]).toBe(head)
    expect(messages.map((message) => message.content)).toEqual(before)
  })

  it('does not fold summaries out of a pinned message 0', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('original question')] }),
      ...toolPair('a'),
      ...toolPair('b'),
    ]
    pinMessage(messages, 0)
    const strategy = Offload.summarize('*').when({ utilization: 0.8, preserveRecent: 2 })
    await strategy.apply(makeContext(messages))
    messages.push(...toolPair('c'))
    await strategy.apply(makeContext(messages))

    expect(isPinned(messages, 0)).toBe(true)
    expect(summaryBlocks(messages[0]!).length).toBeGreaterThan(1)
  })

  it('keeps role alternation and tool pairs intact', async () => {
    const messages = [new Message({ role: 'user', content: [new TextBlock('original question')] })]
    const strategy = Offload.summarize('*').when({ utilization: 0.8, preserveRecent: 2 })

    for (let i = 0; i < 15; i++) {
      messages.push(...toolPair(`t${i}`))
      await strategy.apply(makeContext(messages))
      messages.forEach((message, index) => {
        if (index > 0) expect(message.role).not.toBe(messages[index - 1]!.role)
      })
      const uses = new Set(
        messages.flatMap((m) =>
          m.content.filter((b) => b instanceof ToolUseBlock).map((b) => (b as ToolUseBlock).toolUseId)
        )
      )
      const results = new Set(
        messages.flatMap((m) =>
          m.content.filter((b) => b instanceof ToolResultBlock).map((b) => (b as ToolResultBlock).toolUseId)
        )
      )
      expect(results).toEqual(uses)
    }
  })
})
