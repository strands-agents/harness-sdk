import { describe, it, expect, vi } from 'vitest'
import { Offload } from '../offload/index.js'
import { EmergencyTruncateStrategy } from '../offload/base.js'
import { offloadPlaceholder } from '../../placeholder.js'
import { parseCondition, ResolvedConditions } from '../offload/conditions.js'
import type { OffloadConditions, Percent } from '../offload/conditions.js'
import { OffloadTargetMatcher } from '../offload/target.js'
import type { OffloadTarget } from '../offload/target.js'
import { collectRemovableWithPair, insertMarker } from '../../message-trimming.js'
import type { TruncateConfig } from '../../methods/truncate.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { ImageBlock } from '../../../types/media.js'
import { logger } from '../../../logging/logger.js'
import type { Role } from '../../../types/messages.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import type { Agent } from '../../../agent/agent.js'
import type { ContextState } from '../../types.js'
import { withDefaultLocale } from '../../../__fixtures__/locale-helpers.js'
import { offloadedBy, placeholdersIn } from '../../../__fixtures__/context-manager-helpers.js'
import { summarizeContent } from '../../methods/summarize.js'

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
  it('rejects a token threshold at or below previewTokens', () => {
    expect(() => Offload.truncate('toolResults', { previewTokens: 500 }).when({ blockThreshold: 500 })).toThrow(
      'blockThreshold (500) must be greater than previewTokens (500) to ensure truncation converges'
    )
  })

  it.each([
    [10_000, '5%', 500],
    [undefined, '0.25%', 500],
  ] as [number | undefined, Percent, number][])(
    'rejects on init a percent threshold of a %s-token window at or below previewTokens (%s)',
    (contextWindowLimit, threshold, tokens) => {
      const strategy = Offload.truncate('toolResults', { previewTokens: 500 }).when({ blockThreshold: threshold })
      expect(() => strategy.init!(makeContext([], 0.5, false, contextWindowLimit).agent)).toThrow(
        `blockThreshold (${tokens} tokens of the context window) must be greater than previewTokens (500)`
      )
    }
  )

  it('accepts on init a percent threshold above previewTokens', () => {
    const strategy = Offload.truncate('toolResults', { previewTokens: 500 }).when({ blockThreshold: '6%' })
    expect(() => strategy.init!(makeContext([], 0.5, false, 10_000).agent)).not.toThrow()
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
    expect(offloadedBy(block.content[0])).toBe('truncate')
  })

  it('does not truncate results below threshold', async () => {
    const smallText = 'short result'
    const messages = [makeToolResultMessage(smallText)]
    const strategy = Offload.truncate('toolResults').when({ blockThreshold: 2500 })
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
  it('Offload.drop() drops tool result content from context window entirely', async () => {
    const largeText = 'x'.repeat(100)
    const messages = [makeToolResultMessage(largeText)]
    const strategy = Offload.drop('toolResults').when({})
    const context = makeContext(messages)

    const result = await strategy.apply(context)

    expect(result).toBe(true)
    const block = messages[0]!.content[0] as ToolResultBlock
    expect((block.content[0] as TextBlock).text).toBe('[Dropped: ~25 tokens]')
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
    expect(offloadedBy(block.content[0])).toBe('truncate')
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

  it.each([
    ['drop', Offload.drop('toolResults')],
    ['truncate', Offload.truncate('toolResults', { previewTokens: 500 })],
    ['summarize', Offload.summarize('toolResults')],
  ])('Offload.%s() returns a strategy that runs eagerly without .when()', (method, strategy) => {
    const agent = createMockAgent()
    strategy.init!(agent)
    expect(strategy.name).toBe(`offload:${method}`)
    expect(agent.trackedHooks).toHaveLength(1)
  })

  it('.when() replaces the conditions and keeps the target and config', async () => {
    const bare = Offload.truncate('toolResults', { previewTokens: 100 })
    const strategy = bare.when({ blockThreshold: 2000 }).when({ preserveRecent: 1 })
    expect(strategy).not.toBe(bare)
    const messages = toolHistory([500, 500, 500])

    expect(await strategy.apply(makeContext(messages))).toBe(true)

    expect(resultMethods(messages)).toStrictEqual(['truncate', 'truncate', undefined])
  })

  it.each([
    ['*', '("*") would act on every message'],
    ['media', '("media") would remove media'],
  ] as const)('rejects on init a bare %s strategy that cannot run without conditions', (target, error) => {
    const strategy = Offload.drop(target)
    expect(() => strategy.init!(createMockAgent())).toThrow(error)
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
    'drop("%s") with utilization replaces each %s text block between the first and last message, keeping every message',
    async (target, role) => {
      const messages = conversation(4)
      const strategy = Offload.drop(target).when({ contextUtilization: '50%' })

      expect(await strategy.apply(makeContext(messages, 0.9))).toBe(true)

      expect(messages).toHaveLength(8)
      for (const [index, message] of messages.entries()) {
        const dropped = message.role === role && index > 0 && index < messages.length - 1
        expect(offloadedBy(message.content[0])).toBe(dropped ? 'drop' : undefined)
      }
    }
  )

  it('drop("*") message-level repairs alternation', async () => {
    const messages = conversation(4)
    const strategy = Offload.drop('*').when({ contextUtilization: '50%' })
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
    const strategy = Offload.drop('*').when({ contextUtilization: '50%', preserveRecent: 4 })
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
    const strategy = Offload.drop('*').when({ contextUtilization: '50%' })
    const context = makeContext(messages, 0.9)

    const result = await strategy.apply(context)

    expect(result).toBe(true)
    expect(textsOf(messages)).toEqual([['q1'], ['a2', '[Dropped: 2 messages]']])
  })

  it('message-level starts with user message after operation', async () => {
    const messages = conversation(3)
    const strategy = Offload.drop('*').when({ contextUtilization: '50%' })
    const context = makeContext(messages, 0.9)

    await strategy.apply(context)

    expect(messages[0]!.role).toBe('user')
  })
})

describe('Offload with * target and threshold (acts on messages larger than threshold)', () => {
  const LARGE = 'x'.repeat(2500 * 4 + 100)

  it.each([
    ['drop', Offload.drop('*')],
    ['truncate', Offload.truncate('*')],
    ['summarize', Offload.summarize('*')],
  ])('Offload.%s("*") acts on large messages and keeps small ones', async (_, builder) => {
    const messages = [
      text('user', 'task'),
      text('assistant', LARGE),
      text('user', 'small question'),
      text('assistant', LARGE),
      text('user', 'next'),
    ]

    const result = await builder.when({ blockThreshold: 2500 }).apply(makeContext(messages))

    expect(result).toBe(true)
    const texts = textsOf(messages).flat()
    expect(texts).not.toContain(LARGE)
    expect(texts).toContain('small question')
    expect(texts).toContain('next')
  })

  it('Offload.truncate("*") with threshold shortens large messages in place and leaves the newest alone', async () => {
    const messages = [
      text('user', 'task'),
      text('assistant', LARGE),
      text('user', 'small question'),
      text('assistant', LARGE),
    ]

    expect(await Offload.truncate('*').when({ blockThreshold: 2500 }).apply(makeContext(messages))).toBe(true)

    expect(messages).toHaveLength(4)
    expect(offloadedBy(messages[1]!.content[0])).toBe('truncate')
    expect((messages[2]!.content[0] as TextBlock).text).toBe('small question')
    expect((messages[3]!.content[0] as TextBlock).text).toBe(LARGE)
  })

  it('Offload.truncate("*") with threshold skips small content', async () => {
    const messages = [text('user', 'task'), text('assistant', 'short'), text('user', 'next')]
    const strategy = Offload.truncate('*').when({ blockThreshold: 2500 })

    const result = await strategy.apply(makeContext(messages))

    expect(result).toBe(false)
  })

  it('Offload.truncate("*") rejects a threshold at or below previewTokens', () => {
    expect(() => Offload.truncate('*', { previewTokens: 1000 }).when({ blockThreshold: 500 })).toThrow(
      'blockThreshold (500) must be greater than previewTokens (1000) to ensure truncation converges'
    )
  })
})

describe('Offload with media target', () => {
  function withImage(): Message {
    return new Message({
      role: 'user',
      content: [
        new TextBlock('look at this'),
        new ImageBlock({ format: 'png', source: { bytes: new Uint8Array(4000) } }),
        new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('x'.repeat(4000))] }),
      ],
    })
  }

  it('drops media blocks and leaves text and tool results alone', async () => {
    const message = withImage()

    const result = await Offload.drop('media')
      .when({ contextUtilization: '50%', blockThreshold: 10 })
      .apply(makeContext([text('user', 'task'), message, text('assistant', 'b')]))

    expect(result).toBe(true)
    expect(message.content[0]).toEqual(new TextBlock('look at this'))
    expect((message.content[1] as TextBlock).text).toBe(
      '[Dropped: image, ~2,692 tokens, removed from context after it was received]'
    )
    expect(message.content[2]).toEqual(withImage().content[2])
  })

  it('preserveRecent counts only messages with media', async () => {
    const older = withImage()
    const newer = withImage()
    const messages = [text('user', 'task'), older, text('assistant', 'a'), newer, text('assistant', 'b')]

    await Offload.drop('media').when({ preserveRecent: 1 }).apply(makeContext(messages))

    expect((older.content[1] as TextBlock).text).toBe(
      '[Dropped: image, ~2,692 tokens, removed from context after it was received]'
    )
    expect(newer.content[1]).toBeInstanceOf(ImageBlock)
  })

  describe('under the model token heuristic that counts media as 0 tokens', () => {
    function withHeuristicModel(messages: Message[]): ContextState {
      const agent = createMockAgent({
        messages,
        extra: { model: new MockMessageModel() } as unknown as Partial<Agent>,
      })
      return { messages, agent, utilization: 0.5 }
    }

    it.each([
      { contextUtilization: '50%' },
      { contextUtilization: '50%', blockThreshold: 1000 },
    ] as OffloadConditions[])('drops the media with %j', async (conditions) => {
      const message = withImage()

      expect(
        await Offload.drop('media')
          .when(conditions)
          .apply(withHeuristicModel([text('user', 'task'), message, text('assistant', 'b')]))
      ).toBe(true)
      expect(message.content).toEqual([
        new TextBlock('look at this'),
        offloadPlaceholder('drop', '[Dropped: image, removed from context after it was received]', undefined),
        withImage().content[2],
      ])
    })

    it('offloads the media with a marker that leaves out the unmeasured size', async () => {
      const message = withImage()

      expect(
        await Offload.truncate('media')
          .when({ contextUtilization: '50%' })
          .apply(withHeuristicModel([text('user', 'task'), message, text('assistant', 'b')]))
      ).toBe(true)
      expect((message.content[1] as TextBlock).text).toBe(
        '[Offloaded: image, removed from context after it was received]'
      )
    })
  })
})

