import { createHash } from 'node:crypto'
import type { AgentResult, Message } from '@strands-agents/sdk'

import type { ChatContextUsage } from '../chat/types.js'
import type { AgentModelRuntime } from '../model/runtime.js'

const CONTEXT_METADATA_KEY = 'strands.context.v1'

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
  if (!context || Object.keys(context).length === 0) {
    return
  }
  const message = runtime.agent.messages?.at(-1)
  const fingerprint = contextFingerprint(runtime, scope)
  if (message?.role !== 'assistant' || result.lastMessage?.trackingId !== message.trackingId || !fingerprint) {
    return
  }
  const messages = runtime.agent.messages
  for (let index = messages.length - 2; index >= 0; index--) {
    if (clearStoredContext(messages[index])) {
      break
    }
  }
  message.metadata = {
    ...message.metadata,
    custom: {
      ...message.metadata?.custom,
      [CONTEXT_METADATA_KEY]: {
        fingerprint,
        context: { ...context },
      },
    },
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
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
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
  return Object.keys(parsed).length > 0 ? parsed : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
