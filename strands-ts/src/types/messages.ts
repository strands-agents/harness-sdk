import type { JSONValue, Serialized, MaybeSerializedInput, JSONSerializable } from './json.js'
import { deepCopy, omitUndefined } from './json.js'
import type { AudioBlockData, ImageBlockData, VideoBlockData, DocumentBlockData } from './media.js'
import { AudioBlock, ImageBlock, VideoBlock, DocumentBlock, encodeBase64, decodeBase64 } from './media.js'
import type { CitationsBlockData } from './citations.js'
import { CitationsBlock } from './citations.js'
import type { Usage, Metrics } from '../models/streaming.js'

/**
 * Message types and content blocks for conversational AI interactions.
 *
 * This module follows a pattern where "Data" interfaces define the structure
 * for objects, while corresponding classes extend those interfaces with additional
 * functionality and type discrimination.
 */

/**
 * Optional metadata attached to a message.
 *
 * Not sent to model providers — model providers construct their own message format
 * from `role` and `content` only. Persisted alongside the message in session storage.
 */
export interface MessageMetadata {
  /** Token usage information from the model response. */
  usage?: Usage
  /** Performance metrics from the model response. */
  metrics?: Metrics
  /** Arbitrary user/framework metadata (e.g. compression provenance). */
  custom?: Record<string, JSONValue>
}

/**
 * Data for a message.
 */
export interface MessageData {
  /**
   * The role of the message sender.
   */
  role: Role

  /**
   * Array of content blocks that make up this message.
   */
  content: ContentBlockData[]

  /**
   * Durable, stable UUID for the message. Optional here because serialized/legacy data may omit it;
   * the Message constructor backfills a fresh UUID when absent, so a live Message always has one.
   */
  trackingId?: string

  /**
   * Optional metadata, not sent to model providers.
   */
  metadata?: MessageMetadata
}

/**
 * Generate a durable tracking identifier for a message.
 * @internal
 */
