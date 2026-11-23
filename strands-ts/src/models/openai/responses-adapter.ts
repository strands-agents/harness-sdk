/**
 * Responses API adapter for the OpenAI model provider.
 *
 * Built-in tool support status:
 * | Tool              | Support                                                  |
 * |-------------------|----------------------------------------------------------|
 * | web_search        | Full: includes URL citations                             |
 * | file_search       | Partial: works but file citation annotations not emitted |
 * | code_interpreter  | Partial: works but executed code/stdout not surfaced     |
 * | mcp               | Partial: works but approval flow not supported           |
 * | shell             | Partial: container mode only                             |
 * | image_generation  | Not supported                                            |
 *
 * @internal
 */

import type {
  FunctionTool,
  ResponseStreamEvent,
  ResponseInputItem,
  ResponseFunctionToolCall,
  ResponseFunctionCallOutputItem,
  ResponseCreateParamsStreaming,
  ResponseOutputItem,
  ResponseUsage,
  Tool,
} from 'openai/resources/responses/responses'
import {
  Message,
  type ServerToolBlock,
  type StopReason,
  type ToolResultBlock,
  type ToolUseBlock,
} from '../../types/messages.js'
import type { ImageBlock, DocumentBlock } from '../../types/media.js'
import { encodeBase64 } from '../../types/media.js'
import { toMimeType } from '../../mime.js'
import type { StateStore } from '../../state-store.js'
import type { ModelStreamEvent } from '../streaming.js'
import type { StreamOptions } from '../model.js'
import { logger } from '../../logging/logger.js'
import { DEFAULT_CONTEXT_WINDOW_LIMIT, MODEL_DEFAULTS } from '../defaults.js'
import { formatImageDataUrl, warnManagedParams as warnManagedParamsShared } from './formatting.js'
import { applyCacheConfig, CACHE_LIFETIMES } from './cache.js'
import type { OpenAIResponsesConfig } from './types.js'
import { lookupSystemPromptPlacement } from '../model-info.js'
import type { ModelInfo } from '../model-info.js'
import { referenceText } from '../tool-references.js'
import { isLoaderName, loaderListing, SEARCH_TOOLS_TOOL_NAME, withToolListing } from '../../tools/search-tools.js'
import type { ToolSpec } from '../../tools/types.js'
import type { JSONValue } from '../../types/json.js'

export const DEFAULT_RESPONSES_MODEL_ID = MODEL_DEFAULTS.openai.modelId

/** Input content types that accept `prompt_cache_breakpoint` (gpt-5.6+). */
const CACHEABLE_INPUT_TYPES = new Set(['input_text', 'input_image', 'input_file'])

type InputPart = { type: string; prompt_cache_breakpoint?: { mode: 'explicit'; ttl?: string } }

const MANAGED_PARAMS: ReadonlySet<string> = new Set(['model', 'input', 'stream', 'store'])

/** Provider name of the server tool blocks this API writes. */
const PROVIDER = 'openai'

/**
 * How a request to a model that defers tools natively sends its deferred tools and their loads: with `defer_loading`,
 * and loaded by the provider's tool search, or by the SDK's loader (`load_tools` or `search_tools`) as a client tool
 * search.
 */
interface DeferredToolsRequest {
  /** The tools the request defers. */
  readonly deferred: ReadonlySet<string>
  /** Whether the API searches the deferred tools itself, in place of the loader. */
  readonly onServer: boolean
  /** The request's tool specs by name, which a client tool search output loads. */
  readonly toolSpecs: ReadonlyMap<string, ToolSpec>
  /** The listing of the deferred tools, which the client tool search shows. */
  readonly listing: string
  /** IDs of the loader calls in the messages that loaded tools, which go as client tool searches. */
  readonly searchCalls: ReadonlySet<string>
}

/**
 * Logs a warning for each responses-managed key present in `params`.
 *
 * @internal
 */
export function warnManagedParams(params: Record<string, unknown> | undefined): void {
  warnManagedParamsShared(params, MANAGED_PARAMS)
}

/**
 * Builds a Responses API streaming request body.
 *
 * @param modelInfo - What the SDK knows about the model; decides whether durable message checkpoints are placed
 * @internal
 */
