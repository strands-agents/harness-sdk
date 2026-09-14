import { describe, it, expect } from 'vitest'
import { Offload } from '../offload/index.js'
import { getOldestMatches, buildToolNameMap } from '../offload/base.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import type { Agent } from '../../../agent/agent.js'
import type { ContextState } from '../../types.js'

function makeToolResultMessage(text: string, toolUseId = 'tool-123'): Message {
  return new Message({
    role: 'user',
    content: [
      new ToolResultBlock({
        toolUseId,
        status: 'success',
        content: [new TextBlock(text)],
      }),
    ],
  })
}

function heuristicCountTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block instanceof TextBlock) {
        total += Math.ceil(block.text.length / 4)
      } else if (block instanceof ToolResultBlock) {
        for (const content of block.content) {
          if (content instanceof TextBlock) total += Math.ceil(content.text.length / 4)
          else total += Math.ceil(JSON.stringify(content).length / 2)
        }
      } else {
        total += Math.ceil(JSON.stringify(block).length / 2)
      }
    }
  }
  return total
}

function makeContext(messages: Message[], utilization = 0.5, overflow?: boolean): ContextState {
  const agent = createMockAgent({
    messages,
    extra: { model: { countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs) } } as Partial<Agent>,
  })
  return {
    messages,
    agent,
    utilization,
    ...(overflow ? { overflow: true } : {}),
  }
}

describe('Offload.truncate', () => {
  it('creates a strategy with correct name', () => {
    const strategy = Offload.truncate('toolResults')
    expect(strategy.name).toBe('offload:truncate')
  })

  it('creates a strategy with .when() conditions', () => {
    const strategy = Offload.truncate('toolResults', { previewTokens: 500 }).when({ threshold: 1000 })
    expect(strategy.name).toBe('offload:truncate')
  })

  it('truncates large tool results', async () => {
    const largeText = 'x'.repeat(2500 * 4 + 100)
    const messages = [makeToolResultMessage(largeText)]
    const strategy = Offload.truncate('toolResults')
    const context = makeContext(messages)

    const result = await strategy.apply(context)

    expect(result).toBe(true)
    const content = messages[0]!.content[0]
    expect(content).toBeInstanceOf(ToolResultBlock)
    const block = content as ToolResultBlock
    expect(block.content[0]).toBeInstanceOf(TextBlock)
    expect((block.content[0] as TextBlock).text).toContain('[Truncated:')
  })

  it('does not truncate results below threshold', async () => {
    const smallText = 'short result'
    const messages = [makeToolResultMessage(smallText)]
    const strategy = Offload.truncate('toolResults').when({ threshold: 2500 })
    const context = makeContext(messages)

    const result = await strategy.apply(context)

    expect(result).toBe(false)
  })

  it('skips error results when target is toolResults', async () => {
    const largeText = 'x'.repeat(2500 * 4 + 100)
    const message = new Message({
      role: 'user',
      content: [
        new ToolResultBlock({
          toolUseId: 'tool-err',
          status: 'error',
          content: [new TextBlock(largeText)],
        }),
      ],
    })
    const strategy = Offload.truncate('toolResults')
    const context = makeContext([message])

    const result = await strategy.apply(context)

    expect(result).toBe(false)
  })

  it('truncates error results when target is toolResultErrors', async () => {
    const largeText = 'x'.repeat(2500 * 4 + 100)
    const message = new Message({
      role: 'user',
      content: [
        new ToolResultBlock({
          toolUseId: 'tool-err',
          status: 'error',
          content: [new TextBlock(largeText)],
        }),
      ],
    })
    const strategy = Offload.truncate('toolResultErrors')
    const context = makeContext([message])

    const result = await strategy.apply(context)

    expect(result).toBe(true)
  })

  it('skips non-user messages when targeting tool results', async () => {
    const largeText = 'x'.repeat(2500 * 4 + 100)
    const message = new Message({
      role: 'assistant',
      content: [new TextBlock(largeText)],
    })
    const strategy = Offload.truncate('toolResults')
    const context = makeContext([message])

    const result = await strategy.apply(context)

    expect(result).toBe(false)
  })

  it('truncates assistant text blocks with assistantText target', async () => {
    const largeText = 'x'.repeat(2500 * 4 + 100)
    const message = new Message({
      role: 'assistant',
      content: [new TextBlock(largeText)],
    })
    const strategy = Offload.truncate('assistantText')
    const context = makeContext([message])

    const result = await strategy.apply(context)

    expect(result).toBe(true)
    const block = message.content[0] as TextBlock
    expect(block.text).toContain('[Truncated:')
  })

  it('truncates user text blocks with userText target', async () => {
    const largeText = 'x'.repeat(2500 * 4 + 100)
    const message = new Message({
      role: 'user',
      content: [new TextBlock(largeText)],
    })
    const strategy = Offload.truncate('userText')
    const context = makeContext([message])

    const result = await strategy.apply(context)

    expect(result).toBe(true)
    const block = message.content[0] as TextBlock
    expect(block.text).toContain('[Truncated:')
  })

  it('does not truncate user messages with assistantText target', async () => {
    const largeText = 'x'.repeat(2500 * 4 + 100)
    const message = new Message({
      role: 'user',
      content: [new TextBlock(largeText)],
    })
    const strategy = Offload.truncate('assistantText')
    const context = makeContext([message])

    const result = await strategy.apply(context)

    expect(result).toBe(false)
  })

  it('builds head-tail preview', async () => {
    const largeText = 'HEAD'.repeat(1000) + 'MIDDLE'.repeat(5000) + 'TAIL'.repeat(1000)
    const messages = [makeToolResultMessage(largeText)]
    const strategy = Offload.truncate('toolResults', { previewTokens: 100 })
    const context = makeContext(messages)

    await strategy.apply(context)

    const block = messages[0]!.content[0] as ToolResultBlock
    const previewText = (block.content[0] as TextBlock).text
    expect(previewText).toContain('[...')
    expect(previewText).toContain('chars elided')
  })

  it('returns false for empty messages', async () => {
    const strategy = Offload.truncate('toolResults')
    const context = makeContext([])

    const result = await strategy.apply(context)

    expect(result).toBe(false)
  })
})

