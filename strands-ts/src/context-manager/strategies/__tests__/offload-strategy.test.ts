import { describe, it, expect, vi } from 'vitest'
import { Offload } from '../offload/index.js'
import {
  getOldestMatches,
  buildToolNameMap,
  collectRemovableWithPair,
  insertMarker,
  parseCondition,
  EmergencyTruncateStrategy,
} from '../offload/base.js'
import type { OffloadConditions, OffloadTarget, Percent } from '../offload/base.js'
import { TRUNCATED_PREFIX } from '../../methods/truncate.js'
import type { TruncateConfig } from '../../methods/truncate.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import type { Role } from '../../../types/messages.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import type { Agent } from '../../../agent/agent.js'
import type { ContextState } from '../../types.js'
import { withDefaultLocale } from '../../../__fixtures__/locale-helpers.js'

vi.mock('../../methods/summarize.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, summarizeContent: vi.fn(async () => 'summary') }
})

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

function makeContext(
  messages: Message[],
  utilization = 0.5,
  overflow?: boolean,
  contextWindowLimit?: number
): ContextState {
  const model = {
    countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs),
    getConfig: () => (contextWindowLimit === undefined ? {} : { contextWindowLimit }),
  }
  const agent = createMockAgent({ messages, extra: { model } as unknown as Partial<Agent> })
  return {
    messages,
    agent,
    utilization,
    ...(overflow ? { overflow: true } : {}),
  }
}

describe('Offload.truncate', () => {
  it('creates a strategy with correct name', () => {
    const strategy = Offload.truncate('toolResults').when({})
    expect(strategy.name).toBe('offload:truncate')
  })

  it('creates a strategy with .when() conditions', () => {
    const strategy = Offload.truncate('toolResults', { previewTokens: 500 }).when({ threshold: 1000 })
    expect(strategy.name).toBe('offload:truncate')
  })

  it('rejects a token threshold at or below previewTokens', () => {
    expect(() => Offload.truncate('toolResults', { previewTokens: 500 }).when({ threshold: 500 })).toThrow(
      'threshold (500) must be greater than previewTokens (500) to ensure truncation converges'
    )
  })

  it('accepts a percent threshold regardless of previewTokens', () => {
    expect(() => Offload.truncate('toolResults', { previewTokens: 500 }).when({ threshold: '0.1%' })).not.toThrow()
  })

  it('truncates large tool results', async () => {
    const largeText = 'x'.repeat(2500 * 4 + 100)
    const messages = [makeToolResultMessage(largeText)]
    const strategy = Offload.truncate('toolResults').when({})
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
    const strategy = Offload.truncate('toolResults').when({})
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
    const strategy = Offload.truncate('toolResultErrors').when({})
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
    const strategy = Offload.truncate('toolResults').when({})
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
    const strategy = Offload.truncate('assistantText').when({})
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
    const strategy = Offload.truncate('userText').when({})
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
    const strategy = Offload.truncate('assistantText').when({})
    const context = makeContext([message])

    const result = await strategy.apply(context)

    expect(result).toBe(false)
  })

  it('builds head-tail preview', async () => {
    const largeText = 'HEAD'.repeat(1000) + 'MIDDLE'.repeat(5000) + 'TAIL'.repeat(1000)
    const messages = [makeToolResultMessage(largeText)]
    const strategy = Offload.truncate('toolResults', { previewTokens: 100 }).when({})
    const context = makeContext(messages)

    await strategy.apply(context)

    const block = messages[0]!.content[0] as ToolResultBlock
    const previewText = (block.content[0] as TextBlock).text
    expect(previewText).toContain('[...')
    expect(previewText).toContain('chars elided')
  })

  // https://github.com/strands-agents/harness-sdk/issues/4681
  it('formats preview counts the same regardless of the host locale', async () => {
    const messages = [makeToolResultMessage('x'.repeat(1_000_000))]
    const strategy = Offload.truncate('toolResults', { previewTokens: 100 }).when({})
    const context = makeContext(messages)

    await withDefaultLocale('en-IN', () => strategy.apply(context))

    const block = messages[0]!.content[0] as ToolResultBlock
    const previewText = (block.content[0] as TextBlock).text
    expect(previewText).toContain('~250,000 tokens]')
    expect(previewText).toContain('[... 999,600 chars elided ...]')
  })

  it('returns false for empty messages', async () => {
    const strategy = Offload.truncate('toolResults').when({})
    const context = makeContext([])

    const result = await strategy.apply(context)

    expect(result).toBe(false)
  })
})

