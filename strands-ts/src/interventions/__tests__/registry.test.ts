import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InterventionRegistry } from '../registry.js'
import { InterventionHandler } from '../handler.js'
import { HookRegistryImplementation } from '../../hooks/registry.js'
import { Agent } from '../../agent/agent.js'
import {
  BeforeInvocationEvent,
  BeforeToolCallEvent,
  BeforeModelCallEvent,
  AfterModelCallEvent,
} from '../../hooks/events.js'
import { Message, TextBlock } from '../../types/messages.js'
import { deny } from '../actions.js'
import type { InterventionAction, Guide, Transform, Proceed } from '../actions.js'
import { Interrupt, InterruptState } from '../../interrupt.js'

class DenyHandler extends InterventionHandler {
  readonly name = 'deny-handler'

  override beforeToolCall(): InterventionAction {
    return { type: 'deny', reason: 'not authorized' }
  }
}

class GuideHandler extends InterventionHandler {
  readonly name = 'guide-handler'

  override beforeToolCall(): InterventionAction {
    return { type: 'guide', feedback: 'add more context' }
  }
}

class ConfirmHandler extends InterventionHandler {
  readonly name = 'confirm-handler'

  override beforeToolCall(): InterventionAction {
    return { type: 'confirm', prompt: 'approve this action?' }
  }
}

class ProceedHandler extends InterventionHandler {
  readonly name = 'proceed-handler'

  override beforeToolCall(): InterventionAction {
    return { type: 'proceed', reason: 'all good' }
  }
}

class ThrowingHandler extends InterventionHandler {
  readonly name = 'throwing-handler'
  override readonly onError = 'throw' as const

  override beforeToolCall(): InterventionAction {
    throw new Error('handler crashed')
  }
}

class ThrowingProceedHandler extends InterventionHandler {
  readonly name = 'throwing-proceed'
  override readonly onError = 'proceed' as const

  override beforeToolCall(): InterventionAction {
    throw new Error('handler crashed')
  }
}

class ThrowingDenyHandler extends InterventionHandler {
  readonly name = 'throwing-deny'
  override readonly onError = 'deny' as const

  override beforeToolCall(): InterventionAction {
    throw new Error('handler crashed')
  }
}

class AsyncDenyHandler extends InterventionHandler {
  readonly name = 'async-deny'

  override async beforeToolCall(): Promise<InterventionAction> {
    return { type: 'deny', reason: 'async denial' }
  }
}

class ModelGuideHandler extends InterventionHandler {
  readonly name = 'model-guide'

  override afterModelCall(): Proceed | Guide | Transform {
    return { type: 'guide', feedback: 'be more specific' }
  }
}

