import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import {
  Model,
  type BaseModelConfig,
  type CountTokensOptions,
  type StreamOptions,
  resolveConfigMetadata,
  resolveCacheSection,
  type CacheConfig,
  type ResolvedCacheSection,
} from '../models/model.js'
import type { Message, ContentBlock, SystemPrompt } from '../types/messages.js'
import type { ModelStreamEvent } from '../models/streaming.js'
import { createEmptyUsage } from '../models/streaming.js'
import { ContextWindowOverflowError, ModelError, ModelThrottledError, normalizeError } from '../errors.js'
import type { Citation } from '../types/citations.js'
import type { ImageBlock, DocumentBlock } from '../types/media.js'
import { encodeBase64 } from '../types/media.js'
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

/**
 * `ephemeral` is the only cache type the Anthropic API supports.
 */
// Anthropic pauses a long server-side tool turn with stop_reason=pause_turn and expects the paused
// assistant message to be sent back as-is to resume it. Bounds how many times stream() does so.
const MAX_PAUSE_TURN_CONTINUATIONS = 10

const ANTHROPIC_CACHE_TYPE = 'ephemeral' as const

const TEXT_FILE_FORMATS = ['txt', 'md', 'markdown', 'csv', 'json', 'xml', 'html', 'yml', 'yaml', 'js', 'ts', 'py']

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

/**
 * Copies the numeric fields of an Anthropic usage object; `null` fields leave the existing value in place.
 */
function mergeUsage(target: Record<string, number>, source: object): void {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number') target[key] = value
  }
}

export interface AnthropicModelConfig extends BaseModelConfig {
  /**
   * Maximum number of tokens the model can generate in a response.
   *
   * @defaultValue 64000 — subject to change between versions.
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

export interface AnthropicModelOptions extends AnthropicModelConfig {
  apiKey?: string
  client?: Anthropic
  clientConfig?: ClientOptions
}

export class AnthropicModel extends Model<AnthropicModelConfig> {
  private _config: AnthropicModelConfig
  private _client: Anthropic

  constructor(options?: AnthropicModelOptions) {
    super()
    const { apiKey, client, clientConfig, ...modelConfig } = options || {}

    this._config = {
      modelId: MODEL_DEFAULTS.anthropic.modelId,
      maxTokens: MODEL_DEFAULTS.anthropic.maxTokens,
      ...modelConfig,
    }

    if (modelConfig.anthropicTools) validateAnthropicTools(modelConfig.anthropicTools)

    if (modelConfig.modelId === undefined) {
      warnOnce(logger, defaultModelWarningMessage(MODEL_DEFAULTS.anthropic.modelId))
    }

    if (modelConfig.maxTokens === undefined) {
      warnOnce(logger, defaultMaxTokensWarningMessage(MODEL_DEFAULTS.anthropic.maxTokens))
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
    }
  }

  updateConfig(modelConfig: AnthropicModelConfig): void {
    if (modelConfig.anthropicTools) validateAnthropicTools(modelConfig.anthropicTools)

    this._config = { ...this._config, ...modelConfig }
  }

  getConfig(): AnthropicModelConfig {
    return resolveConfigMetadata(this._config, this._config.modelId ?? MODEL_DEFAULTS.anthropic.modelId)
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
    if (this._config.useNativeTokenCount !== true) return super.countTokens(messages, options)

    try {
      const request = this._formatRequest(messages, options)
      const params: Anthropic.MessageCountTokensParams = {
        model: request.model,
        messages: request.messages,
        ...(request.system && { system: request.system }),
        ...(request.tools && { tools: request.tools }),
        ...(request.tool_choice && { tool_choice: request.tool_choice }),
      }

      const requestOptions = this._buildRequestOptions()
      const response = requestOptions
        ? await this._client.messages.countTokens(params, requestOptions)
        : await this._client.messages.countTokens(params)

      logger.debug(`total_tokens=<${response.input_tokens}> | native token count`)
      return response.input_tokens
    } catch (error) {
      logger.debug(`error=<${error}> | native token counting failed, falling back to estimation`)
      return super.countTokens(messages, options)
    }
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    try {
      let request = this._formatRequest(messages, options)
      const requestOptions = this._buildRequestOptions()
      const usage = createEmptyUsage()
      let continuations = 0

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
                    redactedContent: event.content_block.data as unknown as Uint8Array,
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

        usage.totalTokens = usage.inputTokens + usage.outputTokens
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
      const error = normalizeError(unknownError)

      const lowered = error.message.toLowerCase()
      if (CONTEXT_WINDOW_OVERFLOW_ERRORS.some((msg) => lowered.includes(msg))) {
        throw new ContextWindowOverflowError(error.message)
      }

      const err = unknownError as Error & { status?: number }
      if (err.status === 429) {
        const message = error.message ?? 'Request was throttled by the model provider'
        logger.debug(`throttled | error_message=<${message}>`)
        throw new ModelThrottledError(message, { cause: err })
      }

      throw error
    }
  }

  private _buildRequestOptions(): Anthropic.RequestOptions | undefined {
    const betas = this._config.betas
    if (!betas || betas.length === 0) return undefined
    return { headers: { 'anthropic-beta': betas.join(',') } }
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
      max_tokens: this._config.maxTokens ?? MODEL_DEFAULTS.anthropic.maxTokens,
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
    // Forcing a tool means this turn must call a function tool, so server tools are left out.
    if (!options?.toolChoice || 'auto' in options.toolChoice) {
      // Copied so the cache_control below never lands on the caller's config.
      const paramsTools = (this._config.params?.tools as Anthropic.ToolUnion[] | undefined) ?? []
      tools.push(...(this._config.anthropicTools ?? []).map((tool) => ({ ...tool })))
      tools.push(...paramsTools.map((tool) => ({ ...tool })))
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

    if (this._config.temperature !== undefined) request.temperature = this._config.temperature
    if (this._config.topP !== undefined) request.top_p = this._config.topP
    if (this._config.stopSequences !== undefined) request.stop_sequences = this._config.stopSequences
    if (this._config.params) Object.assign(request, this._config.params)
    if (tools.length > 0) request.tools = tools

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
        if (formattedBlock) content.push(formattedBlock)
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

    // The API rejects an empty message anywhere but the trailing assistant turn.
    return formatted.filter((msg) => msg.content.length > 0)
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
            data: block.redactedContent,
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