describe('Offload builder', () => {
  it('Offload.drop() creates a drop strategy', () => {
    const strategy = Offload.drop('toolResults')
    expect(strategy.name).toBe('offload:drop')
    expect(strategy.init).toBeDefined()
    expect(strategy.apply).toBeDefined()
  })

  it('Offload.drop() drops tool result content from context window entirely', async () => {
    const largeText = 'x'.repeat(100)
    const messages = [makeToolResultMessage(largeText)]
    const strategy = Offload.drop('toolResults')
    const context = makeContext(messages)

    const result = await strategy.apply(context)

    expect(result).toBe(true)
    const block = messages[0]!.content[0] as ToolResultBlock
    expect((block.content[0] as TextBlock).text).toBe('[Dropped]')
  })

  it('Offload.drop() drops assistant text blocks', async () => {
    const message = new Message({
      role: 'assistant',
      content: [new TextBlock('some assistant response')],
    })
    const strategy = Offload.drop('assistantText')
    const context = makeContext([message])

    const result = await strategy.apply(context)

    expect(result).toBe(true)
    const block = message.content[0] as TextBlock
    expect(block.text).toBe('[Dropped]')
  })

  it('Offload.drop() drops user text blocks', async () => {
    const message = new Message({
      role: 'user',
      content: [new TextBlock('some user message')],
    })
    const strategy = Offload.drop('userText')
    const context = makeContext([message])

    const result = await strategy.apply(context)

    expect(result).toBe(true)
    const block = message.content[0] as TextBlock
    expect(block.text).toBe('[Dropped]')
  })

  it('Offload.truncate with string[] target matches tool by name from assistant message', async () => {
    const largeText = 'x'.repeat(2500 * 4 + 100)
    const assistantMsg = new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ name: 'bash', toolUseId: 'tool-bash', input: {} })],
    })
    const userMsg = new Message({
      role: 'user',
      content: [
        new ToolResultBlock({
          toolUseId: 'tool-bash',
          status: 'success',
          content: [new TextBlock(largeText)],
        }),
      ],
    })
    const strategy = Offload.truncate(['tool::bash'])
    const context = makeContext([assistantMsg, userMsg])

    const result = await strategy.apply(context)

    expect(result).toBe(true)
    const block = userMsg.content[0] as ToolResultBlock
    expect((block.content[0] as TextBlock).text).toContain('[Truncated:')
  })

  it('Offload.truncate with string[] target skips non-matching tools', async () => {
    const largeText = 'x'.repeat(2500 * 4 + 100)
    const assistantMsg = new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ name: 'read_file', toolUseId: 'tool-read', input: {} })],
    })
    const userMsg = new Message({
      role: 'user',
      content: [
        new ToolResultBlock({
          toolUseId: 'tool-read',
          status: 'success',
          content: [new TextBlock(largeText)],
        }),
      ],
    })
    const strategy = Offload.truncate(['tool::bash'])
    const context = makeContext([assistantMsg, userMsg])

    const result = await strategy.apply(context)

    expect(result).toBe(false)
  })

  it('Offload.summarize() creates a summarize strategy', () => {
    const strategy = Offload.summarize('toolResults')
    expect(strategy.name).toBe('offload:summarize')
    expect(strategy.apply).toBeDefined()
  })

  it('Offload.summarize().when() creates a strategy with conditions', () => {
    const strategy = Offload.summarize('toolResults').when({ utilization: 0.85 })
    expect(strategy.name).toBe('offload:summarize')
  })

  it('Offload.summarize(config) config-only creates untargeted strategy', () => {
    const strategy = Offload.summarize('*', { systemPrompt: 'summarize briefly' }).when({ utilization: 0.85 })
    expect(strategy.name).toBe('offload:summarize')
  })

  it('Offload.truncate(config) config-only creates untargeted strategy', () => {
    const strategy = Offload.truncate('*', { previewTokens: 200 }).when({ threshold: 1000 })
    expect(strategy.name).toBe('offload:truncate')
  })

  it('throws on empty array target', () => {
    expect(() => Offload.truncate([])).toThrow('Empty array target')
    expect(() => Offload.drop([])).toThrow('Empty array target')
    expect(() => Offload.summarize([])).toThrow('Empty array target')
  })
})

