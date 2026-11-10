import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { BeforeModelCallEvent } from '../../hooks/events.js'
import type { JSONValue } from '../../types/json.js'
import { Swarm } from '../swarm.js'
import type { InvocationState } from '../../types/agent.js'

/**
 * Agent that hands off to `nextAgentId` via the structured-output tool, or
 * terminates when `nextAgentId` is undefined.
 */
function makeHandoffAgent(id: string, nextAgentId: string | undefined, message: string): Agent {
  const handoff: { agentId?: string; message: string } = { message }
  if (nextAgentId !== undefined) handoff.agentId = nextAgentId

  const model = new MockMessageModel().addTurn({
    type: 'toolUseBlock',
    name: 'strands_structured_output',
    toolUseId: `tool-${id}`,
    input: handoff as JSONValue,
  })
  return new Agent({ model, printer: false, id, description: `Agent ${id}` })
}

describe('Swarm invocationState forwarding', () => {
  it('forwards invocationState to every node and mutations from one node are visible to the next', async () => {
    const nodeAObserved: InvocationState[] = []
    const nodeBObserved: InvocationState[] = []

    const agentA = makeHandoffAgent('a', 'b', 'to b')
    agentA.addHook(BeforeModelCallEvent, (event) => {
      nodeAObserved.push(event.invocationState)
      event.invocationState.touchedByA = true
    })

    const agentB = makeHandoffAgent('b', undefined, 'done')
    agentB.addHook(BeforeModelCallEvent, (event) => {
      nodeBObserved.push(event.invocationState)
    })

    const swarm = new Swarm({ nodes: [agentA, agentB], start: 'a' })

    const state: InvocationState = { requestId: 'r-1' }
    await swarm.invoke('hello', { invocationState: state })

    // Both nodes observe the same object reference.
    expect(nodeAObserved[0]).toBe(state)
    expect(nodeBObserved[0]).toBe(state)

    // Node B sees node A's mutation.
    expect(nodeBObserved[0]?.touchedByA).toBe(true)
    expect(state.touchedByA).toBe(true)
  })

  it('defaults invocationState to {} when none is passed', async () => {
    let observed: InvocationState | undefined

    const agentA = makeHandoffAgent('a', undefined, 'done')
    agentA.addHook(BeforeModelCallEvent, (event) => {
      observed = event.invocationState
    })

    const swarm = new Swarm({ nodes: [agentA], start: 'a' })

    await swarm.invoke('hello')

    expect(observed).toEqual({})
  })
})
