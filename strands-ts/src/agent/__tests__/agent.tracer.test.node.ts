import { describe, expect, it, vi, beforeEach, type MockInstance } from 'vitest'
import { Agent } from '../agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import {
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  MaxTokensError,
  StructuredOutputError,
  Message,
} from '../../index.js'
import { AfterToolsEvent, BeforeToolsEvent } from '../../hooks/events.js'
import { InvokeModelStage } from '../../middleware/stages.js'
import { Tracer } from '../../telemetry/tracer.js'
import { z } from 'zod'

interface MockTracerInstance {
  startAgentSpan: MockInstance
  endAgentSpan: MockInstance
  startAgentLoopSpan: MockInstance
  endAgentLoopSpan: MockInstance
  startModelInvokeSpan: MockInstance
  endModelInvokeSpan: MockInstance
  startToolCallSpan: MockInstance
  endToolCallSpan: MockInstance
  withSpanContext: MockInstance
}

vi.mock('../../telemetry/tracer.js', () => ({
  Tracer: vi.fn(function () {
    return {
      startAgentSpan: vi.fn().mockReturnValue({ mock: 'agentSpan' }),
      endAgentSpan: vi.fn(),
      startAgentLoopSpan: vi.fn().mockReturnValue({ mock: 'loopSpan' }),
      endAgentLoopSpan: vi.fn(),
      startModelInvokeSpan: vi.fn().mockReturnValue({ mock: 'modelSpan' }),
      endModelInvokeSpan: vi.fn(),
      startToolCallSpan: vi.fn().mockReturnValue({ mock: 'toolSpan' }),
      endToolCallSpan: vi.fn(),
      withSpanContext: vi.fn((_span, fn) => fn()),
    }
  }),
}))

function getLatestTracer(): MockTracerInstance {
  return vi.mocked(Tracer).mock.results.at(-1)!.value
}