describe('without a threshold', () => {
  it('skips empty text blocks', async () => {
    const message = new Message({ role: 'assistant', content: [new TextBlock(''), new TextBlock('  \n')] })

    expect(
      await Offload.drop('assistantText')
        .when({})
        .apply(makeContext([message]))
    ).toBe(false)
    expect(message.content).toEqual([new TextBlock(''), new TextBlock('  \n')])
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
    const strategy = Offload.drop('*').when({ contextUtilization: '50%' })
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
    const strategy = Offload.drop('*').when({ contextUtilization: '50%' })
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
    const strategy = Offload.drop('*').when({ contextUtilization: '50%', preserveRecent: 4 })
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
    const strategy = Offload.drop('*').when({ contextUtilization: '85%' })
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
    const strategy = Offload.drop('*').when({ contextUtilization: '85%' })
    const context = makeContext(messages, 0.5)

    const acted = await strategy.apply(context)
    expect(acted).toBe(false)
    expect(messages.length).toBe(4)
  })
})

describe('ResolvedConditions.withoutPreserved', () => {
  const matches = (count: number): number[] => Array.from({ length: count }, (_, index) => index)

  it.each([
    [3, 10, 7],
    ['70%', 10, 3],
    ['50%', 3, 1],
    ['99%', 10, 0],
  ] as const)('preserveRecent=%j of %i matches leaves %i', (preserveRecent, count, left) => {
    expect(new ResolvedConditions({ preserveRecent }).withoutPreserved(matches(count))).toEqual(matches(left))
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
    insertMarker(messages, 1, new TextBlock('marker'))
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
    insertMarker(messages, 2, new TextBlock('marker'))
    expect(messages).toHaveLength(3)
    expect(messages[1]!.content).toEqual([new TextBlock('a1'), new TextBlock('marker')])
    expect(messages[1]!.trackingId).toBe('msg-1')
    expect(messages[1]!.metadata).toEqual({ custom: { k: 'v' } })
    expect(original.content).toEqual([new TextBlock('a1')])
  })

  it('appends to the assistant message after the gap', () => {
    const messages = [text('user', 'task'), text('assistant', 'a1'), text('user', 'u1')]
    insertMarker(messages, 1, new TextBlock('marker'))
    expect(messages).toHaveLength(3)
    expect(messages[1]!.content).toEqual([new TextBlock('a1'), new TextBlock('marker')])
  })

  it.each([
    [0, ['task', 'marker', 'u1']],
    [5, ['task', 'u1', 'marker']],
  ])('clamps index %i into the history after message 0', (index, expected) => {
    const messages = [text('user', 'task'), text('user', 'u1')]
    insertMarker(messages, index, new TextBlock('marker'))
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
    drop: () => Offload.drop('*').when({ contextUtilization: '70%', preserveRecent: 3 }),
    'drop-all': () => Offload.drop('*').when({ contextUtilization: '70%' }),
    truncate: () => Offload.truncate('*', { previewTokens: 4 }).when({ contextUtilization: '70%', preserveRecent: 3 }),
    'truncate-all': () => Offload.truncate('*', { previewTokens: 4 }).when({ contextUtilization: '70%' }),
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

function resultMethods(messages: Message[]): (string | undefined)[] {
  return messages.flatMap((message) =>
    message.content
      .filter((block): block is ToolResultBlock => block instanceof ToolResultBlock)
      .map((block) => offloadedBy(block.content[0]))
  )
}

describe('parseCondition', () => {
  const EXPECTED_FORMS = {
    contextUtilization: 'a "N%" string up to "100%" or a whole token count of at least 1000',
    preserveRecent: 'a "N%" string below "100%" or a whole message count',
  }

  it.each([
    ['contextUtilization', '70%', { value: 0.7, isShare: true }],
    ['contextUtilization', 50_000, { value: 50_000, isShare: false }],
    ['contextUtilization', 1000, { value: 1000, isShare: false }],
    ['blockThreshold', 2500, { value: 2500, isShare: false }],
    ['blockThreshold', '5%', { value: 0.05, isShare: true }],
    ['preserveRecent', 4, { value: 4, isShare: false }],
    ['preserveRecent', '50%', { value: 0.5, isShare: true }],
  ] as const)('accepts %s=%j', (name, raw, expected) => {
    expect(parseCondition(name, raw)).toEqual(expected)
  })

  it.each([
    ['contextUtilization', 0, '0'],
    ['contextUtilization', 0.5, '0.5'],
    ['contextUtilization', 1, '1'],
    ['contextUtilization', 1.5, '1.5'],
    ['contextUtilization', '101%', '"101%"'],
    ['contextUtilization', '70', '"70"'],
    ['blockThreshold', -1, '-1'],
    ['blockThreshold', 0, '0'],
    ['blockThreshold', 0.5, '0.5'],
    ['blockThreshold', '100%', '"100%"'],
    ['preserveRecent', 0.5, '0.5'],
    ['preserveRecent', 1.5, '1.5'],
    ['preserveRecent', '100%', '"100%"'],
  ] as const)('rejects %s=%s', (name, raw, shown) => {
    expect(() => parseCondition(name, raw)).toThrow(`${name}=${shown} is invalid: expected `)
  })

  it.each([
    ['contextUtilization', 80, '; for 80%, write "80%"'],
    ['contextUtilization', 0.8, '; for 80%, write "80%"'],
    ['contextUtilization', 1, '; for 100%, write "100%"'],
    ['contextUtilization', 999, ''],
    ['preserveRecent', 0.07, '; for 7%, write "7%"'],
  ] as const)('rejects %s=%s and suggests a percent when it reads as one', (name, raw, hint) => {
    expect(() => parseCondition(name, raw)).toThrow(
      new Error(`${name}=${raw} is invalid: expected ${EXPECTED_FORMS[name]}${hint}`)
    )
  })
})

describe('condition resolution', () => {
  it.each(['utilisation', 'constructor', 'toString'])('rejects the unknown condition name %s', (name) => {
    expect(() => Offload.drop('toolResults').when({ [name]: 0.5 } as OffloadConditions)).toThrow(
      `unknown condition "${name}": expected contextUtilization, blockThreshold, or preserveRecent`
    )
  })

  it.each([
    [{ contextUtilization: '70%' }, undefined, 0.7, true],
    [{ contextUtilization: '70%' }, undefined, 0.69, false],
    [{ contextUtilization: 50_000 }, 100_000, 0.5, true],
    [{ contextUtilization: 50_000 }, 100_000, 0.49, false],
  ] as [OffloadConditions, number | undefined, number, boolean][])(
    '%j with a %s-token window fires at %s: %s',
    async (conditions, contextWindowLimit, utilization, fires) => {
      const strategy = Offload.drop('toolResults').when(conditions)
      expect(await strategy.apply(makeContext(toolHistory([10]), utilization, false, contextWindowLimit))).toBe(fires)
    }
  )

  it('rejects a utilization token count larger than the context window on init', () => {
    const strategy = Offload.drop('*').when({ contextUtilization: 100_001 })
    expect(() => strategy.init!(makeContext([], 0.5, false, 100_000).agent)).toThrow(
      "contextUtilization (100001) is larger than the model's context window (100000 tokens)"
    )
  })

  it('warns and skips the window check on init when the model has no context window', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const strategy = Offload.drop('*').when({ contextUtilization: 500_000 })

    expect(() => strategy.init!(makeContext([], 0.5).agent)).not.toThrow()

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('contextUtilization=<500000> | contextWindowLimit is not set')
    )
    warnSpy.mockRestore()
  })

  it.each([
    [100_000, 100_000],
    [100_000, '100%'],
    [undefined, '80%'],
  ] as [number | undefined, number | Percent][])(
    'inits with a %s-token window and utilization %s',
    (contextWindowLimit, utilization) => {
      const strategy = Offload.drop('*').when({ contextUtilization: utilization })
      expect(() => strategy.init!(makeContext([], 0.5, false, contextWindowLimit).agent)).not.toThrow()
    }
  )

  it('resolves a percent threshold against the context window', async () => {
    const messages = toolHistory([100, 101])
    const strategy = Offload.drop('toolResults').when({ blockThreshold: '1%' })

    expect(await strategy.apply(makeContext(messages, 0, false, 10_000))).toBe(true)

    expect(resultTexts(messages)).toEqual(['x'.repeat(400), '[Dropped: ~101 tokens]'])
  })
})

describe('tool results that already hold a placeholder', () => {
  it.each([
    ['drop', () => Offload.drop('toolResults')],
    ['truncate', () => Offload.truncate('toolResults', { previewTokens: 100 })],
    ['summarize', () => Offload.summarize('toolResults')],
  ] as const)('%s leaves them alone on a second pass', async (method, builder) => {
    const messages = [...toolHistory([1000, 1000]), text('user', 'next')]
    const strategy = builder().when({ contextUtilization: '50%' })

    expect(await strategy.apply(makeContext(messages, 0.9))).toBe(true)
    const offloaded = resultTexts(messages)
    vi.mocked(summarizeContent).mockClear()

    expect(await strategy.apply(makeContext(messages, 0.9))).toBe(false)

    expect(resultMethods(messages)).toEqual([method, method])
    expect(resultTexts(messages)).toEqual(offloaded)
    expect(summarizeContent).not.toHaveBeenCalled()
  })

  it.each([
    ['truncate', () => Offload.truncate('toolResults', { previewTokens: 100 })],
    ['summarize', () => Offload.summarize('toolResults')],
  ] as const)('%s leaves a dropped result alone', async (_method, builder) => {
    const messages = [...toolHistory([1000, 1000]), text('user', 'next')]
    await Offload.drop('toolResults').when({ contextUtilization: '50%' }).apply(makeContext(messages, 0.9))
    vi.mocked(summarizeContent).mockClear()

    expect(await builder().when({ contextUtilization: '50%' }).apply(makeContext(messages, 0.9))).toBe(false)

    expect(resultMethods(messages)).toEqual(['drop', 'drop'])
    expect(summarizeContent).not.toHaveBeenCalled()
  })
})

describe('granularity', () => {
  const BIG = 'x'.repeat(4000)
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
      ['*', { contextUtilization: '50%' }, 0.9, 'messages'],
      ['*', { preserveRecent: 1 }, 0, 'messages'],
      ['*', { blockThreshold: 200, contextUtilization: '50%' }, 0.9, 'large messages'],
      ['assistantText', { contextUtilization: '50%' }, 0.9, [1, 3]],
      ['assistantText', { contextUtilization: '50%' }, 0.1, 'nothing'],
    ] as [OffloadTarget, OffloadConditions, number, 'messages' | 'large messages' | 'nothing' | number[]][])(
      'target=%j with %j at utilization %s acts on %j',
      async (target, conditions, utilization, expected) => {
        // Truncate shortens large messages in place rather than removing them.
        const outcome = expected === 'large messages' && method === 'truncate' ? [1, 2, 3, 4] : expected
        const messages = history()
        const acted = await BUILDERS[method](target).when(conditions).apply(makeContext(messages, utilization))

        if (outcome === 'nothing') {
          expect(acted).toBe(false)
          expect(textsOf(messages)).toEqual(textsOf(history()))
          return
        }
        expect(acted).toBe(true)
        if (outcome === 'messages' || outcome === 'large messages') {
          expect(messages.length).toBeLessThan(history().length)
          expect(placeholdersIn(messages)).toContainEqual(
            expect.objectContaining({ method, removedMessages: expect.any(Number) })
          )
          if (outcome === 'large messages') expect(textsOf(messages).flat()).toContain('end')
          return
        }
        expect(messages).toHaveLength(history().length)
        for (const index of [1, 2, 3, 4]) {
          const block = messages[index]!.content[0]
          if (outcome.includes(index)) expect(offloadedBy(block)).toBe(method)
          else expect((block as TextBlock).text).toBe(BIG)
        }
      }
    )

    it('leaves the newest message alone when gated by utilization', async () => {
      const messages = [...history().slice(0, -1), text('user', BIG)]

      expect(
        await BUILDERS[method]('userText').when({ contextUtilization: '50%' }).apply(makeContext(messages, 0.9))
      ).toBe(true)

      expect(offloadedBy(messages[2]!.content[0])).toBe(method)
      expect((messages.at(-1)!.content[0] as TextBlock).text).toBe(BIG)
    })

    it('leaves the first message alone when gated by utilization', async () => {
      const messages = [text('user', BIG), ...history().slice(1)]

      expect(
        await BUILDERS[method]('userText').when({ contextUtilization: '50%' }).apply(makeContext(messages, 0.9))
      ).toBe(true)

      expect((messages[0]!.content[0] as TextBlock).text).toBe(BIG)
      expect(offloadedBy(messages[2]!.content[0])).toBe(method)
    })
  })
})

