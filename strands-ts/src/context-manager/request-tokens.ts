/**
 * Token counting for the request a context strategy is gated on.
 */

import { ModelProxy } from '../models/model-proxy.js'
import type { LocalAgent } from '../types/agent.js'
import type { Message } from '../types/messages.js'

/**
 * Counts what the next request carries: the messages, plus the system prompt and tool specs that occupy the same
 * context window. Matches the inputs behind `BeforeModelCallEvent.projectedInputTokens`, so a utilization gate reads
 * the same number the agent's own projection would.
 *
 * Counts that measure a single block or a subset rather than a whole request call `countTokens` directly — including
 * the system prompt there would inflate every block against its threshold.
 *
 * @param agent - The agent whose system prompt and tool specs the request carries
 * @param messages - The messages the request would send
 * @returns Total input token count for the request
 * @internal
 */
export async function countRequestTokens(agent: LocalAgent, messages: Message[]): Promise<number> {
  return new ModelProxy(agent.model).countTokens(messages, {
    ...(agent.systemPrompt !== undefined && { systemPrompt: agent.systemPrompt }),
    toolSpecs: agent.toolRegistry.list().map((tool) => tool.toolSpec),
  })
}
