import { describe, it, expect, vi } from 'vitest'
import { Message, TextBlock, ToolResultBlock } from '../../types/messages.js'
import type { MessageData } from '../../types/messages.js'
import { foldIntoLastUserMessage, isUserTurn, resolveTrigger, createInjectionMiddleware } from '../message-injection.js'
import type { InvokeModelContext } from '../../middleware/index.js'
import type { InjectionContext } from '../types.js'
import { createMockAgent } from '../../__fixtures__/agent-helpers.js'
import { logger } from '../../logging/logger.js'
import { anyTrackingId } from '../../__fixtures__/message-helpers.js'

const user = (text: string) => new Message({ role: 'user', content: [new TextBlock(text)] })
const assistant = (text: string) => new Message({ role: 'assistant', content: [new TextBlock(text)] })
const toolResult = () =>
  new Message({
    role: 'user',
    content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('done')] })],
  })

// resolveTrigger predicates take an InjectionContext; tests only exercise `messages`, so a minimal bag suffices.
const injectionCtx = (messages: MessageData[]) => ({ messages }) as unknown as InjectionContext
describe('foldIntoLastUserMessage', () => {
  it('appends the text as a trailing TextBlock on the last user message, behind its content', () => {
    const messages = [user('original task'), assistant('prior step'), user('next ask')]
    const result = foldIntoLastUserMessage(messages, 'INJECTED')

    // A trailing run is the only placement a provider can keep out of its cached prefix.
    expect(result.messages.map((message) => message.toJSON())).toStrictEqual([
      { role: 'user', content: [{ text: 'original task' }], trackingId: anyTrackingId },
      { role: 'assistant', content: [{ text: 'prior step' }], trackingId: anyTrackingId },
      {
        role: 'user',
        content: [{ text: 'next ask' }, { text: '\n\nINJECTED' }],
        trackingId: anyTrackingId,
      },
    ])
    expect(result.appended).toBe(1)
  })

  it('preserves the folded-into message tracking id (same logical message)', () => {
    const target = new Message({ role: 'user', content: [new TextBlock('ask')], trackingId: 'durable-1' })
    const result = foldIntoLastUserMessage([assistant('prior'), target], 'INJECTED')

    // Folding rewrites content but it is the same message, so its tracking id must survive.
    expect(result.messages[1]!.trackingId).toBe('durable-1')
  })

  it('returns a new array and does not mutate the input or its messages', () => {
    const original = user('ask')
    const messages = [assistant('prior'), original]
    const result = foldIntoLastUserMessage(messages, 'INJECTED')

    expect(result.messages).not.toBe(messages)
    expect(messages[1]).toBe(original)
    expect(original.content).toHaveLength(1) // untouched
    expect(result.messages[1]).not.toBe(original)
  })

  it('appends after the tool result block when the target is a tool-result turn', () => {
    const tr = toolResult()
    const result = foldIntoLastUserMessage([user('task'), assistant('thinking'), tr], 'INJECTED')

    // A tool result must stay first in the turn answering a tool use; appending satisfies that.
    expect(result.messages.map((message) => message.toJSON())).toStrictEqual([
      { role: 'user', content: [{ text: 'task' }], trackingId: anyTrackingId },
      { role: 'assistant', content: [{ text: 'thinking' }], trackingId: anyTrackingId },
      {
        role: 'user',
        content: [tr.toJSON().content[0], { text: '\n\nINJECTED' }],
        trackingId: anyTrackingId,
      },
    ])
  })

  it('targets the most recent user message when several exist', () => {
    const messages = [user('first'), assistant('a'), user('second')]
    const result = foldIntoLastUserMessage(messages, 'INJECTED')

    expect(result.messages.map((message) => message.toJSON())).toStrictEqual([
      { role: 'user', content: [{ text: 'first' }], trackingId: anyTrackingId }, // earlier user untouched
      { role: 'assistant', content: [{ text: 'a' }], trackingId: anyTrackingId },
      {
        role: 'user',
        content: [{ text: 'second' }, { text: '\n\nINJECTED' }],
        trackingId: anyTrackingId,
      },
    ])
  })

  it('preserves message metadata on the folded message', () => {
    const tagged = new Message({
      role: 'user',
      content: [new TextBlock('ask')],
      metadata: { custom: { keep: 'me' } },
    })
    const result = foldIntoLastUserMessage([tagged], 'INJECTED')
    expect(result.messages[0]!.metadata?.custom).toStrictEqual({ keep: 'me' })
  })

  it('returns the input unchanged when there is no user message', () => {
    const messages = [assistant('only assistant')]
    const result = foldIntoLastUserMessage(messages, 'INJECTED')
    expect(result.messages).toBe(messages)
    expect(result.appended).toBe(0)
  })

  it('reports no per-call trailing blocks when the fold target is not the last message', () => {
    // Counting an earlier message's blocks would make the provider count back through the wrong one.
    const result = foldIntoLastUserMessage([user('ask'), assistant('reply')], 'INJECTED')

    expect(result.messages[0]!.toJSON().content).toStrictEqual([{ text: 'ask' }, { text: '\n\nINJECTED' }])
    expect(result.appended).toBe(0)
  })

  it('omits the blank-line separator when the target message has no content', () => {
    const result = foldIntoLastUserMessage([new Message({ role: 'user', content: [] })], 'INJECTED')
    expect(result.messages[0]!.toJSON().content).toStrictEqual([{ text: 'INJECTED' }])
  })
})

