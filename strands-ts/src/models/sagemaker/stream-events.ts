/**
 * Turns OpenAI Chat Completions chunks returned by a SageMaker endpoint into SDK stream events.
 *
 * @internal
 */

import type { StopReason } from '../../types/messages.js'
import type { ModelStreamEvent, Usage } from '../streaming.js'
import { ModelError } from '../../errors.js'
import { logger } from '../../logging/logger.js'
import type { ChatChoice, ChatToolCallDelta, ChatUsage, StreamChunk } from './stream-parser.js'

type OpenBlock = 'text' | 'reasoning' | undefined

const STOP_REASONS: Record<string, StopReason> = {
  stop: 'endTurn',
  tool_calls: 'toolUse',
  length: 'maxTokens',
  content_filter: 'contentFiltered',
}

/**
 * Accumulates chunks of one response and yields SDK events.
 *
 * Text and reasoning are streamed as they arrive, one open block at a time. Tool calls are buffered
 * and emitted after the last chunk, because OpenAI-compatible containers may send a tool call's id
 * and name in different deltas than its arguments.
 *
 * @internal
 */
export class ChunkAccumulator {
  private _open: OpenBlock = undefined
  private _hasText = false
  private _finishReason = ''
  private _usage: Usage | undefined
  private readonly _toolCalls = new Map<number, ChatToolCallDelta[]>()

  /** The event that opens the message. */
  start(): ModelStreamEvent {
    return { type: 'modelMessageStartEvent', role: 'assistant' }
  }

  /** Events for one decoded chunk. */
  *push(chunk: StreamChunk): Generator<ModelStreamEvent> {
    if (chunk.usage) this._usage = toUsage(chunk.usage)
    const choice = chunk.choices?.[0]
    // Chunks after the finish reason carry nothing but usage.
    if (!choice || this._finishReason) return
    if (choice.usage) this._usage = toUsage(choice.usage)
    yield* this._pushDelta(choice)
    if (choice.finish_reason) this._finishReason = choice.finish_reason
  }

  /** Events that close the message once the stream has ended. */
  *finish(): Generator<ModelStreamEvent> {
    yield* this._close()
    yield* this._toolEvents()
    // Callers expect a message to hold at least one block.
    if (!this._hasText && this._toolCalls.size === 0) {
      yield { type: 'modelContentBlockStartEvent' }
      yield { type: 'modelContentBlockStopEvent' }
    }
    if (this._usage) yield { type: 'modelMetadataEvent', usage: this._usage }
    yield { type: 'modelMessageStopEvent', stopReason: this._stopReason() }
  }

  private *_pushDelta(choice: ChatChoice): Generator<ModelStreamEvent> {
    const delta = choice.delta ?? {}
    // vLLM 0.16 and later name the field `reasoning`.
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (reasoning) {
      yield* this._openBlock('reasoning')
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: reasoning } }
    }
    if (delta.content) {
      yield* this._openBlock('text')
      this._hasText = true
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: delta.content } }
    }
    for (const toolCall of delta.tool_calls ?? []) {
      const deltas = this._toolCalls.get(toolCall.index) ?? []
      deltas.push(toolCall)
      this._toolCalls.set(toolCall.index, deltas)
    }
  }

  private *_openBlock(block: Exclude<OpenBlock, undefined>): Generator<ModelStreamEvent> {
    if (this._open === block) return
    yield* this._close()
    this._open = block
    yield { type: 'modelContentBlockStartEvent' }
  }

  private *_close(): Generator<ModelStreamEvent> {
    if (this._open === undefined) return
    this._open = undefined
    yield { type: 'modelContentBlockStopEvent' }
  }

  private *_toolEvents(): Generator<ModelStreamEvent> {
    for (const [index, deltas] of this._toolCalls) {
      const name = deltas.find((d) => d.function?.name)?.function?.name
      if (!name) {
        throw new ModelError(`SageMaker endpoint returned tool call ${index} without a tool name`)
      }
      const toolUseId = deltas.find((d) => d.id)?.id ?? `tool_call_${index}`
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId } }
      for (const d of deltas) {
        const input = d.function?.arguments
        if (input) yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input } }
      }
      yield { type: 'modelContentBlockStopEvent' }
    }
  }

  private _stopReason(): StopReason {
    // Some containers end a tool call with "stop" or with no finish reason at all.
    if (this._toolCalls.size > 0 && (this._finishReason === '' || this._finishReason === 'stop')) {
      return 'toolUse'
    }
    if (this._finishReason === '') return 'endTurn'
    const mapped = STOP_REASONS[this._finishReason]
    if (mapped) return mapped
    logger.warn(`finish_reason=<${this._finishReason}> | unknown finish reason from SageMaker endpoint | using endTurn`)
    return 'endTurn'
  }
}

/**
 * Rewrites a non-streaming response as one chunk, so both modes share {@link ChunkAccumulator}.
 *
 * @internal
 */
export function responseToChunk(body: unknown): StreamChunk {
  const response = (body ?? {}) as {
    choices?: Array<{ message?: Record<string, unknown>; finish_reason?: string | null }>
    usage?: ChatUsage
  }
  const choice = response.choices?.[0]
  if (!choice?.message) {
    throw new ModelError('SageMaker endpoint returned a response without choices[0].message')
  }
  const { content, reasoning_content, reasoning, tool_calls } = choice.message as {
    content?: string | null
    reasoning_content?: string
    reasoning?: string
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>
  }
  const toolCalls: ChatToolCallDelta[] = (tool_calls ?? []).map((call, index) => ({
    index,
    ...(call.id !== undefined && { id: call.id }),
    function: {
      ...(call.function?.name !== undefined && { name: call.function.name }),
      arguments: stringifyArguments(call.function?.arguments),
    },
  }))
  return {
    choices: [
      {
        index: 0,
        delta: {
          ...(typeof content === 'string' && { content }),
          ...(reasoning_content !== undefined && { reasoning_content }),
          ...(reasoning !== undefined && { reasoning }),
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        finish_reason: choice.finish_reason ?? null,
      },
    ],
    ...(response.usage !== undefined && { usage: response.usage }),
  }
}

function stringifyArguments(args: unknown): string {
  if (args === undefined || args === null) return ''
  return typeof args === 'string' ? args : JSON.stringify(args)
}

function toUsage(usage: ChatUsage): Usage {
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
  }
}
