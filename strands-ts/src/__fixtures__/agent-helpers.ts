/**
 * Test fixtures and helpers for Agent testing.
 * This module provides utilities for testing Agent-related implementations.
 */

import { expect } from 'vitest'
import type { Agent } from '../agent/agent.js'
import type { AgentResult, InvokableAgent, InvokeArgs, InvokeOptions } from '../types/agent.js'
import type { StopReason } from '../types/messages.js'
import { Message, TextBlock } from '../types/messages.js'
import type { Role } from '../types/messages.js'
import { StateStore } from '../state-store.js'
import type { JSONValue } from '../types/json.js'
import { ToolRegistry } from '../registry/tool-registry.js'
import { defaultSandbox } from '../sandbox/default.js'
import type { Sandbox } from '../sandbox/base.js'
import type { HookableEvent, StreamEvent } from '../hooks/events.js'
import type { HookableEventConstructor, HookCallback } from '../hooks/types.js'
import { AgentMetrics } from '../telemetry/meter.js'
import { expectLoopMetrics, type LoopMetricsMatcher } from './metrics-helpers.js'

/**
 * A hook registration captured by the mock agent's addHook.
 */
export type TrackedHook = {
  eventType: HookableEventConstructor<HookableEvent>
  callback: HookCallback<HookableEvent>
}

/**
 * Data for creating a mock Agent.
 */
export interface MockAgentData {
  /**
   * Messages for the agent.
   */
  messages?: Message[]
  /**
   * Initial state for the agent.
   */
  appState?: Record<string, JSONValue>
  /**
   * Optional tool registry for the agent.
   */
  toolRegistry?: ToolRegistry
  /**
   * Additional properties to spread onto the mock agent.
   */
  extra?: Partial<Agent>
}

/**
 * A mock Agent with a `trackedHooks` array populated by `addHook` calls.
 */
export type MockAgent = Agent & { trackedHooks: TrackedHook[] }

/**
 * Helper to create a mock Agent for testing.
 * Provides minimal Agent interface with messages, appState, and tool registry.
 * `addHook` captures registrations into `trackedHooks` for test inspection.
 *
 * @param data - Optional mock agent data
 * @returns Mock Agent with trackedHooks
 */
export function createMockAgent(data?: MockAgentData): MockAgent {
  const trackedHooks: TrackedHook[] = []
  return {
    messages: data?.messages ?? [],
    appState: new StateStore(data?.appState ?? {}),
    modelState: new StateStore(),
    toolRegistry: data?.toolRegistry ?? new ToolRegistry(),
    cancelSignal: new AbortController().signal,
    metrics: data?.extra?.metrics ?? new AgentMetrics(),
    // Mirror the real Agent.sandbox getter: resolve the environment default lazily.
    // An explicit `extra.sandbox` below overrides this accessor.
    get sandbox(): Sandbox {
      return defaultSandbox.get()
    },
    get sessionId(): string {
      return 'test-ses'
    },
    addHook: <T extends HookableEvent>(eventType: HookableEventConstructor<T>, callback: HookCallback<T>) => {
      trackedHooks.push({
        eventType: eventType as HookableEventConstructor<HookableEvent>,
        callback: callback as HookCallback<HookableEvent>,
      })
      return () => {}
    },
    // No-op so plugins that register middleware in initAgent (e.g. MemoryManager injection) work
    // out of the box. Tests that inspect registrations override this via `extra.addMiddleware`.
    addMiddleware: () => () => {},
    ...data?.extra,
    trackedHooks,
  } as unknown as MockAgent
}

/**
 * Creates a Message with the given role containing a single TextBlock.
 *
 * @param role - The message role
 * @param text - The text content
 * @returns A Message with the specified role
 */
export function textMessage(role: Role, text: string): Message {
  return new Message({ role, content: [new TextBlock(text)] })
}

/**
 * Finds the tracked hook for the given event type and invokes it with the provided event.
 * Throws if no hook is registered for that event type.
 *
 * @param agent - The mock agent with tracked hooks
 * @param event - The event instance to dispatch
 */
export async function invokeTrackedHook<T extends HookableEvent>(agent: MockAgent, event: T): Promise<void> {
  const hooks = agent.trackedHooks.filter((h) => h.eventType === event.constructor)
  if (hooks.length === 0) {
    throw new Error(`No hook registered for event type: ${event.constructor.name}`)
  }
  for (const hook of hooks) {
    await hook.callback(event)
  }
}

