import {
  Ollama,
  type ChatRequest,
  type ChatResponse,
  type Config,
  type Message as OllamaMessage,
  type Options,
  type Tool as OllamaTool,
} from 'ollama'
import { Model, type BaseModelConfig, type CacheConfig, type StreamOptions, resolveConfigMetadata } from './model.js'
import type { Message, ContentBlock, SystemPrompt, StopReason } from '../types/messages.js'
import type { ModelStreamEvent } from './streaming.js'
import { ContextWindowOverflowError, normalizeError } from '../errors.js'
import { logger } from '../logging/logger.js'
import { warnOnce } from '../logging/warn-once.js'
import { MODEL_DEFAULTS, defaultModelWarningMessage } from './defaults.js'

// Substrings Ollama uses when the prompt outgrows the context window, matched case-insensitively.
const CONTEXT_WINDOW_OVERFLOW_ERRORS = [
  'the prompt is longer than the context length',
  'the input length exceeds the context length',
  'exceeds the available context',
  'exceeded max context length',
]

/**
 * Configuration options for an Ollama model.
 */
export interface OllamaModelConfig extends BaseModelConfig {
  /** Ollama model ID (e.g. `llama3.1`, `mistral`, `phi3`). */
  modelId?: string

  /** Maximum number of tokens to generate, sent to Ollama as `num_predict`. */
  maxTokens?: number

  /** How long the model stays loaded in memory after the request (Ollama default `5m`). */
  keepAlive?: string | number

  /** Sequences that stop generation when encountered, sent to Ollama as `stop`. */
  stopSequences?: string[]

  /** Additional Ollama runtime options (e.g. `top_k`, `num_ctx`), merged into the request `options`. */
  options?: Partial<Options>

  /** Extra fields merged into the top-level chat request for forward compatibility. */
  additionalArgs?: Record<string, unknown>

  /** Prompt caching configuration. Ollama honors no cache fields, so any set field is ignored with a warning. */
  cacheConfig?: CacheConfig
}

/**
 * Constructor options for {@link OllamaModel}: model config plus the client connection fields.
 */
export interface OllamaModelOptions extends OllamaModelConfig {
  /** Address of the Ollama server. Defaults to the client's own `http://127.0.0.1:11434`. */
  host?: string

  /** A preconfigured Ollama client. When provided, `host` and `clientConfig` are ignored. */
  client?: Ollama

  /** Additional Ollama client configuration (e.g. `headers` for a proxied host). */
  clientConfig?: Partial<Config>
}

/**
 * Ollama model provider for locally hosted open-source models.
 *
 * Connects to an Ollama server's chat API and streams text and tool calls. Ollama has no content
 * arrays, so each content block is flattened into its own message.
 *
 * @example
 * ```typescript
 * import { OllamaModel } from '@strands-agents/sdk/models/ollama'
 *
 * const model = new OllamaModel({ host: 'http://localhost:11434', modelId: 'llama3.1' })
 * ```
 */
export class OllamaModel extends Model<OllamaModelConfig> {
  private _config: OllamaModelConfig
  private _client: Ollama

  constructor(options?: OllamaModelOptions) {
    super()
    const { host, client, clientConfig, ...modelConfig } = options || {}

    this._config = {
      modelId: MODEL_DEFAULTS.ollama.modelId,
      ...modelConfig,
    }

    if (modelConfig.modelId === undefined) {
      warnOnce(logger, defaultModelWarningMessage(MODEL_DEFAULTS.ollama.modelId))
    }

    if (client) {
      this._client = client
    } else {
      this._client = new Ollama({
        ...(host ? { host } : {}),
        ...clientConfig,
      })
    }
  }

  updateConfig(modelConfig: OllamaModelConfig): void {
    this._config = { ...this._config, ...modelConfig }
  }

  getConfig(): OllamaModelConfig {
    return resolveConfigMetadata(this._config, this._config.modelId ?? MODEL_DEFAULTS.ollama.modelId)
  }

  /**
   * Streams a conversation with the Ollama model.
   *
   * @param messages - Array of conversation messages
   * @param options - Optional streaming configuration
   * @returns Async iterable of streaming events
   * @throws ContextWindowOverflowError - When the input exceeds the model's context window
   */
  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    if (this._config.cacheConfig) {
      logger.warn('prompt caching is not supported by ollama, ignoring cacheConfig')
    }

    const request = this._formatRequest(messages, options)

