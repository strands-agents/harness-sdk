/**
 * Sliding window conversation history management.
 *
 * This module provides a sliding window strategy for managing conversation history
 * that preserves tool usage pairs and avoids invalid window states.
 */

import { Message, TextBlock, ToolResultBlock, type ToolResultContent } from '../types/messages.js'
import { DocumentBlock, ImageBlock, VideoBlock } from '../types/media.js'
import type { LocalAgent } from '../types/agent.js'
import { AfterInvocationEvent } from '../hooks/events.js'
import {
  ConversationManager,
  type ProactiveCompressionConfig,
  type ConversationManagerReduceOptions,
} from './conversation-manager.js'
import { isPinned, applyPinFirst } from './compression/pin-message.js'
import { findValidTrimPoint } from './compression/context-compression.js'
import { logger } from '../logging/logger.js'

const PRESERVE_CHARS = 200
// Max plausible marker length, including newlines. Used as the minimum reduction
// a re-truncation would need to produce in order to be worth running.
const MIN_TRUNCATION_GAIN = 50
// Text payloads at or below this length aren't worth truncating: the savings
// would be smaller than the marker itself, and already-truncated output (which
// lands just above `2 * PRESERVE_CHARS`) falls under this threshold so a
// second pass is a natural no-op.
const TRUNCATION_THRESHOLD = 2 * PRESERVE_CHARS + MIN_TRUNCATION_GAIN

/**
 * Build a short textual stand-in for an image block, used when truncating tool
 * results. The placeholder identifies the image format and its source kind
 * (bytes/url/s3) so the model can reason about what was dropped. For inline
 * bytes the size is included; URL and S3 sources only report the kind since
 * their byte count isn't known locally.
 */
function imagePlaceholder(image: ImageBlock): string {
  const source = image.source
  if (source.type === 'imageSourceBytes') {
    return `[image: ${image.format}, source: bytes, ${source.bytes.byteLength} bytes]`
  }
  if (source.type === 'imageSourceUrl') {
    return `[image: ${image.format}, source: url]`
  }
  return `[image: ${image.format}, source: s3]`
}

/**
 * Build a short textual stand-in for a video block. Binary payloads can't be
 * partially inspected, so videos are replaced wholesale. The placeholder
 * reports format and source kind; byte count is included for inline bytes.
 */
function videoPlaceholder(video: VideoBlock): string {
  const source = video.source
  if (source.type === 'videoSourceBytes') {
    return `[video: ${video.format}, source: bytes, ${source.bytes.byteLength} bytes]`
  }
  return `[video: ${video.format}, source: s3]`
}

/**
 * Build a short textual stand-in for a document block with a binary or remote
 * source. Text-based document sources (text / content) are truncated in place
 * instead of replaced, so this is only called for bytes / s3.
 */
function documentPlaceholder(doc: DocumentBlock): string {
  const source = doc.source
  if (source.type === 'documentSourceBytes') {
    return `[document: ${doc.name}, ${doc.format}, source: bytes, ${source.bytes.byteLength} bytes]`
  }
  return `[document: ${doc.name}, ${doc.format}, source: s3]`
}

/**
 * Build a short textual stand-in for a JSON block. The serialized length is
 * reported so the model knows how much was dropped; truncating JSON
 * mid-structure would produce invalid output, so the whole block is replaced.
 */
function jsonPlaceholder(serializedLength: number): string {
  return `[json: ${serializedLength} chars]`
}

/**
 * Configuration for the sliding window conversation manager.
 */
export type SlidingWindowConversationManagerConfig = {
  /**
   * Maximum number of messages to keep in the conversation history.
   * Defaults to 40 messages.
   */
  windowSize?: number

  /**
   * Whether to truncate tool results when a message is too large for the model's context window.
   * Defaults to true.
   */
  shouldTruncateResults?: boolean

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
   * Pinned messages are protected from eviction during context reduction.
   */
  pinFirst?: number
}

