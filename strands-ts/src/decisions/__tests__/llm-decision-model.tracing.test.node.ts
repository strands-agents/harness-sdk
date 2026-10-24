import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

import { TestModelProvider } from '../../__fixtures__/model-test-helpers.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../tools/structured-output-tool.js'
import { LLMDecisionModel } from '../llm-decision-model.js'
import type { StreamOptions } from '../../models/model.js'
import type { ModelStreamEvent, Usage } from '../../models/streaming.js'
import type { Message } from '../../types/messages.js'

const DEFAULT_USAGE: Usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 }

class ToolUseFixture extends TestModelProvider {
  constructor() {
    super()
    this.setEventGenerator(async function* () {
      yield { type: 'modelMessageStartEvent', role: 'assistant' }
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: STRUCTURED_OUTPUT_TOOL_NAME, toolUseId: 'd' },
      }
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify({ q: 'true' }) },
      }
      yield { type: 'modelContentBlockStopEvent' }
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
      yield { type: 'modelMetadataEvent', usage: DEFAULT_USAGE, metrics: { latencyMs: 1 } }
    })
  }
}

describe('LLMDecisionModel tracing', () => {
  let exporter: InMemorySpanExporter
  let provider: NodeTracerProvider

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
    trace.disable()
  })

  it('parents child spans created inside _ask under the decision span', async () => {
    class ChildSpanModel extends TestModelProvider {
      override async *stream(_messages: Message[], _options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
        const span = trace.getTracer('test').startSpan('child_in_ask')
        span.end()
        yield { type: 'modelMessageStartEvent', role: 'assistant' }
        yield {
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: STRUCTURED_OUTPUT_TOOL_NAME, toolUseId: 'd' },
        }
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: JSON.stringify({ q: 'true' }) },
        }
        yield { type: 'modelContentBlockStopEvent' }
        yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
        yield { type: 'modelMetadataEvent', usage: DEFAULT_USAGE, metrics: { latencyMs: 1 } }
      }
    }
    const decision = new LLMDecisionModel({ model: new ChildSpanModel() })

    await decision.ask('x', { q: { question: 'ok?', choices: 'boolean' } })

    const spans = exporter.getFinishedSpans()
    const decisionSpan = spans.find((s) => s.name === 'decision')
    const childSpan = spans.find((s) => s.name === 'child_in_ask')
    expect(decisionSpan).toBeDefined()
    expect(childSpan).toBeDefined()
    expect(childSpan!.parentSpanContext?.spanId).toBe(decisionSpan!.spanContext().spanId)
  })

  it('runs when there is no active parent span', async () => {
    const decision = new LLMDecisionModel({ model: new ToolUseFixture() })

    await context.with(context.active(), () => decision.ask('x', { q: { question: 'ok?', choices: 'boolean' } }))

    const decisionSpan = exporter.getFinishedSpans().find((s) => s.name === 'decision')
    expect(decisionSpan).toBeDefined()
    expect(decisionSpan!.parentSpanContext).toBeUndefined()
  })
})
