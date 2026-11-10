import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HookRegistryImplementation } from '../registry.js'
import { AfterInvocationEvent, BeforeInvocationEvent, BeforeToolCallEvent } from '../events.js'
import { Agent } from '../../agent/agent.js'
import { InterruptError, InterruptState } from '../../interrupt.js'

describe('HookRegistryImplementation', () => {
  let registry: HookRegistryImplementation
  let mockAgent: Agent

  const getInterruptState = (agent: Agent): InterruptState =>
    (agent as unknown as { _interruptState: InterruptState })._interruptState

  beforeEach(() => {
    registry = new HookRegistryImplementation()
    mockAgent = new Agent()
  })

  describe('addCallback', () => {
    it('registers callback for event type', async () => {
      const callback = vi.fn()
      registry.addCallback(BeforeInvocationEvent, callback)

      await registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(callback).toHaveBeenCalledOnce()
    })

    it('registers multiple callbacks for same event type', async () => {
      const callback1 = vi.fn()
      const callback2 = vi.fn()

      registry.addCallback(BeforeInvocationEvent, callback1)
      registry.addCallback(BeforeInvocationEvent, callback2)

      await registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(callback1).toHaveBeenCalledOnce()
      expect(callback2).toHaveBeenCalledOnce()
    })

    it('registers callbacks for different event types separately', async () => {
      const beforeCallback = vi.fn()
      const afterCallback = vi.fn()

      registry.addCallback(BeforeInvocationEvent, beforeCallback)
      registry.addCallback(AfterInvocationEvent, afterCallback)

      await registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(beforeCallback).toHaveBeenCalledOnce()
      expect(afterCallback).not.toHaveBeenCalled()

      await registry.invokeCallbacks(new AfterInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(afterCallback).toHaveBeenCalledOnce()
    })
  })

  describe('invokeCallbacks', () => {
    it('calls registered callbacks in order', async () => {
      const callOrder: number[] = []
      const callback1 = vi.fn(() => {
        callOrder.push(1)
      })
      const callback2 = vi.fn(() => {
        callOrder.push(2)
      })

      registry.addCallback(BeforeInvocationEvent, callback1)
      registry.addCallback(BeforeInvocationEvent, callback2)

      await registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(callOrder).toEqual([1, 2])
    })

    it('reverses callback order for After events', async () => {
      const callOrder: number[] = []
      const callback1 = vi.fn(() => {
        callOrder.push(1)
      })
      const callback2 = vi.fn(() => {
        callOrder.push(2)
      })

      registry.addCallback(AfterInvocationEvent, callback1)
      registry.addCallback(AfterInvocationEvent, callback2)

      await registry.invokeCallbacks(new AfterInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(callOrder).toEqual([2, 1])
    })

    it('awaits async callbacks', async () => {
      let completed = false
      const callback = vi.fn(async (): Promise<void> => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 10))
        completed = true
      })

      registry.addCallback(BeforeInvocationEvent, callback)

      await registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(completed).toBe(true)
    })

    it('propagates callback errors', async () => {
      const callback = vi.fn(() => {
        throw new Error('Hook failed')
      })

      registry.addCallback(BeforeInvocationEvent, callback)

      await expect(
        registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))
      ).rejects.toThrow('Hook failed')
    })

    it('stops execution on first non-interrupt error', async () => {
      const callback1 = vi.fn(() => {
        throw new Error('First callback failed')
      })
      const callback2 = vi.fn()

      registry.addCallback(BeforeInvocationEvent, callback1)
      registry.addCallback(BeforeInvocationEvent, callback2)

      await expect(
        registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))
      ).rejects.toThrow('First callback failed')

      expect(callback2).not.toHaveBeenCalled()
    })

    it('handles mixed sync and async callbacks', async () => {
      const callOrder: string[] = []
      const syncCallback = vi.fn(() => {
        callOrder.push('sync')
      })
      const asyncCallback = vi.fn(async (): Promise<void> => {
        await new Promise((resolve) => globalThis.globalThis.setTimeout(resolve, 10))
        callOrder.push('async')
      })

      registry.addCallback(BeforeInvocationEvent, syncCallback)
      registry.addCallback(BeforeInvocationEvent, asyncCallback)

      await registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(callOrder).toEqual(['sync', 'async'])
    })

    it('returns the event after invocation', async () => {
      const event = new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} })
      const result = await registry.invokeCallbacks(event)
      expect(result).toBe(event)
    })
  })

  describe('ordering', () => {
    it('lower order runs first', async () => {
      const callOrder: number[] = []
      registry.addCallback(BeforeInvocationEvent, () => {
        callOrder.push(0)
      })
      registry.addCallback(
        BeforeInvocationEvent,
        () => {
          callOrder.push(100)
        },
        { order: 100 }
      )
      registry.addCallback(
        BeforeInvocationEvent,
        () => {
          callOrder.push(-100)
        },
        { order: -100 }
      )

      await registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(callOrder).toEqual([-100, 0, 100])
    })

    it('same order preserves registration order', async () => {
      const callOrder: string[] = []
      registry.addCallback(
        BeforeInvocationEvent,
        () => {
          callOrder.push('first')
        },
        { order: 10 }
      )
      registry.addCallback(
        BeforeInvocationEvent,
        () => {
          callOrder.push('second')
        },
        { order: 10 }
      )
      registry.addCallback(
        BeforeInvocationEvent,
        () => {
          callOrder.push('third')
        },
        { order: 10 }
      )

      await registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(callOrder).toEqual(['first', 'second', 'third'])
    })

    it('negative order runs before default', async () => {
      const callOrder: string[] = []
      registry.addCallback(BeforeInvocationEvent, () => {
        callOrder.push('default')
      })
      registry.addCallback(
        BeforeInvocationEvent,
        () => {
          callOrder.push('early')
        },
        { order: -100 }
      )

      await registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(callOrder).toEqual(['early', 'default'])
    })

    it('After events: lower order still runs first across groups', async () => {
      const callOrder: string[] = []
      registry.addCallback(
        AfterInvocationEvent,
        () => {
          callOrder.push('early')
        },
        { order: -100 }
      )
      registry.addCallback(
        AfterInvocationEvent,
        () => {
          callOrder.push('late')
        },
        { order: 100 }
      )

      await registry.invokeCallbacks(new AfterInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(callOrder).toEqual(['early', 'late'])
    })
  })

  describe('addCallback cleanup function', () => {
    it('returns cleanup function that removes the callback', async () => {
      const callback = vi.fn()

      const cleanup = registry.addCallback(BeforeInvocationEvent, callback)
      cleanup()

      await registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(callback).not.toHaveBeenCalled()
    })

    it('cleanup function is idempotent', async () => {
      const callback = vi.fn()

      const cleanup = registry.addCallback(BeforeInvocationEvent, callback)
      cleanup()
      cleanup()
      cleanup()

      await registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(callback).not.toHaveBeenCalled()
    })

    it('cleanup function does not affect other callbacks', async () => {
      const callback1 = vi.fn()
      const callback2 = vi.fn()

      const cleanup1 = registry.addCallback(BeforeInvocationEvent, callback1)
      registry.addCallback(BeforeInvocationEvent, callback2)
      cleanup1()

      await registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(callback1).not.toHaveBeenCalled()
      expect(callback2).toHaveBeenCalledOnce()
    })

    it('allows callback to be re-registered after cleanup', async () => {
      const callback = vi.fn()

      const cleanup = registry.addCallback(BeforeInvocationEvent, callback)
      cleanup()

      registry.addCallback(BeforeInvocationEvent, callback)
      await registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(callback).toHaveBeenCalledTimes(1)
    })

    it('cleanup from one registration does not affect independent registration of same function', async () => {
      const callback1 = vi.fn()
      const callback2 = vi.fn()

      registry.addCallback(BeforeInvocationEvent, callback1)
      const cleanup2 = registry.addCallback(BeforeInvocationEvent, callback2)
      cleanup2()

      await registry.invokeCallbacks(new BeforeInvocationEvent({ agent: mockAgent, invocationState: {} }))

      expect(callback1).toHaveBeenCalledOnce()
      expect(callback2).not.toHaveBeenCalled()
    })
  })

  describe('InterruptError collection', () => {
    const createEvent = () =>
      new BeforeToolCallEvent({
        agent: mockAgent,
        toolUse: { name: 'test', toolUseId: 'tool-1', input: {} },
        tool: undefined,
        invocationState: {},
      })

    it('collects InterruptErrors from multiple callbacks and invokes all of them', async () => {
      const event = createEvent()

      const callback1 = vi.fn(() => {
        event.interrupt({ name: 'interrupt_a', reason: 'Reason A' })
      })
      const callback2 = vi.fn(() => {
        event.interrupt({ name: 'interrupt_b', reason: 'Reason B' })
      })

      registry.addCallback(BeforeToolCallEvent, callback1)
      registry.addCallback(BeforeToolCallEvent, callback2)

      await expect(registry.invokeCallbacks(event)).rejects.toThrow(InterruptError)

      expect(callback1).toHaveBeenCalledOnce()
      expect(callback2).toHaveBeenCalledOnce()

      const state = getInterruptState(mockAgent)
      expect(Object.keys(state.interrupts).length).toBe(2)
      expect(
        state
          .getInterruptsList()
          .map((i) => i.name)
          .sort()
      ).toEqual(['interrupt_a', 'interrupt_b'])
    })

    it('throws InterruptError with all collected interrupts after all callbacks run', async () => {
      const event = createEvent()

      registry.addCallback(BeforeToolCallEvent, () => {
        event.interrupt({ name: 'first', reason: 'First' })
      })
      registry.addCallback(BeforeToolCallEvent, () => {
        event.interrupt({ name: 'second', reason: 'Second' })
      })

      try {
        await registry.invokeCallbacks(event)
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(InterruptError)
        const ie = error as InterruptError
        expect(ie.interrupts).toHaveLength(2)
        expect(ie.interrupts.map((i) => i.name)).toEqual(['first', 'second'])
        expect(ie.message).toBe('2 interrupts raised: first, second')
      }
    })

    it('stops on non-interrupt error even when interrupts were collected', async () => {
      const event = createEvent()
      const callback3 = vi.fn()

      registry.addCallback(BeforeToolCallEvent, () => {
        event.interrupt({ name: 'interrupt_a', reason: 'Reason A' })
      })
      registry.addCallback(BeforeToolCallEvent, () => {
        throw new Error('Non-interrupt failure')
      })
      registry.addCallback(BeforeToolCallEvent, callback3)

      await expect(registry.invokeCallbacks(event)).rejects.toThrow('Non-interrupt failure')
      expect(callback3).not.toHaveBeenCalled()
    })

    it('runs all callbacks when only some raise interrupts', async () => {
      const event = createEvent()
      const callOrder: string[] = []

      registry.addCallback(BeforeToolCallEvent, () => {
        callOrder.push('first')
        event.interrupt({ name: 'interrupt_a', reason: 'Reason A' })
      })
      registry.addCallback(BeforeToolCallEvent, () => {
        callOrder.push('second-no-interrupt')
      })
      registry.addCallback(BeforeToolCallEvent, () => {
        callOrder.push('third')
        event.interrupt({ name: 'interrupt_b', reason: 'Reason B' })
      })

      await expect(registry.invokeCallbacks(event)).rejects.toThrow(InterruptError)
      expect(callOrder).toEqual(['first', 'second-no-interrupt', 'third'])

      const state = getInterruptState(mockAgent)
      expect(Object.keys(state.interrupts).length).toBe(2)
      expect(
        state
          .getInterruptsList()
          .map((i) => i.name)
          .sort()
      ).toEqual(['interrupt_a', 'interrupt_b'])
    })

    it('throws when two callbacks use the same interrupt name', async () => {
      const event = createEvent()

      registry.addCallback(BeforeToolCallEvent, () => {
        event.interrupt({ name: 'confirm', reason: 'First' })
      })
      registry.addCallback(BeforeToolCallEvent, () => {
        event.interrupt({ name: 'confirm', reason: 'Second' })
      })

      await expect(registry.invokeCallbacks(event)).rejects.toThrow(
        'interrupt_names=<confirm> | duplicate interrupt names'
      )
    })

    it('reports all duplicate interrupt names in error', async () => {
      const event = createEvent()

      registry.addCallback(BeforeToolCallEvent, () => {
        event.interrupt({ name: 'alpha' })
      })
      registry.addCallback(BeforeToolCallEvent, () => {
        event.interrupt({ name: 'alpha' })
      })
      registry.addCallback(BeforeToolCallEvent, () => {
        event.interrupt({ name: 'beta' })
      })
      registry.addCallback(BeforeToolCallEvent, () => {
        event.interrupt({ name: 'beta' })
      })

      await expect(registry.invokeCallbacks(event)).rejects.toThrow(
        'interrupt_names=<alpha, beta> | duplicate interrupt names'
      )
    })
  })
})
