/**
 * Anthropic on-demand compaction: the beta, and how a compaction block is stored and sent back.
 *
 * A compaction block is stored as a {@link TextBlock} whose `text` is the block's `content` and whose
 * `providerData.data` holds every other field the API returned, unchanged. Sending it back restores the block
 * exactly as returned.
 *
 * @internal
 */

import type Anthropic from '@anthropic-ai/sdk'
import { TextBlock } from '../types/messages.js'
import type { ContentBlock, Message } from '../types/messages.js'
import { logger } from '../logging/logger.js'
import type { Usage } from './streaming.js'
import type { SummaryResult } from './summary.js'

/**
 * Beta that enables on-demand compaction and compaction blocks in later requests.
 *
 * @internal
 */
export const COMPACTION_BETA = 'compact-2026-09-04'

/**
 * `providerData.provider` of a block only Anthropic can read.
 *
 * @internal
 */
export const ANTHROPIC_PROVIDER = 'anthropic'

/**
 * Formats a block that holds Anthropic provider data as the block the API returned.
 *
 * @internal
 * @param block - A text block
 * @returns The returned block with its `content` restored from `text`, or undefined for any other text block
 */
export function formatNativeBlock(block: TextBlock): Anthropic.ContentBlockParam | undefined {
  if (block.providerData?.provider !== ANTHROPIC_PROVIDER) return undefined
  return { ...(block.providerData.data as object), content: block.text } as unknown as Anthropic.ContentBlockParam
}

/**
 * Formats a text block: Anthropic's own provider data as the block the API returned, anything else as plain text.
 *
 * @internal
 * @param block - A text block
 * @returns The block to send
 */
export function formatTextBlock(block: TextBlock): Anthropic.ContentBlockParam {
  return formatNativeBlock(block) ?? { type: 'text', text: block.text }
}

/**
 * Whether any message carries a block only Anthropic can read, so the request needs {@link COMPACTION_BETA}.
 *
 * @internal
 * @param messages - The messages of a request
 * @returns True when a block with Anthropic provider data is present
 */
export function carriesNativeBlock(messages: Message[]): boolean {
  return messages.some((message) => message.content.some(isNativeBlock))
}

function isNativeBlock(block: ContentBlock): boolean {
  return block instanceof TextBlock && block.providerData?.provider === ANTHROPIC_PROVIDER
}

/**
 * Stores a returned compaction block: `content` as the text, every other field as opaque provider data.
 *
 * @internal
 * @param block - A `compaction` block from a response
 * @returns The stored block, or undefined when the block holds no summary
 */
export function storeCompactionBlock(block: Record<string, unknown>): TextBlock | undefined {
  const { content, ...data } = block
  if (typeof content !== 'string' || content.length === 0) return undefined
  return new TextBlock(content, { providerData: { provider: ANTHROPIC_PROVIDER, data } })
}

/**
 * Turns a conversation request into an on-demand compaction request. Leaves out what the API rejects on, or refuses to combine
 * with, a compaction request: `stop_sequences`, a structured-output `output_config.format`, a `tool_choice` that
 * forces a tool, `output_config.task_budget.remaining`, and `context_management`. `compaction` is not in the installed SDK's request types; the client sends body fields as given.
 *
 * @internal
 * @param request - The request the model would send for the same messages, system prompt and tools
 * @param instructions - Summarization instructions replacing the API's own prompt
 * @returns The compaction request
 */
export function compactionParams(
  request: Anthropic.MessageStreamParams,
  instructions: string | undefined
): Anthropic.Beta.Messages.MessageCreateParamsStreaming {
  const {
    stop_sequences: _stopSequences,
    tool_choice: toolChoice,
    output_config: outputConfig,
    context_management: _contextManagement,
    ...rest
  } = request as Anthropic.MessageStreamParams & { context_management?: unknown }
  const { format: _format, ...keptOutputConfig } = (outputConfig ?? {}) as Record<string, unknown>
  const taskBudget = keptOutputConfig.task_budget as Record<string, unknown> | undefined
  if (taskBudget && 'remaining' in taskBudget) {
    const { remaining: _remaining, ...keptBudget } = taskBudget
    keptOutputConfig.task_budget = keptBudget
  }
  const params: Record<string, unknown> = {
    ...rest,
    ...(toolChoice && toolChoice.type !== 'any' && toolChoice.type !== 'tool' && { tool_choice: toolChoice }),
    ...(Object.keys(keptOutputConfig).length > 0 && { output_config: keptOutputConfig }),
    compaction: { type: 'summarize', ...(instructions && { instructions }) },
  }
  return params as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming
}

/**
 * Reads a compaction response.
 *
 * @internal
 * @param response - The response message
 * @param modelId - The model id, for the log line
 * @returns The stored summary and the compaction iteration's usage, or undefined when no summary was written
 */
export function readCompaction(
  response: Anthropic.Beta.Messages.BetaMessage,
  modelId: string | undefined
): SummaryResult | undefined {
  const returned = (response.content as unknown as Record<string, unknown>[]).find(
    (block) => block.type === 'compaction'
  )
  const block =
    response.stop_reason === ('compaction' as string) && returned ? storeCompactionBlock(returned) : undefined
  if (!block) {
    logger.warn(`model_id=<${modelId}>, stop_reason=<${response.stop_reason}> | compaction returned no summary`)
    return undefined
  }
  const usage = compactionUsage(response.usage)
  return { block, ...(usage && { usage }) }
}

/** The usage of the compaction iteration; the top-level counts of a compaction response are zero. */
function compactionUsage(usage: Anthropic.Beta.Messages.BetaUsage): Usage | undefined {
  const iteration = usage.iterations?.find((entry) => entry.type === 'compaction') as
    Anthropic.Beta.Messages.BetaCompactionIterationUsage | undefined
  if (!iteration) return undefined
  const inputTokens = iteration.input_tokens ?? 0
  const outputTokens = iteration.output_tokens ?? 0
  const cacheRead = iteration.cache_read_input_tokens ?? 0
  const cacheWrite = iteration.cache_creation_input_tokens ?? 0
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cacheRead > 0 && { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite > 0 && { cacheWriteInputTokens: cacheWrite }),
  }
}
