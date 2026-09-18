import type { StopReason } from '../../types/messages.js'
import type { ModelStreamEvent, Usage } from '../streaming.js'

const THOUGHT_SIGNATURE_SEPARATOR = '__thought__'

interface LiteLLMUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  cache_creation_input_tokens?: number
}

interface LiteLLMToolCall {
  index?: number
  id?: string
  provider_specific_fields?: { thought_signature?: unknown }
  function?: {
    name?: string
    arguments?: string
  }
}

interface LiteLLMMessagePayload {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: LiteLLMToolCall[]
}

interface LiteLLMChoice {
  delta?: LiteLLMMessagePayload
  message?: LiteLLMMessagePayload
  finish_reason?: string | null
}

interface LiteLLMCompletion {
  choices?: LiteLLMChoice[]
  usage?: LiteLLMUsage
}

interface ContentState {
  active?: 'reasoning' | 'text'
}

/**
 * Maps a non-streaming LiteLLM completion to SDK stream events.
 *
 * @internal
 * @param response - Raw LiteLLM gateway completion payload.
 * @returns SDK events representing the completed response.
 */
export function* mapNonStreamingResponse(response: unknown): Generator<ModelStreamEvent> {
  const completion = asCompletion(response)
  const choice = completion.choices?.[0]
  const contentState: ContentState = {}
  const toolCalls = new Map<number, LiteLLMToolCall[]>()

  yield { type: 'modelMessageStartEvent', role: 'assistant' }
  if (choice?.message) {
    yield* mapPayloadContent(choice.message, contentState)
    collectToolCalls(choice.message.tool_calls, toolCalls, false)
  }
  yield* closeContent(contentState)
  yield* mapToolCalls(toolCalls)
  yield { type: 'modelMessageStopEvent', stopReason: mapStopReason(choice?.finish_reason) }
  if (completion.usage) yield { type: 'modelMetadataEvent', usage: mapUsage(completion.usage) }
}

/**
 * Maps a streaming LiteLLM completion sequence to SDK stream events.
 *
 * @internal
 * @param response - Raw LiteLLM gateway completion stream.
 * @returns SDK events emitted as gateway chunks arrive.
 */
export async function* mapStreamingResponse(response: AsyncIterable<unknown>): AsyncIterable<ModelStreamEvent> {
  const contentState: ContentState = {}
  const toolCalls = new Map<number, LiteLLMToolCall[]>()
  let stopReason: StopReason = 'endTurn'
  let usage: Usage | undefined

  yield { type: 'modelMessageStartEvent', role: 'assistant' }
  for await (const rawChunk of response) {
    const chunk = asCompletion(rawChunk)
    if (chunk.usage) usage = mapUsage(chunk.usage)
    const choice = chunk.choices?.[0]
    if (!choice) continue
    if (choice.delta) {
      yield* mapPayloadContent(choice.delta, contentState)
      collectToolCalls(choice.delta.tool_calls, toolCalls, true)
    }
    if (choice.finish_reason) stopReason = mapStopReason(choice.finish_reason)
  }

  yield* closeContent(contentState)
  yield* mapToolCalls(toolCalls)
  yield { type: 'modelMessageStopEvent', stopReason }
  if (usage) yield { type: 'modelMetadataEvent', usage }
}

function asCompletion(value: unknown): LiteLLMCompletion {
  if (!value || typeof value !== 'object') return {}
  return value as LiteLLMCompletion
}

function* mapPayloadContent(payload: LiteLLMMessagePayload, state: ContentState): Generator<ModelStreamEvent> {
  if (payload.reasoning_content) {
    yield* switchContent(state, 'reasoning')
    yield {
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'reasoningContentDelta', text: payload.reasoning_content },
    }
  }
  if (payload.content) {
    yield* switchContent(state, 'text')
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: payload.content } }
  }
}

function* switchContent(state: ContentState, next: 'reasoning' | 'text'): Generator<ModelStreamEvent> {
  if (state.active === next) return
  if (state.active !== undefined) yield { type: 'modelContentBlockStopEvent' }
  state.active = next
  yield { type: 'modelContentBlockStartEvent' }
}

function* closeContent(state: ContentState): Generator<ModelStreamEvent> {
  if (state.active === undefined) return
  delete state.active
  yield { type: 'modelContentBlockStopEvent' }
}

function collectToolCalls(
  deltas: LiteLLMToolCall[] | undefined,
  toolCalls: Map<number, LiteLLMToolCall[]>,
  useWireIndex: boolean
): void {
  for (const [position, delta] of (deltas ?? []).entries()) {
    const index = useWireIndex ? (delta.index ?? position) : position
    const collected = toolCalls.get(index) ?? []
    collected.push(delta)
    toolCalls.set(index, collected)
  }
}

function* mapToolCalls(toolCalls: Map<number, LiteLLMToolCall[]>): Generator<ModelStreamEvent> {
  for (const deltas of toolCalls.values()) {
    const first = deltas[0]
    if (!first) continue
    const toolUseId = deltas.find((delta) => delta.id)?.id ?? `call_${globalThis.crypto.randomUUID()}`
    const name = deltas.find((delta) => delta.function?.name)?.function?.name ?? ''
    const reasoningSignature = extractThoughtSignature(first, toolUseId)
    yield {
      type: 'modelContentBlockStartEvent',
      start: {
        type: 'toolUseStart',
        name,
        toolUseId,
        ...(reasoningSignature !== undefined && { reasoningSignature }),
      },
    }
    for (const delta of deltas) {
      if (delta.function?.arguments) {
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: delta.function.arguments },
        }
      }
    }
    yield { type: 'modelContentBlockStopEvent' }
  }
}

function extractThoughtSignature(first: LiteLLMToolCall, toolUseId: string): string | undefined {
  const structured = first.provider_specific_fields?.thought_signature
  if (typeof structured === 'string' && structured.length > 0) return structured
  const separatorIndex = toolUseId.indexOf(THOUGHT_SIGNATURE_SEPARATOR)
  return separatorIndex >= 0 ? toolUseId.slice(separatorIndex + THOUGHT_SIGNATURE_SEPARATOR.length) : undefined
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_calls':
      return 'toolUse'
    case 'length':
      return 'maxTokens'
    case 'content_filter':
      return 'contentFiltered'
    case 'stop':
    case null:
    case undefined:
      return 'endTurn'
    default:
      return reason.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
  }
}

function mapUsage(usage: LiteLLMUsage): Usage {
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    ...(usage.prompt_tokens_details?.cached_tokens !== undefined && {
      cacheReadInputTokens: usage.prompt_tokens_details.cached_tokens,
    }),
    ...(usage.cache_creation_input_tokens !== undefined && {
      cacheWriteInputTokens: usage.cache_creation_input_tokens,
    }),
  }
}
