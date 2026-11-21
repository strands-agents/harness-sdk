import { describe, it, expect } from 'vitest'
import { ContextManager } from '../context-manager.js'
import { createMockAgent, invokeTrackedHook } from '../../__fixtures__/agent-helpers.js'
import { AfterModelCallEvent, BeforeModelCallEvent, MessageAddedEvent } from '../../hooks/events.js'
import { ContextWindowOverflowError } from '../../errors.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock, OffloadedBlock } from '../../types/messages.js'
import type { Agent } from '../../agent/agent.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import type { Storage } from '../../storage/storage.js'
import { PluginRegistry } from '../../plugins/registry.js'
import { RETRIEVAL_TOOL_NAME } from '../retrieval-tool.js'
import { Offload } from '../strategies/offload/index.js'
import { ToolRegistry } from '../../registry/tool-registry.js'
import { ToolStreamEvent } from '../../tools/tool.js'
import type { CountTokensOptions } from '../../models/model.js'
import type { Tool, ToolStreamGenerator } from '../../tools/tool.js'
import type { ContextState } from '../types.js'

function makeMockAgent(overrides?: {
  id?: string
  messages?: Message[]
  systemPrompt?: string
  toolRegistry?: ToolRegistry
  countTokens?: (msgs: Message[], options?: CountTokensOptions) => Promise<number>
  estimateUtilization?: (tokens: number) => number
}) {
  const messages = overrides?.messages ?? []
  const agent = createMockAgent({
    messages,
    ...(overrides?.toolRegistry && { toolRegistry: overrides.toolRegistry }),
    extra: {
      id: overrides?.id ?? 'test-agent',
      ...(overrides?.systemPrompt !== undefined && { systemPrompt: overrides.systemPrompt }),
      model: {
        getConfig: () => ({}),
        countTokens: overrides?.countTokens ?? (async () => 0),
        estimateUtilization: overrides?.estimateUtilization ?? (() => 0),
      },
    } as Partial<Agent>,
  })
  return agent
}