export function formatResponsesRequest(
  config: OpenAIResponsesConfig,
  messages: Message[],
  options: StreamOptions | undefined,
  stateful: boolean,
  modelInfo: ModelInfo
): ResponseCreateParamsStreaming {
  const { cacheConfig } = config
  const cachePoints = modelInfo.capabilities?.promptCaching === 'cachePoints'
  const cacheMessages = cachePoints && cacheConfig !== undefined && cacheConfig.messagesTTL !== false
  const deferral = deferredToolsRequest(messages, options, modelInfo)
  const { input, explicitCache } = cacheMessages
    ? formatCacheableResponsesMessages(messages, options?.dynamicTrailingBlocks, cacheConfig.messagesTTL, deferral)
    : { input: formatResponsesMessages(messages, deferral), explicitCache: false }

  // User `params` are spread first so provider-managed fields (asserted
  // required by `ResponseCreateParamsStreaming` below) always win. The
  // managed-params warning fires at config time to surface the collision.
  const modelId = config.modelId ?? DEFAULT_RESPONSES_MODEL_ID
  const request = {
    ...(config.params ?? {}),
    model: modelId,
    input,
    stream: true as const,
    store: stateful,
  } as ResponseCreateParamsStreaming

  if (stateful) {
    const responseId = options?.modelState?.get('responseId') as string | undefined
    if (responseId) {
      request.previous_response_id = responseId
    }
  }

  const systemPrompt = systemPromptText(options?.systemPrompt)
  // Some models append instructions after the input, where they never cache; a leading developer message
  // does. A stored conversation would keep every resent copy.
  if (systemPrompt && !stateful && lookupSystemPromptPlacement(modelId) === 'message') {
    request.input = [{ role: 'developer', content: [{ type: 'input_text', text: systemPrompt }] }, ...input]
  } else if (systemPrompt !== undefined) {
    request.instructions = systemPrompt
  }

  if (options?.toolSpecs && options.toolSpecs.length > 0) {
    const existingTools = request.tools ?? []
    request.tools = [...existingTools, ...formatTools(options.toolSpecs, deferral, existingTools)]

    if (options.toolChoice) {
      if ('auto' in options.toolChoice) {
        request.tool_choice = 'auto'
      } else if ('any' in options.toolChoice) {
        request.tool_choice = 'required'
      } else if ('tool' in options.toolChoice) {
        request.tool_choice = { type: 'function', name: options.toolChoice.tool.name }
      }
    }
  }

  if (config.temperature !== undefined) request.temperature = config.temperature
  if (config.maxTokens !== undefined) request.max_output_tokens = config.maxTokens
  if (config.topP !== undefined) request.top_p = config.topP

  if (explicitCache) {
    // Caller-supplied mode, TTL and diagnostics take precedence.
    const native = config.params?.prompt_cache_options as object | undefined
    Object.assign(request, { prompt_cache_options: { mode: 'explicit', ...native } })
  }

  applyCacheConfig(request, cacheConfig, options?.agentMetadata, cachePoints)

  return request
}

/**
 * The request's tools: a function per spec, each deferred one with `defer_loading`. When the request defers tools,
 * the loader becomes a client tool search, or the provider's tool search takes its place under `serverToolSearch`
 * unless the caller configured one.
 */
function formatTools(
  toolSpecs: ToolSpec[],
  deferral: DeferredToolsRequest | undefined,
  existingTools: readonly Tool[]
): Tool[] {
  const deferred = deferral?.deferred ?? new Set<string>()
  const tools = toolSpecs.flatMap((spec): Tool[] => {
    if (!deferral || deferred.size === 0 || !isLoaderName(spec.name)) {
      return [functionTool(spec, deferred.has(spec.name))]
    }
    return deferral.onServer ? [] : [clientToolSearch(spec, deferral.listing)]
  })
  const configured = existingTools.some((tool) => tool.type === 'tool_search')
  if (deferral?.onServer && !configured) tools.push({ type: 'tool_search' })
  return tools
}

/** The loader as a client tool search that lists the deferred tools, since the model can't see them. */
function clientToolSearch(spec: ToolSpec, listing: string): Tool {
  const description = withToolListing(spec.description, listing)
  return { type: 'tool_search', execution: 'client', description, parameters: spec.inputSchema ?? {} }
}

