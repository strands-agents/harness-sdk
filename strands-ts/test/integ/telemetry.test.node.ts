import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { Agent, tool } from '@strands-agents/sdk'
import { getTracer, getMeter } from '@strands-agents/sdk/telemetry'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { SpanStatusCode, trace, context, metrics as otelMetrics } from '@opentelemetry/api'
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics'
import { z } from 'zod'
import { MockMessageModel } from '$/sdk/__fixtures__/mock-message-model.js'
import { TestModelProvider, collectGenerator } from '$/sdk/__fixtures__/model-test-helpers.js'
import { findMetricValue } from '$/sdk/__fixtures__/metrics-helpers.js'

const AGENT_SPAN_PREFIX = 'invoke_agent'
const CYCLE_SPAN_NAME = 'execute_agent_loop_cycle'
const MODEL_SPAN_NAME = 'chat'
const TOOL_SPAN_PREFIX = 'execute_tool'

// Shared provider and exporter — registered once, reset between tests
let provider: NodeTracerProvider
let exporter: InMemorySpanExporter

function getSpans(): ReadableSpan[] {
  return [...exporter.getFinishedSpans()].sort(
    // Compare OTel HrTime [seconds, nanoseconds] — seconds first, then nanoseconds as tiebreaker
    (a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1]
  )
}

function findSpans(spans: ReadableSpan[], prefix: string): ReadableSpan[] {
  return spans.filter((s) => s.name.startsWith(prefix))
}

function assertParentChild(parent: ReadableSpan, child: ReadableSpan): void {
  expect(child.spanContext().traceId).toBe(parent.spanContext().traceId)
  expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
}

function attr(span: ReadableSpan, key: string): unknown {
  return span.attributes[key]
}

const calculatorTool = tool({
  name: 'calculator',
  description: 'Add two numbers',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  callback: ({ a, b }) => `${a + b}`,
})

const failingTool = tool({
  name: 'failing_tool',
  description: 'Always fails',
  inputSchema: z.object({}),
  callback: () => {
    throw new Error('tool exploded')
  },
})

