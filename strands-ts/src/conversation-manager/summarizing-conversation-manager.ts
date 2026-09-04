/**
 * Summarization-based conversation history management.
 *
 * This module provides a conversation manager that summarizes older messages
 * when the context window overflows, preserving important information rather
 * than simply discarding it.
 */

import type { LocalAgent } from '../types/agent.js'
import {
  ConversationManager,
  type ProactiveCompressionConfig,
  type ConversationManagerReduceOptions,
} from './conversation-manager.js'
import { applyPinFirst, partitionPinned } from './compression/pin-message.js'
import {
  adjustSplitPointForToolPairs,
  generateSummary,
  DEFAULT_SUMMARIZATION_PROMPT,
} from './compression/context-compression.js'
import { logger } from '../logging/logger.js'
import { normalizeError } from '../errors.js'
import type { Model } from '../models/model.js'

/**
 * Configuration for the summarization conversation manager.
 */
export type SummarizingConversationManagerConfig = {
  /**
   * Model to use for generating summaries. When provided, overrides the model
   * attached to the agent. Useful when you want to use a different model than
   * the one attached to the agent.
   */
  model?: Model

  /**
   * Ratio of messages to summarize when context overflow occurs.
   * Value is clamped to [0.1, 0.8]. Defaults to 0.3 (summarize 30% of oldest messages).
   */
  summaryRatio?: number

  /**
   * Minimum number of recent messages to always keep.
   * Defaults to 10.
   */
  preserveRecentMessages?: number

  /**
   * Custom system prompt for summarization. If not provided, uses a default
   * prompt that produces structured bullet-point summaries.
   */
  summarizationSystemPrompt?: string

  /**
   * Enable proactive context compression before the model call.
   *
   * - `true`: compress when 70% of the context window is used (default threshold).
   * - `{ compressionThreshold: number }`: compress at the specified ratio (0, 1].
   * - `false` or omitted: disabled, only reactive overflow recovery is used.
   */
  proactiveCompression?: boolean | ProactiveCompressionConfig

  /**
   * Number of messages at the start of the conversation to permanently pin.
   * Pinned messages are protected from summarization and compacted to the front.
   */
  pinFirst?: number
}

/**
 * Implements a summarization strategy for managing conversation history.
 *
 * When a {@link ContextWindowOverflowError} occurs, this manager summarizes
 * the oldest messages using a model call and replaces them with a single
 * summary message, preserving context that would otherwise be lost.
 *
 * @deprecated Use {@link ContextManager} instead. ContextManager will become the default in v2; ConversationManager will be removed.
 */
export class SummarizingConversationManager extends ConversationManager {
  readonly name = 'strands:summarizing-conversation-manager'

  private readonly _model: Model | undefined
  private readonly _summaryRatio: number
  private readonly _preserveRecentMessages: number
  private readonly _summarizationSystemPrompt: string
  private readonly _pinFirst: number | undefined
  private _pinFirstApplied = false

  constructor(config?: SummarizingConversationManagerConfig) {
    super(config)
    this._model = config?.model
    // clamped [0.1, 0.8]
    this._summaryRatio = Math.max(0.1, Math.min(0.8, config?.summaryRatio ?? 0.3))
    this._preserveRecentMessages = config?.preserveRecentMessages ?? 10
    this._summarizationSystemPrompt = config?.summarizationSystemPrompt ?? DEFAULT_SUMMARIZATION_PROMPT
    this._pinFirst = config?.pinFirst != null ? Math.max(0, config.pinFirst) : undefined
  }

  /**
   * Reduce the conversation history by summarizing older messages.
   *
   * When `error` is set (reactive overflow recovery), summarization failure is rethrown
   * with the original error as cause — the agent loop must not proceed with an overflow.
   *
   * When `error` is undefined (proactive compression), summarization failure is logged
   * and returns `false` — the model call proceeds regardless.
   *
   * @param options - The reduction options
   * @returns `true` if the history was reduced, `false` otherwise
   */
  async reduce({ agent, model, error }: ConversationManagerReduceOptions): Promise<boolean> {
    try {
      return await this._summarizeOldest(agent, this._model ?? model)
    } catch (summarizationError) {
      if (error) {
        // Reactive: rethrow so the ContextWindowOverflowError propagates
        logger.error(`error=<${summarizationError}> | summarization failed`)
        const wrapped = normalizeError(summarizationError)
        wrapped.cause = error
        throw wrapped
      }
      // Proactive: best-effort, swallow errors so the model call can still proceed.
      logger.warn(`error=<${summarizationError}> | proactive summarization failed, continuing`)
      return false
    }
  }

  /**
   * Summarize the oldest messages and replace them with a summary.
   *
   * @param agent - The agent instance
   * @param model - The model to use for summarization
   * @returns `true` if the history was reduced, `false` otherwise
   */
  private async _summarizeOldest(agent: LocalAgent, model: Model): Promise<boolean> {
    const messages = agent.messages

    // Calculate how many messages to summarize
    let messagesToSummarizeCount = Math.max(1, Math.floor(messages.length * this._summaryRatio))

    // Don't touch recent messages
    messagesToSummarizeCount = Math.min(messagesToSummarizeCount, messages.length - this._preserveRecentMessages)

    if (messagesToSummarizeCount <= 0) {
      logger.warn(
        `preserve_recent=<${this._preserveRecentMessages}>, messages=<${messages.length}> | insufficient messages for summarization`
      )
      return false
    }

    // Adjust split point to avoid breaking tool use/result pairs
    messagesToSummarizeCount = adjustSplitPointForToolPairs(messages, messagesToSummarizeCount)

    // Pin first N messages permanently (only on first reduction)
    if (this._pinFirst && !this._pinFirstApplied) {
      applyPinFirst(messages, this._pinFirst)
      this._pinFirstApplied = true
    }

    // Partition [0, messagesToSummarizeCount) into pinned (preserve) and non-pinned (summarize)
    const [protectedToPreserve, toSummarize] = partitionPinned(messages, 0, messagesToSummarizeCount)

    if (toSummarize.length === 0) {
      logger.warn(`messages=<${messages.length}> | all messages in summarize range are protected, unable to reduce`)
      return false
    }

    // Generate summary via model call
    const summaryMessage = await generateSummary(toSummarize, model, this._summarizationSystemPrompt)

    // Replace summarized range with protected messages + summary
    messages.splice(0, messagesToSummarizeCount, ...protectedToPreserve, summaryMessage)

    return true
  }
}