/**
 * Implements a sliding window strategy for managing conversation history.
 *
 * This class handles the logic of maintaining a conversation window that preserves
 * tool usage pairs and avoids invalid window states. When the message count exceeds
 * the window size, it will either truncate large tool results or remove the oldest
 * messages while ensuring tool use/result pairs remain valid.
 *
 * Registers hooks for:
 * - AfterInvocationEvent: Applies sliding window management after each invocation
 * - AfterModelCallEvent: Reduces context on overflow errors and requests retry (via super)
 * - BeforeModelCallEvent: Proactive compression when threshold is exceeded (via super)
 */
export class SlidingWindowConversationManager extends ConversationManager {
  private readonly _windowSize: number
  private readonly _shouldTruncateResults: boolean
  private readonly _pinFirst: number | undefined
  private _pinFirstApplied = false

  /**
   * Unique identifier for this conversation manager.
   */
  readonly name = 'strands:sliding-window-conversation-manager'

  /**
   * Initialize the sliding window conversation manager.
   *
   * @param config - Configuration options for the sliding window manager.
   */
  constructor(config?: SlidingWindowConversationManagerConfig) {
    super(config)
    this._windowSize = config?.windowSize ?? 40
    this._shouldTruncateResults = config?.shouldTruncateResults ?? true
    this._pinFirst = config?.pinFirst != null ? Math.max(0, config.pinFirst) : undefined
  }

  /**
   * Initialize the plugin by registering hooks with the agent.
   *
   * Registers:
   * - AfterInvocationEvent callback to apply sliding window management
   * - AfterModelCallEvent callback to handle context overflow and request retry (via super)
   * - BeforeModelCallEvent callback for proactive compression (via super)
   *
   * @param agent - The agent to register hooks with
   */
  public override initAgent(agent: LocalAgent): void {
    super.initAgent(agent)

    agent.addHook(AfterInvocationEvent, (event) => {
      this._applyManagement(event.agent.messages)
    })
  }

  /**
   * Reduce the conversation history.
   *
   * When `error` is set (reactive overflow recovery), attempts to truncate large tool results
   * first before falling back to message trimming.
   *
   * When `error` is undefined (proactive compression), only trims messages without attempting
   * tool result truncation.
   *
   * @param options - The reduction options
   * @returns `true` if the history was reduced, `false` otherwise
   */
  reduce({ agent, error }: ConversationManagerReduceOptions): boolean {
    return this._reduceContext(agent.messages, error)
  }

  /**
   * Apply the sliding window to the messages array to maintain a manageable history size.
   *
   * Called after every agent invocation. No-op if within the window size.
   *
   * @param messages - The message array to manage. Modified in-place.
   */
  private _applyManagement(messages: Message[]): void {
    if (messages.length <= this._windowSize) {
      return
    }

    this._reduceContext(messages, undefined)
  }