describe('Offload builder', () => {
  it('Offload.drop().when() creates a drop strategy', () => {
    const strategy = Offload.drop('toolResults').when({})
    expect(strategy.name).toBe('offload:drop')
    expect(strategy.init).toBeDefined()
    expect(strategy.apply).toBeDefined()
  })

  it('Offload.drop() drops tool result content from context window entirely', async () => {
    const largeText = 'x'.repeat(100)
    const messages = [makeToolResultMessage(largeText)]
    const strategy = Offload.drop('toolResults').when({})
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
    const strategy = Offload.drop('assistantText').when({})
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
    const strategy = Offload.drop('userText').when({})
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
    const strategy = Offload.truncate(['tool::bash']).when({})
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
    const strategy = Offload.truncate(['tool::bash']).when({})
    const context = makeContext([assistantMsg, userMsg])

    const result = await strategy.apply(context)

    expect(result).toBe(false)
  })

  it('Offload.summarize().when() creates a summarize strategy', () => {
    const strategy = Offload.summarize('toolResults').when({})
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

  it.each([
    ['drop', Offload.drop('toolResults')],
    ['truncate', Offload.truncate('toolResults')],
    ['summarize', Offload.summarize('toolResults')],
  ])('Offload.%s() returns a builder that is not a strategy', (_, builder) => {
    expect(builder).not.toHaveProperty('name')
    expect(builder).not.toHaveProperty('apply')
    expect(builder.when).toBeTypeOf('function')
  })

  it('throws on empty array target', () => {
    expect(() => Offload.truncate([])).toThrow('Empty array target')
    expect(() => Offload.drop([])).toThrow('Empty array target')
    expect(() => Offload.summarize([])).toThrow('Empty array target')
  })
})

function conversation(turns: number): Message[] {
  return Array.from({ length: turns }, (_, index) => [
    new Message({ role: 'user', content: [new TextBlock(`q${index + 1}`)] }),
    new Message({ role: 'assistant', content: [new TextBlock(`a${index + 1}`)] }),
  ]).flat()
}

function textsOf(messages: Message[]): string[][] {
  return messages.map((message) => message.content.map((block) => (block as TextBlock).text))
}

describe('Offload message-level with role alternation', () => {
  it.each([
    ['assistantText', 'assistant'],
    ['userText', 'user'],
  ] as const)(
    'drop("%s") with utilization replaces each %s text block but the newest, keeping every message',
    async (target, role) => {
      const messages = conversation(4)
      const strategy = Offload.drop(target).when({ utilization: 0.5 })

      expect(await strategy.apply(makeContext(messages, 0.9))).toBe(true)

      expect(messages).toHaveLength(8)
      for (const [index, message] of messages.entries()) {
        const dropped = message.role === role && index < messages.length - 1
        const expected = dropped ? '[Dropped]' : expect.not.stringContaining('[Dropped]')
        expect((message.content[0] as TextBlock).text).toEqual(expected)
      }
    }
  )

  it('drop("*") message-level repairs alternation', async () => {
    const messages = conversation(4)
    const strategy = Offload.drop('*').when({ utilization: 0.5 })
    const context = makeContext(messages, 0.9)

    await strategy.apply(context)

    for (let index = 0; index < messages.length - 1; index++) {
      expect(messages[index]!.role).not.toBe(messages[index + 1]!.role)
    }
  })

  it('drop("*") message-level with tool pairs preserves tool pair integrity', async () => {
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
    const strategy = Offload.drop('*').when({ utilization: 0.5, preserveRecent: 4 })
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

  it('drop("*") acts when only message 0 precedes the candidates', async () => {
    const messages = conversation(2)
    const strategy = Offload.drop('*').when({ utilization: 0.5 })
    const context = makeContext(messages, 0.9)

    const result = await strategy.apply(context)

    expect(result).toBe(true)
    expect(textsOf(messages)).toEqual([['q1'], ['a2', '[Dropped: 2 messages]']])
  })

  it('message-level starts with user message after operation', async () => {
    const messages = conversation(3)
    const strategy = Offload.drop('*').when({ utilization: 0.5 })
    const context = makeContext(messages, 0.9)

    await strategy.apply(context)

    expect(messages[0]!.role).toBe('user')
  })
})

describe('Offload with * target and threshold (acts on every block)', () => {
  it('Offload.drop("*") with threshold 0 drops all content', async () => {
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
    const strategy = Offload.drop('*').when({ threshold: 0 })
    const context = makeContext([assistantMsg, userMsg])

    const result = await strategy.apply(context)

    expect(result).toBe(true)
    expect((assistantMsg.content[0] as TextBlock).text).toBe('[Dropped]')
    expect((userMsg.content[0] as TextBlock).text).toBe('[Dropped]')
    const toolBlock = userMsg.content[1] as ToolResultBlock
    expect((toolBlock.content[0] as TextBlock).text).toBe('[Dropped]')
  })

  it('Offload.truncate("*") with threshold truncates all large content', async () => {
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
    const strategy = Offload.truncate('*').when({ threshold: 2500 })
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
    const strategy = Offload.truncate('*', { previewTokens: 2 }).when({ utilization: 0.5 })
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

function text(role: Role, value: string): Message {
  return new Message({ role, content: [new TextBlock(value)] })
}

describe('collectRemovableWithPair', () => {
  function toolPair(toolUseId: string): Message[] {
    return [
      new Message({ role: 'assistant', content: [new ToolUseBlock({ toolUseId, name: 'read', input: {} })] }),
      makeToolResultMessage('x', toolUseId),
    ]
  }

  it('collects a tool use with its following tool result', () => {
    const messages = [text('user', 'task'), ...toolPair('tu-1'), text('assistant', 'latest')]
    expect(collectRemovableWithPair(messages, 1)).toEqual([messages[1], messages[2]])
  })

  it('never collects the last message', () => {
    const messages = [text('user', 'task'), text('assistant', 'a1'), text('user', 'latest')]
    expect(collectRemovableWithPair(messages, 2)).toEqual([])
  })

  it('skips a tool use whose result is the last message', () => {
    const messages = [text('user', 'task'), ...toolPair('tu-1')]
    expect(collectRemovableWithPair(messages, 1)).toEqual([])
  })
})

describe('insertMarker', () => {
  it('inserts an assistant message between user messages', () => {
    const messages = [text('user', 'task'), text('user', 'u1')]
    insertMarker(messages, 1, 'marker')
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1]!.content).toEqual([new TextBlock('marker')])
  })

  it('appends to the assistant message before the gap', () => {
    const original = new Message({
      role: 'assistant',
      content: [new TextBlock('a1')],
      trackingId: 'msg-1',
      metadata: { custom: { k: 'v' } },
    })
    const messages = [text('user', 'task'), original, text('user', 'u1')]
    insertMarker(messages, 2, 'marker')
    expect(messages).toHaveLength(3)
    expect(messages[1]!.content).toEqual([new TextBlock('a1'), new TextBlock('marker')])
    expect(messages[1]!.trackingId).toBe('msg-1')
    expect(messages[1]!.metadata).toEqual({ custom: { k: 'v' } })
    expect(original.content).toEqual([new TextBlock('a1')])
  })

  it('appends to the assistant message after the gap', () => {
    const messages = [text('user', 'task'), text('assistant', 'a1'), text('user', 'u1')]
    insertMarker(messages, 1, 'marker')
    expect(messages).toHaveLength(3)
    expect(messages[1]!.content).toEqual([new TextBlock('a1'), new TextBlock('marker')])
  })

  it.each([
    [0, ['task', 'marker', 'u1']],
    [5, ['task', 'u1', 'marker']],
  ])('clamps index %i into the history after message 0', (index, expected) => {
    const messages = [text('user', 'task'), text('user', 'u1')]
    insertMarker(messages, index, 'marker')
    expect(messages.map((message) => (message.content[0] as TextBlock).text)).toEqual(expected)
  })
})

describe('EmergencyTruncateStrategy', () => {
  it('leaves a marker on the assistant message after the cut', async () => {
    const messages = [
      text('user', 'pin'),
      text('assistant', 'a1'),
      text('user', 'u2'),
      text('assistant', 'a2'),
      text('user', 'u3'),
    ]
    expect(await new EmergencyTruncateStrategy().apply(makeContext(messages, 1.1, true))).toBe(true)
    expect(
      messages.map((message) => [message.role, message.content.map((block) => (block as TextBlock).text)])
    ).toEqual([
      ['user', ['pin']],
      ['assistant', ['a2', '[... 2 messages elided ...]']],
      ['user', ['u3']],
    ])
  })
})

describe('repeated message-level reduction', () => {
  // Regression tests for https://github.com/strands-agents/harness-sdk/issues/4685
  const strategies = {
    drop: () => Offload.drop('*').when({ utilization: 0.7, preserveRecent: 3 }),
    'drop-all': () => Offload.drop('*').when({ utilization: 0.7 }),
    truncate: () => Offload.truncate('*', { previewTokens: 4 }).when({ utilization: 0.7, preserveRecent: 3 }),
    'truncate-all': () => Offload.truncate('*', { previewTokens: 4 }).when({ utilization: 0.7 }),
    emergency: () => new EmergencyTruncateStrategy(),
  }

  function turn(index: number, textOnly: boolean): Message[] {
    if (textOnly) return [text('assistant', `a${index}`), text('user', `u${index}`)]
    return [
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ toolUseId: `tu-${index}`, name: 'read', input: {} })],
      }),
      makeToolResultMessage('x', `tu-${index}`),
    ]
  }

  describe.each(Object.entries(strategies))('%s', (_, makeStrategy) => {
    it.each([false, true])('keeps message 0 verbatim when textOnly=%s', async (textOnly) => {
      const strategy = makeStrategy()
      const task = () =>
        new Message({ role: 'user', content: [new TextBlock('task')], metadata: { custom: { pinned: true } } })
      const messages = [task()]
      for (let index = 0; index < 30; index++) {
        const added = turn(index, textOnly)
        messages.push(...added)
        await strategy.apply(makeContext(messages, 1.1, true))
        expect(messages.at(-1)).toBe(added.at(-1))
      }
      expect(messages[0]!.content).toEqual(task().content)
      expect(messages[0]!.metadata).toEqual(task().metadata)
      expect(messages.length).toBeLessThan(10)
    })
  })
})

/** A task message followed by one tool call per result, each result `tokens[i]` tokens long. */
function toolHistory(tokens: number[]): Message[] {
  const calls = tokens.flatMap((size, index) => [
    new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ toolUseId: `tu-${index}`, name: 'read', input: {} })],
    }),
    makeToolResultMessage('x'.repeat(size * 4), `tu-${index}`),
  ])
  return [text('user', 'task'), ...calls, text('assistant', 'done')]
}

