import type { Model } from '../model.js'
import type { ModelRouter, RoutingCandidate } from './router.js'
import type { InvocationState } from '../../types/agent.js'
import type { Message, SystemPrompt } from '../../types/messages.js'
import type { ToolSpec } from '../../tools/types.js'

/** A candidate used during an invocation and the outcome of that attempt. */
export interface RoutingAttempt {
  /** The configured candidate instance. */
  readonly candidate: RoutingCandidate
  /** The model or candidate-resolution error, absent when the call succeeded. */
  readonly exception?: Error
}

/** Read-only inputs supplied to a routing strategy. */
export interface RoutingContext {
  /** Fresh copy of the messages for this strategy ask. */
  readonly messages: Message[]
  /** Fresh copy of the system prompt for this strategy ask. */
  readonly systemPrompt?: SystemPrompt
  /** Fresh copy of tool specifications for this strategy ask. */
  readonly toolSpecs: ToolSpec[]
  /** Stable configured candidate instances. */
  readonly candidates: readonly RoutingCandidate[]
  /** Live invocation state, exposed as read-only. */
  readonly invocationState: Readonly<InvocationState>
  /** Chronological attempts made during this invocation. */
  readonly attempts: readonly RoutingAttempt[]
}

/** Chooses a configured routing candidate. */
export interface RoutingStrategy {
  /**
   * Select a candidate from `context.candidates`, or decline with `undefined`.
   *
   * The router asks before the first model call with an empty attempt history, then after unclaimed
   * failures until routing stops. The returned candidate must be the same instance as one in
   * `context.candidates`.
   *
   * Declining the opening selection uses the router's default model. Declining after a failure ends
   * routing and preserves the pending model error. During opening selection, strategy errors, invalid
   * candidates, and candidate-resolution errors propagate. After a model failure, strategy errors and
   * invalid candidates end routing without replacing the pending error.
   *
   * Each failure round may use a candidate once. Returning a candidate already used in the current round
   * ends routing. If a nested candidate cannot resolve after a failure, it consumes its round slot and
   * the strategy is asked again.
   *
   * @param context - Current request and chronological routing history
   * @returns A configured candidate, or `undefined` to decline
   */
  select(context: RoutingContext): Promise<RoutingCandidate | undefined>
}

/** What each {@link ModelRouter} candidate entry accepts. */
export type CandidateInput = Model | ModelRouter | RoutingCandidate
