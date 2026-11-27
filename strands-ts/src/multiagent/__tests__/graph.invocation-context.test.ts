import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/agent.js'
import {
  InvocationContextImpl,
  unwrapInvocationContext,
  type InvocationContextUsage,
} from '../../agent/invocation-context.js'
import { limitStopMessage } from '../../types/messages.js'
import type { InvokeLimits } from '../../types/agent.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import { AfterInvocationEvent } from '../../hooks/events.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import type { EdgeHandler } from '../edge.js'
import { BeforeNodeCallEvent } from '../events.js'
import { Graph } from '../graph.js'
import { Status } from '../state.js'

/** Agent that answers in one turn, reporting one input and one output token. */
function makeOneTurnAgent(id: string): Agent {
  return new Agent({
    model: new MockMessageModel().addTurn(
      { type: 'textBlock', text: `${id} done` },
      { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    ),
    printer: false,
    id,
  })
}

/** Graph that runs `nodeIds` one after another, each edge gated by `handler` when given. */
function makeChainGraph(nodeIds: string[] = ['a', 'b'], handler?: EdgeHandler): Graph {
  return new Graph({
    nodes: nodeIds.map(makeOneTurnAgent),
    edges: nodeIds.slice(1).map((target, index) => ({ source: nodeIds[index]!, target, ...(handler && { handler }) })),
  })
}

describe('Graph request-wide invocation context', () => {
  it('folds every node model usage and turn into one shared request total', async () => {
    const agentA = new Agent({
      model: new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'A done' },
        { usage: { inputTokens: 10, outputTokens: 25, totalTokens: 35 } }
      ),
      printer: false,
      id: 'a',
    })
    const agentB = new Agent({
      model: new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'B done' },
        { usage: { inputTokens: 20, outputTokens: 35, totalTokens: 55 } }
      ),
      printer: false,
      id: 'b',
    })

    let shared: InvocationContextImpl | undefined
    agentB.addHook(AfterInvocationEvent, (event) => {
      shared = unwrapInvocationContext(event.invocationContext)
    })

    const graph = new Graph({
      nodes: [agentA, agentB],
      edges: [{ source: 'a', target: 'b' }],
    })

    const result = await graph.invoke('hello')

    expect(shared?.usage).toEqual({ turnsTaken: 2, inputTokens: 30, outputTokens: 60, totalTokens: 90 })
    expect(result.invocationContext).toBe(shared)
  })

  it("adds its usage to the request when it runs inside a nested call's own limits", async () => {
    const analyst = new Agent({
      model: new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'done' },
        { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }
      ),
      printer: false,
      id: 'analyst',
    })
    const graph = new Graph({ nodes: [analyst], edges: [] })
    const request = new InvocationContextImpl()
    request.recordUsage({ inputTokens: 100, outputTokens: 100, totalTokens: 200 })

    const nested = new InvocationContextImpl({ turns: 5 }, request)

    const result = await graph.invoke('analyze', { invocationContext: nested })

    expect({ context: result.invocationContext, ownUsage: nested.usage, requestUsage: request.usage }).toEqual({
      context: nested,
      ownUsage: { turnsTaken: 1, inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      requestUsage: { turnsTaken: 1, inputTokens: 102, outputTokens: 103, totalTokens: 205 },
    })
  })

  it('fails a node whose agent stops on the forwarded request limit', async () => {
    const analyst = new Agent({
      model: new MockMessageModel().addTurn({ type: 'textBlock', text: 'never reached' }),
      printer: false,
      id: 'analyst',
    })
    const graph = new Graph({ nodes: [analyst], edges: [] })
    const spentRequest = new InvocationContextImpl({ turns: 1 })
    spentRequest.usage.turnsTaken = 1

    const result = await graph.invoke('analyze', { invocationContext: spentRequest })

    expect(result.results).toEqual([
      expect.objectContaining({
        nodeId: 'analyst',
        status: Status.FAILED,
        error: new Error(limitStopMessage('analyst', 'limitTurns')),
      }),
    ])
  })

  it('fails the node that reaches the limits a root graph starts its request with, and runs none after it', async () => {
    const result = await makeChainGraph(['a', 'b', 'c']).invoke('go', { limits: { turns: 1 } })

    expect({
      status: result.status,
      nodes: result.results.map(({ nodeId, status, error }) => ({ nodeId, status, error })),
      usage: result.invocationContext?.usage,
    }).toEqual({
      status: Status.FAILED,
      nodes: [
        { nodeId: 'a', status: Status.COMPLETED },
        { nodeId: 'b', status: Status.FAILED, error: new Error(limitStopMessage('b', 'limitTurns')) },
      ],
      usage: { turnsTaken: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    })
  })

  it('fails a node queued on an independent branch on its first turn check, without calling its model', async () => {
    const graph = new Graph({ nodes: [makeOneTurnAgent('a'), makeOneTurnAgent('b')], edges: [], maxConcurrency: 1 })

    const result = await graph.invoke('go', { limits: { turns: 1 } })

    expect({
      nodes: result.results.map(({ nodeId, status, error }) => ({ nodeId, status, error })),
      usage: result.invocationContext?.usage,
    }).toEqual({
      nodes: [
        { nodeId: 'a', status: Status.COMPLETED },
        { nodeId: 'b', status: Status.FAILED, error: new Error(limitStopMessage('b', 'limitTurns')) },
      ],
      usage: { turnsTaken: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    })
  })

  it.each([
    { case: 'its own limits are stricter', requestLimits: { turns: 5 }, ownLimits: { turns: 1 } },
    { case: "the request's limits are stricter", requestLimits: { turns: 1 }, ownLimits: { turns: 5 } },
  ])('stops a nested graph with its own limits when $case', async ({ requestLimits, ownLimits }) => {
    const request = new InvocationContextImpl(requestLimits)

    const result = await makeChainGraph().invoke('go', { invocationContext: request, limits: ownLimits })

    expect({
      failedNode: result.results.find((nodeResult) => nodeResult.status === Status.FAILED)?.error,
      ownUsage: result.invocationContext?.usage,
      requestUsage: request.usage,
    }).toEqual({
      failedNode: new Error(limitStopMessage('b', 'limitTurns')),
      ownUsage: { turnsTaken: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      requestUsage: { turnsTaken: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    })
    expect(result.invocationContext).not.toBe(request)
  })

  it.each([
    { case: 'a non-positive limit', limits: { turns: 0 }, message: 'limits.turns must be a positive finite number' },
    { case: 'an unrecognized key', limits: { turn: 3 } as InvokeLimits, message: 'are not recognized limits' },
  ])('rejects $case', async ({ limits, message }) => {
    const invocation = makeChainGraph().invoke('go', { limits })

    await expect(invocation).rejects.toThrow(TypeError)
    await expect(invocation).rejects.toThrow(message)
  })

  it("attaches the request's invocation context to every multi-agent event", async () => {
    const graph = makeChainGraph()
    graph.addHook(BeforeNodeCallEvent, (event) => {
      if (event.nodeId === 'b') event.cancel = true
    })

    const { items, result } = await collectGenerator(graph.stream('go', { limits: { turns: 5 } }))

    expect(new Set(items.map((event) => event.type))).toEqual(
      new Set([
        'beforeMultiAgentInvocationEvent',
        'beforeNodeCallEvent',
        'nodeStreamUpdateEvent',
        'nodeResultEvent',
        'afterNodeCallEvent',
        'multiAgentHandoffEvent',
        'nodeCancelEvent',
        'afterMultiAgentInvocationEvent',
        'multiAgentResultEvent',
      ])
    )
    expect(items.filter((event) => event.invocationContext !== result.invocationContext)).toEqual([])
  })

  it("lets an edge handler read the request's usage from the state", async () => {
    let usageSeenByEdge: InvocationContextUsage | undefined
    const graph = makeChainGraph(['a', 'b'], (state) => {
      usageSeenByEdge = { ...state.invocationContext!.usage }
      return true
    })

    await graph.invoke('go')

    expect(usageSeenByEdge).toEqual({ turnsTaken: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 })
  })

  it('binds a resumed run to its own request', async () => {
    const graph = makeChainGraph()
    graph.addHook(BeforeNodeCallEvent, (event) => {
      if (event.nodeId === 'a') event.interrupt({ name: 'approval', reason: 'approve?' })
    })
    const interrupted = await graph.invoke('go')
    const response = new InterruptResponseContent({ interruptId: interrupted.interrupts![0]!.id, response: 'yes' })

    const { items, result } = await collectGenerator(graph.stream([response]))

    expect(result.invocationContext).not.toBe(interrupted.invocationContext)
    expect(items.filter((event) => event.invocationContext !== result.invocationContext)).toEqual([])
  })
})
