import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { type InvocationContextImpl, unwrapInvocationContext } from '../../agent/invocation-context.js'
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
})
