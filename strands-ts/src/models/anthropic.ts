import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import {
  Model,
  type BaseModelConfig,
  type CountTokensOptions,
  type StreamOptions,
  resolveConfigMetadata,
} from '../models/model.js'
import type { Message, ContentBlock } from '../types/messages.js'
import type { ModelStreamEvent } from '../models/streaming.js'
import { createEmptyUsage } from '../models/streaming.js'
import { ContextWindowOverflowError, ModelThrottledError, normalizeError } from '../errors.js'
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
// Content block types the agent itself acts on.
const CLIENT_SIDE_BLOCK_TYPES = new Set(['redacted_thinking', 'text', 'thinking', 'tool_use'])

// Content block types Anthropic produces for tools it resolves server side. The search / fetch /
// execution already happened inside Anthropic's infrastructure, so these must not be replayed as
// toolUse blocks: the event loop would try to run them locally, and the resulting dangling tool_use
// ids would be rejected on the next request.
//
// Blocks that represent an invocation, and therefore carry a tool `name` rather than a result. Split
// out only to pick the right log message.
const SERVER_TOOL_USE_BLOCK_TYPES = new Set(['mcp_tool_use', 'server_tool_use'])

const SERVER_TOOL_RESULT_BLOCK_TYPES = new Set([
  'bash_code_execution_tool_result',
  'code_execution_tool_result',
  'container_upload',
  'mcp_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  'web_fetch_tool_result',
  'web_search_tool_result',
])

const SERVER_TOOL_BLOCK_TYPES = new Set([...SERVER_TOOL_USE_BLOCK_TYPES, ...SERVER_TOOL_RESULT_BLOCK_TYPES])

const PARAMS_TOOLS_WARNING =
  'params.tools is deprecated and previously overwrote every function tool definition, silently ' +
  "disabling the agent's tools. The value is now appended to the request instead. Use the " +
  '`anthropicTools` config option for Anthropic server-side tools (e.g. web_search) and the standard ' +
  'tools interface for function tools.'

const TEXT_FILE_FORMATS = ['txt', 'md', 'markdown', 'csv', 'json', 'xml', 'html', 'yml', 'yaml', 'js', 'ts', 'py']

/**
 * Coerces a tool-list-ish value into an array of Anthropic tool objects.
 *
 * A bare object is a common mistake and unambiguous, so it is wrapped. Anything else (a string, a
 * number) would be spread element-by-element, turning one mistake into a request full of nonsense
 * tools, so it is rejected. Silently discarding it is not an option either: the deprecation warning
 * promises the value was appended.
 *
 * @param value - The user-supplied value
 * @param label - Human-readable name of the option, used in the error message
 * @returns The value as an array of tools
 * @throws Error - When the value is neither an object nor an array of objects
 */
function normalizeAnthropicTools(value: unknown, label: string): Anthropic.ToolUnion[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value as Anthropic.ToolUnion[]
  if (typeof value === 'object') return [value as Anthropic.ToolUnion]

  throw new Error(
    `${label} must be an array of Anthropic tool objects ` +
      `(e.g. [{ type: 'web_search_20260318', name: 'web_search' }]), got ${typeof value}.`
  )
}

/**
 * Validates that `anthropicTools` does not contain function tool definitions.
 *
 * Anthropic-specific tools should only include tools Anthropic resolves server side and that therefore
 * cannot be expressed as a function tool (e.g. `web_search`, `web_fetch`, `code_execution`). Standard
 * function calling tools belong in the tools interface. Mirrors Python's `_validate_anthropic_tools`.
 *
 * @param anthropicTools - The configured server-side tools
 * @throws Error - When an entry is not an object, looks like a function tool, or is missing `type`
 */
