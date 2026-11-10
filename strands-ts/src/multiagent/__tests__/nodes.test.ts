import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent } from '../../agent/agent.js'
import { AgentPrinter } from '../../agent/printer.js'
import { BeforeInvocationEvent } from '../../hooks/events.js'
import type { MultiAgentInput } from '../multiagent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import { TextBlock } from '../../types/messages.js'
import { MultiAgentResult, MultiAgentState, NodeResult, Status } from '../state.js'
import type { MultiAgentStreamEvent } from '../events.js'
import { MultiAgentHandoffEvent, NodeStreamUpdateEvent } from '../events.js'
import { AgentNode, MultiAgentNode, Node } from '../nodes.js'
import type { MultiAgent } from '../multiagent.js'
import type { NodeResultUpdate } from '../state.js'

/**
 * Concrete Node subclass for testing the abstract base class.
 */
class TestNode extends Node {
  private readonly _fn: (
    args: MultiAgentInput,
    state: MultiAgentState
  ) => AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined>

  constructor(
    id: string,
    fn: (
      args: MultiAgentInput,
      state: MultiAgentState
    ) => AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined>
  ) {
    super(id, {})
    this._fn = fn
  }

  async *handle(
    args: MultiAgentInput,
    state: MultiAgentState
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined> {
    return yield* this._fn(args, state)
  }
}

describe('Node', () => {
  let state: MultiAgentState

  beforeEach(() => {
    state = new MultiAgentState({ nodeIds: ['test-node', 'fail-node'] })
  })

  describe('stream', () => {
    it('returns COMPLETED NodeResult on successful execution', async () => {
      const content = [new TextBlock('result')]
      const node = new TestNode('test-node', async function* () {
        yield* []
        return { content }
      })

      const { items, result } = await collectGenerator(node.stream([], state))

      const resultEvent = items.find((e) => e.type === 'nodeResultEvent')
      expect(resultEvent).toEqual({
        type: 'nodeResultEvent',
        nodeId: 'test-node',
        nodeType: 'node',
        state,
        result,
        invocationState: {},
      })

      expect(result).toEqual({
        type: 'nodeResult',
        nodeId: 'test-node',
        status: Status.COMPLETED,
        content,
        duration: expect.any(Number),
      })
    })

    it('catches errors and returns FAILED NodeResult', async () => {
      const node = new TestNode('fail-node', async function* () {
        yield* []
        throw new Error('boom')
      })

      const { items, result } = await collectGenerator(node.stream([], state))

      const resultEvent = items.find((e) => e.type === 'nodeResultEvent')
      expect(resultEvent).toEqual({
        type: 'nodeResultEvent',
        nodeId: 'fail-node',
        nodeType: 'node',
        state,
        result,
        invocationState: {},
      })

      expect(result).toEqual({
        type: 'nodeResult',
        nodeId: 'fail-node',
        status: Status.FAILED,
        content: [],
        duration: expect.any(Number),
        error: expect.objectContaining({ message: 'boom' }),
      })
    })
  })
})

describe('AgentNode', () => {
  let agent: Agent
  let node: AgentNode
  let state: MultiAgentState

  beforeEach(() => {
    const model = new MockMessageModel().addTurn(new TextBlock('reply'))
    agent = new Agent({ model, printer: false, appState: { key1: 'value1' }, id: 'agent-1' })
    node = new AgentNode({ agent })
    state = new MultiAgentState({ nodeIds: ['agent-1'] })
  })

  describe('constructor', () => {
    it('throws when timeout < 1', () => {
      expect(() => new AgentNode({ agent, timeout: 0 })).toThrow('timeout=<0>, node_id=<agent-1> | must be at least 1')
    })

    it('accepts a positive timeout', () => {
      const timedNode = new AgentNode({ agent, timeout: 5_000 })
      expect(timedNode.timeout).toBe(5_000)
    })

    it('accepts Infinity as an explicit opt-out', () => {
      const timedNode = new AgentNode({ agent, timeout: Infinity })
      expect(timedNode.timeout).toBe(Infinity)
    })

    it('defaults preserveContext to false', () => {
      expect(node.preserveContext).toBe(false)
    })

    it('stores the preserveContext flag when provided', () => {
      const preserveContextNode = new AgentNode({ agent, preserveContext: true })
      expect(preserveContextNode.preserveContext).toBe(true)
    })

    it('throws when preserveContext is set with a non-Agent InvokableAgent', () => {
      const customAgent = {
        id: 'custom',
        async invoke() {
          throw new Error('not used')
        },
        // eslint-disable-next-line require-yield
        async *stream() {
          throw new Error('not used')
        },
        addHook() {
          return () => {}
        },
      }
      expect(() => new AgentNode({ agent: customAgent, preserveContext: true })).toThrow(
        /preserveContext=true requires an Agent/
      )
    })
  })

  describe('handle', () => {
    it('wraps agent events and returns content', async () => {
      const { items, result } = await collectGenerator(node.stream([new TextBlock('prompt')], state))

      const streamEvents = items.filter((e) => e.type === 'nodeStreamUpdateEvent')
      expect(streamEvents.length).toBeGreaterThan(0)
      for (const event of streamEvents) {
        expect(event).toEqual(
          expect.objectContaining({ type: 'nodeStreamUpdateEvent', nodeId: 'agent-1', nodeType: 'agentNode' })
        )
      }

      const resultEvent = items.find((e) => e.type === 'nodeResultEvent')
      expect(resultEvent).toEqual(
        expect.objectContaining({ type: 'nodeResultEvent', nodeId: 'agent-1', nodeType: 'agentNode', result })
      )

      expect(result).toEqual({
        type: 'nodeResult',
        nodeId: 'agent-1',
        status: Status.COMPLETED,
        content: expect.arrayContaining([expect.objectContaining({ type: 'textBlock', text: 'reply' })]),
        duration: expect.any(Number),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      })
    })

    it('restores agent messages and state after execution', async () => {
      const messagesBefore = [...agent.messages]
      const stateBefore = agent.appState.getAll()

      await collectGenerator(node.stream([new TextBlock('prompt')], state))

      expect(agent.messages).toStrictEqual(messagesBefore)
      expect(agent.appState.getAll()).toStrictEqual(stateBefore)
    })

    it('retains agent messages across executions when preserveContext is true', async () => {
      const model = new MockMessageModel().addTurn(new TextBlock('reply-1')).addTurn(new TextBlock('reply-2'))
      const preserveContextAgent = new Agent({ model, printer: false, id: 'preserve-context-agent' })
      const preserveContextNode = new AgentNode({ agent: preserveContextAgent, preserveContext: true })
      const preserveContextState = new MultiAgentState({ nodeIds: ['preserve-context-agent'] })

      await collectGenerator(preserveContextNode.stream([new TextBlock('first')], preserveContextState))
      const messagesAfterFirst = preserveContextAgent.messages.length
      expect(messagesAfterFirst).toBeGreaterThan(0)

      await collectGenerator(preserveContextNode.stream([new TextBlock('second')], preserveContextState))

      expect(preserveContextAgent.messages.length).toBeGreaterThan(messagesAfterFirst)
    })

    it('retains appState mutations across executions when preserveContext is true', async () => {
      const model = new MockMessageModel().addTurn(new TextBlock('reply-1')).addTurn(new TextBlock('reply-2'))
      const preserveContextAgent = new Agent({ model, printer: false, id: 'preserve-context-agent' })
      // Hook bumps a counter on appState every time the agent is invoked.
      preserveContextAgent.addHook(BeforeInvocationEvent, (event) => {
        const count = event.agent.appState.get<{ count: number }>('count') ?? 0
        event.agent.appState.set('count', count + 1)
      })
      const preserveContextNode = new AgentNode({ agent: preserveContextAgent, preserveContext: true })
      const preserveContextState = new MultiAgentState({ nodeIds: ['preserve-context-agent'] })

      await collectGenerator(preserveContextNode.stream([new TextBlock('first')], preserveContextState))
      expect(preserveContextAgent.appState.get<{ count: number }>('count')).toBe(1)

      await collectGenerator(preserveContextNode.stream([new TextBlock('second')], preserveContextState))
      expect(preserveContextAgent.appState.get<{ count: number }>('count')).toBe(2)
    })

    it('leaves the original printer in place when bufferOutput is not set', async () => {
      const writes: string[] = []
      const printer = new AgentPrinter((text) => writes.push(text))
      ;(agent as unknown as { _printer: AgentPrinter })._printer = printer

      // Capture the active printer at every stream event — confirms it never gets
      // swapped for a buffering printer mid-stream on the sequential path.
      const seenPrinters: unknown[] = []
      const gen = node.stream([new TextBlock('prompt')], state)
      for await (const _event of gen) {
        seenPrinters.push((agent as unknown as { _printer: AgentPrinter })._printer)
      }

      expect(seenPrinters.every((p) => p === printer)).toBe(true)
      expect(writes.join('')).toContain('reply')
    })

    it('buffers printer output when bufferOutput is true and flushes on completion', async () => {
      const writes: string[] = []
      const printer = new AgentPrinter((text) => writes.push(text))
      ;(agent as unknown as { _printer: AgentPrinter })._printer = printer

      // While streaming, a buffering printer is installed in place of the original.
      const printerDuringStream: unknown[] = []
      const gen = node.stream([new TextBlock('prompt')], state, { bufferOutput: true })
      for await (const _event of gen) {
        printerDuringStream.push((agent as unknown as { _printer: AgentPrinter })._printer)
      }

      expect(printerDuringStream.some((p) => p !== printer)).toBe(true)
      expect((agent as unknown as { _printer: AgentPrinter })._printer).toBe(printer)
      expect(writes.join('')).toContain('reply')
    })

    it('passes structuredOutputSchema from options to the agent', async () => {
      const schema = z.object({ agentName: z.string().optional(), message: z.string() })

      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'tool-1',
          input: { message: 'hello' },
        })
        .addTurn({ type: 'textBlock', text: 'Done' })

      agent = new Agent({ model, printer: false, id: 'schema-agent' })
      node = new AgentNode({ agent })
      state = new MultiAgentState({ nodeIds: ['schema-agent'] })

      const { result } = await collectGenerator(node.stream('test', state, { structuredOutputSchema: schema }))

      expect(result.structuredOutput).toStrictEqual({ message: 'hello' })
    })
  })