function makeStubTool(name: string): Tool {
  return {
    name,
    description: `stub ${name}`,
    toolSpec: { name, description: `stub ${name}`, inputSchema: { type: 'object', properties: {} } },
    stream: async function* (): ToolStreamGenerator {
      yield new ToolStreamEvent({ data: `stub ${name}` })
      return new ToolResultBlock({ toolUseId: '', status: 'success', content: [] })
    },
  }
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

    it.each([
      ['the preset and Offload.defer', ['deferredToolLoading' as const, Offload.defer(['!shell'])]],
      ['two Offload.defer strategies', [Offload.defer('toolSpecs'), Offload.defer(['shell'])]],
    ])('rejects %s, which would share one tools list', (_name, strategies) => {
      expect(() => new ContextManager({ strategies })).toThrow(
        "contextManager takes one Offload.defer strategy, and the 'deferredToolLoading' preset is one; " +
          'to change what the preset defers or when, use Offload.defer(target).when(conditions) in its place'
      )
    })
  })

  describe('deprecated stash surface', () => {
    it('honors the stash config key when archive is omitted', async () => {
      const storage = new InMemoryStorage()
      const cm = new ContextManager({ stash: { storage: storage.namespace('team') } })
      await cm.initAgent(makeMockAgent())
      await cm.archive!.store('tool-1', 0, new TextEncoder().encode('{}'))

      expect(await storage.list('')).toStrictEqual(['team/tool-1_0'])
    })

    it('honors stash: false', async () => {
      const cm = new ContextManager({ stash: false })
      await cm.initAgent(makeMockAgent())

      expect(cm.archive).toBeUndefined()
    })

    it('prefers archive when both keys are set', async () => {
      const cm = new ContextManager({ archive: false, stash: true })
      await cm.initAgent(makeMockAgent())

      expect(cm.archive).toBeUndefined()
    })

    it('resolves the stash getters to the archive', async () => {
      const cm = new ContextManager()
      await cm.initAgent(makeMockAgent())

      // The published CLI reads these through optional chaining, so a missing getter loses the
      // archive on fork without throwing.
      expect(cm.stash).toBe(cm.archive)
      expect(cm.stashIsDurable).toBe(cm.archiveIsDurable)
    })

    it('sets stash alongside archive on the state a strategy receives', async () => {
      let received: ContextState | undefined
      const cm = new ContextManager({
        strategies: [
          {
            name: 'test',
            apply: async (context) => {
              received = context
              return false
            },
          },
        ],
      })
      const agent = makeMockAgent()
      await cm.initAgent(agent)

      await invokeTrackedHook(agent, makeBeforeEvent(agent, 100))

      // A strategy reading `context.stash?.…` goes silently no-op without this, the same way the
      // published CLI's fork did.
      expect(received?.stash).toBe(cm.archive)
    })
  })

  describe('from', () => {
    it('returns a ContextManager instance as-is', () => {
      const cm = new ContextManager({ strategies: [{ name: 'custom', apply: async () => false }] })
      expect(ContextManager.from(cm)).toBe(cm)
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

  describe('archive root', () => {
    it('uses an explicitly configured scoped archive storage as the exact root', async () => {
      const storage = new InMemoryStorage()
      const cm = new ContextManager({ archive: { storage: storage.namespace('team') } })
      await cm.initAgent(makeMockAgent())
      await cm.archive!.store('tool-1', 0, new TextEncoder().encode('{}'))

      expect(await storage.list('')).toStrictEqual(['team/tool-1_0'])
    })

    it('keeps the per-agent root under a scoped agent storage', async () => {
      const storage = new InMemoryStorage()
      const agent = createMockAgent({
        extra: { id: 'test-agent', storage: storage.namespace('tenant') } as Partial<Agent>,
      })
      const cm = new ContextManager()
      await cm.initAgent(agent)
      await cm.archive!.store('tool-1', 0, new TextEncoder().encode('{}'))

      expect(await storage.list('')).toStrictEqual(['tenant/context/test-ses/scopes/agent/test-agent/tool-1_0'])
    })
  })

  describe('seeded messages', () => {
    it('does not overwrite an archived original with a seeded preview', async () => {
      const storage = new InMemoryStorage()
      const view = storage.namespace('team')
      await view.write('tu-1_0', new TextEncoder().encode(JSON.stringify({ text: 'original full result' })))
      const preview = new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'tu-1',
            status: 'success',
            content: [
              new OffloadedBlock({
                text: '[Truncated: 1 block, ~7,500 tokens] preview [ref: tu-1]',
                method: 'truncate',
                ref: 'tu-1',
              }),
            ],
          }),
        ],
      })
      const cm = new ContextManager({ archive: { storage: view } })

      await cm.initAgent(makeMockAgent({ messages: [preview] }))

      expect(await cm.archive!.retrieve('tu-1_0')).toStrictEqual({ data: { text: 'original full result' } })
    })
  })

  describe('seeded messages from a session without placeholder metadata', () => {
    it('does not overwrite an archived original with a text-only preview', async () => {
      const storage = new InMemoryStorage()
      const view = storage.namespace('team')
      await view.write('tu-1_0', new TextEncoder().encode(JSON.stringify({ text: 'original full result' })))
      await view.write('msg-1_0', new TextEncoder().encode(JSON.stringify({ text: 'original user text' })))
      const restored = new Message({
        role: 'user',
        content: [
          new TextBlock('[Truncated: ~2,000 tokens] original [ref: msg-1_0]'),
          new ToolResultBlock({
            toolUseId: 'tu-1',
            status: 'success',
            content: [new TextBlock('[Truncated: 1 block, ~7,500 tokens] preview [ref: tu-1_0]')],
          }),
        ],
        trackingId: 'msg-1',
      })
      const cm = new ContextManager({ archive: { storage: view } })

      await cm.initAgent(makeMockAgent({ messages: [restored] }))

      expect(await cm.archive!.retrieve('tu-1_0')).toStrictEqual({ data: { text: 'original full result' } })
      expect(await cm.archive!.retrieve('msg-1_0')).toStrictEqual({ data: { text: 'original user text' } })
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

    it('truncates when a strategy throws', async () => {
      const messages = Array.from(
        { length: 10 },
        (_, i) => new Message({ role: i % 2 === 0 ? 'user' : 'assistant', content: [new TextBlock(`msg ${i}`)] })
      )
      const strategy = {
        name: 'failing',
        apply: async (): Promise<boolean> => {
          throw new Error('summarizer rejected')
        },
      }
      const cm = new ContextManager({ strategies: [strategy] })
      const agent = makeMockAgent({ messages, countTokens: async () => 10000, estimateUtilization: () => 1.5 })
      await cm.initAgent(agent)

      const event = makeOverflowEvent(agent)
      await invokeTrackedHook(agent, event)

      expect(messages.length).toBeLessThan(10)
      expect(event.retry).toBe(true)
    })

    it('does not truncate on non-overflow when utilization is below 1.0', async () => {
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('system')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 1')] }),
        new Message({ role: 'user', content: [new TextBlock('msg 2')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 2')] }),
        new Message({ role: 'user', content: [new TextBlock('msg 3')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 3')] }),
      ]

      const strategy = { name: 'test', apply: async () => false }
      const cm = new ContextManager({ strategies: [strategy] })
      const agent = makeMockAgent({
        messages,
        countTokens: async () => 100,
        estimateUtilization: () => 0.5,
      })
      await cm.initAgent(agent)

      const originalLength = messages.length
      const event = new BeforeModelCallEvent({
        agent,
        model: agent.model,
        invocationState: {},
        projectedInputTokens: 100,
      })
      await invokeTrackedHook(agent, event)

      expect(messages.length).toBe(originalLength)
    })

    it('emergency truncate fires when estimate undercounts on overflow', async () => {
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('system')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 1')] }),
        new Message({ role: 'user', content: [new TextBlock('msg 2')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 2')] }),
        new Message({ role: 'user', content: [new TextBlock('msg 3')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 3')] }),
        new Message({ role: 'user', content: [new TextBlock('msg 4')] }),
        new Message({ role: 'assistant', content: [new TextBlock('response 4')] }),
      ]

      const strategy = { name: 'noop', apply: async () => false }
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

      expect(messages.length).toBeLessThan(originalLength)
      expect(event.retry).toBe(true)
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

  describe('token counting', () => {
    it('counts the system prompt and tool specs alongside the messages', async () => {
      const toolRegistry = new ToolRegistry()
      toolRegistry.add(makeStubTool('lookup'))
      const countOptions: (CountTokensOptions | undefined)[] = []

      let applied = false
      const strategy = {
        name: 'acts-once',
        apply: async () => {
          if (applied) return false
          applied = true
          return true
        },
      }
      const cm = new ContextManager({ strategies: [strategy], archive: false })
      const agent = makeMockAgent({
        messages: [new Message({ role: 'user', content: [new TextBlock('hello')] })],
        systemPrompt: 'be helpful',
        toolRegistry,
        countTokens: async (_messages, options) => {
          countOptions.push(options)
          return 100
        },
      })
      await cm.initAgent(agent)

      // No projectedInputTokens, so the initial gate counts too — both counts must see the same inputs.
      await invokeTrackedHook(agent, makeBeforeEvent(agent))

      expect(countOptions).toStrictEqual([
        { systemPrompt: 'be helpful', toolSpecs: [toolRegistry.list()[0]!.toolSpec] },
        { systemPrompt: 'be helpful', toolSpecs: [toolRegistry.list()[0]!.toolSpec] },
      ])
    })

    it('omits the system prompt when the agent has none', async () => {
      const countOptions: (CountTokensOptions | undefined)[] = []
      const cm = new ContextManager({ strategies: [{ name: 'noop', apply: async () => false }], archive: false })
      const agent = makeMockAgent({
        messages: [new Message({ role: 'user', content: [new TextBlock('hello')] })],
        countTokens: async (_messages, options) => {
          countOptions.push(options)
          return 100
        },
      })
      await cm.initAgent(agent)

      await invokeTrackedHook(agent, makeBeforeEvent(agent))

      expect(countOptions).toStrictEqual([{ toolSpecs: [] }])
    })

    // The gate measures the messages it would drop, not the whole request the other gates are measured on.
    it('leaves messages that fit the window in the emergency truncate gate', async () => {
      const toolRegistry = new ToolRegistry()
      toolRegistry.add(makeStubTool('lookup'))
      let counts = 0
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('a')] }),
        new Message({ role: 'assistant', content: [new TextBlock('b')] }),
        new Message({ role: 'user', content: [new TextBlock('c')] }),
        new Message({ role: 'assistant', content: [new TextBlock('d')] }),
      ]

      // Only the emergency truncate appended by the constructor can act.
      const cm = new ContextManager({ strategies: [{ name: 'noop', apply: async () => false }], archive: false })
      const agent = makeMockAgent({
        messages,
        systemPrompt: 'be helpful',
        toolRegistry,
        estimateUtilization: (tokens: number) => tokens / 10_000,
        // The request is over the window, the messages are a tenth of it: dropping them cannot be what helps.
        countTokens: async () => {
          counts += 1
          return 1_000
        },
      })
      await cm.initAgent(agent)

      await invokeTrackedHook(agent, makeBeforeEvent(agent, 20_000))

      expect(agent.messages).toHaveLength(4)
      expect(counts).toBe(1)
    })
  })

  describe('shared across multiple agents', () => {
    function invokeRetrieval(tool: Tool, reference: string): Promise<unknown> {
      return (tool as unknown as { invoke(input: unknown): Promise<unknown> }).invoke({ reference })
    }

    function makeSessionAgent(params: {
      id: string
      sessionId: string
      storage: Storage
      messages?: Message[]
      estimateUtilization?: (tokens: number) => number
    }) {
      return createMockAgent({
        messages: params.messages ?? [],
        extra: {
          id: params.id,
          sessionId: params.sessionId,
          storage: params.storage,
          model: {
            getConfig: () => ({}),
            modelInfo: { limits: { contextWindow: 10_000 } },
            countTokens: async (msgs: Message[]) =>
              msgs.reduce(
                (sum, m) =>
                  sum +
                  m.content.reduce((s, b) => {
                    if (b instanceof TextBlock) return s + Math.ceil(b.text.length / 4)
                    if (b instanceof ToolResultBlock) {
                      return (
                        s +
                        b.content.reduce((cs, c) => cs + (c instanceof TextBlock ? Math.ceil(c.text.length / 4) : 0), 0)
                      )
                    }
                    return s
                  }, 0),
                0
              ),
            estimateUtilization: params.estimateUtilization ?? ((tokens: number) => tokens / 10_000),
          },
        } as Partial<Agent>,
      })
    }

    it('isolates archives, retrieval tools, and backfill across agents sharing one ContextManager', async () => {
      const storage = new InMemoryStorage()
      const cm = new ContextManager({ strategies: [] })

      const msgA = new Message({ role: 'user', content: [new TextBlock('secret from session A')], trackingId: 'msg-a' })
      const msgB = new Message({ role: 'user', content: [new TextBlock('secret from session B')], trackingId: 'msg-b' })
      const agentA = makeSessionAgent({ id: 'agent-a', sessionId: 's1', storage, messages: [msgA] })
      const agentB = makeSessionAgent({ id: 'agent-b', sessionId: 's2', storage, messages: [msgB] })

      await new PluginRegistry([cm]).initialize(agentA)
      await new PluginRegistry([cm]).initialize(agentB)

      const toolA = agentA.toolRegistry.get(RETRIEVAL_TOOL_NAME)!
      const toolB = agentB.toolRegistry.get(RETRIEVAL_TOOL_NAME)!
      expect(toolA).toBeDefined()
      expect(toolB).toBeDefined()
      expect(toolA).not.toBe(toolB)
      expect(cm.getTools(agentA)).toStrictEqual([toolA])
      expect(cm.getTools(agentB)).toStrictEqual([toolB])
      expect(cm.archiveFor(agentA)).not.toBe(cm.archiveFor(agentB))

      expect(await invokeRetrieval(toolA, 'msg-a_0')).toEqual(new TextBlock('secret from session A'))
      expect(await invokeRetrieval(toolB, 'msg-b_0')).toEqual(new TextBlock('secret from session B'))
      await expect(invokeRetrieval(toolB, 'msg-a_0')).rejects.toThrow('reference not found: msg-a_0')
      await expect(invokeRetrieval(toolA, 'msg-b_0')).rejects.toThrow('reference not found: msg-b_0')

      expect(await storage.list('context/s1/')).toStrictEqual(['context/s1/scopes/agent/agent-a/msg-a_0'])
      expect(await storage.list('context/s2/')).toStrictEqual(['context/s2/scopes/agent/agent-b/msg-b_0'])
    })

    it('isolates archives and retrieval tools when shared ContextManager initializes agents concurrently', async () => {
      const storage = new InMemoryStorage()
      const cm = new ContextManager({ strategies: [] })

      const agentA = makeSessionAgent({
        id: 'agent-a',
        sessionId: 's1',
        storage,
        messages: [new Message({ role: 'user', content: [new TextBlock('concurrent A')], trackingId: 'conc-a' })],
      })
      const agentB = makeSessionAgent({
        id: 'agent-b',
        sessionId: 's2',
        storage,
        messages: [new Message({ role: 'user', content: [new TextBlock('concurrent B')], trackingId: 'conc-b' })],
      })

      await Promise.all([new PluginRegistry([cm]).initialize(agentA), new PluginRegistry([cm]).initialize(agentB)])

      const toolA = agentA.toolRegistry.get(RETRIEVAL_TOOL_NAME)!
      const toolB = agentB.toolRegistry.get(RETRIEVAL_TOOL_NAME)!
      expect(toolA).not.toBe(toolB)
      expect(await invokeRetrieval(toolA, 'conc-a_0')).toEqual(new TextBlock('concurrent A'))
      expect(await invokeRetrieval(toolB, 'conc-b_0')).toEqual(new TextBlock('concurrent B'))
      await expect(invokeRetrieval(toolB, 'conc-a_0')).rejects.toThrow('reference not found: conc-a_0')
      await expect(invokeRetrieval(toolA, 'conc-b_0')).rejects.toThrow('reference not found: conc-b_0')
    })

    it('keeps offload strategy writes on agent A isolated after agent B is initialized', async () => {
      const storage = new InMemoryStorage()
      const cm = new ContextManager({
        strategies: [
          Offload.truncate('toolResults', { previewTokens: 10 }).when({ blockThreshold: 50 }),
          Offload.drop('*').when({ contextUtilization: '50%', preserveRecent: 1 }),
        ],
      })

      const agentA = makeSessionAgent({
        id: 'agent-a',
        sessionId: 's1',
        storage,
        messages: [
          new Message({ role: 'user', content: [new TextBlock('task A')], trackingId: 'a-0' }),
          new Message({ role: 'assistant', content: [new TextBlock('old reply A')], trackingId: 'a-1' }),
          new Message({ role: 'user', content: [new TextBlock('follow-up A')], trackingId: 'a-2' }),
        ],
        estimateUtilization: () => 0.8,
      })
      const agentB = makeSessionAgent({
        id: 'agent-b',
        sessionId: 's2',
        storage,
        messages: [new Message({ role: 'user', content: [new TextBlock('task B')], trackingId: 'b-0' })],
      })

      await new PluginRegistry([cm]).initialize(agentA)
      await new PluginRegistry([cm]).initialize(agentB)

      // Trigger eager offload on agent A after agent B was initialized.
      const largeOutput = 'A_SECRET_PAYLOAD '.repeat(200)
      const toolResultMsg = new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'tu-a-big',
            status: 'success',
            content: [new TextBlock(largeOutput)],
          }),
        ],
        trackingId: 'a-3',
      })
      agentA.messages.push(toolResultMsg)
      await invokeTrackedHook(
        agentA,
        new MessageAddedEvent({ agent: agentA, message: toolResultMsg, invocationState: {} })
      )

      // Trigger pipeline offload (Offload.drop('*')) on agent A after agent B was initialized.
      await invokeTrackedHook(agentA, makeBeforeEvent(agentA, 8_000))

      const toolA = agentA.toolRegistry.get(RETRIEVAL_TOOL_NAME)!
      const toolB = agentB.toolRegistry.get(RETRIEVAL_TOOL_NAME)!

      // Eagerly offloaded tool result belongs strictly to agent A's archive.
      expect(await invokeRetrieval(toolA, 'tu-a-big')).toEqual(new TextBlock(largeOutput))
      await expect(invokeRetrieval(toolB, 'tu-a-big')).rejects.toThrow('reference not found: tu-a-big')

      // Dropped message placeholder belongs strictly to agent A's archive.
      const droppedBlock = agentA.messages
        .flatMap((m) => m.content)
        .find((b): b is OffloadedBlock => b instanceof OffloadedBlock && b.method === 'drop')
      expect(droppedBlock?.ref).toBeDefined()
      expect(await invokeRetrieval(toolA, droppedBlock!.ref!)).toBeDefined()
      await expect(invokeRetrieval(toolB, droppedBlock!.ref!)).rejects.toThrow(
        `reference not found: ${droppedBlock!.ref}`
      )

      // Nothing from agent A leaked into session B's storage prefix.
      expect(await storage.list('context/s2/')).toStrictEqual(['context/s2/scopes/agent/agent-b/b-0_0'])
      const keysA = await storage.list('context/s1/')
      expect(keysA.some((k) => k.endsWith('/tu-a-big_0'))).toBe(true)
      expect(keysA.some((k) => k.includes('/removed-'))).toBe(true)
    })

    it('tracks archive durability per agent', async () => {
      const ephemeralStorage = new InMemoryStorage()
      const durableStorage: Storage = {
        read: async () => null,
        write: async () => {},
        delete: async () => {},
        list: async () => [],
      }
      const cm = new ContextManager({ strategies: [] })
      const agentA = makeSessionAgent({ id: 'agent-a', sessionId: 's1', storage: ephemeralStorage })
      const agentB = makeSessionAgent({ id: 'agent-b', sessionId: 's2', storage: durableStorage })

      await cm.initAgent(agentA)
      await cm.initAgent(agentB)

      expect(cm.archiveIsDurableFor(agentA)).toBe(false)
      expect(cm.archiveIsDurableFor(agentB)).toBe(true)
    })
  })
})