  /**
   * Trim the oldest messages to reduce the conversation context size.
   *
   * The method handles special cases where trimming the messages leads to:
   * - toolResult with no corresponding toolUse
   * - toolUse with no corresponding toolResult
   *
   * The strategy is:
   * 1. First, attempt to truncate large tool results if shouldTruncateResults is true
   * 2. If truncation is not possible or doesn't help, trim oldest messages
   * 3. When trimming, skip invalid trim points (toolResult at start, or toolUse without following toolResult)
   *
   * @param messages - The message array to reduce. Modified in-place.
   * @param _error - The error that triggered the context reduction, if any.
   * @returns `true` if any reduction occurred, `false` otherwise.
   */
  private _reduceContext(messages: Message[], _error?: Error): boolean {
    // Pin first N messages permanently (only on first reduction)
    if (this._pinFirst && !this._pinFirstApplied) {
      applyPinFirst(messages, this._pinFirst)
      this._pinFirstApplied = true
    }

    // Only truncate tool results when handling a context overflow error, not for window size enforcement
    const oldestMessageIdxWithToolResults = this._findOldestMessageWithToolResults(messages)
    if (_error && oldestMessageIdxWithToolResults !== undefined && this._shouldTruncateResults) {
      const resultsTruncated = this._truncateToolResults(messages, oldestMessageIdxWithToolResults)
      if (resultsTruncated) {
        return true
      }
    }

    // Try to trim messages when tool result cannot be truncated anymore
    // If the number of messages is less than the window_size, then we default to 2, otherwise, trim to window size
    const startIndex = messages.length <= this._windowSize ? 2 : messages.length - this._windowSize
    let trimIndex = findValidTrimPoint(messages, startIndex)
    let fallbackUserIndex: number | undefined

    if (trimIndex === messages.length && this._windowSize > 0) {
      const toolPairTrimIndex = this._findToolPairTrimPoint(messages, startIndex)
      if (toolPairTrimIndex !== undefined) {
        fallbackUserIndex = this._findToolPairUserAnchor(messages, toolPairTrimIndex)
        if (fallbackUserIndex !== undefined) {
          logger.debug(
            `window_size=<${this._windowSize}>, trim_index=<${toolPairTrimIndex}>, user_anchor_index=<${fallbackUserIndex}> | no plain user trim point, falling back to complete tool pair`
          )
          trimIndex = toolPairTrimIndex
        } else {
          logger.debug(
            `window_size=<${this._windowSize}>, trim_index=<${toolPairTrimIndex}> | complete tool pair found but no valid user anchor, declining fallback`
          )
          return false
        }
      }
    }

    // If no valid trim point was found, return false and let the caller handle it.
    // When windowSize is 0, trimIndex === messages.length is expected (remove all), so allow it through.
    if (trimIndex > messages.length || (trimIndex === messages.length && this._windowSize > 0)) {
      logger.warn(
        `window_size=<${this._windowSize}>, messages=<${messages.length}> | unable to trim conversation context, no valid trim point found`
      )
      return false
    }

    // Collect non-pinned indices in [0, trimIndex) to remove
    const indicesToRemove: number[] = []
    for (let i = 0; i < trimIndex; i++) {
      if (i === fallbackUserIndex || isPinned(messages, i)) continue
      indicesToRemove.push(i)
    }

    if (indicesToRemove.length === 0) {
      logger.warn(
        `window_size=<${this._windowSize}>, messages=<${messages.length}> | all messages in trim range are protected, unable to reduce`
      )
      return false
    }

    // Remove in reverse order to keep indices stable
    for (let i = indicesToRemove.length - 1; i >= 0; i--) {
      messages.splice(indicesToRemove[i]!, 1)
    }
    return true
  }

  /**
   * Apply head/tail truncation to a string if it exceeds the size threshold.
   *
   * Returns the truncated form (first {@link PRESERVE_CHARS} + marker + last
   * {@link PRESERVE_CHARS}) when the input exceeds {@link TRUNCATION_THRESHOLD},
   * otherwise `undefined`.
   */
  private _truncateLongText(text: string): string | undefined {
    if (text.length <= TRUNCATION_THRESHOLD) {
      return undefined
    }
    const prefix = text.slice(0, PRESERVE_CHARS)
    const suffix = text.slice(-PRESERVE_CHARS)
    const removed = text.length - 2 * PRESERVE_CHARS
    return `${prefix}\n<truncated chars="${removed}"/>\n${suffix}`
  }

