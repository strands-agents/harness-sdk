import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import { BeforeModelCallEvent } from '../../hooks/events.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import type { InvocationState } from '../../types/agent.js'

describe('AgentAsTool invocationState forwarding', () => {
  it('forwards outer invocationState into the wrapped agent and reflects inner mutations on outer result', async () => {
    const innerModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'inner-done' })
    const inner = new Agent({ model: innerModel, name: 'inner', description: 'inner agent' })

    let innerSawState: InvocationState | undefined
    inner.addHook(BeforeModelCallEvent, (event) => {
      innerSawState = event.invocationState
      event.invocationState.innerTouched = true
    })

    const outerModel = new MockMessageModel()
      .addTurn([{ type: 'toolUseBlock', name: 'inner', toolUseId: 'tu-1', input: { input: 'hi' } }])
      .addTurn({ type: 'textBlock', text: 'outer-done' })
    const outer = new Agent({ model: outerModel, tools: [inner.asTool()] })

    const result = await outer.invoke('run inner', { invocationState: { userId: 'u-1' } })

    expect(innerSawState).toEqual({ userId: 'u-1', innerTouched: true })
    expect(result.invocationState).toEqual({ userId: 'u-1', innerTouched: true })
  })
})
