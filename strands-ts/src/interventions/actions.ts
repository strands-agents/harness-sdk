import type {
  BeforeInvocationEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  BeforeModelCallEvent,
  AfterModelCallEvent,
} from '../hooks/events.js'
import type { JSONValue } from '../types/json.js'

const APPROVED_RESPONSES = new Set(['y', 'yes'])

/**
 * Default evaluate function for the confirm action.
 * Accepts: true, 'y'/'yes' (case-insensitive, whitespace-trimmed).
 *
 * @param response - The human's response value to evaluate.
 * @returns true if the response is considered an approval, false otherwise.
 */
export function defaultEvaluate(response: JSONValue): boolean {
  if (response === true) return true
  if (typeof response === 'string') return APPROVED_RESPONSES.has(response.toLowerCase().trim())
  return false
}

export type LifecycleEvent =
  BeforeInvocationEvent | BeforeToolCallEvent | AfterToolCallEvent | BeforeModelCallEvent | AfterModelCallEvent

/**
 * Allow the operation to continue unchanged.
 *
 * @param reason - Optional metadata for debugging/logging. Not shown to the model.
 *
 * @example
 * ```typescript
 * return { type: 'proceed' }
 * ```
 */
export type Proceed = { type: 'proceed'; reason?: string }

/**
 * Block the operation. On Before* events, sets event.cancel with the reason text.
 * The reason is shown to the model as the cancellation message.
 *
 * @param reason - Why the operation was blocked. Shown to the model.
 *
 * @example
 * ```typescript
 * override beforeToolCall(event: BeforeToolCallEvent): InterventionAction {
 *   if (!this.isAuthorized(event.agent.appState.get('user_id'), event.toolUse.name)) {
 *     return { type: 'deny', reason: 'User not authorized for this tool' }
 *   }
 *   return { type: 'proceed' }
 * }
 * ```
 */
export type Deny = { type: 'deny'; reason: string }

/**
 * Provide feedback to steer behavior. On beforeToolCall/beforeInvocation, sets
 * event.cancel so the model sees the feedback and adjusts. On beforeModelCall,
 * injects feedback as a user message so the model sees it on this call.
 * On afterModelCall, the response is discarded and the model retries with the
 * feedback injected as a user message.
 *
 * @param feedback - The guidance text shown to the model.
 * @param reason - Optional metadata for debugging/logging. Not shown to the model.
 *
 * @example
 * ```typescript
 * override afterModelCall(event: AfterModelCallEvent): InterventionAction {
 *   if (this.isTooVague(event.stopData?.message)) {
 *     return { type: 'guide', feedback: 'Be more specific in your response.' }
 *   }
 *   return { type: 'proceed' }
 * }
 * ```
 */
export type Guide = { type: 'guide'; feedback: string; reason?: string }

/**
 * Request human approval before proceeding. Only supported on beforeToolCall.
 *
 * Two modes depending on whether `response` is provided:
 * - With `response`: passed as a preemptive value to the interrupt system, agent
 *   never pauses. Handlers collect the response themselves (e.g. via readline).
 * - Without `response`: breaks out of the agent loop to pause for external resume.
 *
 * The response is checked against `evaluate` (defaults to accepting `true` or
 * `'y'`/`'yes'` case-insensitive). If denied, sets event.cancel.
 *
 * @example
 * ```typescript
 * // Inline mode (handler collected the response already)
 * const answer = await rl.question(`${prompt} (y/n): `)
 * return confirm(prompt, { response: answer })
 *
 * // Stateless mode (interrupt/resume)
 * return confirm(`Approve ${event.toolUse.name}?`)
 * ```
 */
export type Confirm = {
  type: 'confirm'
  prompt: string
  reason?: string
  response?: JSONValue
  evaluate?: (response: JSONValue) => boolean
}

/**
 * Modify event content in-place. The `apply` function mutates the event before
 * execution proceeds. Later handlers in the pipeline see the transformed content.
 *
 * The handler already has the typed event from its lifecycle method, so `apply`
 * can close over it directly — no cast needed:
 *
 * @param apply - Function that mutates the event. Not shown to the model.
 * @param reason - Optional metadata for debugging/logging. Not shown to the model.
 *
 * @example
 * ```typescript
 * override beforeToolCall(event: BeforeToolCallEvent): InterventionAction {
 *   const redacted = redactPII(event.toolUse.input)
 *   return {
 *     type: 'transform',
 *     apply: () => { event.toolUse.input = redacted },
 *     reason: 'PII redacted from tool input',
 *   }
 * }
 * ```
 */
export type Transform = { type: 'transform'; apply: (event: LifecycleEvent) => void; reason?: string }

/**
 * Union of all intervention actions a handler can return.
 *
 * | Action    | beforeInvocation | beforeToolCall | beforeModelCall | afterToolCall | afterModelCall |
 * |-----------|------------------|----------------|-----------------|---------------|----------------|
 * | Proceed   | —                | —              | —               | —             | —              |
 * | Deny      | cancel           | cancel         | cancel          | —             | —              |
 * | Guide     | cancel+          | cancel+        | inject          | —             | inject + retry |
 * | Confirm   | —                | confirm        | —               | —             | —              |
 * | Transform | apply            | apply          | apply           | apply         | apply          |
 *
 * — = no-op (logged in audit trail, warns at runtime)
 * cancel = sets event.cancel, short-circuits (remaining handlers skipped)
 * cancel+ = sets event.cancel with accumulated feedback from all guiding handlers
 * confirm = uses preemptive response or interrupt, checks with evaluate, sets cancel if denied
 * inject = appends accumulated feedback as a user message so the model sees it on this call
 * inject + retry = appends accumulated feedback and retries so the model sees guidance
 * apply = calls action.apply(event) for in-place mutation, later handlers see the change
 */
export type InterventionAction = Proceed | Deny | Guide | Confirm | Transform

/**
 * Allow the operation to continue.
 * @param options - Options: reason (debug metadata).
 */
export function proceed(options?: { reason?: string }): Proceed {
  return { type: 'proceed', ...options }
}

/**
 * Block the operation.
 * @param reason - Why the operation was blocked. Shown to the model.
 */
export function deny(reason: string): Deny {
  return { type: 'deny', reason }
}

/**
 * Provide feedback to steer behavior.
 * @param feedback - The guidance text shown to the model.
 * @param options - Options: reason (debug metadata).
 */
export function guide(feedback: string, options?: { reason?: string }): Guide {
  return { type: 'guide', feedback, ...options }
}

/**
 * Request human approval.
 * @param prompt - Message shown to the human. Not shown to the model.
 * @param options - Options: reason (debug metadata), evaluate (custom response
 * validator, defaults to accepting true or y/yes case-insensitive), response
 * (pre-collected value to skip pausing the agent).
 */
export function confirm(
  prompt: string,
  options?: {
    reason?: string
    response?: JSONValue
    evaluate?: (response: JSONValue) => boolean
  }
): Confirm {
  return { type: 'confirm', prompt, evaluate: defaultEvaluate, ...options }
}

/**
 * Modify event content in-place.
 * @param apply - Function that mutates the event.
 * @param options - Options: reason (debug metadata).
 */
export function transform(apply: (event: LifecycleEvent) => void, options?: { reason?: string }): Transform {
  return { type: 'transform', apply, ...options }
}