/** A tool spec as a function tool. */
function functionTool(spec: ToolSpec, deferred: boolean): FunctionTool {
  return {
    type: 'function',
    name: spec.name,
    description: spec.description ?? '',
    parameters: (spec.inputSchema ?? {}) as Record<string, unknown>,
    // `null` defers to the OpenAI server default. The SDK's typed
    // contract requires a value; omitting it (as the Python SDK does)
    // is not an option here.
    strict: null,
    ...(deferred && { defer_loading: true }),
  }
}

/** How the request sends deferred tools and their loads, or undefined when the model doesn't defer tools natively. */
function deferredToolsRequest(
  messages: Message[],
  options: StreamOptions | undefined,
  modelInfo: ModelInfo
): DeferredToolsRequest | undefined {
  if (modelInfo.capabilities?.deferredToolLoading !== 'native') return undefined
  const deferred = options?.deferredTools ?? new Set<string>()
  const toolSpecs = options?.toolSpecs ?? []
  const contextWindow = modelInfo.limits?.contextWindow || DEFAULT_CONTEXT_WINDOW_LIMIT
  return {
    deferred,
    onServer: deferred.size > 0 && options?.serverToolSearch === true,
    toolSpecs: new Map(toolSpecs.map((spec) => [spec.name, spec])),
    listing: loaderListing(
      toolSpecs,
      toolSpecs.filter((spec) => deferred.has(spec.name)),
      contextWindow
    ),
    searchCalls: loadingSearchCalls(messages),
  }
}

/**
 * IDs of the loader calls whose result loaded tools: it holds only tool references. Any other, such as a failed load,
 * goes as a function call with its text.
 */
function loadingSearchCalls(messages: Message[]): Set<string> {
  const searches = new Set<string>()
  const ids = new Set<string>()
  for (const block of messages.flatMap((message) => message.content)) {
    if (block.type === 'toolUseBlock' && isLoaderName(block.name)) searches.add(block.toolUseId)
    if (block.type === 'toolResultBlock' && searches.has(block.toolUseId) && onlyReferences(block)) {
      ids.add(block.toolUseId)
    }
  }
  return ids
}

function onlyReferences(block: ToolResultBlock): boolean {
  return block.content.length > 0 && block.content.every((content) => content.type === 'toolReferenceBlock')
}

function systemPromptText(systemPrompt: StreamOptions['systemPrompt']): string | undefined {
  if (typeof systemPrompt === 'string') return systemPrompt
  if (!Array.isArray(systemPrompt)) return undefined
  const texts = systemPrompt.flatMap((block) => (block.type === 'textBlock' ? [block.text] : []))
  return texts.length > 0 ? texts.join('') : undefined
}

/**
 * Formats messages with a cache checkpoint on the last input part of each durable user message.
 *
 * The final user message's last `dynamicTrailingBlocks` blocks are temporary: they go after the
 * checkpoint and after any tool outputs, so a changing injection never shifts the cached prefix.
 * A `messagesTTL` naming a cache lifetime becomes each checkpoint's `ttl`. `explicitCache` reports
 * whether the request should default `prompt_cache_options.mode` to explicit; without a checkpoint or
 * a temporary suffix, implicit caching stays so the request still caches.
 */
function formatCacheableResponsesMessages(
  messages: Message[],
  dynamicTrailingBlocks = 0,
  messagesTTL: boolean | string | undefined,
  deferral: DeferredToolsRequest | undefined
): { input: ResponseInputItem[]; explicitCache: boolean } {
  const ttl = typeof messagesTTL === 'string' && CACHE_LIFETIMES.has(messagesTTL) ? { ttl: messagesTTL } : {}
  const input: ResponseInputItem[] = []
  let hasCheckpoints = false
  for (const [index, { role, content }] of messages.entries()) {
    const dynamicCount = role === 'user' && index === messages.length - 1 ? dynamicTrailingBlocks : 0
    const boundary = Math.max(0, content.length - dynamicCount)
    const items = formatResponsesMessages([new Message({ role, content: content.slice(0, boundary) })], deferral)
    normalizeToolOutputs(items)
    const part = role === 'user' ? lastCacheablePart(items) : undefined
    if (part) {
      // Mark every durable user message, not just the latest: the provider bounds lookups and
      // writes itself, and earlier markers keep the previous request's cache entry reachable.
      part.prompt_cache_breakpoint = { mode: 'explicit', ...ttl }
      hasCheckpoints = true
    }
    if (dynamicCount > 0) {
      const tail = formatResponsesMessages([new Message({ role: 'user', content: content.slice(boundary) })], deferral)
      normalizeToolOutputs(tail)
      appendDynamicContent(items, tail)
    }
    input.push(...items)
  }
  return { input, explicitCache: hasCheckpoints || dynamicTrailingBlocks > 0 }
}

