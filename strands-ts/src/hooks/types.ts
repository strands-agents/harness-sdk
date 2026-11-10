import type { HookableEvent } from './events.js'

/**
 * Type for a constructor function that creates HookableEvent instances.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HookableEventConstructor<T extends HookableEvent = HookableEvent> = new (...args: any[]) => T

/**
 * Type for callback functions that handle hookable events.
 * Callbacks can be synchronous or asynchronous.
 *
 * @example
 * ```typescript
 * const callback: HookCallback<BeforeInvocationEvent> = (event) => {
 *   console.log('Agent invocation started')
 * }
 * ```
 */
export type HookCallback<T extends HookableEvent> = (event: T) => void | Promise<void>

/**
 * Options for registering a hook callback.
 */
export interface HookCallbackOptions {
  order?: number
}

/**
 * Function that removes a previously registered hook callback.
 * Safe to call multiple times (idempotent).
 * No-op if the callback is no longer registered.
 */
export type HookCleanup = () => void

/**
 * Presets for hook execution order. Lower values run first.
 * Any number is a valid order — these presets are not bounds, just convenient
 * reference points. SDK_FIRST/SDK_LAST mark where the SDK's own hooks run,
 * so you can position yours relative to them.
 *
 * @example
 * ```typescript
 * agent.addHook(BeforeToolCallEvent, callback, { order: HookOrder.SDK_FIRST }) // run with the SDK's earliest hooks
 * agent.addHook(BeforeToolCallEvent, callback, { order: HookOrder.SDK_FIRST - 1 }) // run before the SDK's earliest hooks
 * ```
 */
export const HookOrder = {
  SDK_FIRST: -100,
  INTERVENTION_OUTPUT: -90,
  DEFAULT: 0,
  MODEL_ROUTING: 50,
  INTERVENTION_INPUT: 90,
  SDK_LAST: 100,
} as const