describe('Offload message-level with role alternation', () => {
  it('drop("assistantText") repairs alternation after removing assistant messages', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('q1')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a1')] }),
      new Message({ role: 'user', content: [new TextBlock('q2')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a2')] }),
      new Message({ role: 'user', content: [new TextBlock('q3')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a3')] }),
      new Message({ role: 'user', content: [new TextBlock('q4')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a4')] }),
    ]
    const strategy = Offload.drop('assistantText').when({ utilization: 0.5 })
    const context = makeContext(messages, 0.9)

    await strategy.apply(context)

    for (let index = 0; index < messages.length - 1; index++) {
      expect(messages[index]!.role).not.toBe(messages[index + 1]!.role)
    }
  })

  it('drop("userText") repairs alternation after removing user messages', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('q1')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a1')] }),
      new Message({ role: 'user', content: [new TextBlock('q2')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a2')] }),
      new Message({ role: 'user', content: [new TextBlock('q3')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a3')] }),
      new Message({ role: 'user', content: [new TextBlock('q4')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a4')] }),
    ]
    const strategy = Offload.drop('userText').when({ utilization: 0.5 })
    const context = makeContext(messages, 0.9)

    await strategy.apply(context)

    for (let index = 0; index < messages.length - 1; index++) {
      expect(messages[index]!.role).not.toBe(messages[index + 1]!.role)
    }
  })

  it('drop("*") message-level repairs alternation', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('q1')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a1')] }),
      new Message({ role: 'user', content: [new TextBlock('q2')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a2')] }),
      new Message({ role: 'user', content: [new TextBlock('q3')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a3')] }),
      new Message({ role: 'user', content: [new TextBlock('q4')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a4')] }),
    ]
    const strategy = Offload.drop('*').when({ utilization: 0.5 })
    const context = makeContext(messages, 0.9)

    await strategy.apply(context)

    for (let index = 0; index < messages.length - 1; index++) {
      expect(messages[index]!.role).not.toBe(messages[index + 1]!.role)
    }
  })

  it('drop("assistantText") message-level with tool pairs preserves tool pair integrity', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('q1')] }),
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 'bash', toolUseId: 'tu-1', input: {} })],
      }),
      new Message({
        role: 'user',
        content: [new ToolResultBlock({ toolUseId: 'tu-1', status: 'success', content: [new TextBlock('result')] })],
      }),
      new Message({ role: 'assistant', content: [new TextBlock('a2')] }),
      new Message({ role: 'user', content: [new TextBlock('q3')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a3')] }),
      new Message({ role: 'user', content: [new TextBlock('q4')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a4')] }),
    ]
    const strategy = Offload.drop('assistantText').when({ utilization: 0.5 })
    const context = makeContext(messages, 0.9)

    await strategy.apply(context)

    for (let index = 0; index < messages.length - 1; index++) {
      expect(messages[index]!.role).not.toBe(messages[index + 1]!.role)
    }

    // Verify no orphaned tool results: every toolResult must have its toolUse present
    const toolUseIds = new Set<string>()
    const toolResultIds = new Set<string>()
    for (const message of messages) {
      for (const block of message.content) {
        if (block instanceof ToolUseBlock) toolUseIds.add(block.toolUseId)
        if (block instanceof ToolResultBlock) toolResultIds.add(block.toolUseId)
      }
    }
    for (const resultId of toolResultIds) {
      expect(toolUseIds.has(resultId)).toBe(true)
    }
  })

  it('drop("userText") is not a no-op when messages[0] is the only front candidate', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('q1')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a1')] }),
      new Message({ role: 'user', content: [new TextBlock('q2')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a2')] }),
    ]
    const strategy = Offload.drop('userText').when({ utilization: 0.5 })
    const context = makeContext(messages, 0.9)

    const result = await strategy.apply(context)

    expect(result).toBe(true)
    // Marker message replaces removed content, so length stays same or +1 (marker - removed + marker)
    expect(messages.length).toBeLessThanOrEqual(4)
  })

  it('message-level starts with user message after operation', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('q1')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a1')] }),
      new Message({ role: 'user', content: [new TextBlock('q2')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a2')] }),
      new Message({ role: 'user', content: [new TextBlock('q3')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a3')] }),
    ]
    const strategy = Offload.drop('assistantText').when({ utilization: 0.5 })
    const context = makeContext(messages, 0.9)

    await strategy.apply(context)

    expect(messages[0]!.role).toBe('user')
  })
})

describe('Offload with * target (fires on everything)', () => {
  it('Offload.drop("*") drops all content', async () => {
    const assistantMsg = new Message({
      role: 'assistant',
      content: [new TextBlock('assistant text')],
    })
    const userMsg = new Message({
      role: 'user',
      content: [
        new TextBlock('user text'),
        new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success',
          content: [new TextBlock('tool output')],
        }),
      ],
    })
    const strategy = Offload.drop('*')
    const context = makeContext([assistantMsg, userMsg])

    const result = await strategy.apply(context)

    expect(result).toBe(true)
    expect((assistantMsg.content[0] as TextBlock).text).toBe('[Dropped]')
    expect((userMsg.content[0] as TextBlock).text).toBe('[Dropped]')
    const toolBlock = userMsg.content[1] as ToolResultBlock
    expect((toolBlock.content[0] as TextBlock).text).toBe('[Dropped]')
  })

  it('Offload.truncate("*") truncates all large content', async () => {
    const largeText = 'x'.repeat(2500 * 4 + 100)
    const assistantMsg = new Message({
      role: 'assistant',
      content: [new TextBlock(largeText)],
    })
    const userMsg = new Message({
      role: 'user',
      content: [
        new TextBlock(largeText),
        new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success',
          content: [new TextBlock(largeText)],
        }),
      ],
    })
    const strategy = Offload.truncate('*')
    const context = makeContext([assistantMsg, userMsg])

    const result = await strategy.apply(context)

    expect(result).toBe(true)
    expect((assistantMsg.content[0] as TextBlock).text).toContain('[Truncated:')
    expect((userMsg.content[0] as TextBlock).text).toContain('[Truncated:')
    const toolBlock = userMsg.content[1] as ToolResultBlock
    expect((toolBlock.content[0] as TextBlock).text).toContain('[Truncated:')
  })

  it('Offload.truncate("*") with threshold skips small content', async () => {
    const smallText = 'short'
    const assistantMsg = new Message({
      role: 'assistant',
      content: [new TextBlock(smallText)],
    })
    const strategy = Offload.truncate('*').when({ threshold: 2500 })
    const context = makeContext([assistantMsg])

    const result = await strategy.apply(context)

    expect(result).toBe(false)
  })
})

describe('Message-level drop vs truncate markers', () => {
  it('drop leaves [Dropped: N messages] marker', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('q1')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a1')] }),
      new Message({ role: 'user', content: [new TextBlock('q2')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a2')] }),
      new Message({ role: 'user', content: [new TextBlock('q3')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a3')] }),
      new Message({ role: 'user', content: [new TextBlock('q4')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a4')] }),
    ]
    const strategy = Offload.drop('*').when({ utilization: 0.5 })
    const context = makeContext(messages, 0.9)

    await strategy.apply(context)

    const allText = messages.flatMap((m) =>
      m.content.filter((b) => b instanceof TextBlock).map((b) => (b as TextBlock).text)
    )
    const markerText = allText.find((t) => t.includes('[Dropped:'))
    expect(markerText).toBeDefined()
    expect(markerText).toMatch(/\[Dropped: \d+ messages?\]/)
  })

  it('truncate leaves [... N messages elided ...] marker', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('q1')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a1')] }),
      new Message({ role: 'user', content: [new TextBlock('q2')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a2')] }),
      new Message({ role: 'user', content: [new TextBlock('q3')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a3')] }),
      new Message({ role: 'user', content: [new TextBlock('q4')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a4')] }),
    ]
    const strategy = Offload.truncate('*').when({ utilization: 0.5 })
    const context = makeContext(messages, 0.9)

    await strategy.apply(context)

    const allText = messages.flatMap((m) =>
      m.content.filter((b) => b instanceof TextBlock).map((b) => (b as TextBlock).text)
    )
    const markerText = allText.find((t) => t.includes('elided'))
    expect(markerText).toBeDefined()
    expect(markerText).toMatch(/\[\.\.\. \d+ messages? elided \.\.\.\]/)
  })
})

describe('pinned message protection', () => {
  it('message-level drop skips pinned messages', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('q1')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a1')] }),
      new Message({
        role: 'user',
        content: [new TextBlock('pinned-msg')],
        metadata: { custom: { pinned: true } },
      }),
      new Message({ role: 'assistant', content: [new TextBlock('a2')] }),
      new Message({ role: 'user', content: [new TextBlock('q3')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a3')] }),
    ]
    const strategy = Offload.drop('*').when({ utilization: 0.5 })
    const context = makeContext(messages, 0.9)

    await strategy.apply(context)

    const allText = messages.flatMap((message) =>
      message.content.filter((block) => block instanceof TextBlock).map((block) => (block as TextBlock).text)
    )
    expect(allText).toContain('pinned-msg')
  })

  it('message-level drop skips tool-pair partner of pinned message', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('q1')] }),
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ toolUseId: 'tu-1', name: 'test', input: {} })],
        metadata: { custom: { pinned: true } },
      }),
      new Message({
        role: 'user',
        content: [new ToolResultBlock({ toolUseId: 'tu-1', status: 'success', content: [new TextBlock('result')] })],
      }),
      new Message({ role: 'assistant', content: [new TextBlock('a2')] }),
      new Message({ role: 'user', content: [new TextBlock('q3')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a3')] }),
    ]
    const strategy = Offload.drop('*').when({ utilization: 0.5 })
    const context = makeContext(messages, 0.9)

    await strategy.apply(context)

    const hasToolResult = messages.some((message) =>
      message.content.some((block) => block instanceof ToolResultBlock && block.toolUseId === 'tu-1')
    )
    expect(hasToolResult).toBe(true)
  })

  it('pinned message survives repairAlternation merge across two passes', async () => {
    // After pass 1 drops eligible messages, pinned-a3 becomes adjacent to a7 —
    // repairAlternation must merge them and preserve the pinned metadata.
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('q1')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a1')] }),
      new Message({ role: 'user', content: [new TextBlock('q2')] }),
      new Message({
        role: 'assistant',
        content: [new TextBlock('pinned-a3')],
        metadata: { custom: { pinned: true } },
      }),
      new Message({ role: 'user', content: [new TextBlock('q4')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a5')] }),
      new Message({ role: 'user', content: [new TextBlock('q6')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a7')] }),
      new Message({ role: 'user', content: [new TextBlock('q8')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a9')] }),
      new Message({ role: 'user', content: [new TextBlock('q10')] }),
    ]
    const strategy = Offload.drop('*').when({ utilization: 0.5, preserveRecent: 4 })
    const context = makeContext(messages, 0.9)

    await strategy.apply(context)
    await strategy.apply(context)

    const allText = messages.flatMap((message) =>
      message.content.filter((block) => block instanceof TextBlock).map((block) => (block as TextBlock).text)
    )
    expect(allText.some((text) => text.includes('pinned-a3'))).toBe(true)
    const merged = messages.find((message) =>
      message.content.some((block) => block instanceof TextBlock && (block as TextBlock).text === 'pinned-a3')
    )
    expect(merged?.metadata?.custom?.pinned).toBe(true)
  })
})

describe('overflow bypass', () => {
  it('message-level strategy fires on low utilization when overflow is set', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('q1')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a1')] }),
      new Message({ role: 'user', content: [new TextBlock('q2')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a2')] }),
    ]
    const strategy = Offload.drop('*').when({ utilization: 0.85 })
    const context = makeContext(messages, 0.5, true)

    const acted = await strategy.apply(context)
    expect(acted).toBe(true)
    expect(messages.length).toBeLessThan(4)
  })

  it('message-level strategy skips on low utilization without overflow', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('q1')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a1')] }),
      new Message({ role: 'user', content: [new TextBlock('q2')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a2')] }),
    ]
    const strategy = Offload.drop('*').when({ utilization: 0.85 })
    const context = makeContext(messages, 0.5)

    const acted = await strategy.apply(context)
    expect(acted).toBe(false)
    expect(messages.length).toBe(4)
  })
})

describe('getOldestMatches with ratio preserveRecent', () => {
  function makeMessages(count: number): Message[] {
    return Array.from(
      { length: count },
      (_, index) =>
        new Message({ role: index % 2 === 0 ? 'user' : 'assistant', content: [new TextBlock(`msg-${index}`)] })
    )
  }

  it('integer preserveRecent keeps absolute count', () => {
    const messages = makeMessages(10)
    const toolNameMap = buildToolNameMap(messages)
    const result = getOldestMatches(messages, '*', 3, toolNameMap, undefined, undefined)
    expect(result).toHaveLength(7)
  })

  it('decimal preserveRecent keeps ratio of matches', () => {
    const messages = makeMessages(10)
    const toolNameMap = buildToolNameMap(messages)
    // 0.7 = keep 70% of 10 = ceil(7) = 7 preserved, 3 returned
    const result = getOldestMatches(messages, '*', 0.7, toolNameMap, undefined, undefined)
    expect(result).toHaveLength(3)
  })

  it('decimal preserveRecent rounds up', () => {
    const messages = makeMessages(3)
    const toolNameMap = buildToolNameMap(messages)
    // 0.5 of 3 = ceil(1.5) = 2 preserved, 1 returned
    const result = getOldestMatches(messages, '*', 0.5, toolNameMap, undefined, undefined)
    expect(result).toHaveLength(1)
  })

  it('decimal preserveRecent of 0.99 preserves almost all', () => {
    const messages = makeMessages(10)
    const toolNameMap = buildToolNameMap(messages)
    // 0.99 of 10 = ceil(9.9) = 10 preserved, 0 returned
    const result = getOldestMatches(messages, '*', 0.99, toolNameMap, undefined, undefined)
    expect(result).toHaveLength(0)
  })
})
