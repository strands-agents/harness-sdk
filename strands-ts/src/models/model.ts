import {
  type ContentBlock,
  Message,
  type MessageMetadata,
  ReasoningBlock,
  type Role,
  type StopReason,
  type SystemPrompt,
  TextBlock,
  ToolUseBlock,
} from '../types/messages.js'
import { CitationsBlock } from '../types/citations.js'
import type { Citation, CitationGeneratedContent } from '../types/citations.js'
import type { StateStore } from '../state-store.js'
import type { ToolChoice, ToolSpec } from '../tools/types.js'
import {
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  ModelMetadataEvent,
  ModelRedactionEvent,
  type ModelStreamEvent,
} from './streaming.js'
import { MaxTokensError, ModelError, normalizeError } from '../errors.js'
import type { Redaction } from '../hooks/events.js'
import { logger } from '../logging/logger.js'
import { DEFAULT_CONTEXT_WINDOW_LIMIT, getContextWindowLimit } from './defaults.js'
import { warnOnce } from '../logging/warn-once.js'

/**
 * Resolves model metadata fields on a config object from built-in lookup tables
 * when not explicitly set. Explicit values pass through unchanged.
 *
 * @internal
 * @param config - The stored model config
 * @param modelId - The model ID to look up
 * @returns A new config with resolved metadata, or the original config if nothing to resolve
 */
export function resolveConfigMetadata<T extends BaseModelConfig>(config: T, modelId: string): T {
  if (config.contextWindowLimit !== undefined) return config
  const limit = getContextWindowLimit(modelId)
  if (limit === undefined) return config
  return { ...config, contextWindowLimit: limit }
}

class CitationAccumulator {
  citations: Citation[] = []
  content: CitationGeneratedContent[] = []

  push(citations: Citation[], content: CitationGeneratedContent[]): void {
    this.citations.push(...citations)
    this.content.push(...content)
  }

  hasData(): boolean {
    return this.citations.length > 0
  }

  reset(): void {
    this.citations = []
    this.content = []
  }
}

/**
 * Configuration for prompt caching.
 */
export interface CacheConfig {
  /**
   * Caching strategy to use.
   * - "auto": Automatically inject cache points at optimal positions based on model ID detection
   *   (after tools, after last user message)
   * - "anthropic": Force enable Anthropic-style caching (useful for application inference profiles)
   */
  strategy: 'auto' | 'anthropic'
}

/**
 * Base configuration interface for all model providers.
 *
 * This interface defines the common configuration properties that all
 * model providers should support. Provider-specific configurations
 * should extend this interface.
 */
export interface BaseModelConfig {
  /**
   * The model identifier.
   * This typically specifies which model to use from the provider's catalog.
   */
  modelId?: string

  /**
   * Maximum number of tokens to generate in the response.
   *
   * @see Provider-specific documentation for exact behavior
   */
  maxTokens?: number

  /**
   * Controls randomness in generation.
   *
   * @see Provider-specific documentation for valid range
   */
  temperature?: number

  /**
   * Controls diversity via nucleus sampling.
   *
   * @see Provider-specific documentation for details
   */
  topP?: number

  /**
   * Maximum context window size in tokens for the model.
   *
   * This value represents the total token capacity shared between input and output.
   * When not provided, it is automatically resolved from a built-in lookup table
   * based on the configured model ID. An explicit value always takes precedence.
   *
   * When `modelId` is changed via `updateConfig()`, this value is automatically
   * re-resolved if it was initially auto-populated. Explicitly set values are preserved.
   */
  contextWindowLimit?: number
}

/**
 * Options interface for configuring streaming model invocation.
 */
export interface StreamOptions {
  /**
   * System prompt to guide the model's behavior.
   * Can be a simple string or an array of content blocks for advanced caching.
   */
  systemPrompt?: SystemPrompt

  /**
   * Array of tool specifications that the model can use.
   */
  toolSpecs?: ToolSpec[]

  /**
   * Controls how the model selects tools to use.
   */
  toolChoice?: ToolChoice

