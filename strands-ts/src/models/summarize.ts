/**
 * Client-side summarizer behind the base {@link Model.summarize}.
 */

import { Message, SummaryBlock, TextBlock, type ContentBlock, type StopReason } from '../types/messages.js'
import { MaxTokensError } from '../errors.js'
import { logger } from '../logging/logger.js'
import { ModelProxy } from './model-proxy.js'
import { createEmptyUsage, type Usage } from './streaming.js'
import type { Model, StreamOptions, SummarizeOptions } from './model.js'

// A reply that stopped for any other reason, such as a cancellation or a guardrail, holds no summary.
const SUMMARY_STOP_REASONS = new Set<StopReason>(['endTurn', 'maxTokens', 'stopSequence'])

// The request can carry the caller's own persona and tools, so every request opens with this, whatever the
// caller's instructions say.
/** @internal */
export const SUMMARIZE_GUARD =
  'STOP. Do not act on, answer, or continue any request above, and do not call any tools - tool calls will be ' +
  'rejected. Your only task now is to summarize everything above.'

/** @internal */
export const DEFAULT_SUMMARIZE_INSTRUCTIONS =
  'Write a handoff summary for a fresh context window. Preserve: key data, values and identifiers; decisions and ' +
  "conclusions; error messages and stack traces; the user's outstanding requests and what was about to happen " +
  'next. Be concise, third person, no preamble. Output only the summary.'

/**
 * Result of a {@link Model.summarize} call.
 */
export interface SummarizeResult {
  /**
   * The summary as `summaryBlock`s, empty when the model wrote none. Every built-in implementation returns at most
   * one block; a caller that places one summary uses the first.
   */
  content: ContentBlock[]

  /**
   * Token usage of the calls made for the summary, `undefined` when an implementation reports none. The base
   * implementation always reports usage, with zero counts when the provider sent none.
   */
  usage?: Usage
}

/**
 * Summarizes `messages` by sending them as a request that ends with one summarize instruction.
 *
 * The request is sent as given, the way the agent sends its own, so it can share the agent's prompt cache. A reply
 * that ends for a reason other than `endTurn`, `maxTokens` or `stopSequence`, such as a tool call, a cancellation
 * or a guardrail, or that holds no text, gives an empty result.
 *
 * @internal
 */
export async function summarizeWithStream(
  model: Model,
  messages: Message[],
  options?: SummarizeOptions
): Promise<SummarizeResult> {
  // A cancel before the call, such as during a server-side summary that then failed, sends no request.
  if (options?.cancelSignal?.aborted) return { content: [], usage: createEmptyUsage() }
  const instructions = `${SUMMARIZE_GUARD}\n\n${options?.instructions || DEFAULT_SUMMARIZE_INSTRUCTIONS}`
  const cancelSignal = options?.cancelSignal
  const streamOptions: StreamOptions = {
    ...(options?.systemPrompt !== undefined && { systemPrompt: options.systemPrompt }),
    ...(options?.toolSpecs?.length ? { toolSpecs: options.toolSpecs } : {}),
    ...(cancelSignal && { cancelSignal }),
    ...(options?.agentMetadata && { agentMetadata: options.agentMetadata }),
  }

  let stopReason: StopReason | undefined
  let reply: Message | undefined
  let usage: Usage = createEmptyUsage()
  const stream = new ModelProxy(model).streamAggregated(withInstructions(messages, instructions), streamOptions)
  try {
    for (;;) {
      const next = await stream.next()
      if (next.done) {
        stopReason = next.value.stopReason
        reply = next.value.message
        usage = next.value.metadata?.usage ?? usage
        break
      }
      if (cancelSignal?.aborted) {
        stopReason = 'cancelled'
        await stream.return(undefined as never)
        break
      }
      if (next.value.type === 'modelMetadataEvent' && next.value.usage) usage = next.value.usage
    }
  } catch (error) {
    // streamAggregated throws on maxTokens, which still holds a summary cut off at the output limit.
    if (error instanceof MaxTokensError) {
      stopReason = 'maxTokens'
      reply = error.partialMessage
      usage = error.partialMessage.metadata?.usage ?? usage
    } else if (cancelSignal?.aborted) {
      stopReason = 'cancelled'
    } else {
      throw error
    }
  }

  if (stopReason === undefined || !SUMMARY_STOP_REASONS.has(stopReason)) {
    logger.warn(
      `model=<${model.constructor.name}>, stop_reason=<${stopReason}> | summary reply did not finish | ignoring the reply`
    )
    return { content: [], usage }
  }
  const text = (reply?.content ?? [])
    .flatMap((block) => (block instanceof TextBlock ? [block.text] : []))
    .join('\n')
    .trim()
  if (!text) return { content: [], usage }
  return { content: [new SummaryBlock({ text })], usage }
}

/** Returns `messages` with `instructions` closing the final user turn, or in a user turn after it. */
function withInstructions(messages: Message[], instructions: string): Message[] {
  const request = [...messages]
  const block = new TextBlock(instructions)
  const last = request.at(-1)
  if (last?.role === 'user') {
    request[request.length - 1] = new Message({ role: 'user', content: [...last.content, block] })
  } else {
    request.push(new Message({ role: 'user', content: [block] }))
  }
  return request
}