/**
 * Sends text tool outputs as one input_text block, so they can carry a checkpoint and replay identically.
 * An empty output stays a string: an empty text block would be a meaningless checkpoint.
 */
function normalizeToolOutputs(items: ResponseInputItem[]): void {
  for (const item of items) {
    if (item.type === 'function_call_output' && typeof item.output === 'string' && item.output !== '') {
      item.output = [{ type: 'input_text', text: item.output }]
    }
  }
}

/** Finds the final input part (text, image, or file) in a formatted, normalized durable user message. */
function lastCacheablePart(items: ResponseInputItem[]): InputPart | undefined {
  const parts = items.flatMap((item) => {
    const content = item.type === 'function_call_output' ? item.output : (item as { content?: unknown }).content
    return Array.isArray(content) ? (content as InputPart[]) : []
  })
  return parts.reverse().find((part) => CACHEABLE_INPUT_TYPES.has(part.type))
}

/** Merges temporary content into the durable user message; after tool outputs, it becomes its own message. */
function appendDynamicContent(items: ResponseInputItem[], tail: ResponseInputItem[]): void {
  const last = items.at(-1)
  const first = tail[0]
  if (last && first && 'role' in last && 'role' in first) {
    ;(last as { content: unknown[] }).content.push(...(first as { content: unknown[] }).content)
    tail.shift()
  }
  items.push(...tail)
}

/**
 * Formats SDK messages into Responses API input items.
 *
 * Per message, content blocks are split into four buckets:
 * - Text/media → grouped in `{ role, content: [...] }`
 * - This API's own tool items, such as the provider's tool search → sent as they came
 * - Tool calls → separate `{ type: 'function_call', ... }` items, or client tool search calls
 * - Tool results → separate `{ type: 'function_call_output', ... }` items, or client tool search outputs
 */
function formatResponsesMessages(messages: Message[], deferral?: DeferredToolsRequest): ResponseInputItem[] {
  const input: ResponseInputItem[] = []

  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const contentItems: Array<Record<string, unknown>> = []
    const serverItems: ResponseInputItem[] = []
    const toolCallItems: ResponseInputItem[] = []
    const toolResultItems: ResponseInputItem[] = []

    for (const block of message.content) {
      switch (block.type) {
        case 'textBlock': {
          if (role === 'user') {
            contentItems.push({ type: 'input_text', text: block.text })
          } else {
            contentItems.push({ type: 'output_text', text: block.text })
          }
          break
        }

        case 'imageBlock': {
          const formatted = formatImageInput(block as ImageBlock)
          if (formatted) contentItems.push(formatted)
          break
        }

        case 'documentBlock': {
          const formatted = formatDocumentInput(block as DocumentBlock)
          if (formatted) contentItems.push(formatted)
          break
        }

        case 'citationsBlock': {
          const citBlock = block as { content: Array<{ text: string }> }
          for (const c of citBlock.content) {
            contentItems.push({ type: role === 'user' ? 'input_text' : 'output_text', text: c.text })
          }
          break
        }

        case 'toolUseBlock':
          toolCallItems.push(formatToolCall(block, deferral))
          break

        case 'toolResultBlock':
          toolResultItems.push(formatToolCallOutput(block, deferral))
          break

        case 'serverToolBlock':
          serverItems.push(...formatServerTool(block))
          break

        case 'reasoningBlock': {
          logger.warn(
            'block_type=<reasoningBlock> | reasoning content is not yet supported in multi-turn conversations with the responses api'
          )
          break
        }

        case 'unknownBlock':
          break
        default: {
          logger.warn(
            `block_type=<${block.type}> | unsupported content type in responses api message formatting | skipping`
          )
        }
      }
    }

    if (contentItems.length > 0) {
      if (role === 'assistant') {
        // Only the string EasyInputMessage form is a valid assistant *input* shape
        // without the full ResponseOutputMessage metadata (id/status/annotations),
        // which has already been discarded by this point. Non-text assistant history
        // has no valid input shape either. Replaying verbatim output items is
        // tracked in https://github.com/strands-agents/harness-sdk/issues/3389.
        const droppedTypes = contentItems.filter((item) => item.type !== 'output_text').map((item) => item.type)
        if (droppedTypes.length > 0) {
          logger.warn(
            `content_type=<${droppedTypes.join(', ')}> | non-text assistant history content has no valid responses api input shape | dropping`
          )
        }
        const text = contentItems
          .filter((item) => item.type === 'output_text')
          .map((item) => item.text as string)
          .join('\n')
        if (text) input.push({ role: 'assistant', content: text })
      } else {
        // Cast is needed only because `contentItems` is built as a loosely-typed
        // record array; the user-role items themselves (`input_text`/`input_image`/
        // `input_file`) are valid `EasyInputMessage` content.
        input.push({
          role,
          content: contentItems,
        } as unknown as ResponseInputItem)
      }
    }

    input.push(...serverItems)
    input.push(...toolCallItems)
    input.push(...toolResultItems)
  }

  return input
}

