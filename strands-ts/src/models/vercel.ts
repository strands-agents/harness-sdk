/**
 * Vercel LanguageModelV3 model provider implementation.
 *
 * This module provides integration with any Vercel v3 compatible model provider,
 * supporting streaming responses, tool use, and reasoning content.
 *
 * @see https://github.com/vercel/ai/tree/main/packages/provider/src/language-model/v3
 */
import type {
  JSONObject,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ReasoningPart,
  LanguageModelV3StreamPart,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolChoice,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3ToolResultPart,
  LanguageModelV3Usage,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import type { SystemPrompt, StopReason } from '../types/messages.js'
import type { ToolChoice, ToolSpec } from '../tools/types.js'
import type { ModelStreamEvent, Usage } from './streaming.js'
import { Message, TextBlock, type ToolResultContent } from '../types/messages.js'
import { encodeBase64, ImageBlock, DocumentBlock, VideoBlock } from '../types/media.js'
import {
  Model,
  resolveCacheSection,
  type BaseModelConfig,
  type CacheConfig,
  type CacheTTL,
  type StreamOptions,
} from './model.js'
import { resolveOpenAICache, warnUnsupportedRetention } from './openai/cache.js'
import {
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  ModelMetadataEvent,
} from './streaming.js'
import { ContextWindowOverflowError, ModelError, ModelThrottledError } from '../errors.js'
import { toMimeType } from '../mime.js'
import { logger } from '../logging/logger.js'
import { warnOnce } from '../logging/warn-once.js'

/**
 * Error message patterns that indicate context window overflow.
 * These patterns are common across Vercel providers (Bedrock, OpenAI, Anthropic, etc.).
 */
const CONTEXT_WINDOW_OVERFLOW_PATTERNS = [
  'too many tokens',
  'context length',
  'context_length_exceeded',
  'max_tokens exceeded',
  'too many total text bytes',
  'input is too long for requested model',
  'prompt is too long',
  'input too long',
]

/**
 * Call option fields from LanguageModelV3CallOptions that can be configured.
 * Excludes prompt, tools, and toolChoice which are managed by the agent loop.
 */
type LanguageModelCallSettings = Omit<LanguageModelV3CallOptions, 'prompt' | 'tools' | 'toolChoice'>

/**
 * Configuration for the VercelModel adapter.
 *
 * Extends BaseModelConfig with all LanguageModelV3 call settings (temperature, topP, topK,
 * presencePenalty, frequencyPenalty, stopSequences, seed, etc.). When new fields are added
 * to the Language Model Specification, they become available here automatically.
 *
 * Note: `maxTokens` (from BaseModelConfig) maps to `maxOutputTokens` in the underlying call.
 * If both are set, `maxOutputTokens` takes precedence.
 */
export interface VercelModelConfig extends BaseModelConfig, LanguageModelCallSettings {
  /**
   * Caching configuration, routed by the underlying Vercel provider. Anthropic honors every placement
   * field (`ttl`, `toolsTTL`, `systemPromptTTL`, `messagesTTL`); Bedrock honors `systemPromptTTL` and
   * `messagesTTL`, caches tools as part of that prefix (so `toolsTTL` is inert), and under the default
   * `'auto'` strategy caches only models known to support it; OpenAI honors `cacheKey` and a retention
   * `ttl`; every other provider ignores it with a one-time warning.
   */
  cacheConfig?: CacheConfig
}

/**
 * Options for creating a VercelModel instance.
 */
export interface VercelModelOptions extends Partial<VercelModelConfig> {
  /**
   * A LanguageModelV3 instance from any Vercel provider.
   */
  provider: LanguageModelV3
}

/**
 * Adapter that wraps a LanguageModelV3 instance
 * for use as a Strands model provider.
 *
 * Implements the Model interface for any Vercel v3 compatible provider.
 * Supports streaming responses, tool use, and reasoning content.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { VercelModel } from '@strands-agents/sdk/models/vercel'
 * import { bedrock } from '@ai-sdk/amazon-bedrock'
 *
 * const agent = new Agent({
 *   model: new VercelModel({ provider: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0') }),
 * })
 *
 * for await (const event of agent.stream('Hello!')) {
 *   if (event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta') {
 *     process.stdout.write(event.delta.text)
 *   }
 * }
 * ```
 */
export class VercelModel extends Model<VercelModelConfig> {
  private _provider: LanguageModelV3
  private _config: VercelModelConfig

  /**
   * Creates a new VercelModel instance.
   *
   * @param options - The model and optional configuration
   */
  constructor(options: VercelModelOptions) {
    super()
    const { provider, modelId, maxTokens, ...callSettings } = options
    this._provider = provider
    this._config = {
      modelId: modelId ?? provider.modelId,
      ...(maxTokens != null && { maxTokens }),
      ...callSettings,
    }
  }

  getConfig(): VercelModelConfig {
    return { ...this._config }
  }

  updateConfig(config: VercelModelConfig): void {
    this._config = { ...this._config, ...config }
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const prompt = formatMessages(messages, options?.systemPrompt)
    const tools = options?.toolSpecs ? formatTools(options.toolSpecs) : undefined
    const toolChoice = options?.toolChoice ? formatToolChoice(options.toolChoice) : undefined

    const { modelId: _, maxTokens, cacheConfig, ...callSettings } = this._config

    const callOptions: LanguageModelV3CallOptions = {
      prompt,
      ...(tools && { tools }),
      ...(toolChoice && { toolChoice }),
      ...(maxTokens != null && { maxOutputTokens: maxTokens }),
      ...callSettings,
    }

    applyVercelCacheConfig(callOptions, this._provider, cacheConfig, options?.dynamicTrailingBlocks)

    let result
    try {
      result = await this._provider.doStream(callOptions)
    } catch (error) {
      throw classifyError(error)
    }

    const reader = result.stream.getReader()
    const incrementalToolCallIds = new Set<string>()
    const clientToolInputStarts = new Set<string>()
    let sawToolUse = false
    try {
      while (true) {
        let readResult
        try {
          readResult = await reader.read()
        } catch (error) {
          throw classifyError(error)
        }
        const { done, value } = readResult
        if (done) break
        if (value.type === 'tool-input-start') {
          incrementalToolCallIds.add(value.id)
          // Only client-executed tool calls need the agent to run them; provider-executed calls
          // were already handled by the provider, so they must not drive the promotion below.
          // Remember the flag here, but don't promote yet: a block that never closes produces no
          // ToolUseBlock in the aggregator, and promoting the stop reason for it would leave the
          // agent with stopReason toolUse and zero tool blocks — an invariant violation.
          if (value.providerExecuted !== true) {
            clientToolInputStarts.add(value.id)
          }
        }
        if (value.type === 'tool-input-end' && clientToolInputStarts.has(value.id)) {
          sawToolUse = true
        }
        // Skip complete tool-call events when we already received incremental tool-input-* events for the same call
        if (value.type === 'tool-call' && incrementalToolCallIds.has(value.toolCallId)) {
          continue
        }
        if (value.type === 'tool-call' && value.providerExecuted !== true) {
          sawToolUse = true
        }
        for (const event of mapStreamPart(value)) {
          // Some community providers (e.g. ai-sdk-ollama) stream tool-call blocks but still report
          // finish_reason "stop", which maps to endTurn and would leave the agent skipping tool
          // execution. Decide from the streamed content, not just the provider's finish label: if any
          // client tool use block completed, promote the terminating endTurn to toolUse. See #3185.
          if (event.type === 'modelMessageStopEvent' && sawToolUse && event.stopReason === 'endTurn') {
            yield new ModelMessageStopEvent({ ...event, stopReason: 'toolUse' })
          } else {
            yield event
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}

/**
 * Applies a `CacheConfig` to a Vercel call by the underlying provider. See
 * {@link VercelModelConfig.cacheConfig} for the per-provider routing.
 *
 * @param dynamicTrailingBlocks - Trailing content parts of the last user message a context injector
 * rebuilds every call; the conversation breakpoint stays ahead of them so the cached prefix is stable.
 * @internal
 */
function applyVercelCacheConfig(
  callOptions: LanguageModelV3CallOptions,
  model: LanguageModelV3,
  cacheConfig: CacheConfig | undefined,
  dynamicTrailingBlocks = 0
): void {
  if (!cacheConfig) return

  // The segment before the first '.' is the provider namespace in the ai-sdk
  switch (model.provider.split('.')[0]) {
    case 'anthropic':
      applyAnthropicCache(callOptions, cacheConfig, dynamicTrailingBlocks)
      break
    case 'amazon-bedrock':
      applyBedrockCache(callOptions, cacheConfig, dynamicTrailingBlocks, model.modelId)
      break
    case 'openai':
      applyOpenAICache(callOptions, cacheConfig)
      break
    default:
      warnOnce(logger, `provider=<${model.provider}> | cacheConfig is not supported for this vercel provider, ignoring`)
  }
}

/**
 * Reports whether the configured cache strategy is supported
 *
 * @internal
 */
function isCacheStrategySupported(cacheConfig: CacheConfig): boolean {
  const strategy = cacheConfig.strategy ?? 'auto'
  if (strategy !== 'auto' && strategy !== 'anthropic') {
    warnOnce(logger, `strategy=<${strategy}> | unknown cache strategy, prompt caching disabled`)
    return false
  }
  return true
}

/**
 * Injects Anthropic `cacheControl` breakpoints
 *
 * @internal
 */
function applyAnthropicCache(
  callOptions: LanguageModelV3CallOptions,
  cacheConfig: CacheConfig,
  dynamicTrailingBlocks: number
): void {
  if (!isCacheStrategySupported(cacheConfig)) return

  const tools = resolveCacheSection(cacheConfig.toolsTTL, cacheConfig.ttl)
  if (tools.enabled) {
    // Anthropic caches the whole prefix up to the last function tool, so one breakpoint on it covers
    // every tool definition; provider-defined tools carry no providerOptions and are skipped.
    for (let index = (callOptions.tools?.length ?? 0) - 1; index >= 0; index--) {
      const tool = callOptions.tools?.[index]
      if (tool?.type === 'function') {
        setAnthropicCacheControl(tool, tools.ttl)
        break
      }
    }
  }

  const systemPrompt = resolveCacheSection(cacheConfig.systemPromptTTL, cacheConfig.ttl)
  if (systemPrompt.enabled) {
    const system = callOptions.prompt.find((message) => message.role === 'system')
    if (system) setAnthropicCacheControl(system, systemPrompt.ttl)
  }

  const messages = resolveCacheSection(cacheConfig.messagesTTL, cacheConfig.ttl)
  if (messages.enabled) {
    // ai-sdk honors cacheControl on any user content part, so place it on the durable part directly
    // (message-level would land on the last part, ahead of no per-call content).
    cacheLastUserMessage(callOptions.prompt, (userMessage) => {
      const part = durableCachePart(userMessage.content, dynamicTrailingBlocks, () => true)
      if (part) setAnthropicCacheControl(part, messages.ttl)
      else logger.debug('last user message has no durable content, skipped conversation cache point')
    })
  }
}

// Bedrock models that support the Anthropic-style caching strategy, mirroring `BedrockModel`'s
// auto-detect list. Kept local rather than imported so the caching path does not widen bedrock.ts's
// surface for a two-element constant.
const BEDROCK_MODELS_SUPPORTING_CACHING = ['anthropic', 'claude']

/**
 * Injects Bedrock `cachePoint` breakpoints on system and the last user message.
 *
 * @param modelId - The wrapped Bedrock model id; the default `'auto'` strategy caches only models
 * known to support it, matching `BedrockModel`.
 * @internal
 */
function applyBedrockCache(
  callOptions: LanguageModelV3CallOptions,
  cacheConfig: CacheConfig,
  dynamicTrailingBlocks: number,
  modelId: string
): void {
  if (!isCacheStrategySupported(cacheConfig)) return
  if (!bedrockModelSupportsCaching(cacheConfig, modelId)) return

  // The amazon-bedrock ai-sdk adapter accepts no tool-level cache point, so toolsTTL does nothing here.
  // Tool definitions are cached only as part of the system/messages prefix.
  if (cacheConfig.toolsTTL !== undefined && cacheConfig.toolsTTL !== true) {
    warnOnce(
      logger,
      `toolsTTL=<${cacheConfig.toolsTTL}> | toolsTTL has no effect on the amazon-bedrock vercel adapter, it accepts no tool-level cache point`
    )
  }

  const systemPrompt = resolveCacheSection(cacheConfig.systemPromptTTL, cacheConfig.ttl)
  if (systemPrompt.enabled) {
    const system = callOptions.prompt.find((message) => message.role === 'system')
    if (system) setBedrockCachePoint(system, systemPrompt.ttl)
  }

  const messages = resolveCacheSection(cacheConfig.messagesTTL, cacheConfig.ttl)
  if (messages.enabled) {
    cacheLastUserMessage(callOptions.prompt, (userMessage) => {
      // Bedrock rejects a cache point directly after a non-PDF document, so scan back past those parts.
      const part = durableCachePart(
        userMessage.content,
        dynamicTrailingBlocks,
        (candidate) => !blocksCachePoint(candidate)
      )
      if (part) setBedrockCachePoint(part, messages.ttl)
      else logger.debug('last user message has no durable non-document content, skipped conversation cache point')
    })
  }
}

/**
 * Reports whether the wrapped Bedrock model supports Anthropic-style caching. An explicit
 * `'anthropic'` strategy opts in regardless; the default `'auto'` caches only models known to support
 * it, warning once and skipping otherwise (mirroring `BedrockModel`).
 *
 * @internal
 */
function bedrockModelSupportsCaching(cacheConfig: CacheConfig, modelId: string): boolean {
  if ((cacheConfig.strategy ?? 'auto') !== 'auto') return true

  const supported = BEDROCK_MODELS_SUPPORTING_CACHING.some((pattern) => modelId.includes(pattern))
  if (!supported) {
    warnOnce(
      logger,
      `model_id=<${modelId}> | cacheConfig is enabled but this bedrock model does not support automatic caching, ignoring`
    )
  }
  return supported
}

/**
 * Reports whether Bedrock forbids a cache point directly after this part. The adapter turns every
 * non-image file part into a document, and Bedrock rejects a cache point after a non-PDF document (a
 * PDF document is fine).
 *
 * @internal
 */
function blocksCachePoint(part: LanguageModelV3TextPart | LanguageModelV3FilePart): boolean {
  return part.type === 'file' && !part.mediaType.startsWith('image/') && part.mediaType !== 'application/pdf'
}

/**
 * Finds the content part the conversation breakpoint should sit on: the last part at or before the
 * durable boundary that the provider accepts a breakpoint after.
 *
 * `dynamicTrailingBlocks` counts trailing parts a context injector rebuilds every call (e.g. a
 * per-turn timestamp); the breakpoint must stay ahead of them, or the cached prefix changes every
 * turn and is written but never read. `accepts` rejects part types the provider cannot carry a
 * breakpoint after. Returns undefined when nothing durable remains, so the caller skips the point.
 *
 * @internal
 */
function durableCachePart(
  content: Array<LanguageModelV3TextPart | LanguageModelV3FilePart>,
  dynamicTrailingBlocks: number,
  accepts: (part: LanguageModelV3TextPart | LanguageModelV3FilePart) => boolean
): LanguageModelV3TextPart | LanguageModelV3FilePart | undefined {
  for (let index = content.length - 1 - dynamicTrailingBlocks; index >= 0; index--) {
    const part = content[index]
    if (part && accepts(part)) return part
  }
  return undefined
}

/**
 * Locates the last user message and hands it to the provider-specific setter, which owns where the
 * cache breakpoint lands
 *
 * @internal
 */
function cacheLastUserMessage(
  prompt: LanguageModelV3CallOptions['prompt'],
  setCachePoint: (userMessage: Extract<LanguageModelV3Message, { role: 'user' }>) => void
): void {
  for (let index = prompt.length - 1; index >= 0; index--) {
    const message = prompt[index]
    if (message?.role === 'user') {
      setCachePoint(message)
      return
    }
  }
  logger.debug('no user message to cache, skipped conversation cache point')
}

/**
 * Sets the Anthropic `cacheControl` breakpoint, preserving other options.
 *
 * @internal
 */
function setAnthropicCacheControl(target: { providerOptions?: SharedV3ProviderOptions }, ttl?: CacheTTL): void {
  target.providerOptions = {
    ...target.providerOptions,
    anthropic: {
      ...target.providerOptions?.anthropic,
      cacheControl: ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' },
    },
  }
}

/**
 * Sets the Bedrock `cachePoint` breakpoint on a system message or user content part, preserving other
 * options.
 *
 * @internal
 */
function setBedrockCachePoint(target: { providerOptions?: SharedV3ProviderOptions }, ttl?: CacheTTL): void {
  target.providerOptions = {
    ...target.providerOptions,
    bedrock: {
      ...target.providerOptions?.bedrock,
      cachePoint: ttl ? { type: 'default', ttl } : { type: 'default' },
    },
  }
}

/**
 * Maps a `CacheConfig` onto `providerOptions.openai`.
 *
 * ai-sdk translates the camelCase options to the wire `prompt_cache_key`/`prompt_cache_retention`,
 * so the Vercel path writes camelCase.
 *
 * @internal
 */
function applyOpenAICache(callOptions: LanguageModelV3CallOptions, cacheConfig: CacheConfig): void {
  const openai: JSONObject = { ...callOptions.providerOptions?.openai }
  const openaiCache = resolveOpenAICache(cacheConfig)

  if (openaiCache.cacheKey !== undefined && openai.promptCacheKey === undefined) {
    openai.promptCacheKey = openaiCache.cacheKey
  }

  // Leave an explicit promptCacheRetention untouched; otherwise map a retention ttl or, if it names
  // no retention literal, warn that it was ignored.
  if (openai.promptCacheRetention === undefined) {
    if (openaiCache.retention !== undefined) openai.promptCacheRetention = openaiCache.retention
    else if (cacheConfig.ttl !== undefined) warnUnsupportedRetention(cacheConfig.ttl)
  }

  // Nothing to cache on (e.g. placement-only config) — leave providerOptions untouched rather than
  // injecting an empty openai namespace.
  if (Object.keys(openai).length > 0) {
    callOptions.providerOptions = { ...callOptions.providerOptions, openai }
  }
}

/**
 * Classifies an error from doStream into the appropriate Strands error type.
 *
 * @param error - The error thrown by the Vercel provider
 * @returns A classified error (ContextWindowOverflowError, ModelThrottledError, or ModelError)
 */
function classifyError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)

  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) {
      logger.debug(`throttled | error_message=<${message}>`)
      return new ModelThrottledError(message, { cause: error })
    }

    const searchText = (error.responseBody ?? message).toLowerCase()
    if (CONTEXT_WINDOW_OVERFLOW_PATTERNS.some((pattern) => searchText.includes(pattern))) {
      return new ContextWindowOverflowError(message)
    }
  }

  if (CONTEXT_WINDOW_OVERFLOW_PATTERNS.some((pattern) => message.toLowerCase().includes(pattern))) {
    return new ContextWindowOverflowError(message)
  }

  return new ModelError(`Language model stream error: ${message}`, { cause: error })
}

/**
 * Maps a single LanguageModelV3 stream part to zero or more Strands ModelStreamEvents.
 */
function* mapStreamPart(part: LanguageModelV3StreamPart): Generator<ModelStreamEvent> {
  switch (part.type) {
    case 'stream-start':
      yield new ModelMessageStartEvent({ type: 'modelMessageStartEvent', role: 'assistant' })
      break

    case 'text-start':
      yield new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent' })
      break

    case 'text-delta':
      yield new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: part.delta },
      })
      break

    case 'text-end':
      yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' })
      break

    case 'reasoning-start':
      yield new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent' })
      break

    case 'reasoning-delta':
      yield new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', text: part.delta },
      })
      break

    case 'reasoning-end':
      yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' })
      break

    case 'tool-input-start':
      yield new ModelContentBlockStartEvent({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: part.toolName, toolUseId: part.id },
      })
      break

    case 'tool-input-delta':
      yield new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: part.delta },
      })
      break

    case 'tool-input-end':
      yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' })
      break

    // Some providers (e.g. Responses API) emit only the complete tool-call without incremental tool-input-* events.
    // Synthesize the start/delta/stop sequence so the aggregation logic builds ToolUseBlocks correctly.
    case 'tool-call':
      yield new ModelContentBlockStartEvent({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: part.toolName, toolUseId: part.toolCallId },
      })
      yield new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: {
          type: 'toolUseInputDelta',
          input: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
        },
      })
      yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' })
      break

    case 'finish':
      yield new ModelMetadataEvent({
        type: 'modelMetadataEvent',
        usage: mapUsage(part.usage),
      })
      yield new ModelMessageStopEvent({
        type: 'modelMessageStopEvent',
        stopReason: mapFinishReason(part.finishReason),
      })
      break

    case 'error':
      throw new ModelError(
        `Language model stream error: ${part.error instanceof Error ? part.error.message : JSON.stringify(part.error)}`,
        { cause: part.error }
      )

    case 'response-metadata':
      logger.debug(`event_type=<${part.type}>, id=<${part.id}>, modelId=<${part.modelId}> | response metadata`)
      break

    default:
      logger.warn(`event_type=<${part.type}> | unsupported vercel stream event type, skipping`)
      break
  }
}