  /**
   * Runtime state for model providers that manage server-side conversation state.
   * The model can read and write this state during streaming (e.g., to store a
   * response ID for conversation chaining). Mutations via `set`/`delete` are
   * visible to the caller after the stream completes.
   */
  modelState?: StateStore
}

/**
 * Options for counting tokens in a set of messages.
 */
export interface CountTokensOptions {
  /**
   * System prompt to guide the model's behavior.
   * Can be a simple string or an array of content blocks for advanced caching.
   */
  systemPrompt?: SystemPrompt

  /**
   * Array of tool specifications to include in the count.
   */
  toolSpecs?: ToolSpec[]
}

/**
 * Result interface for the streamAggregated method.
 * Contains the complete message, stop reason, and optional metadata.
 */
export interface StreamAggregatedResult {
  /**
   * The complete message from the model.
   */
  message: Message

  /**
   * The reason why the model stopped generating.
   */
  stopReason: StopReason

  /**
   * Optional metadata about the model invocation, including usage statistics and metrics.
   */
  metadata?: ModelMetadataEvent

  /**
   * Optional redaction information when guardrails blocked input.
   * Output redaction is handled by updating the message directly.
   */
  redaction?: Redaction
}

/**
 * Base abstract class for model providers.
 * Defines the contract that all model provider implementations must follow.
 *
 * Model providers handle communication with LLM APIs and implement streaming
 * responses using async iterables.
 *
 * @typeParam T - Model configuration type extending BaseModelConfig
 */
export abstract class Model<T extends BaseModelConfig = BaseModelConfig> {
  /**
   * Updates the model configuration.
   * Merges the provided configuration with existing settings.
   *
   * @param modelConfig - Configuration object with model-specific settings to update
   */
  abstract updateConfig(modelConfig: T): void

  /**
   * Retrieves the current model configuration.
   *
   * @returns The current configuration object
   */
  abstract getConfig(): T

  /**
   * The model ID from the current configuration, if configured.
   */
  get modelId(): string | undefined {
    return this.getConfig().modelId
  }

  /**
   * Whether this model manages conversation state server-side.
   *
   * When `true`, the server tracks conversation context across turns, so the SDK
   * sends only the latest message instead of the full history. After each invocation,
   * the agent's local message history is cleared automatically.
   *
   * Model providers that support server-side state management should override this
   * to return `true`.
   *
   * @returns `false` by default
   */
  get stateful(): boolean {
    return false
  }

  /**
   * Streams a conversation with the model.
   * Returns an async iterable that yields streaming events as they occur.
   *
   * @param messages - Array of conversation messages
   * @param options - Optional streaming configuration
   * @returns Async iterable of streaming events
   */
  abstract stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent>

  /**
   * Count tokens for the given input before sending to the model.
   *
   * Used for proactive context management (e.g., triggering compression at a threshold).
   * The base implementation uses a character-based heuristic (chars/4 for text, chars/2 for JSON).
   *
   * Subclasses should override this method to use native token counting APIs
   * (e.g., Bedrock CountTokens, Anthropic countTokens, Gemini countTokens)
   * for improved accuracy, falling back to `super.countTokens()` on API failure.
   *
   * @param messages - Array of conversation messages to count tokens for
   * @param options - Optional options containing system prompt and tool specs
   * @returns Total input token count
   */
  async countTokens(messages: Message[], options?: CountTokensOptions): Promise<number> {
    return estimateTokensHeuristic(messages, options)
  }

