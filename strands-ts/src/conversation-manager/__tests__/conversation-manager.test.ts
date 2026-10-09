import { describe, it, expect, vi } from 'vitest'
import {
  ConversationManager,
  type ConversationManagerReduceOptions,
  type ConversationManagerOptions,
} from '../conversation-manager.js'
import { NullConversationManager } from '../null-conversation-manager.js'
import { Agent } from '../../agent/agent.js'
import { Message, TextBlock } from '../../index.js'
import { AfterModelCallEvent, BeforeModelCallEvent } from '../../hooks/events.js'
import { ContextWindowOverflowError } from '../../errors.js'
import { createMockAgent, invokeTrackedHook } from '../../__fixtures__/agent-helpers.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import type { BaseModelConfig } from '../../models/model.js'
import { Model } from '../../models/model.js'
import { warnOnce } from '../../logging/warn-once.js'

vi.mock('../../logging/warn-once.js', () => ({
  warnOnce: vi.fn(),
}))

class TestConversationManager extends ConversationManager {
  readonly name = 'test:conversation-manager'
  reduceCallCount = 0
  shouldReduce = true

  constructor(options?: ConversationManagerOptions) {
    super(options)
  }

  reduce({ agent }: ConversationManagerReduceOptions): boolean {
    this.reduceCallCount++
    if (!this.shouldReduce) return false
    agent.messages.splice(0, 1)
    return true
  }
}

class ThresholdTestManager extends ConversationManager {
  readonly name = 'test:threshold-manager'
  reduceCallCount = 0
  shouldReduce = true

  constructor(options?: ConversationManagerOptions) {
    super(options)
  }

  reduce({ agent }: ConversationManagerReduceOptions): boolean {
    this.reduceCallCount++
    if (!this.shouldReduce) return false
    agent.messages.splice(0, 1)
    return true
  }
}