/**
 * Maps LanguageModelV3 finish reason to Strands StopReason.
 */
function mapFinishReason(finishReason: LanguageModelV3FinishReason): StopReason {
  switch (finishReason.unified) {
    case 'stop':
      return 'endTurn'
    case 'length':
      return 'maxTokens'
    case 'content-filter':
      return 'contentFiltered'
    case 'tool-calls':
      return 'toolUse'
    case 'other':
      return 'endTurn'
    case 'error':
      throw new ModelError(`model finished with error | raw=<${finishReason.raw}>`)
    default:
      logger.warn(`finish_reason=<${finishReason.unified}> | unknown vercel finish reason, defaulting to endTurn`)
      return 'endTurn'
  }
}

/**
 * Maps LanguageModelV3 usage to Strands Usage.
 */
function mapUsage(usage: LanguageModelV3Usage): Usage {
  const inputTokens = usage.inputTokens.total ?? 0
  const outputTokens = usage.outputTokens.total ?? 0
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(usage.inputTokens.cacheRead != null && { cacheReadInputTokens: usage.inputTokens.cacheRead }),
    ...(usage.inputTokens.cacheWrite != null && { cacheWriteInputTokens: usage.inputTokens.cacheWrite }),
  }
}

/**
 * Converts Strands messages + system prompt to LanguageModelV3 prompt format.
 */
