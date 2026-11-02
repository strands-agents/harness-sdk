import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { InvocationContextImpl, unwrapInvocationContext } from '../../agent/invocation-context.js'
import { AfterInvocationEvent } from '../../hooks/events.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import type { JSONValue } from '../../types/json.js'
import type { InvokeLimits } from '../../types/agent.js'
import { limitStopMessage } from '../../types/messages.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import type { Usage } from '../../models/streaming.js'
import { BeforeNodeCallEvent } from '../events.js'
import { Status } from '../state.js'
import { Swarm } from '../swarm.js'

/**
 * Agent that hands off to `nextAgentId` via the structured-output tool, or
 * terminates when `nextAgentId` is undefined, reporting `usage` for its one call.
 */
function makeHandoffAgent(id: string, nextAgentId: string | undefined, usage: Usage): Agent {
  const handoff: { agentId?: string; message: string } = { message: `from ${id}` }
  if (nextAgentId !== undefined) handoff.agentId = nextAgentId

  const model = new MockMessageModel().addTurn(
    {
      type: 'toolUseBlock',
      name: 'strands_structured_output',
      toolUseId: `tool-${id}`,
      input: handoff as JSONValue,
    },
    { usage }
  )
  return new Agent({ model, printer: false, id, description: `Agent ${id}` })
}

describe('Swarm request-wide invocation context', () => {
  it('folds every node model usage into one shared request total', async () => {
    const agentA = makeHandoffAgent('a', 'b', { inputTokens: 10, outputTokens: 25, totalTokens: 35 })
    const agentB = makeHandoffAgent('b', undefined, { inputTokens: 20, outputTokens: 35, totalTokens: 55 })

    let shared: InvocationContextImpl | undefined
    agentB.addHook(AfterInvocationEvent, (event) => {
      shared = unwrapInvocationContext(event.invocationContext)
    })

    const swarm = new Swarm({ nodes: [agentA, agentB], start: 'a' })

    await swarm.invoke('hello')

    expect(shared?.usage).toEqual({ turnsTaken: 2, inputTokens: 30, outputTokens: 60, totalTokens: 90 })
  })

  it('fails the node that reaches the limits a root swarm starts its request with', async () => {
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    const swarm = new Swarm({
      nodes: [makeHandoffAgent('a', 'b', usage), makeHandoffAgent('b', undefined, usage)],
      start: 'a',
    })

    const result = await swarm.invoke('hello', { limits: { turns: 1 } })

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
      usage: { turnsTaken: 1, ...usage },
    })
  })

  it.each([
    { case: 'its own limits are stricter', requestLimits: { turns: 5 }, ownLimits: { turns: 1 } },
    { case: "the request's limits are stricter", requestLimits: { turns: 1 }, ownLimits: { turns: 5 } },
  ])('stops a nested swarm with its own limits when $case', async ({ requestLimits, ownLimits }) => {
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    const swarm = new Swarm({
      nodes: [makeHandoffAgent('a', 'b', usage), makeHandoffAgent('b', undefined, usage)],
      start: 'a',
    })
    const request = new InvocationContextImpl(requestLimits)

    const result = await swarm.invoke('hello', { invocationContext: request, limits: ownLimits })

    expect({
      failedNode: result.results.find((nodeResult) => nodeResult.status === Status.FAILED)?.error,
      ownUsage: result.invocationContext?.usage,
      requestUsage: request.usage,
    }).toEqual({
      failedNode: new Error(limitStopMessage('b', 'limitTurns')),
      ownUsage: { turnsTaken: 1, ...usage },
      requestUsage: { turnsTaken: 1, ...usage },
    })
    expect(result.invocationContext).not.toBe(request)
  })

  it.each([
    { case: 'a non-positive limit', limits: { turns: 0 }, message: 'limits.turns must be a positive finite number' },
    { case: 'an unrecognized key', limits: { turn: 3 } as InvokeLimits, message: 'are not recognized limits' },
  ])('rejects $case', async ({ limits, message }) => {
    const swarm = new Swarm({
      nodes: [makeHandoffAgent('a', undefined, { inputTokens: 1, outputTokens: 1, totalTokens: 2 })],
      start: 'a',
    })

    const invocation = swarm.invoke('hello', { limits })

    await expect(invocation).rejects.toThrow(TypeError)
    await expect(invocation).rejects.toThrow(message)
  })

  it("attaches the request's invocation context to every multi-agent event", async () => {
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    const swarm = new Swarm({
      nodes: [makeHandoffAgent('a', 'b', usage), makeHandoffAgent('b', undefined, usage)],
      start: 'a',
    })
    swarm.addHook(BeforeNodeCallEvent, (event) => {
      if (event.nodeId === 'b') event.cancel = true
    })

    const { items, result } = await collectGenerator(swarm.stream('hello', { limits: { turns: 5 } }))

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

  it('binds a resumed run to its own request', async () => {
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    const swarm = new Swarm({ nodes: [makeHandoffAgent('a', undefined, usage)], start: 'a' })
    swarm.addHook(BeforeNodeCallEvent, (event) => {
      event.interrupt({ name: 'approval', reason: 'approve?' })
    })
    const interrupted = await swarm.invoke('hello')
    const response = new InterruptResponseContent({ interruptId: interrupted.interrupts![0]!.id, response: 'yes' })

    const { items, result } = await collectGenerator(swarm.stream([response]))

    expect(result.invocationContext).not.toBe(interrupted.invocationContext)
    expect(items.filter((event) => event.invocationContext !== result.invocationContext)).toEqual([])
  })
})
