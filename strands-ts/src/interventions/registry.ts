import {
  BeforeInvocationEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  BeforeModelCallEvent,
  AfterModelCallEvent,
  type HookableEvent,
} from '../hooks/events.js'
import type { HookRegistry } from '../hooks/registry.js'
import { HookOrder } from '../hooks/types.js'
import { Message, TextBlock } from '../types/messages.js'
import type { Guide, InterventionAction } from './actions.js'
import { defaultEvaluate } from './actions.js'
import { InterventionHandler } from './handler.js'
import { InterruptError } from '../interrupt.js'
import { logger } from '../logging/logger.js'
import type { JSONValue } from '../types/json.js'

type LifecycleMethod = 'beforeInvocation' | 'beforeToolCall' | 'afterToolCall' | 'beforeModelCall' | 'afterModelCall'

/**
 * Bridges {@link InterventionHandler} instances and the Strands hook system.
 *
 * Registers one hook callback per lifecycle event type, then dispatches to
 * all handlers that override that method — in registration order, with
 * short-circuiting on Deny (and denied Confirms) and accumulation for Guide.
 *
 * See {@link InterventionAction} for the action-to-event compatibility matrix.
 */
export class InterventionRegistry {
  private readonly _handlers: InterventionHandler[]

  constructor(handlers: InterventionHandler[], hookRegistry: HookRegistry) {
    const seen = new Set<string>()
    for (const h of handlers) {
      if (seen.has(h.name)) {
        throw new Error(`Duplicate intervention handler name: '${h.name}'`)
      }
      seen.add(h.name)
    }
    this._handlers = handlers
    this._registerHooks(hookRegistry)
  }

  /** Registered handlers in registration order. */
  get handlers(): readonly InterventionHandler[] {
    return this._handlers
  }

  private _registerHooks(hookRegistry: HookRegistry): void {
    if (this._handlers.some((h) => h.beforeInvocation !== InterventionHandler.prototype.beforeInvocation)) {
      hookRegistry.addCallback(BeforeInvocationEvent, (e) => this._onBeforeInvocation(e), {
        order: HookOrder.INTERVENTION_INPUT,
      })
    }
    if (this._handlers.some((h) => h.beforeToolCall !== InterventionHandler.prototype.beforeToolCall)) {
      hookRegistry.addCallback(BeforeToolCallEvent, (e) => this._onBeforeToolCall(e), {
        order: HookOrder.INTERVENTION_INPUT,
      })
    }
    if (this._handlers.some((h) => h.afterToolCall !== InterventionHandler.prototype.afterToolCall)) {
      hookRegistry.addCallback(AfterToolCallEvent, (e) => this._onAfterToolCall(e), {
        order: HookOrder.INTERVENTION_OUTPUT,
      })
    }
    if (this._handlers.some((h) => h.beforeModelCall !== InterventionHandler.prototype.beforeModelCall)) {
      hookRegistry.addCallback(BeforeModelCallEvent, (e) => this._onBeforeModelCall(e), {
        order: HookOrder.INTERVENTION_INPUT,
      })
    }
    if (this._handlers.some((h) => h.afterModelCall !== InterventionHandler.prototype.afterModelCall)) {
      hookRegistry.addCallback(AfterModelCallEvent, (e) => this._onAfterModelCall(e), {
        order: HookOrder.INTERVENTION_OUTPUT,
      })
    }
  }

  private async _onBeforeInvocation(event: BeforeInvocationEvent): Promise<void> {
    return this._dispatch(event, 'beforeInvocation', (action, handlerName) => {
      switch (action.type) {
        case 'deny':
          event.cancel = `DENIED: ${action.reason}`
          return true
        case 'guide':
          event.cancel = `GUIDANCE: ${action.feedback}`
          return false
        case 'transform':
          action.apply(event)
          return false
        case 'proceed':
          return false
        default:
          logger.warn(`handler=<${handlerName}>, event=<beforeInvocation> | ${action.type} has no effect`)
          return false
      }
    })
  }

  private async _onBeforeToolCall(event: BeforeToolCallEvent): Promise<void> {
    return this._dispatch(event, 'beforeToolCall', (action, handlerName) => {
      const actionType = action.type
      switch (actionType) {
        case 'deny':
          event.cancel = `DENIED: ${action.reason}`
          return true
        case 'confirm': {
          // If response is provided, it's passed as a preemptive value to
          // event.interrupt() — the interrupt is registered but never pauses.
          // If no response, event.interrupt() throws InterruptError on first
          // call (pausing the agent for external resume).
          const result = event.interrupt<JSONValue>({
            name: handlerName,
            reason: action.prompt,
            ...(action.response !== undefined && { response: action.response }),
          })
          const check = action.evaluate ?? defaultEvaluate
          if (!check(result)) {
            event.cancel = `CONFIRMATION_FAILED: ${action.prompt}`
            return true
          }
          return false
        }
        case 'guide':
          event.cancel = `GUIDANCE: ${action.feedback}`
          return false
        case 'transform':
          action.apply(event)
          return false
        case 'proceed':
          return false
        default:
          logger.warn(`handler=<${handlerName}>, event=<beforeToolCall> | ${actionType} has no effect`)
          return false
      }
    })
  }