function formatMessages(messages: Message[], systemPrompt?: SystemPrompt): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = []

  if (systemPrompt) {
    if (typeof systemPrompt === 'string') {
      prompt.push({ role: 'system', content: systemPrompt })
    } else {
      const textBlocks: string[] = []
      let hasCachePoints = false
      let hasGuardContent = false

      for (const block of systemPrompt) {
        if (isTextBlock(block)) {
          textBlocks.push(block.text)
        } else if (block.type === 'cachePointBlock') {
          hasCachePoints = true
        } else if (block.type === 'guardContentBlock') {
          hasGuardContent = true
        }
      }

      if (hasCachePoints) {
        logger.warn('cache points are not supported in vercel system prompts, ignoring cache points')
      }

      if (hasGuardContent) {
        logger.warn('guard content is not supported in vercel system prompts, removing guard content block')
      }

      const text = textBlocks.join('')
      if (text) {
        prompt.push({ role: 'system', content: text })
      }
    }
  }

  // Build a global toolCallId -> toolName map across all messages
  const toolNameMap = new Map<string, string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'toolUseBlock') {
        toolNameMap.set(block.toolUseId, block.name)
      }
    }
  }

  for (const message of messages) {
    if (message.role === 'user') {
      formatUserMessage(message, prompt, toolNameMap)
    } else if (message.role === 'assistant') {
      formatAssistantMessage(message, prompt)
    }
  }

  return prompt
}

