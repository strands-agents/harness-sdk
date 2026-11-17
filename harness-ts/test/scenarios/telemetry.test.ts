import { InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createHarness } from '../../src/agent.js'
import { checkInvariants, record, type Recording } from './recording.js'
import { ScriptedModel } from './scripted-model.js'
import { useWorkDir } from './work-dir.js'

describe('telemetry', () => {
  useWorkDir()
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })

  // The SDK traces through the global OTel provider, which is how an exporter reaches a harness agent.
  beforeAll(() => provider.register())
  beforeEach(() => exporter.reset())
  afterAll(() => provider.shutdown())

  async function turnWithToolCall(memory: boolean): Promise<{ recording: Recording; spans: ReadableSpan[] }> {
    const model = new ScriptedModel([[['shell', { command: 'echo hi' }]], 'hi'])
    const agent = await createHarness({ model, memory, printer: false })
    const recording = record(agent)
    await agent.invoke('Say hi.')
    model.assertExhausted()
    checkInvariants(recording, agent)
    return { recording, spans: exporter.getFinishedSpans() }
  }

  const id = (span: ReadableSpan): string => span.spanContext().spanId
  const usageOf = (span: ReadableSpan): Record<string, unknown> => ({
    inputTokens: span.attributes['gen_ai.usage.input_tokens'],
    outputTokens: span.attributes['gen_ai.usage.output_tokens'],
    cacheReadInputTokens: span.attributes['gen_ai.usage.cache_read.input_tokens'] ?? 0,
    cacheWriteInputTokens: span.attributes['gen_ai.usage.cache_creation.input_tokens'] ?? 0,
  })
  const parent = (span: ReadableSpan): string | undefined => span.parentSpanContext?.spanId

  it(
    'nests model and tool spans under the agent span and reports usage with cache tokens on model spans',
    { timeout: 30_000 },
    async () => {
      const { recording, spans } = await turnWithToolCall(false)
      const named = (prefix: string): ReadableSpan[] => spans.filter((span) => span.name.startsWith(prefix))

      const [invocation] = named('invoke_agent')
      const cycles = named('execute_agent_loop_cycle')
      const chats = named('chat')
      const [shell] = named('execute_tool shell')
      expect(parent(invocation!)).toBeUndefined()
      expect(cycles.map(parent)).toEqual([id(invocation!), id(invocation!)])
      expect(chats.map(parent)).toEqual(cycles.map(id))
      expect(parent(shell!)).toBe(id(cycles[0]!))

      const usage = recording.calls.map((call) => call.usage!)
      expect(usage[0]!.cacheWriteInputTokens).toBeGreaterThan(0)
      expect(usage[1]!.cacheReadInputTokens).toBeGreaterThan(0)
      expect(chats.map(usageOf)).toEqual(usage.map(({ totalTokens: _total, ...tokens }) => tokens))
      const keys = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens'] as const
      const total = Object.fromEntries(keys.map((key) => [key, usage.reduce((sum, call) => sum + (call[key] ?? 0), 0)]))
      expect(usageOf(invocation!)).toEqual(total)
    }
  )

  // memory.inject starts outside the agent span's context, so it and memory.search open a second trace.
  it.fails('keeps every span of a turn in one trace', { timeout: 30_000 }, async () => {
    const { spans } = await turnWithToolCall(true)

    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1)
  })
})
