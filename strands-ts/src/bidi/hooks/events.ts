/**
 * Hook events emitted by bidirectional agents.
 *
 * All events follow the conventions in `hooks/events.ts`: they extend {@link HookableEvent},
 * carry a `readonly type` discriminator (camelCase of the class name), take a single data-object
 * constructor parameter, and omit the agent reference from `toJSON()`.
 */

import { HookableEvent } from '../../hooks/events.js'

import type { InvocationState, LocalAgent } from '../../types/agent.js'
import type { ConnectionTimeoutError } from '../models/model.js'

/**
 * Event triggered after a bidirectional agent attempts to stop its streaming session.
 *
 * This event is fired after background-task and model cleanup have been attempted, including
 * when cleanup raises an error. Hook callbacks can use this event for cleanup, logging, or state
 * persistence.
 *
 * Note: this event uses reverse callback ordering, meaning callbacks registered later are
 * invoked first during cleanup.
 */
export class BidiAgentStopEvent extends HookableEvent {
  readonly type = 'bidiAgentStopEvent' as const
  readonly agent: LocalAgent
  readonly invocationState: InvocationState

  constructor(data: { agent: LocalAgent; invocationState: InvocationState }) {
    super()
    this.agent = data.agent
    this.invocationState = data.invocationState
  }

  override _shouldReverseCallbacks(): boolean {
    return true
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<BidiAgentStopEvent, 'type'> {
    return { type: this.type }
  }
}

/**
 * Event triggered when the model reports that a response has ended.
 *
 * A connection failure or shutdown without a model-reported completion does not emit this event.
 */
export class BidiResponseStopEvent extends HookableEvent {
  readonly type = 'bidiResponseStopEvent' as const
  readonly agent: LocalAgent
  readonly invocationState: InvocationState

  /** Identifier of the response that ended. */
  readonly responseId: string

  constructor(data: { agent: LocalAgent; invocationState: InvocationState; responseId: string }) {
    super()
    this.agent = data.agent
    this.invocationState = data.invocationState
    this.responseId = data.responseId
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<BidiResponseStopEvent, 'type' | 'responseId'> {
    return { type: this.type, responseId: this.responseId }
  }
}

/**
 * Event triggered to stop current response generation or playback.
 *
 * This event is fired when the user barges in (e.g., by speaking during the assistant's
 * response). This is specific to a response and does not pause the bidirectional session.
 *
 * Hook callbacks can use this event to log barge-ins, stop playback, or trigger cleanup.
 */
export class BidiBargeInEvent extends HookableEvent {
  readonly type = 'bidiBargeInEvent' as const
  readonly agent: LocalAgent
  readonly invocationState: InvocationState

  constructor(data: { agent: LocalAgent; invocationState: InvocationState }) {
    super()
    this.agent = data.agent
    this.invocationState = data.invocationState
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<BidiBargeInEvent, 'type'> {
    return { type: this.type }
  }
}

/**
 * Event emitted before the agent restarts the model connection.
 *
 * A restart is triggered either reactively, after the model reports a timeout, or proactively,
 * when the restart timer fires ahead of the provider's limit.
 */
export class BidiBeforeConnectionRestartEvent extends HookableEvent {
  readonly type = 'bidiBeforeConnectionRestartEvent' as const
  readonly agent: LocalAgent
  readonly invocationState: InvocationState

  /** What triggered the restart ('timeout' reactively, 'scheduled' proactively). */
  readonly reason: 'timeout' | 'scheduled'

  /** The model's timeout error on the reactive path; absent when scheduled. */
  readonly timeoutError?: ConnectionTimeoutError

  constructor(data: {
    agent: LocalAgent
    invocationState: InvocationState
    reason: 'timeout' | 'scheduled'
    timeoutError?: ConnectionTimeoutError
  }) {
    super()
    this.agent = data.agent
    this.invocationState = data.invocationState
    this.reason = data.reason
    if (data.timeoutError !== undefined) {
      this.timeoutError = data.timeoutError
    }
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState, and
   * reducing the timeout error to its message.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<BidiBeforeConnectionRestartEvent, 'type' | 'reason'> & { timeoutError?: { message: string } } {
    return {
      type: this.type,
      reason: this.reason,
      ...(this.timeoutError !== undefined && { timeoutError: { message: this.timeoutError.message } }),
    }
  }
}

/**
 * Event emitted after the agent attempts to restart the model connection.
 *
 * Uses reverse callback ordering for proper cleanup semantics.
 */
export class BidiAfterConnectionRestartEvent extends HookableEvent {
  readonly type = 'bidiAfterConnectionRestartEvent' as const
  readonly agent: LocalAgent
  readonly invocationState: InvocationState

  /** What triggered the restart ('timeout' reactively, 'scheduled' proactively). */
  readonly reason: 'timeout' | 'scheduled'

  /** Populated if an error was raised during the restart. Absent means success. */
  readonly error?: Error

  constructor(data: {
    agent: LocalAgent
    invocationState: InvocationState
    reason: 'timeout' | 'scheduled'
    error?: Error
  }) {
    super()
    this.agent = data.agent
    this.invocationState = data.invocationState
    this.reason = data.reason
    if (data.error !== undefined) {
      this.error = data.error
    }
  }

  override _shouldReverseCallbacks(): boolean {
    return true
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState, and
   * reducing the error to its message.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<BidiAfterConnectionRestartEvent, 'type' | 'reason'> & { error?: { message: string } } {
    return {
      type: this.type,
      reason: this.reason,
      ...(this.error !== undefined && { error: { message: this.error.message } }),
    }
  }
}