/**
 * Formats a Strands user message to LanguageModelV3 format. Tool result blocks are extracted into
 * separate `tool` messages, always emitted before the text/media `user` message regardless of their
 * order within the source message. A provider adapter re-merges the split messages in prompt order,
 * so leading with the tool results keeps each one adjacent to the assistant tool call it answers
 * (tool_use → tool_result) — the LanguageModelV3 prompt itself carries no such adjacency guarantee.
 *
 * @param message - The user message to format
 * @param prompt - The prompt array to push formatted messages into
 * @param toolNameMap - Map of toolCallId to toolName for resolving tool result names
 */
function formatUserMessage(message: Message, prompt: LanguageModelV3Prompt, toolNameMap: Map<string, string>): void {
  const content: Array<LanguageModelV3TextPart | LanguageModelV3FilePart> = []
  const toolResults: LanguageModelV3ToolResultPart[] = []

  for (const block of message.content) {
    switch (block.type) {
      case 'textBlock':
        content.push({ type: 'text', text: block.text })
        break
      case 'imageBlock':
      case 'documentBlock':
      case 'videoBlock':
        content.push(...formatMediaBlock(block))
        break
      case 'toolResultBlock':
        toolResults.push({
          type: 'tool-result',
          toolCallId: block.toolUseId,
          toolName: toolNameMap.get(block.toolUseId) ?? '',
          output: formatToolResultOutput(block.status, block.content),
        })
        break
      default:
        logger.warn(`block_type=<${block.type}> | unsupported content type in vercel user message, skipping`)
        break
    }
  }

  for (const result of toolResults) {
    prompt.push({ role: 'tool', content: [result] })
  }

  if (content.length > 0) {
    prompt.push({ role: 'user', content })
  }
}

