import type { HookableEvent } from '../hooks/index.js'
import type { Plugin } from '../plugins/plugin.js'
import type { LocalAgent } from '../types/agent.js'
import {
  InitializedEvent,
  BeforeInvocationEvent,
  AfterInvocationEvent,
  MessageAddedEvent,
  BeforeToolsEvent,
  AfterToolsEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  BeforeModelCallEvent,
  AfterModelCallEvent,
  ToolResultEvent,
  ToolStreamUpdateEvent,
} from '../hooks/index.js'
import type { HookableEventConstructor } from '../hooks/types.js'

/**
 * Mock plugin that records all hookable event invocations for testing.
 */
export class MockPlugin implements Plugin {
  invocations: HookableEvent[] = []

  get name(): string {
    return 'mock-plugin'
  }

  initAgent(agent: LocalAgent): void {
    const eventTypes: HookableEventConstructor[] = [
      InitializedEvent,
      BeforeInvocationEvent,
      AfterInvocationEvent,
      MessageAddedEvent,
      BeforeToolsEvent,
      AfterToolsEvent,
      BeforeToolCallEvent,
      AfterToolCallEvent,
      BeforeModelCallEvent,
      AfterModelCallEvent,
      ToolResultEvent,
      ToolStreamUpdateEvent,
    ]

    for (const eventType of eventTypes) {
      agent.addHook(eventType, (e) => {
        this.invocations.push(e)
      })
    }
  }

  reset(): void {
    this.invocations = []
  }
}
