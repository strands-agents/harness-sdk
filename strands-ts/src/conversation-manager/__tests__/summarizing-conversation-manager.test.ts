import { describe, it, expect, vi } from 'vitest'
import { SummarizingConversationManager } from '../summarizing-conversation-manager.js'
import { ContextWindowOverflowError, Message, TextBlock, ToolUseBlock, ToolResultBlock } from '../../index.js'
import { AfterModelCallEvent, BeforeModelCallEvent } from '../../hooks/events.js'
import { createMockAgent, invokeTrackedHook } from '../../__fixtures__/agent-helpers.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createInvocation } from '../../agent/invocation.js'
import { Model as ModelBase } from '../../models/model.js'
import type { Model, BaseModelConfig } from '../../models/model.js'

function textMsg(role: 'user' | 'assistant', text: string): Message {
  return new Message({ role, content: [new TextBlock(text)] })
}

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => textMsg(i % 2 === 0 ? 'user' : 'assistant', `Message ${i + 1}`))
}

describe('SummarizingConversationManager', () => {
  describe('constructor', () => {
    it('clamps summaryRatio to [0.1, 0.8]', () => {
      expect((new SummarizingConversationManager({ summaryRatio: 0 }) as any)._summaryRatio).toBe(0.1)
      expect((new SummarizingConversationManager({ summaryRatio: 1.0 }) as any)._summaryRatio).toBe(0.8)
    })
  })

  describe('reduce', () => {
    it('summarizes oldest messages and replaces them with a user-role summary', async () => {
      const model = new MockMessageModel()
      model.addTurn({ type: 'textBlock', text: 'Summary of conversation' })

      const manager = new SummarizingConversationManager({
        summaryRatio: 0.5,
        preserveRecentMessages: 2,
      })
      const messages = makeMessages(20)
      const lastTwo = messages.slice(-2)
      const mockAgent = createMockAgent({ messages })

      const result = await manager.reduce({
        agent: mockAgent,
        model: model as unknown as Model,
        error: new ContextWindowOverflowError('overflow'),
      })

      expect(result).toBe(true)
      // 20 * 0.5 = 10 summarized → 1 summary + 10 remaining = 11
      expect(mockAgent.messages).toHaveLength(11)
      expect(mockAgent.messages[0]!.role).toBe('user')
      expect(mockAgent.messages[0]!.content[0]!).toEqual({
        type: 'textBlock',
        text: 'Summary of conversation',
      })
      // Recent messages preserved
      expect(mockAgent.messages.slice(-2)).toEqual(lastTwo)
    })

    it('assigns a durable tracking id to the generated summary message', async () => {
      const model = new MockMessageModel()
      model.addTurn({ type: 'textBlock', text: 'Summary of conversation' })

      const manager = new SummarizingConversationManager({ summaryRatio: 0.5, preserveRecentMessages: 2 })
      const mockAgent = createMockAgent({ messages: makeMessages(20) })

      await manager.reduce({
        agent: mockAgent,
        model: model as unknown as Model,
        error: new ContextWindowOverflowError('overflow'),
      })

      expect(typeof mockAgent.messages[0]!.trackingId).toBe('string')
      expect(mockAgent.messages[0]!.trackingId).toBeTruthy()
    })

    it('uses the config model over the reduce model when provided', async () => {
      const configModel = new MockMessageModel()
      configModel.addTurn({ type: 'textBlock', text: 'Config model summary' })
      const reduceModel = new MockMessageModel()
      reduceModel.addTurn({ type: 'textBlock', text: 'Reduce model summary' })

      const manager = new SummarizingConversationManager({
        model: configModel as unknown as Model,
        summaryRatio: 0.5,
        preserveRecentMessages: 2,
      })
      const messages = makeMessages(20)
      const mockAgent = createMockAgent({ messages })

      await manager.reduce({
        agent: mockAgent,
        model: reduceModel as unknown as Model,
        error: new ContextWindowOverflowError('overflow'),
      })

      expect(mockAgent.messages[0]!.content[0]!).toEqual({
        type: 'textBlock',
        text: 'Config model summary',
      })
    })

    it('uses the config model when no reduce model is provided', async () => {
      const configModel = new MockMessageModel()
      configModel.addTurn({ type: 'textBlock', text: 'Config model summary' })

      const manager = new SummarizingConversationManager({
        model: configModel as unknown as Model,
        summaryRatio: 0.5,
        preserveRecentMessages: 2,
      })
      const messages = makeMessages(20)
      const mockAgent = createMockAgent({ messages })

      const result = await manager.reduce({
        agent: mockAgent,
        model: {} as Model,
        error: new ContextWindowOverflowError('overflow'),
      })

      expect(result).toBe(true)
      expect(mockAgent.messages[0]!.content[0]!).toEqual({
        type: 'textBlock',
        text: 'Config model summary',
      })
    })

    it('returns false when there are not enough messages to summarize', async () => {
      const model = new MockMessageModel()
      const manager = new SummarizingConversationManager({
        preserveRecentMessages: 10,
      })
      const messages = makeMessages(8)
      const mockAgent = createMockAgent({ messages })

      const result = await manager.reduce({
        agent: mockAgent,
        model: model as unknown as Model,
        error: new ContextWindowOverflowError('overflow'),
      })

      expect(result).toBe(false)
      expect(mockAgent.messages).toHaveLength(8)
    })

    it('rethrows model errors with the overflow error as cause', async () => {
      const model = new MockMessageModel()
      model.addTurn(new Error('model failed'))

      const manager = new SummarizingConversationManager({
        summaryRatio: 0.5,
        preserveRecentMessages: 2,
      })
      const overflowError = new ContextWindowOverflowError('overflow')
      const mockAgent = createMockAgent({ messages: makeMessages(20) })

      const thrown = await manager
        .reduce({ agent: mockAgent, model: model as unknown as Model, error: overflowError })
        .catch((e: unknown) => e)
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toBe('model failed')
      expect((thrown as Error).cause).toBe(overflowError)
    })

    it('wraps non-Error throw values with the overflow error as cause', async () => {
      const model = new MockMessageModel()
      const err = 'string error'
      vi.spyOn(model, 'streamAggregated').mockImplementation(async function* () {
        yield undefined as any
        throw err
      } as any)

      const manager = new SummarizingConversationManager({
        summaryRatio: 0.5,
        preserveRecentMessages: 2,
      })
      const overflowError = new ContextWindowOverflowError('overflow')
      const mockAgent = createMockAgent({ messages: makeMessages(20) })

      const thrown = await manager
        .reduce({ agent: mockAgent, model: model as unknown as Model, error: overflowError })
        .catch((e: unknown) => e)
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toBe('string error')
      expect((thrown as Error).cause).toBe(overflowError)
    })

    it('passes the correct message slice and system prompt to the model', async () => {
      const model = new MockMessageModel()
      model.addTurn({ type: 'textBlock', text: 'Summary' })
      const streamSpy = vi.spyOn(model, 'stream')

      const customPrompt = 'Custom summarization prompt'
      const manager = new SummarizingConversationManager({
        summaryRatio: 0.5,
        preserveRecentMessages: 2,
        summarizationSystemPrompt: customPrompt,
      })
      const messages = makeMessages(10)
      const expectedSlice = messages.slice(0, 5)
      const mockAgent = createMockAgent({ messages })

      await manager.reduce({
        agent: mockAgent,
        model: model as unknown as Model,
        error: new ContextWindowOverflowError('overflow'),
      })

      expect(streamSpy).toHaveBeenCalledOnce()
      const [calledMessages, calledOptions] = streamSpy.mock.calls[0]!
      // First 5 messages (10 * 0.5) plus the "Please summarize" request
      expect(calledMessages).toHaveLength(6)
      expect(calledMessages!.slice(0, 5)).toEqual(expectedSlice)
      expect(calledMessages![5]!.role).toBe('user')
      expect(calledMessages![5]!.content[0]!).toEqual(
        expect.objectContaining({ text: 'Please summarize this conversation.' })
      )
      expect(calledOptions).toEqual(expect.objectContaining({ systemPrompt: customPrompt }))
    })

    it('preserveRecentMessages dominates when larger than ratio allows', async () => {
      const model = new MockMessageModel()
      model.addTurn({ type: 'textBlock', text: 'Summary' })

      const manager = new SummarizingConversationManager({
        summaryRatio: 0.8,
        preserveRecentMessages: 18,
      })
      const messages = makeMessages(20)
      const mockAgent = createMockAgent({ messages })

      const result = await manager.reduce({
        agent: mockAgent,
        model: model as unknown as Model,
        error: new ContextWindowOverflowError('overflow'),
      })

      expect(result).toBe(true)
      // 20 * 0.8 = 16, but min(16, 20-18) = 2, so only 2 summarized
      // 1 summary + 18 remaining = 19
      expect(mockAgent.messages).toHaveLength(19)
    })
  })

  describe('request limits', () => {
    it('adds the summarization usage to the request total even when the request limit is used up', async () => {
      const model = new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'Summary of conversation' },
        { usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 } }
      )
      const manager = new SummarizingConversationManager({ summaryRatio: 0.5, preserveRecentMessages: 2 })
      const mockAgent = createMockAgent({ messages: makeMessages(20) })
      const invocation = createInvocation({ turns: 1 })
      invocation.turns = 5

      const result = await manager.reduce({
        agent: mockAgent,
        model: model as unknown as Model,
        error: new ContextWindowOverflowError('overflow'),
        invocation,
      })

      expect(result).toBe(true)
      expect(mockAgent.messages[0]!.content).toEqual([{ type: 'textBlock', text: 'Summary of conversation' }])
      expect(invocation.usage).toEqual({ inputTokens: 4, outputTokens: 5, totalTokens: 9 })
      expect(invocation.turns).toBe(5)
    })
  })

  describe('tool pair adjustment', () => {
    it('advances split point past orphaned toolResult and toolUse boundaries', async () => {
      const model = new MockMessageModel()
      model.addTurn({ type: 'textBlock', text: 'Summary' })

      const manager = new SummarizingConversationManager({
        summaryRatio: 0.3,
        preserveRecentMessages: 2,
      })

      // Natural split at ~index 3 lands on a toolResult
      const messages = [
        textMsg('user', 'Message 1'),
        textMsg('assistant', 'Message 2'),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ name: 'tool1', toolUseId: 'id-1', input: {} })],
        }),
        new Message({
          role: 'user',
          content: [new ToolResultBlock({ toolUseId: 'id-1', status: 'success', content: [new TextBlock('Result')] })],
        }),
        textMsg('assistant', 'Response after tool'),
        ...makeMessages(8),
      ]
      const mockAgent = createMockAgent({ messages })

      const result = await manager.reduce({
        agent: mockAgent,
        model: model as unknown as Model,
        error: new ContextWindowOverflowError('overflow'),
      })

      expect(result).toBe(true)
      // After summary insertion, no remaining message should start with an orphaned toolResult
      expect(mockAgent.messages[1]!.content.some((b) => b.type === 'toolResultBlock')).toBe(false)
    })

    it('throws when no valid split point exists', async () => {
      const model = new MockMessageModel()
      const manager = new SummarizingConversationManager({
        summaryRatio: 0.5,
        preserveRecentMessages: 0,
      })

      // All messages are toolResults
      const messages = Array.from(
        { length: 4 },
        (_, i) =>
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({ toolUseId: `id-${i}`, status: 'success', content: [new TextBlock(`R${i}`)] }),
            ],
          })
      )
      const mockAgent = createMockAgent({ messages })

      await expect(
        manager.reduce({
          agent: mockAgent,
          model: model as unknown as Model,
          error: new ContextWindowOverflowError('overflow'),
        })
      ).rejects.toThrow('Unable to find valid split point for summarization')
    })
  })

  describe('base class hook integration', () => {
    // Two agents: pluginAgent receives the hook registration via initAgent(),
    // while agent holds the messages and is carried on the event object.
    it('async reduce sets retry=true through the base class await', async () => {
      const model = new MockMessageModel()
      model.addTurn({ type: 'textBlock', text: 'Summary' })

      const manager = new SummarizingConversationManager({
        summaryRatio: 0.5,
        preserveRecentMessages: 2,
      })
      const messages = makeMessages(20)
      const agent = createMockAgent({ messages })

      const pluginAgent = createMockAgent()
      manager.initAgent(pluginAgent)
      const event = new AfterModelCallEvent({
        agent,
        model: model as unknown as Model,
        attemptCount: 1,
        error: new ContextWindowOverflowError('overflow'),
        invocationState: {},
      })
      await invokeTrackedHook(pluginAgent, event)

      expect(event.retry).toBe(true)
      expect(agent.messages).toHaveLength(11)
    })
  })

  describe('reduceOnThreshold', () => {
    it('summarizes oldest messages when compressionThreshold is exceeded', async () => {
      const model = new MockMessageModel()
      model.addTurn({ type: 'textBlock', text: 'Summary of conversation' })

      const manager = new SummarizingConversationManager({
        model: model as unknown as Model,
        summaryRatio: 0.5,
        preserveRecentMessages: 2,
        proactiveCompression: { compressionThreshold: 0.7 },
      })
      const messages = makeMessages(20)
      const mockAgent = createMockAgent({ messages })
      const mockModel = {
        getConfig: () => ({ contextWindowLimit: 1000 }) as BaseModelConfig,
        estimateUtilization: ModelBase.prototype.estimateUtilization,
      } as any

      manager.initAgent(mockAgent)

      const event = new BeforeModelCallEvent({
        agent: mockAgent,
        model: mockModel,
        invocationState: {},
        projectedInputTokens: 800,
      })
      await invokeTrackedHook(mockAgent, event)

      // 20 * 0.5 = 10 summarized → 1 summary + 10 remaining = 11
      expect(mockAgent.messages).toHaveLength(11)
      expect(mockAgent.messages[0]!.role).toBe('user')
      expect(mockAgent.messages[0]!.content[0]!).toEqual({
        type: 'textBlock',
        text: 'Summary of conversation',
      })
    })

    it('does not summarize when below compressionThreshold', async () => {
      const model = new MockMessageModel()
      model.addTurn({ type: 'textBlock', text: 'Summary' })

      const manager = new SummarizingConversationManager({
        model: model as unknown as Model,
        proactiveCompression: { compressionThreshold: 0.7 },
      })
      const messages = makeMessages(20)
      const mockAgent = createMockAgent({ messages })
      const mockModel = {
        getConfig: () => ({ contextWindowLimit: 1000 }) as BaseModelConfig,
        estimateUtilization: ModelBase.prototype.estimateUtilization,
      } as any

      manager.initAgent(mockAgent)

      const event = new BeforeModelCallEvent({
        agent: mockAgent,
        model: mockModel,
        invocationState: {},
        projectedInputTokens: 500,
      })
      await invokeTrackedHook(mockAgent, event)

      expect(mockAgent.messages).toHaveLength(20)
    })

    it('returns false and does not throw when summarization fails', async () => {
      const model = new MockMessageModel()
      model.addTurn(new Error('model failed'))

      const manager = new SummarizingConversationManager({
        model: model as unknown as Model,
        summaryRatio: 0.5,
        preserveRecentMessages: 2,
        proactiveCompression: { compressionThreshold: 0.7 },
      })
      const messages = makeMessages(20)
      const mockAgent = createMockAgent({ messages })
      const mockModel = {
        getConfig: () => ({ contextWindowLimit: 1000 }) as BaseModelConfig,
        estimateUtilization: ModelBase.prototype.estimateUtilization,
      } as any

      manager.initAgent(mockAgent)

      const event = new BeforeModelCallEvent({
        agent: mockAgent,
        model: mockModel,
        invocationState: {},
        projectedInputTokens: 800,
      })

      // Should not throw — reduceOnThreshold is best-effort
      await invokeTrackedHook(mockAgent, event)
      expect(mockAgent.messages).toHaveLength(20)
    })
  })

  describe('pinFirst', () => {
    it('protects first N messages from summarization', async () => {
      const model = new MockMessageModel()
      model.addTurn({ type: 'textBlock', text: 'Summary' })

      const manager = new SummarizingConversationManager({
        summaryRatio: 0.5,
        preserveRecentMessages: 2,
        pinFirst: 2,
      })

      const agent = createMockAgent({
        messages: [
          textMsg('user', 'protected-1'),
          textMsg('assistant', 'protected-2'),
          textMsg('user', 'summarize-me'),
          textMsg('assistant', 'summarize-me-too'),
          textMsg('user', 'recent-1'),
          textMsg('assistant', 'recent-2'),
        ],
      })

      await manager.reduce({ agent, model: model as unknown as Model })

      const texts = agent.messages.map((m) => (m.content[0] as TextBlock).text)
      expect(texts).toEqual(['protected-1', 'protected-2', 'Summary', 'summarize-me-too', 'recent-1', 'recent-2'])
    })

    it('returns false when all messages in summary range are protected', async () => {
      const model = new MockMessageModel()
      model.addTurn({ type: 'textBlock', text: 'Summary' })

      const manager = new SummarizingConversationManager({
        summaryRatio: 0.3,
        preserveRecentMessages: 2,
        pinFirst: 10,
      })

      const agent = createMockAgent({ messages: makeMessages(6) })
      const result = await manager.reduce({ agent, model: model as unknown as Model })
      expect(result).toBe(false)
    })

    it('pinned message in middle survives summarization', async () => {
      const { pinMessage } = await import('../compression/pin-message.js')
      const model = new MockMessageModel()
      model.addTurn({ type: 'textBlock', text: 'Summary' })

      const manager = new SummarizingConversationManager({
        summaryRatio: 0.5,
        preserveRecentMessages: 2,
      })

      const messages = [
        textMsg('user', 'old-1'),
        textMsg('assistant', 'pinned-middle'),
        textMsg('user', 'old-3'),
        textMsg('assistant', 'old-4'),
        textMsg('user', 'recent-1'),
        textMsg('assistant', 'recent-2'),
      ]
      pinMessage(messages, 1)
      const agent = createMockAgent({ messages })

      await manager.reduce({ agent, model: model as unknown as Model })

      const texts = agent.messages.map((m) => (m.content[0] as TextBlock).text)
      expect(texts).toEqual(['pinned-middle', 'Summary', 'old-4', 'recent-1', 'recent-2'])
    })
  })
})
