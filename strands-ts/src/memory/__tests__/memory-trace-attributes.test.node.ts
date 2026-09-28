import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { trace } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { Agent } from '../../agent/agent.js'
import { MemoryManager } from '../memory-manager.js'
import type { MemoryStore } from '../types.js'

// Regression tests: Agent traceAttributes must reach memory spans, which MemoryManager emits
// through its own Tracer rather than the agent's.
const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })

function createStore(): MemoryStore {
  return { name: 'personal', writable: true, search: vi.fn().mockResolvedValue([]), add: vi.fn() }
}

describe('Agent traceAttributes on memory spans', () => {
  beforeAll(() => {
    trace.setGlobalTracerProvider(provider)
  })
  afterEach(() => {
    exporter.reset()
  })
  afterAll(async () => {
    await provider.shutdown()
    trace.disable()
  })

  it('applies them when memoryManager is given as config', async () => {
    const agent = new Agent({
      traceAttributes: { 'session.id': 'sess-1' },
      memoryManager: { stores: [createStore()], injection: false },
    })

    await agent.memoryManager!.search('q')
    await agent.memoryManager!.add('c')

    const spans = exporter.getFinishedSpans()
    expect(spans.map((s) => s.name)).toEqual(['memory.search', 'memory.add'])
    for (const s of spans) expect(s.attributes['session.id'], s.name).toBe('sess-1')
  })

  it('applies them when memoryManager is given as an instance', async () => {
    const memoryManager = new MemoryManager({ stores: [createStore()], injection: false })
    new Agent({ traceAttributes: { 'session.id': 'sess-2' }, memoryManager })

    await memoryManager.search('q')

    const [span] = exporter.getFinishedSpans()
    expect(span!.attributes['session.id']).toBe('sess-2')
  })
})