  /**
   * Truncate tool result content in a message to reduce context size.
   *
   * Rule: preserve head/tail when the payload is plain-text-shaped; replace
   * wholesale when it's binary or remote. Specifically:
   * - Text blocks: partial head/tail truncation if over threshold.
   * - Image, Video blocks: wholesale replacement with a textual placeholder.
   * - Document blocks with bytes/s3 source: wholesale replacement.
   * - Document blocks with text source: partial truncation of the inner text.
   * - Document blocks with content source (TextBlock[]): partial truncation of
   *   each nested block.
   * - JSON blocks: wholesale replacement if serialized length is over threshold;
   *   mid-structure truncation would produce invalid JSON.
   *
   * The tool result `status` and `error` fields are preserved.
   *
   * @param messages - The conversation message history.
   * @param msgIdx - Index of the message containing tool results to truncate.
   * @returns True if any changes were made to the message, false otherwise.
   */
  private _truncateToolResults(messages: Message[], msgIdx: number): boolean {
    if (msgIdx >= messages.length || msgIdx < 0) {
      return false
    }

    const message = messages[msgIdx]
    if (!message) {
      return false
    }

    let changesMade = false
    const newContent = message.content.map((block) => {
      if (block.type !== 'toolResultBlock') {
        return block
      }

      const toolResultBlock = block as ToolResultBlock
      const newItems: ToolResultContent[] = []
      let itemChanged = false

      for (const item of toolResultBlock.content) {
        if (item.type === 'imageBlock') {
          newItems.push(new TextBlock(imagePlaceholder(item)))
          itemChanged = true
          continue
        }

        if (item.type === 'videoBlock') {
          newItems.push(new TextBlock(videoPlaceholder(item)))
          itemChanged = true
          continue
        }

        if (item.type === 'documentBlock') {
          const source = item.source
          if (source.type === 'documentSourceBytes' || source.type === 'documentSourceS3Location') {
            newItems.push(new TextBlock(documentPlaceholder(item)))
            itemChanged = true
            continue
          }
          if (source.type === 'documentSourceText') {
            const truncated = this._truncateLongText(source.text)
            if (truncated !== undefined) {
              newItems.push(
                new DocumentBlock({
                  name: item.name,
                  format: item.format,
                  source: { text: truncated },
                  ...(item.citations !== undefined ? { citations: item.citations } : {}),
                  ...(item.context !== undefined ? { context: item.context } : {}),
                })
              )
              itemChanged = true
              continue
            }
          }
          if (source.type === 'documentSourceContentBlock') {
            let nestedChanged = false
            const newContentBlocks = source.content.map((nested) => {
              const truncated = this._truncateLongText(nested.text)
              if (truncated !== undefined) {
                nestedChanged = true
                return new TextBlock(truncated)
              }
              return nested
            })
            if (nestedChanged) {
              newItems.push(
                new DocumentBlock({
                  name: item.name,
                  format: item.format,
                  source: { content: newContentBlocks },
                  ...(item.citations !== undefined ? { citations: item.citations } : {}),
                  ...(item.context !== undefined ? { context: item.context } : {}),
                })
              )
              itemChanged = true
              continue
            }
          }
          newItems.push(item)
          continue
        }

        if (item.type === 'jsonBlock') {
          const serializedLength = JSON.stringify(item.json).length
          if (serializedLength > TRUNCATION_THRESHOLD) {
            newItems.push(new TextBlock(jsonPlaceholder(serializedLength)))
            itemChanged = true
            continue
          }
          newItems.push(item)
          continue
        }

        if (item.type === 'textBlock') {
          const truncated = this._truncateLongText(item.text)
          if (truncated !== undefined) {
            newItems.push(new TextBlock(truncated))
            itemChanged = true
            continue
          }
        }

        newItems.push(item)
      }

      if (!itemChanged) {
        return block
      }

      changesMade = true
      return new ToolResultBlock({
        toolUseId: toolResultBlock.toolUseId,
        status: toolResultBlock.status,
        content: newItems,
        ...(toolResultBlock.error !== undefined ? { error: toolResultBlock.error } : {}),
      })
    })

    if (!changesMade) {
      return false
    }

    messages[msgIdx] = new Message({
      role: message.role,
      content: newContent,
      // Preserve the durable tracking id: this message stays in history, only its content is truncated.
      trackingId: message.trackingId,
    })

    return true
  }

