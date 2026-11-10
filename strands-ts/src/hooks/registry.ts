import type { HookableEvent } from './events.js'
import { HookOrder } from './types.js'
import type { HookCallback, HookableEventConstructor, HookCallbackOptions, HookCleanup } from './types.js'
import { InterruptError, Interrupt } from '../interrupt.js'

/**
 * Represents a registered callback entry.
 */
type CallbackEntry = {
  callback: HookCallback<HookableEvent>
  order: number
}

/**
 * Interface for hook registry operations.
 * Enables registration of hook callbacks for event-driven extensibility.
 */
export interface HookRegistry {
  /**
   * Register a callback function for a specific event type.
   *
   * @param eventType - The event class constructor to register the callback for
   * @param callback - The callback function to invoke when the event occurs
   * @param options - Optional configuration including execution order
   * @returns Cleanup function that removes the callback when invoked
   */
  addCallback<T extends HookableEvent>(
    eventType: HookableEventConstructor<T>,
    callback: HookCallback<T>,
    options?: HookCallbackOptions
  ): HookCleanup
}

/**
 * Implementation of the hook registry for managing hook callbacks.
 * Maintains mappings between event types and callback functions.
 */
export class HookRegistryImplementation implements HookRegistry {
  private readonly _callbacks: Map<HookableEventConstructor, CallbackEntry[]>

  constructor() {
    this._callbacks = new Map()
  }

  /** {@inheritDoc HookRegistry.addCallback} */
  addCallback<T extends HookableEvent>(
    eventType: HookableEventConstructor<T>,
    callback: HookCallback<T>,
    options?: HookCallbackOptions
  ): HookCleanup {
    const entry: CallbackEntry = {
      callback: callback as HookCallback<HookableEvent>,
      order: options?.order ?? HookOrder.DEFAULT,
    }
    const callbacks = this._callbacks.get(eventType) ?? []
    // Insert in sorted position: lower order first, same order preserves registration order
    const insertAt = callbacks.findIndex((e) => e.order > entry.order)
    if (insertAt === -1) {
      callbacks.push(entry)
    } else {
      callbacks.splice(insertAt, 0, entry)
    }
    this._callbacks.set(eventType, callbacks)

    return () => {
      const callbacks = this._callbacks.get(eventType)
      if (!callbacks) return
      const index = callbacks.indexOf(entry)
      if (index !== -1) {
        callbacks.splice(index, 1)
      }
    }
  }

  /**
   * Invoke all registered callbacks for the given event.
   * Awaits each callback, supporting both sync and async.
   *
   * InterruptErrors are collected across callbacks rather than immediately thrown,
   * allowing all hooks to register their interrupts. Non-interrupt errors propagate immediately.
   *
   * @param event - The event to invoke callbacks for
   * @returns The event after all callbacks have been invoked
   * @throws InterruptError with all collected interrupts after all callbacks complete
   */
  async invokeCallbacks<T extends HookableEvent>(event: T): Promise<T> {
    const callbacks = this.getCallbacksFor(event)
    const collectedInterrupts: Interrupt[] = []

    for (const callback of callbacks) {
      try {
        await callback(event)
      } catch (error) {
        if (error instanceof InterruptError) {
          collectedInterrupts.push(...error.interrupts)
        } else {
          throw error
        }
      }
    }

    if (collectedInterrupts.length > 0) {
      const seen = new Set<string>()
      const duplicates = new Set<string>()
      for (const interrupt of collectedInterrupts) {
        if (seen.has(interrupt.name)) {
          duplicates.add(interrupt.name)
        }
        seen.add(interrupt.name)
      }
      if (duplicates.size > 0) {
        const names = [...duplicates].join(', ')
        throw new Error(`interrupt_names=<${names}> | duplicate interrupt names`)
      }
      throw new InterruptError(collectedInterrupts)
    }

    return event
  }

  /**
   * Get callbacks for a specific event in order.
   * For After* events, reverses then re-sorts by order so that lower order
   * still runs first, but same-order hooks run in reverse registration order.
   *
   * @param event - The event to get callbacks for
   * @returns Array of callbacks for the event
   */
  private getCallbacksFor<T extends HookableEvent>(event: T): HookCallback<T>[] {
    const entries = this._callbacks.get(event.constructor as HookableEventConstructor<T>) ?? []
    if (event._shouldReverseCallbacks()) {
      const reversed = [...entries].reverse().sort((a, b) => a.order - b.order)
      return reversed.map((entry) => entry.callback) as HookCallback<T>[]
    }
    return entries.map((entry) => entry.callback) as HookCallback<T>[]
  }
}