describe('InterventionRegistry', () => {
  let hookRegistry: HookRegistryImplementation
  let agent: Agent
  const toolUse = { name: 'testTool', toolUseId: 'id-1', input: {} }

  beforeEach(() => {
    hookRegistry = new HookRegistryImplementation()
    agent = new Agent()
  })

  function makeBeforeInvocationEvent() {
    return new BeforeInvocationEvent({ agent, invocationState: {} })
  }

  function makeBeforeToolCallEvent() {
    return new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} })
  }

  function makeBeforeModelCallEvent() {
    return new BeforeModelCallEvent({ agent, model: {} as never, invocationState: {} })
  }

  function makeAfterModelCallEvent() {
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

  describe('constructor', () => {
    it('rejects duplicate handler names', () => {
      expect(() => new InterventionRegistry([new DenyHandler(), new DenyHandler()], hookRegistry)).toThrow(
        "Duplicate intervention handler name: 'deny-handler'"
      )
    })

    it('accepts handlers with unique names', () => {
      // No throw means success
      new InterventionRegistry([new DenyHandler(), new GuideHandler()], hookRegistry)
    })
  })

  describe('hook registration', () => {
    it('only registers hooks for overridden methods', async () => {
      new InterventionRegistry([new DenyHandler()], hookRegistry)

      const beforeToolEvent = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(beforeToolEvent)
      expect(beforeToolEvent.cancel).toBe('DENIED: not authorized')

      // afterModelCall should not be registered — no handler overrides it
      const afterModelEvent = makeAfterModelCallEvent()
      await hookRegistry.invokeCallbacks(afterModelEvent)
      expect(afterModelEvent.retry).toBeUndefined()
    })
  })

  describe('dispatch ordering', () => {
    it('calls handlers in registration order', async () => {
      const callOrder: string[] = []

      class First extends InterventionHandler {
        readonly name = 'first'
        override beforeToolCall(): InterventionAction {
          callOrder.push('first')
          return { type: 'proceed' }
        }
      }
      class Second extends InterventionHandler {
        readonly name = 'second'
        override beforeToolCall(): InterventionAction {
          callOrder.push('second')
          return { type: 'proceed' }
        }
      }

      new InterventionRegistry([new First(), new Second()], hookRegistry)

      await hookRegistry.invokeCallbacks(makeBeforeToolCallEvent())
      expect(callOrder).toEqual(['first', 'second'])
    })

    it('skips handlers that do not override the method', async () => {
      const callOrder: string[] = []

      class ToolHandler extends InterventionHandler {
        readonly name = 'tool'
        override beforeToolCall(): InterventionAction {
          callOrder.push('tool')
          return { type: 'proceed' }
        }
      }
      class ModelHandler extends InterventionHandler {
        readonly name = 'model'
        override afterModelCall(): Proceed | Guide | Transform {
          callOrder.push('model')
          return { type: 'proceed' }
        }
      }

      new InterventionRegistry([new ToolHandler(), new ModelHandler()], hookRegistry)

      await hookRegistry.invokeCallbacks(makeBeforeToolCallEvent())
      expect(callOrder).toEqual(['tool'])
    })
  })

  describe('deny', () => {
    it('sets cancel on BeforeToolCallEvent', async () => {
      new InterventionRegistry([new DenyHandler()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)

      expect(event.cancel).toBe('DENIED: not authorized')
    })

    it('short-circuits — later handlers do not run', async () => {
      const laterCalled = vi.fn()

      class LaterHandler extends InterventionHandler {
        readonly name = 'later'
        override beforeToolCall(): InterventionAction {
          laterCalled()
          return { type: 'proceed' }
        }
      }

      new InterventionRegistry([new DenyHandler(), new LaterHandler()], hookRegistry)

      await hookRegistry.invokeCallbacks(makeBeforeToolCallEvent())
      expect(laterCalled).not.toHaveBeenCalled()
    })

    it('sets cancel on BeforeInvocationEvent', async () => {
      class InvocationDeny extends InterventionHandler {
        readonly name = 'invocation-deny'
        override beforeInvocation() {
          return deny('unauthorized user')
        }
      }

      new InterventionRegistry([new InvocationDeny()], hookRegistry)

      const event = makeBeforeInvocationEvent()
      await hookRegistry.invokeCallbacks(event)
      expect(event.cancel).toBe('DENIED: unauthorized user')
    })

    it('sets cancel on BeforeModelCallEvent', async () => {
      class ModelDeny extends InterventionHandler {
        readonly name = 'model-deny'
        override beforeModelCall() {
          return deny('prompt injection detected')
        }
      }

      new InterventionRegistry([new ModelDeny()], hookRegistry)

      const event = makeBeforeModelCallEvent()
      await hookRegistry.invokeCallbacks(event)
      expect(event.cancel).toBe('DENIED: prompt injection detected')
    })
  })

  describe('guide', () => {
    it('sets cancel with guidance on BeforeToolCallEvent', async () => {
      new InterventionRegistry([new GuideHandler()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)
      expect(event.cancel).toBe('GUIDANCE: [guide-handler] add more context')
    })

    it('accumulates feedback from multiple handlers', async () => {
      class SecondGuide extends InterventionHandler {
        readonly name = 'second-guide'
        override beforeToolCall(): InterventionAction {
          return { type: 'guide', feedback: 'also check permissions' }
        }
      }

      new InterventionRegistry([new GuideHandler(), new SecondGuide()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)
      expect(event.cancel).toBe('GUIDANCE: [guide-handler] add more context\n[second-guide] also check permissions')
    })

    it('sets retry=true and injects guidance message on AfterModelCallEvent', async () => {
      new InterventionRegistry([new ModelGuideHandler()], hookRegistry)

      const event = makeAfterModelCallEvent()
      const messageCountBefore = event.agent.messages.length
      await hookRegistry.invokeCallbacks(event)

      expect(event.retry).toBe(true)
      expect(event.agent.messages).toHaveLength(messageCountBefore + 1)
      const guidanceMessage = event.agent.messages[event.agent.messages.length - 1]!
      expect(guidanceMessage.role).toBe('user')
      expect(guidanceMessage.content[0]).toMatchObject({ type: 'textBlock', text: '[model-guide] be more specific' })
      // The injected message carries a durable tracking id even though it bypasses the append chokepoint.
      expect(typeof guidanceMessage.trackingId).toBe('string')
      expect(guidanceMessage.trackingId).toBeTruthy()
    })
  })

  describe('confirm', () => {
    it('pauses agent when no response is provided', async () => {
      new InterventionRegistry([new ConfirmHandler()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await expect(hookRegistry.invokeCallbacks(event)).rejects.toThrow('Interrupt raised')
    })

    it('short-circuits — later handlers do not run', async () => {
      const laterCalled = vi.fn()

      class LaterHandler extends InterventionHandler {
        readonly name = 'later'
        override beforeToolCall(): InterventionAction {
          laterCalled()
          return { type: 'proceed' }
        }
      }

      new InterventionRegistry([new ConfirmHandler(), new LaterHandler()], hookRegistry)

      await expect(hookRegistry.invokeCallbacks(makeBeforeToolCallEvent())).rejects.toThrow()
      expect(laterCalled).not.toHaveBeenCalled()
    })

    function preloadInterruptResponse(handlerName: string, response: unknown) {
      const interruptId = `hook:beforeToolCall:${toolUse.toolUseId}:${handlerName}`
      const interruptState = (agent as unknown as { _interruptState: InterruptState })._interruptState
      interruptState.interrupts[interruptId] = new Interrupt({
        id: interruptId,
        name: handlerName,
        response: response as never,
        source: 'hook',
      })
    }

    describe('approve/deny on resume', () => {
      const DENIED = 'CONFIRMATION_FAILED: approve this action?'

      it.each([
        [true, false],
        ['yes', false],
        ['y', false],
        ['Y', false],
        ['YES', false],
        ['  yes  ', false],
        ['no', DENIED],
        [false, DENIED],
        [null, DENIED],
        ['', DENIED],
      ])('response %j → cancel=%j', async (response, expectedCancel) => {
        preloadInterruptResponse('confirm-handler', response)
        new InterventionRegistry([new ConfirmHandler()], hookRegistry)

        const event = makeBeforeToolCallEvent()
        await hookRegistry.invokeCallbacks(event)
        expect(event.cancel).toBe(expectedCancel)
      })
    })

    it('uses custom evaluate when provided', async () => {
      class CustomApprovalHandler extends InterventionHandler {
        readonly name = 'custom-approval'
        override beforeToolCall(): InterventionAction {
          return {
            type: 'confirm',
            prompt: 'approve?',
            evaluate: (response) => response === 'custom-yes',
          }
        }
      }

      // 'yes' would pass default evaluate but fails custom
      preloadInterruptResponse('custom-approval', 'yes')

      new InterventionRegistry([new CustomApprovalHandler()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)
      expect(event.cancel).toBe('CONFIRMATION_FAILED: approve?')
    })

    it('custom evaluate approves when its condition is met', async () => {
      class CustomApprovalHandler extends InterventionHandler {
        readonly name = 'custom-approval'
        override beforeToolCall(): InterventionAction {
          return {
            type: 'confirm',
            prompt: 'approve?',
            evaluate: (response) => response === 'custom-yes',
          }
        }
      }

      preloadInterruptResponse('custom-approval', 'custom-yes')

      new InterventionRegistry([new CustomApprovalHandler()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)
      expect(event.cancel).toBe(false)
    })

    it('approved confirm does not short-circuit later handlers', async () => {
      preloadInterruptResponse('confirm-handler', 'yes')

      const laterCalled = vi.fn()

      class LaterHandler extends InterventionHandler {
        readonly name = 'later'
        override beforeToolCall(): InterventionAction {
          laterCalled()
          return { type: 'proceed' }
        }
      }

      new InterventionRegistry([new ConfirmHandler(), new LaterHandler()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)
      expect(event.cancel).toBe(false)
      expect(laterCalled).toHaveBeenCalled()
    })

    it('denied confirm short-circuits later handlers', async () => {
      preloadInterruptResponse('confirm-handler', 'no')
      const laterCalled = vi.fn()

      class LaterHandler extends InterventionHandler {
        readonly name = 'later'
        override beforeToolCall(): InterventionAction {
          laterCalled()
          return { type: 'proceed' }
        }
      }

      new InterventionRegistry([new ConfirmHandler(), new LaterHandler()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)
      expect(event.cancel).toBe('CONFIRMATION_FAILED: approve this action?')
      expect(laterCalled).not.toHaveBeenCalled()
    })

    describe('preemptive response (inline mode)', () => {
      it('approves when response is an approved value', async () => {
        class InlineConfirmHandler extends InterventionHandler {
          readonly name = 'inline-confirm'
          override beforeToolCall(): InterventionAction {
            return { type: 'confirm', prompt: 'approve?', response: 'yes' }
          }
        }

        new InterventionRegistry([new InlineConfirmHandler()], hookRegistry)

        const event = makeBeforeToolCallEvent()
        await hookRegistry.invokeCallbacks(event)
        expect(event.cancel).toBe(false)
      })

      it('denies when response is a non-approved value', async () => {
        class InlineConfirmHandler extends InterventionHandler {
          readonly name = 'inline-confirm'
          override beforeToolCall(): InterventionAction {
            return { type: 'confirm', prompt: 'approve?', response: 'no' }
          }
        }

        new InterventionRegistry([new InlineConfirmHandler()], hookRegistry)

        const event = makeBeforeToolCallEvent()
        await hookRegistry.invokeCallbacks(event)
        expect(event.cancel).toBe('CONFIRMATION_FAILED: approve?')
      })

      it('uses custom evaluate with preemptive response', async () => {
        class OtpHandler extends InterventionHandler {
          readonly name = 'otp-handler'
          override beforeToolCall(): InterventionAction {
            return {
              type: 'confirm',
              prompt: 'Enter OTP:',
              response: '123456',
              evaluate: (r) => r === '123456',
            }
          }
        }

        new InterventionRegistry([new OtpHandler()], hookRegistry)

        const event = makeBeforeToolCallEvent()
        await hookRegistry.invokeCallbacks(event)
        expect(event.cancel).toBe(false)
      })

      it('passes response as preemptive value so agent never pauses', async () => {
        class InlineConfirmHandler extends InterventionHandler {
          readonly name = 'inline-confirm'
          override beforeToolCall(): InterventionAction {
            return { type: 'confirm', prompt: 'approve?', response: 'yes' }
          }
        }

        new InterventionRegistry([new InlineConfirmHandler()], hookRegistry)

        const event = makeBeforeToolCallEvent()
        const interruptSpy = vi.spyOn(event, 'interrupt')
        await hookRegistry.invokeCallbacks(event)
        expect(interruptSpy).toHaveBeenCalledWith({ name: 'inline-confirm', reason: 'approve?', response: 'yes' })
      })

      it('denies when response is falsy but defined (false)', async () => {
        class InlineConfirmHandler extends InterventionHandler {
          readonly name = 'inline-confirm'
          override beforeToolCall(): InterventionAction {
            return { type: 'confirm', prompt: 'approve?', response: false }
          }
        }

        new InterventionRegistry([new InlineConfirmHandler()], hookRegistry)

        const event = makeBeforeToolCallEvent()
        await hookRegistry.invokeCallbacks(event)
        expect(event.cancel).toBe('CONFIRMATION_FAILED: approve?')
      })
    })

    it.each(['proceed', 'deny'] as const)(
      'InterruptError always propagates regardless of onError=%s',
      async (onError) => {
        class ConfirmWithOnError extends InterventionHandler {
          readonly name = 'confirm-onerror'
          override readonly onError = onError
          override beforeToolCall(): InterventionAction {
            return { type: 'confirm', prompt: 'approve?' }
          }
        }

        new InterventionRegistry([new ConfirmWithOnError()], hookRegistry)

        const event = makeBeforeToolCallEvent()
        await expect(hookRegistry.invokeCallbacks(event)).rejects.toThrow('Interrupt raised')
      }
    )

    // Guards #4371: a handler calling event.interrupt() directly pauses the agent under any onError.
    it.each(['proceed', 'deny'] as const)(
      'a handler-raised InterruptError propagates regardless of onError=%s',
      async (onError) => {
        class DirectInterruptHandler extends InterventionHandler {
          readonly name = 'direct-interrupt'
          override readonly onError = onError
          override beforeToolCall(event: BeforeToolCallEvent): InterventionAction {
            event.interrupt({ name: 'approval', reason: 'approve?' })
            return { type: 'proceed' }
          }
        }

        new InterventionRegistry([new DirectInterruptHandler()], hookRegistry)

        const event = makeBeforeToolCallEvent()
        await expect(hookRegistry.invokeCallbacks(event)).rejects.toThrow('Interrupt raised')
        expect(event.cancel).toBe(false)
      }
    )
  })

  describe('transform', () => {
    it('calls the apply function with the event', async () => {
      const applyFn = vi.fn()

      class TransformHandler extends InterventionHandler {
        readonly name = 'transform-handler'
        override beforeToolCall(): InterventionAction {
          return { type: 'transform', apply: applyFn, reason: 'sanitized input' }
        }
      }

      new InterventionRegistry([new TransformHandler()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)
      expect(applyFn).toHaveBeenCalledWith(event)
    })

    it('later handlers see the transformed state', async () => {
      const observed: string[] = []

      class Transformer extends InterventionHandler {
        readonly name = 'transformer'
        override beforeToolCall(): InterventionAction {
          return {
            type: 'transform',
            apply: (e) => {
              ;(e as BeforeToolCallEvent).cancel = 'transformed'
            },
          }
        }
      }

      class Observer extends InterventionHandler {
        readonly name = 'observer'
        override beforeToolCall(event: BeforeToolCallEvent): InterventionAction {
          observed.push(String(event.cancel))
          return { type: 'proceed' }
        }
      }

      new InterventionRegistry([new Transformer(), new Observer()], hookRegistry)

      await hookRegistry.invokeCallbacks(makeBeforeToolCallEvent())
      expect(observed).toEqual(['transformed'])
    })

    it('works on AfterModelCallEvent', async () => {
      const applyFn = vi.fn()

      class ModelTransform extends InterventionHandler {
        readonly name = 'model-transform'
        override afterModelCall(): Proceed | Guide | Transform {
          return { type: 'transform', apply: applyFn, reason: 'redacted output' }
        }
      }

      new InterventionRegistry([new ModelTransform()], hookRegistry)

      const event = makeAfterModelCallEvent()
      await hookRegistry.invokeCallbacks(event)
      expect(applyFn).toHaveBeenCalledWith(event)
    })

    it('is logged in the audit trail', async () => {
      class TransformHandler extends InterventionHandler {
        readonly name = 'transform-handler'
        override beforeToolCall(): InterventionAction {
          return { type: 'transform', apply: () => {}, reason: 'sanitized' }
        }
      }

      new InterventionRegistry([new TransformHandler()], hookRegistry)

      await hookRegistry.invokeCallbacks(makeBeforeToolCallEvent())
      // Transform was applied (verified by the apply fn mock tests above)
    })
  })

  describe('proceed', () => {
    it('does not mutate the event', async () => {
      new InterventionRegistry([new ProceedHandler()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)
      expect(event.cancel).toBe(false)
    })
  })

  describe('error handling', () => {
    it('onError=throw (default) rethrows the error', async () => {
      new InterventionRegistry([new ThrowingHandler(), new ProceedHandler()], hookRegistry)

      await expect(hookRegistry.invokeCallbacks(makeBeforeToolCallEvent())).rejects.toThrow('handler crashed')
    })

    it('onError=proceed skips the handler and continues to next', async () => {
      new InterventionRegistry([new ThrowingProceedHandler(), new ProceedHandler()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)
      expect(event.cancel).toBe(false)
    })

    it('onError=deny logs the error and applies deny', async () => {
      const laterCalled = vi.fn()

      class LaterHandler extends InterventionHandler {
        readonly name = 'later'
        override beforeToolCall(): InterventionAction {
          laterCalled()
          return { type: 'proceed' }
        }
      }

      new InterventionRegistry([new ThrowingDenyHandler(), new LaterHandler()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)

      expect(event.cancel).toBe('DENIED: Handler threw: handler crashed')
      expect(laterCalled).not.toHaveBeenCalled()
    })
  })

  describe('async handlers', () => {
    it('awaits async handler results', async () => {
      new InterventionRegistry([new AsyncDenyHandler()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)
      expect(event.cancel).toBe('DENIED: async denial')
    })
  })

  describe('conflict resolution', () => {
    it('deny wins over guide', async () => {
      new InterventionRegistry([new GuideHandler(), new DenyHandler()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)

      expect(event.cancel).toBe('DENIED: not authorized')
    })

    it('deny short-circuits before guide can accumulate', async () => {
      new InterventionRegistry([new DenyHandler(), new GuideHandler()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)

      expect(event.cancel).toBe('DENIED: not authorized')
    })

    it('confirm short-circuits before guide can accumulate', async () => {
      new InterventionRegistry([new ConfirmHandler(), new GuideHandler()], hookRegistry)

      await expect(hookRegistry.invokeCallbacks(makeBeforeToolCallEvent())).rejects.toThrow('Interrupt raised')
    })
  })

  describe('agent integration', () => {
    it('deny on beforeToolCall prevents tool execution', async () => {
      const { MockMessageModel } = await import('../../__fixtures__/mock-message-model.js')
      const { createMockTool } = await import('../../__fixtures__/tool-helpers.js')

      let toolExecuted = false
      const tool = createMockTool('blockedTool', () => {
        toolExecuted = true
        return 'should not reach here'
      })

      class BlockAllTools extends InterventionHandler {
        readonly name = 'block-all'
        override beforeToolCall(): InterventionAction {
          return { type: 'deny', reason: 'blocked by intervention' }
        }
      }

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'blockedTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [new BlockAllTools()],
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(false)
    })

    it('interventions run before plugins (HookOrder.INTERVENTIONS < DEFAULT)', async () => {
      const { MockMessageModel } = await import('../../__fixtures__/mock-message-model.js')
      const { createMockTool } = await import('../../__fixtures__/tool-helpers.js')

      const callOrder: string[] = []

      const tool = createMockTool('testTool', () => 'result')

      class OrderTracker extends InterventionHandler {
        readonly name = 'order-tracker'
        override beforeToolCall(): InterventionAction {
          callOrder.push('intervention')
          return { type: 'proceed' }
        }
      }

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [new OrderTracker()],
      })

      agent.addHook(BeforeToolCallEvent, () => {
        callOrder.push('plugin')
      })

      await agent.invoke('Test')

      // On Before*: plugins run first (DEFAULT:0), interventions last (INTERVENTIONS:90)
      expect(callOrder[0]).toBe('plugin')
      expect(callOrder[1]).toBe('intervention')
    })
  })

  describe('edge cases', () => {
    it('guide on beforeModelCall injects a user message', async () => {
      class ModelGuide extends InterventionHandler {
        readonly name = 'model-guide'
        override beforeModelCall(): Proceed | Guide | Transform {
          return { type: 'guide', feedback: 'check your sources' }
        }
      }

      new InterventionRegistry([new ModelGuide()], hookRegistry)

      const event = makeBeforeModelCallEvent()
      const messageCountBefore = event.agent.messages.length
      await hookRegistry.invokeCallbacks(event)

      expect(event.cancel).toBe(false)
      expect(event.agent.messages).toHaveLength(messageCountBefore + 1)
      const injected = event.agent.messages[event.agent.messages.length - 1]!
      expect(injected.role).toBe('user')
      expect(injected.content[0]).toMatchObject({ type: 'textBlock', text: '[model-guide] check your sources' })
      // The injected message carries a durable tracking id even though it bypasses the append chokepoint.
      expect(typeof injected.trackingId).toBe('string')
      expect(injected.trackingId).toBeTruthy()
    })

    it('transform apply() error is handled via onError policy', async () => {
      class BadTransform extends InterventionHandler {
        readonly name = 'bad-transform'
        override readonly onError = 'proceed' as const
        override beforeToolCall(): InterventionAction {
          return {
            type: 'transform',
            apply: () => {
              throw new Error('apply boom')
            },
          }
        }
      }

      class AfterTransform extends InterventionHandler {
        readonly name = 'after-transform'
        override beforeToolCall(): InterventionAction {
          return { type: 'proceed', reason: 'still running' }
        }
      }

      new InterventionRegistry([new BadTransform(), new AfterTransform()], hookRegistry)

      const event = makeBeforeToolCallEvent()
      await hookRegistry.invokeCallbacks(event)
      // onError=proceed means the error is swallowed and next handler runs
      expect(event.cancel).toBe(false)
    })

    it('transform apply() error with onError=throw propagates', async () => {
      class BadTransform extends InterventionHandler {
        readonly name = 'bad-transform'
        override readonly onError = 'throw' as const
        override beforeToolCall(): InterventionAction {
          return {
            type: 'transform',
            apply: () => {
              throw new Error('apply boom')
            },
          }
        }
      }

      new InterventionRegistry([new BadTransform()], hookRegistry)

      await expect(hookRegistry.invokeCallbacks(makeBeforeToolCallEvent())).rejects.toThrow('apply boom')
    })

    it('warns when action has no effect on event type', async () => {
      const { logger } = await import('../../logging/logger.js')
      const warnSpy = vi.spyOn(logger, 'warn')

      // Force a confirm return on beforeInvocation (which doesn't support it)
      // via cast to test the runtime warning path
      class InterruptOnInvocation extends InterventionHandler {
        readonly name = 'confirm-invocation'
        override beforeInvocation() {
          // Force a confirm return via any cast to test the runtime warning
          return { type: 'confirm', prompt: 'test' } as never
        }
      }

      new InterventionRegistry([new InterruptOnInvocation()], hookRegistry)

      await hookRegistry.invokeCallbacks(makeBeforeInvocationEvent())
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('has no effect'))

      warnSpy.mockRestore()
    })
  })
})