describe('unconditioned strategy warning', () => {
  it('warns on init for an unconditioned strategy that acts on arrival', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    Offload.drop('assistantText').init!(createMockAgent())

    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      'strategy=<offload:drop>, target=<"assistantText"> | strategy has no conditions, so it acts on every matching block as it arrives, before the model reads it | use .when() to set blockThreshold, contextUtilization, or preserveRecent'
    )
    warnSpy.mockRestore()
  })

  it.each([{ blockThreshold: 1 }, { contextUtilization: '50%' }, { preserveRecent: 1 }] as OffloadConditions[])(
    'does not warn for a strategy with %j',
    (conditions) => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      Offload.drop('assistantText').when(conditions).init!(createMockAgent())

      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    }
  )
})

describe('whole-message conditions', () => {
  describe.each([
    ['drop', () => Offload.drop('*')],
    ['truncate', () => Offload.truncate('*')],
    ['summarize', () => Offload.summarize('*')],
  ] as const)('Offload.%s("*")', (method, builder) => {
    it.each([{}, { preserveRecent: 0 }, { preserveRecent: '0%' }] as OffloadConditions[])(
      'rejects %j',
      (conditions) => {
        expect(() => builder().when(conditions)).toThrow(
          `Offload.${method}("*") would act on every message; use .when() to set contextUtilization, blockThreshold, or a preserveRecent above 0`
        )
      }
    )

    it.each([{ contextUtilization: '50%' }, { preserveRecent: 1 }, { blockThreshold: 2500 }] as OffloadConditions[])(
      'accepts %j',
      (conditions) => {
        expect(() => builder().when(conditions)).not.toThrow()
      }
    )
  })
})