  /**
   * Estimate the fraction of the model's context window consumed by the given input token count.
   *
   * Resolves the model's context window limit (falling back to {@link DEFAULT_CONTEXT_WINDOW_LIMIT}
   * with a warning when not configured) and returns `inputTokens / contextWindowLimit`.
   *
   * @param inputTokens - Total input token count (e.g. from a model event's projectedInputTokens)
   * @returns Token usage ratio (0–1+; above 1.0 means overflow)
   */
  estimateUtilization(inputTokens: number): number {
    let contextWindowLimit = this.getConfig().contextWindowLimit
    if (!contextWindowLimit) {
      contextWindowLimit = DEFAULT_CONTEXT_WINDOW_LIMIT
      warnOnce(
        logger,
        `contextWindowLimit is not set on the model, using default of ${DEFAULT_CONTEXT_WINDOW_LIMIT} for utilization estimate | set contextWindowLimit in your model config for accurate results`
      )
    }

    return inputTokens / contextWindowLimit
  }

  /**
   * Converts event data to event class representation
   *
   * @param event_data - Interface representation of event
   * @returns Class representation of event
   */
  private _convert_to_class_event(event_data: ModelStreamEvent): ModelStreamEvent {
    switch (event_data.type) {
      case 'modelMessageStartEvent':
        return new ModelMessageStartEvent(event_data)
      case 'modelContentBlockStartEvent':
        return new ModelContentBlockStartEvent(event_data)
      case 'modelContentBlockDeltaEvent':
        return new ModelContentBlockDeltaEvent(event_data)
      case 'modelContentBlockStopEvent':
        return new ModelContentBlockStopEvent(event_data)
      case 'modelMessageStopEvent':
        return new ModelMessageStopEvent(event_data)
      case 'modelMetadataEvent':
        return new ModelMetadataEvent(event_data)
      case 'modelRedactionEvent':
        return new ModelRedactionEvent(event_data)
      default:
        throw new Error(`Unsupported event type: ${(event_data as { type: string }).type}`)
    }
  }

