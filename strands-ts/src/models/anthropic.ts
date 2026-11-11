import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { VERSION as ANTHROPIC_SDK_VERSION } from '@anthropic-ai/sdk/version'
import {
  Model,
  type BaseModelConfig,
  type CountTokensOptions,
  type StreamOptions,
  type SummarizeOptions,
  resolveConfigMetadata,
  resolveMaxTokens,
  resolveCacheSection,
  type CacheConfig,
  type ResolvedCacheSection,
} from '../models/model.js'
import { THINKING_BINDING_BETA, isThinkingBindingError, thinkingWithDropBlock } from './thinking-binding.js'
import {
  handleRejectedMechanism,
  structuredOutputMechanisms,
  toNativeOutputSchema,
  type StructuredOutputMechanism,
} from './native-output.js'
import { zodSchemaToJsonSchema } from '../tools/zod-utils.js'
import { lookupModelInfo, mergeModelInfo, type ModelInfo } from './model-info.js'
import { Message, SummaryBlock } from '../types/messages.js'
import type { ContentBlock, SystemPrompt } from '../types/messages.js'
import type { ModelStreamEvent, Usage } from '../models/streaming.js'
import { accumulateUsage, createEmptyUsage } from '../models/streaming.js'
import type { SummarizeResult } from './summarize.js'
import { ContextWindowOverflowError, ModelError, ModelThrottledError, normalizeError } from '../errors.js'
import type { Citation } from '../types/citations.js'
import type { ImageBlock, DocumentBlock } from '../types/media.js'
import { encodeBase64, decodeBase64 } from '../types/media.js'
import { logger } from '../logging/logger.js'
import { warnOnce } from '../logging/warn-once.js'
import { MODEL_DEFAULTS, defaultMaxTokensWarningMessage, defaultModelWarningMessage } from './defaults.js'

// Union of overflow phrases observed across Anthropic responses, matched
// case-insensitively. Kept in lowercase so the comparison is a single
// ``toLowerCase`` on the error message.
const CONTEXT_WINDOW_OVERFLOW_ERRORS = [
  'prompt is too long',
  'max_tokens exceeded',
  'input too long',
  'input is too long',
  'input length exceeds context window',
  'input and output tokens exceed your context limit',
]
// Content blocks for tools Anthropic executes server side. They have no toolUse/toolResult equivalent
// (the agent never runs them), so they are not streamed.
const SERVER_TOOL_BLOCK_TYPES = new Set([
  'bash_code_execution_tool_result',
  'code_execution_tool_result',
  'container_upload',
  'mcp_tool_result',
  'mcp_tool_use',
  'server_tool_use',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  'web_fetch_tool_result',
  'web_search_tool_result',
])

// Anthropic pauses a long server-side tool turn with stop_reason=pause_turn and expects the paused
// assistant message to be sent back as-is to resume it. Bounds how many times stream() does so.
const MAX_PAUSE_TURN_CONTINUATIONS = 10

/**
 * `ephemeral` is the only cache type the Anthropic API supports.
 */
const ANTHROPIC_CACHE_TYPE = 'ephemeral' as const

/**
 * Beta that lets a mid-conversation system message carry `clear_at`.
 *
 * @see https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
 */
const TURN_SCOPED_SYSTEM_BETA = 'mid-conversation-system-clear-at-2026-08-21'

/**
 * A system message cleared at the next user message. Declared here because the SDK types lack `clear_at`, and
 * because `MessageParam` is an interface before SDK 1.x and a union from it.
 */
interface TurnScopedSystemMessage {
  role: 'system'
  content: Anthropic.TextBlockParam[]
  clear_at: 'next_user_message'
}
const TEXT_FILE_FORMATS = ['txt', 'md', 'markdown', 'csv', 'json', 'xml', 'html', 'yml', 'yaml', 'js', 'ts', 'py']

// API version 2026-10-21 removed the sampling params and rejects document blocks in assistant messages.
// @see https://platform.claude.com/docs/en/api/migration-2026-10-21
const SAMPLING_PARAMS_REMOVED_VERSION = '2026-10-21'
const REMOVED_SAMPLING_PARAMS = ['temperature', 'top_p', 'top_k']

/**
 * Validates that `anthropicTools` does not contain function tool definitions.
 *
 * @param anthropicTools - The configured server-side tools
 * @throws Error - When an entry carries an `input_schema`
 */
function validateAnthropicTools(anthropicTools: Anthropic.ToolUnion[]): void {
  for (const tool of anthropicTools) {
    if ('input_schema' in tool) {
      throw new Error(
        'anthropicTools should not contain function tool definitions. Use the standard tools interface for ' +
          'function calling tools. anthropicTools is reserved for Anthropic server-side tools like web_search, ' +
          'web_fetch, and code_execution.'
      )
    }
  }
}

/** A server tool's `name`, or its `type` for a toolset, which has none. */
function serverToolName(tool: Anthropic.ToolUnion): string {
  // The cast keeps 0.x compiling, where every ToolUnion member has a name and the else branch is `never`.
  return 'name' in tool ? tool.name : (tool as { type: string }).type
}

/**
 * Copies the numeric fields of an Anthropic usage object; `null` fields leave the existing value in place.
 */
function mergeUsage(target: Record<string, number>, source: object): void {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number') target[key] = value
  }
}

/** The stream options to format the request with: the requested ones, or auto when the mechanism does not force. */
function mechanismOptions(
  options: StreamOptions | undefined,
  mechanism: StructuredOutputMechanism | undefined
): StreamOptions | undefined {
  if (mechanism !== 'native' && mechanism !== 'auto') return options
  return { ...options, toolChoice: { auto: {} } }
}

/**
 * Constrains the response to the schema, keeping other `output_config` settings.
 *
 * `tool_choice` none keeps the tools array unchanged while ruling out tool calls, so the response is the JSON object.
 */
function withNativeOutput(
  request: Anthropic.MessageStreamParams,
  mechanism: StructuredOutputMechanism | undefined,
  options: StreamOptions | undefined
): Anthropic.MessageStreamParams {
  if (mechanism !== 'native' || !options?.structuredOutputSchema) return request
  const schema = toNativeOutputSchema(
    zodSchemaToJsonSchema(options.structuredOutputSchema)
  ) as Anthropic.JSONOutputFormat['schema']
  return {
    ...request,
    tool_choice: { type: 'none' },
    output_config: { ...request.output_config, format: { type: 'json_schema', schema } },
  }
}

/**
 * The provider's error text. The SDK's error message is the JSON-encoded response body, which escapes quotes in the
 * text, so the body's own message is read when present.
 */
function apiErrorMessage(error: unknown): string {
  const message = (error as { error?: { error?: { message?: unknown } } }).error?.error?.message
  return typeof message === 'string' ? message : normalizeError(error).message
}

