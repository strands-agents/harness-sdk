import { describe, expect, it, vi, beforeEach, type MockInstance } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { TextBlock } from '../../types/messages.js'
import type { JSONValue } from '../../types/json.js'
import { Tracer } from '../../telemetry/tracer.js'
import { Swarm } from '../swarm.js'
import { BeforeNodeCallEvent } from '../events.js'
import { Status } from '../state.js'

interface MockTracerInstance {
  startAgentSpan: MockInstance
  endAgentSpan: MockInstance
  startAgentLoopSpan: MockInstance
  endAgentLoopSpan: MockInstance
  startModelInvokeSpan: MockInstance
  endModelInvokeSpan: MockInstance
  startToolCallSpan: MockInstance
  endToolCallSpan: MockInstance
  startMultiAgentSpan: MockInstance
  endMultiAgentSpan: MockInstance
  startNodeSpan: MockInstance
  endNodeSpan: MockInstance
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
      startMultiAgentSpan: vi.fn().mockReturnValue({ mock: 'multiAgentSpan' }),
      endMultiAgentSpan: vi.fn(),
      startNodeSpan: vi.fn().mockReturnValue({ mock: 'nodeSpan' }),
      endNodeSpan: vi.fn(),
      withSpanContext: vi.fn((_span: unknown, fn: () => unknown) => fn()),
    }
  }),
}))

/**
 * Returns the Tracer mock instance owned by the Swarm.
 * Agents are constructed before the Swarm, so the Swarm's Tracer
 * is always the last one created during Swarm construction.
 */
function getSwarmTracer(): MockTracerInstance {
  return vi.mocked(Tracer).mock.results.at(-1)!.value
}

function createHandoffAgent(
  agentId: string,
  handoff: { agentId?: string; message: string; context?: Record<string, unknown> },
  description: string = `Agent ${agentId}`
): Agent {
  const model = new MockMessageModel()
    .addTurn({
      type: 'toolUseBlock',
      name: 'strands_structured_output',
      toolUseId: 'tool-1',
      input: handoff as JSONValue,
    })
    .addTurn(new TextBlock('Done'))
  return new Agent({ model, printer: false, id: agentId, description })
}