export function generateTrackingId(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * A message in a conversation between user and assistant.
 * Each message has a role (user or assistant) and an array of content blocks.
 */
export class Message implements JSONSerializable<MessageData> {
  /**
   * Discriminator for message type.
   */
  readonly type = 'message' as const

  /**
   * The role of the message sender.
   */
  readonly role: Role

  /**
   * Array of content blocks that make up this message.
   */
  readonly content: ContentBlock[]

  /**
   * Durable, stable UUID for the message, assigned at construction. Every Message has one — a
   * caller-supplied id is preserved, otherwise a fresh UUID is minted (so callers do not normally
   * set it; a caller supplying its own should use a UUID v4, e.g. `crypto.randomUUID()`). Survives
   * session save/restore, and is stripped before model calls. Preserved when a message is copied or
   * restored, so ids are unique within a conversation, but the same message carries the same id
   * across sessions (copying another agent's messages does not re-key them).
   */
  readonly trackingId: string

  /**
   * Optional metadata, not sent to model providers.
   */
  metadata?: MessageMetadata

  constructor(data: { role: Role; content: ContentBlock[]; trackingId?: string; metadata?: MessageMetadata }) {
    this.role = data.role
    this.content = data.content
    // Mint a durable id when the caller did not supply a usable one, so every Message has one from
    // the moment it exists — including messages added ad-hoc to agent.messages.
    this.trackingId = data.trackingId || generateTrackingId()
    if (data.metadata !== undefined) {
      this.metadata = data.metadata
    }
  }

  /**
   * Creates a Message instance from MessageData.
   */
  public static fromMessageData(data: MessageData): Message {
    const contentBlocks: ContentBlock[] = data.content.map(contentBlockFromData)

    return new Message({
      role: data.role,
      content: contentBlocks,
      // A missing trackingId (e.g. legacy serialized data) is backfilled by the constructor.
      ...(data.trackingId !== undefined && { trackingId: data.trackingId }),
      ...(data.metadata !== undefined && { metadata: data.metadata }),
    })
  }

  /**
   * Serializes the Message to a JSON-compatible MessageData object.
   * Called automatically by JSON.stringify().
   */
  toJSON(): MessageData {
    return {
      role: this.role,
      content: this.content.map((block) => block.toJSON() as ContentBlockData),
      ...(this.trackingId !== undefined && { trackingId: this.trackingId }),
      ...(this.metadata !== undefined && { metadata: this.metadata }),
    }
  }

  /**
   * Creates a Message instance from MessageData.
   * Alias for fromMessageData for API consistency.
   *
   * @param data - MessageData to deserialize
   * @returns Message instance
   */
  static fromJSON(data: MessageData): Message {
    return Message.fromMessageData(data)
  }

  /**
   * Creates a deep copy of this Message (round-trips through serialization).
   */
  clone(): Message {
    return Message.fromMessageData(deepCopy(this.toJSON()) as unknown as MessageData)
  }
}

/**
 * Role of a message in a conversation.
 * Can be either 'user' (human input) or 'assistant' (model response).
 */
export type Role = 'user' | 'assistant'

/**
 * A block of content within a message.
 * Content blocks can contain text, tool usage requests, tool results, reasoning content, cache points, guard content, or media (audio, image, video, document).
 *
 * This is a discriminated union where the object key determines the content format.
 *
 * @example
 * ```typescript
 * if ('text' in block) {
 *   console.log(block.text.text)
 * }
 * ```
 */
export type ContentBlockData =
  | TextBlockData
  | { toolUse: ToolUseBlockData }
  | { toolResult: ToolResultBlockData }
  | { reasoning: ReasoningBlockData }
  | { cachePoint: CachePointBlockData }
  | { guardContent: GuardContentBlockData }
  | { audio: AudioBlockData }
  | { image: ImageBlockData }
  | { video: VideoBlockData }
  | { document: DocumentBlockData }
  | { citations: CitationsBlockData }

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ReasoningBlock
  | CachePointBlock
  | GuardContentBlock
  | AudioBlock
  | ImageBlock
  | VideoBlock
  | DocumentBlock
  | CitationsBlock

/**
 * Data for a text block.
 */
export interface TextBlockData {
  /**
   * Plain text content.
   */
  text: string
}

/**
 * Text content block within a message.
 */
export class TextBlock implements TextBlockData, JSONSerializable<TextBlockData> {
  /**
   * Discriminator for text content.
   */
  readonly type = 'textBlock' as const

  /**
   * Plain text content.
   */
  readonly text: string

  constructor(data: string) {
    this.text = data
  }

  /**
   * Serializes the TextBlock to a JSON-compatible TextBlockData object.
   * Called automatically by JSON.stringify().
   */
  toJSON(): TextBlockData {
    return { text: this.text }
  }

  /**
   * Creates a TextBlock instance from TextBlockData.
   *
   * @param data - TextBlockData to deserialize
   * @returns TextBlock instance
   */
  static fromJSON(data: TextBlockData): TextBlock {
    return new TextBlock(data.text)
  }
}

/**
 * Data for a tool use block.
 */
export interface ToolUseBlockData {
  /**
   * The name of the tool to execute.
   */
  name: string

  /**
   * Unique identifier for this tool use instance.
   */
  toolUseId: string

  /**
   * The input parameters for the tool.
   * This can be any JSON-serializable value.
   */
  input: JSONValue

  /**
   * Reasoning signature from thinking models (e.g., Gemini).
   * Must be preserved and sent back to the model for multi-turn tool use.
   */
  reasoningSignature?: string
}

/**
 * Tool use content block.
 */
export class ToolUseBlock implements ToolUseBlockData, JSONSerializable<{ toolUse: ToolUseBlockData }> {
  /**
   * Discriminator for tool use content.
   */
  readonly type = 'toolUseBlock' as const

  /**
   * The name of the tool to execute.
   */
  readonly name: string

  /**
   * Unique identifier for this tool use instance.
   */
  readonly toolUseId: string

  /**
   * The input parameters for the tool.
   * This can be any JSON-serializable value.
   */
  readonly input: JSONValue

  /**
   * Reasoning signature from thinking models (e.g., Gemini).
   * Must be preserved and sent back to the model for multi-turn tool use.
   */
  readonly reasoningSignature?: string

  constructor(data: ToolUseBlockData) {
    this.name = data.name
    this.toolUseId = data.toolUseId
    this.input = data.input
    if (data.reasoningSignature !== undefined) {
      this.reasoningSignature = data.reasoningSignature
    }
  }

  /**
   * Serializes the ToolUseBlock to a JSON-compatible ContentBlockData object.
   * Called automatically by JSON.stringify().
   */
  toJSON(): { toolUse: ToolUseBlockData } {
    return {
      toolUse: omitUndefined({
        name: this.name,
        toolUseId: this.toolUseId,
        input: this.input,
        reasoningSignature: this.reasoningSignature,
      }),
    }
  }

  /**
   * Creates a ToolUseBlock instance from its wrapped data format.
   *
   * @param data - Wrapped ToolUseBlockData to deserialize
   * @returns ToolUseBlock instance
   */
  static fromJSON(data: { toolUse: ToolUseBlockData }): ToolUseBlock {
    return new ToolUseBlock(data.toolUse)
  }
}

/**
 * Content within a tool result.
 * Can be text, structured JSON data, or media blocks (image, video, document).
 *
 * This is a discriminated union where the object key determines the content format.
 */
export type ToolResultContentData =
  | TextBlockData
  | JsonBlockData
  | { image: ImageBlockData }
  | { video: VideoBlockData }
  | { document: DocumentBlockData }

export type ToolResultContent = TextBlock | JsonBlock | ImageBlock | VideoBlock | DocumentBlock

/**
 * Data for a tool result block.
 */
export interface ToolResultBlockData {
  /**
   * The ID of the tool use that this result corresponds to.
   */
  toolUseId: string

  /**
   * Status of the tool execution.
   */
  status: 'success' | 'error'

  /**
   * The content returned by the tool.
   */
  content: ToolResultContentData[]

  /**
   * The original error object when status is 'error'.
   * Available for inspection by hooks, error handlers, and agent loop.
   * Tools must wrap non-Error thrown values into Error objects.
   */
  error?: Error
}

/**
 * Tool result content block.
 */
export class ToolResultBlock implements JSONSerializable<{ toolResult: ToolResultBlockData }> {
  /**
   * Discriminator for tool result content.
   */
  readonly type = 'toolResultBlock' as const

  /**
   * The ID of the tool use that this result corresponds to.
   */
  readonly toolUseId: string

  /**
   * Status of the tool execution.
   */
  readonly status: 'success' | 'error'

  /**
   * The content returned by the tool.
   */
  readonly content: ToolResultContent[]

  /**
   * The original error object when status is 'error'.
   * Available for inspection by hooks, error handlers, and agent loop.
   * Tools must wrap non-Error thrown values into Error objects.
   */
  readonly error?: Error

  constructor(data: { toolUseId: string; status: 'success' | 'error'; content: ToolResultContent[]; error?: Error }) {
    this.toolUseId = data.toolUseId
    this.status = data.status
    this.content = data.content
    if (data.error !== undefined) {
      this.error = data.error
    }
  }

  /**
   * Serializes the ToolResultBlock to a JSON-compatible ContentBlockData object.
   * Called automatically by JSON.stringify().
   * Note: The error field is not serialized (deferred for future implementation).
   */
  toJSON(): { toolResult: ToolResultBlockData } {
    return {
      toolResult: {
        toolUseId: this.toolUseId,
        status: this.status,
        content: this.content.map((block) => block.toJSON() as ToolResultContentData),
      },
    }
  }

  /**
   * Creates a ToolResultBlock instance from its wrapped data format.
   *
   * @param data - Wrapped ToolResultBlockData to deserialize
   * @returns ToolResultBlock instance
   */
  static fromJSON(data: { toolResult: ToolResultBlockData }): ToolResultBlock {
    const content = data.toolResult.content.map(toolResultContentFromData)
    return new ToolResultBlock({
      toolUseId: data.toolResult.toolUseId,
      status: data.toolResult.status,
      content,
    })
  }
}

/**
 * Converts a single ToolResultContentData to a ToolResultContent class instance.
 *
 * @param data - The tool result content data to convert
 * @returns A ToolResultContent instance of the appropriate type
 * @throws Error if the content data type is unknown
 */
export function toolResultContentFromData(data: ToolResultContentData): ToolResultContent {
  if ('text' in data) return new TextBlock(data.text)
  if ('json' in data) return new JsonBlock(data)
  if ('image' in data) return ImageBlock.fromJSON(data as { image: ImageBlockData })
  if ('video' in data) return VideoBlock.fromJSON(data as { video: VideoBlockData })
  if ('document' in data) return DocumentBlock.fromJSON(data as { document: DocumentBlockData })
  throw new Error('Unknown ToolResultContentData type')
}

/**
 * Data for a reasoning block.
 */
export interface ReasoningBlockData {
  /**
   * The text content of the reasoning process.
   */
  text?: string

  /**
   * A cryptographic signature for verification purposes.
   */
  signature?: string

  /**
   * The redacted content of the reasoning process.
   */
  redactedContent?: Uint8Array
}

/**
 * Reasoning content block within a message.
 */
export class ReasoningBlock
  implements ReasoningBlockData, JSONSerializable<{ reasoning: Serialized<ReasoningBlockData> }>
{
  /**
   * Discriminator for reasoning content.
   */
  readonly type = 'reasoningBlock' as const

  /**
   * The text content of the reasoning process.
   */
  readonly text?: string

  /**
   * A cryptographic signature for verification purposes.
   */
  readonly signature?: string

  /**
   * The redacted content of the reasoning process.
   */
  readonly redactedContent?: Uint8Array

  constructor(data: ReasoningBlockData) {
    if (data.text !== undefined) {
      this.text = data.text
    }
    if (data.signature !== undefined) {
      this.signature = data.signature
    }
    if (data.redactedContent !== undefined) {
      this.redactedContent = data.redactedContent
    }
  }

  /**
   * Serializes the ReasoningBlock to a JSON-compatible ContentBlockData object.
   * Called automatically by JSON.stringify().
   * Uint8Array redactedContent is encoded as base64 string.
   */
  toJSON(): { reasoning: Serialized<ReasoningBlockData> } {
    return {
      reasoning: omitUndefined({
        text: this.text,
        signature: this.signature,
        redactedContent: this.redactedContent ? encodeBase64(this.redactedContent) : undefined,
      }),
    }
  }

  /**
   * Creates a ReasoningBlock instance from its wrapped data format.
   * Base64-encoded redactedContent is decoded back to Uint8Array.
   *
   * @param data - Wrapped ReasoningBlockData to deserialize (accepts both string and Uint8Array for redactedContent)
   * @returns ReasoningBlock instance
   */
  static fromJSON(data: { reasoning: MaybeSerializedInput<ReasoningBlockData> }): ReasoningBlock {
    const reasoning = data.reasoning
    const result: ReasoningBlockData = {}
    if (reasoning.text !== undefined) {
      result.text = reasoning.text
    }
    if (reasoning.signature !== undefined) {
      result.signature = reasoning.signature
    }
    if (reasoning.redactedContent !== undefined) {
      result.redactedContent =
        typeof reasoning.redactedContent === 'string'
          ? decodeBase64(reasoning.redactedContent)
          : reasoning.redactedContent
    }
    return new ReasoningBlock(result)
  }
}

/**
 * Data for a cache point block.
 */
export interface CachePointBlockData {
  /**
   * The cache type. Currently only 'default' is supported.
   */
  cacheType: 'default'

  /**
   * Optional TTL for the cache entry. When omitted, the provider's default TTL is used.
   *
   * The accepted value space is provider-specific. For example, the Bedrock provider only
   * accepts the values defined by `BedrockCacheTTL` (`'5m'` and `'1h'`). Other providers
   * may accept different values or ignore this field.
   */
  ttl?: string
}

/**
 * Cache point block for prompt caching.
 * Marks a position in a message or system prompt where caching should occur.
 */
export class CachePointBlock implements CachePointBlockData, JSONSerializable<{ cachePoint: CachePointBlockData }> {
  /**
   * Discriminator for cache point.
   */
  readonly type = 'cachePointBlock' as const

  /**
   * The cache type. Currently only 'default' is supported.
   */
  readonly cacheType: 'default'

  /**
   * Optional TTL for the cache entry. See {@link CachePointBlockData.ttl} for the
   * provider-specific value space.
   */
  readonly ttl?: string

  constructor(data: CachePointBlockData) {
    this.cacheType = data.cacheType
    if (data.ttl !== undefined) {
      this.ttl = data.ttl
    }
  }

  /**
   * Serializes the CachePointBlock to a JSON-compatible ContentBlockData object.
   * Called automatically by JSON.stringify().
   */
  toJSON(): { cachePoint: CachePointBlockData } {
    return {
      cachePoint: {
        cacheType: this.cacheType,
        ...(this.ttl !== undefined && { ttl: this.ttl }),
      },
    }
  }

  /**
   * Creates a CachePointBlock instance from its wrapped data format.
   *
   * @param data - Wrapped CachePointBlockData to deserialize
   * @returns CachePointBlock instance
   */
  static fromJSON(data: { cachePoint: CachePointBlockData }): CachePointBlock {
    return new CachePointBlock(data.cachePoint)
  }
}

/**
 * Data for a JSON block.
 */
export interface JsonBlockData {
  /**
   * Structured JSON data.
   */
  json: JSONValue
}

/**
 * JSON content block within a message.
 * Used for structured data returned from tools or model responses.
 */
export class JsonBlock implements JsonBlockData, JSONSerializable<JsonBlockData> {
  /**
   * Discriminator for JSON content.
   */
  readonly type = 'jsonBlock' as const

  /**
   * Structured JSON data.
   */
  readonly json: JSONValue

  constructor(data: JsonBlockData) {
    this.json = data.json
  }

  /**
   * Serializes the JsonBlock to a JSON-compatible JsonBlockData object.
   * Called automatically by JSON.stringify().
   */
  toJSON(): JsonBlockData {
    return { json: this.json }
  }

  /**
   * Creates a JsonBlock instance from JsonBlockData.
   *
   * @param data - JsonBlockData to deserialize
   * @returns JsonBlock instance
   */
  static fromJSON(data: JsonBlockData): JsonBlock {
    return new JsonBlock(data)
  }
}

/**
 * Reason why the model stopped generating content.
 *
 * - `cancelled` - Agent invocation was cancelled via `agent.cancel()`
 * - `contentFiltered` - Content was filtered by safety mechanisms
 * - `endTurn` - Natural end of the model's turn
 * - `guardrailIntervened` - A guardrail policy stopped generation
 * - `checkpoint` - Agent paused at a cycle boundary for durable execution (experimental; see experimental checkpoint module)
 * - `interrupt` - Agent execution was interrupted for human input
 * - `maxTokens` - The model provider's per-call token cap was reached
 * - `limitOutputTokens` - Agent loop stopped because `InvokeOptions.limits.outputTokens` was reached
 * - `limitTotalTokens` - Agent loop stopped because `InvokeOptions.limits.totalTokens` was reached
 * - `limitTurns` - Agent loop stopped because `InvokeOptions.limits.turns` was reached
 * - `pauseTurn` - Model paused a long-running turn; the response should be sent back to continue
 * - `refusal` - A streaming classifier intervened to handle a potential policy violation
 * - `stopSequence` - A stop sequence was encountered
 * - `toolUse` - Model wants to use a tool
 * - `modelContextWindowExceeded` - Input exceeded the model's context window
 */
export type StopReason =
  | 'cancelled'
  | 'checkpoint'
  | 'contentFiltered'
  | 'endTurn'
  | 'guardrailIntervened'
  | 'interrupt'
  | 'maxTokens'
  | 'limitOutputTokens'
  | 'limitTotalTokens'
  | 'limitTurns'
  | 'pauseTurn'
  | 'refusal'
  | 'stopSequence'
  | 'toolUse'
  | 'modelContextWindowExceeded'
  | (string & {}) // Allow any string while preserving autocomplete for known values

/**
 * System prompt for guiding model behavior.
 * Can be a simple string or an array of content blocks for advanced caching.
 *
 * @example
 * ```typescript
 * // Simple string
 * const prompt: SystemPrompt = 'You are a helpful assistant'
 *
 * // Array with cache points for advanced caching
 * const prompt: SystemPrompt = [
 *   { textBlock: new TextBlock('You are a helpful assistant') },
 *   { textBlock: new TextBlock(largeContextDocument) },
 *   { cachePointBlock: new CachePointBlock({ cacheType: 'default' }) }
 * ]
 * ```
 */
export type SystemPrompt = string | SystemContentBlock[]

/**
 * Data representation of a system prompt.
 * Can be a simple string or an array of system content block data for advanced caching.
 *
 * This is the data interface counterpart to SystemPrompt, following the "Data" pattern.
 */
export type SystemPromptData = string | SystemContentBlockData[]

/**
 * Converts SystemPromptData to SystemPrompt by converting data blocks to class instances.
 * If already in SystemPrompt format (class instances), returns as-is.
 *
 * @param data - System prompt data to convert
 * @returns SystemPrompt with class-based content blocks
 */
export function systemPromptFromData(data: SystemPromptData | SystemPrompt): SystemPrompt {
  if (typeof data === 'string') {
    return data
  }

  // Convert data format to class instances
  return data.map((block) => {
    if ('type' in block) {
      return block
    } else if ('cachePoint' in block) {
      return new CachePointBlock(block.cachePoint)
    } else if ('guardContent' in block) {
      return new GuardContentBlock(block.guardContent)
    } else if ('text' in block) {
      return new TextBlock(block.text)
    } else {
      throw new Error('Unknown SystemContentBlockData type')
    }
  })
}

/**
 * Converts a SystemPrompt to its data representation for serialization.
 *
 * @param prompt - System prompt to convert (string or content block array)
 * @returns SystemPromptData suitable for JSON serialization
 */
export function systemPromptToData(prompt: SystemPrompt): SystemPromptData {
  if (typeof prompt === 'string') {
    return prompt
  }
  // Convert content blocks to their data representation
  return prompt.map((block: SystemContentBlock) => block.toJSON()) as SystemContentBlockData[]
}

/**
 * Creates a deep copy of a SystemPrompt by round-tripping through serialization.
 */
export function cloneSystemPrompt(prompt: SystemPrompt): SystemPrompt {
  return systemPromptFromData(systemPromptToData(prompt))
}

/**
 * A block of content within a system prompt.
 * Supports text content, cache points, and guard content for prompt caching and guardrail evaluation.
 *
 * This is a discriminated union where the object key determines the block format.
 */
export type SystemContentBlockData =
  TextBlockData | { cachePoint: CachePointBlockData } | { guardContent: GuardContentBlockData }

export type SystemContentBlock = TextBlock | CachePointBlock | GuardContentBlock

/**
 * Qualifier for guard content.
 * Specifies how the content should be evaluated by guardrails.
 *
 * - `grounding_source` - Content to check for grounding/factuality
 * - `query` - User query to evaluate
 * - `guard_content` - General content for guardrail evaluation
 */
export type GuardQualifier = 'grounding_source' | 'query' | 'guard_content'

/**
 * Image format for guard content.
 * Only formats supported by Bedrock guardrails.
 */
export type GuardImageFormat = 'png' | 'jpeg'

/**
 * Source for guard content image.
 * Only supports raw bytes.
 */
export type GuardImageSource = { bytes: Uint8Array }

/**
 * Text content to be evaluated by guardrails.
 */
export interface GuardContentText {
  /**
   * Qualifiers that specify how this content should be evaluated.
   */
  qualifiers: GuardQualifier[]

  /**
   * The text content to be evaluated.
   */
  text: string
}

/**
 * Image content to be evaluated by guardrails.
 */
export interface GuardContentImage {
  /**
   * Image format.
   */
  format: GuardImageFormat

  /**
   * Image source (bytes only).
   */
  source: GuardImageSource
}

/**
 * Data for a guard content block.
 * Can contain either text or image content for guardrail evaluation.
 */
export interface GuardContentBlockData {
  /**
   * Text content with evaluation qualifiers.
   */
  text?: GuardContentText

  /**
   * Image content with evaluation qualifiers.
   */
  image?: GuardContentImage
}

/**
 * Guard content block for guardrail evaluation.
 * Marks content that should be evaluated by guardrails for safety, grounding, or other policies.
 * Can be used in both message content and system prompts.
 */
export class GuardContentBlock
  implements GuardContentBlockData, JSONSerializable<{ guardContent: Serialized<GuardContentBlockData> }>
{
  /**
   * Discriminator for guard content.
   */
  readonly type = 'guardContentBlock' as const

  /**
   * Text content with evaluation qualifiers.
   */
  readonly text?: GuardContentText

  /**
   * Image content with evaluation qualifiers.
   */
  readonly image?: GuardContentImage

  constructor(data: GuardContentBlockData) {
    if (!data.text && !data.image) {
      throw new Error('GuardContentBlock must have either text or image content')
    }
    if (data.text && data.image) {
      throw new Error('GuardContentBlock cannot have both text and image content')
    }
    if (data.text) {
      this.text = data.text
    }
    if (data.image) {
      this.image = data.image
    }
  }

  /**
   * Serializes the GuardContentBlock to a JSON-compatible ContentBlockData object.
   * Called automatically by JSON.stringify().
   * Uint8Array image bytes are encoded as base64 string.
   */
  toJSON(): { guardContent: Serialized<GuardContentBlockData> } {
    const data: Serialized<GuardContentBlockData> = {}
    if (this.text) {
      data.text = this.text
    }
    if (this.image) {
      data.image = {
        format: this.image.format,
        source: { bytes: encodeBase64(this.image.source.bytes) },
      }
    }
    return { guardContent: data }
  }

  /**
   * Creates a GuardContentBlock instance from its wrapped data format.
   * Base64-encoded image bytes are decoded back to Uint8Array.
   *
   * @param data - Wrapped GuardContentBlockData to deserialize (accepts both string and Uint8Array for image bytes)
   * @returns GuardContentBlock instance
   */
  static fromJSON(data: { guardContent: MaybeSerializedInput<GuardContentBlockData> }): GuardContentBlock {
    const guardContent = data.guardContent
    const result: GuardContentBlockData = {}
    if (guardContent.text) {
      result.text = guardContent.text
    }
    if (guardContent.image) {
      const bytes = guardContent.image.source.bytes
      result.image = {
        format: guardContent.image.format,
        source: {
          bytes: typeof bytes === 'string' ? decodeBase64(bytes) : bytes,
        },
      }
    }
    return new GuardContentBlock(result)
  }
}

/**
 * Converts ContentBlockData to a ContentBlock instance.
 * Handles all content block types including text, tool use/result, reasoning, cache points, guard content, and media blocks.
 *
 * @param data - The content block data to convert
 * @returns A ContentBlock instance of the appropriate type
 * @throws Error if the content block type is unknown
 */
export function contentBlockFromData(data: ContentBlockData): ContentBlock {
  if ('text' in data) {
    return new TextBlock(data.text)
  } else if ('toolUse' in data) {
    return new ToolUseBlock(data.toolUse)
  } else if ('toolResult' in data) {
    return ToolResultBlock.fromJSON(data)
  } else if ('reasoning' in data) {
    return ReasoningBlock.fromJSON(data)
  } else if ('cachePoint' in data) {
    return CachePointBlock.fromJSON(data)
  } else if ('guardContent' in data) {
    return GuardContentBlock.fromJSON(data)
  } else if ('audio' in data) {
    return AudioBlock.fromJSON(data)
  } else if ('image' in data) {
    return ImageBlock.fromJSON(data)
  } else if ('video' in data) {
    return VideoBlock.fromJSON(data)
  } else if ('document' in data) {
    return DocumentBlock.fromJSON(data)
  } else if ('citations' in data) {
    return CitationsBlock.fromJSON(data)
  } else {
    throw new Error('Unknown ContentBlockData type')
  }
}
