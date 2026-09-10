import { describe, it, expect } from 'vitest'
import { ContextManager } from '../context-manager.js'
import { createMockAgent, invokeTrackedHook } from '../../__fixtures__/agent-helpers.js'
import { AfterModelCallEvent, BeforeModelCallEvent } from '../../hooks/events.js'
import { ContextWindowOverflowError } from '../../errors.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../types/messages.js'
import type { Agent } from '../../agent/agent.js'

function makeMockAgent(overrides?: {
  id?: string
  messages?: Message[]
  countTokens?: (msgs: Message[]) => Promise<number>
  estimateUtilization?: (tokens: number) => number
}) {
  const messages = overrides?.messages ?? []
  const agent = createMockAgent({
    messages,
    extra: {
      id: overrides?.id ?? 'test-agent',
      model: {
        getConfig: () => ({}),
        countTokens: overrides?.countTokens ?? (async () => 0),
        estimateUtilization: overrides?.estimateUtilization ?? (() => 0),
      },
    } as Partial<Agent>,
  })
  return agent
}

function makeOverflowEvent(agent: ReturnType<typeof makeMockAgent>) {
  return new AfterModelCallEvent({
    agent,
    model: agent.model,
    invocationState: {},
    attemptCount: 1,
    error: new ContextWindowOverflowError('overflow'),
  })
}

function makeBeforeEvent(agent: ReturnType<typeof makeMockAgent>, projectedInputTokens?: number) {
  return new BeforeModelCallEvent({
    agent,
    model: agent.model,
    invocationState: {},
    ...(projectedInputTokens !== undefined && { projectedInputTokens }),
  })
}

