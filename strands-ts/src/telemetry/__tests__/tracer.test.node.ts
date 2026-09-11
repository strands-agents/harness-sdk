import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Span, SpanAttributeValue } from '@opentelemetry/api'
import { SpanStatusCode, trace, context } from '@opentelemetry/api'
import { Tracer } from '../tracer.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock, CachePointBlock } from '../../types/messages.js'
import { MockSpan, eventAttr } from '../../__fixtures__/mock-span.js'
import { textMessage } from '../../__fixtures__/agent-helpers.js'

// Partial mock: keep real SpanStatusCode, isSpanContextValid, etc., replace context and trace
vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@opentelemetry/api')
  return {
    ...actual,
    context: { active: vi.fn(() => ({})), with: vi.fn((_ctx: unknown, fn: () => unknown) => fn()) },
    trace: {
      getTracer: vi.fn(),
      setSpan: vi.fn(),
      getActiveSpan: vi.fn(),
    },
  }
})

describe('Tracer', () => {
  let mockSpan: MockSpan
  let mockStartSpan: ReturnType<typeof vi.fn<(name: string, ...args: unknown[]) => Span>>

  beforeEach(() => {
    mockSpan = new MockSpan()
    mockStartSpan = vi.fn<(name: string, ...args: unknown[]) => Span>().mockReturnValue(mockSpan)

    vi.mocked(trace.getTracer).mockReturnValue({
      startSpan: mockStartSpan,
      startActiveSpan: vi.fn(),
    })

    // Default to stable conventions; tests needing latest override this
    vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', '')
  })

  /** Get the [spanName, options] from the startSpan call for the span under test. */
  function getStartSpanCall(): [string, { attributes: Record<string, SpanAttributeValue | undefined> }] {
    return mockStartSpan.mock.calls[0] as [string, { attributes: Record<string, SpanAttributeValue | undefined> }]
  }

  describe('constructor', () => {
    it('reads service name from OTEL_SERVICE_NAME env var', () => {
      vi.stubEnv('OTEL_SERVICE_NAME', 'my-custom-service')

      new Tracer()

      expect(trace.getTracer).toHaveBeenCalledWith('my-custom-service')
    })

    it('defaults service name to strands-agents', () => {
      vi.stubEnv('OTEL_SERVICE_NAME', '')

      new Tracer()

      expect(trace.getTracer).toHaveBeenCalledWith('strands-agents')
    })
  })

  describe('startAgentSpan', () => {
    it('creates span with correct name and standard attributes', () => {
      const tracer = new Tracer()

      tracer.startAgentSpan({
        messages: [textMessage('user', 'Hello')],
        agentName: 'test-agent',
        modelId: 'model-123',
      })

      const [spanName, options] = getStartSpanCall()
      expect(spanName).toBe('invoke_agent test-agent')
      expect(options.attributes).toMatchObject({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.system': expect.any(String),
        'gen_ai.agent.name': 'test-agent',
        'gen_ai.request.model': 'model-123',
        name: 'invoke_agent test-agent',
      })
    })

    it('includes agent id when provided', () => {
      const tracer = new Tracer()

      tracer.startAgentSpan({
        messages: [textMessage('user', 'Hello')],
        agentName: 'test-agent',
        agentId: 'agent-42',
      })

      const [, options] = getStartSpanCall()
      expect(options.attributes['gen_ai.agent.id']).toBe('agent-42')
    })

    it('serializes tool names into gen_ai.agent.tools', () => {
      const tracer = new Tracer()

      tracer.startAgentSpan({
        messages: [textMessage('user', 'Hello')],
        agentName: 'test-agent',
        tools: [{ name: 'calculator' }, { name: 'search' }],
      })

      const [, options] = getStartSpanCall()
      expect(options.attributes['gen_ai.agent.tools']).toBe('["calculator","search"]')
    })

    it('includes tool definitions when gen_ai_tool_definitions opt-in is set', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_tool_definitions')
      const tracer = new Tracer()
      const toolsConfig = { calc: { name: 'calc', description: 'Calculator' } }

      tracer.startAgentSpan({
        messages: [textMessage('user', 'Hello')],
        agentName: 'test-agent',
        toolsConfig,
      })

      const [, options] = getStartSpanCall()
      expect(options.attributes['gen_ai.tool.definitions']).toBe(JSON.stringify(toolsConfig))
    })

    it('serializes system prompt into attribute', () => {
      const tracer = new Tracer()

      tracer.startAgentSpan({
        messages: [textMessage('user', 'Hello')],
        agentName: 'test-agent',
        systemPrompt: 'You are a helpful assistant',
      })

      const [, options] = getStartSpanCall()
      expect(options.attributes['system_prompt']).toBe('"You are a helpful assistant"')
    })

    it('merges constructor-level and call-level trace attributes', () => {
      const tracer = new Tracer({ 'global.attr': 'global-val' })

      tracer.startAgentSpan({
        messages: [textMessage('user', 'Hello')],
        agentName: 'test-agent',
        traceAttributes: { 'custom.session': 'sess-1' },
      })

      const [, options] = getStartSpanCall()
      expect(options.attributes['global.attr']).toBe('global-val')
      expect(options.attributes['custom.session']).toBe('sess-1')
    })

    it('adds separate stable message events per message', () => {
      const tracer = new Tracer()

      tracer.startAgentSpan({
        messages: [textMessage('user', 'Hello'), textMessage('assistant', 'Hi')],
        agentName: 'test-agent',
      })

      expect(mockSpan.getEvents('gen_ai.user.message')).toHaveLength(1)
      expect(mockSpan.getEvents('gen_ai.assistant.message')).toHaveLength(1)
    })

    it('classifies tool result messages as gen_ai.tool.message', () => {
      const tracer = new Tracer()

      const toolResultMsg = new Message({
        role: 'user',
        content: [new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('done')] })],
      })

      tracer.startAgentSpan({ messages: [toolResultMsg], agentName: 'test-agent' })

      expect(mockSpan.getEvents('gen_ai.tool.message')).toHaveLength(1)
    })

    it('adds single operation details event with latest conventions', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()

      tracer.startAgentSpan({
        messages: [textMessage('user', 'Hello'), textMessage('assistant', 'Hi')],
        agentName: 'test-agent',
      })

      const detailEvents = mockSpan.getEvents('gen_ai.client.inference.operation.details')
      expect(detailEvents).toHaveLength(1)

      const inputMessages = JSON.parse(eventAttr(detailEvents[0]!, 'gen_ai.input.messages'))
      expect(inputMessages).toStrictEqual([
        { role: 'user', parts: [{ type: 'text', content: 'Hello' }] },
        { role: 'assistant', parts: [{ type: 'text', content: 'Hi' }] },
      ])
    })

    it('uses gen_ai.provider.name with latest conventions', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()

      tracer.startAgentSpan({ messages: [textMessage('user', 'Hello')], agentName: 'test-agent' })

      const [, options] = getStartSpanCall()
      expect(options.attributes['gen_ai.provider.name']).toBeDefined()
      expect(options.attributes['gen_ai.system']).toBeUndefined()
    })

    it('uses gen_ai.system with stable conventions', () => {
      const tracer = new Tracer()

      tracer.startAgentSpan({ messages: [textMessage('user', 'Hello')], agentName: 'test-agent' })

      const [, options] = getStartSpanCall()
      expect(options.attributes['gen_ai.system']).toBeDefined()
      expect(options.attributes['gen_ai.provider.name']).toBeUndefined()
    })
  })

  describe('endAgentSpan', () => {
    it('sets OK status and ends span on success', () => {
      const tracer = new Tracer()
      const span = tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' })

      tracer.endAgentSpan(span)

      expect(mockSpan.calls.setStatus).toContainEqual({ status: { code: SpanStatusCode.OK } })
      expect(mockSpan.calls.end).toHaveLength(1)
    })

    it('sets ERROR status and records exception on error', () => {
      const tracer = new Tracer()
      const span = tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' })
      const error = new Error('agent failed')

      tracer.endAgentSpan(span, { error })

      expect(mockSpan.calls.setStatus).toContainEqual({
        status: { code: SpanStatusCode.ERROR, message: 'agent failed' },
      })
      expect(mockSpan.calls.recordException).toContainEqual({ exception: error, time: undefined })
    })

    it('sets accumulated usage attributes', () => {
      const tracer = new Tracer()
      const span = tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' })

      tracer.endAgentSpan(span, {
        accumulatedUsage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
      })

      expect(mockSpan.getAttributeValue('gen_ai.usage.input_tokens')).toBe(100)
      expect(mockSpan.getAttributeValue('gen_ai.usage.output_tokens')).toBe(200)
      expect(mockSpan.getAttributeValue('gen_ai.usage.total_tokens')).toBe(300)
      expect(mockSpan.getAttributeValue('gen_ai.usage.prompt_tokens')).toBe(100)
      expect(mockSpan.getAttributeValue('gen_ai.usage.completion_tokens')).toBe(200)
    })

    // Accumulated usage folds cached tokens into input_tokens for disjoint-cache providers,
    // matching the per-invocation span (OTel GenAI semconv).
    it('includes cached tokens in accumulated input_tokens for disjoint-cache providers', () => {
      const tracer = new Tracer()
      const span = tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' })

      tracer.endAgentSpan(span, {
        accumulatedUsage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 58,
          cacheReadInputTokens: 25,
          cacheWriteInputTokens: 3,
        },
      })

      expect(mockSpan.getAttributeValue('gen_ai.usage.input_tokens')).toBe(38)
      expect(mockSpan.getAttributeValue('gen_ai.usage.prompt_tokens')).toBe(38)
      expect(mockSpan.getAttributeValue('gen_ai.usage.total_tokens')).toBe(58)
    })

    it('adds response event with stable conventions', () => {
      const tracer = new Tracer()
      const span = tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' })

      const response = new Message({ role: 'assistant', content: [new TextBlock('Hello back')] })
      tracer.endAgentSpan(span, { response, stopReason: 'end_turn' })

      const choiceEvents = mockSpan.getEvents('gen_ai.choice')
      expect(choiceEvents).toHaveLength(1)
      expect(eventAttr(choiceEvents[0]!, 'message')).toBe('Hello back')
      expect(eventAttr(choiceEvents[0]!, 'finish_reason')).toBe('end_turn')
    })

    it('adds response event with latest conventions', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()
      const span = tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' })

      const response = new Message({ role: 'assistant', content: [new TextBlock('Hello back')] })
      tracer.endAgentSpan(span, { response, stopReason: 'end_turn' })

      const detailEvents = mockSpan.getEvents('gen_ai.client.inference.operation.details')
      const outputEvent = detailEvents.find((e) => eventAttr(e, 'gen_ai.output.messages'))
      expect(outputEvent).toBeDefined()
      const parsed = JSON.parse(eventAttr(outputEvent!, 'gen_ai.output.messages'))
      expect(parsed).toStrictEqual([
        { role: 'assistant', parts: [{ type: 'text', content: 'Hello back' }], finish_reason: 'end_turn' },
      ])
    })

    it('handles null span gracefully', () => {
      const tracer = new Tracer()

      expect(() => tracer.endAgentSpan(null)).not.toThrow()
      expect(mockSpan.calls.end).toHaveLength(0)
    })
  })

  describe('startModelInvokeSpan', () => {
    it('creates span with chat operation name and model id', () => {
      const tracer = new Tracer()

      tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hello')], modelId: 'claude-3' })

      const [spanName, options] = getStartSpanCall()
      expect(spanName).toBe('chat')
      expect(options.attributes).toMatchObject({
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-3',
      })
    })

    it('adds message events to span', () => {
      const tracer = new Tracer()

      tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hello')] })

      expect(mockSpan.getEvents('gen_ai.user.message')).toHaveLength(1)
    })
  })

  describe('endModelInvokeSpan', () => {
    it('sets usage and metrics attributes', () => {
      const tracer = new Tracer()
      const span = tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')], modelId: 'model-1' })

      tracer.endModelInvokeSpan(span, {
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        metrics: { latencyMs: 500 },
      })

      expect(mockSpan.getAttributeValue('gen_ai.usage.input_tokens')).toBe(10)
      expect(mockSpan.getAttributeValue('gen_ai.usage.output_tokens')).toBe(20)
      expect(mockSpan.getAttributeValue('gen_ai.usage.total_tokens')).toBe(30)
      expect(mockSpan.getAttributeValue('gen_ai.server.request.duration')).toBe(500)
    })

    // input_tokens must include cached tokens per the OTel GenAI semconv; disjoint-cache
    // providers (Bedrock Converse, Anthropic-direct) report them separately, so fold them in.
    it('includes cached tokens in input_tokens for disjoint-cache providers', () => {
      const tracer = new Tracer()
      const span = tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })

      tracer.endModelInvokeSpan(span, {
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 58,
          cacheReadInputTokens: 25,
          cacheWriteInputTokens: 3,
        },
      })

      expect(mockSpan.getAttributeValue('gen_ai.usage.input_tokens')).toBe(38)
      expect(mockSpan.getAttributeValue('gen_ai.usage.prompt_tokens')).toBe(38)
      expect(mockSpan.getAttributeValue('gen_ai.usage.output_tokens')).toBe(20)
      expect(mockSpan.getAttributeValue('gen_ai.usage.total_tokens')).toBe(58)
      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_read.input_tokens')).toBe(25)
      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_creation.input_tokens')).toBe(3)
    })

    // Subset-cache providers (OpenAI, Gemini) already count cache inside input_tokens;
    // the fold-in must be a no-op so cached tokens are not counted twice.
    it('does not double-count when the provider already includes cache in input_tokens', () => {
      const tracer = new Tracer()
      const span = tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })

      tracer.endModelInvokeSpan(span, {
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadInputTokens: 30 },
      })

      expect(mockSpan.getAttributeValue('gen_ai.usage.input_tokens')).toBe(100)
      expect(mockSpan.getAttributeValue('gen_ai.usage.prompt_tokens')).toBe(100)
      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_read.input_tokens')).toBe(30)
    })

    it('sets cache token attributes when provided', () => {
      const tracer = new Tracer()
      const span = tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })

      tracer.endModelInvokeSpan(span, {
        usage: {
          inputTokens: 100,
          outputTokens: 200,
          totalTokens: 300,
          cacheReadInputTokens: 50,
          cacheWriteInputTokens: 25,
        },
      })

      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_read.input_tokens')).toBe(50)
      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_creation.input_tokens')).toBe(25)
      // deprecated aliases kept so existing consumers keep resolving, value-identical to the semconv names
      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_read_input_tokens')).toBe(50)
      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_write_input_tokens')).toBe(25)
    })

    it('skips cache token attributes when zero', () => {
      const tracer = new Tracer()
      const span = tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })

      tracer.endModelInvokeSpan(span, {
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cacheReadInputTokens: 0 },
      })

      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_read.input_tokens')).toBeUndefined()
      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_read_input_tokens')).toBeUndefined()
    })

    // Regression for https://github.com/strands-agents/harness-sdk/issues/3754
    it('dual-emits cache usage under both the semconv names and the deprecated aliases', () => {
      const tracer = new Tracer()
      const span = tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })

      tracer.endModelInvokeSpan(span, {
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cacheReadInputTokens: 5848 },
      })

      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_read.input_tokens')).toBe(5848)
      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_read_input_tokens')).toBe(5848)
    })

    it('suppresses the deprecated cache aliases when opted into the latest conventions', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()
      const span = tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })

      tracer.endModelInvokeSpan(span, {
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
          cacheReadInputTokens: 5848,
          cacheWriteInputTokens: 3,
        },
      })

      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_read.input_tokens')).toBe(5848)
      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_creation.input_tokens')).toBe(3)
      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_read_input_tokens')).toBeUndefined()
      expect(mockSpan.getAttributeValue('gen_ai.usage.cache_write_input_tokens')).toBeUndefined()
    })

    it('skips latency attribute when zero', () => {
      const tracer = new Tracer()
      const span = tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })

      tracer.endModelInvokeSpan(span, {
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        metrics: { latencyMs: 0 },
      })

      expect(mockSpan.getAttributeValue('gen_ai.server.request.duration')).toBeUndefined()
    })

    it('adds output event with stable conventions for mixed content', () => {
      const tracer = new Tracer()
      const span = tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })

      const output = new Message({
        role: 'assistant',
        content: [
          new TextBlock('The answer is 42'),
          new ToolUseBlock({ name: 'calc', toolUseId: 'tool-1', input: { expr: '6*7' } }),
        ],
      })

      tracer.endModelInvokeSpan(span, { output, stopReason: 'tool_use' })

      const choiceEvents = mockSpan.getEvents('gen_ai.choice')
      expect(choiceEvents).toHaveLength(1)
      expect(eventAttr(choiceEvents[0]!, 'finish_reason')).toBe('tool_use')

      const parsed = JSON.parse(eventAttr(choiceEvents[0]!, 'message'))
      expect(parsed).toStrictEqual([
        { text: 'The answer is 42' },
        { type: 'toolUse', name: 'calc', toolUseId: 'tool-1', input: { expr: '6*7' } },
      ])
    })

    it('adds output event with latest conventions for mixed content', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()
      const span = tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })

      const output = new Message({
        role: 'assistant',
        content: [
          new TextBlock('The answer'),
          new ToolUseBlock({ name: 'calc', toolUseId: 'tool-1', input: { x: 1 } }),
        ],
      })

      tracer.endModelInvokeSpan(span, { output, stopReason: 'tool_use' })

      const detailEvents = mockSpan.getEvents('gen_ai.client.inference.operation.details')
      const outputEvent = detailEvents.find((e) => eventAttr(e, 'gen_ai.output.messages'))
      expect(outputEvent).toBeDefined()
      const parsed = JSON.parse(eventAttr(outputEvent!, 'gen_ai.output.messages'))
      expect(parsed).toStrictEqual([
        {
          role: 'assistant',
          parts: [
            { type: 'text', content: 'The answer' },
            { type: 'tool_call', name: 'calc', id: 'tool-1', arguments: { x: 1 } },
          ],
          finish_reason: 'tool_use',
        },
      ])
    })

    it('records error on model invocation failure', () => {
      const tracer = new Tracer()
      const span = tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })
      const error = new Error('model timeout')

      tracer.endModelInvokeSpan(span, { error })

      expect(mockSpan.calls.setStatus).toContainEqual({
        status: { code: SpanStatusCode.ERROR, message: 'model timeout' },
      })
      expect(mockSpan.calls.recordException).toContainEqual({ exception: error, time: undefined })
    })

    it('handles null span gracefully', () => {
      const tracer = new Tracer()

      expect(() => tracer.endModelInvokeSpan(null)).not.toThrow()
    })
  })

  describe('startToolCallSpan', () => {
    it('creates span with tool name and call id', () => {
      const tracer = new Tracer()

      tracer.startToolCallSpan({
        tool: { name: 'calculator', toolUseId: 'call-1', input: { expr: '2+2' } },
      })

      const [spanName, options] = getStartSpanCall()
      expect(spanName).toBe('execute_tool calculator')
      expect(options.attributes).toMatchObject({
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': 'calculator',
        'gen_ai.tool.call.id': 'call-1',
      })
    })

    it('adds stable tool message event with serialized input', () => {
      const tracer = new Tracer()

      tracer.startToolCallSpan({
        tool: { name: 'search', toolUseId: 'call-2', input: { query: 'test' } },
      })

      const toolEvents = mockSpan.getEvents('gen_ai.tool.message')
      expect(toolEvents).toHaveLength(1)
      expect(eventAttr(toolEvents[0]!, 'role')).toBe('tool')
      expect(eventAttr(toolEvents[0]!, 'content')).toBe('{"query":"test"}')
      expect(eventAttr(toolEvents[0]!, 'id')).toBe('call-2')
    })

    it('adds latest convention tool input event', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()

      tracer.startToolCallSpan({
        tool: { name: 'search', toolUseId: 'call-2', input: { query: 'test' } },
      })

      const detailEvents = mockSpan.getEvents('gen_ai.client.inference.operation.details')
      expect(detailEvents).toHaveLength(1)
      const parsed = JSON.parse(eventAttr(detailEvents[0]!, 'gen_ai.input.messages'))
      expect(parsed).toStrictEqual([
        {
          role: 'tool',
          parts: [{ type: 'tool_call', name: 'search', id: 'call-2', arguments: { query: 'test' } }],
        },
      ])
    })

    it('sets latest convention tool call arguments attribute', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()

      tracer.startToolCallSpan({
        tool: { name: 'search', toolUseId: 'call-2', input: { query: 'test' } },
      })

      expect(mockSpan.getAttributeValue('gen_ai.tool.call.arguments')).toBe('{"query":"test"}')
    })
  })

  describe('endToolCallSpan', () => {
    it('sets tool status attribute and adds stable result event', () => {
      const tracer = new Tracer()
      const span = tracer.startToolCallSpan({
        tool: { name: 'calc', toolUseId: 'call-1', input: {} },
      })

      const toolResult = new ToolResultBlock({
        toolUseId: 'call-1',
        status: 'success',
        content: [new TextBlock('42')],
      })

      tracer.endToolCallSpan(span, { toolResult })

      expect(mockSpan.getAttributeValue('gen_ai.tool.status')).toBe('success')

      const choiceEvents = mockSpan.getEvents('gen_ai.choice')
      expect(choiceEvents).toHaveLength(1)
      expect(eventAttr(choiceEvents[0]!, 'id')).toBe('call-1')
    })

    it('adds latest convention tool result event', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()
      const span = tracer.startToolCallSpan({
        tool: { name: 'calc', toolUseId: 'call-1', input: {} },
      })

      const toolResult = new ToolResultBlock({
        toolUseId: 'call-1',
        status: 'success',
        content: [new TextBlock('42')],
      })

      tracer.endToolCallSpan(span, { toolResult })

      const detailEvents = mockSpan.getEvents('gen_ai.client.inference.operation.details')
      const outputEvent = detailEvents.find((e) => eventAttr(e, 'gen_ai.output.messages'))
      expect(outputEvent).toBeDefined()
      const parsed = JSON.parse(eventAttr(outputEvent!, 'gen_ai.output.messages'))
      expect(parsed[0].role).toBe('tool')
      expect(parsed[0].parts[0].type).toBe('tool_call_response')
      expect(parsed[0].parts[0].id).toBe('call-1')
    })

    it('sets latest convention tool call result attribute on success', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()
      const span = tracer.startToolCallSpan({
        tool: { name: 'calc', toolUseId: 'call-1', input: {} },
      })

      const toolResult = new ToolResultBlock({
        toolUseId: 'call-1',
        status: 'success',
        content: [new TextBlock('42')],
      })

      tracer.endToolCallSpan(span, { toolResult })

      const resultAttr = mockSpan.getAttributeValue('gen_ai.tool.call.result')
      expect(resultAttr).toBeDefined()
      const parsed = JSON.parse(resultAttr as string)
      expect(parsed).toHaveLength(1)
      expect(parsed[0]).toMatchObject({ text: '42' })
    })

    it('omits latest convention tool call result attribute on error status', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()
      const span = tracer.startToolCallSpan({
        tool: { name: 'calc', toolUseId: 'call-1', input: {} },
      })

      const toolResult = new ToolResultBlock({
        toolUseId: 'call-1',
        status: 'error',
        content: [new TextBlock('tool exploded')],
      })

      tracer.endToolCallSpan(span, { toolResult })

      expect(mockSpan.getAttributeValue('gen_ai.tool.call.result')).toBeUndefined()
      expect(mockSpan.getAttributeValue('gen_ai.tool.status')).toBe('error')
    })

    it('records error on tool failure', () => {
      const tracer = new Tracer()
      const span = tracer.startToolCallSpan({
        tool: { name: 'calc', toolUseId: 'call-1', input: {} },
      })
      const error = new Error('tool crashed')

      tracer.endToolCallSpan(span, { error })

      expect(mockSpan.calls.setStatus).toContainEqual({
        status: { code: SpanStatusCode.ERROR, message: 'tool crashed' },
      })
      expect(mockSpan.calls.recordException).toContainEqual({ exception: error, time: undefined })
    })

    it('handles null span gracefully', () => {
      const tracer = new Tracer()

      expect(() => tracer.endToolCallSpan(null)).not.toThrow()
    })
  })

  describe('startAgentLoopSpan', () => {
    it('creates span with cycle id attribute', () => {
      const tracer = new Tracer()

      tracer.startAgentLoopSpan({ cycleId: 'cycle-42', messages: [textMessage('user', 'Hi')] })

      const [spanName, options] = getStartSpanCall()
      expect(spanName).toBe('execute_agent_loop_cycle')
      expect(options.attributes['agent_loop.cycle_id']).toBe('cycle-42')
    })

    it('adds message events to loop span', () => {
      const tracer = new Tracer()

      tracer.startAgentLoopSpan({ cycleId: 'cycle-1', messages: [textMessage('user', 'Hello')] })

      expect(mockSpan.getEvents('gen_ai.user.message')).toHaveLength(1)
    })

    it('creates local trace with cycleId in metadata', () => {
      const tracer = new Tracer()

      tracer.startAgentLoopSpan({ cycleId: 'cycle-123', messages: [] })

      const traces = tracer.localTraces
      expect(traces).toEqual([
        expect.objectContaining({
          name: 'Cycle 1',
          metadata: expect.objectContaining({ cycleId: 'cycle-123' }),
        }),
      ])
    })

    it('stores unique cycleIds for multiple cycles', () => {
      const tracer = new Tracer()

      tracer.startAgentLoopSpan({ cycleId: 'cycle-abc', messages: [] })
      tracer.endAgentLoopSpan(mockSpan)
      tracer.startAgentLoopSpan({ cycleId: 'cycle-xyz', messages: [] })

      const traces = tracer.localTraces
      expect(traces).toEqual([
        expect.objectContaining({
          name: 'Cycle 1',
          metadata: expect.objectContaining({ cycleId: 'cycle-abc' }),
        }),
        expect.objectContaining({
          name: 'Cycle 2',
          metadata: expect.objectContaining({ cycleId: 'cycle-xyz' }),
        }),
      ])
    })
  })

  describe('endAgentLoopSpan', () => {
    it('ends span with OK status', () => {
      const tracer = new Tracer()
      const span = tracer.startAgentLoopSpan({ cycleId: 'cycle-1', messages: [textMessage('user', 'Hi')] })

      tracer.endAgentLoopSpan(span)

      expect(mockSpan.calls.setStatus).toContainEqual({ status: { code: SpanStatusCode.OK } })
      expect(mockSpan.calls.end).toHaveLength(1)
    })

    it('records error on loop failure', () => {
      const tracer = new Tracer()
      const span = tracer.startAgentLoopSpan({ cycleId: 'cycle-1', messages: [textMessage('user', 'Hi')] })
      const error = new Error('loop failed')

      tracer.endAgentLoopSpan(span, { error })

      expect(mockSpan.calls.setStatus).toContainEqual({
        status: { code: SpanStatusCode.ERROR, message: 'loop failed' },
      })
      expect(mockSpan.calls.recordException).toContainEqual({ exception: error, time: undefined })
    })

    it('handles null span gracefully', () => {
      const tracer = new Tracer()

      expect(() => tracer.endAgentLoopSpan(null)).not.toThrow()
    })
  })

  describe('withSpanContext', () => {
    it('executes callback directly when span is null', () => {
      const tracer = new Tracer()
      const fn = vi.fn(() => 'result')

      const result = tracer.withSpanContext(null, fn)

      expect(result).toBe('result')
      expect(fn).toHaveBeenCalledOnce()
      expect(context.with).not.toHaveBeenCalled()
    })

    it('executes callback within span context when span is provided', () => {
      const tracer = new Tracer()
      const span = tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' })
      const mockContext = { spanContext: true }
      vi.mocked(trace.setSpan).mockReturnValue(mockContext as never)

      tracer.withSpanContext(span, () => 'inside')

      expect(trace.setSpan).toHaveBeenCalledWith({}, span)
      expect(context.with).toHaveBeenCalledWith(mockContext, expect.any(Function))
    })

    it('propagates return value from callback', () => {
      const tracer = new Tracer()
      const span = tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' })

      const result = tracer.withSpanContext(span, () => 42)

      expect(result).toBe(42)
    })
  })

  describe('message event formatting', () => {
    it('maps tool use blocks to tool_call parts in latest conventions', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()

      const messages = [
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ name: 'search', toolUseId: 'tu-1', input: { q: 'test' } })],
        }),
      ]

      tracer.startAgentSpan({ messages, agentName: 'agent' })

      const detailEvents = mockSpan.getEvents('gen_ai.client.inference.operation.details')
      const parsed = JSON.parse(eventAttr(detailEvents[0]!, 'gen_ai.input.messages'))
      expect(parsed[0].parts[0]).toStrictEqual({
        type: 'tool_call',
        name: 'search',
        id: 'tu-1',
        arguments: { q: 'test' },
      })
    })

    it('maps tool result blocks to tool_call_response parts in latest conventions', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()

      const messages = [
        new Message({
          role: 'user',
          content: [new ToolResultBlock({ toolUseId: 'tu-1', status: 'success', content: [new TextBlock('result')] })],
        }),
      ]

      tracer.startAgentSpan({ messages, agentName: 'agent' })

      const detailEvents = mockSpan.getEvents('gen_ai.client.inference.operation.details')
      const parsed = JSON.parse(eventAttr(detailEvents[0]!, 'gen_ai.input.messages'))
      expect(parsed[0].parts[0].type).toBe('tool_call_response')
      expect(parsed[0].parts[0].id).toBe('tu-1')
    })

    it('serializes text block content in stable convention events', () => {
      const tracer = new Tracer()

      tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hello world')] })

      const userEvents = mockSpan.getEvents('gen_ai.user.message')
      const parsed = JSON.parse(eventAttr(userEvents[0]!, 'content'))
      expect(parsed[0].text).toBe('Hello world')
    })
  })

  describe('system prompt on chat spans', () => {
    it('emits gen_ai.system.message event with stable conventions', () => {
      const tracer = new Tracer()

      tracer.startModelInvokeSpan({
        messages: [textMessage('user', 'Hello')],
        modelId: 'test-model',
        systemPrompt: 'You are a helpful assistant',
      })

      const systemEvents = mockSpan.getEvents('gen_ai.system.message')
      expect(systemEvents).toHaveLength(1)
      expect(JSON.parse(eventAttr(systemEvents[0]!, 'content'))).toStrictEqual([
        { text: 'You are a helpful assistant' },
      ])
    })

    it('emits gen_ai.system_instructions with latest conventions', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()

      tracer.startModelInvokeSpan({
        messages: [textMessage('user', 'Hello')],
        modelId: 'test-model',
        systemPrompt: 'You are a calculator assistant',
      })

      const detailEvents = mockSpan.getEvents('gen_ai.client.inference.operation.details')
      const systemEvent = detailEvents.find((e) => eventAttr(e, 'gen_ai.system_instructions'))
      expect(systemEvent).toBeDefined()
      expect(JSON.parse(eventAttr(systemEvent!, 'gen_ai.system_instructions'))).toStrictEqual([
        { type: 'text', content: 'You are a calculator assistant' },
      ])
    })

    it('does not emit system prompt event when systemPrompt is undefined', () => {
      const tracer = new Tracer()

      tracer.startModelInvokeSpan({
        messages: [textMessage('user', 'Hello')],
        modelId: 'test-model',
      })

      const systemEvents = mockSpan.getEvents('gen_ai.system.message')
      expect(systemEvents).toHaveLength(0)
    })

    it('handles SystemContentBlock array with cache points in latest conventions', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()

      tracer.startModelInvokeSpan({
        messages: [textMessage('user', 'Hello')],
        modelId: 'test-model',
        systemPrompt: [new TextBlock('You are helpful'), new CachePointBlock({ cacheType: 'default' })],
      })

      const detailEvents = mockSpan.getEvents('gen_ai.client.inference.operation.details')
      const systemEvent = detailEvents.find((e) => eventAttr(e, 'gen_ai.system_instructions'))
      expect(systemEvent).toBeDefined()
      expect(JSON.parse(eventAttr(systemEvent!, 'gen_ai.system_instructions'))).toStrictEqual([
        { type: 'text', content: 'You are helpful' },
        { type: 'cache_point', cacheType: 'default' },
      ])
    })

    it('serializes SystemContentBlock array in stable conventions', () => {
      const tracer = new Tracer()

      tracer.startModelInvokeSpan({
        messages: [textMessage('user', 'Hello')],
        modelId: 'test-model',
        systemPrompt: [new TextBlock('You are helpful'), new CachePointBlock({ cacheType: 'default' })],
      })

      const systemEvents = mockSpan.getEvents('gen_ai.system.message')
      expect(systemEvents).toHaveLength(1)
      const parsed = JSON.parse(eventAttr(systemEvents[0]!, 'content'))
      expect(parsed).toHaveLength(2)
      expect(parsed[0]).toStrictEqual({ text: 'You are helpful' })
      expect(parsed[1]).toStrictEqual({ cachePoint: { cacheType: 'default' } })
    })
  })

  describe('timeToFirstByteMs', () => {
    it('does not set TTFB as span attribute (TTFB is a histogram metric, not a span attribute)', () => {
      const tracer = new Tracer()
      const span = tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })

      tracer.endModelInvokeSpan(span, {
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        metrics: { latencyMs: 500, timeToFirstByteMs: 150 },
      })

      expect(mockSpan.getAttributeValue('gen_ai.server.time_to_first_token')).toBeUndefined()
      expect(mockSpan.getAttributeValue('gen_ai.server.request.duration')).toBe(500)
    })
  })

  describe('Langfuse detection', () => {
    it('sets langfuse.observation.type on agent span when OTEL_EXPORTER_OTLP_ENDPOINT contains langfuse', () => {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://us.cloud.langfuse.com')
      const tracer = new Tracer()
      const span = tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' })

      tracer.endAgentSpan(span, {
        accumulatedUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      })

      expect(mockSpan.getAttributeValue('langfuse.observation.type')).toBe('span')
    })

    it('sets langfuse.observation.type when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT contains langfuse', () => {
      vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'https://us.cloud.langfuse.com/api/public/otel/v1/traces')
      const tracer = new Tracer()
      const span = tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' })

      tracer.endAgentSpan(span, {
        accumulatedUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      })

      expect(mockSpan.getAttributeValue('langfuse.observation.type')).toBe('span')
    })

    it('sets langfuse.observation.type when LANGFUSE_BASE_URL is set', () => {
      vi.stubEnv('LANGFUSE_BASE_URL', 'https://self-hosted.example.com')
      const tracer = new Tracer()
      const span = tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' })

      tracer.endAgentSpan(span, {
        accumulatedUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      })

      expect(mockSpan.getAttributeValue('langfuse.observation.type')).toBe('span')
    })

    it('does not set langfuse.observation.type when no langfuse env vars are set', () => {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
      vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', '')
      vi.stubEnv('LANGFUSE_BASE_URL', '')
      const tracer = new Tracer()
      const span = tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' })

      tracer.endAgentSpan(span, {
        accumulatedUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      })

      expect(mockSpan.getAttributeValue('langfuse.observation.type')).toBeUndefined()
    })
  })

  describe('span attributes only', () => {
    // With the opt-in set, message content is recorded as span attributes rather than deprecated
    // span events, for backends that cannot read events.
    it('records latest-convention content as span attributes and skips the event when opted in', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental,gen_ai_span_attributes_only')
      const tracer = new Tracer()

      tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })

      const inputMessages = JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'Hi' }] }])
      expect(mockSpan.calls.setAttributes).toContainEqual({
        attributes: { 'gen_ai.input.messages': inputMessages },
      })
      expect(mockSpan.getEvents('gen_ai.client.inference.operation.details')).toHaveLength(0)
    })

    it('records latest-convention content as span attributes for Langfuse without opt-in', () => {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://us.cloud.langfuse.com')
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()

      tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })

      const inputMessages = JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'Hi' }] }])
      expect(mockSpan.calls.setAttributes).toContainEqual({
        attributes: { 'gen_ai.input.messages': inputMessages },
      })
      expect(mockSpan.getEvents('gen_ai.client.inference.operation.details')).toHaveLength(0)
    })

    it('emits span events by default without the opt-in or Langfuse', () => {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
      vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', '')
      vi.stubEnv('LANGFUSE_BASE_URL', '')
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
      const tracer = new Tracer()

      tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })

      expect(mockSpan.getEvents('gen_ai.client.inference.operation.details')).toHaveLength(1)
    })

    it('leaves legacy per-message events as events even when opted in', () => {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
      vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', '')
      vi.stubEnv('LANGFUSE_BASE_URL', '')
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_span_attributes_only')
      const tracer = new Tracer()

      tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] })

      expect(mockSpan.getEvents('gen_ai.user.message')).toHaveLength(1)
    })

    it('records the memory search query as a span attribute and skips the event when opted in', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_span_attributes_only')
      const tracer = new Tracer()

      tracer.startMemorySearchSpan({ query: 'dark mode preference', storeNames: ['personal'] })

      expect(mockSpan.calls.setAttributes).toContainEqual({ attributes: { content: 'dark mode preference' } })
      expect(mockSpan.getEvents('memory.query')).toHaveLength(0)
    })

    it('records the memory add content as a span attribute and skips the event when opted in', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_span_attributes_only')
      const tracer = new Tracer()

      tracer.startMemoryAddSpan({ content: 'remember dark mode', storeNames: ['personal'] })

      expect(mockSpan.calls.setAttributes).toContainEqual({ attributes: { content: 'remember dark mode' } })
      expect(mockSpan.getEvents('memory.content')).toHaveLength(0)
    })
  })

  describe('error resilience', () => {
    it.each([
      {
        method: 'startAgentSpan',
        call: (tracer: Tracer) => tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' }),
      },
      {
        method: 'startModelInvokeSpan',
        call: (tracer: Tracer) => tracer.startModelInvokeSpan({ messages: [textMessage('user', 'Hi')] }),
      },
      {
        method: 'startToolCallSpan',
        call: (tracer: Tracer) => tracer.startToolCallSpan({ tool: { name: 'x', toolUseId: 'y', input: {} } }),
      },
      {
        method: 'startAgentLoopSpan',
        call: (tracer: Tracer) => tracer.startAgentLoopSpan({ cycleId: 'c', messages: [textMessage('user', 'Hi')] }),
      },
    ])('returns null when $method throws internally', ({ call }) => {
      mockStartSpan.mockImplementation(() => {
        throw new Error('otel failure')
      })
      const tracer = new Tracer()

      expect(call(tracer)).toBeNull()
    })

    it('does not throw when ending null spans with errors', () => {
      const tracer = new Tracer()

      expect(() => {
        tracer.endAgentSpan(null, { error: new Error('test') })
        tracer.endModelInvokeSpan(null, { error: new Error('test') })
        tracer.endToolCallSpan(null, { error: new Error('test') })
        tracer.endAgentLoopSpan(null, { error: new Error('test') })
      }).not.toThrow()
    })
  })

  describe('semantic convention opt-in parsing', () => {
    it('parses multiple comma-separated opt-in values', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental,gen_ai_tool_definitions')
      const tracer = new Tracer()
      const toolsConfig = { calc: { name: 'calc', description: 'Calculator' } }

      tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent', toolsConfig })

      const [, options] = getStartSpanCall()
      expect(options.attributes['gen_ai.provider.name']).toBeDefined()
      expect(options.attributes['gen_ai.tool.definitions']).toBe(JSON.stringify(toolsConfig))
    })

    it('handles whitespace in opt-in values', () => {
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', ' gen_ai_latest_experimental , gen_ai_tool_definitions ')
      const tracer = new Tracer()

      tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' })

      const [, options] = getStartSpanCall()
      expect(options.attributes['gen_ai.provider.name']).toBeDefined()
    })

    it('defaults to stable conventions when env var is empty', () => {
      const tracer = new Tracer()

      tracer.startAgentSpan({ messages: [textMessage('user', 'Hi')], agentName: 'agent' })

      const [, options] = getStartSpanCall()
      expect(options.attributes['gen_ai.system']).toBeDefined()
      expect(options.attributes['gen_ai.provider.name']).toBeUndefined()
    })
  })

  describe('memory spans', () => {
    it('startMemorySearchSpan sets attributes and records the query as an event', () => {
      const tracer = new Tracer()

      tracer.startMemorySearchSpan({
        query: 'dark mode preference',
        storeNames: ['personal', 'team'],
        maxSearchResults: 5,
      })

      const [spanName, options] = getStartSpanCall()
      expect(spanName).toBe('memory.search')
      expect(options.attributes).toMatchObject({
        'gen_ai.operation.name': 'memory.search',
        'memory.store.names': JSON.stringify(['personal', 'team']),
        'memory.store.count': 2,
        'memory.max_search_results': 5,
      })
      expect(eventAttr(mockSpan.getEvents('memory.query')[0]!, 'content')).toBe('dark mode preference')
    })

    it('endMemorySearchSpan records result/failure counts and the entries event', () => {
      const tracer = new Tracer()
      const span = tracer.startMemorySearchSpan({ query: 'q', storeNames: ['personal'] })

      tracer.endMemorySearchSpan(span, {
        entries: [{ content: 'likes dark mode', storeName: 'personal', metadata: { score: 0.9 } }],
        storeFailureCount: 1,
      })

      expect(mockSpan.calls.setAttributes).toContainEqual({
        attributes: {
          'memory.result.count': 1,
          'memory.store.failure_count': 1,
          'gen_ai.event.end_time': expect.any(String),
        },
      })
      expect(mockSpan.getEvents('memory.results')).toHaveLength(1)
      expect(mockSpan.calls.setStatus).toContainEqual({ status: { code: SpanStatusCode.OK } })
    })

    it('endMemorySearchSpan records error and skips the results event', () => {
      const tracer = new Tracer()
      const span = tracer.startMemorySearchSpan({ query: 'q', storeNames: ['personal'] })
      const error = new Error('store missing')

      tracer.endMemorySearchSpan(span, { error })

      expect(mockSpan.getEvents('memory.results')).toHaveLength(0)
      expect(mockSpan.calls.setStatus).toContainEqual({
        status: { code: SpanStatusCode.ERROR, message: 'store missing' },
      })
      expect(mockSpan.calls.recordException).toContainEqual({ exception: error, time: undefined })
    })

    it('startMemoryAddSpan records content as an event', () => {
      const tracer = new Tracer()

      tracer.startMemoryAddSpan({ content: 'remember dark mode', storeNames: ['personal'] })

      const [spanName, options] = getStartSpanCall()
      expect(spanName).toBe('memory.add')
      expect(options.attributes).toMatchObject({
        'gen_ai.operation.name': 'memory.add',
        'memory.store.names': JSON.stringify(['personal']),
        'memory.store.count': 1,
      })
      expect(eventAttr(mockSpan.getEvents('memory.content')[0]!, 'content')).toBe('remember dark mode')
    })

    it('endMemoryAddSpan records the store failure count and error', () => {
      const tracer = new Tracer()
      const span = tracer.startMemoryAddSpan({ content: 'x', storeNames: ['personal'] })
      const error = new Error('write failed')

      tracer.endMemoryAddSpan(span, { storeFailureCount: 2, error })

      expect(mockSpan.calls.setStatus).toContainEqual({
        status: { code: SpanStatusCode.ERROR, message: 'write failed' },
      })
      expect(mockSpan.calls.recordException).toContainEqual({ exception: error, time: undefined })
    })

    it('memory inject span: start sets max_entries, end records injected and entry count', () => {
      const tracer = new Tracer()
      const span = tracer.startMemoryInjectSpan({ maxEntries: 5 })

      const [spanName, options] = getStartSpanCall()
      expect(spanName).toBe('memory.inject')
      expect(options.attributes['memory.max_entries']).toBe(5)

      tracer.endMemoryInjectSpan(span, { injected: true, entryCount: 3 })
      expect(mockSpan.calls.setAttributes).toContainEqual({
        attributes: { 'memory.injected': true, 'memory.entry.count': 3, 'gen_ai.event.end_time': expect.any(String) },
      })
      expect(mockSpan.calls.setStatus).toContainEqual({ status: { code: SpanStatusCode.OK } })
    })

    it('endMemoryInjectSpan fails open on a format error (OK status, flag set)', () => {
      const tracer = new Tracer()
      const span = tracer.startMemoryInjectSpan({})

      tracer.endMemoryInjectSpan(span, { injected: false, formatError: true })

      expect(mockSpan.calls.setAttributes).toContainEqual({
        attributes: {
          'memory.injected': false,
          'memory.entry.count': 0,
          'memory.inject.format_error': true,
          'gen_ai.event.end_time': expect.any(String),
        },
      })
      expect(mockSpan.calls.setStatus).toContainEqual({ status: { code: SpanStatusCode.OK } })
      expect(mockSpan.calls.recordException).toHaveLength(0)
    })

    it('startMemoryExtractSpan is a root span (forceRoot, no parent context)', () => {
      const tracer = new Tracer()

      tracer.startMemoryExtractSpan({
        storeName: 'personal',
        messageCount: 2,
        filteredCount: 1,
        extractor: 'ModelExtractor',
      })

      const [spanName, options] = getStartSpanCall()
      expect(spanName).toBe('memory.extract')
      expect(options.attributes).toMatchObject({
        'gen_ai.operation.name': 'memory.extract',
        'memory.store.name': 'personal',
        'memory.message.count': 2,
        'memory.message.filtered_count': 1,
        'memory.extractor': 'ModelExtractor',
      })
      // forceRoot passes ROOT_CONTEXT (no active span) as the third startSpan arg.
      const startCtx = mockStartSpan.mock.calls[0]![2]
      expect(startCtx).toBeDefined()
    })

    it('startMemoryExtractSpan attaches a valid agent span context as a link', () => {
      const tracer = new Tracer()
      const agentSpanContext = {
        traceId: 'abcdef01234567890abcdef012345678',
        spanId: 'abcdef0123456789',
        traceFlags: 1,
      }

      tracer.startMemoryExtractSpan({ storeName: 'personal', messageCount: 1, agentSpanContext })

      const options = mockStartSpan.mock.calls[0]![1] as {
        links?: { context: unknown }[]
        attributes: Record<string, unknown>
      }
      expect(options.links).toHaveLength(1)
      expect(options.links![0]!.context).toBe(agentSpanContext)
      // The detached root has no OTel parent, so the scheduling run's ids are also recorded as
      // plain attributes for backends that don't render span links.
      expect(options.attributes).toMatchObject({
        'memory.parent.trace_id': 'abcdef01234567890abcdef012345678',
        'memory.parent.span_id': 'abcdef0123456789',
      })
    })

    it('startMemoryExtractSpan skips the link and parent ids for an invalid agent span context', () => {
      const tracer = new Tracer()
      const invalid = { traceId: '00000000000000000000000000000000', spanId: '0000000000000000', traceFlags: 0 }

      tracer.startMemoryExtractSpan({ storeName: 'personal', messageCount: 1, agentSpanContext: invalid })

      const options = mockStartSpan.mock.calls[0]![1] as { links?: unknown; attributes: Record<string, unknown> }
      expect(options.links).toBeUndefined()
      expect(options.attributes).not.toHaveProperty('memory.parent.trace_id')
      expect(options.attributes).not.toHaveProperty('memory.parent.span_id')
    })

    it('endMemoryExtractSpan records the entry count on success', () => {
      const tracer = new Tracer()
      const span = tracer.startMemoryExtractSpan({ storeName: 'personal', messageCount: 1 })

      tracer.endMemoryExtractSpan(span, { entryCount: 3 })

      expect(mockSpan.calls.setAttributes).toContainEqual({
        attributes: { 'memory.entry.count': 3, 'gen_ai.event.end_time': expect.any(String) },
      })
      expect(mockSpan.calls.setStatus).toContainEqual({ status: { code: SpanStatusCode.OK } })
    })

    it('endMemoryExtractSpan records error (failures are swallowed by the coordinator)', () => {
      const tracer = new Tracer()
      const span = tracer.startMemoryExtractSpan({ storeName: 'personal', messageCount: 1 })
      const error = new Error('save failed')

      tracer.endMemoryExtractSpan(span, { error })

      expect(mockSpan.calls.setStatus).toContainEqual({
        status: { code: SpanStatusCode.ERROR, message: 'save failed' },
      })
      expect(mockSpan.calls.recordException).toContainEqual({ exception: error, time: undefined })
    })

    it('memory span methods handle a null span gracefully', () => {
      const tracer = new Tracer()
      expect(() => tracer.endMemorySearchSpan(null, { entries: [] })).not.toThrow()
      expect(() => tracer.endMemoryAddSpan(null)).not.toThrow()
      expect(() => tracer.endMemoryInjectSpan(null, { injected: false })).not.toThrow()
      expect(() => tracer.endMemoryExtractSpan(null)).not.toThrow()
    })
  })

  describe('currentSpanContext', () => {
    it('returns undefined when no span is active', () => {
      vi.mocked(trace.getActiveSpan).mockReturnValue(undefined)
      expect(new Tracer().currentSpanContext()).toBeUndefined()
    })

    it('returns undefined for a non-recording active span', () => {
      // A non-recording span (tracing disabled / sampled out) must not be captured for linking.
      const span = { isRecording: () => false, spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 1 }) }
      vi.mocked(trace.getActiveSpan).mockReturnValue(span as unknown as Span)
      expect(new Tracer().currentSpanContext()).toBeUndefined()
    })

    it('returns undefined for a recording span with an invalid (all-zeros) context', () => {
      const invalid = { traceId: '00000000000000000000000000000000', spanId: '0000000000000000', traceFlags: 0 }
      const span = { isRecording: () => true, spanContext: () => invalid }
      vi.mocked(trace.getActiveSpan).mockReturnValue(span as unknown as Span)
      expect(new Tracer().currentSpanContext()).toBeUndefined()
    })

    it('returns the context for a recording span with a valid context', () => {
      const valid = { traceId: 'abcdef01234567890abcdef012345678', spanId: 'abcdef0123456789', traceFlags: 1 }
      const span = { isRecording: () => true, spanContext: () => valid }
      vi.mocked(trace.getActiveSpan).mockReturnValue(span as unknown as Span)
      expect(new Tracer().currentSpanContext()).toBe(valid)
    })
  })
})