describe('ConversationManager', () => {
  describe('initAgent', () => {
    it('registers both AfterModelCallEvent and BeforeModelCallEvent hooks', () => {
      const manager = new TestConversationManager()
      const mockAgent = createMockAgent()
      manager.initAgent(mockAgent)

      // Always registers both hooks now
      expect(mockAgent.trackedHooks).toHaveLength(2)
      expect(mockAgent.trackedHooks[0]!.eventType).toBe(AfterModelCallEvent)
      expect(mockAgent.trackedHooks[1]!.eventType).toBe(BeforeModelCallEvent)
    })

    it('calls reduce and sets retry=true on ContextWindowOverflowError when reduce returns true', async () => {
      const manager = new TestConversationManager()
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('Message 1')] }),
        new Message({ role: 'assistant', content: [new TextBlock('Response 1')] }),
      ]
      const mockAgent = createMockAgent({ messages })
      manager.initAgent(mockAgent)

      const error = new ContextWindowOverflowError('overflow')
      const event = new AfterModelCallEvent({
        agent: mockAgent,
        model: {} as any,
        attemptCount: 1,
        error,
        invocationState: {},
      })
      await invokeTrackedHook(mockAgent, event)

      expect(manager.reduceCallCount).toBe(1)
      expect(event.retry).toBe(true)
      expect(mockAgent.messages).toHaveLength(1)
    })

    it('does not set retry when reduce returns false', async () => {
      const manager = new TestConversationManager()
      manager.shouldReduce = false
      const mockAgent = createMockAgent()
      manager.initAgent(mockAgent)

      const error = new ContextWindowOverflowError('overflow')
      const event = new AfterModelCallEvent({
        agent: mockAgent,
        model: {} as any,
        attemptCount: 1,
        error,
        invocationState: {},
      })
      await invokeTrackedHook(mockAgent, event)

      expect(manager.reduceCallCount).toBe(1)
      expect(event.retry).toBeUndefined()
    })

    it('does not call reduce for non-overflow errors', async () => {
      const manager = new TestConversationManager()
      const mockAgent = createMockAgent()
      manager.initAgent(mockAgent)

      const error = new Error('some other error')
      const event = new AfterModelCallEvent({
        agent: mockAgent,
        model: {} as any,
        attemptCount: 1,
        error,
        invocationState: {},
      })
      await invokeTrackedHook(mockAgent, event)

      expect(manager.reduceCallCount).toBe(0)
      expect(event.retry).toBeUndefined()
    })

    it('passes error to reduce when called due to overflow', async () => {
      const receivedArgs: ConversationManagerReduceOptions[] = []
      class CapturingManager extends ConversationManager {
        readonly name = 'test:capturing'
        reduce(args: ConversationManagerReduceOptions): boolean {
          receivedArgs.push(args)
          return false
        }
      }

      const manager = new CapturingManager()
      const mockAgent = createMockAgent()
      manager.initAgent(mockAgent)

      const error = new ContextWindowOverflowError('overflow')
      const event = new AfterModelCallEvent({
        agent: mockAgent,
        model: {} as any,
        attemptCount: 1,
        error,
        invocationState: {},
      })
      await invokeTrackedHook(mockAgent, event)

      expect(receivedArgs).toHaveLength(1)
      expect(receivedArgs[0]!.error).toBe(error)
      expect(receivedArgs[0]!.agent).toBe(mockAgent)
      expect(receivedArgs[0]!.model).toBe(event.model)
    })
  })

  describe('proactiveCompression', () => {
    const mockModel = {
      getConfig: () => ({ contextWindowLimit: 1000 }) as BaseModelConfig,
      estimateUtilization: Model.prototype.estimateUtilization,
    } as any

    it('always registers a BeforeModelCallEvent hook regardless of proactiveCompression setting', () => {
      const manager = new TestConversationManager()
      const mockAgent = createMockAgent()
      manager.initAgent(mockAgent)

      // Both hooks always registered
      expect(mockAgent.trackedHooks).toHaveLength(2)
      expect(mockAgent.trackedHooks[0]!.eventType).toBe(AfterModelCallEvent)
      expect(mockAgent.trackedHooks[1]!.eventType).toBe(BeforeModelCallEvent)
    })

    it('BeforeModelCallEvent handler is a no-op when proactiveCompression is not set', async () => {
      const manager = new ThresholdTestManager()
      const mockAgent = createMockAgent()
      manager.initAgent(mockAgent)

      const event = new BeforeModelCallEvent({
        agent: mockAgent,
        model: mockModel,
        invocationState: {},
        projectedInputTokens: 900, // Would exceed any threshold
      })
      await invokeTrackedHook(mockAgent, event)

      expect(manager.reduceCallCount).toBe(0)
    })

    it('uses default threshold of 0.7 when proactiveCompression is true', async () => {
      const manager = new ThresholdTestManager({ proactiveCompression: true })
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('Message 1')] }),
        new Message({ role: 'assistant', content: [new TextBlock('Response 1')] }),
      ]
      const mockAgent = createMockAgent({ messages })
      manager.initAgent(mockAgent)

      // 650/1000 = 0.65 < 0.7 — should NOT trigger
      const event = new BeforeModelCallEvent({
        agent: mockAgent,
        model: mockModel,
        invocationState: {},
        projectedInputTokens: 650,
      })
      await invokeTrackedHook(mockAgent, event)
      expect(manager.reduceCallCount).toBe(0)

      // 800/1000 = 0.8 >= 0.7 — should trigger
      const event2 = new BeforeModelCallEvent({
        agent: mockAgent,
        model: mockModel,
        invocationState: {},
        projectedInputTokens: 800,
      })
      await invokeTrackedHook(mockAgent, event2)
      expect(manager.reduceCallCount).toBe(1)
    })

    it('calls reduce without error when projected tokens exceed custom threshold', async () => {
      const receivedArgs: ConversationManagerReduceOptions[] = []
      class CapturingManager extends ConversationManager {
        readonly name = 'test:capturing-threshold'
        reduce(args: ConversationManagerReduceOptions): boolean {
          receivedArgs.push(args)
          args.agent.messages.splice(0, 1)
          return true
        }
      }

      const manager = new CapturingManager({ proactiveCompression: { compressionThreshold: 0.5 } })
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('Message 1')] }),
        new Message({ role: 'assistant', content: [new TextBlock('Response 1')] }),
      ]
      const mockAgent = createMockAgent({ messages })
      manager.initAgent(mockAgent)

      const event = new BeforeModelCallEvent({
        agent: mockAgent,
        model: mockModel,
        invocationState: {},
        projectedInputTokens: 600, // 600/1000 = 0.6 >= 0.5
      })
      await invokeTrackedHook(mockAgent, event)

      expect(receivedArgs).toHaveLength(1)
      expect(receivedArgs[0]!.error).toBeUndefined()
      expect(receivedArgs[0]!.model).toBe(mockModel)
      expect(receivedArgs[0]!.agent).toBe(mockAgent)
    })

    it('does not call reduce when below threshold', async () => {
      const manager = new ThresholdTestManager({ proactiveCompression: { compressionThreshold: 0.7 } })
      const mockAgent = createMockAgent()
      manager.initAgent(mockAgent)

      const event = new BeforeModelCallEvent({
        agent: mockAgent,
        model: mockModel,
        invocationState: {},
        projectedInputTokens: 500, // 500/1000 = 0.5 < 0.7
      })
      await invokeTrackedHook(mockAgent, event)

      expect(manager.reduceCallCount).toBe(0)
    })

    it('does not call reduce when projectedInputTokens is undefined', async () => {
      const manager = new ThresholdTestManager({ proactiveCompression: true })
      const mockAgent = createMockAgent()
      manager.initAgent(mockAgent)

      const event = new BeforeModelCallEvent({
        agent: mockAgent,
        model: mockModel,
        invocationState: {},
      })
      await invokeTrackedHook(mockAgent, event)

      expect(manager.reduceCallCount).toBe(0)
    })

    it('uses 200k default when contextWindowLimit is undefined and logs warning', async () => {
      const manager = new ThresholdTestManager({ proactiveCompression: { compressionThreshold: 0.7 } })
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('Message 1')] }),
        new Message({ role: 'assistant', content: [new TextBlock('Response 1')] }),
      ]
      const mockAgent = createMockAgent({ messages })
      manager.initAgent(mockAgent)

      const modelWithoutLimit = {
        getConfig: () => ({}) as BaseModelConfig,
        estimateUtilization: Model.prototype.estimateUtilization,
      } as any
      // 150000/200000 = 0.75 >= 0.7 — should trigger with the 200k default
      const event = new BeforeModelCallEvent({
        agent: mockAgent,
        model: modelWithoutLimit,
        invocationState: {},
        projectedInputTokens: 150000,
      })
      await invokeTrackedHook(mockAgent, event)

      expect(manager.reduceCallCount).toBe(1)
      expect(warnOnce).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('contextWindowLimit is not set on the model, using default of 200000')
      )
    })

    it('does not trigger with 200k default when below threshold', async () => {
      const manager = new ThresholdTestManager({ proactiveCompression: { compressionThreshold: 0.7 } })
      const mockAgent = createMockAgent()
      manager.initAgent(mockAgent)

      const modelWithoutLimit = {
        getConfig: () => ({}) as BaseModelConfig,
        estimateUtilization: Model.prototype.estimateUtilization,
      } as any
      // 100000/200000 = 0.5 < 0.7 — should NOT trigger
      const event = new BeforeModelCallEvent({
        agent: mockAgent,
        model: modelWithoutLimit,
        invocationState: {},
        projectedInputTokens: 100000,
      })
      await invokeTrackedHook(mockAgent, event)

      expect(manager.reduceCallCount).toBe(0)
    })

    it('swallows errors from proactive reduce and continues', async () => {
      class ThrowingManager extends ConversationManager {
        readonly name = 'test:throwing'
        reduce({ error }: ConversationManagerReduceOptions): boolean {
          if (!error) {
            throw new Error('proactive compression exploded')
          }
          return false
        }
      }

      const manager = new ThrowingManager({ proactiveCompression: true })
      const mockAgent = createMockAgent()
      manager.initAgent(mockAgent)

      const event = new BeforeModelCallEvent({
        agent: mockAgent,
        model: mockModel,
        invocationState: {},
        projectedInputTokens: 800,
      })

      // Should not throw — error is swallowed
      await expect(invokeTrackedHook(mockAgent, event)).resolves.toBeUndefined()
    })

    it('throws on compressionThreshold <= 0', () => {
      expect(() => new ThresholdTestManager({ proactiveCompression: { compressionThreshold: 0 } })).toThrow(
        'must be between 0 (exclusive) and 1 (inclusive)'
      )
      expect(() => new ThresholdTestManager({ proactiveCompression: { compressionThreshold: -1 } })).toThrow(
        'must be between 0 (exclusive) and 1 (inclusive)'
      )
    })

    it('throws on compressionThreshold > 1', () => {
      expect(() => new ThresholdTestManager({ proactiveCompression: { compressionThreshold: 1.5 } })).toThrow(
        'must be between 0 (exclusive) and 1 (inclusive)'
      )
    })

    it('accepts compressionThreshold of exactly 1', () => {
      expect(() => new ThresholdTestManager({ proactiveCompression: { compressionThreshold: 1 } })).not.toThrow()
    })
  })
})

describe('overflow propagation', () => {
  it('propagates ContextWindowOverflowError out of the agent loop when reduce returns false', async () => {
    const model = new MockMessageModel()
    model.addTurn(new ContextWindowOverflowError('context window exceeded'))

    const agent = new Agent({
      model,
      conversationManager: new NullConversationManager(),
      printer: false,
    })

    await expect(agent.invoke('hello')).rejects.toThrow(ContextWindowOverflowError)
  })
})
