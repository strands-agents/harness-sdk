/**
 * Request and result of one summary operation, shared by the summarize strategy's summarizers and
 * `Model.compact`.
 */

import type { Message, SystemPrompt, TextBlock } from '../types/messages.js'
import type { ToolSpec } from '../tools/types.js'
import type { Usage } from './streaming.js'

/**
 * What to summarize, and the settings of the summary request.
 *
 * @experimental
 */
export interface SummaryRequest {
  /** The messages to summarize, left unmodified. */
  messages: Message[]

  /** The live conversation's system prompt; set only for `Model.compact`, which must send it unchanged. */
  systemPrompt?: SystemPrompt

  /** The live conversation's tool specifications; set only for `Model.compact`, which must send them unchanged. */
  toolSpecs?: ToolSpec[]

  /** Summarization instructions that replace the default ones. */
  instructions?: string

  /** Signal that aborts the request. */
  cancelSignal?: AbortSignal
}

/**
 * A summary that replaces the summarized messages.
 *
 * @experimental
 */
export interface SummaryResult {
  /**
   * The summary. `text` is the summary alone; `metadata.offloaded` records what it replaced, and a provider's
   * native summary carries `providerData`.
   */
  block: TextBlock

  /** Token usage of the summary request, absent when the provider reports none. */
  usage?: Usage
}
