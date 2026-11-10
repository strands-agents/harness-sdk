import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../../../agent/agent.js'
import { HookRegistryImplementation } from '../../../hooks/registry.js'
import { AfterModelCallEvent, BeforeToolCallEvent } from '../../../hooks/events.js'
import { Interrupt, InterruptState } from '../../../interrupt.js'
import { confirm, guide, type Confirm, type Guide, type Proceed } from '../../../interventions/actions.js'
import { Message, TextBlock } from '../../../types/messages.js'
import type { ToolUse } from '../../../tools/types.js'
import type { LocalAgent } from '../../../types/agent.js'
import { SteeringHandler } from '../handlers/handler.js'
import type { SteeringContextData, SteeringContextProvider } from '../providers/context-provider.js'

function getHookRegistry(agent: Agent): HookRegistryImplementation {
  return (agent as unknown as { _hooksRegistry: HookRegistryImplementation })._hooksRegistry
}

describe('SteeringHandler', () => {
  const toolUse = { name: 'searchWeb', toolUseId: 'tu-1', input: { q: 'hi' } }

  function makeBeforeToolCallEvent(agent: LocalAgent): BeforeToolCallEvent {
    return new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} })
  }

  function makeAfterModelCallEvent(agent: LocalAgent): AfterModelCallEvent {
    return new AfterModelCallEvent({
      agent,
      model: {} as never,
      invocationState: {},
      attemptCount: 0,
      stopData: {
        message: new Message({ role: 'assistant', content: [new TextBlock('response')] }),
        stopReason: 'endTurn',
      },
    })
  }

  it('routes beforeToolCall to subclass override with the event', async () => {
    const seen: { agent?: LocalAgent; toolUse?: ToolUse } = {}

    class Spy extends SteeringHandler {
      override readonly name = 'spy'
      override async beforeToolCall(event: BeforeToolCallEvent): Promise<Guide> {
        seen.agent = event.agent
        seen.toolUse = event.toolUse
        return guide('try again')
      }
    }

    const agent = new Agent({ interventions: [new Spy()] })
    await agent.initialize()
    const event = makeBeforeToolCallEvent(agent)
    await getHookRegistry(agent).invokeCallbacks(event)

    expect(seen.agent).toBe(agent)
    expect(seen.toolUse).toEqual(toolUse)
    expect(event.cancel).toContain('GUIDANCE:')
    expect(event.cancel).toContain('try again')
  })

  it('routes afterModelCall to subclass override with the event', async () => {
    const seen: { message?: Message; stopReason?: string } = {}

    class Spy extends SteeringHandler {
      override readonly name = 'spy'
      override async afterModelCall(event: AfterModelCallEvent): Promise<Guide | Proceed> {
        if (!event.stopData) return { type: 'proceed' }
        seen.message = event.stopData.message
        seen.stopReason = event.stopData.stopReason
        return guide('be terser')
      }
    }

    const agent = new Agent({ interventions: [new Spy()] })
    await agent.initialize()
    const event = makeAfterModelCallEvent(agent)
    await getHookRegistry(agent).invokeCallbacks(event)

    expect(seen.message).toBeDefined()
    expect(seen.stopReason).toBe('endTurn')
    expect(event.retry).toBe(true)
  })

  it('exposes provider context to subclasses via getSteeringContext', async () => {
    const fakeProvider: SteeringContextProvider = {
      name: 'fake',
      observeAgent() {},
      get context(): SteeringContextData {
        return { type: 'fake', tokens: 42 }
      },
    }

    let observedContext: SteeringContextData[] | undefined

    class ContextReader extends SteeringHandler {
      override readonly name = 'context-reader'
      override async beforeToolCall(): Promise<Proceed> {
        observedContext = this.getSteeringContext()
        return { type: 'proceed' }
      }
    }

    const agent = new Agent({ interventions: [new ContextReader({ contextProviders: [fakeProvider] })] })
    await agent.initialize()
    await getHookRegistry(agent).invokeCallbacks(makeBeforeToolCallEvent(agent))

    expect(observedContext).toEqual([{ type: 'fake', tokens: 42 }])
  })

  it('siblings with distinct names can coexist on one agent', () => {
    class A extends SteeringHandler {
      override readonly name = 'steer:tool'
    }
    class B extends SteeringHandler {
      override readonly name = 'steer:model'
    }

    expect(() => new Agent({ interventions: [new A(), new B()] })).not.toThrow()
  })

  it('does not invoke afterModelCall body when stopData is missing', async () => {
    const called = vi.fn()

    class Spy extends SteeringHandler {
      override readonly name = 'spy'
      override async afterModelCall(event: AfterModelCallEvent): Promise<Proceed> {
        if (event.stopData) called()
        return { type: 'proceed' }
      }
    }

    const agent = new Agent({ interventions: [new Spy()] })
    await agent.initialize()
    const event = new AfterModelCallEvent({
      agent,
      model: {} as never,
      invocationState: {},
      attemptCount: 0,
    })
    await getHookRegistry(agent).invokeCallbacks(event)

    expect(called).not.toHaveBeenCalled()
  })

  it('confirm decision flows through the interrupt system on resume (approved)', async () => {
    class Approver extends SteeringHandler {
      override readonly name = 'approver'
      override async beforeToolCall(): Promise<Confirm> {
        return confirm('approve searchWeb?')
      }
    }

    const agent = new Agent({ interventions: [new Approver()] })
    await agent.initialize()

    // Preload an approval response so event.interrupt() returns it instead of pausing
    const interruptId = `hook:beforeToolCall:${toolUse.toolUseId}:approver`
    const interruptState = (agent as unknown as { _interruptState: InterruptState })._interruptState
    interruptState.interrupts[interruptId] = new Interrupt({
      id: interruptId,
      name: 'approver',
      response: 'yes' as never,
      source: 'hook',
    })

    const event = makeBeforeToolCallEvent(agent)
    await getHookRegistry(agent).invokeCallbacks(event)

    expect(event.cancel).toBe(false)
  })

  it('confirm decision sets cancel when human denies', async () => {
    class Approver extends SteeringHandler {
      override readonly name = 'approver'
      override async beforeToolCall(): Promise<Confirm> {
        return confirm('approve searchWeb?')
      }
    }

    const agent = new Agent({ interventions: [new Approver()] })
    await agent.initialize()

    const interruptId = `hook:beforeToolCall:${toolUse.toolUseId}:approver`
    const interruptState = (agent as unknown as { _interruptState: InterruptState })._interruptState
    interruptState.interrupts[interruptId] = new Interrupt({
      id: interruptId,
      name: 'approver',
      response: 'no' as never,
      source: 'hook',
    })

    const event = makeBeforeToolCallEvent(agent)
    await getHookRegistry(agent).invokeCallbacks(event)

    expect(event.cancel).toBe('CONFIRMATION_FAILED: approve searchWeb?')
  })
})