  describe('agent', () => {
    it('exposes the wrapped agent instance', () => {
      expect(node.agent).toBe(agent)
    })
  })
})

describe('MultiAgentNode', () => {
  const content = [new TextBlock('inner-result')]

  /**
   * Creates a mock orchestrator that yields the given events and returns a result with the given content.
   */
  function mockOrchestrator(id: string, events: MultiAgentStreamEvent[]): MultiAgent {
    return {
      id,
      invoke: async () => new MultiAgentResult({ results: [], duration: 0 }),
      async *stream() {
        for (const event of events) {
          yield event
        }
        return new MultiAgentResult({
          results: [new NodeResult({ nodeId: id, status: Status.COMPLETED, duration: 0, content })],
          content,
          duration: 0,
        })
      },
      addHook: () => () => {},
    }
  }

  let node: MultiAgentNode
  let state: MultiAgentState

  beforeEach(() => {
    const orchestrator = mockOrchestrator('inner', [])
    node = new MultiAgentNode({ orchestrator })
    state = new MultiAgentState({ nodeIds: ['inner'] })
  })

  describe('constructor', () => {
    it('derives id from orchestrator', () => {
      expect(node.id).toBe('inner')
    })
  })

  describe('handle', () => {
    it('passes through inner NodeStreamUpdateEvents', async () => {
      const innerUpdate = new MultiAgentHandoffEvent({ source: 'x', targets: ['y'], state, invocationState: {} })
      const innerEvent = new NodeStreamUpdateEvent({
        nodeId: 'deep-node',
        nodeType: 'agentNode',
        state,
        inner: { source: 'multiAgent', event: innerUpdate },
        invocationState: {},
      })
      const orchestrator = mockOrchestrator('inner', [innerEvent])
      node = new MultiAgentNode({ orchestrator })

      const { items } = await collectGenerator(node.stream([], state))

      const streamEvents = items.filter((e) => e.type === 'nodeStreamUpdateEvent') as NodeStreamUpdateEvent[]
      const passthrough = streamEvents.find((e) => e.nodeId === 'deep-node')
      expect(passthrough).toBe(innerEvent)
    })

    it('wraps non-NodeStreamUpdateEvents with this node identity', async () => {
      const handoff = new MultiAgentHandoffEvent({ source: 'a', targets: ['b'], state, invocationState: {} })
      const orchestrator = mockOrchestrator('inner', [handoff])
      node = new MultiAgentNode({ orchestrator })

      const { items } = await collectGenerator(node.stream([], state))

      const streamEvents = items.filter((e) => e.type === 'nodeStreamUpdateEvent') as NodeStreamUpdateEvent[]
      const wrapped = streamEvents.find((e) => e.nodeId === 'inner' && e.inner.event === handoff)
      expect(wrapped).toBeDefined()
      expect(wrapped!.nodeType).toBe('multiAgentNode')
    })

    it('returns orchestrator content', async () => {
      const { result } = await collectGenerator(node.stream([], state))

      expect(result).toEqual(
        expect.objectContaining({
          nodeId: 'inner',
          status: Status.COMPLETED,
          content,
        })
      )
    })

    it('propagates FAILED status from inner orchestrator', async () => {
      const failedOrchestrator: MultiAgent = {
        id: 'inner',
        invoke: async () => new MultiAgentResult({ results: [], duration: 0 }),
        async *stream() {
          yield* []
          return new MultiAgentResult({
            status: Status.FAILED,
            results: [
              new NodeResult({ nodeId: 'x', status: Status.FAILED, duration: 0, error: new Error('inner boom') }),
            ],
            content: [],
            duration: 0,
            error: new Error('inner boom'),
          })
        },
        addHook: () => () => {},
      }
      node = new MultiAgentNode({ orchestrator: failedOrchestrator })

      const { result } = await collectGenerator(node.stream([], state))

      expect(result.status).toBe(Status.FAILED)
      expect(result.error?.message).toBe('inner boom')
    })

    it('propagates CANCELLED status from inner orchestrator', async () => {
      const cancelledOrchestrator: MultiAgent = {
        id: 'inner',
        invoke: async () => new MultiAgentResult({ results: [], duration: 0 }),
        async *stream() {
          yield* []
          return new MultiAgentResult({
            status: Status.CANCELLED,
            results: [],
            content: [],
            duration: 0,
          })
        },
        addHook: () => () => {},
      }
      node = new MultiAgentNode({ orchestrator: cancelledOrchestrator })

      const { result } = await collectGenerator(node.stream([], state))

      expect(result.status).toBe(Status.CANCELLED)
    })
  })

  describe('orchestrator', () => {
    it('exposes the wrapped orchestrator instance', () => {
      const orchestrator = mockOrchestrator('test', [])
      node = new MultiAgentNode({ orchestrator })
      expect(node.orchestrator).toBe(orchestrator)
    })
  })
})