/**
 * Reads a header's values from client default headers, matching the name case-insensitively and skipping the
 * `undefined` and `null` values the SDK leaves out of the request.
 */
function headerValues(headers: ClientOptions['defaultHeaders'], name: string): string[] {
  if (!headers) return []
  const rows: Iterable<readonly unknown[]> =
    headers instanceof Headers || Array.isArray(headers) ? headers : Object.entries(headers)
  return [...rows]
    .filter(([key]) => typeof key === 'string' && key.toLowerCase() === name)
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === 'string')
}

/** Beta that enables on-demand compaction, and compaction blocks in later requests. */
const COMPACTION_BETA = 'compact-2026-09-04'

type UsageCounters = Partial<
  Record<'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens', number | null>
>

type CompactionUsage = UsageCounters & { iterations?: UsageCounters[] | null }

const USAGE_COUNTERS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const

/** Converts an Anthropic usage payload to a Strands usage. */
function formatUsage(usage: UsageCounters): Usage {
  const inputTokens = usage.input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  // Anthropic's input_tokens excludes tokens read from or written to the cache, so the
  // billed total is the sum of all four counters.
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + cacheRead + cacheWrite,
    ...(cacheRead && { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite && { cacheWriteInputTokens: cacheWrite }),
  }
}

/** Converts a compaction response's usage, which counts its tokens per iteration and zero at the top level. */
function formatCompactionUsage(usage: CompactionUsage): Usage {
  const iterations = usage.iterations ?? []
  if (iterations.length === 0) return formatUsage(usage)
  const totals: UsageCounters = {}
  for (const key of USAGE_COUNTERS) {
    totals[key] = iterations.reduce((sum, iteration) => sum + (iteration[key] ?? 0), 0)
  }
  return formatUsage(totals)
}

/** Returns the combined usage of two calls, or whichever one reported usage. */
function sumUsage(first: Usage | undefined, second: Usage | undefined): Usage | undefined {
  if (first === undefined || second === undefined) return first ?? second
  const total = { ...first }
  accumulateUsage(total, second)
  return total
}

/** Whether `block` holds a compaction block Anthropic returned. */
function isCompaction(block: ContentBlock): block is SummaryBlock {
  return block.type === 'summaryBlock' && block.provider === 'anthropic'
}

/**
 * Returns the messages from the last compaction block, which stands in for everything before it, or all of them.
 * The API rejects any content before a compaction block.
 */
function fromLastCompaction(messages: Message[]): Message[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    const position = message.content.map(isCompaction).lastIndexOf(true)
    if (position < 0) continue
    const first = new Message({ role: message.role, content: message.content.slice(position) })
    return [first, ...messages.slice(index + 1)]
  }
  return messages
}

/** Reads the `anthropic-beta` values from client default headers. */
function headerBetas(headers: ClientOptions['defaultHeaders']): string[] {
  return headerValues(headers, 'anthropic-beta').flatMap((value) =>
    value.split(',').flatMap((beta) => beta.trim() || [])
  )
}

/** The `anthropic-version` the SDK sends unless a default header pins one: `2023-06-01` on 0.x, `2026-10-21` from 1.0. */
function sdkDefaultApiVersion(): string {
  return ANTHROPIC_SDK_VERSION.startsWith('0.') ? '2023-06-01' : SAMPLING_PARAMS_REMOVED_VERSION
}

export interface AnthropicModelConfig extends BaseModelConfig {
  /**
   * Maximum number of tokens the model can generate in a response.
   *
   * @defaultValue the model's `maxOutputTokens` from the model info, else 64000 — subject to change between versions.
   * Set this explicitly to avoid unexpected changes.
   */
  maxTokens?: number
  stopSequences?: string[]
  params?: Record<string, unknown>

  /**
   * Built-in server-side tools (e.g. `web_search`, `web_fetch`, `code_execution`).
   * These are appended alongside the agent's function tools.
   *
   * @see https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview
   */
  anthropicTools?: Anthropic.ToolUnion[]

  /**
   * Beta features to enable via the `anthropic-beta` header.
   *
   * No header is sent by default. Provide a list of beta identifiers to opt into
   * features such as `interleaved-thinking-2025-05-14` or `mcp-client-2025-11-20`.
   *
   * @see https://docs.anthropic.com/en/api/beta-headers
   */
  betas?: string[]

  /**
   * Whether to use the native Anthropic countTokens API.
   *
   * When `true`, `countTokens()` calls the Anthropic token counting API for
   * accurate counts. When `false` or not set (default), skips the API call and uses
   * the character-based heuristic estimator.
   *
   * @defaultValue false
   */
  useNativeTokenCount?: boolean

  /**
   * Prompt caching configuration. Setting it caches the tool definitions and adds a cache point
   * to the last user message; caching is off when unset.
   *
   * `strategy` has no effect here, since prompt caching is supported on every active Claude model.
   */
  cacheConfig?: CacheConfig
}

type AnthropicMessagesClient = {
  messages: Pick<Anthropic['messages'], 'stream'> & Partial<Pick<Anthropic['messages'], 'countTokens'>>
}

export interface AnthropicModelOptions extends AnthropicModelConfig {
  apiKey?: string
  /**
   * Pre-built client for any Anthropic Messages API endpoint, such as `Anthropic`, or
   * `AnthropicBedrock` / `AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk`.
   */
  client?: AnthropicMessagesClient
  clientConfig?: ClientOptions
}

export class AnthropicModel extends Model<AnthropicModelConfig> {
  private _config: AnthropicModelConfig
  private _client: AnthropicMessagesClient
  private _dropStaleThinkingModelId: string | undefined
  private _clientBetas: string[]
  // Unknown for an injected client, which may not be this SDK's `Anthropic` (e.g. a Bedrock or Vertex client).
  private _apiVersion: string | undefined
  private _apiVersionOrigin = ''

  constructor(options?: AnthropicModelOptions) {
    super()
    const { apiKey, client, clientConfig, ...modelConfig } = options || {}
    this._clientBetas = headerBetas(clientConfig?.defaultHeaders)

    this._config = {
      modelId: MODEL_DEFAULTS.anthropic.modelId,
      ...modelConfig,
    }

    if (modelConfig.anthropicTools) validateAnthropicTools(modelConfig.anthropicTools)

    if (modelConfig.modelId === undefined) {
      warnOnce(logger, defaultModelWarningMessage(MODEL_DEFAULTS.anthropic.modelId))
    }

    if (modelConfig.maxTokens === undefined && modelConfig.modelInfo?.limits?.maxOutputTokens === undefined) {
      warnOnce(logger, defaultMaxTokensWarningMessage(this._resolvedMaxTokens()))
    }

    if (client) {
      this._client = client
    } else {
      const hasEnvKey =
        typeof process !== 'undefined' && typeof process.env !== 'undefined' && process.env.ANTHROPIC_API_KEY

      if (!apiKey && !hasEnvKey) {
        throw new Error(
          "Anthropic API key is required. Provide it via the 'apiKey' option or set the ANTHROPIC_API_KEY environment variable."
        )
      }

      this._client = new Anthropic({
        ...(apiKey ? { apiKey } : {}),
        ...clientConfig,
      })
      this._resolveApiVersion(clientConfig)
    }
  }