/**
 * Options for building an AgentResult matcher.
 */
export interface AgentResultMatcher extends Omit<LoopMetricsMatcher, 'cycleCount'> {
  /**
   * Expected stop reason from the final model response.
   */
  stopReason: StopReason

  /**
   * Expected text content in the last assistant message's TextBlock.
   * When provided, asserts exact text match in a TextBlock with role 'assistant'.
   * When omitted, only validates lastMessage exists with role 'assistant'.
   */
  messageText?: string

  /**
   * Expected number of agent loop cycles.
   */
  cycleCount: number

  /**
   * Expected number of traces. When provided, asserts exact array length.
   * When omitted, asserts traces array exists with at least one element.
   */
  traceCount?: number

  /**
   * Expected `invocationState` on the result. When provided, the full object
   * must match exactly — extra keys fail. When omitted, only asserts
   * `invocationState` is present (any object).
   */
  invocationState?: Record<string, unknown>
}

/**
 * Creates an asymmetric matcher that validates AgentResult structure and values.
 * Reduces nesting in test assertions by providing a clean, readable matcher.
 *
 * @param options - Expected result values
 * @returns An asymmetric matcher suitable for use in expect().toEqual()
 *
 * @example
 * ```typescript
 * expect(result).toEqual(expectAgentResult({
 *   stopReason: 'endTurn',
 *   messageText: 'Hello',
 *   cycleCount: 1,
 * }))
 * ```
 */
export function expectAgentResult(options: AgentResultMatcher): AgentResult {
  const { stopReason, messageText, cycleCount, traceCount, toolNames, usage, invocationState } = options

  const expectedLastMessage = messageText
    ? expect.objectContaining({
        role: 'assistant',
        content: expect.arrayContaining([expect.objectContaining({ type: 'textBlock', text: messageText })]),
      })
    : expect.objectContaining({ role: 'assistant' })

  const expectedTraces =
    traceCount !== undefined
      ? expect.objectContaining({ length: traceCount })
      : expect.arrayContaining([expect.objectContaining({ name: expect.any(String) })])

  // Build metrics matcher options, only including defined properties
  const metricsOptions: LoopMetricsMatcher = { cycleCount }
  if (toolNames !== undefined) {
    metricsOptions.toolNames = toolNames
  }
  if (usage !== undefined) {
    metricsOptions.usage = usage
  }

  return expect.objectContaining({
    type: 'agentResult',
    stopReason,
    lastMessage: expectedLastMessage,
    metrics: expectLoopMetrics(metricsOptions),
    traces: expectedTraces,
    invocationState: invocationState ?? expect.any(Object),
  }) as AgentResult
}

/**
 * Creates a minimal InvokableAgent that sleeps for `delayMs` before resolving,
 * aborting the sleep early when the invocation's `cancelSignal` fires. Used to
 * exercise timeout and cancellation behavior deterministically without spinning
 * up a full Agent.
 *
 * @param id - The agent id
 * @param delayMs - How long the agent should sleep before returning
 * @param structuredOutput - Optional structured output (e.g. a swarm handoff). When present,
 *   its `message` field is used as the assistant text.
 */
export function createCancellableAgent(
  id: string,
  delayMs: number,
  structuredOutput: { agentId?: string; message: string } = { message: 'done' }
): InvokableAgent {
  const sleep = (signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs)
      if (signal) {
        const onAbort = (): void => {
          clearTimeout(timer)
          reject(new Error('cancelled'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })

  return {
    id,
    description: `Agent ${id}`,
    async invoke(_args: InvokeArgs, options?: InvokeOptions): Promise<AgentResult> {
      await sleep(options?.cancelSignal)
      return {
        stopReason: 'endTurn',
        lastMessage: { role: 'assistant', content: [new TextBlock(structuredOutput.message)] },
        structuredOutput,
      } as AgentResult
    },
    // eslint-disable-next-line require-yield
    async *stream(args: InvokeArgs, options?: InvokeOptions): AsyncGenerator<StreamEvent, AgentResult, undefined> {
      return await this.invoke(args, options)
    },
  }
}