describe('media conditions', () => {
  describe.each([
    ['drop', () => Offload.drop('media')],
    ['truncate', () => Offload.truncate('media')],
    ['summarize', () => Offload.summarize('media')],
  ] as const)('Offload.%s("media")', (method, builder) => {
    it.each([{}, { blockThreshold: 100 }, { preserveRecent: '0%' }] as OffloadConditions[])(
      'rejects %j',
      (conditions) => {
        expect(() => builder().when(conditions)).toThrow(
          `Offload.${method}("media") would remove media before the model sees it; use .when() to set contextUtilization or a preserveRecent above 0`
        )
      }
    )

    it.each([{ contextUtilization: '80%' }, { preserveRecent: 1 }] as OffloadConditions[])(
      'accepts %j',
      (conditions) => {
        expect(() => builder().when(conditions)).not.toThrow()
      }
    )
  })
})

describe('tool list targets', () => {
  it('subtracts excluded tools from included ones in a mixed list', () => {
    const matcher = new OffloadTargetMatcher(['tool::bash', 'python', '!tool::python', '!grep'])
    const toolNameMap = new Map([
      ['tu-bash', 'bash'],
      ['tu-python', 'python'],
    ])
    const resultOf = (toolUseId: string): ToolResultBlock =>
      new ToolResultBlock({ toolUseId, status: 'success', content: [new TextBlock('x')] })
    const message = new Message({ role: 'user', content: [] })
    expect(matcher.matchesBlock(resultOf('tu-bash'), message, toolNameMap)).toBe(true)
    expect(matcher.matchesBlock(resultOf('tu-python'), message, toolNameMap)).toBe(false)
  })

  it('rejects a list that excludes every tool it includes', () => {
    expect(() => Offload.drop(['tool::bash', '!bash'])).toThrow(
      'Tool target ["tool::bash","!bash"] excludes every tool it includes, so it matches nothing'
    )
  })
})

