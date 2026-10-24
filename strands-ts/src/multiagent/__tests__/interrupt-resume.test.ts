import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { BeforeInvocationEvent, BeforeModelCallEvent } from '../../hooks/events.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import { TextBlock } from '../../types/messages.js'
import { BeforeNodeCallEvent } from '../events.js'
import { Graph } from '../graph.js'
import { Status } from '../state.js'
import { Swarm } from '../swarm.js'
import type { MultiAgentInput } from '../multiagent.js'
import type { MultiAgentResult } from '../state.js'

type OrchestratorKind = 'Graph' | 'Swarm'

interface Fixture {
  orchestrator: Graph | Swarm
  model: MockMessageModel
  observations: { agentInvocations: number; modelInputs: string[][] }
}

// Rejected input preserves the paused run: https://github.com/strands-agents/harness-sdk/issues/5459
describe.each(['Graph', 'Swarm'] as const)('%s', (kind) => {
  describe('same-instance interrupt resume', () => {
    it.each(['unknown ID', 'valid then unknown ID', 'mixed content'] as const)(
      'preserves the paused run after rejecting %s',
      async (invalid) => {
        const fixture = createFixture(kind)
        const response = await pause(fixture.orchestrator)
        const unknown = new InterruptResponseContent({ interruptId: 'unknown-id', response: 'approved' })
        // JavaScript callers can supply mixed arrays even though the TypeScript union excludes them.
        const mixed = [response, new TextBlock('stray content')] as unknown as MultiAgentInput
        const input =
          invalid === 'unknown ID' ? [unknown] : invalid === 'valid then unknown ID' ? [response, unknown] : mixed
        const error =
          invalid === 'mixed content'
            ? 'Must resume from interrupt with a list of interruptResponse content blocks only'
            : 'interrupt_id=<unknown-id> | no node found with matching interrupt'

        await expect(fixture.orchestrator.invoke(input)).rejects.toThrow(error)
        expect({
          agentInvocations: fixture.observations.agentInvocations,
          modelCalls: fixture.model.callCount,
        }).toEqual({
          agentInvocations: 0,
          modelCalls: 0,
        })
        expectCompleted(fixture, await fixture.orchestrator.invoke([response]))
      }
    )

    it.each(['class instance', 'JSON'] as const)('resumes from a %s and clears the completed pause', async (format) => {
      const fixture = createFixture(kind)
      const response = await pause(fixture.orchestrator)

      const result = await fixture.orchestrator.invoke([format === 'JSON' ? response.toJSON() : response])
      expectCompleted(fixture, result)
      await expectCleared(fixture, response)
    })

    it('keeps the pause when the routed target is missing', async () => {
      const fixture = createFixture(kind)
      const response = await pause(fixture.orchestrator)
      const lookup = vi.spyOn(fixture.orchestrator.nodes, 'get').mockReturnValueOnce(undefined)

      try {
        await expect(fixture.orchestrator.invoke([response])).rejects.toThrow(/resume response targets a node missing/)
      } finally {
        lookup.mockRestore()
      }

      expectCompleted(fixture, await fixture.orchestrator.invoke([response]))
    })

    it.each([Status.FAILED, Status.CANCELLED])('clears the pause after a %s result', async (terminalStatus) => {
      const fixture = createFixture(kind, terminalStatus === Status.FAILED)
      if (terminalStatus === Status.CANCELLED) {
        fixture.orchestrator.addHook(BeforeNodeCallEvent, (event) => {
          event.cancel = true
        })
      }
      const response = await pause(fixture.orchestrator)

      const result = await fixture.orchestrator.invoke([response])
      expect({ status: result.status, nodes: result.results.map(({ status }) => status) }).toEqual({
        status: terminalStatus,
        nodes: [terminalStatus],
      })
      await expectCleared(fixture, response)
    })

    it('consumes an accepted resume before a later node hook throws', async () => {
      const fixture = createFixture(kind)
      const response = await pause(fixture.orchestrator)
      const removeHook = fixture.orchestrator.addHook(BeforeNodeCallEvent, () => {
        throw new Error('later hook failure')
      })

      await expect(fixture.orchestrator.invoke([response])).rejects.toThrow('later hook failure')
      removeHook()
      await expectCleared(fixture, response)
    })
  })
})

function createFixture(kind: OrchestratorKind, failModel = false): Fixture {
  const model = new MockMessageModel()
  if (failModel) {
    model.addTurn(new Error('model failure'))
  } else if (kind === 'Graph') {
    model.addTurn({ type: 'textBlock', text: 'completed' })
  } else {
    model.addTurn({
      type: 'toolUseBlock',
      name: 'strands_structured_output',
      toolUseId: 'final-result',
      input: { message: 'completed' },
    })
  }
  // Multiple turns make the existing mock count calls instead of repeating its only turn.
  model.addTurn(new Error('unexpected second model call'))
  const agent = new Agent({ id: 'worker', model, printer: false })
  const observations: Fixture['observations'] = { agentInvocations: 0, modelInputs: [] }
  agent.addHook(BeforeInvocationEvent, () => {
    observations.agentInvocations++
  })
  agent.addHook(BeforeModelCallEvent, (event) => {
    observations.modelInputs.push(
      (event.agent.messages.find((message) => message.role === 'user')?.content ?? [])
        .filter((block): block is TextBlock => block instanceof TextBlock)
        .map((block) => block.text)
    )
  })
  const orchestrator =
    kind === 'Graph' ? new Graph({ nodes: [agent], edges: [] }) : new Swarm({ nodes: [agent], start: 'worker' })
  orchestrator.addHook(BeforeNodeCallEvent, (event) => {
    event.interrupt({ name: 'approval' })
  })
  return { orchestrator, model, observations }
}

async function pause(orchestrator: Graph | Swarm): Promise<InterruptResponseContent> {
  const result = await orchestrator.invoke('original task')
  expect(result).toEqual(
    expect.objectContaining({
      status: Status.INTERRUPTED,
      results: [expect.objectContaining({ nodeId: 'worker', status: Status.INTERRUPTED })],
      interrupts: [expect.objectContaining({ id: expect.any(String), source: 'multiagent-hook' })],
    })
  )
  return new InterruptResponseContent({ interruptId: result.interrupts![0]!.id, response: 'approved' })
}

function expectCompleted(fixture: Fixture, result: MultiAgentResult): void {
  expect({
    status: result.status,
    nodes: result.results.map(({ nodeId, status }) => ({ nodeId, status })),
    interrupts: result.interrupts,
    modelCalls: fixture.model.callCount,
    ...fixture.observations,
  }).toEqual({
    status: Status.COMPLETED,
    nodes: [{ nodeId: 'worker', status: Status.COMPLETED }],
    interrupts: undefined,
    modelCalls: 1,
    agentInvocations: 1,
    modelInputs: [['original task']],
  })
}

async function expectCleared(fixture: Fixture, response: InterruptResponseContent): Promise<void> {
  const priorCalls = fixture.model.callCount
  await expect(fixture.orchestrator.invoke([response])).rejects.toThrow(/no node found with matching interrupt/)
  const freshResult = await fixture.orchestrator.invoke('new task')
  expect({ status: freshResult.status, modelCalls: fixture.model.callCount }).toEqual({
    status: Status.INTERRUPTED,
    modelCalls: priorCalls,
  })
}