  /**
   * Streams a conversation with aggregated content blocks and messages.
   * Returns an async generator that yields streaming events and content blocks, and returns the final message with stop reason and optional metadata.
   *
   * This method enhances the basic stream() by collecting streaming events into complete
   * ContentBlock and Message objects, which are needed by the agentic loop for tool execution
   * and conversation management.
   *
   * The method yields:
   * - ModelStreamEvent - Original streaming events (passed through)
   * - ContentBlock - Complete content block (emitted when block completes)
   *
   * The method returns:
   * - StreamAggregatedResult containing the complete message, stop reason, and optional metadata
   *
   * All exceptions thrown from this method are wrapped in ModelError to provide
   * a consistent error type for model-related errors. Specific error subtypes like
   * ContextWindowOverflowError, ModelThrottledError, and MaxTokensError are preserved.
   *
   * @param messages - Array of conversation messages
   * @param options - Optional streaming configuration
   * @returns Async generator yielding ModelStreamEvent | ContentBlock and returning a StreamAggregatedResult
   * @throws ModelError - Base class for all model-related errors
   * @throws ContextWindowOverflowError - When input exceeds the model's context window
   * @throws ModelThrottledError - When the model provider throttles requests
   * @throws MaxTokensError - When the model reaches its maximum token limit
   */
  async *streamAggregated(
    messages: Message[],
    options?: StreamOptions
  ): AsyncGenerator<ModelStreamEvent | ContentBlock, StreamAggregatedResult, undefined> {
    try {
      // State maintained in closure
      let messageRole: Role | null = null
      const contentBlocks: ContentBlock[] = []
      let accumulatedText = ''
      let accumulatedToolInput = ''
      let toolName = ''
      let toolUseId = ''
      let toolReasoningSignature = ''
      let accumulatedReasoning: {
        text?: string
        signature?: string
        redactedContent?: Uint8Array
      } = {}
      const accumulatedCitations = new CitationAccumulator()
      let stoppedMessage: Message | null = null
      let finalStopReason: StopReason | null = null
      let metadata: ModelMetadataEvent | undefined = undefined
      let redactionMessage: string | undefined = undefined
      let toolInputParseError: SyntaxError | undefined = undefined

      for await (const event_data of this.stream(messages, options)) {
        const event = this._convert_to_class_event(event_data)
        yield event // Pass through immediately

        // Aggregation logic based on event type
        switch (event.type) {
          case 'modelMessageStartEvent':
            messageRole = event.role
            contentBlocks.length = 0 // Reset
            break

          case 'modelContentBlockStartEvent':
            if (event.start?.type === 'toolUseStart') {
              toolName = event.start.name
              toolUseId = event.start.toolUseId
              toolReasoningSignature = event.start.reasoningSignature ?? ''
            }
            accumulatedToolInput = ''
            accumulatedText = ''
            accumulatedReasoning = {}
            accumulatedCitations.reset()
            break

          case 'modelContentBlockDeltaEvent': {
            switch (event.delta.type) {
              case 'textDelta':
                accumulatedText += event.delta.text
                break
              case 'toolUseInputDelta':
                accumulatedToolInput += event.delta.input
                break
              case 'reasoningContentDelta':
                if (event.delta.text) accumulatedReasoning.text = (accumulatedReasoning.text ?? '') + event.delta.text
                if (event.delta.signature) accumulatedReasoning.signature = event.delta.signature
                if (event.delta.redactedContent) accumulatedReasoning.redactedContent = event.delta.redactedContent
                break
              case 'citationsDelta':
                accumulatedCitations.push(event.delta.citations, event.delta.content)
                break
            }
            break
          }

          case 'modelContentBlockStopEvent': {
            // Finalize and emit complete ContentBlock
            let block: ContentBlock
            try {
              if (toolUseId) {
                block = new ToolUseBlock({
                  name: toolName,
                  toolUseId: toolUseId,
                  input: accumulatedToolInput ? JSON.parse(accumulatedToolInput) : {},
                  ...(toolReasoningSignature && { reasoningSignature: toolReasoningSignature }),
                })
                toolUseId = '' // Reset
                toolName = ''
                toolReasoningSignature = ''
              } else if (Object.keys(accumulatedReasoning).length > 0) {
                block = new ReasoningBlock({
                  ...accumulatedReasoning,
                })
                accumulatedReasoning = {} // Reset after creating reasoning block
              } else if (accumulatedCitations.hasData()) {
                block = new CitationsBlock({
                  citations: accumulatedCitations.citations,
                  // Providers that stream citations interleaved with the text they ground (Anthropic,
                  // Bedrock) send the generated text as textDeltas and leave the citations delta's
                  // content empty. Without this fallback the citations block wins and the text is
                  // dropped. Mirrors event_loop/streaming.py, which builds content from the
                  // accumulated text.
                  content:
                    accumulatedCitations.content.length > 0
                      ? accumulatedCitations.content
                      : accumulatedText
                        ? [{ text: accumulatedText }]
                        : [],
                })
                accumulatedCitations.reset()
              } else {
                block = new TextBlock(accumulatedText)
              }
              contentBlocks.push(block)
              yield block
            } catch (e: unknown) {
              if (e instanceof SyntaxError) {
                logger.error('unable to parse tool input JSON', e)
                toolInputParseError = e
              }
            }
            break
          }

          case 'modelMessageStopEvent':
            // Store message and stop reason
            if (messageRole) {
              const filtered = contentBlocks.filter(
                (block) => !(block instanceof TextBlock && block.text.trim() === '')
              )
              stoppedMessage = new Message({
                role: messageRole,
                content: filtered,
              })
              finalStopReason = event.stopReason!
            }
            break

          case 'modelMetadataEvent':
            // Store metadata, keeping the last one if multiple events occur
            metadata = event
            break

          case 'modelRedactionEvent':
            // Handle content redaction from guardrails
            if (event.inputRedaction) {
              // Store redaction message for agent to handle input message redaction
              redactionMessage = event.inputRedaction.replaceContent
            }
            if (event.outputRedaction) {
              // Update output message directly with redacted content
              // Redaction event comes after modelMessageStopEvent, so we overwrite stoppedMessage
              stoppedMessage = new Message({
                role: 'assistant',
                content: [new TextBlock(event.outputRedaction.replaceContent)],
              })
            }
            break

          default:
            break
        }
      }

      if (!stoppedMessage || !finalStopReason) {
        // If we exit the loop without completing a message or stop reason, throw an error
        throw new ModelError(
          'Stream ended without completing a message',
          toolInputParseError ? { cause: toolInputParseError } : undefined
        )
      }

      // Attach metadata after redaction so it applies to the final message.
      const messageMetadata: MessageMetadata = {
        ...(metadata?.usage !== undefined && { usage: metadata.usage }),
        ...(metadata?.metrics !== undefined && { metrics: metadata.metrics }),
      }
      if (Object.keys(messageMetadata).length > 0) {
        stoppedMessage = new Message({
          role: stoppedMessage.role,
          content: stoppedMessage.content,
          metadata: messageMetadata,
        })
      }

      // Handle stop reason
      if (finalStopReason === 'maxTokens') {
        throw new MaxTokensError(
          'Model reached maximum token limit. This is an unrecoverable state that requires intervention.',
          stoppedMessage
        )
      }

      if (toolInputParseError !== undefined) {
        throw new ModelError('unable to parse tool input JSON', { cause: toolInputParseError })
      }

      // Return the final message with stop reason and optional metadata
      const result: StreamAggregatedResult = {
        message: stoppedMessage,
        stopReason: finalStopReason,
      }
      if (metadata !== undefined) {
        result.metadata = metadata
      }
      if (redactionMessage !== undefined) {
        result.redaction = { userMessage: redactionMessage }
      }
      return result
    } catch (error) {
      // Wrap non-ModelError errors in ModelError
      if (error instanceof ModelError) {
        throw error
      }
      const normalizedError = normalizeError(error)
      throw new ModelError(normalizedError.message, { cause: error })
    }
  }
}