describe.sequential('Telemetry Integration', () => {
  beforeAll(() => {
    exporter = new InMemorySpanExporter()
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
    provider.register()
  })

  beforeEach(() => {
    exporter.reset()
  })

  afterAll(async () => {
    await provider.forceFlush()
    await provider.shutdown()
  })

  /**
   * Flush and return all spans captured during the current test.
   */
  async function flush(): Promise<ReadableSpan[]> {
    await provider.forceFlush()
    return getSpans()
  }

  describe('span hierarchy', () => {
    it('creates agent → cycle → model spans for a simple invocation', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello back' })
      const agent = new Agent({ model, printer: false, name: 'hierarchy-agent' })

      await agent.invoke('Hi')

      const spans = await flush()
      const agentSpans = findSpans(spans, AGENT_SPAN_PREFIX)
      const cycleSpans = findSpans(spans, CYCLE_SPAN_NAME)
      const modelSpans = findSpans(spans, MODEL_SPAN_NAME)

      expect(agentSpans).toHaveLength(1)
      expect(cycleSpans).toHaveLength(1)
      expect(modelSpans).toHaveLength(1)

      // Verify span names
      expect(agentSpans[0]!.name).toBe('invoke_agent hierarchy-agent')
      expect(cycleSpans[0]!.name).toBe('execute_agent_loop_cycle')
      expect(modelSpans[0]!.name).toBe('chat')

      assertParentChild(agentSpans[0]!, cycleSpans[0]!)
      assertParentChild(cycleSpans[0]!, modelSpans[0]!)
    })

    it('creates tool spans nested under cycle spans', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'calculator', toolUseId: 'tool-1', input: { a: 1, b: 2 } })
        .addTurn({ type: 'textBlock', text: 'The answer is 3' })

      const agent = new Agent({ model, printer: false, name: 'tool-agent', tools: [calculatorTool] })

      await agent.invoke('Add 1 and 2')

      const spans = await flush()
      const agentSpans = findSpans(spans, AGENT_SPAN_PREFIX)
      const cycleSpans = findSpans(spans, CYCLE_SPAN_NAME)
      const modelSpans = findSpans(spans, MODEL_SPAN_NAME)
      const toolSpans = findSpans(spans, TOOL_SPAN_PREFIX)

      // Verify exact span counts and names
      expect(agentSpans.map((s) => s.name)).toStrictEqual(['invoke_agent tool-agent'])
      expect(cycleSpans).toHaveLength(2)
      expect(modelSpans).toHaveLength(2)
      expect(toolSpans.map((s) => s.name)).toStrictEqual(['execute_tool calculator'])

      // Both cycles parent to agent
      assertParentChild(agentSpans[0]!, cycleSpans[0]!)
      assertParentChild(agentSpans[0]!, cycleSpans[1]!)

      // Tool span parents to first cycle
      assertParentChild(cycleSpans[0]!, toolSpans[0]!)

      // All spans share the same trace ID
      const traceId = agentSpans[0]!.spanContext().traceId
      for (const span of spans) {
        expect(span.spanContext().traceId).toBe(traceId)
      }
    })

    it('creates correct hierarchy for multi-tool invocation in a single cycle', async () => {
      const echoTool = tool({
        name: 'echo',
        description: 'Echo input',
        inputSchema: z.object({ text: z.string() }),
        callback: ({ text }) => text,
      })

      const model = new MockMessageModel()
        .addTurn([
          { type: 'toolUseBlock', name: 'calculator', toolUseId: 'tool-1', input: { a: 1, b: 2 } },
          { type: 'toolUseBlock', name: 'echo', toolUseId: 'tool-2', input: { text: 'hello' } },
        ])
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, printer: false, name: 'multi-tool-agent', tools: [calculatorTool, echoTool] })

      await agent.invoke('Do both')

      const spans = await flush()
      const toolSpans = findSpans(spans, TOOL_SPAN_PREFIX)
      const cycleSpans = findSpans(spans, CYCLE_SPAN_NAME)

      expect(toolSpans.map((s) => s.name)).toStrictEqual(['execute_tool calculator', 'execute_tool echo'])
      assertParentChild(cycleSpans[0]!, toolSpans[0]!)
      assertParentChild(cycleSpans[0]!, toolSpans[1]!)
    })
  })

  describe('span attributes', () => {
    it('sets agent span attributes correctly', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({
        model,
        printer: false,
        name: 'attr-agent',
        systemPrompt: 'You are helpful',
        tools: [calculatorTool],
        traceAttributes: { 'app.custom': 'value' },
      })

      await agent.invoke('Hello')

      const spans = await flush()
      const agentSpan = findSpans(spans, AGENT_SPAN_PREFIX)[0]!

      expect(attr(agentSpan, 'gen_ai.operation.name')).toBe('invoke_agent')
      expect(attr(agentSpan, 'gen_ai.agent.name')).toBe('attr-agent')
      expect(attr(agentSpan, 'gen_ai.request.model')).toBe('test-model')
      expect(attr(agentSpan, 'app.custom')).toBe('value')
      expect(attr(agentSpan, 'system_prompt')).toBe('"You are helpful"')

      const toolNames = attr(agentSpan, 'gen_ai.agent.tools') as string
      expect(JSON.parse(toolNames)).toStrictEqual(['calculator'])
    })

    it('sets model span attributes correctly', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
      const agent = new Agent({ model, printer: false, name: 'model-attr-agent' })

      await agent.invoke('Hello')

      const spans = await flush()
      const modelSpan = findSpans(spans, MODEL_SPAN_NAME)[0]!

      expect(attr(modelSpan, 'gen_ai.operation.name')).toBe('chat')
      expect(attr(modelSpan, 'gen_ai.request.model')).toBe('test-model')

      const choiceEvent = modelSpan.events.find((e) => e.name === 'gen_ai.choice')
      expect(choiceEvent).toBeDefined()
      expect(JSON.parse(choiceEvent!.attributes!['message'] as string)).toStrictEqual([{ text: 'Response' }])
    })

    it('sets tool span attributes correctly', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'calculator', toolUseId: 'tool-42', input: { a: 5, b: 3 } })
        .addTurn({ type: 'textBlock', text: '8' })

      const agent = new Agent({ model, printer: false, name: 'tool-attr-agent', tools: [calculatorTool] })

      await agent.invoke('Add 5 and 3')

      const spans = await flush()
      const toolSpan = findSpans(spans, TOOL_SPAN_PREFIX)[0]!

      expect(attr(toolSpan, 'gen_ai.operation.name')).toBe('execute_tool')
      expect(attr(toolSpan, 'gen_ai.tool.name')).toBe('calculator')
      expect(attr(toolSpan, 'gen_ai.tool.call.id')).toBe('tool-42')

      const choiceEvent = toolSpan.events.find((e) => e.name === 'gen_ai.choice')
      expect(choiceEvent).toBeDefined()
      expect(choiceEvent!.attributes!['id']).toBe('tool-42')
      expect(JSON.parse(choiceEvent!.attributes!['message'] as string)).toStrictEqual([{ text: '8' }])
    })

    it('sets cycle span attributes correctly', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Done' })
      const agent = new Agent({ model, printer: false, name: 'cycle-attr-agent' })

      await agent.invoke('Hello')

      const spans = await flush()
      const cycleSpan = findSpans(spans, CYCLE_SPAN_NAME)[0]!

      expect(attr(cycleSpan, 'agent_loop.cycle_id')).toBe('cycle-1')
    })
  })

  describe('custom trace attributes', () => {
    it('merges constructor-level trace attributes onto agent span', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({
        model,
        printer: false,
        name: 'custom-attr-agent',
        traceAttributes: { 'app.module': 'weather', 'app.version': '1.0.0' },
      })

      await agent.invoke('Hello')

      const spans = await flush()
      const agentSpan = findSpans(spans, AGENT_SPAN_PREFIX)[0]!

      expect(attr(agentSpan, 'app.module')).toBe('weather')
      expect(attr(agentSpan, 'app.version')).toBe('1.0.0')
    })

    it('traceAttributes override SDK-computed attributes for colliding keys', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({
        model,
        printer: false,
        name: 'override-agent',
        traceAttributes: { 'gen_ai.agent.name': 'custom-name', 'gen_ai.request.model': 'custom-model' },
      })

      await agent.invoke('Hello')

      const spans = await flush()
      const agentSpan = findSpans(spans, AGENT_SPAN_PREFIX)[0]!

      expect(attr(agentSpan, 'gen_ai.agent.name')).toBe('custom-name')
      expect(attr(agentSpan, 'gen_ai.request.model')).toBe('custom-model')
    })
  })

  describe('stop reason propagation', () => {
    it('records stop reason in agent span response event', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Final answer' })
      const agent = new Agent({ model, printer: false, name: 'stop-reason-agent' })

      await agent.invoke('Hello')

      const spans = await flush()
      const agentSpan = findSpans(spans, AGENT_SPAN_PREFIX)[0]!

      const choiceEvent = agentSpan.events.find((e) => e.name === 'gen_ai.choice')
      expect(choiceEvent).toBeDefined()
      expect(choiceEvent!.attributes!['finish_reason']).toBe('endTurn')
      expect(choiceEvent!.attributes!['message']).toBe('Final answer')
    })

    it('records stop reason in model span output event', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
      const agent = new Agent({ model, printer: false, name: 'model-stop-agent' })

      await agent.invoke('Hello')

      const spans = await flush()
      const modelSpan = findSpans(spans, MODEL_SPAN_NAME)[0]!

      const choiceEvent = modelSpan.events.find((e) => e.name === 'gen_ai.choice')
      expect(choiceEvent).toBeDefined()
      expect(choiceEvent!.attributes!['finish_reason']).toBe('endTurn')

      const message = JSON.parse(choiceEvent!.attributes!['message'] as string)
      expect(message).toStrictEqual([{ text: 'Response' }])
    })
  })

  describe('error handling', () => {
    it('records error status on agent span when model throws', async () => {
      const model = new MockMessageModel().addTurn(new Error('Model failed'))
      const agent = new Agent({ model, printer: false, name: 'error-agent' })

      await expect(agent.invoke('Hello')).rejects.toThrow()

      const spans = await flush()
      const agentSpan = findSpans(spans, AGENT_SPAN_PREFIX)[0]!

      expect(agentSpan.status.code).toBe(SpanStatusCode.ERROR)
      expect(agentSpan.status.message).toBe('Model failed')
    })

    it('records error status and exception event on model span when model throws', async () => {
      const model = new MockMessageModel().addTurn(new Error('Model failed'))
      const agent = new Agent({ model, printer: false, name: 'model-error-agent' })

      await expect(agent.invoke('Hello')).rejects.toThrow()

      const spans = await flush()
      const modelSpan = findSpans(spans, MODEL_SPAN_NAME)[0]!

      expect(modelSpan.status.code).toBe(SpanStatusCode.ERROR)
      expect(modelSpan.status.message).toBe('Model failed')

      const exceptionEvent = modelSpan.events.find((e) => e.name === 'exception')
      expect(exceptionEvent).toBeDefined()
      expect(exceptionEvent!.attributes!['exception.message']).toBe('Model failed')
    })

    it('records error status and exception event on tool span when tool throws', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'failing_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Handled the error' })

      const agent = new Agent({ model, printer: false, name: 'tool-error-agent', tools: [failingTool] })

      await agent.invoke('Do something')

      const spans = await flush()
      const toolSpan = findSpans(spans, TOOL_SPAN_PREFIX)[0]!

      expect(toolSpan.status.code).toBe(SpanStatusCode.ERROR)
      expect(toolSpan.status.message).toBe('tool exploded')

      const exceptionEvent = toolSpan.events.find((e) => e.name === 'exception')
      expect(exceptionEvent).toBeDefined()
      expect(exceptionEvent!.attributes!['exception.message']).toBe('tool exploded')
    })

    it('records error on cycle span when model throws mid-loop', async () => {
      const model = new MockMessageModel().addTurn(new Error('Cycle failure'))
      const agent = new Agent({ model, printer: false, name: 'cycle-error-agent' })

      await expect(agent.invoke('Hello')).rejects.toThrow()

      const spans = await flush()
      const cycleSpan = findSpans(spans, CYCLE_SPAN_NAME)[0]!

      expect(cycleSpan.status.code).toBe(SpanStatusCode.ERROR)
      expect(cycleSpan.status.message).toBe('Cycle failure')
    })

    it('sets OK status on all spans for successful invocations', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'All good' })
      const agent = new Agent({ model, printer: false, name: 'ok-agent' })

      await agent.invoke('Hello')

      const spans = await flush()
      for (const span of spans) {
        expect(span.status.code).toBe(SpanStatusCode.OK)
      }
    })
  })

  describe('multi-cycle agent loops', () => {
    it('creates separate cycle spans for each loop iteration', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'calculator', toolUseId: 'tool-1', input: { a: 1, b: 2 } })
        .addTurn({ type: 'toolUseBlock', name: 'calculator', toolUseId: 'tool-2', input: { a: 3, b: 4 } })
        .addTurn({ type: 'textBlock', text: 'All done' })

      const agent = new Agent({ model, printer: false, name: 'multi-cycle-agent', tools: [calculatorTool] })

      await agent.invoke('Do two calculations')

      const spans = await flush()
      const agentSpans = findSpans(spans, AGENT_SPAN_PREFIX)
      const cycleSpans = findSpans(spans, CYCLE_SPAN_NAME)
      const modelSpans = findSpans(spans, MODEL_SPAN_NAME)
      const toolSpans = findSpans(spans, TOOL_SPAN_PREFIX)

      expect(agentSpans.map((s) => s.name)).toStrictEqual(['invoke_agent multi-cycle-agent'])
      expect(cycleSpans).toHaveLength(3)
      expect(modelSpans).toHaveLength(3)
      expect(toolSpans.map((s) => s.name)).toStrictEqual(['execute_tool calculator', 'execute_tool calculator'])

      expect(cycleSpans.map((s) => attr(s, 'agent_loop.cycle_id'))).toStrictEqual(['cycle-1', 'cycle-2', 'cycle-3'])

      for (const cycle of cycleSpans) {
        assertParentChild(agentSpans[0]!, cycle)
      }
    })
  })

  describe('streaming', () => {
    it('creates the same span hierarchy when using stream()', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'calculator', toolUseId: 'tool-1', input: { a: 2, b: 3 } })
        .addTurn({ type: 'textBlock', text: '5' })

      const agent = new Agent({ model, printer: false, name: 'stream-agent', tools: [calculatorTool] })

      await collectGenerator(agent.stream('Add 2 and 3'))

      const spans = await flush()
      const agentSpans = findSpans(spans, AGENT_SPAN_PREFIX)
      const cycleSpans = findSpans(spans, CYCLE_SPAN_NAME)
      const modelSpans = findSpans(spans, MODEL_SPAN_NAME)
      const toolSpans = findSpans(spans, TOOL_SPAN_PREFIX)

      expect(agentSpans.map((s) => s.name)).toStrictEqual(['invoke_agent stream-agent'])
      expect(cycleSpans).toHaveLength(2)
      expect(modelSpans).toHaveLength(2)
      expect(toolSpans.map((s) => s.name)).toStrictEqual(['execute_tool calculator'])

      assertParentChild(agentSpans[0]!, cycleSpans[0]!)
      assertParentChild(agentSpans[0]!, cycleSpans[1]!)
      assertParentChild(cycleSpans[0]!, toolSpans[0]!)
      assertParentChild(cycleSpans[0]!, modelSpans[0]!)
      assertParentChild(cycleSpans[1]!, modelSpans[1]!)

      // All spans OK
      for (const span of spans) {
        expect(span.status.code).toBe(SpanStatusCode.OK)
      }

      // Verify tool output content
      const toolSpan = toolSpans[0]!
      const toolChoiceEvent = toolSpan.events.find((e) => e.name === 'gen_ai.choice')
      expect(toolChoiceEvent).toBeDefined()
      expect(JSON.parse(toolChoiceEvent!.attributes!['message'] as string)).toStrictEqual([{ text: '5' }])
    })
  })

  describe('span timing', () => {
    it('sets ISO 8601 start and end time attributes on all spans', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Done' })
      const agent = new Agent({ model, printer: false, name: 'timing-agent' })

      await agent.invoke('Hello')

      const spans = await flush()
      const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      for (const span of spans) {
        const startTime = attr(span, 'gen_ai.event.start_time') as string
        const endTime = attr(span, 'gen_ai.event.end_time') as string
        expect(startTime).toMatch(isoPattern)
        expect(endTime).toMatch(isoPattern)
        expect(new Date(startTime).getTime()).toBeLessThanOrEqual(new Date(endTime).getTime())
      }
    })
  })

  describe('span events', () => {
    it('records user message and response choice events on agent span', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello there' })
      const agent = new Agent({ model, printer: false, name: 'events-agent' })

      await agent.invoke('Hi')

      const spans = await flush()
      const agentSpan = findSpans(spans, AGENT_SPAN_PREFIX)[0]!

      const userEvent = agentSpan.events.find((e) => e.name === 'gen_ai.user.message')
      expect(userEvent).toBeDefined()
      const userContent = JSON.parse(userEvent!.attributes!['content'] as string)
      expect(userContent).toStrictEqual([{ text: 'Hi' }])

      const choiceEvent = agentSpan.events.find((e) => e.name === 'gen_ai.choice')
      expect(choiceEvent).toBeDefined()
      expect(choiceEvent!.attributes!['message']).toBe('Hello there')
      expect(choiceEvent!.attributes!['finish_reason']).toBe('endTurn')
    })

    it('records tool input and output events with correct data on tool span', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'calculator', toolUseId: 'tool-1', input: { a: 10, b: 20 } })
        .addTurn({ type: 'textBlock', text: '30' })

      const agent = new Agent({ model, printer: false, name: 'tool-events-agent', tools: [calculatorTool] })

      await agent.invoke('Add 10 and 20')

      const spans = await flush()
      const toolSpan = findSpans(spans, TOOL_SPAN_PREFIX)[0]!

      const toolInputEvent = toolSpan.events.find((e) => e.name === 'gen_ai.tool.message')
      expect(toolInputEvent).toBeDefined()
      expect(toolInputEvent!.attributes!['role']).toBe('tool')
      expect(JSON.parse(toolInputEvent!.attributes!['content'] as string)).toStrictEqual({ a: 10, b: 20 })
      expect(toolInputEvent!.attributes!['id']).toBe('tool-1')

      const toolOutputEvent = toolSpan.events.find((e) => e.name === 'gen_ai.choice')
      expect(toolOutputEvent).toBeDefined()
      expect(toolOutputEvent!.attributes!['id']).toBe('tool-1')
      expect(JSON.parse(toolOutputEvent!.attributes!['message'] as string)).toStrictEqual([{ text: '30' }])
    })
  })

  describe('token usage accumulation', () => {
    it('reports per-call usage only on chat spans, not the agent span', async () => {
      let callCount = 0
      const model = new TestModelProvider(() => {
        callCount++
        return (async function* () {
          yield { type: 'modelMessageStartEvent' as const, role: 'assistant' as const }

          if (callCount === 1) {
            // First call: tool use
            yield {
              type: 'modelContentBlockStartEvent' as const,
              start: { type: 'toolUseStart' as const, name: 'calculator', toolUseId: 'tool-1' },
            }
            yield {
              type: 'modelContentBlockDeltaEvent' as const,
              delta: { type: 'toolUseInputDelta' as const, input: '{"a":1,"b":2}' },
            }
            yield { type: 'modelContentBlockStopEvent' as const }
            yield { type: 'modelMessageStopEvent' as const, stopReason: 'toolUse' as const }
            yield {
              type: 'modelMetadataEvent' as const,
              usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            }
          } else {
            // Second call: text response
            yield { type: 'modelContentBlockStartEvent' as const }
            yield {
              type: 'modelContentBlockDeltaEvent' as const,
              delta: { type: 'textDelta' as const, text: 'The answer is 3' },
            }
            yield { type: 'modelContentBlockStopEvent' as const }
            yield { type: 'modelMessageStopEvent' as const, stopReason: 'endTurn' as const }
            yield {
              type: 'modelMetadataEvent' as const,
              usage: { inputTokens: 200, outputTokens: 75, totalTokens: 275 },
            }
          }
        })()
      })

      const agent = new Agent({ model, printer: false, name: 'usage-agent', tools: [calculatorTool] })

      await agent.invoke('Add 1 and 2')

      const spans = await flush()
      const agentSpan = findSpans(spans, AGENT_SPAN_PREFIX)[0]!
      const chatSpans = findSpans(spans, MODEL_SPAN_NAME)

      // Usage is reported exactly once per model call, on the chat spans only.
      // The agent span must carry no usage attributes (no accumulated re-emission).
      expect(attr(agentSpan, 'gen_ai.usage.input_tokens')).toBeUndefined()
      expect(attr(agentSpan, 'gen_ai.usage.output_tokens')).toBeUndefined()
      expect(attr(agentSpan, 'gen_ai.usage.total_tokens')).toBeUndefined()
      expect(attr(agentSpan, 'gen_ai.usage.prompt_tokens')).toBeUndefined()
      expect(attr(agentSpan, 'gen_ai.usage.completion_tokens')).toBeUndefined()

      // Agent-level totals are obtained by summing the chat spans: 100+200=300 input,
      // 50+75=125 output, 150+275=425 total.
      expect(chatSpans).toHaveLength(2)
      const sum = (key: string) => chatSpans.reduce((acc, s) => acc + ((attr(s, key) as number | undefined) ?? 0), 0)
      expect(sum('gen_ai.usage.input_tokens')).toBe(300)
      expect(sum('gen_ai.usage.output_tokens')).toBe(125)
      expect(sum('gen_ai.usage.total_tokens')).toBe(425)
    })

    it('records per-call usage on individual model spans', async () => {
      let callCount = 0
      const model = new TestModelProvider(() => {
        callCount++
        return (async function* () {
          yield { type: 'modelMessageStartEvent' as const, role: 'assistant' as const }
          yield { type: 'modelContentBlockStartEvent' as const }
          yield {
            type: 'modelContentBlockDeltaEvent' as const,
            delta: { type: 'textDelta' as const, text: `Response ${callCount}` },
          }
          yield { type: 'modelContentBlockStopEvent' as const }
          yield { type: 'modelMessageStopEvent' as const, stopReason: 'endTurn' as const }
          yield {
            type: 'modelMetadataEvent' as const,
            usage: { inputTokens: callCount * 10, outputTokens: callCount * 5, totalTokens: callCount * 15 },
          }
        })()
      })

      const agent = new Agent({ model, printer: false, name: 'model-usage-agent' })

      await agent.invoke('Hello')

      const spans = await flush()
      const modelSpan = findSpans(spans, MODEL_SPAN_NAME)[0]!

      expect(attr(modelSpan, 'gen_ai.usage.input_tokens')).toBe(10)
      expect(attr(modelSpan, 'gen_ai.usage.output_tokens')).toBe(5)
      expect(attr(modelSpan, 'gen_ai.usage.total_tokens')).toBe(15)
    })
  })

  describe('concurrent agents', () => {
    it('creates isolated traces for concurrent agent invocations', async () => {
      const model1 = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Agent 1 response' })
      const model2 = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Agent 2 response' })

      const agent1 = new Agent({ model: model1, printer: false, name: 'agent-1' })
      const agent2 = new Agent({ model: model2, printer: false, name: 'agent-2' })

      await Promise.all([agent1.invoke('Hello 1'), agent2.invoke('Hello 2')])

      const spans = await flush()
      const agentSpans = findSpans(spans, AGENT_SPAN_PREFIX)

      expect(agentSpans).toHaveLength(2)

      const spanNames = agentSpans.map((s) => s.name).sort()
      expect(spanNames).toStrictEqual(['invoke_agent agent-1', 'invoke_agent agent-2'])

      // Each agent gets its own trace
      const traceIds = new Set(agentSpans.map((s) => s.spanContext().traceId))
      expect(traceIds.size).toBe(2)

      // Each trace has its own complete hierarchy
      for (const agentSpan of agentSpans) {
        const traceId = agentSpan.spanContext().traceId
        const traceSpans = spans.filter((s) => s.spanContext().traceId === traceId)
        const traceCycles = findSpans(traceSpans, CYCLE_SPAN_NAME)
        const traceModels = findSpans(traceSpans, MODEL_SPAN_NAME)

        expect(traceCycles).toHaveLength(1)
        expect(traceModels).toHaveLength(1)
        assertParentChild(agentSpan, traceCycles[0]!)
        assertParentChild(traceCycles[0]!, traceModels[0]!)
      }
    })

    it('creates isolated traces for same-named concurrent agents', async () => {
      const model1 = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response A' })
      const model2 = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response B' })

      const agent1 = new Agent({ model: model1, printer: false, name: 'shared-name' })
      const agent2 = new Agent({ model: model2, printer: false, name: 'shared-name' })

      await Promise.all([agent1.invoke('Hello 1'), agent2.invoke('Hello 2')])

      const spans = await flush()
      const agentSpans = findSpans(spans, AGENT_SPAN_PREFIX)

      expect(agentSpans).toHaveLength(2)
      expect(agentSpans.every((s) => s.name === 'invoke_agent shared-name')).toBe(true)

      // Same name but distinct traces
      const traceIds = new Set(agentSpans.map((s) => s.spanContext().traceId))
      expect(traceIds.size).toBe(2)

      // Each trace still has a complete hierarchy with correct output
      const expectedResponses = new Set(['Response A', 'Response B'])
      for (const agentSpan of agentSpans) {
        const traceId = agentSpan.spanContext().traceId
        const traceSpans = spans.filter((s) => s.spanContext().traceId === traceId)
        const traceCycles = findSpans(traceSpans, CYCLE_SPAN_NAME)
        const traceModels = findSpans(traceSpans, MODEL_SPAN_NAME)

        expect(traceCycles).toHaveLength(1)
        expect(traceModels).toHaveLength(1)
        assertParentChild(agentSpan, traceCycles[0]!)
        assertParentChild(traceCycles[0]!, traceModels[0]!)

        const choiceEvent = agentSpan.events.find((e) => e.name === 'gen_ai.choice')
        expect(choiceEvent).toBeDefined()
        const message = choiceEvent!.attributes!['message'] as string
        expect(expectedResponses.has(message)).toBe(true)
        expectedResponses.delete(message)
      }

      // Both responses were seen
      expect(expectedResponses.size).toBe(0)
    })
  })

  describe('getTracer', () => {
    it('returns a tracer that produces spans captured by the registered provider', async () => {
      const tracer = getTracer()
      const span = tracer.startSpan('custom-operation')
      span.setAttribute('custom.key', 'custom-value')
      span.end()

      const spans = await flush()
      const customSpans = spans.filter((s) => s.name === 'custom-operation')

      expect(customSpans).toHaveLength(1)
      expect(attr(customSpans[0]!, 'custom.key')).toBe('custom-value')
    })

    // The OTel global tracer provider can only be set once per process via register().
    // Subsequent register() calls are no-ops and emit a warning. All spans always
    // land in the first registered provider.

    it('ignores later register() calls — spans stay in the first registered provider', async () => {
      const userExporter = new InMemorySpanExporter()
      const userProvider = new NodeTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(userExporter)],
      })
      trace.setGlobalTracerProvider(userProvider) // no-op: global provider already set in beforeAll

      const tracer = getTracer()
      const span = tracer.startSpan('user-provider-span')
      span.setAttribute('source', 'custom-provider')
      span.end()

      // Span lands in the original shared provider, not the user's
      const spans = await flush()
      const sharedSpan = spans.find((s) => s.name === 'user-provider-span')
      expect(sharedSpan).toBeDefined()
      expect(sharedSpan!.attributes['source']).toBe('custom-provider')

      // The user's exporter never receives the span
      await userProvider.forceFlush()
      const userSpans = userExporter.getFinishedSpans()
      expect(userSpans.find((s) => s.name === 'user-provider-span')).toBeUndefined()
    })

    it('all spans land in the first registered provider even when multiple providers call register()', async () => {
      const exporterA = new InMemorySpanExporter()
      const providerA = new NodeTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporterA)],
      })
      trace.setGlobalTracerProvider(providerA) // no-op

      const exporterB = new InMemorySpanExporter()
      const providerB = new NodeTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporterB)],
      })
      trace.setGlobalTracerProvider(providerB) // no-op

      const tracer = getTracer()
      const span = tracer.startSpan('multi-register-span')
      span.end()

      // Span lands in the original shared provider
      const spans = await flush()
      expect(spans.find((s) => s.name === 'multi-register-span')).toBeDefined()

      // Neither late provider receives the span
      await providerA.forceFlush()
      await providerB.forceFlush()
      expect(exporterA.getFinishedSpans().find((s) => s.name === 'multi-register-span')).toBeUndefined()
      expect(exporterB.getFinishedSpans().find((s) => s.name === 'multi-register-span')).toBeUndefined()
    })

    it('creates custom spans that nest under agent spans via context propagation', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, printer: false, name: 'gettracer-nest-agent' })

      await agent.invoke('Hello')

      const allSpans = await flush()
      const agentReadableSpan = findSpans(allSpans, AGENT_SPAN_PREFIX)[0]!

      // Wrap the ReadableSpan's context into a live span reference for context propagation
      const agentSpanRef = trace.wrapSpanContext(agentReadableSpan.spanContext())

      // Create a custom span parented to the agent span via context
      const tracer = getTracer()
      context.with(trace.setSpan(context.active(), agentSpanRef), () => {
        const childSpan = tracer.startSpan('custom-child')
        childSpan.end()
      })

      const spansAfter = await flush()
      const childSpan = spansAfter.find((s) => s.name === 'custom-child')!

      expect(childSpan).toBeDefined()
      expect(childSpan.spanContext().traceId).toBe(agentReadableSpan.spanContext().traceId)
      expect(childSpan.parentSpanContext?.spanId).toBe(agentReadableSpan.spanContext().spanId)
    })
  })
})