function resultTexts(messages: Message[]): string[] {
  return messages.flatMap((message) =>
    message.content
      .filter((block): block is ToolResultBlock => block instanceof ToolResultBlock)
      .map((block) => (block.content[0] as TextBlock).text)
  )
}

describe('parseCondition', () => {
  it.each([
    ['utilization', 0.5, { value: 0.5, isShare: true }],
    ['utilization', '70%', { value: 0.7, isShare: true }],
    ['utilization', 50_000, { value: 50_000, isShare: false }],
    ['threshold', 2500, { value: 2500, isShare: false }],
    ['threshold', '5%', { value: 0.05, isShare: true }],
    ['preserveRecent', 4, { value: 4, isShare: false }],
    ['preserveRecent', 0.5, { value: 0.5, isShare: true }],
    ['preserveRecent', '50%', { value: 0.5, isShare: true }],
  ] as const)('accepts %s=%j', (name, raw, expected) => {
    expect(parseCondition(name, raw)).toEqual(expected)
  })

  it.each([
    ['utilization', 0, '0'],
    ['utilization', 1.5, '1.5'],
    ['utilization', '101%', '"101%"'],
    ['utilization', '70', '"70"'],
    ['threshold', -1, '-1'],
    ['threshold', 0.5, '0.5'],
    ['preserveRecent', 1.5, '1.5'],
    ['preserveRecent', '100%', '"100%"'],
  ] as const)('rejects %s=%s', (name, raw, shown) => {
    expect(() => parseCondition(name, raw)).toThrow(`${name}=${shown} is invalid: expected `)
  })
})

