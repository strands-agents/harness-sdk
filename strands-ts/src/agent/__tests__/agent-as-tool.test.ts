import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import { AgentAsTool } from '../agent-as-tool.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import { createMockContext, createMockTool } from '../../__fixtures__/tool-helpers.js'
import { ToolValidationError } from '../../errors.js'
import { BeforeModelCallEvent } from '../../hooks/events.js'
import { createErrorResult, Tool, ToolStreamEvent } from '../../tools/tool.js'
import { DELEGATION_DESCRIPTION_SUFFIX } from '../agent-as-tool.js'
import { ToolResultBlock } from '../../types/messages.js'
import { SessionManager } from '../../session/session-manager.js'
import type { Plugin } from '../../plugins/plugin.js'
import type { SnapshotStorage } from '../../session/storage.js'

describe('AgentAsTool', () => {
  describe('properties', () => {
    it('uses agent name as default tool name', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, name: 'researcher' })
      const tool = new AgentAsTool({ agent })

      expect(tool.name).toBe('researcher')
    })

    it('allows overriding the tool name', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, name: 'researcher' })
      const tool = new AgentAsTool({ agent, name: 'research-tool' })

      expect(tool.name).toBe('research-tool')
    })

    it('uses agent description as default tool description', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, name: 'researcher', description: 'Finds information' })
      const tool = new AgentAsTool({ agent })

      expect(tool.description).toBe('Finds information')
    })

    it('falls back to generic description when agent has no description', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, name: 'researcher' })
      const tool = new AgentAsTool({ agent })

      expect(tool.description).toBe('Use the researcher agent by providing a natural language input')
    })

    it('allows overriding the tool description', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, name: 'researcher' })
      const tool = new AgentAsTool({ agent, description: 'Custom description' })

      expect(tool.description).toBe('Custom description')
    })

    it('exposes the wrapped agent via getter', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, name: 'researcher' })
      const tool = new AgentAsTool({ agent })

      expect(tool.agent).toBe(agent)
    })

    it('has correct toolSpec shape', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, name: 'researcher', description: 'Finds info' })
      const tool = new AgentAsTool({ agent })

      expect(tool.toolSpec).toEqual({
        name: 'researcher',
        description: 'Finds info',
        inputSchema: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: 'The natural language input to send to the agent.',
            },
          },
          required: ['input'],
        },
      })
    })
  })

  describe('name validation', () => {
    it('throws when registered with agent name containing spaces', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const subAgent = new Agent({ model, name: 'Strands Agent' })

      expect(() => new Agent({ model, tools: [subAgent] })).toThrow(ToolValidationError)
    })

    it('throws when registered with explicit name containing invalid characters', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const subAgent = new Agent({ model, name: 'researcher' })

      expect(() => new Agent({ model, tools: [subAgent.asTool({ name: 'has spaces' })] })).toThrow(ToolValidationError)
    })

    it('accepts valid name with hyphens and underscores', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, name: 'my_research-agent' })
      const tool = new AgentAsTool({ agent })

      expect(tool.name).toBe('my_research-agent')
    })
  })

  describe('stream', () => {
    it('invokes the wrapped agent and returns text result', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Agent response' })
      const agent = new Agent({ model, name: 'test-agent', printer: false })
      const tool = new AgentAsTool({ agent })

      const context = createMockContext({
        name: 'test-agent',
        toolUseId: 'tool-1',
        input: { input: 'Hello agent' },
      })

      const { result } = await collectGenerator(tool.stream(context))

      expect(result.toolUseId).toBe('tool-1')
      expect(result.status).toBe('success')
      expect(result.content).toHaveLength(1)
      expect(result.content[0]).toEqual(
        expect.objectContaining({
          type: 'textBlock',
          text: 'Agent response',
        })
      )
    })

    it('returns an error when the execution signal cancels the wrapped agent', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Agent response' })
      const agent = new Agent({ model, name: 'test-agent', printer: false })
      const tool = new AgentAsTool({ agent })
      const controller = new AbortController()
      agent.addHook(BeforeModelCallEvent, () => controller.abort())

      const context = createMockContext({
        name: 'test-agent',
        toolUseId: 'tool-1',
        input: { input: 'Hello agent' },
      })
      context.cancelSignal = controller.signal

      const { result } = await collectGenerator(tool.stream(context))

      expect(result).toEqual(createErrorResult("Agent 'test-agent' cancelled", 'tool-1'))
    })

    it('does not persist cancellation when the signal aborts during initialization', async () => {
      let signalInitializationStarted!: () => void
      const initializationStarted = new Promise<void>((resolve) => {
        signalInitializationStarted = resolve
      })
      let releaseInitialization!: () => void
      const initializationReleased = new Promise<void>((resolve) => {
        releaseInitialization = resolve
      })
      const plugin: Plugin = {
        name: 'delayed-initialization',
        async initAgent(): Promise<void> {
          signalInitializationStarted()
          await initializationReleased
        },
      }
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Agent response' })
      const agent = new Agent({ model, name: 'test-agent', plugins: [plugin], printer: false })
      const tool = new AgentAsTool({ agent, preserveContext: true })
      const controller = new AbortController()
      const context = createMockContext({
        name: 'test-agent',
        toolUseId: 'tool-1',
        input: { input: 'Hello agent' },
      })
      context.cancelSignal = controller.signal

      const execution = collectGenerator(tool.stream(context))
      await initializationStarted
      controller.abort()
      releaseInitialization()
      const { result } = await execution

      expect({
        result,
        messages: agent.messages,
      }).toEqual({
        result: createErrorResult("Agent 'test-agent' cancelled", 'tool-1'),
        messages: [],
      })
    })

    it('yields ToolStreamEvents wrapping sub-agent events', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, name: 'test-agent', printer: false })
      const tool = new AgentAsTool({ agent })

      const context = createMockContext({
        name: 'test-agent',
        toolUseId: 'tool-1',
        input: { input: 'Hi' },
      })

      const { items } = await collectGenerator(tool.stream(context))

      expect(items.length).toBeGreaterThan(0)
      for (const item of items) {
        expect(item).toBeInstanceOf(ToolStreamEvent)
      }
    })

    it('unwraps toolStreamUpdateEvent by yielding inner ToolStreamEvent directly', async () => {
      // Create a tool that yields ToolStreamEvents during execution.
      // When the sub-agent runs this tool, the agent loop wraps each yielded
      // ToolStreamEvent in a ToolStreamUpdateEvent. The AgentAsTool should
      // unwrap these back to bare ToolStreamEvents instead of double-wrapping.
      const streamingTool = {
        name: 'streaming-tool',
        description: 'A tool that yields stream events',
        toolSpec: {
          name: 'streaming-tool',
          description: 'A tool that yields stream events',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        async *stream(context: any) {
          yield new ToolStreamEvent({ data: 'progress-1' })
          yield new ToolStreamEvent({ data: 'progress-2' })
          return new ToolResultBlock({
            toolUseId: context.toolUse.toolUseId,
            status: 'success' as const,
            content: [],
          })
        },
      } as Tool

      // Turn 1: model requests tool use → triggers the streaming tool
      // Turn 2: model responds with text after tool result
      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'streaming-tool',
          toolUseId: 'sub-tool-1',
          input: {},
        })
        .addTurn({ type: 'textBlock', text: 'Final response' })

      const agent = new Agent({ model, name: 'test-agent', tools: [streamingTool], printer: false })
      const tool = new AgentAsTool({ agent })

      const context = createMockContext({
        name: 'test-agent',
        toolUseId: 'outer-tool-1',
        input: { input: 'Do something' },
      })

      const { items } = await collectGenerator(tool.stream(context))

      // All yielded items should be ToolStreamEvent instances
      for (const item of items) {
        expect(item).toBeInstanceOf(ToolStreamEvent)
      }

      // Find the unwrapped events from the streaming tool.
      // If unwrapping works correctly, data is the original string.
      // If double-wrapped, data would be a ToolStreamUpdateEvent object.
      const progressEvents = items.filter((item) => item.data === 'progress-1' || item.data === 'progress-2')

      expect(progressEvents).toHaveLength(2)
      expect(progressEvents[0]!.data).toBe('progress-1')
      expect(progressEvents[1]!.data).toBe('progress-2')
    })

    it('returns error result on agent failure', async () => {
      const model = new MockMessageModel().addTurn(new Error('Model failed'))
      const agent = new Agent({ model, name: 'test-agent', printer: false })
      const tool = new AgentAsTool({ agent })

      const context = createMockContext({
        name: 'test-agent',
        toolUseId: 'tool-1',
        input: { input: 'Hello' },
      })

      const { result } = await collectGenerator(tool.stream(context))

      expect(result.toolUseId).toBe('tool-1')
      expect(result.status).toBe('error')
    })

    it('returns error result when agent is already busy', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Slow response' })
      const agent = new Agent({ model, name: 'test-agent', printer: false })
      const tool = new AgentAsTool({ agent })

      const context1 = createMockContext({
        name: 'test-agent',
        toolUseId: 'tool-1',
        input: { input: 'First call' },
      })
      const context2 = createMockContext({
        name: 'test-agent',
        toolUseId: 'tool-2',
        input: { input: 'Second call' },
      })

      // Start first call but don't fully consume it
      const gen1 = tool.stream(context1)
      await gen1.next()

      // Second call should get an error immediately
      const { result } = await collectGenerator(tool.stream(context2))

      expect(result.toolUseId).toBe('tool-2')
      expect(result.status).toBe('error')
      expect(result.content[0]).toEqual(
        expect.objectContaining({
          type: 'textBlock',
          text: expect.stringContaining('already processing'),
        })
      )

      // Clean up first generator
      await collectGenerator(gen1)
    })

    // Guards https://github.com/strands-agents/harness-sdk/issues/4795: an early close of the orchestrator's
    // stream must release the sub-agent so it can be invoked again.
    it('releases the sub-agent when the orchestrator stream is closed mid-flight', async () => {
      const sub = new Agent({
        name: 'sub',
        printer: false,
        model: new MockMessageModel()
          .addTurn({ type: 'toolUseBlock', name: 'inner', toolUseId: 'inner-1', input: {} })
          .addTurn({ type: 'textBlock', text: 'sub done' })
          .addTurn({ type: 'textBlock', text: 'again done' }),
        tools: [createMockTool('inner', () => 'ok')],
      })
      const tool = sub.asTool()
      const orch = new Agent({
        printer: false,
        model: new MockMessageModel()
          .addTurn({ type: 'toolUseBlock', name: 'sub', toolUseId: 'outer-1', input: { input: 'go' } })
          .addTurn({ type: 'textBlock', text: 'orch done' }),
        tools: [tool],
      })

      for await (const event of orch.stream('go')) {
        // Sub-agent events arrive wrapped in a ToolStreamUpdateEvent whose `event.data` is the sub-agent's event.
        const inner = (event as { event?: { data?: { type?: string } } }).event?.data?.type
        if (inner === 'beforeToolCallEvent') break
      }

      expect(orch.isInvoking).toBe(false)
      expect(sub.isInvoking).toBe(false)
      await expect(
        collectGenerator(
          tool.stream(createMockContext({ name: 'sub', toolUseId: 'tool-2', input: { input: 'again' } }))
        )
      ).resolves.toMatchObject({
        result: expect.objectContaining({ status: 'success' }),
      })
    })
  })

  describe('preserveContext', () => {
    it('resets agent state between invocations when false (default)', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
      const agent = new Agent({ model, name: 'test-agent', printer: false })
      const tool = new AgentAsTool({ agent })

      const context1 = createMockContext({
        name: 'test-agent',
        toolUseId: 'tool-1',
        input: { input: 'Hello' },
      })
      const context2 = createMockContext({
        name: 'test-agent',
        toolUseId: 'tool-2',
        input: { input: 'Hello again' },
      })

      await collectGenerator(tool.stream(context1))
      const messagesAfterFirst = agent.messages.length

      await collectGenerator(tool.stream(context2))
      const messagesAfterSecond = agent.messages.length

      // State is reset so both produce the same message count
      expect(messagesAfterSecond).toBe(messagesAfterFirst)
    })

    it('preserves agent state across invocations when true', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
      const agent = new Agent({ model, name: 'test-agent', printer: false })
      const tool = new AgentAsTool({ agent, preserveContext: true })

      const context1 = createMockContext({
        name: 'test-agent',
        toolUseId: 'tool-1',
        input: { input: 'Hello' },
      })
      const context2 = createMockContext({
        name: 'test-agent',
        toolUseId: 'tool-2',
        input: { input: 'Hello again' },
      })

      await collectGenerator(tool.stream(context1))
      const messagesAfterFirst = agent.messages.length

      await collectGenerator(tool.stream(context2))
      const messagesAfterSecond = agent.messages.length

      // Messages should accumulate across invocations
      expect(messagesAfterSecond).toBeGreaterThan(messagesAfterFirst)
    })

    it('snapshots at construction time, not first invocation', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
      const agent = new Agent({ model, name: 'test-agent', printer: false })
      const tool = new AgentAsTool({ agent })
      const messagesAtConstruction = agent.messages.length

      // Modify agent state after tool creation
      await agent.invoke('Direct invocation')
      expect(agent.messages.length).toBeGreaterThan(messagesAtConstruction)

      // First tool call restores to construction-time state, then runs
      const context1 = createMockContext({
        name: 'test-agent',
        toolUseId: 'tool-1',
        input: { input: 'Hello' },
      })
      await collectGenerator(tool.stream(context1))
      const messagesAfterFirstTool = agent.messages.length

      // Second tool call should produce the same count — both reset to construction baseline
      const context2 = createMockContext({
        name: 'test-agent',
        toolUseId: 'tool-2',
        input: { input: 'Hello again' },
      })
      await collectGenerator(tool.stream(context2))

      expect(agent.messages.length).toBe(messagesAfterFirstTool)
    })
  })

  describe('sessionManager validation', () => {
    const mockStorage: SnapshotStorage = {
      saveSnapshot: async () => {},
      loadSnapshot: async () => null,
      listSnapshotIds: async () => [],
      deleteSession: async () => {},
      loadManifest: async () => ({ schemaVersion: '1.0', updatedAt: '12:00:00' }),
      saveManifest: async () => {},
    }

    it('throws when preserveContext is false and agent has a sessionManager', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const sessionManager = new SessionManager({ storage: { snapshot: mockStorage } })
      const agent = new Agent({ model, name: 'test-agent', sessionManager })

      expect(() => new AgentAsTool({ agent })).toThrow(/SessionManager.*conflicts with preserveContext=false/)
    })

    it('throws when preserveContext is explicitly false and agent has a sessionManager', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const sessionManager = new SessionManager({ storage: { snapshot: mockStorage } })
      const agent = new Agent({ model, name: 'test-agent', sessionManager })

      expect(() => new AgentAsTool({ agent, preserveContext: false })).toThrow(
        /SessionManager.*conflicts with preserveContext=false/
      )
    })

    it('allows preserveContext true with sessionManager', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const sessionManager = new SessionManager({ storage: { snapshot: mockStorage } })
      const agent = new Agent({ model, name: 'test-agent', sessionManager })

      expect(() => new AgentAsTool({ agent, preserveContext: true })).not.toThrow()
    })
  })

  describe('Agent.asTool', () => {
    it('returns an AgentAsTool instance', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, name: 'researcher' })

      const tool = agent.asTool()

      expect(tool).toBeInstanceOf(AgentAsTool)
      expect(tool.name).toBe('researcher')
    })

    it('passes options through to AgentAsTool', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, name: 'researcher' })

      const tool = agent.asTool({ name: 'custom-name', description: 'Custom desc' })

      expect(tool.name).toBe('custom-name')
      expect(tool.description).toBe('Custom desc')
    })

    it('sets delegate and appends description suffix when delegate is true', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, name: 'specialist', description: 'Handles billing', printer: false })

      const tool = agent.asTool({ delegate: true }) as AgentAsTool

      expect(tool.delegate).toBe(true)
      expect(tool.description).toBe('Handles billing' + DELEGATION_DESCRIPTION_SUFFIX)
      expect(tool.toolSpec.description).toBe('Handles billing' + DELEGATION_DESCRIPTION_SUFFIX)
    })

    it('does not set delegate or append description suffix when delegate is false', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, name: 'specialist', description: 'Handles billing', printer: false })

      const tool = agent.asTool({ delegate: false }) as AgentAsTool

      expect(tool.delegate).toBe(false)
      expect(tool.description).toBe('Handles billing')
      expect(tool.description).not.toContain(DELEGATION_DESCRIPTION_SUFFIX)
    })
  })

  describe('Agent in ToolList', () => {
    it('auto-wraps Agent as AgentAsTool when passed in tools array', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const subAgent = new Agent({ model, name: 'sub-agent', description: 'A sub agent' })
      const parentAgent = new Agent({ model, tools: [subAgent] })

      const registeredTool = parentAgent.toolRegistry.get('sub-agent')
      expect(registeredTool).toBeInstanceOf(AgentAsTool)
      expect(registeredTool!.name).toBe('sub-agent')
    })

    it('auto-wraps Agent in nested tools arrays', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const subAgent = new Agent({ model, name: 'nested-agent' })
      const parentAgent = new Agent({ model, tools: [[subAgent]] })

      const registeredTool = parentAgent.toolRegistry.get('nested-agent')
      expect(registeredTool).toBeInstanceOf(AgentAsTool)
    })
  })
})
