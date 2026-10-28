import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import { unwrapInvocationContext, type InvocationContextImpl } from '../invocation-context.js'
import { BeforeInvocationEvent } from '../../hooks/events.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import type { AgentResult } from '../../types/agent.js'

function confirmTool() {
  return createMockTool(
    'confirm',
    (context) => `confirmed: ${context.interrupt<string>({ name: 'confirm', reason: 'ok?' })}`
  )
}

/** An agent whose first turn interrupts; `invocations` records the invocation of every invoke. */
function interruptingAgent(extraTurns: string[] = []) {
  const model = new MockMessageModel()
    .addTurn({ type: 'toolUseBlock', name: 'confirm', toolUseId: 't1', input: {} })
    .addTurn({ type: 'textBlock', text: 'done' })
  for (const text of extraTurns) model.addTurn({ type: 'textBlock', text })
  const agent = new Agent({ model, tools: [confirmTool()], printer: false })
  const invocations: InvocationContextImpl[] = []
  agent.addHook(BeforeInvocationEvent, (event) => {
    invocations.push(unwrapInvocationContext(event.invocationContext)!)
  })
  return { agent, invocations }
}

function responseFor(interrupted: AgentResult): InterruptResponseContent {
  return new InterruptResponseContent({ interruptId: interrupted.interrupts![0]!.id, response: 'yes' })
}

describe('interrupt resume and the request invocation', () => {
  it('resumes under the invocation that raised the interrupt, continuing its turn count', async () => {
    const { agent, invocations } = interruptingAgent()

    const interrupted = await agent.invoke('go')
    expect(interrupted.stopReason).toBe('interrupt')
    const resumed = await agent.invoke([responseFor(interrupted)])

    expect(resumed.stopReason).toBe('endTurn')
    expect(invocations).toHaveLength(2)
    expect(invocations[1]).toBe(invocations[0])
    // One turn before the interrupt, then the resume's pending-tool cycle and its model call.
    expect(invocations[0]!.usage.turnsTaken).toBe(3)
  })

  it('a rejected call while interrupted fires no invocation hooks and does not change which invocation the resume joins', async () => {
    const { agent, invocations } = interruptingAgent()
    const interrupted = await agent.invoke('go')
    const hooksBefore = invocations.length

    await expect(agent.invoke('not a resume', { limits: { turns: 5 } })).rejects.toThrow(/interrupted state/)
    expect(invocations).toHaveLength(hooksBefore)
    await agent.invoke([responseFor(interrupted)])

    expect(invocations.at(-1)).toBe(invocations[0])
  })

  it('a resume with limits tightens the interrupted request instead of starting a new one', async () => {
    const { agent, invocations } = interruptingAgent()
    const interrupted = await agent.invoke('go')

    await agent.invoke([responseFor(interrupted)], { limits: { turns: 5 } })

    expect(invocations).toHaveLength(2)
    expect(invocations[1]).not.toBe(invocations[0])
    expect(invocations[1]!.limitingParent).toBe(invocations[0])
  })

  it('starts the interrupted invocation afresh after the next root invoke', async () => {
    const { agent, invocations } = interruptingAgent(['again'])
    const interrupted = await agent.invoke('go')
    await agent.invoke([responseFor(interrupted)])

    await agent.invoke('again')

    expect(invocations).toHaveLength(3)
    expect(invocations[2]).not.toBe(invocations[0])
    expect(invocations[2]!.usage.turnsTaken).toBe(1)
  })

  it('a restored interrupt belongs to no prior invocation of the restoring agent', async () => {
    const { agent: source } = interruptingAgent()
    const interrupted = await source.invoke('go')
    const snapshot = source.takeSnapshot({ preset: 'session' })

    const target = new Agent({
      model: new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'warm-up' })
        .addTurn({ type: 'textBlock', text: 'done' }),
      tools: [confirmTool()],
      printer: false,
    })
    const targetInvocations: InvocationContextImpl[] = []
    target.addHook(BeforeInvocationEvent, (event) => {
      targetInvocations.push(unwrapInvocationContext(event.invocationContext)!)
    })
    await target.invoke('warm up')
    target.loadSnapshot(snapshot)

    const resumed = await target.invoke([responseFor(interrupted)])

    expect(resumed.stopReason).toBe('endTurn')
    expect(targetInvocations).toHaveLength(2)
    expect(targetInvocations[1]).not.toBe(targetInvocations[0])
    // The resume's own two cycles only; the warm-up turn is not carried over.
    expect(targetInvocations[1]!.usage.turnsTaken).toBe(2)
  })
})