describe('isUserTurn', () => {
  it('is true when the last message is a plain user ask', () => {
    expect(isUserTurn([assistant('prior').toJSON(), user('ask').toJSON()])).toBe(true)
  })

  it('is false when the last message is a user tool-result turn', () => {
    expect(isUserTurn([user('task').toJSON(), assistant('a').toJSON(), toolResult().toJSON()])).toBe(false)
  })

  it('is false when the last message is an assistant message', () => {
    expect(isUserTurn([user('ask').toJSON(), assistant('reply').toJSON()])).toBe(false)
  })

  it('is false for an empty conversation', () => {
    expect(isUserTurn([])).toBe(false)
  })
})

describe('resolveTrigger', () => {
  it('defaults (undefined) to the userTurn policy', () => {
    const trigger = resolveTrigger(undefined)
    expect(trigger(injectionCtx([user('ask').toJSON()]))).toBe(true)
    expect(trigger(injectionCtx([toolResult().toJSON()]))).toBe(false)
  })

  it("'userTurn' uses isUserTurn", () => {
    const trigger = resolveTrigger('userTurn')
    expect(trigger(injectionCtx([user('ask').toJSON()]))).toBe(true)
    expect(trigger(injectionCtx([toolResult().toJSON()]))).toBe(false)
  })

  it("'everyTurn' always fires", () => {
    const trigger = resolveTrigger('everyTurn')
    expect(trigger(injectionCtx([]))).toBe(true)
    expect(trigger(injectionCtx([toolResult().toJSON()]))).toBe(true)
  })

  it('uses a custom predicate over the context', () => {
    const trigger = resolveTrigger((context) => context.messages.length >= 2)
    expect(trigger(injectionCtx([user('a').toJSON()]))).toBe(false)
    expect(trigger(injectionCtx([user('a').toJSON(), assistant('b').toJSON()]))).toBe(true)
  })

  it('fails open (returns false, logs) when a custom predicate throws', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const trigger = resolveTrigger(() => {
      throw new Error('boom')
    })
    expect(trigger(injectionCtx([user('ask').toJSON()]))).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('createInjectionMiddleware', () => {
  // The handler is an InvokeModelStage.Input transformer. It reads `context.messages` and derives the
  // InjectionContext (appState/agent) from `context.agent`, then spreads the rest through, so a context
  // carrying `messages` plus a mock agent exercises it faithfully.
  const ctx = (messages: Message[]) => ({ messages, agent: createMockAgent() }) as unknown as InvokeModelContext

  it('folds renderContent() text into the latest user message, leaving other context fields intact', async () => {
    const handler = createInjectionMiddleware({ renderContent: async () => 'INJECTED' })
    const result = await handler(ctx([assistant('prior'), user('ask')]))

    expect(result.messages.map((m) => m.toJSON())).toStrictEqual([
      { role: 'assistant', content: [{ text: 'prior' }], trackingId: anyTrackingId },
      {
        role: 'user',
        content: [{ text: 'ask' }, { text: '\n\nINJECTED' }],
        trackingId: anyTrackingId,
      },
    ])
  })

  it('passes an InjectionContext carrying the conversation (as data) to renderContent', async () => {
    const seen: string[] = []
    const handler = createInjectionMiddleware({
      renderContent: async (context) => {
        seen.push(...context.messages.map((m) => m.role))
        return 'x'
      },
    })
    await handler(ctx([assistant('prior'), user('ask')]))

    expect(seen).toStrictEqual(['assistant', 'user'])
  })

  it('exposes appState and the agent on the InjectionContext', async () => {
    const appState = { get: () => 'stashed' }
    const agent = { appState } as unknown as InvokeModelContext['agent']
    const input = { messages: [user('ask')], agent } as unknown as InvokeModelContext
    let received: { appState: unknown; agent: unknown } | undefined
    const handler = createInjectionMiddleware({
      renderContent: async (context) => {
        received = { appState: context.appState, agent: context.agent }
        return undefined
      },
    })
    await handler(input)

    expect(received).toStrictEqual({ appState, agent })
  })

  it('returns the context unchanged when the trigger does not fire', async () => {
    const renderContent = vi.fn(async () => 'x')
    const handler = createInjectionMiddleware({ renderContent }) // default 'userTurn'
    const input = ctx([user('task'), assistant('a'), toolResult()])
    const result = await handler(input)

    expect(result).toBe(input)
    expect(renderContent).not.toHaveBeenCalled()
  })

  it("'everyTurn' injects on an autonomous tool-result turn, keeping the tool result first", async () => {
    const handler = createInjectionMiddleware({ trigger: 'everyTurn', renderContent: async () => 'INJECTED' })
    const tr = toolResult()
    const result = await handler(ctx([user('task'), assistant('a'), tr]))

    // The most recent user message on a tool-result turn carries the tool result, which must stay the
    // first block, so the injected text is appended after it.
    expect(result.messages.map((m) => m.toJSON())).toStrictEqual([
      { role: 'user', content: [{ text: 'task' }], trackingId: anyTrackingId },
      { role: 'assistant', content: [{ text: 'a' }], trackingId: anyTrackingId },
      {
        role: 'user',
        content: [tr.toJSON().content[0], { text: '\n\nINJECTED' }],
        trackingId: anyTrackingId,
      },
    ])
  })

  it('returns the context unchanged when renderContent yields empty text', async () => {
    const handler = createInjectionMiddleware({ renderContent: async () => '   ' })
    const input = ctx([assistant('prior'), user('ask')])
    const result = await handler(input)

    expect(result).toBe(input)
  })

  it('fails open (returns the context unchanged, logs) when renderContent throws', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const handler = createInjectionMiddleware({
      renderContent: async () => {
        throw new Error('boom')
      },
    })
    const input = ctx([assistant('prior'), user('ask')])
    const result = await handler(input)

    expect(result).toBe(input)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not mutate the original context messages', async () => {
    const handler = createInjectionMiddleware({ renderContent: async () => 'INJECTED' })
    const input = ctx([assistant('prior'), user('ask')])
    const before = input.messages[1]!
    await handler(input)

    expect(before.content).toHaveLength(1) // the original user message is untouched
  })

  describe('per-call trailing blocks reporting', () => {
    // The boundary a provider needs is reported on the context, not written into the messages.
    it('reports one trailing block as per-call', async () => {
      const handler = createInjectionMiddleware({ renderContent: async () => 'INJECTED' })
      const result = await handler(ctx([user('ask')]))

      expect(result.dynamicTrailingBlocks).toBe(1)
    })

    it('accumulates across producers on one call', async () => {
      const first = createInjectionMiddleware({ renderContent: async () => 'ONE' })
      const second = createInjectionMiddleware({ renderContent: async () => 'TWO' })

      const result = await second(await first(ctx([user('ask')])))

      expect(result.dynamicTrailingBlocks).toBe(2)
    })

    it('reports nothing when injection is skipped', async () => {
      const handler = createInjectionMiddleware({ renderContent: async () => '' })
      const result = await handler(ctx([user('ask')]))

      expect(result.dynamicTrailingBlocks ?? 0).toBe(0)
    })

    it('reports nothing when the fold target is not the last message', async () => {
      const handler = createInjectionMiddleware({ renderContent: async () => 'INJECTED', trigger: 'everyTurn' })
      const result = await handler(ctx([user('ask'), assistant('reply')]))

      expect(result.dynamicTrailingBlocks).toBe(0)
    })

    it('emits no cache point into the messages', async () => {
      // Most providers reject a cachePoint inside a message, so the framework never writes one.
      const handler = createInjectionMiddleware({ renderContent: async () => 'INJECTED' })
      const result = await handler(ctx([user('ask')]))

      const blocks = result.messages.flatMap((message) => (message as Message).content)
      expect(blocks.some((block) => block.type === 'cachePointBlock')).toBe(false)
    })
  })
})
