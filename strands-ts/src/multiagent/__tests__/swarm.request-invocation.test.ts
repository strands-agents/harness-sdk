import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { toInternal, type InternalInvocation } from '../../agent/invocation.js'
import { AfterInvocationEvent } from '../../hooks/events.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import type { JSONValue } from '../../types/json.js'
import type { Usage } from '../../models/streaming.js'
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

describe('Swarm request-wide invocation', () => {
  it('folds every node model usage into one shared request total', async () => {
    const agentA = makeHandoffAgent('a', 'b', { inputTokens: 10, outputTokens: 25, totalTokens: 35 })
    const agentB = makeHandoffAgent('b', undefined, { inputTokens: 20, outputTokens: 35, totalTokens: 55 })

    // Capture the shared Invocation from the terminal node's after-invocation
    // hook, where it is attached to the event.
    let shared: InternalInvocation | undefined
    agentB.addHook(AfterInvocationEvent, (event) => {
      shared = toInternal(event.invocation)
    })

    const swarm = new Swarm({ nodes: [agentA, agentB], start: 'a' })

    await swarm.invoke('hello')

    // Node A hands off to node B; both accumulate into the single shared
    // Invocation, so the total is the exact sum across the handoff.
    expect(shared?.usage).toEqual({ inputTokens: 30, outputTokens: 60, totalTokens: 90 })
  })
})