describe('condition resolution', () => {
  it.each([
    [{ utilization: '70%' }, undefined, 0.7, true],
    [{ utilization: 0.7 }, undefined, 0.69, false],
    [{ utilization: 50_000 }, 100_000, 0.5, true],
    [{ utilization: 50_000 }, 100_000, 0.49, false],
  ] as [OffloadConditions, number | undefined, number, boolean][])(
    '%j with a %s-token window fires at %s: %s',
    async (conditions, contextWindowLimit, utilization, fires) => {
      const strategy = Offload.drop('toolResults').when(conditions)
      expect(await strategy.apply(makeContext(toolHistory([10]), utilization, false, contextWindowLimit))).toBe(fires)
    }
  )

  it('rejects a utilization token count larger than the context window on init', () => {
    const strategy = Offload.drop('*').when({ utilization: 100_001 })
    expect(() => strategy.init!(makeContext([], 0.5, false, 100_000).agent)).toThrow(
      "utilization (100001) is larger than the model's context window (100000 tokens)"
    )
  })

  it.each([
    [100_000, 100_000],
    [100_000, '100%'],
    [undefined, 500_000],
  ] as [number | undefined, number | Percent][])(
    'inits with a %s-token window and utilization %s',
    (contextWindowLimit, utilization) => {
      const strategy = Offload.drop('*').when({ utilization })
      expect(() => strategy.init!(makeContext([], 0.5, false, contextWindowLimit).agent)).not.toThrow()
    }
  )

  it('resolves a percent threshold against the context window', async () => {
    const messages = toolHistory([100, 101])
    const strategy = Offload.drop('toolResults').when({ threshold: '1%' })

    expect(await strategy.apply(makeContext(messages, 0, false, 10_000))).toBe(true)

    expect(resultTexts(messages)).toEqual(['x'.repeat(400), '[Dropped]'])
  })
})

