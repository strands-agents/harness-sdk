/**
 * Hooks module for event-driven extensibility.
 *
 * This module has two concerns with distinct naming:
 *
 * - **Events** (`StreamEvent` and subclasses) — the data objects yielded by `agent.stream()`.
 *   Named `Stream*` because they are members of the agent stream.
 *   All current events extend {@link HookableEvent}, making them subscribable via hook callbacks.
 *   See {@link StreamEvent} and `events.ts` for the full taxonomy.
 *
 * - **Hook infrastructure** (`HookCallback`, `HookRegistry`, `HookCleanup`) —
 *   the subscription mechanism that lets callers register callbacks for {@link HookableEvent} types.
 *   Named `Hook*` because they describe the hooking/subscription pattern, not the events themselves.
 */

// Event classes
export {
  StreamEvent,
  HookableEvent,
  InitializedEvent,
  BeforeInvocationEvent,
  AfterInvocationEvent,
  MessageAddedEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  BeforeModelCallEvent,
  AfterModelCallEvent,
  ModelStreamUpdateEvent,
  ContentBlockEvent,
  ModelMessageEvent,
  ToolResultEvent,
  ToolStreamUpdateEvent,
  AgentResultEvent,
  InterruptEvent,
  BeforeToolsEvent,
  AfterToolsEvent,
} from './events.js'

// Event types
export type { ModelStopData as ModelStopResponse, Redaction, ToolUseData } from './events.js'

// Registry
export { HookRegistryImplementation as HookRegistry } from './registry.js'

// Types
export type { HookCallback, HookableEventConstructor, HookCallbackOptions, HookCleanup } from './types.js'
export { HookOrder } from './types.js'