  /** Turns temporary messages back on for the models the shared model info lists. */
  override get modelInfo(): ModelInfo {
    const { temporaryMessages } = lookupModelInfo(this.modelId ?? '').capabilities ?? {}
    return mergeModelInfo(super.modelInfo, { capabilities: { temporaryMessages } }, this._config.modelInfo)
  }

  updateConfig(modelConfig: AnthropicModelConfig): void {
    if (modelConfig.anthropicTools) validateAnthropicTools(modelConfig.anthropicTools)

    this._config = { ...this._config, ...modelConfig }
  }

  getConfig(): AnthropicModelConfig {
    const modelId = this._config.modelId ?? MODEL_DEFAULTS.anthropic.modelId
    const config = resolveConfigMetadata(this._config, modelId)
    return config.maxTokens === undefined ? { ...config, maxTokens: this._resolvedMaxTokens() } : config
  }

  /**
   * The `maxTokens` to send: the user's value, else the model's output ceiling (see
   * `resolveMaxTokens`), else the fixed default. Resolved on each read so it follows `updateConfig({ modelId })`.
   */
  private _resolvedMaxTokens(): number {
    const modelId = this._config.modelId ?? MODEL_DEFAULTS.anthropic.modelId
    return resolveMaxTokens(this._config, modelId) ?? MODEL_DEFAULTS.anthropic.maxTokens
  }

  /**
   * Count tokens using Anthropic's native countTokens API.
   *
   * Uses the same message format as the Messages API to get accurate token counts
   * directly from the Anthropic service. Falls back to the base class heuristic on failure.
   *
   * @param messages - Array of conversation messages to count tokens for
   * @param options - Optional options containing system prompt and tool specs
   * @returns Total input token count
   */
  override async countTokens(messages: Message[], options?: CountTokensOptions): Promise<number> {
    // Count what a request sends, which starts at the last compaction block.
    if (this._serverSideSummary()) messages = fromLastCompaction(messages)
    if (this._config.useNativeTokenCount !== true) return super.countTokens(messages, options)

    // Bedrock clients omit `countTokens`.
    const countTokens = this._client.messages.countTokens?.bind(this._client.messages)
    if (!countTokens) return super.countTokens(messages, options)

    try {
      const request = this._formatRequest(messages, options)
      const params: Anthropic.MessageCountTokensParams = {
        model: request.model,
        messages: request.messages,
        ...(request.system && { system: request.system }),
        ...(request.tools && { tools: request.tools }),
        ...(request.tool_choice && { tool_choice: request.tool_choice }),
      }

      const requestOptions = this._buildRequestOptions(request, this._compactionBetas(messages))
      const response = requestOptions ? await countTokens(params, requestOptions) : await countTokens(params)

      logger.debug(`total_tokens=<${response.input_tokens}> | native token count`)
      return response.input_tokens
    } catch (error) {
      logger.debug(`error=<${error}> | native token counting failed, falling back to estimation`)
      return super.countTokens(messages, options)
    }
  }