/**
 * Formats a Strands assistant message to LanguageModelV3 format.
 *
 * @param message - The assistant message to format
 * @param prompt - The prompt array to push formatted messages into
 */
function formatAssistantMessage(message: Message, prompt: LanguageModelV3Prompt): void {
  const content: Array<
    LanguageModelV3TextPart | LanguageModelV3FilePart | LanguageModelV3ReasoningPart | LanguageModelV3ToolCallPart
  > = []

  for (const block of message.content) {
    switch (block.type) {
      case 'textBlock':
        content.push({ type: 'text', text: block.text })
        break
      case 'reasoningBlock':
        if (block.text) {
          content.push({ type: 'reasoning', text: block.text })
        }
        break
      case 'toolUseBlock':
        content.push({
          type: 'tool-call',
          toolCallId: block.toolUseId,
          toolName: block.name,
          input: block.input,
        })
        break
      case 'toolResultBlock':
        logger.warn('tool result in assistant message is not supported, skipping')
        break
      case 'imageBlock':
      case 'documentBlock':
      case 'videoBlock':
        content.push(...formatMediaBlock(block))
        break
      default:
        logger.warn(`block_type=<${block.type}> | unsupported content type in vercel assistant message, skipping`)
        break
    }
  }

  if (content.length > 0) {
    prompt.push({ role: 'assistant', content })
  }
}