/** A tool call as a function call with its namespace, or as a client tool search for a loader call that loaded tools. */
function formatToolCall(block: ToolUseBlock, deferral: DeferredToolsRequest | undefined): ResponseInputItem {
  if (deferral?.searchCalls.has(block.toolUseId)) {
    return {
      type: 'tool_search_call',
      call_id: block.toolUseId,
      execution: 'client',
      status: 'completed',
      arguments: block.input,
    }
  }
  const call: ResponseFunctionToolCall = {
    type: 'function_call',
    call_id: block.toolUseId,
    name: block.name,
    arguments: JSON.stringify(block.input),
  }
  return block.namespace ? { ...call, namespace: block.namespace } : call
}

/** A tool result as a function call output, or as the client tool search output of a loader call that loaded tools. */
function formatToolCallOutput(block: ToolResultBlock, deferral: DeferredToolsRequest | undefined): ResponseInputItem {
  if (deferral?.searchCalls.has(block.toolUseId)) return toolSearchOutput(block, deferral)
  return {
    type: 'function_call_output',
    call_id: block.toolUseId,
    output: formatToolResultOutput(block, deferral?.toolSpecs),
  }
}

/** A server tool block this API wrote, as the item it came as; another provider's is left out. */
function formatServerTool(block: ServerToolBlock): ResponseInputItem[] {
  return block.provider === PROVIDER ? [block.data as unknown as ResponseInputItem] : []
}

/** A loader result as the client tool search output that loads its tools, each the request still has. */
function toolSearchOutput(block: ToolResultBlock, deferral: DeferredToolsRequest): ResponseInputItem {
  const tools = block.content.flatMap((content) => {
    const spec = content.type === 'toolReferenceBlock' ? deferral.toolSpecs.get(content.name) : undefined
    return spec ? [functionTool(spec, true)] : []
  })
  return { type: 'tool_search_output', call_id: block.toolUseId, execution: 'client', status: 'completed', tools }
}

/**
 * Builds a Responses API `function_call_output.output` value from a SDK
 * `toolResultBlock`. Returns a plain string for text-only results (joined with
 * newlines) or the content-item array shape when the result carries image or
 * document data.
 */