function validateAnthropicTools(anthropicTools: unknown): void {
  for (const tool of normalizeAnthropicTools(anthropicTools, 'anthropicTools')) {
    if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) {
      throw new Error(
        "anthropicTools entries must be Anthropic tool objects (e.g. { type: 'web_search_20260318', " +
          `name: 'web_search' }), got ${Array.isArray(tool) ? 'array' : typeof tool}.`
      )
    }

    if ('input_schema' in tool) {
      throw new Error(
        'anthropicTools should not contain function tool definitions. Use the standard tools interface ' +
          'for function calling tools. anthropicTools is reserved for Anthropic-specific server-side ' +
          'tools like web_search, web_fetch, code_execution, memory, text_editor, and bash.'
      )
    }

    if (!(tool as { type?: string }).type) {
      throw new Error(
        'anthropicTools entries must carry the versioned `type` string for the tool (e.g. ' +
          "'web_search_20260318'). See https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview"
      )
    }
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
  /**
   * Additional parameters merged into the request (e.g. `temperature`, `thinking`).
   *
   * Do not pass `tools` here. Use {@link AnthropicModelConfig.anthropicTools} instead so that
   * server-side tools are appended to, rather than replacing, the agent's function tools.
   */
  params?: Record<string, unknown>

  /**
   * Anthropic-specific tools that are not function tools (e.g. `web_search`, `web_fetch`,
   * `code_execution`, `memory`, `text_editor`, `bash`).
   *
   * These run server side inside Anthropic's infrastructure and are appended alongside the function
   * tool definitions rather than replacing them. Use the standard tools interface for function
   * calling tools.
   *
   * The versioned `type` string is supplied by the caller, e.g.
   * `{ type: 'web_search_20260318', name: 'web_search' }`.
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

    if (modelConfig.anthropicTools !== undefined) validateAnthropicTools(modelConfig.anthropicTools)

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
    if ('anthropicTools' in modelConfig) validateAnthropicTools(modelConfig.anthropicTools)

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
      const request = this._formatRequest(messages, options)
      const requestOptions = this._buildRequestOptions()
      const stream = requestOptions
        ? this._client.messages.stream(request, requestOptions)
        : this._client.messages.stream(request)

      const usage = createEmptyUsage()

      let stopReason = 'endTurn'

      // Indexes of content blocks Anthropic ran server side. Their input_json_delta events describe a
      // tool the agent never executes, so replaying them would corrupt the streaming tool-use state.
      const serverToolBlockIndexes = new Set<number>()

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            usage.inputTokens = event.message.usage.input_tokens

            const rawUsage = event.message.usage as unknown as Record<string, number | undefined>
            if (rawUsage.cache_creation_input_tokens !== undefined) {
              usage.cacheWriteInputTokens = rawUsage.cache_creation_input_tokens
            }
            if (rawUsage.cache_read_input_tokens !== undefined) {
              usage.cacheReadInputTokens = rawUsage.cache_read_input_tokens
            }

            yield {
              type: 'modelMessageStartEvent',
              role: event.message.role,
            }
            break
          }

          case 'content_block_start':
            if (SERVER_TOOL_BLOCK_TYPES.has(event.content_block.type)) {
              // Anthropic already resolved this tool. Skip the whole block, start and stop included,
              // so it leaves no empty content block behind.
              serverToolBlockIndexes.add(event.index)
              this._logServerToolBlock(event.content_block)
              break
            }

            if (!CLIENT_SIDE_BLOCK_TYPES.has(event.content_block.type)) {
              // Forward rather than suppress: dropping a block type we simply do not know about would
              // lose content silently, which is worse than the degraded handling below. Warn loudly so
              // a newly shipped Anthropic block type shows up instead of quietly misbehaving.
              logger.warn(
                `block_type=<${event.content_block.type}> | unrecognized content block type | forwarding | ` +
                  'if anthropic resolves this server side its input deltas may be replayed as function tool input'
              )
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
              // `content` is left empty: the text this citation grounds streams as textDeltas, and
              // model.ts falls back to the accumulated text when a citations delta carries none.
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
            if (serverToolBlockIndexes.has(event.index)) {
              // Release the index: Anthropic reuses indexes, so a later client-side block at the same
              // index must still stream.
              serverToolBlockIndexes.delete(event.index)
              break
            }

            yield { type: 'modelContentBlockStopEvent' }
            break

          case 'message_delta':
            if (event.usage) {
              usage.outputTokens = event.usage.output_tokens
            }
            if (event.delta.stop_reason) {
              stopReason = this._mapStopReason(event.delta.stop_reason)
            }
            break

          case 'message_stop':
            usage.totalTokens = usage.inputTokens + usage.outputTokens
            yield {
              type: 'modelMetadataEvent',
              usage,
            }
            yield {
              type: 'modelMessageStopEvent',
              stopReason,
            }
            break
        }
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

  private _formatRequest(messages: Message[], options?: StreamOptions): Anthropic.MessageStreamParams {
    if (!this._config.modelId) throw new Error('Model ID is required')

    const request: Anthropic.MessageStreamParams = {
      model: this._config.modelId,
      max_tokens: this._config.maxTokens ?? MODEL_DEFAULTS.anthropic.maxTokens,
      messages: this._formatMessages(messages),
      stream: true,
    }

    if (options?.systemPrompt) {
      if (typeof options.systemPrompt === 'string') {
        request.system = options.systemPrompt
      } else if (Array.isArray(options.systemPrompt)) {
        const systemBlocks: Anthropic.TextBlockParam[] = []
        for (let i = 0; i < options.systemPrompt.length; i++) {
          const block = options.systemPrompt[i]
          if (!block) continue

          if (block.type === 'textBlock') {
            const nextBlock = options.systemPrompt[i + 1]
            const cacheControl = nextBlock?.type === 'cachePointBlock' ? { type: 'ephemeral' as const } : undefined

            systemBlocks.push({
              type: 'text',
              text: block.text,
              ...(cacheControl && { cache_control: cacheControl }),
            })

            if (cacheControl) i++
          } else if (block.type === 'guardContentBlock') {
            logger.warn(
              'block_type=<guardContentBlock> | guard content not supported in anthropic system prompt | skipping'
            )
          }
        }
        if (systemBlocks.length > 0) request.system = systemBlocks
      }
    }

    const tools: Anthropic.ToolUnion[] = (options?.toolSpecs ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }))

    if (options?.toolSpecs?.length && options.toolChoice) {
      if ('auto' in options.toolChoice) {
        request.tool_choice = { type: 'auto' }
      } else if ('any' in options.toolChoice) {
        request.tool_choice = { type: 'any' }
      } else if ('tool' in options.toolChoice) {
        request.tool_choice = { type: 'tool', name: options.toolChoice.tool.name }
      }
    }

    // Server-side tools are additive: they extend the function tool definitions instead of replacing
    // them (mirrors GoogleModel's builtInTools).
    if (this._config.anthropicTools?.length) tools.push(...this._config.anthropicTools)

    if (this._config.temperature !== undefined) request.temperature = this._config.temperature
    if (this._config.topP !== undefined) request.top_p = this._config.topP
    if (this._config.stopSequences !== undefined) request.stop_sequences = this._config.stopSequences

    if (this._config.params) {
      const { tools: paramsTools, ...restParams } = this._config.params
      if (paramsTools !== undefined) {
        warnOnce(logger, PARAMS_TOOLS_WARNING)
        tools.push(...normalizeAnthropicTools(paramsTools, 'params.tools'))
      }
      Object.assign(request, restParams)
    }

    // Assigned after params so a stale `tools` key can never clobber the merged list.
    if (tools.length > 0) request.tools = tools

    return request
  }

  private _formatMessages(messages: Message[]): Anthropic.MessageParam[] {
    return messages.map((msg) => {
      const role = (msg.role as string) === 'tool' ? 'user' : msg.role

      const content: Anthropic.ContentBlockParam[] = []

      for (let i = 0; i < msg.content.length; i++) {
        const block = msg.content[i]
        if (!block) continue

        const nextBlock = msg.content[i + 1]
        const hasCachePoint = nextBlock?.type === 'cachePointBlock'

        const formattedBlock = this._formatContentBlock(block)

        if (formattedBlock) {
          if (hasCachePoint && this._isCacheableBlock(formattedBlock)) {
            formattedBlock.cache_control = { type: 'ephemeral' }
            i++
          }
          content.push(formattedBlock)
        }
      }

      return {
        role: role as 'user' | 'assistant',
        content,
      }
    })
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

        if (imgBlock.source.type === 'imageSourceBytes') {
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: encodeBase64(imgBlock.source.bytes),
            },
          }
        }
        logger.warn('source_type=<imageSourceUrl> | anthropic requires image bytes | url sources not fully supported')
        return undefined
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

        logger.warn(`format=<${docBlock.format}> | unsupported document format or source for anthropic`)
        return undefined
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
        // Citations are output-only for Anthropic: `web_search_result_location` citations describe a
        // search Anthropic already ran and cannot be sent back as input. Preserve the generated text
        // so a cited answer survives into the next turn instead of being silently dropped.
        const citedText = block.content.map((generated) => generated.text).join('')
        if (!citedText.trim()) {
          // Anthropic rejects empty text blocks ("text content blocks must contain non-whitespace
          // text"). Providers that stream citations separately from the text they ground can produce a
          // citations block with no generated text, so drop it rather than sending a certain 400.
          logger.debug('citations block has no generated text | skipping content block')
          return undefined
        }
        return { type: 'text', text: citedText }
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
   * Server-side web search attaches `web_search_result_location` citations to the text blocks it
   * grounds; those carry the source url, title and cited source text, and the url also yields the
   * domain that the `web` location exposes.
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
        // Anthropic's end_block_index is exclusive (a single-block citation has end = start + 1);
        // copied through as-is.
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
        // Anthropic page numbers are 1-based; copied through as-is.
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
   * Logs a server-side tool block that has no equivalent Strands content block type.
   *
   * Result errors (e.g. `max_uses_exceeded`, `unavailable`) are logged as warnings so a server-side
   * search that returned nothing is never silent.
   *
   * @param contentBlock - The `content_block` from a `content_block_start` event
   */
  private _logServerToolBlock(contentBlock: { type: string; name?: string; content?: unknown }): void {
    if (SERVER_TOOL_USE_BLOCK_TYPES.has(contentBlock.type)) {
      logger.debug(
        `block_type=<${contentBlock.type}>, tool_name=<${contentBlock.name}> | anthropic executed this tool server side`
      )
      return
    }

    const content = contentBlock.content
    const errorCode =
      content && typeof content === 'object' && 'error_code' in content
        ? (content as { error_code?: string }).error_code
        : undefined

    if (errorCode !== undefined) {
      logger.warn(`block_type=<${contentBlock.type}>, error_code=<${errorCode}> | server-side tool returned an error`)
      return
    }

    logger.debug(
      `block_type=<${contentBlock.type}>, result_count=<${Array.isArray(content) ? content.length : 'n/a'}> | ` +
        'server-side tool result has no content block representation | citations on the following text blocks ' +
        'carry the cited sources'
    )
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