  /**
   * Streams a conversation with the Anthropic model.
   *
   * A server-side tool turn that Anthropic pauses is resumed with follow-up requests inside this call, so
   * an error thrown by one of those requests can surface after earlier events were already yielded.
   *
   * @param messages - Array of conversation messages
   * @param options - Optional streaming configuration
   * @returns Async iterable of streaming events
   */
  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    let thinking: Anthropic.ThinkingConfigParam | undefined
    let continuations = 0
    const mechanism = this._structuredOutputMechanism(options)
    try {
      let request = withNativeOutput(
        this._formatRequest(messages, mechanismOptions(options, mechanism)),
        mechanism,
        options
      )
      thinking = request.thinking
      const requestOptions = this._buildRequestOptions(request, this._compactionBetas(messages))
      const usage = createEmptyUsage()

      while (true) {
        const stream = requestOptions
          ? this._client.messages.stream(request, requestOptions)
          : this._client.messages.stream(request)

        let stopReason = 'endTurn'
        let messageStopped = false
        const responseUsage: Record<string, number> = {}

        const serverToolBlockIndexes = new Set<number>()

        for await (const event of stream) {
          switch (event.type) {
            case 'message_start': {
              mergeUsage(responseUsage, event.message.usage)

              if (continuations === 0) {
                yield {
                  type: 'modelMessageStartEvent',
                  role: event.message.role,
                }
              }
              break
            }

            case 'content_block_start':
              if (SERVER_TOOL_BLOCK_TYPES.has(event.content_block.type)) {
                serverToolBlockIndexes.add(event.index)
                this._logServerToolBlock(event.content_block)
                break
              }

              if (event.content_block.type === 'tool_use') {
                yield {
                  type: 'modelContentBlockStartEvent',
                  start: {
                    type: 'toolUseStart',
                    name: event.content_block.name,
                    toolUseId: event.content_block.id,
                  },
                }
              } else if (event.content_block.type === 'thinking') {
                yield { type: 'modelContentBlockStartEvent' }
                if (event.content_block.thinking) {
                  yield {
                    type: 'modelContentBlockDeltaEvent',
                    delta: {
                      type: 'reasoningContentDelta',
                      text: event.content_block.thinking,
                      signature: event.content_block.signature,
                    },
                  }
                }
              } else if (event.content_block.type === 'redacted_thinking') {
                yield { type: 'modelContentBlockStartEvent' }
                yield {
                  type: 'modelContentBlockDeltaEvent',
                  delta: {
                    type: 'reasoningContentDelta',
                    redactedContent: decodeBase64(event.content_block.data),
                  },
                }
              } else {
                yield { type: 'modelContentBlockStartEvent' }
                if (event.content_block.type === 'text' && event.content_block.text) {
                  yield {
                    type: 'modelContentBlockDeltaEvent',
                    delta: { type: 'textDelta', text: event.content_block.text },
                  }
                }
              }
              break

            case 'content_block_delta':
              if (serverToolBlockIndexes.has(event.index)) break

              if (event.delta.type === 'text_delta') {
                yield {
                  type: 'modelContentBlockDeltaEvent',
                  delta: { type: 'textDelta', text: event.delta.text },
                }
              } else if (event.delta.type === 'citations_delta') {
                const citation = this._formatCitation(event.delta.citation)
                if (citation) {
                  yield {
                    type: 'modelContentBlockDeltaEvent',
                    delta: { type: 'citationsDelta', citations: [citation], content: [] },
                  }
                }
              } else if (event.delta.type === 'input_json_delta') {
                yield {
                  type: 'modelContentBlockDeltaEvent',
                  delta: { type: 'toolUseInputDelta', input: event.delta.partial_json },
                }
              } else if (event.delta.type === 'thinking_delta') {
                yield {
                  type: 'modelContentBlockDeltaEvent',
                  delta: { type: 'reasoningContentDelta', text: event.delta.thinking },
                }
              } else if (event.delta.type === 'signature_delta') {
                yield {
                  type: 'modelContentBlockDeltaEvent',
                  delta: { type: 'reasoningContentDelta', signature: event.delta.signature },
                }
              }
              break

            case 'content_block_stop':
              if (serverToolBlockIndexes.delete(event.index)) break

              yield { type: 'modelContentBlockStopEvent' }
              break

            case 'message_delta':
              if (event.usage) {
                // Cumulative within one response; fields Anthropic omits keep their message_start value.
                mergeUsage(responseUsage, event.usage)
              }
              if (event.delta.stop_reason) {
                stopReason = this._mapStopReason(event.delta.stop_reason)
              }
              break

            case 'message_stop':
              messageStopped = true
              break
          }
        }

        // A stream that ends without message_stop is incomplete; emit no stop event so the caller can tell.
        if (!messageStopped) return
        usage.inputTokens += responseUsage.input_tokens ?? 0
        usage.outputTokens += responseUsage.output_tokens ?? 0
        if (responseUsage.cache_creation_input_tokens !== undefined) {
          usage.cacheWriteInputTokens = (usage.cacheWriteInputTokens ?? 0) + responseUsage.cache_creation_input_tokens
        }
        if (responseUsage.cache_read_input_tokens !== undefined) {
          usage.cacheReadInputTokens = (usage.cacheReadInputTokens ?? 0) + responseUsage.cache_read_input_tokens
        }

        if (stopReason === 'pauseTurn') {
          if (continuations >= MAX_PAUSE_TURN_CONTINUATIONS) {
            throw new ModelError(`server-side tool turn did not complete after ${continuations} continuations`)
          }
          continuations++
          const pausedMessage = await stream.finalMessage()
          request = {
            ...request,
            messages: [...request.messages, { role: 'assistant', content: pausedMessage.content }],
          }
          logger.debug(`continuation=<${continuations}> | resuming paused server-side tool turn`)
          continue
        }

        // Anthropic's input_tokens excludes tokens read from or written to the cache, so the
        // billed total is the sum of all four counters.
        usage.totalTokens =
          usage.inputTokens +
          usage.outputTokens +
          (usage.cacheReadInputTokens ?? 0) +
          (usage.cacheWriteInputTokens ?? 0)
        yield {
          type: 'modelMetadataEvent',
          usage,
        }
        yield {
          type: 'modelMessageStopEvent',
          stopReason,
        }
        return
      }
    } catch (unknownError) {
      if (
        continuations === 0 &&
        (unknownError as { status?: number }).status === 400 &&
        isThinkingBindingError(unknownError) &&
        thinkingWithDropBlock(thinking)
      ) {
        // Stale blocks stay in history, so drop_block stays on for every later request to this model.
        logger.warn(
          `model_id=<${this._config.modelId}> | history edit invalidated replayed thinking blocks, retrying with drop_block`
        )
        this._dropStaleThinkingModelId = this._config.modelId
        yield* this.stream(messages, options)
        return
      }

      // A mechanism is rejected on a turn's first request, before any event is yielded; continuations reuse an
      // accepted one. So the request can be resent with the next mechanism, the same order BedrockModel tries.
      if (continuations === 0 && this._recordRejectedMechanism(unknownError, mechanism, options)) {
        yield* this.stream(messages, options)
        return
      }

      throw this._translateError(unknownError)
    }
  }

  /** Maps a context overflow or a throttle to the SDK's error types; any other error is normalized. */
  private _translateError(unknownError: unknown): Error {
    const error = normalizeError(unknownError)

    const lowered = error.message.toLowerCase()
    if (CONTEXT_WINDOW_OVERFLOW_ERRORS.some((msg) => lowered.includes(msg))) {
      return new ContextWindowOverflowError(error.message)
    }

    const err = unknownError as Error & { status?: number; type?: string }
    // Bedrock sends a throttle that arrives mid-stream as a `throttlingException` frame, which has no status.
    if (err.status === 429 || err.type === 'throttlingException') {
      const message = error.message ?? 'Request was throttled by the model provider'
      logger.debug(`throttled | error_message=<${message}>`)
      return new ModelThrottledError(message, { cause: err })
    }

    return error
  }

  /**
   * Summarizes `messages` with Anthropic on-demand compaction.
   *
   * Sends the request unchanged under beta `compact-2026-09-04`, so the thinking kept after a summary of the live
   * conversation stays valid. Later requests from a model with `serverSideSummary` rebuild the compaction block
   * from the returned summary block and start from it; requests without it send the summary text. Uses the base
   * {@link Model.summarize} when `modelInfo.capabilities.serverSideSummary` is not `true`, when the client has no
   * beta messages API, when the compaction request fails with an API error (a rejection, an overload, a timeout or
   * a connection error), or when the response holds no compaction block.
   *
   * @param messages - The request to summarize, left unmodified
   * @param options - The request's system prompt and tools, instructions replacing the API's own prompt, and the
   *   cancel signal and agent metadata passed to the base implementation
   * @returns The summary and the usage of every call made for it
   */
  override async summarize(messages: Message[], options?: SummarizeOptions): Promise<SummarizeResult> {
    if (!this._serverSideSummary()) return super.summarize(messages, options)

    const result = await this._compact(messages, options)
    if (result.content.length > 0) return result

    const fallback = await super.summarize(messages, options)
    const usage = sumUsage(result.usage, fallback.usage)
    return { content: fallback.content, ...(usage && { usage }) }
  }

  /** Sends `messages` as a compaction request; the result is empty when the response holds no compaction. */
  private async _compact(messages: Message[], options?: SummarizeOptions): Promise<SummarizeResult> {
    const request = this._formatRequest(messages, {
      ...(options?.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
      ...(options?.toolSpecs !== undefined && { toolSpecs: options.toolSpecs }),
    })
    // The API rejects these on a compaction request.
    const {
      stop_sequences: _stopSequences,
      context_management: _contextManagement,
      ...rest
    } = request as Anthropic.MessageStreamParams & { context_management?: unknown }
    const params = {
      ...rest,
      compaction: { type: 'summarize', ...(options?.instructions && { instructions: options.instructions }) },
    } as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming
    const requestOptions = this._buildRequestOptions(request, [COMPACTION_BETA])

    // On-demand compaction is only on the beta endpoint, which a narrower injected client may not have.
    const beta = (this._client as Partial<Pick<Anthropic, 'beta'>>).beta
    if (!beta) {
      logger.warn(`model_id=<${this._config.modelId}> | client has no beta messages API | summarizing client-side`)
      return { content: [] }
    }
    let response: Anthropic.Beta.Messages.BetaMessage
    try {
      response = await beta.messages.stream(params, requestOptions).finalMessage()
    } catch (error) {
      if (!(error instanceof Anthropic.APIError)) throw this._translateError(error)
      logger.warn(
        `model_id=<${this._config.modelId}>, error=<${error.message}> | compaction request failed | summarizing client-side`
      )
      return { content: [] }
    }
    const responseUsage = response.usage as unknown as CompactionUsage | undefined
    const usage = responseUsage ? formatCompactionUsage(responseUsage) : undefined

    const block = (response.content as unknown as Record<string, unknown>[] | undefined)?.find(
      (item) => item.type === 'compaction'
    )
    if ((response.stop_reason as string) !== 'compaction' || !block || !block.content) {
      logger.debug(
        `model_id=<${this._config.modelId}>, stop_reason=<${response.stop_reason}> | compaction returned no summary | summarizing client-side`
      )
      return { content: [], ...(usage && { usage }) }
    }
    const summary = new SummaryBlock({
      provider: 'anthropic',
      ...(typeof block.signature === 'string' && { signature: block.signature }),
      text: block.content as string,
    })
    return { content: [summary], ...(usage && { usage }) }
  }

  /** Chooses the strongest structured output mechanism not yet rejected for this model. */
  private _structuredOutputMechanism(options: StreamOptions | undefined): StructuredOutputMechanism | undefined {
    const schema = options?.structuredOutputSchema
    if (!schema || !this._config.modelId) return undefined
    return structuredOutputMechanisms('anthropic', this._config.modelId, options.toolChoice, schema, this.modelInfo)[0]
  }

  /**
   * Records a structured output rejection, so the request should be resent with the next mechanism.
   *
   * @returns True if the rejection was recorded; false if the error is unrelated and should surface unchanged
   */
  private _recordRejectedMechanism(
    error: unknown,
    mechanism: StructuredOutputMechanism | undefined,
    options: StreamOptions | undefined
  ): boolean {
    const schema = options?.structuredOutputSchema
    const modelId = this._config.modelId
    if (!mechanism || !schema || !modelId || (error as { status?: number }).status !== 400) return false
    return handleRejectedMechanism('anthropic', modelId, mechanism, schema, apiErrorMessage(error))
  }

  private _buildRequestOptions(
    request: Anthropic.MessageStreamParams,
    extra: string[] = []
  ): Anthropic.RequestOptions | undefined {
    const required = [
      ...extra,
      ...(this._dropsStaleThinking() ? [THINKING_BINDING_BETA] : []),
      ...(request.messages.some((message) => 'clear_at' in message) ? [TURN_SCOPED_SYSTEM_BETA] : []),
    ]
    let betas = this._config.betas ?? []
    // Request headers replace client headers of the same name, so betas set on the client are carried over.
    if (required.length > 0 && betas.length === 0) betas = this._clientBetas
    betas = [...new Set([...betas, ...required])]
    if (betas.length === 0) return undefined
    return { headers: { 'anthropic-beta': betas.join(',') } }
  }

  /** The compaction beta when `messages` carry a compaction block this model sends as one. */
  private _compactionBetas(messages: Message[]): string[] {
    const carries = messages.some((message) => message.content.some(isCompaction))
    return this._serverSideSummary() && carries ? [COMPACTION_BETA] : []
  }

  private _serverSideSummary(): boolean {
    return this.modelInfo.capabilities?.serverSideSummary === true
  }

  /** Formats a summary as a compaction block when Anthropic wrote it and compaction is enabled, else as text. */
  private _formatSummary(summary: SummaryBlock): Anthropic.ContentBlockParam {
    if (summary.provider !== 'anthropic' || !this._serverSideSummary()) return { type: 'text', text: summary.text }
    return {
      type: 'compaction',
      content: summary.text,
      ...(summary.signature && { signature: summary.signature }),
    } as unknown as Anthropic.ContentBlockParam
  }

  /** Whether a binding error already turned drop_block on for the configured model. */
  private _dropsStaleThinking(): boolean {
    return this._dropStaleThinkingModelId === this._config.modelId
  }

  /** Resolves the `anthropic-version` the built client sends, and where it comes from for error messages. */
  private _resolveApiVersion(clientConfig: ClientOptions | undefined): void {
    // The SDK merges ANTHROPIC_CUSTOM_HEADERS into `_options.defaultHeaders`; fall back to clientConfig if that moves.
    const sent =
      (this._client as unknown as { _options?: ClientOptions })._options?.defaultHeaders ?? clientConfig?.defaultHeaders
    // The SDK lets the last of several case-variant keys win.
    const pinned = headerValues(sent, 'anthropic-version').at(-1)
    this._apiVersion = pinned ?? sdkDefaultApiVersion()
    if (pinned === undefined) {
      this._apiVersionOrigin = `the default for @anthropic-ai/sdk ${ANTHROPIC_SDK_VERSION}`
    } else if (pinned === headerValues(clientConfig?.defaultHeaders, 'anthropic-version').at(-1)) {
      this._apiVersionOrigin = "pinned by clientConfig.defaultHeaders['anthropic-version']"
    } else {
      this._apiVersionOrigin = 'pinned by the ANTHROPIC_CUSTOM_HEADERS environment variable'
    }
  }

  /** Whether the request goes to an API version that dropped the sampling params and assistant documents. */
  private _usesCurrentApiVersion(): boolean {
    return this._apiVersion !== undefined && this._apiVersion >= SAMPLING_PARAMS_REMOVED_VERSION
  }

  /** The API rejects these params with a 400, so a request that carries them fails here with the fixes instead. */
  private _rejectRemovedSamplingParams(request: Record<string, unknown>): void {
    if (!this._usesCurrentApiVersion()) return
    const set = REMOVED_SAMPLING_PARAMS.filter((name) => request[name] !== undefined)
    if (set.length === 0) return
    throw new Error(
      `${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} not supported by Anthropic API version ` +
        `${this._apiVersion}, ${this._apiVersionOrigin}. Remove the ${set.length === 1 ? 'param' : 'params'}, or pin API ` +
        `version 2023-06-01 for models that still honor them: ` +
        `clientConfig: { defaultHeaders: { 'anthropic-version': '2023-06-01' } }`
    )
  }

  /** Resolves a cache section, disabled when `cacheConfig` is unset or its strategy is unknown. */
  private _cacheSection(section: 'toolsTTL' | 'messagesTTL' | 'systemPromptTTL'): ResolvedCacheSection {
    const cacheConfig = this._config.cacheConfig
    if (!cacheConfig) {
      return { enabled: false }
    }

    const strategy = cacheConfig.strategy ?? 'auto'
    if (strategy !== 'auto' && strategy !== 'anthropic') {
      logger.warn(`strategy=<${strategy}> | unknown cache strategy, prompt caching disabled`)
      return { enabled: false }
    }
    if (strategy === 'auto' && this.modelInfo.capabilities?.promptCaching === 'unsupported') {
      warnOnce(
        logger,
        `model_id=<${this._config.modelId}> | cacheConfig is enabled but the model info says this model does not support prompt caching, ignoring`
      )
      return { enabled: false }
    }

    return resolveCacheSection(cacheConfig[section], cacheConfig.ttl)
  }

  /** Builds an Anthropic `cache_control` value. A falsy `ttl` leaves the API default. */
  private _formatCacheControl(ttl?: string): Anthropic.CacheControlEphemeral {
    const cacheControl: Anthropic.CacheControlEphemeral = { type: ANTHROPIC_CACHE_TYPE }
    if (ttl) {
      // The API validates TTL values server-side, so any string is passed through.
      cacheControl.ttl = ttl as NonNullable<Anthropic.CacheControlEphemeral['ttl']>
    }
    return cacheControl
  }

  /**
   * Marks the last formatted block the API accepts `cache_control` on, mutating `content` in place.
   * Scans backwards because the nearest block may be a rejected type or dropped in translation.
   *
   * @returns True when a block was marked.
   */
  private _attachCacheControl(content: Anthropic.ContentBlockParam[], ttl?: string, skipTrailing = 0): boolean {
    // Skip trailing blocks rebuilt every call so the cache point stays ahead of them; a prefix that
    // changes every call is written every call and never read.
    for (let i = content.length - 1 - skipTrailing; i >= 0; i--) {
      const block = content[i]
      if (block && this._isCacheableBlock(block)) {
        block.cache_control = this._formatCacheControl(ttl)
        return true
      }
    }

    return false
  }

  /**
   * Formats the system prompt for the Anthropic API, auto-injecting a cache point at its end.
   *
   * @param systemPrompt - The system prompt as a string or content blocks.
   * @returns The API system value (string or text blocks), or undefined when nothing cacheable remains.
   */
  private _formatSystemPrompt(systemPrompt: SystemPrompt): string | Anthropic.TextBlockParam[] | undefined {
    const systemCache = this._cacheSection('systemPromptTTL')

    if (typeof systemPrompt === 'string') {
      if (!systemCache.enabled) return systemPrompt
      return [{ type: 'text', text: systemPrompt, cache_control: this._formatCacheControl(systemCache.ttl) }]
    }

    const systemBlocks: Anthropic.TextBlockParam[] = []
    let hasPlacedCachePoint = false
    for (let index = 0; index < systemPrompt.length; index++) {
      const block = systemPrompt[index]
      if (!block) continue
      if (block.type === 'guardContentBlock') {
        logger.warn(
          'block_type=<guardContentBlock> | guard content not supported in anthropic system prompt | skipping'
        )
        continue
      }
      if (block.type !== 'textBlock') continue

      const nextBlock = systemPrompt[index + 1]
      const cacheControl =
        nextBlock?.type === 'cachePointBlock' ? this._formatCacheControl(nextBlock.ttl || systemCache.ttl) : undefined
      systemBlocks.push({ type: 'text', text: block.text, ...(cacheControl && { cache_control: cacheControl }) })
      if (cacheControl) {
        hasPlacedCachePoint = true
        index++
      }
    }

    if (systemBlocks.length === 0) return undefined

    if (systemCache.enabled && !hasPlacedCachePoint) {
      const lastBlock = systemBlocks[systemBlocks.length - 1]
      if (lastBlock) lastBlock.cache_control = this._formatCacheControl(systemCache.ttl)
    }

    return systemBlocks
  }

  private _formatRequest(messages: Message[], options?: StreamOptions): Anthropic.MessageStreamParams {
    if (!this._config.modelId) throw new Error('Model ID is required')
    if (this._serverSideSummary()) messages = fromLastCompaction(messages)

    const messagesCache = this._cacheSection('messagesTTL')
    // The cache point goes on the last user message with content, not counting cache point blocks.
    let cacheTargetMessage = -1
    if (messagesCache.enabled) {
      for (let messageIndex = messages.length - 1; messageIndex >= 0 && cacheTargetMessage < 0; messageIndex--) {
        const message = messages[messageIndex]
        if (message?.role === 'user' && message.content.some((block) => block.type !== 'cachePointBlock')) {
          cacheTargetMessage = messageIndex
        }
      }
    }

    const request: Anthropic.MessageStreamParams = {
      model: this._config.modelId,
      max_tokens: this._resolvedMaxTokens(),
      messages: this._formatMessages(messages, messagesCache, cacheTargetMessage, options?.dynamicTrailingBlocks ?? 0),
      stream: true,
    }

    if (options?.systemPrompt) {
      const system = this._formatSystemPrompt(options.systemPrompt)
      if (system !== undefined) request.system = system
    }

    const tools: Anthropic.ToolUnion[] = (options?.toolSpecs ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }))
    const serverTools = [
      ...(this._config.anthropicTools ?? []),
      ...((this._config.params?.tools as Anthropic.ToolUnion[] | undefined) ?? []),
    ]
    // Forcing a tool means this turn must call a function tool, so server tools are left out.
    if (!options?.toolChoice || 'auto' in options.toolChoice) {
      // Copied so the cache_control below never lands on the caller's config.
      tools.push(...serverTools.map((tool) => ({ ...tool })))
    } else if (serverTools.length > 0) {
      logger.warn(
        `tool_choice=<${Object.keys(options.toolChoice)[0]}>, server_tools=<${serverTools.map(serverToolName).join(',')}> | forced tool call, omitting server tools`
      )
    }

    // A cache_control on the last tool caches all of them, so one cache point suffices.
    const toolsCache = this._cacheSection('toolsTTL')
    const lastTool = tools[tools.length - 1]
    if (toolsCache.enabled && lastTool) {
      lastTool.cache_control = this._formatCacheControl(toolsCache.ttl)
    }

    if (tools.length > 0 && options?.toolChoice) {
      if ('auto' in options.toolChoice) {
        request.tool_choice = { type: 'auto' }
      } else if ('any' in options.toolChoice) {
        request.tool_choice = { type: 'any' }
      } else if ('tool' in options.toolChoice) {
        request.tool_choice = { type: 'tool', name: options.toolChoice.tool.name }
      }
    }

    const sampling: Record<string, number> = {}
    if (this._config.temperature !== undefined) sampling.temperature = this._config.temperature
    if (this._config.topP !== undefined) sampling.top_p = this._config.topP
    if (this._config.stopSequences !== undefined) request.stop_sequences = this._config.stopSequences
    Object.assign(request, sampling, this._config.params)
    this._rejectRemovedSamplingParams(request)
    const dropBlockThinking = this._dropsStaleThinking() ? thinkingWithDropBlock(request.thinking) : undefined
    if (dropBlockThinking) request.thinking = dropBlockThinking
    // params.tools is already merged into tools above; never let it bypass the forced-turn rule.
    if (tools.length > 0) request.tools = tools
    else delete request.tools

    return request
  }

  private _formatMessages(
    messages: Message[],
    messagesCache: ResolvedCacheSection = { enabled: false },
    cacheTargetMessage = -1,
    dynamicTrailingBlocks = 0
  ): Anthropic.MessageParam[] {
    let strippedCachePoints = 0
    const cacheManaged = messagesCache.enabled

    const formatted = messages.map((msg, messageIndex) => {
      const role = (msg.role as string) === 'tool' ? 'user' : msg.role
      const isCacheTarget = cacheManaged && messageIndex === cacheTargetMessage

      const content: Anthropic.ContentBlockParam[] = []
      let marked = false
      let honored = false

      for (const block of msg.content) {
        if (!block) continue

        if (block.type === 'cachePointBlock') {
          if (!cacheManaged) {
            if (!this._attachCacheControl(content, block.ttl)) {
              logger.warn('no preceding block accepts a cache point | skipped cache point')
            }
          } else if (isCacheTarget && !honored) {
            // A TTL written on the point is more specific than the configured one.
            honored = true
            marked = this._attachCacheControl(content, block.ttl || messagesCache.ttl)
            if (!marked) {
              logger.warn(
                `msg_idx=<${messageIndex}> | nothing ahead of the placed cache point can carry one, ` +
                  `falling back to automatic placement`
              )
            }
          } else {
            strippedCachePoints += 1
          }
          continue
        }

        const formattedBlock = this._formatContentBlock(block)
        if (!formattedBlock) continue
        if (formattedBlock.type === 'document' && role === 'assistant' && this._usesCurrentApiVersion()) {
          logger.warn(
            `msg_idx=<${messageIndex}>, api_version=<${this._apiVersion}> | document blocks are not accepted in ` +
              `assistant messages, skipping`
          )
          continue
        }
        content.push(formattedBlock)
      }

      // Placed after formatting so the cache point lands on a block that survived translation.
      // Per-call trailing blocks apply only to the cache-target message, where a producer appends
      // content rebuilt every call.
      if (isCacheTarget && !marked) {
        if (this._attachCacheControl(content, messagesCache.ttl, dynamicTrailingBlocks)) {
          logger.debug(`msg_idx=<${messageIndex}> | added cache point to last user message`)
        } else {
          logger.debug(`msg_idx=<${messageIndex}> | no cacheable content block, skipped cache point`)
        }
      }

      return {
        role: role as 'user' | 'assistant',
        content,
      }
    })

    if (strippedCachePoints > 0) {
      logger.warn(
        `count=<${strippedCachePoints}> | stripped extra cache points, cacheConfig keeps the first cache ` +
          `point in the last user message; unset cacheConfig to keep every cache point`
      )
    }

    return requestMessages(messages, formatted, this.modelInfo.capabilities?.temporaryMessages === true)
  }

  private _isCacheableBlock(
    block: Anthropic.ContentBlockParam | Anthropic.ToolResultBlockParam
  ): block is (
    | Anthropic.TextBlockParam
    | Anthropic.ImageBlockParam
    | Anthropic.ToolUseBlockParam
    | Anthropic.ToolResultBlockParam
    | Anthropic.DocumentBlockParam
  ) & { cache_control?: { type: 'ephemeral' } } {
    return ['text', 'image', 'tool_use', 'tool_result', 'document'].includes(block.type)
  }

  private _formatContentBlock(
    block: ContentBlock
  ): Anthropic.ContentBlockParam | Anthropic.ToolResultBlockParam | undefined {
    switch (block.type) {
      case 'textBlock':
        return { type: 'text', text: block.text }

      case 'summaryBlock':
        return this._formatSummary(block)

      case 'imageBlock': {
        const imgBlock = block as ImageBlock
        let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

        switch (imgBlock.format) {
          case 'jpeg':
          case 'jpg':
            mediaType = 'image/jpeg'
            break
          case 'png':
            mediaType = 'image/png'
            break
          case 'gif':
            mediaType = 'image/gif'
            break
          case 'webp':
            mediaType = 'image/webp'
            break
          default:
            throw new Error(`Unsupported image format for Anthropic: ${imgBlock.format}`)
        }

        switch (imgBlock.source.type) {
          case 'imageSourceBytes':
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: encodeBase64(imgBlock.source.bytes),
              },
            }
          case 'imageSourceUrl':
            return {
              type: 'image',
              source: {
                type: 'url',
                url: imgBlock.source.url,
              },
            }
          case 'imageSourceS3Location':
            logger.warn(
              'source_type=<imageSourceS3Location> | s3 location sources are not supported by anthropic | skipping'
            )
            return undefined
          default:
            throw new Error(`Unsupported image source for Anthropic: ${(imgBlock.source as { type: string }).type}`)
        }
      }

      case 'documentBlock': {
        const docBlock = block as DocumentBlock

        if (docBlock.format === 'pdf' && docBlock.source.type === 'documentSourceBytes') {
          return {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: encodeBase64(docBlock.source.bytes),
            },
            ...(docBlock.name && { title: docBlock.name }),
          } as unknown as Anthropic.ContentBlockParam
        }

        if (TEXT_FILE_FORMATS.includes(docBlock.format)) {
          let textContent: string | undefined

          if (docBlock.source.type === 'documentSourceText') {
            textContent = docBlock.source.text
          } else if (docBlock.source.type === 'documentSourceBytes') {
            if (typeof TextDecoder !== 'undefined') {
              textContent = new TextDecoder().decode(docBlock.source.bytes)
            } else {
              logger.warn(`format=<${docBlock.format}> | cannot decode document bytes | TextDecoder not available`)
            }
          }

          if (textContent) {
            return {
              type: 'text',
              text: textContent,
            }
          }
        }

        throw new Error(
          `Unsupported document format or source for Anthropic: format=${docBlock.format}, source=${docBlock.source.type}`
        )
      }

      case 'toolUseBlock':
        return {
          type: 'tool_use',
          id: block.toolUseId,
          name: block.name,
          input: block.input as Record<string, unknown>,
        }

      case 'videoBlock':
        logger.warn('block_type=<videoBlock> | video blocks not supported by anthropic, skipping')
        return undefined

      case 'toolResultBlock': {
        const innerContent = block.content
          .map((c) => {
            if (c.type === 'textBlock') return { type: 'text' as const, text: c.text }
            if (c.type === 'jsonBlock') return { type: 'text' as const, text: JSON.stringify(c.json) }

            // Recursively format any other content block (image, document, video, etc.)
            const formatted = this._formatContentBlock(c as unknown as ContentBlock)
            return formatted
          })
          .filter((c): c is NonNullable<typeof c> => !!c)

        let contentVal: string | Anthropic.ContentBlockParam[]

        const firstItem = innerContent[0]
        if (innerContent.length === 1 && firstItem && firstItem.type === 'text') {
          contentVal = firstItem.text
        } else {
          contentVal = innerContent
        }

        return {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: contentVal,
          is_error: block.status === 'error',
        } as Anthropic.ToolResultBlockParam
      }

      case 'reasoningBlock':
        if (block.signature) {
          return {
            type: 'thinking',
            thinking: block.text ?? '',
            signature: block.signature,
          } as unknown as Anthropic.ContentBlockParam
        } else if (block.redactedContent) {
          return {
            type: 'redacted_thinking',
            data: encodeBase64(block.redactedContent),
          } as unknown as Anthropic.ContentBlockParam
        }
        return undefined

      case 'citationsBlock': {
        const text = block.content.map((generated) => generated.text).join('')
        return text ? { type: 'text', text } : undefined
      }

      case 'cachePointBlock':
        return undefined

      default:
        return undefined
    }
  }

  /**
   * Maps an Anthropic citation onto a Strands citation.
   *
   * @param citation - Citation from a `citations_delta` event
   * @returns The mapped citation, or `undefined` when the location type has no Strands equivalent
   */
  private _formatCitation(citation: Anthropic.TextCitation): Citation | undefined {
    const citedText = 'cited_text' in citation && citation.cited_text ? [{ text: citation.cited_text }] : []

    switch (citation.type) {
      case 'web_search_result_location': {
        const url = citation.url ?? ''
        let domain: string | undefined
        try {
          domain = new URL(url).hostname
        } catch {
          domain = undefined
        }
        return {
          location: { type: 'web', url, ...(domain ? { domain } : {}) },
          source: url,
          sourceContent: citedText,
          title: citation.title ?? '',
        }
      }

      case 'search_result_location':
        return {
          location: {
            type: 'searchResult',
            searchResultIndex: citation.search_result_index,
            start: citation.start_block_index,
            end: citation.end_block_index,
          },
          source: citation.source,
          sourceContent: citedText,
          title: citation.title ?? '',
        }

      case 'char_location':
        return {
          location: {
            type: 'documentChar',
            documentIndex: citation.document_index,
            start: citation.start_char_index,
            end: citation.end_char_index,
          },
          source: citation.file_id ?? '',
          sourceContent: citedText,
          title: citation.document_title ?? '',
        }

      case 'page_location':
        return {
          location: {
            type: 'documentPage',
            documentIndex: citation.document_index,
            start: citation.start_page_number,
            end: citation.end_page_number,
          },
          source: citation.file_id ?? '',
          sourceContent: citedText,
          title: citation.document_title ?? '',
        }

      case 'content_block_location':
        return {
          location: {
            type: 'documentChunk',
            documentIndex: citation.document_index,
            start: citation.start_block_index,
            end: citation.end_block_index,
          },
          source: citation.file_id ?? '',
          sourceContent: citedText,
          title: citation.document_title ?? '',
        }

      default:
        logger.warn(`citation_type=<${(citation as { type: string }).type}> | unsupported citation location | skipping`)
        return undefined
    }
  }

  /**
   * Logs a skipped server-side tool block, at warn level when the tool returned an error.
   *
   * @param contentBlock - The `content_block` of a `content_block_start` event
   */
  private _logServerToolBlock(contentBlock: { type: string; content?: unknown }): void {
    const errorCode = (contentBlock.content as { error_code?: string } | undefined)?.error_code
    if (errorCode !== undefined) {
      logger.warn(`block_type=<${contentBlock.type}>, error_code=<${errorCode}> | server-side tool failed`)
    } else {
      logger.debug(`block_type=<${contentBlock.type}> | skipping server-side tool block`)
    }
  }

  private _mapStopReason(anthropicReason: string): string {
    switch (anthropicReason) {
      case 'end_turn':
        return 'endTurn'
      case 'max_tokens':
        return 'maxTokens'
      case 'stop_sequence':
        return 'stopSequence'
      case 'tool_use':
        return 'toolUse'
      case 'pause_turn':
        return 'pauseTurn'
      case 'refusal':
        return 'refusal'
      default:
        logger.warn(`stop_reason=<${anthropicReason}> | unknown anthropic stop reason`)
        return anthropicReason
    }
  }
}

