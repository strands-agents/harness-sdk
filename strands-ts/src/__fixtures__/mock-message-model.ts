/**
 * Test message model provider for simplified agent testing.
 * This module provides a content-focused test model that generates appropriate
 * ModelStreamEvents from ContentBlock objects, eliminating the need to manually
 * construct events in tests.
 */

import { Model } from '../models/model.js'
import type { Message, StopReason } from '../types/messages.js'
import type { ModelStreamEvent, Usage } from '../models/streaming.js'
import type { BaseModelConfig, StreamOptions } from '../models/model.js'
import type { PlainContentBlock } from './slim-types.js'

/**
 * Input type for addTurn - accepts plain objects or class instances.
 */
type ContentBlockInput = PlainContentBlock | PlainContentBlock[] | Error

/**
 * Represents a single turn in the test sequence.
 * Can be either content blocks with stopReason, or an Error to throw.
 */
type Turn =
  | { type: 'content'; content: PlainContentBlock[]; stopReason: StopReason; usage?: Usage }
  | { type: 'error'; error: Error }

/**
 * Test model provider that operates at the content block level.
 * Simplifies agent loop tests by allowing specification of content blocks
 * instead of manually yielding individual ModelStreamEvents.
 */
export class MockMessageModel extends Model<BaseModelConfig> {
  private _turns: Turn[]
  private _currentTurnIndex: number
  private _config: BaseModelConfig

  /**
   * Creates a new MockMessageModel.
   */
  constructor() {
    super()
    this._config = { modelId: 'test-model' }
    this._currentTurnIndex = 0
    this._turns = []
  }

  /**
   * The number of turns that have been invoked thus far.
   */
  get callCount(): number {
    return this._currentTurnIndex
  }

  /**
   * Adds a turn to the test sequence.
   * Returns this for method chaining.
   *
   * @param turn - ContentBlock, ContentBlock[], or Error to add
   * @param options - Optional stop reason and token usage
   * @returns This provider for chaining
   *
   * @example
   * ```typescript
   * provider
   *   .addTurn({ type: 'textBlock', text: 'Hello' })  // Single block
   *   .addTurn([{ type: 'toolUseBlock', ... }])  // Array of blocks
   *   .addTurn({ type: 'textBlock', text: 'Done' }, { stopReason: 'maxTokens' })  // Explicit stopReason
   *   .addTurn({ type: 'textBlock', text: 'Hi' }, { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
   *   .addTurn(new Error('Failed'))  // Error turn
   * ```
   */
  addTurn(turn: ContentBlockInput, options?: { stopReason?: StopReason; usage?: Usage }): this {
    this._turns.push(this._createTurn(turn, options?.stopReason, options?.usage))
    return this
  }

  /**
   * Updates the model configuration.
   *
   * @param modelConfig - Configuration to merge with existing config
   */
  updateConfig(modelConfig: BaseModelConfig): void {
    this._config = { ...this._config, ...modelConfig }
  }

  /**
   * Retrieves the current model configuration.
   *
   * @returns Current configuration object
   */
  getConfig(): BaseModelConfig {
    return this._config
  }

  /**
   * Streams a conversation with the model.
   * Generates appropriate ModelStreamEvents from the content blocks.
   *
   * Single-turn behavior: Reuses the same turn indefinitely
   * Multi-turn behavior: Advances through turns and throws when exhausted
   *
   * @param _messages - Conversation messages (ignored by test provider)
   * @param _options - Streaming options (ignored by test provider)
   * @returns Async iterable of ModelStreamEvents
   */
  async *stream(_messages: Message[], _options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    // Determine which turn index to use
    // For single turn, always use 0. For multiple turns, use current index
    const turnIndex = this._turns.length === 1 ? 0 : this._currentTurnIndex

    // Advance turn index immediately for multi-turn scenarios
    // This ensures that the next call to stream() will use the next turn
    if (this._turns.length > 1) {
      this._currentTurnIndex++
    }

    // Check if we've exhausted all turns (after potential increment)
    if (turnIndex >= this._turns.length) {
      throw new Error('All turns have been consumed')
    }

    // Get the current turn
    const turn = this._turns[turnIndex]!

    // Handle error turns
    if (turn.type === 'error') {
      throw turn.error
    }

    // Generate events for content turn
    yield* this._generateEventsForContent(turn.content, turn.stopReason, turn.usage)
  }

