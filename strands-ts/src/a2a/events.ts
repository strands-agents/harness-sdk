/**
 * A2A-specific stream events yielded by A2AAgent.stream().
 */

import type { Message, Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from '@a2a-js/sdk'
import { StreamEvent } from '../hooks/events.js'
import type { AgentResultEvent } from '../hooks/events.js'

/**
 * Union of raw A2A protocol event types received during streaming.
 */
export type A2AEventData = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent

/**
 * Event wrapping a raw A2A protocol streaming event.
 *
 * Yielded by `A2AAgent.stream()` for each event received from the remote agent.
 * The `event` property contains the raw A2A SDK event data, discriminated by `kind`:
 * - `'message'` — A2A Message
 * - `'task'` — A2A Task
 * - `'status-update'` — TaskStatusUpdateEvent
 * - `'artifact-update'` — TaskArtifactUpdateEvent
 */
export class A2AStreamUpdateEvent extends StreamEvent {
  readonly type = 'a2aStreamUpdateEvent' as const
  readonly event: A2AEventData

  constructor(event: A2AEventData) {
    super()
    this.event = event
  }

  toJSON(): Pick<A2AStreamUpdateEvent, 'type' | 'event'> {
    return { type: this.type, event: this.event }
  }
}

/**
 * Event triggered as the final event in the A2A agent stream.
 * Wraps the agent result containing the stop reason and last message.
 */
export class A2AResultEvent extends StreamEvent {
  readonly type = 'a2aResultEvent' as const
  readonly result: AgentResultEvent['result']

  constructor(data: Pick<AgentResultEvent, 'result'>) {
    super()
    this.result = data.result
  }

  toJSON(): Pick<A2AResultEvent, 'type' | 'result'> {
    return { type: this.type, result: this.result }
  }
}

/**
 * Union of all events yielded by `A2AAgent.stream()`.
 *
 * Includes raw A2A protocol events ({@link A2AStreamUpdateEvent}) and the final
 * result event ({@link A2AResultEvent}).
 */
export type A2AStreamEvent = A2AStreamUpdateEvent | A2AResultEvent