describe('granularity', () => {
  const BIG = 'x'.repeat(4000)
  const MESSAGE_MARKERS = { drop: '[Dropped: ', truncate: 'elided', summarize: '[Summarized: ' }
  const BLOCK_PREFIXES = { drop: '[Dropped]', truncate: TRUNCATED_PREFIX, summarize: '[Summarized: ' }
  const BUILDERS = {
    drop: (target: OffloadTarget) => Offload.drop(target),
    truncate: (target: OffloadTarget) => Offload.truncate(target, { previewTokens: 100 }),
    summarize: (target: OffloadTarget) => Offload.summarize(target),
  }

  function history(): Message[] {
    return [
      text('user', 'task'),
      text('assistant', BIG),
      text('user', BIG),
      text('assistant', BIG),
      text('user', BIG),
      text('assistant', 'end'),
      text('user', 'next'),
    ]
  }

  describe.each(['drop', 'truncate', 'summarize'] as const)('%s', (method) => {
    it.each([
      ['*', { utilization: 0.5 }, 0.9, 'messages'],
      ['*', { preserveRecent: 1 }, 0, 'messages'],
      ['*', { threshold: 200, utilization: 0.5 }, 0.9, [1, 2, 3, 4]],
      ['assistantText', { utilization: 0.5 }, 0.9, [1, 3]],
      ['assistantText', { utilization: 0.5 }, 0.1, 'nothing'],
    ] as [OffloadTarget, OffloadConditions, number, 'messages' | 'nothing' | number[]][])(
      'target=%j with %j at utilization %s acts on %j',
      async (target, conditions, utilization, outcome) => {
        const messages = history()
        const acted = await BUILDERS[method](target).when(conditions).apply(makeContext(messages, utilization))

        if (outcome === 'nothing') {
          expect(acted).toBe(false)
          expect(textsOf(messages)).toEqual(textsOf(history()))
          return
        }
        expect(acted).toBe(true)
        if (outcome === 'messages') {
          expect(messages.length).toBeLessThan(history().length)
          expect(textsOf(messages).flat().join('\n')).toContain(MESSAGE_MARKERS[method])
          return
        }
        expect(messages).toHaveLength(history().length)
        for (const index of [1, 2, 3, 4]) {
          const blockText = (messages[index]!.content[0] as TextBlock).text
          if (outcome.includes(index)) expect(blockText.startsWith(BLOCK_PREFIXES[method])).toBe(true)
          else expect(blockText).toBe(BIG)
        }
      }
    )

    it('leaves the newest message alone when gated by utilization', async () => {
      const messages = [...history().slice(0, -1), text('user', BIG)]

      expect(await BUILDERS[method]('userText').when({ utilization: 0.5 }).apply(makeContext(messages, 0.9))).toBe(true)

      expect((messages[2]!.content[0] as TextBlock).text.startsWith(BLOCK_PREFIXES[method])).toBe(true)
      expect((messages.at(-1)!.content[0] as TextBlock).text).toBe(BIG)
    })
  })
})