describe('ContextManager', () => {
  describe('constructor', () => {
    it('has correct plugin name', () => {
      const cm = new ContextManager()
      expect(cm.name).toBe('strands:context-manager')
    })

    it('accepts custom strategies', () => {
      const cm = new ContextManager({
        strategies: [{ name: 'custom', apply: async () => false }],
      })
      expect(cm).toBeDefined()
    })
  })

  describe('initAgent', () => {
    it('registers AfterModelCallEvent hook', async () => {
      const cm = new ContextManager()
      const agent = makeMockAgent()
      await cm.initAgent(agent)
      expect(agent.trackedHooks.length).toBeGreaterThan(0)
    })

    it('initializes strategies with init context', async () => {
      let initCalled = false
      const strategy = {
        name: 'test',
        init: () => {
          initCalled = true
        },
        apply: async () => false,
      }
      const cm = new ContextManager({ strategies: [strategy] })
      const agent = makeMockAgent()
      await cm.initAgent(agent)
      expect(initCalled).toBe(true)
    })
  })

  describe('overflow path', () => {
    it('runs strategies on ContextWindowOverflowError and sets retry', async () => {
      let strategyCalled = false
      const strategy = {
        name: 'test',
        apply: async () => {
          strategyCalled = true
          return true
        },
      }
      const cm = new ContextManager({ strategies: [strategy] })
      const agent = makeMockAgent()
      await cm.initAgent(agent)

      const event = makeOverflowEvent(agent)
      await invokeTrackedHook(agent, event)

      expect(strategyCalled).toBe(true)
      expect(event.retry).toBe(true)
    })

    it('does not run strategies on non-overflow errors', async () => {
      let strategyCalled = false
      const strategy = {
        name: 'test',
        apply: async () => {
          strategyCalled = true
          return true
        },
      }
      const cm = new ContextManager({ strategies: [strategy] })
      const agent = makeMockAgent()
      await cm.initAgent(agent)

      const event = new AfterModelCallEvent({
        agent,
        model: agent.model,
        invocationState: {},
        attemptCount: 1,
        error: new Error('some other error'),
      })
      await invokeTrackedHook(agent, event)

      expect(strategyCalled).toBe(false)
      expect(event.retry).toBeUndefined()
    })

    it('truncates when utilization remains >= 1.0 after strategies', async () => {
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('system')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 1')] }),
        new Message({ role: 'user', content: [new TextBlock('msg 2')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 2')] }),
        new Message({ role: 'user', content: [new TextBlock('msg 3')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 3')] }),
        new Message({ role: 'user', content: [new TextBlock('msg 4')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 4')] }),
        new Message({ role: 'user', content: [new TextBlock('msg 5')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 5')] }),
      ]

      const strategy = { name: 'noop', apply: async () => false }
      const cm = new ContextManager({ strategies: [strategy] })
      const agent = makeMockAgent({
        messages,
        countTokens: async () => 10000,
        estimateUtilization: () => 1.5,
      })
      await cm.initAgent(agent)

      const originalLength = messages.length
      const event = makeOverflowEvent(agent)
      await invokeTrackedHook(agent, event)

      expect(messages.length).toBeLessThan(originalLength)
      expect(event.retry).toBe(true)
    })

    it('does not truncate when strategies bring utilization below 1.0', async () => {
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('system')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 1')] }),
        new Message({ role: 'user', content: [new TextBlock('msg 2')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 2')] }),
        new Message({ role: 'user', content: [new TextBlock('msg 3')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 3')] }),
      ]

      const strategy = { name: 'noop', apply: async () => true }
      const cm = new ContextManager({ strategies: [strategy] })
      const agent = makeMockAgent({
        messages,
        countTokens: async () => 100,
        estimateUtilization: () => 0.5,
      })
      await cm.initAgent(agent)

      const originalLength = messages.length
      const event = makeOverflowEvent(agent)
      await invokeTrackedHook(agent, event)

      expect(messages.length).toBe(originalLength)
    })

    it('caps retries at 3 and stops setting retry', async () => {
      const strategy = { name: 'noop', apply: async () => false }
      const cm = new ContextManager({ strategies: [strategy] })
      const agent = makeMockAgent({
        messages: [
          new Message({ role: 'user', content: [new TextBlock('system')] }),
          new Message({ role: 'assistant', content: [new TextBlock('a')] }),
          new Message({ role: 'user', content: [new TextBlock('b')] }),
          new Message({ role: 'assistant', content: [new TextBlock('c')] }),
          new Message({ role: 'user', content: [new TextBlock('d')] }),
          new Message({ role: 'assistant', content: [new TextBlock('e')] }),
          new Message({ role: 'user', content: [new TextBlock('f')] }),
          new Message({ role: 'assistant', content: [new TextBlock('g')] }),
          new Message({ role: 'user', content: [new TextBlock('h')] }),
          new Message({ role: 'assistant', content: [new TextBlock('i')] }),
        ],
        countTokens: async () => 10000,
        estimateUtilization: () => 1.5,
      })
      await cm.initAgent(agent)

      // First 3 overflows should retry
      for (let attempt = 0; attempt < 3; attempt++) {
        const event = makeOverflowEvent(agent)
        await invokeTrackedHook(agent, event)
        expect(event.retry).toBe(true)
      }

      // 4th overflow should NOT retry
      const event = makeOverflowEvent(agent)
      await invokeTrackedHook(agent, event)
      expect(event.retry).toBeUndefined()
    })

    it('resets retry counter on successful (non-overflow) model call', async () => {
      const strategy = { name: 'noop', apply: async () => false }
      const cm = new ContextManager({ strategies: [strategy] })
      const messages: Message[] = [new Message({ role: 'user', content: [new TextBlock('system')] })]
      for (let idx = 0; idx < 20; idx++) {
        messages.push(new Message({ role: 'assistant', content: [new TextBlock(`r${idx}`)] }))
        messages.push(new Message({ role: 'user', content: [new TextBlock(`m${idx}`)] }))
      }
      const agent = makeMockAgent({
        messages,
        countTokens: async () => 10000,
        estimateUtilization: () => 1.5,
      })
      await cm.initAgent(agent)

      // Use 2 retries
      for (let attempt = 0; attempt < 2; attempt++) {
        const event = makeOverflowEvent(agent)
        await invokeTrackedHook(agent, event)
        expect(event.retry).toBe(true)
      }

      // Successful call resets the counter
      const successEvent = new AfterModelCallEvent({
        agent,
        model: agent.model,
        invocationState: {},
        attemptCount: 1,
      })
      await invokeTrackedHook(agent, successEvent)

      // Should get 3 more retries
      for (let attempt = 0; attempt < 3; attempt++) {
        const event = makeOverflowEvent(agent)
        await invokeTrackedHook(agent, event)
        expect(event.retry).toBe(true)
      }
    })
  })

  describe('truncation', () => {
    it('preserves the first message content', async () => {
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('system prompt')] }),
        new Message({ role: 'assistant', content: [new TextBlock('r1')] }),
        new Message({ role: 'user', content: [new TextBlock('m2')] }),
        new Message({ role: 'assistant', content: [new TextBlock('r2')] }),
        new Message({ role: 'user', content: [new TextBlock('m3')] }),
        new Message({ role: 'assistant', content: [new TextBlock('r3')] }),
        new Message({ role: 'user', content: [new TextBlock('m4')] }),
        new Message({ role: 'assistant', content: [new TextBlock('r4')] }),
        new Message({ role: 'user', content: [new TextBlock('m5')] }),
        new Message({ role: 'assistant', content: [new TextBlock('r5')] }),
      ]

      const strategy = { name: 'noop', apply: async () => false }
      const cm = new ContextManager({ strategies: [strategy] })
      const agent = makeMockAgent({
        messages,
        countTokens: async () => 10000,
        estimateUtilization: () => 1.5,
      })
      await cm.initAgent(agent)

      const event = makeOverflowEvent(agent)
      await invokeTrackedHook(agent, event)

      const firstBlock = messages[0]!.content[0]! as TextBlock
      expect(firstBlock.text).toBe('system prompt')
    })

    it('does not orphan tool-use/tool-result pairs in preserved region', async () => {
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('system')] }),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ toolUseId: 'tu-1', name: 'myTool', input: {} })],
        }),
        new Message({
          role: 'user',
          content: [new ToolResultBlock({ toolUseId: 'tu-1', status: 'success', content: [new TextBlock('result')] })],
        }),
        new Message({ role: 'assistant', content: [new TextBlock('after tool')] }),
        new Message({ role: 'user', content: [new TextBlock('m4')] }),
        new Message({ role: 'assistant', content: [new TextBlock('r4')] }),
        new Message({ role: 'user', content: [new TextBlock('m5')] }),
        new Message({ role: 'assistant', content: [new TextBlock('r5')] }),
        new Message({ role: 'user', content: [new TextBlock('m6')] }),
        new Message({ role: 'assistant', content: [new TextBlock('r6')] }),
        new Message({ role: 'user', content: [new TextBlock('m7')] }),
        new Message({ role: 'assistant', content: [new TextBlock('r7')] }),
      ]

      const strategy = { name: 'noop', apply: async () => false }
      const cm = new ContextManager({ strategies: [strategy] })
      const agent = makeMockAgent({
        messages,
        countTokens: async () => 10000,
        estimateUtilization: () => 1.5,
      })
      await cm.initAgent(agent)

      const event = makeOverflowEvent(agent)
      await invokeTrackedHook(agent, event)

      // Tool use at index 1 should still be present with its result
      const hasToolUse = messages.some((message) =>
        message.content.some((block) => 'toolUseId' in block && 'name' in block && block.name === 'myTool')
      )
      const hasToolResult = messages.some((message) =>
        message.content.some(
          (block) => block.type === 'toolResultBlock' && (block as ToolResultBlock).toolUseId === 'tu-1'
        )
      )
      // If tool use is present, its result must also be present
      if (hasToolUse) {
        expect(hasToolResult).toBe(true)
      }
    })

    it('does not truncate when messages <= 3', async () => {
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('system')] }),
        new Message({ role: 'assistant', content: [new TextBlock('r1')] }),
        new Message({ role: 'user', content: [new TextBlock('m2')] }),
      ]

      const strategy = { name: 'noop', apply: async () => false }
      const cm = new ContextManager({ strategies: [strategy] })
      const agent = makeMockAgent({
        messages,
        countTokens: async () => 10000,
        estimateUtilization: () => 1.5,
      })
      await cm.initAgent(agent)

      const event = makeOverflowEvent(agent)
      await invokeTrackedHook(agent, event)

      expect(messages).toHaveLength(3)
    })
  })

  describe('proactive strategies (BeforeModelCallEvent)', () => {
    it('runs strategies with projected input tokens', async () => {
      let receivedUtilization: number | undefined
      const strategy = {
        name: 'test',
        apply: async (context: { utilization: number }) => {
          receivedUtilization = context.utilization
          return false
        },
      }
      const cm = new ContextManager({ strategies: [strategy] })
      const agent = makeMockAgent({
        estimateUtilization: (tokens: number) => tokens / 10000,
      })
      await cm.initAgent(agent)

      const event = makeBeforeEvent(agent, 5000)
      await invokeTrackedHook(agent, event)

      expect(receivedUtilization).toBe(0.5)
    })
  })
})