/**
 * Converts an image, document, or video block to LanguageModelV3 file/text parts.
 */
function formatMediaBlock(
  block: ImageBlock | DocumentBlock | VideoBlock
): Array<LanguageModelV3TextPart | LanguageModelV3FilePart> {
  const parts: Array<LanguageModelV3TextPart | LanguageModelV3FilePart> = []

  switch (block.type) {
    case 'imageBlock': {
      const mediaType = toMimeType(block.format) ?? `image/${block.format}`
      if (block.source.type === 'imageSourceBytes') {
        parts.push({ type: 'file', data: block.source.bytes, mediaType })
      } else if (block.source.type === 'imageSourceUrl') {
        parts.push({ type: 'file', data: new URL(block.source.url), mediaType })
      } else {
        logger.warn(`source_type=<${block.source.type}> | unsupported image source type, skipping`)
      }
      break
    }
    case 'documentBlock': {
      const mediaType = toMimeType(block.format) ?? `application/${block.format}`
      if (block.source.type === 'documentSourceBytes') {
        parts.push({ type: 'file', data: block.source.bytes, mediaType })
      } else if (block.source.type === 'documentSourceText') {
        parts.push({ type: 'text', text: block.source.text })
      } else if (block.source.type === 'documentSourceContentBlock') {
        for (const contentBlock of block.source.content) {
          parts.push({ type: 'text', text: contentBlock.text })
        }
      } else {
        logger.warn(`source_type=<${block.source.type}> | unsupported document source type, skipping`)
      }
      break
    }
    case 'videoBlock': {
      if (block.source.type === 'videoSourceBytes') {
        parts.push({
          type: 'file',
          data: block.source.bytes,
          mediaType: toMimeType(block.format) ?? `video/${block.format}`,
        })
      } else {
        logger.warn(`source_type=<${block.source.type}> | unsupported video source type, skipping`)
      }
      break
    }
  }

  return parts
}