describe('truncate block threshold', () => {
  it('leaves blocks within the preview alone and skips blocks it already truncated', async () => {
    const messages = toolHistory([100, 2000])
    const strategy = Offload.truncate('toolResults', { previewTokens: 100 }).when({})

    expect(await strategy.apply(makeContext(messages, 0))).toBe(true)
    const firstPass = resultTexts(messages)
    expect(firstPass[0]).toBe('x'.repeat(400))
    expect(resultMethods(messages)).toStrictEqual([undefined, 'truncate'])
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
      const strategy = Offload.truncate('*', { preview, previewTokens }).when({ contextUtilization: '50%' })

      expect(await strategy.apply(makeContext(messages, 0.9))).toBe(true)

      const label = (value: string): string => (value.startsWith('m') ? pad(value) : value)
      expect(textsOf(messages)).toEqual(expected.map((value) => [label(value)]))
    }
  )

  it("elides a message carrying another strategy's marker for removed messages", async () => {
    const messages = history()
    messages[3] = new Message({
      role: 'assistant',
      content: [offloadPlaceholder('summarize', pad('summary'), undefined, 3)],
    })
    const strategy = Offload.truncate('*', { previewTokens: 40 }).when({ contextUtilization: '50%' })

    expect(await strategy.apply(makeContext(messages, 0.9))).toBe(true)

    expect(textsOf(messages)).toEqual([
      ['task'],
      [pad('m1')],
      [pad('m2')],
      ['[... 7 messages elided ...]'],
      [pad('m10')],
    ])
  })

  it('stops once only its own marker is left to elide', async () => {
    const messages = history()
    const strategy = Offload.truncate('*', { preview: 'head', previewTokens: 40 }).when({ contextUtilization: '50%' })
    expect(await strategy.apply(makeContext(messages, 0.9))).toBe(true)
    const afterFirstPass = textsOf(messages)

    expect(await strategy.apply(makeContext(messages, 0.9))).toBe(false)

    expect(textsOf(messages)).toEqual(afterFirstPass)
  })
})
