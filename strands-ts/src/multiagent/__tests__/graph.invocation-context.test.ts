import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { InvocationContextImpl, unwrapInvocationContext } from '../../agent/invocation-context.js'
import { limitStopMessage } from '../../types/messages.js'
import { AfterInvocationEvent } from '../../hooks/events.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { Graph } from '../graph.js'
import { Status } from '../state.js'

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
})