/**
 * Formats tool result content to LanguageModelV3 ToolResultOutput.
 */
function formatToolResultOutput(
  status: string,
  content: ReadonlyArray<ToolResultContent>
): LanguageModelV3ToolResultOutput {
  if (status === 'error') {
    const errorText = content
      .filter((c): c is ToolResultContent & { text: string } => 'text' in c && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
    return { type: 'error-text', value: errorText || 'Tool execution failed' }
  }

  const value: Array<{ type: 'text'; text: string } | { type: 'file-data'; data: string; mediaType: string }> = []
  for (const c of content) {
    switch (c.type) {
      case 'textBlock':
        value.push({ type: 'text', text: c.text })
        break
      case 'jsonBlock':
        value.push({ type: 'text', text: JSON.stringify(c.json) })
        break
      case 'imageBlock': {
        const mediaType = toMimeType(c.format) ?? `image/${c.format}`
        if (c.source.type === 'imageSourceBytes') {
          value.push({ type: 'file-data', data: encodeBase64(c.source.bytes), mediaType })
        } else if (c.source.type === 'imageSourceUrl') {
          value.push({ type: 'text', text: c.source.url })
        } else {
          logger.warn(`source_type=<${c.source.type}> | unsupported image source in vercel tool result, skipping`)
        }
        break
      }
      case 'documentBlock': {
        const mediaType = toMimeType(c.format) ?? `application/${c.format}`
        if (c.source.type === 'documentSourceBytes') {
          value.push({ type: 'file-data', data: encodeBase64(c.source.bytes), mediaType })
        } else if (c.source.type === 'documentSourceText') {
          value.push({ type: 'text', text: c.source.text })
        } else if (c.source.type === 'documentSourceContentBlock') {
          for (const block of c.source.content) {
            value.push({ type: 'text', text: block.text })
          }
        } else {
          logger.warn(`source_type=<${c.source.type}> | unsupported document source in vercel tool result, skipping`)
        }
        break
      }
      case 'videoBlock': {
        const mediaType = toMimeType(c.format) ?? `video/${c.format}`
        if (c.source.type === 'videoSourceBytes') {
          value.push({ type: 'file-data', data: encodeBase64(c.source.bytes), mediaType })
        } else {
          logger.warn(`source_type=<${c.source.type}> | unsupported video source in vercel tool result, skipping`)
        }
        break
      }
      default:
        logger.warn(
          `block_type=<${(c as unknown as { type: string }).type}> | unsupported content type in vercel tool result, skipping`
        )
        break
    }
  }
  return { type: 'content', value }
}

/**
 * Converts Strands ToolSpec[] to LanguageModelV3 FunctionTool[].
 */
function formatTools(toolSpecs: ToolSpec[]): LanguageModelV3FunctionTool[] {
  return toolSpecs.map((spec) => ({
    type: 'function' as const,
    name: spec.name,
    description: spec.description,
    inputSchema: (spec.inputSchema ?? {
      type: 'object',
      properties: {},
    }) as LanguageModelV3FunctionTool['inputSchema'],
  }))
}

/**
 * Converts Strands ToolChoice to LanguageModelV3 ToolChoice.
 */
function formatToolChoice(toolChoice: ToolChoice): LanguageModelV3ToolChoice {
  if ('auto' in toolChoice) return { type: 'auto' }
  if ('any' in toolChoice) return { type: 'required' }
  if ('tool' in toolChoice) return { type: 'tool', toolName: toolChoice.tool.name }
  return { type: 'auto' }
}

/**
 * Type guard for TextBlock instances in system prompt content.
 */
function isTextBlock(block: unknown): block is TextBlock {
  return typeof block === 'object' && block !== null && 'text' in block && typeof (block as TextBlock).text === 'string'
}