describe('Agent tracer integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('initializes Tracer with traceAttributes from config', () => {
      const traceAttributes = { 'custom.attr': 'value' }
      new Agent({ traceAttributes })

      expect(Tracer).toHaveBeenCalledWith(traceAttributes)
    })

    it('initializes Tracer without traceAttributes when not provided', () => {
      new Agent()

      expect(Tracer).toHaveBeenCalledWith(undefined)
    })
  })

  describe('name and id', () => {
    it('defaults name to "Strands Agent"', () => {
      const agent = new Agent()

      expect(agent.name).toBe('Strands Agent')
    })

    it('uses provided name', () => {
      const agent = new Agent({ name: 'My Agent' })

      expect(agent.name).toBe('My Agent')
    })

    it('defaults id to "agent"', () => {
      const agent = new Agent()

      expect(agent.id).toBe('agent')
    })

    it('uses provided id', () => {
      const agent = new Agent({ id: 'custom-id-123' })

      expect(agent.id).toBe('custom-id-123')
    })
  })

  describe('agent span lifecycle', () => {
    it('starts and ends agent span on successful invocation', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, name: 'TestAgent', id: 'test-id' })
      const tracer = getLatestTracer()

      await agent.invoke('Hi')

      expect(tracer.startAgentSpan).toHaveBeenCalledTimes(1)
      expect(tracer.startAgentSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'TestAgent',
          agentId: 'test-id',
          modelId: 'test-model',
        })
      )
      expect(tracer.endAgentSpan).toHaveBeenCalledTimes(1)
      expect(tracer.endAgentSpan).toHaveBeenCalledWith(
        { mock: 'agentSpan' },
        expect.objectContaining({
          response: expect.objectContaining({ role: 'assistant' }),
          stopReason: 'endTurn',
        })
      )
    })

    it('ends agent span with error when invocation fails', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Partial' }, { stopReason: 'maxTokens' })
      const agent = new Agent({ model })
      const tracer = getLatestTracer()

      await expect(agent.invoke('Hi')).rejects.toThrow(MaxTokensError)

      expect(tracer.startAgentSpan).toHaveBeenCalledTimes(1)
      expect(tracer.endAgentSpan).toHaveBeenCalledTimes(1)
      expect(tracer.endAgentSpan).toHaveBeenCalledWith(
        { mock: 'agentSpan' },
        expect.objectContaining({
          error: expect.any(MaxTokensError),
        })
      )
    })

    it('includes systemPrompt in agent span when configured', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, systemPrompt: 'Be helpful' })
      const tracer = getLatestTracer()

      await agent.invoke('Hi')

      expect(tracer.startAgentSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: 'Be helpful',
        })
      )
    })

    it('includes empty string systemPrompt in agent span', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, systemPrompt: '' })
      const tracer = getLatestTracer()

      await agent.invoke('Hi')

      expect(tracer.startAgentSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: '',
        })
      )
    })

    it('omits systemPrompt from agent span when not configured', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })
      const tracer = getLatestTracer()

      await agent.invoke('Hi')

      expect(tracer.startAgentSpan).toHaveBeenCalledWith(
        expect.not.objectContaining({
          systemPrompt: expect.anything(),
        })
      )
    })

    it('includes tools in agent span', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const tool = createMockTool(
        'myTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'id',
            status: 'success',
            content: [],
          })
      )
      const agent = new Agent({ model, tools: [tool] })
      const tracer = getLatestTracer()

      await agent.invoke('Hi')

      expect(tracer.startAgentSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining([expect.objectContaining({ name: 'myTool' })]),
        })
      )
    })
  })

  describe('agent loop span lifecycle', () => {
    // Guards https://github.com/strands-agents/harness-sdk/issues/3800: breaking out of the
    // public stream closes the generator mid-cycle and must still end the loop span
    // and record the meter cycle.
    it('ends the loop span once when the public stream iterator is closed mid-cycle', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)

      try {
        const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Done' })
        const agent = new Agent({ model })
        const tracer = getLatestTracer()

        for await (const event of agent.stream('Hi')) {
          if (event.type === 'messageAddedEvent') {
            vi.setSystemTime(60)
            break
          }
        }

        // The first messageAddedEvent is the user-message append, so the break
        // lands before the model call.
        expect(tracer.startModelInvokeSpan).not.toHaveBeenCalled()
        expect(tracer.startAgentLoopSpan).toHaveBeenCalledTimes(1)
        expect(tracer.endAgentLoopSpan).toHaveBeenCalledTimes(1)
        expect(tracer.endAgentLoopSpan).toHaveBeenCalledWith({ mock: 'loopSpan' })
        expect(agent.metrics.totalDuration).toBe(60)
        expect(agent.metrics.latestAgentInvocation?.cycles).toEqual([expect.objectContaining({ duration: 60 })])
      } finally {
        vi.useRealTimers()
      }
    })

    // Guards https://github.com/strands-agents/harness-sdk/issues/3800: the issue's
    // reported scenario is cancel() plus break while the model is streaming.
    it('ends the loop span once when the consumer cancels and breaks during model streaming', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Done' })
      const agent = new Agent({ model })
      const tracer = getLatestTracer()

      for await (const event of agent.stream('Hi')) {
        if (event.type === 'modelStreamUpdateEvent') {
          agent.cancel()
          break
        }
      }

      expect(tracer.startAgentLoopSpan).toHaveBeenCalledTimes(1)
      expect(tracer.endAgentLoopSpan).toHaveBeenCalledTimes(1)
      expect(tracer.endAgentLoopSpan).toHaveBeenCalledWith({ mock: 'loopSpan' })
    })

    it('closes cycle telemetry for every started cycle when the consumer breaks during tool execution', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })
      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('Result')],
          })
      )
      const agent = new Agent({ model, tools: [tool] })
      const tracer = getLatestTracer()

      for await (const event of agent.stream('Hi')) {
        if (event.type === 'toolResultEvent') break
      }

      // _streamCore's drain loop resumes the agent loop after the break, so the
      // invocation runs to completion; every started cycle must also close.
      expect(tracer.startAgentLoopSpan).toHaveBeenCalledTimes(2)
      expect(tracer.endAgentLoopSpan).toHaveBeenCalledTimes(2)
    })

    it('closes cycle telemetry once when an error is thrown after the cycle already closed', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)

      try {
        const model = new MockMessageModel().addTurn({
          type: 'toolUseBlock',
          name: 'testTool',
          toolUseId: 'tool-1',
          input: {},
        })
        const tool = createMockTool(
          'testTool',
          () =>
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success',
              content: [new TextBlock('Result')],
            })
        )
        const agent = new Agent({ model, tools: [tool] })
        const tracer = getLatestTracer()

        agent.addHook(BeforeToolsEvent, () => {
          vi.setSystemTime(60)
        })
        agent.addHook(AfterToolsEvent, (event: AfterToolsEvent) => {
          event.endTurn = true
        })

        // Cycle telemetry closes after tool execution; the endTurn message append
        // then throws, exercising the error-after-clean-close path.
        const push = agent.messages.push.bind(agent.messages)
        vi.spyOn(agent.messages, 'push').mockImplementation((...items: Message[]): number => {
          const isEndTurnMessage = items.some((message) =>
            message.content.some((block) => block.type === 'textBlock' && block.text.includes('Turn ended early'))
          )
          if (isEndTurnMessage) {
            throw new Error('append failed after cycle close')
          }
          return push(...items)
        })

        await expect(agent.invoke('Hi')).rejects.toThrow('append failed after cycle close')

        expect(tracer.endAgentLoopSpan).toHaveBeenCalledTimes(1)
        expect(tracer.endAgentLoopSpan).toHaveBeenCalledWith({ mock: 'loopSpan' })
        expect(agent.metrics.totalDuration).toBe(60)
      } finally {
        vi.useRealTimers()
      }
    })

    it('starts and ends loop span for each cycle', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Done' })
      const agent = new Agent({ model })
      const tracer = getLatestTracer()

      await agent.invoke('Hi')

      expect(tracer.startAgentLoopSpan).toHaveBeenCalledTimes(1)
      expect(tracer.startAgentLoopSpan).toHaveBeenCalledWith(expect.objectContaining({ cycleId: 'cycle-1' }))
      expect(tracer.endAgentLoopSpan).toHaveBeenCalledTimes(1)
      expect(tracer.endAgentLoopSpan).toHaveBeenCalledWith({ mock: 'loopSpan' })
    })

    it('creates multiple loop spans for multi-cycle invocations', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('Result')],
          })
      )

      const agent = new Agent({ model, tools: [tool] })
      const tracer = getLatestTracer()

      await agent.invoke('Use tool')

      expect(tracer.startAgentLoopSpan).toHaveBeenCalledTimes(2)
      expect(tracer.startAgentLoopSpan).toHaveBeenNthCalledWith(1, expect.objectContaining({ cycleId: 'cycle-1' }))
      expect(tracer.startAgentLoopSpan).toHaveBeenNthCalledWith(2, expect.objectContaining({ cycleId: 'cycle-2' }))
      expect(tracer.endAgentLoopSpan).toHaveBeenCalledTimes(2)
    })

    it('ends loop span with error when cycle fails', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Partial' }, { stopReason: 'maxTokens' })
      const agent = new Agent({ model })
      const tracer = getLatestTracer()

      await expect(agent.invoke('Hi')).rejects.toThrow(MaxTokensError)

      expect(tracer.endAgentLoopSpan).toHaveBeenCalledTimes(1)
      expect(tracer.endAgentLoopSpan).toHaveBeenCalledWith(
        { mock: 'loopSpan' },
        expect.objectContaining({ error: expect.any(MaxTokensError) })
      )
    })

    it('ends loop span for cycle where structured output forces tool choice', async () => {
      const schema = z.object({ value: z.number() })

      // Turn 1: model returns text (no tool use) → triggers forced tool choice on next cycle
      // Turn 2: model uses the structured output tool → tool succeeds, early exit
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'First response' })
        .addTurn({ type: 'toolUseBlock', name: 'strands_structured_output', toolUseId: 'tool-1', input: { value: 42 } })

      const agent = new Agent({ model, structuredOutputSchema: schema })
      const tracer = getLatestTracer()

      await agent.invoke('Test')

      // Forced call gets its own cycle for accurate metrics and tracing
      expect(tracer.startAgentLoopSpan).toHaveBeenCalledTimes(2)
      expect(tracer.startAgentLoopSpan).toHaveBeenNthCalledWith(1, expect.objectContaining({ cycleId: 'cycle-1' }))
      expect(tracer.startAgentLoopSpan).toHaveBeenNthCalledWith(2, expect.objectContaining({ cycleId: 'cycle-2' }))
      expect(tracer.endAgentLoopSpan).toHaveBeenCalledTimes(2)
    })
  })

  describe('model invoke span lifecycle', () => {
    it('ends the model invoke span once when the consumer breaks mid-model-response', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })
      const tracer = getLatestTracer()

      for await (const event of agent.stream('Hi')) {
        if (event.type === 'modelStreamUpdateEvent') break
      }

      expect(tracer.startModelInvokeSpan).toHaveBeenCalledTimes(1)
      expect(tracer.endModelInvokeSpan).toHaveBeenCalledTimes(1)
      expect(tracer.endModelInvokeSpan).toHaveBeenCalledWith({ mock: 'modelSpan' })
    })

    it('starts and ends model span on successful model call', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })
      const tracer = getLatestTracer()

      await agent.invoke('Hi')

      expect(tracer.startModelInvokeSpan).toHaveBeenCalledTimes(1)
      expect(tracer.startModelInvokeSpan).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'test-model' }))
      expect(tracer.endModelInvokeSpan).toHaveBeenCalledTimes(1)
      expect(tracer.endModelInvokeSpan).toHaveBeenCalledWith(
        { mock: 'modelSpan' },
        expect.objectContaining({
          output: expect.objectContaining({ role: 'assistant' }),
          stopReason: 'endTurn',
        })
      )
    })

    it('ends model span with error when model call fails', async () => {
      const model = new MockMessageModel().addTurn(new Error('Model failed'))
      const agent = new Agent({ model })
      const tracer = getLatestTracer()

      await expect(agent.invoke('Hi')).rejects.toThrow()

      expect(tracer.endModelInvokeSpan).toHaveBeenCalledTimes(1)
      expect(tracer.endModelInvokeSpan).toHaveBeenCalledWith(
        { mock: 'modelSpan' },
        expect.objectContaining({ error: expect.any(Error) })
      )
    })

    it('creates model span for each model call in multi-cycle invocation', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('Result')],
          })
      )

      const agent = new Agent({ model, tools: [tool] })
      const tracer = getLatestTracer()

      await agent.invoke('Use tool')

      expect(tracer.startModelInvokeSpan).toHaveBeenCalledTimes(2)
      expect(tracer.endModelInvokeSpan).toHaveBeenCalledTimes(2)
    })

    it('model span records post-middleware context when InvokeModelStage middleware transforms input', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Default response' })
      const selectedModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Selected response' })
      selectedModel.updateConfig({ modelId: 'selected-model' })
      const agent = new Agent({ model, systemPrompt: 'Original prompt' })
      const tracer = getLatestTracer()

      agent.addMiddleware(InvokeModelStage.Input, async (context) => ({
        ...context,
        model: selectedModel,
        systemPrompt: 'Transformed prompt',
      }))

      await agent.invoke('Hi')

      expect(tracer.startModelInvokeSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'selected-model',
          systemPrompt: 'Transformed prompt',
        })
      )
    })
  })

  describe('tool call span lifecycle', () => {
    it('starts and ends tool span for each tool execution', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: { key: 'val' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('Result')],
          })
      )

      const agent = new Agent({ model, tools: [tool] })
      const tracer = getLatestTracer()

      await agent.invoke('Use tool')

      expect(tracer.startToolCallSpan).toHaveBeenCalledTimes(1)
      expect(tracer.startToolCallSpan).toHaveBeenCalledWith({
        tool: expect.objectContaining({
          name: 'testTool',
          toolUseId: 'tool-1',
          input: { key: 'val' },
        }),
      })
      expect(tracer.endToolCallSpan).toHaveBeenCalledTimes(1)
      expect(tracer.endToolCallSpan).toHaveBeenCalledWith(
        { mock: 'toolSpan' },
        expect.objectContaining({
          toolResult: expect.objectContaining({ toolUseId: 'tool-1', status: 'success' }),
        })
      )
    })

    it('ends tool span with error when tool is not found', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'missingTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model })
      const tracer = getLatestTracer()

      await agent.invoke('Use tool')

      expect(tracer.endToolCallSpan).toHaveBeenCalledWith(
        { mock: 'toolSpan' },
        expect.objectContaining({
          toolResult: expect.objectContaining({ status: 'error' }),
        })
      )
    })

    it('ends tool span with error when tool throws', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'failTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('failTool', () => {
        throw new Error('Tool exploded')
      })

      const agent = new Agent({ model, tools: [tool] })
      const tracer = getLatestTracer()

      await agent.invoke('Use tool')

      expect(tracer.endToolCallSpan).toHaveBeenCalledWith(
        { mock: 'toolSpan' },
        expect.objectContaining({
          error: expect.any(Error),
          toolResult: expect.objectContaining({ status: 'error' }),
        })
      )
    })

    it('creates spans for multiple tool calls in a single turn', async () => {
      const model = new MockMessageModel()
        .addTurn([
          new ToolUseBlock({ name: 'tool1', toolUseId: 'id-1', input: {} }),
          new ToolUseBlock({ name: 'tool2', toolUseId: 'id-2', input: {} }),
        ])
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool1 = createMockTool(
        'tool1',
        () =>
          new ToolResultBlock({
            toolUseId: 'id-1',
            status: 'success',
            content: [new TextBlock('R1')],
          })
      )
      const tool2 = createMockTool(
        'tool2',
        () =>
          new ToolResultBlock({
            toolUseId: 'id-2',
            status: 'success',
            content: [new TextBlock('R2')],
          })
      )

      const agent = new Agent({ model, tools: [tool1, tool2] })
      const tracer = getLatestTracer()

      await agent.invoke('Use tools')

      expect(tracer.startToolCallSpan).toHaveBeenCalledTimes(2)
      expect(tracer.endToolCallSpan).toHaveBeenCalledTimes(2)
    })

    it('creates overlapping tool spans when toolExecutor is concurrent', async () => {
      const model = new MockMessageModel()
        .addTurn([
          new ToolUseBlock({ name: 'tool1', toolUseId: 'id-1', input: {} }),
          new ToolUseBlock({ name: 'tool2', toolUseId: 'id-2', input: {} }),
        ])
        .addTurn({ type: 'textBlock', text: 'Done' })

      // Tools sleep briefly so the concurrent executor has time to launch both
      // before either resolves. The assertions below check call order, not
      // wall-clock timing.
      const sleep = (ms: number) => new Promise<void>((r) => globalThis.setTimeout(r, ms))
      // eslint-disable-next-line require-yield
      async function* sleepThenReturn(toolUseId: string, text: string) {
        await sleep(20)
        return new ToolResultBlock({ toolUseId, status: 'success', content: [new TextBlock(text)] })
      }
      const tool1 = createMockTool('tool1', () => sleepThenReturn('id-1', 'R1'))
      const tool2 = createMockTool('tool2', () => sleepThenReturn('id-2', 'R2'))

      const agent = new Agent({ model, tools: [tool1, tool2], toolExecutor: 'concurrent' })
      const tracer = getLatestTracer()

      // Record span lifecycle events in order. Sequential execution would
      // produce [start:A, end:A, start:B, end:B]; concurrent execution
      // interleaves so both starts precede both ends.
      const events: string[] = []
      tracer.startToolCallSpan.mockImplementation((args: { tool: { toolUseId: string } }) => {
        events.push(`start:${args.tool.toolUseId}`)
        return { mock: 'toolSpan', id: args.tool.toolUseId }
      })
      tracer.endToolCallSpan.mockImplementation((span: { id: string } | null) => {
        if (span && 'id' in span) events.push(`end:${span.id}`)
      })

      await agent.invoke('Use tools')

      expect(tracer.startToolCallSpan).toHaveBeenCalledTimes(2)
      expect(tracer.endToolCallSpan).toHaveBeenCalledTimes(2)
      // Both starts happened before either end — i.e. the spans overlap.
      expect(events.slice(0, 2).sort()).toEqual(['start:id-1', 'start:id-2'])
      expect(events.slice(2, 4).sort()).toEqual(['end:id-1', 'end:id-2'])
    })
  })

  describe('token usage accumulation', () => {
    it('passes accumulated usage to endAgentSpan', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })
      const tracer = getLatestTracer()

      await agent.invoke('Hi')

      expect(tracer.endAgentSpan).toHaveBeenCalledWith(
        { mock: 'agentSpan' },
        expect.objectContaining({
          accumulatedUsage: expect.objectContaining({
            inputTokens: expect.any(Number),
            outputTokens: expect.any(Number),
            totalTokens: expect.any(Number),
          }),
        })
      )
    })
  })

  describe('null span handling', () => {
    it('completes successfully when startAgentSpan returns null', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })
      const tracer = getLatestTracer()
      tracer.startAgentSpan.mockReturnValue(null)

      const result = await agent.invoke('Hi')

      expect(result.stopReason).toBe('endTurn')
      expect(tracer.endAgentSpan).toHaveBeenCalledWith(null, expect.any(Object))
    })

    it('completes successfully when startAgentLoopSpan returns null', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })
      const tracer = getLatestTracer()
      tracer.startAgentLoopSpan.mockReturnValue(null)

      const result = await agent.invoke('Hi')

      expect(result.stopReason).toBe('endTurn')
      expect(tracer.endAgentLoopSpan).toHaveBeenCalledWith(null)
    })

    it('completes successfully when startModelInvokeSpan returns null', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })
      const tracer = getLatestTracer()
      tracer.startModelInvokeSpan.mockReturnValue(null)

      const result = await agent.invoke('Hi')

      expect(result.stopReason).toBe('endTurn')
    })

    it('completes successfully when startToolCallSpan returns null', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('Result')],
          })
      )

      const agent = new Agent({ model, tools: [tool] })
      const tracer = getLatestTracer()
      tracer.startToolCallSpan.mockReturnValue(null)

      const result = await agent.invoke('Use tool')

      expect(result.stopReason).toBe('endTurn')
      expect(tracer.endToolCallSpan).toHaveBeenCalledWith(null, expect.any(Object))
    })
  })

  describe('span context hierarchy', () => {
    it('resets accumulated usage on each invocation', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'First' })
        .addTurn({ type: 'textBlock', text: 'Second' })
      const agent = new Agent({ model })
      const tracer = getLatestTracer()

      await agent.invoke('First')
      await agent.invoke('Second')

      expect(tracer.startAgentSpan).toHaveBeenCalledTimes(2)
      expect(tracer.endAgentSpan).toHaveBeenCalledTimes(2)
    })
  })

  describe('structured output and telemetry interaction', () => {
    it('creates tool span for structured output tool execution', async () => {
      const schema = z.object({ value: z.number() })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'strands_structured_output', toolUseId: 'tool-1', input: { value: 42 } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, structuredOutputSchema: schema })
      const tracer = getLatestTracer()

      await agent.invoke('Test')

      expect(tracer.startToolCallSpan).toHaveBeenCalledWith({
        tool: expect.objectContaining({ name: 'strands_structured_output' }),
      })
      expect(tracer.endToolCallSpan).toHaveBeenCalledWith(
        { mock: 'toolSpan' },
        expect.objectContaining({
          toolResult: expect.objectContaining({ status: 'success' }),
        })
      )
    })

    it('ends agent span with error when model refuses structured output tool after forcing', async () => {
      const schema = z.object({ value: z.number() })

      // Single-turn model always returns text — first normally, then when forced
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'I refuse' })

      const agent = new Agent({ model, structuredOutputSchema: schema })
      const tracer = getLatestTracer()

      await expect(agent.invoke('Test')).rejects.toThrow(StructuredOutputError)

      expect(tracer.endAgentSpan).toHaveBeenCalledWith(
        { mock: 'agentSpan' },
        expect.objectContaining({ error: expect.any(StructuredOutputError) })
      )
    })

    it('ends cycle span with error on StructuredOutputError', async () => {
      const schema = z.object({ value: z.number() })

      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'I refuse' })

      const agent = new Agent({ model, structuredOutputSchema: schema })
      const tracer = getLatestTracer()

      await expect(agent.invoke('Test')).rejects.toThrow(StructuredOutputError)

      // Cycle 1: model returns text, triggers forced tool choice on next cycle
      // Cycle 2: model still returns text, throws StructuredOutputError
      expect(tracer.startAgentLoopSpan).toHaveBeenCalledTimes(2)
      expect(tracer.endAgentLoopSpan).toHaveBeenCalledTimes(2)
      expect(tracer.endAgentLoopSpan).toHaveBeenNthCalledWith(1, { mock: 'loopSpan' })
      expect(tracer.endAgentLoopSpan).toHaveBeenNthCalledWith(
        2,
        { mock: 'loopSpan' },
        expect.objectContaining({ error: expect.any(StructuredOutputError) })
      )
    })

    it('ends agent span with result on successful structured output', async () => {
      const schema = z.object({ value: z.number() })

      // Model calls structured output tool → early exit after successful validation
      const model = new MockMessageModel().addTurn({
        type: 'toolUseBlock',
        name: 'strands_structured_output',
        toolUseId: 'tool-1',
        input: { value: 42 },
      })

      const agent = new Agent({ model, structuredOutputSchema: schema })
      const tracer = getLatestTracer()

      await agent.invoke('Test')

      expect(tracer.endAgentSpan).toHaveBeenCalledWith(
        { mock: 'agentSpan' },
        expect.objectContaining({
          response: expect.objectContaining({ role: 'assistant' }),
          stopReason: 'toolUse',
        })
      )
    })

    it('creates correct spans for validation retry cycle', async () => {
      const schema = z.object({ name: z.string(), age: z.number() })

      // Turn 1: invalid input → tool returns error, loop continues
      // Turn 2: valid input → tool succeeds, early exit
      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'tool-1',
          input: { name: 'John', age: 'not-a-number' },
        })
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'tool-2',
          input: { name: 'John', age: 30 },
        })

      const agent = new Agent({ model, structuredOutputSchema: schema })
      const tracer = getLatestTracer()

      await agent.invoke('Test')

      // 2 cycles: invalid tool use, valid tool use with early exit
      expect(tracer.startAgentLoopSpan).toHaveBeenCalledTimes(2)
      expect(tracer.startAgentLoopSpan).toHaveBeenNthCalledWith(1, expect.objectContaining({ cycleId: 'cycle-1' }))
      expect(tracer.startAgentLoopSpan).toHaveBeenNthCalledWith(2, expect.objectContaining({ cycleId: 'cycle-2' }))
      expect(tracer.endAgentLoopSpan).toHaveBeenCalledTimes(2)
      expect(tracer.endAgentLoopSpan).toHaveBeenNthCalledWith(1, { mock: 'loopSpan' })
      expect(tracer.endAgentLoopSpan).toHaveBeenNthCalledWith(2, { mock: 'loopSpan' })

      // 2 model calls, one per cycle
      expect(tracer.startModelInvokeSpan).toHaveBeenCalledTimes(2)
      expect(tracer.endModelInvokeSpan).toHaveBeenCalledTimes(2)
      for (let i = 1; i <= 2; i++) {
        expect(tracer.endModelInvokeSpan).toHaveBeenNthCalledWith(
          i,
          { mock: 'modelSpan' },
          expect.objectContaining({ output: expect.objectContaining({ role: 'assistant' }) })
        )
      }

      // 2 tool calls: first with validation error, second succeeds
      expect(tracer.startToolCallSpan).toHaveBeenCalledTimes(2)
      expect(tracer.startToolCallSpan).toHaveBeenNthCalledWith(1, {
        tool: expect.objectContaining({ name: 'strands_structured_output', toolUseId: 'tool-1' }),
      })
      expect(tracer.startToolCallSpan).toHaveBeenNthCalledWith(2, {
        tool: expect.objectContaining({ name: 'strands_structured_output', toolUseId: 'tool-2' }),
      })
      expect(tracer.endToolCallSpan).toHaveBeenCalledTimes(2)
      expect(tracer.endToolCallSpan).toHaveBeenNthCalledWith(
        1,
        { mock: 'toolSpan' },
        expect.objectContaining({
          toolResult: expect.objectContaining({ toolUseId: 'tool-1', status: 'error' }),
        })
      )
      expect(tracer.endToolCallSpan).toHaveBeenNthCalledWith(
        2,
        { mock: 'toolSpan' },
        expect.objectContaining({
          toolResult: expect.objectContaining({ toolUseId: 'tool-2', status: 'success' }),
        })
      )
    })

    it('ends agent span with error on maxTokens with structured output schema', async () => {
      const schema = z.object({ value: z.number() })

      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Partial' }, { stopReason: 'maxTokens' })

      const agent = new Agent({ model, structuredOutputSchema: schema })
      const tracer = getLatestTracer()

      await expect(agent.invoke('Test')).rejects.toThrow(MaxTokensError)

      expect(tracer.endAgentSpan).toHaveBeenCalledWith(
        { mock: 'agentSpan' },
        expect.objectContaining({ error: expect.any(MaxTokensError) })
      )
      expect(tracer.endAgentLoopSpan).toHaveBeenCalledWith(
        { mock: 'loopSpan' },
        expect.objectContaining({ error: expect.any(MaxTokensError) })
      )
    })
  })
})