function formatToolResultOutput(
  resultBlock: ToolResultBlock,
  toolSpecs?: ReadonlyMap<string, ToolSpec>
): string | ResponseFunctionCallOutputItem[] {
  const parts: ResponseFunctionCallOutputItem[] = []
  const texts: string[] = []
  let hasMedia = false

  for (const c of resultBlock.content) {
    switch (c.type) {
      case 'textBlock':
        texts.push(c.text)
        parts.push({ type: 'input_text', text: c.text })
        break
      case 'jsonBlock': {
        const jsonBlock = c as { json: unknown }
        let text: string
        try {
          text = JSON.stringify(jsonBlock.json)
        } catch {
          text = '[JSON serialization error]'
        }
        texts.push(text)
        parts.push({ type: 'input_text', text })
        break
      }
      case 'imageBlock': {
        const url = formatImageDataUrl(c as ImageBlock)
        if (url) {
          hasMedia = true
          parts.push({ type: 'input_image', image_url: url })
        }
        break
      }
      case 'documentBlock': {
        const docBlock = c as DocumentBlock
        if (docBlock.source.type === 'documentSourceBytes') {
          const base64 = encodeBase64(docBlock.source.bytes)
          const mimeType = toMimeType(docBlock.format) || `application/${docBlock.format}`
          hasMedia = true
          parts.push({
            type: 'input_file',
            file_data: `data:${mimeType};base64,${base64}`,
            filename: docBlock.name,
          })
        } else {
          logger.warn(
            `source_type=<${docBlock.source.type}> | only byte source documents supported in responses api tool results`
          )
        }
        break
      }
      // A function call output can't load a tool, so a reference goes as its parameters.
      case 'toolReferenceBlock': {
        const text = referenceText(c.name, toolSpecs?.get(c.name))
        texts.push(text)
        parts.push({ type: 'input_text', text })
        break
      }
      case 'unknownBlock':
        break
      default:
        logger.warn(`block_type=<${c.type}> | unsupported tool result content type for responses api`)
    }
  }

  if (hasMedia) return parts

  // Text-only: collapse to a single string to match the API's simpler shape.
  const text = texts.join('\n')
  if (resultBlock.status === 'error') {
    return `[ERROR] ${text}`
  }
  return text
}

function formatImageInput(imageBlock: ImageBlock): Record<string, unknown> | undefined {
  const url = formatImageDataUrl(imageBlock)
  if (!url) return undefined
  return { type: 'input_image', image_url: url }
}

function formatDocumentInput(docBlock: DocumentBlock): Record<string, unknown> | undefined {
  if (docBlock.source.type === 'documentSourceBytes') {
    const base64 = encodeBase64(docBlock.source.bytes)
    const mimeType = toMimeType(docBlock.format) || `application/${docBlock.format}`
    return {
      type: 'input_file',
      file_data: `data:${mimeType};base64,${base64}`,
      filename: docBlock.name,
    }
  }
  logger.warn(`source_type=<${docBlock.source.type}> | only byte source documents supported in responses api`)
  return undefined
}

/**
 * Internal stream state for the Responses adapter. Tracks the active content
 * block kind so the adapter can emit stop/start events when content type
 * switches (text ↔ reasoning ↔ citations).
 *
 * @internal
 */
export interface ResponsesStreamState {
  dataType: string | null
  toolCalls: Map<
    string,
    { name: string; arguments: string; callId: string; itemId: string; namespace?: string | undefined }
  >
  finalUsage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadInputTokens?: number
    cacheWriteInputTokens?: number
  } | null
  stopReason: StopReason
  /** The loader a client tool search call runs: the one the request sent as its client tool search. */
  loader: string
}

/**
 * Creates fresh stream state for a new Responses API stream.
 *
 * @param options - The request's options, whose tool specs name the loader a client tool search call runs
 * @returns The stream state
 * @internal
 */
export function createResponsesStreamState(options?: StreamOptions): ResponsesStreamState {
  return {
    dataType: null,
    toolCalls: new Map(),
    finalUsage: null,
    stopReason: 'endTurn',
    loader: options?.toolSpecs?.find((spec) => isLoaderName(spec.name))?.name ?? SEARCH_TOOLS_TOOL_NAME,
  }
}

/**
 * Maps a Responses API `usage` object to the SDK's usage shape, including
 * prompt-cache reads and writes. The Responses API reports cache hits via
 * `usage.input_tokens_details.cached_tokens` and cache writes via
 * `cache_write_tokens`; surfacing them as `cacheReadInputTokens` /
 * `cacheWriteInputTokens` keeps the Responses path consistent with the Bedrock,
 * Anthropic, and Vercel model adapters (and lets `telemetry/tracer.ts` emit
 * `gen_ai.usage.cache_read.input_tokens`).
 *
 * @internal
 */