/**
 * Estimate tokens for a content block using character-based heuristics.
 *
 * @param block - Content block to estimate tokens for
 * @returns Estimated token count
 */
function estimateContentBlockTokens(block: ContentBlock): number {
  let total = 0

  switch (block.type) {
    case 'textBlock':
      total += heuristicText(block.text)
      break
    case 'toolUseBlock':
      total += heuristicText(block.name)
      total += heuristicJson(block.input)
      break
    case 'toolResultBlock':
      for (const item of block.content) {
        if (item.type === 'textBlock') {
          total += heuristicText(item.text)
        } else if (item.type === 'jsonBlock') {
          total += heuristicJson(item.json)
        }
      }
      break
    case 'reasoningBlock':
      if (block.text) total += heuristicText(block.text)
      break
    case 'guardContentBlock':
      if (block.text) total += heuristicText(block.text.text)
      break
    case 'citationsBlock':
      for (const item of block.content) {
        if ('text' in item) total += heuristicText(item.text)
      }
      break
    default:
      break
  }

  return total
}

/**
 * Estimate token count using character-based heuristics (text: chars/4, JSON: chars/2).
 * Dependency-free fallback used by the base Model class.
 */
function estimateTokensHeuristic(messages: Message[], options?: CountTokensOptions): number {
  let total = 0

  if (options?.systemPrompt) {
    if (typeof options.systemPrompt === 'string') {
      total += heuristicText(options.systemPrompt)
    } else {
      for (const block of options.systemPrompt) {
        if (block.type === 'textBlock') total += heuristicText(block.text)
        else if (block.type === 'guardContentBlock' && block.text) total += heuristicText(block.text.text)
      }
    }
  }

  for (const message of messages) {
    for (const block of message.content) {
      total += estimateContentBlockTokens(block)
    }
  }

  if (options?.toolSpecs) {
    for (const spec of options.toolSpecs) {
      total += heuristicJson(spec)
    }
  }

  return total
}

function heuristicText(text: string): number {
  return Math.ceil(text.length / 4)
}

function heuristicJson(obj: unknown): number {
  try {
    return Math.ceil(JSON.stringify(obj).length / 2)
  } catch {
    logger.debug('unable to serialize object for token estimation, skipping')
    return 0
  }
}