  private async _onAfterToolCall(event: AfterToolCallEvent): Promise<void> {
    return this._dispatch(event, 'afterToolCall', (action, handlerName) => {
      switch (action.type) {
        case 'transform':
          action.apply(event)
          return false
        case 'proceed':
          return false
        default:
          logger.warn(`handler=<${handlerName}>, event=<afterToolCall> | ${action.type} has no effect`)
          return false
      }
    })
  }

  // Guide on beforeModelCall injects feedback as a user message so the model sees
  // it on this call, rather than cancelling (which would end the invocation).
  private async _onBeforeModelCall(event: BeforeModelCallEvent): Promise<void> {
    return this._dispatch(event, 'beforeModelCall', (action, handlerName) => {
      switch (action.type) {
        case 'deny':
          event.cancel = `DENIED: ${action.reason}`
          return true
        case 'guide':
          // Direct push bypasses MessageAddedEvent and conversation manager.
          // This matches what plugins can do today via event.agent.messages.
          event.agent.messages.push(new Message({ role: 'user', content: [new TextBlock(action.feedback)] }))
          return false
        case 'transform':
          action.apply(event)
          return false
        case 'proceed':
          return false
        default:
          logger.warn(`handler=<${handlerName}>, event=<beforeModelCall> | ${action.type} has no effect`)
          return false
      }
    })
  }

  private async _onAfterModelCall(event: AfterModelCallEvent): Promise<void> {
    return this._dispatch(event, 'afterModelCall', (action, handlerName) => {
      switch (action.type) {
        case 'guide':
          event.retry = true
          // Direct push bypasses MessageAddedEvent and conversation manager, so this
          // message won't trigger context management and could push the context over
          // the limit. LocalAgent doesn't expose a message-append method that goes
          // through the hook pipeline. This matches what plugins can do today.
          event.agent.messages.push(new Message({ role: 'user', content: [new TextBlock(action.feedback)] }))
          return false
        case 'transform':
          action.apply(event)
          return false
        case 'proceed':
          return false
        default:
          logger.warn(`handler=<${handlerName}>, event=<afterModelCall> | ${action.type} has no effect`)
          return false
      }
    })
  }

  /**
   * Iterate handlers in registration order and resolve the winning action.
   *
   * - Deny short-circuits immediately (remaining handlers are skipped).
   * - Confirm pauses for human input; if denied short-circuits, if approved continues.
   * - Guide feedback strings accumulate across handlers and are applied at the end.
   * - Transform is applied in-place so later handlers see the mutation.
   * - If a handler throws, behavior depends on {@link InterventionHandler.onError}:
   *   `'throw'` (default) rethrows, `'deny'` fails closed, `'proceed'` skips.
   */
  private async _dispatch(
    event: HookableEvent,
    method: LifecycleMethod,
    apply: (action: InterventionAction, handlerName: string) => boolean
  ): Promise<void> {
    logger.debug(`event=<${method}> | dispatching to ${this._handlers.length} handler(s)`)
    const guides: Array<{ handlerName: string; action: Guide }> = []

    for (const handler of this._handlers) {
      if (handler[method] === InterventionHandler.prototype[method]) continue

      logger.debug(`handler=<${handler.name}>, event=<${method}> | evaluating`)

      let action: InterventionAction | undefined
      try {
        action = await handler[method](event as never)
      } catch (error) {
        // InterruptError is intentional control flow (pauses the agent),
        // not a handler failure. Always propagate regardless of onError.
        if (error instanceof InterruptError) {
          throw error
        }
        action = this._handleError(handler, method, error)
        if (!action) continue
      }

      logger.debug(`handler=<${handler.name}>, event=<${method}> | returned ${action.type}`)

      if (action.type === 'guide') {
        guides.push({ handlerName: handler.name, action })
      } else {
        try {
          if (apply(action, handler.name)) {
            logger.debug(`handler=<${handler.name}>, event=<${method}> | short-circuited`)
            return
          }
        } catch (error) {
          // InterruptError is intentional control flow (pauses the agent),
          // not a handler failure. Always propagate regardless of onError.
          if (error instanceof InterruptError) {
            throw error
          }
          const errorAction = this._handleError(handler, method, error)
          if (errorAction) {
            if (apply(errorAction, handler.name)) {
              return
            }
          }
        }
      }
    }

    // Guide feedback accumulates across handlers. Only applied if
    // no earlier handler short-circuited (deny/confirm).
    if (guides.length > 0) {
      logger.debug(`event=<${method}> | applying accumulated guide from ${guides.length} handler(s)`)
      const feedback = guides.map((g) => `[${g.handlerName}] ${g.action.feedback}`).join('\n')
      apply({ type: 'guide', feedback }, '')
    }
  }

  private _handleError(handler: InterventionHandler, method: string, error: unknown): InterventionAction | undefined {
    const errorMsg = error instanceof Error ? error.message : String(error)

    if (handler.onError === 'throw') {
      throw error
    } else if (handler.onError === 'deny') {
      return { type: 'deny', reason: `Handler threw: ${errorMsg}` }
    } else {
      return undefined
    }
  }
}