function mapResponsesUsage(usage: ResponseUsage): NonNullable<ResponsesStreamState['finalUsage']> {
  const mapped: NonNullable<ResponsesStreamState['finalUsage']> = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  }
  const cached = usage.input_tokens_details?.cached_tokens
  if (typeof cached === 'number' && cached > 0) {
    mapped.cacheReadInputTokens = cached
  }
  // GPT-5.6 reports cache writes here; the openai package's InputTokensDetails
  // does not type the field yet, so read it through a narrow cast.
  const cacheWrite = (usage.input_tokens_details as { cache_write_tokens?: number } | undefined)?.cache_write_tokens
  if (typeof cacheWrite === 'number' && cacheWrite > 0) {
    mapped.cacheWriteInputTokens = cacheWrite
  }
  return mapped
}

function createResponsesStreamError(
  message: string | undefined,
  code: string | null | undefined
): Error & { code?: string } {
  const error = new Error(message || 'OpenAI Responses API response failed') as Error & { code?: string }
  if (code) {
    error.code = code
  }
  return error
}

/**
 * Maps a single Responses API stream event to zero or more SDK events. Mutates
 * `state` and, when `stateful` is `true`, writes `responseId` into `modelState`.
 *
 * @internal
 */
export function mapResponsesEventToSDK(
  event: ResponseStreamEvent,
  state: ResponsesStreamState,
  stateful: boolean,
  modelState: StateStore | undefined
): ModelStreamEvent[] {
  const events: ModelStreamEvent[] = []

  switch (event.type) {
    case 'response.created': {
      if (stateful && modelState) {
        modelState.set('responseId', event.response.id)
      }
      events.push({ type: 'modelMessageStartEvent', role: 'assistant' as const })
      break
    }

    case 'response.output_text.delta': {
      events.push(...switchContent('text', state.dataType))
      state.dataType = 'text'
      events.push({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: event.delta },
      })
      break
    }

    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary_text.delta': {
      events.push(...switchContent('reasoning', state.dataType))
      state.dataType = 'reasoning'
      events.push({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', text: event.delta },
      })
      break
    }

    case 'response.output_text.annotation.added': {
      // The SDK types `event.annotation` as `unknown` and doesn't export a
      // named annotation union, so we narrow structurally on the fields we use.
      const annotation = event.annotation as { type: string; url?: string; title?: string; cited_text?: string }
      if (annotation.type === 'url_citation') {
        // Close the in-flight text block before the citation delta.
        // model.ts finalization picks ONE block kind per open block
        // (citations wins over text), so text + citation in the same
        // block drops the text on stop. Switching here forces a
        // separate CitationsBlock, and the next text delta will open
        // a fresh TextBlock.
        events.push(...switchContent('citations', state.dataType))
        state.dataType = 'citations'
        events.push({
          type: 'modelContentBlockDeltaEvent',
          delta: {
            type: 'citationsDelta',
            citations: [
              {
                location: {
                  type: 'web' as const,
                  url: annotation.url ?? '',
                },
                source: annotation.url ?? '',
                sourceContent: [],
                title: annotation.title ?? '',
              },
            ],
            content: [{ text: annotation.cited_text ?? '' }],
          },
        })
      } else {
        logger.warn(`annotation_type=<${annotation.type}> | unsupported annotation type in responses api`)
      }
      break
    }

    case 'response.output_item.added': {
      if (event.item.type === 'function_call') {
        // `id` is optional in the SDK type but load-bearing here: it keys
        // subsequent argument delta/done events. Skip rather than collapse
        // to an empty string, which would let distinct calls share a key.
        const { id: itemId, call_id: callId, name, namespace } = event.item
        if (!itemId) {
          logger.warn(`call_id=<${callId}> name=<${name}> | function_call event missing item id — skipping`)
          break
        }
        state.toolCalls.set(itemId, { name, arguments: '', callId, itemId, namespace })
      }
      break
    }

    case 'response.output_item.done': {
      events.push(...toolSearchItemEvents(event.item, state))
      break
    }

    case 'response.function_call_arguments.delta': {
      const tc = state.toolCalls.get(event.item_id)
      if (tc) {
        tc.arguments += event.delta
      }
      break
    }

    case 'response.function_call_arguments.done': {
      const tc = state.toolCalls.get(event.item_id)
      if (tc) {
        tc.arguments = event.arguments
      }
      break
    }

    case 'response.incomplete': {
      const resp = event.response
      if (resp.usage) {
        state.finalUsage = mapResponsesUsage(resp.usage)
      }
      if (resp.incomplete_details?.reason === 'max_output_tokens') {
        state.stopReason = 'maxTokens'
      } else if (resp.incomplete_details?.reason === 'content_filter') {
        state.stopReason = 'contentFiltered'
      }
      break
    }

    case 'response.failed': {
      const error = event.response.error
      throw createResponsesStreamError(error?.message, error?.code)
    }

    case 'error': {
      throw createResponsesStreamError(event.message, event.code)
    }

    case 'response.completed': {
      const resp = event.response
      if (resp.usage) {
        state.finalUsage = mapResponsesUsage(resp.usage)
      }
      break
    }

    default:
      break
  }

  return events
}