describe('whole-message conditions', () => {
  describe.each([
    ['drop', () => Offload.drop('*')],
    ['truncate', () => Offload.truncate('*')],
    ['summarize', () => Offload.summarize('*')],
  ] as const)('Offload.%s("*")', (method, builder) => {
    it.each([{}, { preserveRecent: 0 }] as OffloadConditions[])('rejects %j', (conditions) => {
      expect(() => builder().when(conditions)).toThrow(
        `Offload.${method}("*") without threshold acts on whole messages; set utilization or preserveRecent`
      )
    })

    it.each([{ utilization: 0.5 }, { preserveRecent: 1 }, { threshold: 2500 }] as OffloadConditions[])(
      'accepts %j',
      (conditions) => {
        expect(() => builder().when(conditions)).not.toThrow()
      }
    )
  })
})

describe('truncate block threshold', () => {
  it('defaults to previewTokens and skips blocks it already truncated', async () => {
    const messages = toolHistory([100, 2000])
    const strategy = Offload.truncate('toolResults', { previewTokens: 100 }).when({})

    expect(await strategy.apply(makeContext(messages, 0))).toBe(true)
    const firstPass = resultTexts(messages)
    expect(firstPass[0]).toBe('x'.repeat(400))
    expect(firstPass[1]!.startsWith(TRUNCATED_PREFIX)).toBe(true)
    expect(Math.ceil(firstPass[1]!.length / 4)).toBeGreaterThan(100)

    expect(await strategy.apply(makeContext(messages, 0))).toBe(false)
    expect(resultTexts(messages)).toEqual(firstPass)
  })
})

describe('truncate whole messages', () => {
  /** Ten tokens per message under the heuristic. */
  const pad = (label: string): string => label.padEnd(40, '.')

  function history(): Message[] {
    const messages = [text('user', 'task')]
    for (let index = 1; index <= 10; index++) {
      messages.push(text(index % 2 === 1 ? 'assistant' : 'user', pad(`m${index}`)))
    }
    return messages
  }

  it.each([
    ['headTail', 40, ['task', 'm1', 'm2', '[... 7 messages elided ...]', 'm10']],
    ['head', 40, ['task', 'm1', 'm2', 'm3', 'm4', '[... 5 messages elided ...]', 'm10']],
    ['tail', 50, ['task', '[... 5 messages elided ...]', 'm6', 'm7', 'm8', 'm9', 'm10']],
  ] as [NonNullable<TruncateConfig['preview']>, number, string[]][])(
    'preview=%s with previewTokens=%s elides the middle',
    async (preview, previewTokens, expected) => {
      const messages = history()
      const strategy = Offload.truncate('*', { preview, previewTokens }).when({ utilization: 0.5 })

      expect(await strategy.apply(makeContext(messages, 0.9))).toBe(true)

      const label = (value: string): string => (value.startsWith('m') ? pad(value) : value)
      expect(textsOf(messages)).toEqual(expected.map((value) => [label(value)]))
    }
  )

  it('stops once only its own marker is left to elide', async () => {
    const messages = history()
    const strategy = Offload.truncate('*', { preview: 'head', previewTokens: 40 }).when({ utilization: 0.5 })
    expect(await strategy.apply(makeContext(messages, 0.9))).toBe(true)
    const afterFirstPass = textsOf(messages)

    expect(await strategy.apply(makeContext(messages, 0.9))).toBe(false)

    expect(textsOf(messages)).toEqual(afterFirstPass)
  })
})