/**
 * Drops the formatted messages left empty, which the API rejects anywhere but the trailing assistant turn. With
 * `temporaryMessages`, each user message's injected text follows it as a turn-scoped system message.
 *
 * @param messages - The messages of the request
 * @param formatted - The formatted messages, one per message
 * @param temporaryMessages - Whether to send injected text as turn-scoped system messages
 * @returns The messages to send
 */
function requestMessages(
  messages: Message[],
  formatted: Anthropic.MessageParam[],
  temporaryMessages: boolean
): Anthropic.MessageParam[] {
  const kept = formatted
    .map((message, index) => ({ message, source: messages[index]! }))
    .filter(({ message }) => message.content.length > 0)
  if (!temporaryMessages) return kept.map(({ message }) => message)
  return kept.flatMap(({ message, source }, index) => {
    const systemMessage = turnScopedSystemMessage(source)
    // The API rejects one followed directly by a user message. No assistant turn can have read it, so it is left out.
    if (!systemMessage || message.role !== 'user' || kept[index + 1]?.message.role === 'user') return [message]
    return [message, systemMessage]
  })
}

/**
 * The message's injected text as a system message the model reads only until a later user message exists. Once
 * cleared, it stays in the request but renders nothing, so the history before every later assistant turn is sent
 * unchanged. Never carries `cache_control`: a cleared message is not part of any cache key.
 *
 * @param message - A message of the conversation
 * @returns The system message, or `undefined` when the message has no injected text
 */
function turnScopedSystemMessage(message: Message): TurnScopedSystemMessage | undefined {
  const content = message.content.flatMap((block): Anthropic.TextBlockParam[] =>
    block.type === 'injectedBlock' ? [{ type: 'text', text: block.injected.text }] : []
  )
  if (content.length === 0) return undefined
  return { role: 'system', content, clear_at: 'next_user_message' }
}
