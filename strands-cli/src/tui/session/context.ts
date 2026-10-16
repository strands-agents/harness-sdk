import { createHash } from 'node:crypto'
import type { AgentResult, Message } from '@strands-agents/sdk'

import type { ChatContextBreakdown, ChatContextUsage } from '../chat/types.js'
import type { AgentModelRuntime } from '../model/runtime.js'
import { isRecord } from '../values.js'

const CONTEXT_METADATA_KEY = 'strands.context.v1'
const CONTEXT_CATEGORY_KINDS = new Set<ChatContextBreakdown['categories'][number]['kind']>([
  'systemPrompt',
  'tools',
  'userMessages',
  'assistantMessages',
  'toolResults',
  'injectedContext',
  'other',
])

export function restoreContext(runtime: AgentModelRuntime, scope: string | undefined): ChatContextUsage | undefined {
  const message = runtime.agent.messages?.at(-1)
  if (message?.role !== 'assistant') {
    return undefined
  }
  const stored = message.metadata?.custom?.[CONTEXT_METADATA_KEY]
  const fingerprint = contextFingerprint(runtime, scope)
  if (!fingerprint || !isRecord(stored) || stored.fingerprint !== fingerprint) {
    return undefined
  }
  return parseContextUsage(stored.context)
}

export async function persistContext(
  runtime: AgentModelRuntime,
  scope: string | undefined,
  result: AgentResult,
  context: ChatContextUsage | undefined
): Promise<void> {
  if (!context || result.lastMessage?.trackingId !== runtime.agent.messages?.at(-1)?.trackingId) {
    return
  }
  if (!storeContext(runtime, scope, context)) {
    return
  }
  try {
    await runtime.agent.sessionManager?.saveSnapshot({
      target: runtime.agent,
      isLatest: true,
    })
  } catch {
    // A meter persistence failure must not turn a completed model response into a failed turn.
  }
}

/**
 * Records the context usage on the latest assistant message so a resumed session restores the meter.
 * The caller saves the session snapshot.
 */
export function storeContext(
  runtime: AgentModelRuntime,
  scope: string | undefined,
  context: ChatContextUsage
): boolean {
  const messages = runtime.agent.messages
  const message = messages?.at(-1)
  const fingerprint = contextFingerprint(runtime, scope)
  if (Object.keys(context).length === 0 || message?.role !== 'assistant' || !fingerprint) {
    return false
  }
  for (let index = messages.length - 2; index >= 0; index--) {
    if (clearStoredContext(messages[index])) {
      break
    }
  }
  const { breakdown, ...usage } = context
  message.metadata = {
    ...message.metadata,
    custom: {
      ...message.metadata?.custom,
      [CONTEXT_METADATA_KEY]: {
        fingerprint,
        context: {
          ...usage,
          ...(breakdown
            ? { breakdown: { categories: breakdown.categories.map((category) => ({ ...category })) } }
            : {}),
        },
      },
    },
  }
  return true
}

function contextFingerprint(runtime: AgentModelRuntime, scope: string | undefined): string | undefined {
  const agent = runtime.agent
  const value = {
    scope,
    runtime: runtime.forkConfiguration(),
    modelType: agent.model.constructor.name,
    modelConfig: agent.model.getConfig(),
    systemPrompt: agent.systemPrompt,
    tools: (agent.tools ?? []).map((tool) => tool.toolSpec),
  }
  try {
    const serialized = JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === 'bigint' || typeof candidate === 'function' || typeof candidate === 'symbol') {
        throw new TypeError('Context compatibility values must be JSON-serializable.')
      }
      if (isRecord(candidate)) {
        return Object.fromEntries(
          Object.entries(candidate).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        )
      }
      return candidate
    })
    return createHash('sha256').update(serialized).digest('hex')
  } catch {
    return undefined
  }
}

export function clearStoredContext(message: Message | undefined): boolean {
  const custom = message?.metadata?.custom
  if (!custom || !(CONTEXT_METADATA_KEY in custom)) {
    return false
  }
  const nextCustom = { ...custom }
  delete nextCustom[CONTEXT_METADATA_KEY]
  message.metadata = { ...message.metadata, custom: nextCustom }
  return true
}

function parseContextUsage(value: unknown): ChatContextUsage | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const parsed: Record<string, number> = {}
  for (const field of [
    'currentTokens',
    'projectedTokens',
    'contextWindow',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadInputTokens',
    'cacheWriteInputTokens',
  ]) {
    const candidate = value[field]
    if (candidate === undefined) {
      continue
    }
    if (
      typeof candidate !== 'number' ||
      !Number.isSafeInteger(candidate) ||
      candidate < 0 ||
      (field === 'contextWindow' && candidate === 0)
    ) {
      return undefined
    }
    parsed[field] = candidate
  }
  if (Object.keys(parsed).length === 0) {
    return undefined
  }
  const breakdown = parseContextBreakdown(value.breakdown, parsed.projectedTokens ?? parsed.currentTokens)
  return { ...parsed, ...(breakdown ? { breakdown } : {}) }
}

function parseContextBreakdown(value: unknown, occupiedTokens: number | undefined): ChatContextBreakdown | undefined {
  if (!isRecord(value) || !Array.isArray(value.categories) || occupiedTokens === undefined) {
    return undefined
  }
  const categories: ChatContextBreakdown['categories'][number][] = []
  const seen = new Set<string>()
  let total = 0
  for (const category of value.categories) {
    if (
      !isRecord(category) ||
      !CONTEXT_CATEGORY_KINDS.has(category.kind as ChatContextBreakdown['categories'][number]['kind']) ||
      seen.has(category.kind as string) ||
      typeof category.tokens !== 'number' ||
      !Number.isSafeInteger(category.tokens) ||
      category.tokens < 0
    ) {
      return undefined
    }
    const kind = category.kind as ChatContextBreakdown['categories'][number]['kind']
    categories.push({ kind, tokens: category.tokens })
    seen.add(kind)
    total += category.tokens
  }
  return Number.isSafeInteger(total) && total === occupiedTokens ? { categories } : undefined
}
