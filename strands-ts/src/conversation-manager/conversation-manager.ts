/**
 * Abstract base class for conversation history management.
 *
 * This module defines the ConversationManager abstraction, which provides a
 * domain-specific interface for managing an agent's conversation context.
 */

import type { Plugin } from '../plugins/plugin.js'
import type { LocalAgent } from '../types/agent.js'
import { AfterModelCallEvent, BeforeModelCallEvent } from '../hooks/events.js'
import { ContextWindowOverflowError } from '../errors.js'
import type { Model } from '../models/model.js'
import { logger } from '../logging/logger.js'

/** Default compression threshold ratio. */
const DEFAULT_COMPRESSION_THRESHOLD = 0.7

/**
 * Options passed to {@link ConversationManager.reduce}.
 *
 * When `error` is set, this is a reactive overflow recovery call — the implementation
 * MUST remove enough history for the next model call to succeed.
 *
 * When `error` is undefined, this is a proactive compression call — best-effort reduction
 * to avoid hitting the context window limit.
 */
export type ConversationManagerReduceOptions = {
  /**
   * The agent instance. Mutate `agent.messages` in place to reduce history.
   */
  agent: LocalAgent

  /**
   * The model instance. Used by conversation managers that perform model-based
   * reduction (e.g. summarization).
   */
  model: Model

  /**
   * The {@link ContextWindowOverflowError} that triggered this call, or `undefined`
   * for proactive compression calls.
   *
   * When set, `reduce` MUST remove enough history for the next model call to succeed,
   * or this error will propagate out of the agent loop uncaught.
   *
   * When undefined, `reduce` is best-effort — errors are swallowed and the model call
   * proceeds regardless.
   */
  error?: ContextWindowOverflowError
}

/**
 * Configuration for proactive compression when passed as an object.
 */
export type ProactiveCompressionConfig = {
  /**
   * Ratio of context window usage that triggers proactive compression.
   * Value between 0 (exclusive) and 1 (inclusive).
   * Defaults to 0.7 (compress when 70% of the context window is used).
   */
  compressionThreshold: number
}

/**
 * Configuration options for the ConversationManager base class.
 */
export type ConversationManagerOptions = {
  /**
   * Enable proactive context compression before the model call.
   *
   * - `true`: compress when 70% of the context window is used (default threshold).
   * - `{ compressionThreshold: number }`: compress at the specified ratio (0, 1].
   * - `false` or omitted: disabled, only reactive overflow recovery is used.
   */
  proactiveCompression?: boolean | ProactiveCompressionConfig
}

/**
 * Abstract base class for conversation history management strategies.
 *
 * The primary responsibility of a ConversationManager is overflow recovery: when the
 * model returns a {@link ContextWindowOverflowError}, {@link ConversationManager.reduce}
 * is called with `error` set and MUST reduce the history enough for the next model call
 * to succeed. If `reduce` returns `false` (no reduction performed), the error propagates
 * out of the agent loop uncaught. This makes `reduce` a critical operation —
 * implementations must be able to make meaningful progress when called with `error` set.
 *
 * Subclasses can enable proactive compression by passing `proactiveCompression` in the
 * options object to the base constructor. When enabled, the base class registers a
 * `BeforeModelCallEvent` hook that checks projected input tokens against the model's
 * context window limit and calls `reduce` (without `error`) when the threshold is exceeded.
 *
 * @deprecated Use {@link ContextManager} instead. ContextManager will become the default in v2; ConversationManager will be removed.
 *
 * @example
 * ```typescript
 * class Last10MessagesManager extends ConversationManager {
 *   readonly name = 'my:last-10-messages'
 *
 *   reduce({ agent }: ReduceOptions): boolean {
 *     if (agent.messages.length <= 10) return false
 *     agent.messages.splice(0, agent.messages.length - 10)
 *     return true
 *   }
 * }
 * ```
 */
export abstract class ConversationManager implements Plugin {
  /**
   * A stable string identifier for this conversation manager.
   */
  abstract readonly name: string

  protected readonly _compressionThreshold: number | undefined

  /**
   * @param options - Configuration options for the conversation manager.
   */
  constructor(options?: ConversationManagerOptions) {
    const proactiveCompression = options?.proactiveCompression
    const threshold =
      proactiveCompression === true
        ? DEFAULT_COMPRESSION_THRESHOLD
        : proactiveCompression
          ? proactiveCompression.compressionThreshold
          : undefined

    if (threshold !== undefined && (threshold <= 0 || threshold > 1)) {
      throw new Error(`compressionThreshold must be between 0 (exclusive) and 1 (inclusive), got ${threshold}`)
    }
    this._compressionThreshold = threshold
  }

  /**
   * Reduce the conversation history.
   *
   * Called in two scenarios:
   * 1. **Reactive** (error set): A {@link ContextWindowOverflowError} occurred. The implementation
   *    MUST remove enough history for the next model call to succeed. Returning `false` means no
   *    reduction was possible, and the error will propagate out of the agent loop.
   * 2. **Proactive** (error undefined): The compression threshold was exceeded. This is best-effort —
   *    returning `false` or throwing is acceptable; the model call proceeds regardless.
   *
   * Implementations should mutate `agent.messages` in place and return `true` if any reduction
   * was performed, `false` otherwise.
   *
   * @param options - The reduction options
   * @returns `true` if the history was reduced, `false` otherwise.
   *   May return a `Promise` for implementations that need async I/O (e.g. model calls).
   */
  abstract reduce(options: ConversationManagerReduceOptions): boolean | Promise<boolean>

  /**
   * Initialize the conversation manager with the agent instance.
   *
   * Registers two hooks:
   * 1. `AfterModelCallEvent`: Overflow recovery — when a {@link ContextWindowOverflowError} occurs,
   *    calls {@link ConversationManager.reduce} with `error` set and retries if reduction succeeded.
   * 2. `BeforeModelCallEvent`: Proactive compression — when projected input tokens exceed the
   *    configured compression threshold, calls {@link ConversationManager.reduce} without `error`.
   *    The hook is always registered but only acts when proactive compression is enabled.
   *
   * Subclasses that override `initAgent` MUST call `super.initAgent(agent)` to
   * preserve overflow recovery and proactive compression behavior.
   *
   * @param agent - The agent to register hooks with
   */
  initAgent(agent: LocalAgent): void {
    // Reactive overflow recovery
    agent.addHook(AfterModelCallEvent, async (event) => {
      if (event.error instanceof ContextWindowOverflowError) {
        if (await this.reduce({ agent: event.agent, model: event.model, error: event.error })) {
          event.retry = true
        }
      }
    })

    // Proactive compression — always subscribe, check threshold in the handler
    agent.addHook(BeforeModelCallEvent, async (event) => {
      if (this._compressionThreshold === undefined) {
        return
      }

      if (event.projectedInputTokens === undefined) {
        return
      }

      const ratio = event.model.estimateUtilization(event.projectedInputTokens)
      if (ratio >= this._compressionThreshold) {
        logger.debug(
          `projected_tokens=<${event.projectedInputTokens}>, ratio=<${ratio.toFixed(2)}>, compression_threshold=<${this._compressionThreshold}> | compression threshold exceeded, reducing context`
        )
        // Proactive compression is best-effort: swallow errors so the model call can still proceed.
        try {
          await this.reduce({ agent: event.agent, model: event.model })
        } catch (e) {
          logger.warn(`conversation_manager=<${this.name}> | proactive compression failed, continuing | error=<${e}>`)
        }
      }
    })
  }
}
