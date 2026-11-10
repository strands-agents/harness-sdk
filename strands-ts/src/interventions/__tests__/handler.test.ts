import { describe, expect, it } from 'vitest'
import { InterventionHandler } from '../handler.js'
import { Agent } from '../../agent/agent.js'
import { BeforeToolCallEvent, AfterModelCallEvent } from '../../hooks/events.js'
import type { InterventionAction } from '../actions.js'

class NoOpHandler extends InterventionHandler {
  readonly name = 'no-op'
}

class ToolOnlyHandler extends InterventionHandler {
  readonly name = 'tool-only'

  override beforeToolCall(): InterventionAction {
    return { type: 'deny', reason: 'blocked' }
  }
}

describe('InterventionHandler', () => {
  const agent = new Agent()
  const toolUse = { name: 'test', toolUseId: 'id', input: {} }

  it('default methods return proceed', () => {
    const handler = new NoOpHandler()

    expect(
      handler.beforeToolCall(new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} }))
    ).toEqual({
      type: 'proceed',
    })
    expect(
      handler.afterModelCall(
        new AfterModelCallEvent({ agent, model: {} as never, invocationState: {}, attemptCount: 0 })
      )
    ).toEqual({
      type: 'proceed',
    })
  })

  it('override detection works via prototype comparison', () => {
    const noOp = new NoOpHandler()
    const toolOnly = new ToolOnlyHandler()

    expect(noOp.beforeToolCall).toBe(InterventionHandler.prototype.beforeToolCall)
    expect(noOp.afterModelCall).toBe(InterventionHandler.prototype.afterModelCall)

    expect(toolOnly.beforeToolCall).not.toBe(InterventionHandler.prototype.beforeToolCall)
    expect(toolOnly.afterModelCall).toBe(InterventionHandler.prototype.afterModelCall)
  })
})
