/**
 * Abstract base class for model-retry strategies.
 */

import { AfterModelCallEvent } from '../hooks/events.js'
import type { Plugin } from '../plugins/plugin.js'
import type { LocalAgent } from '../types/agent.js'
import type { RetryDecision } from './retry-strategy.js'

/**
 * Abstract base class for model-retry strategies.
 *
 * A {@link ModelRetryStrategy} is a {@link Plugin} that retries failed model
 * calls. Subclasses implement {@link computeRetryDecision} to answer *whether* to retry
 * and *how long* to wait; the base class orchestrates the rest:
 *
 * 1. Short-circuits if another hook already set `event.retry` (no stacked delay).
 * 2. Short-circuits on success events (`event.error === undefined`).
 * 3. Calls {@link onFirstModelAttempt} when a fresh retry budget starts
 *    (`event.attemptCount === 1`), letting stateful subclasses clear per-budget state.
 * 4. Invokes {@link computeRetryDecision}; on `retry: true`, sleeps for `waitMs` then
 *    sets `event.retry = true`.
 *
 * Other retry kinds (e.g. tool retries) will land as *sibling* abstract
 * classes, not as additional methods on this one — different retry kinds
 * have different unit-of-work boundaries and don't share a single state
 * contract.
 *
 * Single-agent attachment: instances typically carry per-budget state, so
 * sharing one instance across agents would let their calls trample each
 * other. The base class throws on attempts to attach to a different agent.
 */
export abstract class ModelRetryStrategy implements Plugin {
  /**
   * A stable string identifier for this retry strategy.
   */
  abstract readonly name: string

  private _attachedAgent: LocalAgent | undefined

  /**
   * Decide whether to retry the failed model call, and how long to wait first.
   *
   * Called only for error events that have not already been marked for retry
   * by another hook. The base class has already filtered out successes and
   * short-circuited events where `event.retry` is true, so implementations
   * only need to reason about `event.error`.
   *
   * Return `{ retry: false }` to let the error propagate. Return
   * `{ retry: true, waitMs }` to retry after sleeping for `waitMs`
   * milliseconds.
   */
  protected abstract computeRetryDecision(event: AfterModelCallEvent): RetryDecision | Promise<RetryDecision>

  /**
   * Called when `event.attemptCount === 1`, at the start of a fresh retry budget. This occurs on a new
   * turn and when model routing switches candidates. Subclasses with per-budget state override this to
   * clear it; the default is a no-op.
   */
  protected onFirstModelAttempt(): void {}

  /**
   * @internal
   * Hook callback invoked by the agent on every {@link AfterModelCallEvent}.
   * Subclasses should override {@link computeRetryDecision} or
   * {@link onFirstModelAttempt} instead of this method.
   */
  async retryModel(event: AfterModelCallEvent): Promise<void> {
    // Reset per-budget state before any short-circuit, including when another hook already requested
    // retry on the first attempt.
    if (event.attemptCount === 1) this.onFirstModelAttempt()

    if (event.retry) return
    if (event.error === undefined) return

    const decision = await this.computeRetryDecision(event)
    if (!decision.retry) return

    await sleep(decision.waitMs)
    event.retry = true
  }

  /**
   * Initialize the retry strategy with the agent instance.
   *
   * Enforces the single-agent attachment guard and registers the
   * {@link AfterModelCallEvent} hook that drives retry orchestration.
   *
   * Subclasses that override this method MUST call `super.initAgent(agent)`
   * to preserve the attachment guard and hook registration. Additional
   * hooks may be registered after the `super` call.
   *
   * @param agent - The agent to register hooks with
   */
  initAgent(agent: LocalAgent): void {
    if (this._attachedAgent !== undefined && this._attachedAgent !== agent) {
      throw new Error(
        `${this.constructor.name}: instance is already attached to another agent. ` +
          'Create a separate instance per agent.'
      )
    }
    this._attachedAgent = agent

    agent.addHook(AfterModelCallEvent, (event) => this.retryModel(event))
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}