  /**
   * Find the first complete tool use/result pair at or after the starting index.
   *
   * @param messages - The conversation message history.
   * @param startIndex - The index to begin searching from.
   * @returns The assistant message index that starts the pair, or undefined if none exists.
   */
  private _findToolPairTrimPoint(messages: Message[], startIndex: number): number | undefined {
    for (let index = startIndex; index < messages.length; index++) {
      const message = messages[index]
      if (!message) break
      const nextMessage = messages[index + 1]
      const hasToolUse = message.role === 'assistant' && message.content.some((block) => block.type === 'toolUseBlock')
      const hasFollowingToolResult =
        nextMessage?.role === 'user' && nextMessage.content.some((block) => block.type === 'toolResultBlock')

      if (hasToolUse && hasFollowingToolResult) {
        return index
      }
    }

    return undefined
  }

  /**
   * Find a user message that can remain immediately before a fallback tool pair.
   *
   * Pinned messages must already form a user-first alternating prefix that ends
   * with a user message. Without a pinned prefix, the most recent plain user
   * message before the tool pair is retained as the conversation anchor.
   *
   * This deliberately differs from Python's `_find_tool_pair_trim_point`, which
   * trims directly to the assistant tool-use boundary. TypeScript retains a
   * validated user anchor to preserve a user-first, legally alternating history
   * for providers that require it (see #2085 and #2087).
   *
   * @param messages - The conversation message history.
   * @param toolPairIndex - The assistant message index that starts the fallback pair.
   * @returns The user message index to preserve, or undefined when fallback would produce an invalid prefix.
   */
  private _findToolPairUserAnchor(messages: Message[], toolPairIndex: number): number | undefined {
    const pinnedIndices: number[] = []
    for (let index = 0; index < toolPairIndex; index++) {
      if (isPinned(messages, index)) {
        pinnedIndices.push(index)
      }
    }

    if (pinnedIndices.length > 0) {
      const pinnedMessages = pinnedIndices.map((index) => messages[index]!)
      if (
        pinnedMessages[0]?.role !== 'user' ||
        pinnedMessages[0].content.some((block) => block.type === 'toolResultBlock')
      ) {
        return undefined
      }

      for (let index = 1; index < pinnedMessages.length; index++) {
        if (pinnedMessages[index]!.role === pinnedMessages[index - 1]!.role) {
          return undefined
        }
      }

      const lastPinnedIndex = pinnedIndices[pinnedIndices.length - 1]!
      const lastPinnedMessage = messages[lastPinnedIndex]!
      if (
        lastPinnedMessage.role !== 'user' ||
        lastPinnedMessage.content.some((block) => block.type === 'toolUseBlock')
      ) {
        return undefined
      }
      return lastPinnedIndex
    }

    for (let index = toolPairIndex - 1; index >= 0; index--) {
      const message = messages[index]
      if (!message || message.role !== 'user') continue
      const hasToolContent = message.content.some(
        (block) => block.type === 'toolUseBlock' || block.type === 'toolResultBlock'
      )
      if (!hasToolContent) return index
    }

    return undefined
  }

  /**
   * Find the index of the oldest message containing tool results.
   *
   * Truncation targets the least-recent tool result first so the most relevant
   * recent context is preserved as long as possible.
   *
   * @param messages - The conversation message history.
   * @returns Index of the oldest message with tool results, or undefined if no such message exists.
   */
  private _findOldestMessageWithToolResults(messages: Message[]): number | undefined {
    for (let idx = 0; idx < messages.length; idx++) {
      if (isPinned(messages, idx)) continue

      const hasToolResult = messages[idx]!.content.some((block) => block.type === 'toolResultBlock')
      if (hasToolResult) {
        return idx
      }
    }

    return undefined
  }
}