    try {
      const response = await this._client.chat(request)
      this._forwardAbort(response, options?.cancelSignal)

      yield { type: 'modelMessageStartEvent', role: 'assistant' }
      yield { type: 'modelContentBlockStartEvent' }

      let toolRequested = false
      let lastChunk: ChatResponse | undefined
      for await (const chunk of response) {
        for (const toolCall of chunk.message.tool_calls ?? []) {
          const toolUseId = `tooluse_${globalThis.crypto.randomUUID()}`
          yield {
            type: 'modelContentBlockStartEvent',
            start: { type: 'toolUseStart', name: toolCall.function.name, toolUseId },
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: JSON.stringify(toolCall.function.arguments) },
          }
          yield { type: 'modelContentBlockStopEvent' }
          toolRequested = true
        }

        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: chunk.message.content } }
        lastChunk = chunk
      }

      yield { type: 'modelContentBlockStopEvent' }

      if (lastChunk) {
        yield {
          type: 'modelMetadataEvent',
          usage: {
            inputTokens: lastChunk.prompt_eval_count ?? 0,
            outputTokens: lastChunk.eval_count ?? 0,
            totalTokens: (lastChunk.prompt_eval_count ?? 0) + (lastChunk.eval_count ?? 0),
          },
          metrics: { latencyMs: Math.round((lastChunk.total_duration ?? 0) / 1e6) },
        }
      }

      yield {
        type: 'modelMessageStopEvent',
        stopReason: toolRequested ? 'toolUse' : this._mapStopReason(lastChunk?.done_reason),
      }
    } catch (unknownError) {
      const error = normalizeError(unknownError)
      const lowered = error.message.toLowerCase()
      if (CONTEXT_WINDOW_OVERFLOW_ERRORS.some((message) => lowered.includes(message))) {
        throw new ContextWindowOverflowError(error.message)
      }
      throw error
    }
  }

  /** Aborts the in-flight request when the caller's signal fires. */
  private _forwardAbort(response: { abort: () => void }, cancelSignal?: AbortSignal): void {
    if (!cancelSignal) return
    if (cancelSignal.aborted) {
      response.abort()
      return
    }
    cancelSignal.addEventListener('abort', () => response.abort(), { once: true })
  }

  private _formatRequest(messages: Message[], options?: StreamOptions): ChatRequest & { stream: true } {
    if (!this._config.modelId) throw new Error('Model ID is required')

    const modelOptions: Partial<Options> = { ...this._config.options }
    if (this._config.maxTokens !== undefined) modelOptions.num_predict = this._config.maxTokens
    if (this._config.temperature !== undefined) modelOptions.temperature = this._config.temperature
    if (this._config.topP !== undefined) modelOptions.top_p = this._config.topP
    if (this._config.stopSequences !== undefined) modelOptions.stop = this._config.stopSequences

    const request: ChatRequest & { stream: true } = {
      model: this._config.modelId,
      messages: this._formatMessages(messages, options?.systemPrompt),
      stream: true,
      options: modelOptions,
    }

    const tools: OllamaTool[] = (options?.toolSpecs ?? []).map((tool): OllamaTool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        ...(tool.inputSchema
          ? { parameters: tool.inputSchema as NonNullable<OllamaTool['function']['parameters']> }
          : {}),
      },
    }))
    if (tools.length > 0) request.tools = tools

    if (this._config.keepAlive !== undefined) request.keep_alive = this._config.keepAlive
    if (this._config.additionalArgs) Object.assign(request, this._config.additionalArgs)

    return request
  }

  private _formatMessages(messages: Message[], systemPrompt?: SystemPrompt): OllamaMessage[] {
    const formatted: OllamaMessage[] = []

    const system = this._formatSystemPrompt(systemPrompt)
    if (system) formatted.push({ role: 'system', content: system })

    for (const message of messages) {
      for (const block of message.content) {
        formatted.push(...this._formatContentBlock(message.role, block))
      }
    }

    return formatted
  }

  /** Flattens the system prompt to a single string; Ollama accepts no cache points or content arrays. */
  private _formatSystemPrompt(systemPrompt?: SystemPrompt): string | undefined {
    if (!systemPrompt) return undefined
    if (typeof systemPrompt === 'string') return systemPrompt

    const text = systemPrompt
      .map((block) => (block.type === 'textBlock' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
    return text || undefined
  }

  /**
   * Flattens a Strands content block into one or more Ollama messages.
   *
   * @param role - The role of the message the block belongs to
   * @param block - The content block to format
   * @returns The Ollama messages, empty when the block has no Ollama equivalent
   */
  private _formatContentBlock(role: string, block: ContentBlock): OllamaMessage[] {
    switch (block.type) {
      case 'textBlock':
        return [{ role, content: block.text }]

      case 'imageBlock':
        if (block.source.type === 'imageSourceBytes') {
          return [{ role, content: '', images: [block.source.bytes] }]
        }
        logger.warn(`source_type=<${block.source.type}> | ollama supports only inline image bytes | skipping`)
        return []

      case 'toolUseBlock':
        return [
          {
            role,
            content: '',
            tool_calls: [{ function: { name: block.name, arguments: block.input as Record<string, unknown> } }],
          },
        ]

      case 'toolResultBlock':
        return block.content.flatMap((item) => {
          if (item.type === 'jsonBlock') return [{ role: 'tool', content: JSON.stringify(item.json) }]
          return this._formatContentBlock('tool', item as ContentBlock)
        })

      default:
        logger.debug(`block_type=<${block.type}> | unsupported by ollama, skipping`)
        return []
    }
  }

  private _mapStopReason(doneReason?: string): StopReason {
    if (doneReason === 'length') return 'maxTokens'
    return 'endTurn'
  }
}