describe.sequential('Metrics Integration', () => {
  let metricExporter: InMemoryMetricExporter
  let metricReader: PeriodicExportingMetricReader
  let meterProvider: MeterProvider

  const calculatorTool = tool({
    name: 'calculator',
    description: 'Add two numbers',
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    callback: ({ a, b }) => `${a + b}`,
  })

  beforeAll(() => {
    metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
    metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 100,
    })
    meterProvider = new MeterProvider({
      readers: [metricReader],
    })
    otelMetrics.setGlobalMeterProvider(meterProvider)
  })

  beforeEach(() => {
    metricExporter.reset()
  })

  afterAll(async () => {
    await meterProvider.forceFlush()
    await meterProvider.shutdown()
  })

  async function collectMetrics(): Promise<ReturnType<typeof metricExporter.getMetrics>> {
    await meterProvider.forceFlush()
    return [...metricExporter.getMetrics()]
  }

  it('emits cycle count metrics during agent invocation', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
    const agent = new Agent({ model, printer: false, name: 'metrics-cycle-agent' })

    await agent.invoke('Hi')

    const metrics = await collectMetrics()
    const cycleCount = findMetricValue(metrics, 'gen_ai.agent.cycle.count')

    expect(cycleCount).toBeGreaterThanOrEqual(1)
  })

  it('emits invocation count metrics', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
    const agent = new Agent({ model, printer: false, name: 'metrics-invocation-agent' })

    await agent.invoke('Hi')

    const metrics = await collectMetrics()
    const invocationCount = findMetricValue(metrics, 'gen_ai.agent.invocation.count')

    expect(invocationCount).toBeGreaterThanOrEqual(1)
  })

  it('emits token usage metrics', async () => {
    const model = new MockMessageModel().addTurn(
      { type: 'textBlock', text: 'Hello back' },
      { usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 } }
    )

    const agent = new Agent({ model, printer: false, name: 'metrics-token-agent' })

    await agent.invoke('Hello')

    const metrics = await collectMetrics()
    const inputTokens = findMetricValue(metrics, 'gen_ai.agent.tokens.input')
    const outputTokens = findMetricValue(metrics, 'gen_ai.agent.tokens.output')

    expect(inputTokens).toBeGreaterThanOrEqual(50)
    expect(outputTokens).toBeGreaterThanOrEqual(25)
  })

  it('emits tool call metrics when tools are used', async () => {
    const model = new MockMessageModel()
      .addTurn(
        { type: 'toolUseBlock', name: 'calculator', toolUseId: 'tool-1', input: { a: 1, b: 2 } },
        { usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 } }
      )
      .addTurn(
        { type: 'textBlock', text: 'The answer is 3' },
        { usage: { inputTokens: 40, outputTokens: 15, totalTokens: 55 } }
      )

    const agent = new Agent({ model, printer: false, name: 'metrics-tool-agent', tools: [calculatorTool] })

    await agent.invoke('Add 1 and 2')

    const metrics = await collectMetrics()
    const toolCallCount = findMetricValue(metrics, 'gen_ai.agent.tool.call.count')

    expect(toolCallCount).toBeGreaterThanOrEqual(1)
  })

  it('emits cycle duration histogram', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Done' })
    const agent = new Agent({ model, printer: false, name: 'metrics-duration-agent' })

    await agent.invoke('Hello')

    const metrics = await collectMetrics()
    const durationValue = findMetricValue(metrics, 'gen_ai.agent.cycle.duration')

    expect(durationValue).toBeDefined()
  })

  it('emits metrics across multiple invocations cumulatively', async () => {
    const model1 = new MockMessageModel().addTurn({ type: 'textBlock', text: 'First' })
    const model2 = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Second' })

    const agent1 = new Agent({ model: model1, printer: false, name: 'metrics-multi-1' })
    const agent2 = new Agent({ model: model2, printer: false, name: 'metrics-multi-2' })

    await agent1.invoke('Hello')
    await agent2.invoke('World')

    const metrics = await collectMetrics()
    const cycleCount = findMetricValue(metrics, 'gen_ai.agent.cycle.count')

    // At least 2 cycles (one per invocation)
    expect(cycleCount).toBeGreaterThanOrEqual(2)
  })

  it('getMeter returns a meter that records real metrics', async () => {
    const meter = getMeter()
    const counter = meter.createCounter('test.custom.counter')
    counter.add(7)

    const metrics = await collectMetrics()
    expect(findMetricValue(metrics, 'test.custom.counter')).toBe(7)
  })
})
