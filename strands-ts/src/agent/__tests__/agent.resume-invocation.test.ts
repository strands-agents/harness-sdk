import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import { unwrapInvocationContext, type InvocationContextImpl } from '../invocation-context.js'
import { AfterInvocationEvent, BeforeInvocationEvent } from '../../hooks/events.js'
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
    .addTurn(
      { type: 'toolUseBlock', name: 'confirm', toolUseId: 't1', input: {} },
      { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
    )
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
    // The interrupted turn, which the resume finishes, then the model call after it.
    expect(invocations[0]!.usage.turnsTaken).toBe(2)
  })

  it.each([
    { limits: { turns: 1 }, stopReason: 'limitTurns' },
    { limits: { totalTokens: 10 }, stopReason: 'limitTotalTokens' },
  ])('a resume finishes the interrupted turn when $stopReason is already reached', async ({ limits, stopReason }) => {
    const { agent, invocations } = interruptingAgent(['next'])
    const interrupted = await agent.invoke('go', { limits })
    expect(interrupted.stopReason).toBe('interrupt')

    const resumed = await agent.invoke([responseFor(interrupted)])

    expect(resumed.stopReason).toBe(stopReason)
    expect(invocations[0]!.usage.turnsTaken).toBe(1)
    expect(agent.messages.map((message) => message.content[0]!.type)).toEqual([
      'textBlock',
      'toolUseBlock',
      'toolResultBlock',
    ])
    // The interrupt is resolved, so the agent takes new input again.
    expect((await agent.invoke('next')).stopReason).toBe('endTurn')
  })

  it('a resume through another nested call of the same request finishes the interrupted turn', async () => {
    const model = new MockMessageModel()
      .addTurn({ type: 'textBlock', text: 'warm' })
      .addTurn({ type: 'toolUseBlock', name: 'confirm', toolUseId: 't1', input: {} })
    const agent = new Agent({ model, tools: [confirmTool()], printer: false })
    const request = (await agent.invoke('warm up', { limits: { turns: 2 } })).invocationContext!
    const nested = { invocationContext: request, limits: { turns: 5 } }
    const interrupted = await agent.invoke('go', nested)
    expect(interrupted.stopReason).toBe('interrupt')

    const resumed = await agent.invoke([responseFor(interrupted)], nested)

    expect(resumed.stopReason).toBe('limitTurns')
    expect(request.usage.turnsTaken).toBe(2)
    expect(agent.messages.at(-1)!.content[0]!.type).toBe('toolResultBlock')
  })

  it("a hook's resume finishes the interrupted turn when the turn limit is already reached", async () => {
    const { agent } = interruptingAgent()
    agent.addHook(AfterInvocationEvent, (event) => {
      if (event.result?.stopReason === 'interrupt') event.resume = [responseFor(event.result)]
    })

    const result = await agent.invoke('go', { limits: { turns: 1 } })

    expect(result.stopReason).toBe('limitTurns')
    expect(agent.messages.at(-1)!.content[0]!.type).toBe('toolResultBlock')
  })

  it.each([
    { mode: 'queue', stopReason: 'limitTurns' },
    { mode: 'stopPrevious', stopReason: 'cancelled' },
    { mode: 'cancelPrevious', stopReason: 'cancelled' },
  ] as const)(
    'a $mode caller parked behind the interrupt runs after a resume at the turn limit',
    async ({ mode, stopReason }) => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'confirm', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({ model, tools: [confirmTool()], printer: false, concurrentInvocationMode: mode })
      const interrupted = await agent.invoke('a', { limits: { turns: 1 } })
      const parked = agent.invoke('b')

      const resumed = await agent.invoke([responseFor(interrupted)])

      expect(resumed.stopReason).toBe(stopReason)
      expect((await parked).stopReason).toBe('endTurn')
      expect(agent.pendingInvocations).toHaveLength(0)
      expect(agent.messages.map((message) => message.content[0]!.type).slice(0, 3)).toEqual([
        'textBlock',
        'toolUseBlock',
        'toolResultBlock',
      ])
    }
  )

  it.each(['an aborted cancelSignal', 'a BeforeInvocationEvent hook'])(
    'a resume cancelled by %s before its pending tools leaves the turn for the next resume',
    async (route) => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'confirm', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({ model, tools: [confirmTool()], printer: false, concurrentInvocationMode: 'queue' })
      const interrupted = await agent.invoke('a', { limits: { turns: 1 } })

      const byHook = route === 'a BeforeInvocationEvent hook'
      const removeHook = byHook ? agent.addHook(BeforeInvocationEvent, () => agent.cancel()) : undefined
      const cancelled = await agent.invoke(
        [responseFor(interrupted)],
        byHook ? {} : { cancelSignal: AbortSignal.abort() }
      )
      removeHook?.()
      expect(cancelled.stopReason).toBe('cancelled')
      const parked = agent.invoke('b')

      const resumed = await agent.invoke([responseFor(interrupted)])

      expect(resumed.stopReason).toBe('limitTurns')
      expect(agent.messages.map((message) => message.content[0]!.type)).toContain('toolResultBlock')
      expect((await parked).stopReason).toBe('endTurn')
    }
  )

  it('a turn interrupted more than once is still counted once', async () => {
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'confirm', toolUseId: 't1', input: {} })
      .addTurn({ type: 'textBlock', text: 'done' })
    const twice = createMockTool('confirm', (context) => {
      const first = context.interrupt<string>({ name: 'first', reason: 'ok?' })
      return `${first} ${context.interrupt<string>({ name: 'second', reason: 'sure?' })}`
    })
    const agent = new Agent({ model, tools: [twice], printer: false })

    const first = await agent.invoke('go', { limits: { turns: 2 } })
    const second = await agent.invoke([responseFor(first)])
    expect(second.stopReason).toBe('interrupt')
    const resumed = await agent.invoke([responseFor(second)])

    expect(resumed.stopReason).toBe('endTurn')
    expect(unwrapInvocationContext(resumed.invocationContext)!.usage.turnsTaken).toBe(2)
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
    // A new request: its pending-tool cycle and its model call. The warm-up turn is not carried over.
    expect(targetInvocations[1]!.usage.turnsTaken).toBe(2)
  })
})
