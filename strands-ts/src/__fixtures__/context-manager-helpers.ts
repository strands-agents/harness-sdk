/**
 * Shared helpers for context-manager tests: messages, a character-based token count, and a
 * {@link ContextState} over a mock agent.
 */

import { isOffloaded, Message, TextBlock, ToolResultBlock } from '../types/messages.js'
import type { OffloadedBlockData, OffloadMethod } from '../types/messages.js'
import type { Agent } from '../agent/agent.js'
import type { ContextState } from '../context-manager/types.js'
import type { Stash } from '../context-manager/stash.js'
import { createMockAgent } from './agent-helpers.js'

/** A user message holding one successful tool result with the given text. */
export function makeToolResultMessage(text: string, toolUseId = 'tool-123'): Message {
  return new Message({
    role: 'user',
    content: [new ToolResultBlock({ toolUseId, status: 'success', content: [new TextBlock(text)] })],
  })
}

/** The offload method that left `block` as a placeholder, or undefined when it is not one. */
export function offloadedBy(block: unknown): OffloadMethod | undefined {
  return isOffloaded(block) ? block.metadata.offloaded.method : undefined
}

/** The metadata of every placeholder in `messages`, including those inside tool results, in history order. */
export function placeholdersIn(messages: Message[]): OffloadedBlockData[] {
  return messages
    .flatMap((message) => message.content)
    .flatMap((block): unknown[] => (block instanceof ToolResultBlock ? block.content : [block]))
    .filter(isOffloaded)
    .map((block) => block.metadata.offloaded)
}

/** Counts text at four characters per token and everything else at two characters per token of its JSON. */
export function heuristicCountTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block instanceof TextBlock) {
        total += Math.ceil(block.text.length / 4)
      } else if (block instanceof ToolResultBlock) {
        for (const content of block.content) {
          if (content instanceof TextBlock) total += Math.ceil(content.text.length / 4)
          else total += Math.ceil(JSON.stringify(content).length / 2)
        }
      } else {
        total += Math.ceil(JSON.stringify(block).length / 2)
      }
    }
  }
  return total
}

export interface MakeContextOptions {
  /** Stash the strategies may write to. */
  stash?: Stash
  /** Context window utilization reported to the strategies. Defaults to 0.5. */
  utilization?: number
  /** Whether the strategies run on an overflow. */
  overflow?: boolean
  /**
   * Extra members of the agent's model, merged over {@link heuristicCountTokens}. `null` leaves the
   * agent without a model.
   */
  model?: object | null
}

/** A {@link ContextState} over a mock agent whose model counts tokens with {@link heuristicCountTokens}. */
export function makeContext(messages: Message[], options: MakeContextOptions = {}): ContextState {
  const { stash, utilization = 0.5, overflow, model = {} } = options
  const extra: Partial<Agent> =
    model === null
      ? {}
      : ({ model: { countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs), ...model } } as Partial<Agent>)
  const agent = createMockAgent({ messages, extra })
  return {
    messages,
    agent,
    utilization,
    ...(stash !== undefined && { stash }),
    ...(overflow && { overflow: true }),
  }
}