/**
 * Emits the terminal events for a Responses API stream: closes any open content
 * block, flushes accumulated tool calls, emits usage metadata, and finishes
 * with `modelMessageStopEvent`.
 *
 * @internal
 */
export function finalizeResponsesStream(state: ResponsesStreamState): ModelStreamEvent[] {
  const events: ModelStreamEvent[] = []

  if (state.dataType !== null) {
    events.push({ type: 'modelContentBlockStopEvent' })
  }

  for (const [, tc] of state.toolCalls) {
    events.push({
      type: 'modelContentBlockStartEvent',
      start: {
        type: 'toolUseStart',
        name: tc.name,
        toolUseId: tc.callId,
        ...(tc.namespace && { namespace: tc.namespace }),
      },
    })
    events.push({
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'toolUseInputDelta', input: tc.arguments },
    })
    events.push({ type: 'modelContentBlockStopEvent' })
  }

  // A function call in flight at max_output_tokens has truncated arguments, so maxTokens wins.
  let stopReason = state.stopReason
  if (state.toolCalls.size > 0 && stopReason !== 'maxTokens') {
    stopReason = 'toolUse'
  }

  if (state.finalUsage) {
    events.push({ type: 'modelMetadataEvent', usage: state.finalUsage })
  }

  events.push({ type: 'modelMessageStopEvent', stopReason })

  return events
}

/**
 * The events for a finished tool search item. A client tool search is a call to the loader the agent runs, sent with
 * the other calls at the end; the API's own search becomes a server tool block where it happened.
 */
function toolSearchItemEvents(item: ResponseOutputItem, state: ResponsesStreamState): ModelStreamEvent[] {
  if (item.type !== 'tool_search_call' && item.type !== 'tool_search_output') return []
  if (item.type === 'tool_search_call' && item.execution === 'client') {
    const callId = item.call_id ?? item.id
    const args = JSON.stringify(item.arguments ?? {})
    state.toolCalls.set(item.id, { name: state.loader, arguments: args, callId, itemId: item.id })
    return []
  }
  const events: ModelStreamEvent[] = state.dataType !== null ? [{ type: 'modelContentBlockStopEvent' }] : []
  state.dataType = null
  const loadedTools = item.type === 'tool_search_output' ? loadedFunctions(item.tools) : undefined
  events.push(
    { type: 'modelContentBlockStartEvent' },
    {
      type: 'modelContentBlockDeltaEvent',
      delta: {
        type: 'serverToolDelta',
        provider: PROVIDER,
        data: item as unknown as JSONValue,
        ...(loadedTools && { loadedTools }),
      },
    },
    { type: 'modelContentBlockStopEvent' }
  )
  return events
}

/** Names of the functions a tool search output loaded, those in a namespace included. */
function loadedFunctions(tools: Tool[]): string[] {
  return tools.flatMap((tool) => {
    if (tool.type === 'function') return [tool.name]
    if (tool.type !== 'namespace') return []
    return tool.tools.flatMap((inner) => (inner.type === 'function' ? [inner.name] : []))
  })
}

function switchContent(newType: string, prevType: string | null): ModelStreamEvent[] {
  const events: ModelStreamEvent[] = []
  if (newType !== prevType) {
    if (prevType !== null) {
      events.push({ type: 'modelContentBlockStopEvent' })
    }
    events.push({ type: 'modelContentBlockStartEvent' })
  }
  return events
}