function createHandoffAgentWithUsage(
  agentId: string,
  handoff: { agentId?: string; message: string; context?: Record<string, unknown> },
  description: string = `Agent ${agentId}`
): Agent {
  const model = new MockMessageModel()
    .addTurn(
      {
        type: 'toolUseBlock',
        name: 'strands_structured_output',
        toolUseId: 'tool-1',
        input: handoff as JSONValue,
      },
      { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
    )
    .addTurn(new TextBlock('Done'))
  return new Agent({ model, printer: false, id: agentId, description })
}

describe('Swarm tracer integration', () => {
  let swarm: Swarm
  let tracer: MockTracerInstance

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('multi-agent span lifecycle', () => {
    it('starts and ends multi-agent span on successful invocation', async () => {
      swarm = new Swarm({ id: 'test-swarm', nodes: [createHandoffAgent('a', { message: 'final response' })] })
      tracer = getSwarmTracer()

      await swarm.invoke('Hello')

      expect(tracer.startMultiAgentSpan.mock.calls).toEqual([
        [{ orchestratorId: 'test-swarm', orchestratorType: 'swarm', input: 'Hello' }],
      ])
      expect(tracer.endMultiAgentSpan.mock.calls.length).toBe(1)

      const [span, endOpts] = tracer.endMultiAgentSpan.mock.calls[0]!
      expect(span).toStrictEqual({ mock: 'multiAgentSpan' })
      expect(endOpts).toEqual({
        duration: expect.any(Number),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      })
      expect(endOpts.duration).toBeGreaterThanOrEqual(0)
    })

    it('passes exact usage from result to endMultiAgentSpan', async () => {
      swarm = new Swarm({ id: 'test-swarm', nodes: [createHandoffAgentWithUsage('a', { message: 'final response' })] })
      tracer = getSwarmTracer()

      await swarm.invoke('Hello')

      const [, endOpts] = tracer.endMultiAgentSpan.mock.calls[0]!
      expect(endOpts.usage).toStrictEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    })

    it('ends multi-agent span with error when maxSteps exceeded', async () => {
      swarm = new Swarm({
        nodes: [
          createHandoffAgent('a', { agentId: 'b', message: 'go' }),
          createHandoffAgent('b', { agentId: 'a', message: 'go' }),
        ],
        maxSteps: 1,
      })
      tracer = getSwarmTracer()

      await expect(swarm.invoke('Hello')).rejects.toThrow('swarm reached step limit')

      const [span, endOpts] = tracer.endMultiAgentSpan.mock.calls[0]!
      expect(span).toStrictEqual({ mock: 'multiAgentSpan' })
      expect(endOpts).toEqual({
        duration: expect.any(Number),
        error: expect.objectContaining({
          message: expect.stringContaining('swarm reached step limit'),
        }),
      })
      expect(endOpts.duration).toBeGreaterThanOrEqual(0)
    })
  })

  describe('node span lifecycle', () => {
    it('starts and ends node span for each agent in handoff chain', async () => {
      swarm = new Swarm({
        nodes: [
          createHandoffAgent('a', { agentId: 'b', message: 'go to b' }),
          createHandoffAgent('b', { message: 'final response' }),
        ],
      })
      tracer = getSwarmTracer()

      await swarm.invoke('Hello')

      expect(tracer.startNodeSpan.mock.calls).toEqual([
        [{ nodeId: 'a', nodeType: 'agentNode' }],
        [{ nodeId: 'b', nodeType: 'agentNode' }],
      ])
      expect(tracer.endNodeSpan.mock.calls.length).toBe(2)
    })

    it('ends node span with COMPLETED status, duration, and zero usage on success', async () => {
      swarm = new Swarm({ nodes: [createHandoffAgent('a', { message: 'final response' })] })
      tracer = getSwarmTracer()

      await swarm.invoke('Hello')

      const [span, endOpts] = tracer.endNodeSpan.mock.calls[0]!
      expect(span).toStrictEqual({ mock: 'nodeSpan' })
      expect(endOpts).toEqual({
        status: Status.COMPLETED,
        duration: expect.any(Number),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      })
      expect(endOpts.duration).toBeGreaterThanOrEqual(0)
    })

    it('passes exact usage from node result to endNodeSpan', async () => {
      swarm = new Swarm({ nodes: [createHandoffAgentWithUsage('a', { message: 'final response' })] })
      tracer = getSwarmTracer()

      await swarm.invoke('Hello')

      const [, endOpts] = tracer.endNodeSpan.mock.calls[0]!
      expect(endOpts.status).toBe(Status.COMPLETED)
      expect(endOpts.usage).toStrictEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    })

    it('ends node span with error when node agent throws', async () => {
      const model = new MockMessageModel().addTurn(new Error('agent exploded'))
      swarm = new Swarm({ nodes: [new Agent({ model, printer: false, id: 'a', description: 'Agent a' })] })
      tracer = getSwarmTracer()

      const result = await swarm.invoke('Hello')

      expect(result.status).toBe(Status.FAILED)
      const [span, endOpts] = tracer.endNodeSpan.mock.calls[0]!
      expect(span).toStrictEqual({ mock: 'nodeSpan' })
      expect(endOpts).toEqual({
        status: Status.FAILED,
        duration: expect.any(Number),
      })
      expect(endOpts.duration).toBeGreaterThanOrEqual(0)
    })

    it('ends node span with CANCELLED status and zero duration when cancelled by hook', async () => {
      swarm = new Swarm({ nodes: [createHandoffAgent('a', { message: 'final response' })] })
      tracer = getSwarmTracer()
      swarm.addHook(BeforeNodeCallEvent, (event) => {
        event.cancel = 'cancelled by test'
      })

      await swarm.invoke('Hello')

      expect(tracer.endNodeSpan.mock.calls).toEqual([[{ mock: 'nodeSpan' }, { status: Status.CANCELLED, duration: 0 }]])
    })
  })

  describe('null span handling', () => {
    it('completes successfully when startMultiAgentSpan returns null', async () => {
      swarm = new Swarm({ nodes: [createHandoffAgent('a', { message: 'final response' })] })
      tracer = getSwarmTracer()
      tracer.startMultiAgentSpan.mockReturnValue(null)

      const result = await swarm.invoke('Hello')

      expect(result.status).toBe(Status.COMPLETED)
      const [span] = tracer.endMultiAgentSpan.mock.calls[0]!
      expect(span).toBeNull()
    })

    it('completes successfully when startNodeSpan returns null', async () => {
      swarm = new Swarm({ nodes: [createHandoffAgent('a', { message: 'final response' })] })
      tracer = getSwarmTracer()
      tracer.startNodeSpan.mockReturnValue(null)

      const result = await swarm.invoke('Hello')

      expect(result.status).toBe(Status.COMPLETED)
      const [span] = tracer.endNodeSpan.mock.calls[0]!
      expect(span).toBeNull()
    })
  })

  describe('span context propagation', () => {
    it('passes node span to every withSpanContext call during node execution', async () => {
      swarm = new Swarm({ nodes: [createHandoffAgent('a', { message: 'final response' })] })
      tracer = getSwarmTracer()

      await swarm.invoke('Hello')

      // First call: multiAgentSpan to create nodeSpan, then nodeSpan for node.stream() + gen.next() calls
      const calls = tracer.withSpanContext.mock.calls
      expect(calls.length).toBeGreaterThanOrEqual(3)

      // First call uses multiAgentSpan to create the nodeSpan
      expect(calls[0]).toEqual([{ mock: 'multiAgentSpan' }, expect.any(Function)])

      // Subsequent calls use nodeSpan for node execution
      const subsequentCalls = calls.slice(1)
      expect(subsequentCalls).toEqual(
        expect.arrayContaining(Array(subsequentCalls.length).fill([{ mock: 'nodeSpan' }, expect.any(Function)]))
      )
    })
  })

  describe('handoff chain tracing', () => {
    it('creates node spans for each agent in a multi-hop handoff', async () => {
      swarm = new Swarm({
        nodes: [
          createHandoffAgent('a', { agentId: 'b', message: 'go to b' }),
          createHandoffAgent('b', { agentId: 'c', message: 'go to c' }),
          createHandoffAgent('c', { message: 'final response' }),
        ],
      })
      tracer = getSwarmTracer()

      await swarm.invoke('Hello')

      expect(tracer.startNodeSpan).toHaveBeenCalledTimes(3)
      const nodeIds = tracer.startNodeSpan.mock.calls.map((call) => call[0].nodeId)
      expect(nodeIds).toStrictEqual(['a', 'b', 'c'])
      expect(tracer.endNodeSpan).toHaveBeenCalledTimes(3)
    })

    it('accumulates usage across handoff chain', async () => {
      swarm = new Swarm({
        nodes: [
          createHandoffAgentWithUsage('a', { agentId: 'b', message: 'go to b' }),
          createHandoffAgentWithUsage('b', { message: 'final response' }),
        ],
      })
      tracer = getSwarmTracer()

      await swarm.invoke('Hello')

      const [, endOpts] = tracer.endMultiAgentSpan.mock.calls[0]!
      expect(endOpts.usage).toStrictEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30 })
    })
  })
})
