import { describe, it, expect, vi } from 'vitest'
import { createTokenUsageMiddleware } from '../../context-manager/modes/agentic/agentic-context.js'
import { Message, TextBlock } from '../../types/messages.js'
import type { InvokeModelContext } from '../../middleware/stages.js'
import type { Model } from '../../models/model.js'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'

function createMockModel(contextWindowLimit?: number): Model {
  return {
    getConfig: () => ({ contextWindowLimit }),
  } as unknown as Model
}

function createContext(overrides: Partial<InvokeModelContext> = {}): InvokeModelContext {
  return {
    agent: {} as InvokeModelContext['agent'],
    model: createMockModel(200_000),
    messages: [new Message({ role: 'user', content: [new TextBlock('hello')] })],
    toolSpecs: [],
    invocationState: {},
    ...overrides,
  }
}

describe('createTokenUsageMiddleware', () => {
  it('returns context unchanged when projectedInputTokens is not set', async () => {
    const middleware = createTokenUsageMiddleware()
    const context = createContext()

    const result = await middleware(context)

    expect(result).toBe(context)
  })

  it('returns context unchanged when messages are empty', async () => {
    const middleware = createTokenUsageMiddleware()
    const context = createContext({
      messages: [],
      projectedInputTokens: 50_000,
    })

    const result = await middleware(context)

    expect(result).toBe(context)
  })

  it('appends context status to last message content', async () => {
    const middleware = createTokenUsageMiddleware()
    const context = createContext({
      projectedInputTokens: 50_000,
    })

    const result = await middleware(context)

    expect(result.messages.length).toBe(1)
    const lastMsg = result.messages[0]!
    expect(lastMsg.content.length).toBe(2)
    const statusBlock = lastMsg.content[1] as TextBlock
    expect(statusBlock.text).toContain('<context-status>')
    expect(statusBlock.text).toContain('25.0%')
    expect(statusBlock.text).toContain('<remaining>')
    expect(statusBlock.text).toContain('</context-status>')
  })

  it('uses the effective context model limit', async () => {
    const middleware = createTokenUsageMiddleware()
    const context = createContext({
      model: createMockModel(10_000),
      projectedInputTokens: 8_000,
    })

    const result = await middleware(context)

    const statusBlock = result.messages[0]!.content[1] as TextBlock
    expect(statusBlock.text).toContain('8,000 / 10,000 tokens (80.0%)')
    expect(statusBlock.text).toContain('<remaining>~2,000 tokens</remaining>')
  })

  it('reports the status line as one per-call block', async () => {
    // The live token count makes this per-call, so a cache point must stay ahead of it.
    const middleware = createTokenUsageMiddleware()
    const context = createContext({ projectedInputTokens: 50_000 })

    const result = await middleware(context)

    expect(result.dynamicTrailingBlocks).toBe(1)
  })

  it('reports no per-call trailing blocks when the status line lands in an assistant message', async () => {
    // The status text lands in whatever message is last. On an assistant-terminated history it is
    // already outside the cached prefix, so reporting it would evict durable content. Reachable via invoke()
    // with no prompt, and restored sessions.
    const middleware = createTokenUsageMiddleware()
    const context = createContext({
      messages: [
        new Message({ role: 'user', content: [new TextBlock('durable ask')] }),
        new Message({ role: 'assistant', content: [new TextBlock('reply')] }),
      ],
      projectedInputTokens: 50_000,
    })

    const result = await middleware(context)

    const lastMessage = result.messages[result.messages.length - 1]!
    expect(lastMessage.role).toBe('assistant')
    expect((lastMessage.content[lastMessage.content.length - 1] as TextBlock).text).toContain('<context-status>')
    expect(result.dynamicTrailingBlocks ?? 0).toBe(0)
  })

  it('reports no per-call trailing blocks when no status line is appended', async () => {
    const middleware = createTokenUsageMiddleware()
    const context = createContext()

    const result = await middleware(context)

    expect(result.dynamicTrailingBlocks ?? 0).toBe(0)
  })

  it('does not mutate the original messages array', async () => {
    const middleware = createTokenUsageMiddleware()
    const originalMessage = new Message({ role: 'user', content: [new TextBlock('hello')] })
    const context = createContext({
      messages: [originalMessage],
      projectedInputTokens: 50_000,
    })

    const result = await middleware(context)

    expect(result.messages).not.toBe(context.messages)
    expect(originalMessage.content.length).toBe(1)
  })

  it('uses DEFAULT_CONTEXT_WINDOW_LIMIT when model config has no limit', async () => {
    const middleware = createTokenUsageMiddleware()
    const context = createContext({
      model: createMockModel(undefined),
      projectedInputTokens: 100_000,
    })

    const result = await middleware(context)

    const statusBlock = (result.messages[0]! as Message).content[1] as TextBlock
    expect(statusBlock.text).toContain('<context-status>')
    expect(statusBlock.text).toContain('50.0%')
    expect(statusBlock.text).toContain('200,000')
  })

  it('preserves message metadata', async () => {
    const middleware = createTokenUsageMiddleware()
    const metadata = { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
    const context = createContext({
      messages: [new Message({ role: 'user', content: [new TextBlock('hello')], metadata })],
      projectedInputTokens: 50_000,
    })

    const result = await middleware(context)

    expect(result.messages[0]!.metadata).toEqual(metadata)
  })

  it('reports correct remaining tokens', async () => {
    const middleware = createTokenUsageMiddleware()
    const context = createContext({
      model: createMockModel(100_000),
      projectedInputTokens: 80_000,
    })

    const result = await middleware(context)

    const statusBlock = (result.messages[0]! as Message).content[1] as TextBlock
    expect(statusBlock.text).toContain('80.0%')
    expect(statusBlock.text).toContain('<remaining>~20,000 tokens</remaining>')
  })
})

describe('token usage middleware integration', () => {
  it('injects context status into messages sent to model on second call', async () => {
    const model = new MockMessageModel()
      .addTurn(
        { type: 'textBlock', text: 'First response' },
        { usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } }
      )
      .addTurn(
        { type: 'textBlock', text: 'Second response' },
        { usage: { inputTokens: 2000, outputTokens: 300, totalTokens: 2300 } }
      )

    model.updateConfig({ contextWindowLimit: 100_000 })

    const agent = new Agent({ model, contextManager: 'agentic', printer: false })
    const streamSpy = vi.spyOn(model, 'stream')

    await agent.invoke('First message')
    await agent.invoke('Second message')

    const secondCallMessages = streamSpy.mock.calls[1]![0] as Message[]
    const lastMessage = secondCallMessages[secondCallMessages.length - 1]!
    const lastBlock = lastMessage.content[lastMessage.content.length - 1] as TextBlock
    expect(lastBlock.text).toContain('<context-status>')
    expect(lastBlock.text).toContain('100,000')
    expect(lastBlock.text).toContain('<remaining>')
  })

  it('injects on first call when token estimation succeeds', async () => {
    const model = new MockMessageModel().addTurn(
      { type: 'textBlock', text: 'First response' },
      { usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } }
    )

    model.updateConfig({ contextWindowLimit: 100_000 })

    const agent = new Agent({ model, contextManager: 'agentic', printer: false })
    const streamSpy = vi.spyOn(model, 'stream')

    await agent.invoke('First message')

    const firstCallMessages = streamSpy.mock.calls[0]![0] as Message[]
    const lastMessage = firstCallMessages[firstCallMessages.length - 1]!
    const lastBlock = lastMessage.content[lastMessage.content.length - 1] as TextBlock
    expect(lastBlock.text).toContain('<context-status>')
    expect(lastBlock.text).toContain('100,000')
  })

  it('does not register middleware when contextManager is not agentic', async () => {
    const model = new MockMessageModel()
      .addTurn(
        { type: 'textBlock', text: 'First response' },
        { usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } }
      )
      .addTurn(
        { type: 'textBlock', text: 'Second response' },
        { usage: { inputTokens: 2000, outputTokens: 300, totalTokens: 2300 } }
      )

    model.updateConfig({ contextWindowLimit: 100_000 })

    const agent = new Agent({ model, printer: false })
    const streamSpy = vi.spyOn(model, 'stream')

    await agent.invoke('First message')
    await agent.invoke('Second message')

    const secondCallMessages = streamSpy.mock.calls[1]![0] as Message[]
    const lastMessage = secondCallMessages[secondCallMessages.length - 1]!
    const lastBlock = lastMessage.content[lastMessage.content.length - 1] as TextBlock
    expect(lastBlock.text).not.toContain('<context-status>')
  })
})