  /**
   * Generates appropriate ModelStreamEvents for content blocks.
   * All messages have role 'assistant' since this is for testing model responses.
   */
  private async *_generateEventsForContent(
    content: PlainContentBlock[],
    stopReason: StopReason,
    usage?: Usage
  ): AsyncGenerator<ModelStreamEvent> {
    // Yield message start event (always assistant role)
    yield { type: 'modelMessageStartEvent', role: 'assistant' }

    // Yield events for each content block
    for (let i = 0; i < content.length; i++) {
      const block = content[i]!
      yield* this._generateEventsForBlock(block)
    }

    // Yield message stop event
    yield { type: 'modelMessageStopEvent', stopReason }

    // Yield metadata event with token usage when provided
    if (usage) {
      yield { type: 'modelMetadataEvent', usage }
    }
  }

  /**
   * Creates a Turn object from ContentBlock(s) or Error.
   */
  private _createTurn(turn: ContentBlockInput, explicitStopReason?: StopReason, usage?: Usage): Turn {
    if (turn instanceof Error) {
      return { type: 'error', error: turn }
    }

    // Normalize to array
    const content = Array.isArray(turn) ? turn : [turn]

    return {
      type: 'content',
      content,
      stopReason: explicitStopReason ?? this._deriveStopReason(content),
      ...(usage !== undefined && { usage }),
    }
  }

  /**
   * Auto-derives stopReason from content blocks.
   * Returns 'toolUse' if content contains any ToolUseBlock, otherwise 'endTurn'.
   */
  private _deriveStopReason(content: PlainContentBlock[]): StopReason {
    const hasToolUse = content.some((block) => block.type === 'toolUseBlock')
    return hasToolUse ? 'toolUse' : 'endTurn'
  }

  /**
   * Generates appropriate ModelStreamEvents for a message.
   */
  private async *_generateEventsForMessage(message: Message, stopReason: StopReason): AsyncGenerator<ModelStreamEvent> {
    // Yield message start event
    yield { type: 'modelMessageStartEvent', role: message.role }

    // Yield events for each content block
    for (let i = 0; i < message.content.length; i++) {
      const block = message.content[i]!
      yield* this._generateEventsForBlock(block)
    }

    // Yield message stop event
    yield { type: 'modelMessageStopEvent', stopReason }
  }

  /**
   * Generates appropriate ModelStreamEvents for a content block.
   */
  private async *_generateEventsForBlock(block: PlainContentBlock): AsyncGenerator<ModelStreamEvent> {
    switch (block.type) {
      case 'textBlock':
        yield { type: 'modelContentBlockStartEvent' }
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: block.text },
        }
        yield { type: 'modelContentBlockStopEvent' }
        break

      case 'toolUseBlock':
        yield {
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: block.name, toolUseId: block.toolUseId },
        }
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: JSON.stringify(block.input) },
        }
        yield { type: 'modelContentBlockStopEvent' }
        break

      case 'reasoningBlock': {
        yield { type: 'modelContentBlockStartEvent' }
        // Build delta object with only defined properties
        const delta: {
          type: 'reasoningContentDelta'
          text?: string
          signature?: string
          redactedContent?: Uint8Array
        } = {
          type: 'reasoningContentDelta',
        }
        if (block.text !== undefined) {
          delta.text = block.text
        }
        if (block.signature !== undefined) {
          delta.signature = block.signature
        }
        if (block.redactedContent !== undefined) {
          delta.redactedContent = block.redactedContent
        }
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta,
        }
        yield { type: 'modelContentBlockStopEvent' }
        break
      }

      case 'cachePointBlock':
        // CachePointBlock doesn't generate delta events
        yield { type: 'modelContentBlockStartEvent' }
        yield { type: 'modelContentBlockStopEvent' }
        break

      case 'toolResultBlock':
        // ToolResultBlock appears in user messages and doesn't generate model events
        // This shouldn't normally be in assistant messages, but we'll handle it gracefully
        break

      case 'guardContentBlock':
        // GuardContentBlock is handled by guardrails and doesn't generate model events
        // This is typically used in system prompts or message content for guardrail evaluation
        break

      case 'citationsBlock':
        yield { type: 'modelContentBlockStartEvent' }
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta: {
            type: 'citationsDelta',
            citations: block.citations,
            content: block.content,
          },
        }
        yield { type: 'modelContentBlockStopEvent' }
        break

      case 'imageBlock':
      case 'videoBlock':
      case 'documentBlock':
      case 'audioBlock':
      case 'jsonBlock':
        // These blocks don't generate events in mock - just skip them
        break

      default: {
        // Exhaustive check
        const _exhaustive: never = block
        throw new Error(`Unknown content block type: ${(_exhaustive as PlainContentBlock).type}`)
      }
    }
  }
}
