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
  ResponseStreamEvent,
  ResponseInputItem,
  ResponseFunctionToolCall,
  ResponseFunctionCallOutputItem,
  ResponseCreateParamsStreaming,
  ResponseUsage,
} from 'openai/resources/responses/responses'
import type { Message, StopReason, ToolResultBlock } from '../../types/messages.js'
import type { ImageBlock, DocumentBlock } from '../../types/media.js'
import { encodeBase64 } from '../../types/media.js'
import { toMimeType } from '../../mime.js'
import type { StateStore } from '../../state-store.js'
import type { ModelStreamEvent } from '../streaming.js'
import type { StreamOptions } from '../model.js'
import { logger } from '../../logging/logger.js'
import { MODEL_DEFAULTS } from '../defaults.js'
import { formatImageDataUrl, warnManagedParams as warnManagedParamsShared } from './formatting.js'
import { applyCacheConfig } from './cache.js'
import type { OpenAIResponsesConfig } from './types.js'

export const DEFAULT_RESPONSES_MODEL_ID = MODEL_DEFAULTS.openai.modelId

const MANAGED_PARAMS: ReadonlySet<string> = new Set(['model', 'input', 'stream', 'store'])

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
 * @internal
 */
export function formatResponsesRequest(
  config: OpenAIResponsesConfig,
  messages: Message[],
  options: StreamOptions | undefined,
  stateful: boolean
): ResponseCreateParamsStreaming {
  const input = formatResponsesMessages(messages)

  // User `params` are spread first so provider-managed fields (asserted
  // required by `ResponseCreateParamsStreaming` below) always win. The
  // managed-params warning fires at config time to surface the collision.
  const request = {
    ...(config.params ?? {}),
    model: config.modelId ?? DEFAULT_RESPONSES_MODEL_ID,
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

  if (options?.systemPrompt !== undefined) {
    if (typeof options.systemPrompt === 'string') {
      request.instructions = options.systemPrompt
    } else if (Array.isArray(options.systemPrompt)) {
      const texts: string[] = []
      for (const block of options.systemPrompt) {
        if (block.type === 'textBlock') {
          texts.push(block.text)
        }
      }
      if (texts.length > 0) {
        request.instructions = texts.join('')
      }
    }
  }

  if (options?.toolSpecs && options.toolSpecs.length > 0) {
    const existingTools = request.tools ?? []
    request.tools = [
      ...existingTools,
      ...options.toolSpecs.map((spec) => ({
        type: 'function' as const,
        name: spec.name,
        description: spec.description ?? '',
        parameters: (spec.inputSchema ?? {}) as Record<string, unknown>,
        // `null` defers to the OpenAI server default. The SDK's typed
        // contract requires a value; omitting it (as the Python SDK does)
        // is not an option here.
        strict: null,
      })),
    ]

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

  applyCacheConfig(request, config.cacheConfig)

  return request
}

/**
 * Formats SDK messages into Responses API input items.
 *
 * Per message, content blocks are split into three buckets:
 * - Text/media → grouped in `{ role, content: [...] }`
 * - Tool calls → separate `{ type: 'function_call', ... }` items
 * - Tool results → separate `{ type: 'function_call_output', ... }` items
 */
function formatResponsesMessages(messages: Message[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = []

  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const contentItems: Array<Record<string, unknown>> = []
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

        case 'toolUseBlock': {
          const toolBlock = block as { name: string; toolUseId: string; input: unknown }
          const call: ResponseFunctionToolCall = {
            type: 'function_call',
            call_id: toolBlock.toolUseId,
            name: toolBlock.name,
            arguments: JSON.stringify(toolBlock.input),
          }
          toolCallItems.push(call)
          break
        }

        case 'toolResultBlock': {
          const resultBlock = block as ToolResultBlock
          const result: ResponseInputItem.FunctionCallOutput = {
            type: 'function_call_output',
            call_id: resultBlock.toolUseId,
            output: formatToolResultOutput(resultBlock),
          }
          toolResultItems.push(result)
          break
        }

        case 'reasoningBlock': {
          logger.warn(
            'block_type=<reasoningBlock> | reasoning content is not yet supported in multi-turn conversations with the responses api'
          )
          break
        }

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

    input.push(...toolCallItems)
    input.push(...toolResultItems)
  }

  return input
}

/**
 * Builds a Responses API `function_call_output.output` value from a SDK
 * `toolResultBlock`. Returns a plain string for text-only results (joined with
 * newlines) or the content-item array shape when the result carries image or
 * document data.
 */
function formatToolResultOutput(resultBlock: ToolResultBlock): string | ResponseFunctionCallOutputItem[] {
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
  toolCalls: Map<string, { name: string; arguments: string; callId: string; itemId: string }>
  finalUsage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadInputTokens?: number
  } | null
  stopReason: StopReason
}

/**
 * Creates fresh stream state for a new Responses API stream.
 *
 * @internal
 */
export function createResponsesStreamState(): ResponsesStreamState {
  return {
    dataType: null,
    toolCalls: new Map(),
    finalUsage: null,
    stopReason: 'endTurn',
  }
}

/**
 * Maps a Responses API `usage` object to the SDK's usage shape, including
 * prompt-cache reads. The Responses API reports cache hits via
 * `usage.input_tokens_details.cached_tokens`; surfacing it as
 * `cacheReadInputTokens` keeps the Responses path consistent with the Bedrock,
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
        const { id: itemId, call_id: callId, name } = event.item
        if (!itemId) {
          logger.warn(`call_id=<${callId}> name=<${name}> | function_call event missing item id — skipping`)
          break
        }
        state.toolCalls.set(itemId, { name, arguments: '', callId, itemId })
      }
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
      start: { type: 'toolUseStart', name: tc.name, toolUseId: tc.callId },
    })
    events.push({
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'toolUseInputDelta', input: tc.arguments },
    })
    events.push({ type: 'modelContentBlockStopEvent' })
  }

  // maxTokens wins over toolUse: a function call that is still in flight when the
  // response is cut off has truncated arguments, so it must not be executed.
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
