/**
 * Live harness for summarization on preserved-thinking Claude models over first-party Anthropic.
 *
 * Runs one bounded multi-turn tool task and forces a fixed number of summary passes, with test-local
 * instrumentation only: every HTTP status, every compaction block returned and replayed, every
 * `input_transformations` entry, and every SDK warning. Nothing logs keys or full conversations.
 *
 * Shared by `context-manager-native-compaction.test.node.ts` and `run-native-compaction.ts`.
 */

import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { Agent, Offload, configureLogging, tool } from '@strands-agents/sdk'
import type { ContextState, ContextStrategy, Logger } from '@strands-agents/sdk'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'

/** Verified on platform.claude.com compaction-on-demand (supported models), 2026-11-02. */
export const SONNET_5_5 = 'claude-sonnet-5-5'
export const HAIKU_5_5 = 'claude-haiku-5-5'

export const CODEWORD = 'PELICAN'
export const STEPS = 7
export const TASK = [
  `Read steps 1 to ${STEPS} in order with read_step, one call per turn.`,
  `Every read_step call must pass codeword "${CODEWORD}".`,
  'When all steps are read, reply with exactly: DONE <sum of the values>.',
].join(' ')
export const EXPECTED_SUM = Array.from({ length: STEPS }, (_, index) => (index + 1) * 7).reduce((sum, v) => sum + v, 0)
export const INSTRUCTIONS = [
  'Summarize the conversation so far for the assistant that continues it.',
  'Restate the original task from the first user message word for word, including the codeword.',
  'List every step already read with its value. Do not call tools; respond with the summary text only.',
].join(' ')

/** The thinking configuration: binding failures error instead of hiding behind an account default. */
export const STRICT_THINKING = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } }
const BINDING_BETA = 'thinking-binding-controls-2026-08-01'
const DROP_BLOCK_WARNING = 'history edit invalidated replayed thinking blocks, retrying with drop_block'

export interface HarnessOptions {
  apiKey: string
  mainModelId: string
  summarizerModelId: string
  /** `true` opts the summarizer into native compaction; `undefined` leaves the capability unset (base control). */
  serverSideCompaction: true | undefined
  /** Thinking config of both models; the base control may leave `block_binding` to the account. */
  thinking: Record<string, unknown>
  /** Model calls (1-based) that a summary pass precedes. */
  passBeforeCalls: number[]
  maxTokens?: number
}

/** One HTTP exchange, without bodies. */
export interface Exchange {
  kind: 'compaction' | 'conversation' | 'summarizer'
  model: string
  status: number
  /** Compaction blocks the response returned, as returned. */
  returned: Record<string, unknown>[]
  /** Compaction blocks the request carried, as sent. */
  sentCompaction: Record<string, unknown>[]
  /** Signatures of the thinking blocks the request carried. */
  sentThinking: string[]
  /** Signatures of the thinking blocks the response returned. */
  returnedThinking: string[]
  /** `input_transformations` entries seen in the response; `undefined` when the field never appeared. */
  inputTransformations: unknown[] | undefined
}

export interface HarnessReport {
  exchanges: Exchange[]
  warnings: string[]
  dropBlockWarnings: string[]
  codewordsAfterPass: string[][]
  passes: number
  finalText: string
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  messageZeroAfter: string
}

/** Runs the task once and returns what the wire and the agent saw. */
export async function runCompactionTask(options: HarnessOptions): Promise<HarnessReport> {
  const exchanges: Exchange[] = []
  const reads: Promise<void>[] = []
  const warnings: string[] = []
  const restore = captureWarnings(warnings)
  const codewords: string[][] = [[]]
  let passes = 0

  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 0, fetch: instrumentedFetch(exchanges, reads) })
  const maxTokens = options.maxTokens ?? 8192
  const model = new AnthropicModel({
    client,
    modelId: options.mainModelId,
    maxTokens,
    params: { thinking: options.thinking },
    betas: [BINDING_BETA],
  })
  const summarizer = new AnthropicModel({
    client,
    modelId: options.summarizerModelId,
    maxTokens,
    params: { thinking: options.thinking },
    betas: [BINDING_BETA],
    ...(options.serverSideCompaction && { modelInfo: { capabilities: { serverSideCompaction: true } } }),
  })

  const readStep = tool({
    name: 'read_step',
    description: 'Read the value of one step.',
    inputSchema: z.object({ n: z.number(), codeword: z.string() }),
    callback: ({ n, codeword }) => {
      codewords.at(-1)!.push(codeword)
      return `step ${n} value ${n * 7}`
    },
  })

  const summarize = Offload.summarize('*', { systemPrompt: INSTRUCTIONS }).when({ utilization: 0, preserveRecent: 3 })
  let calls = 0
  const atPlannedCalls: ContextStrategy = {
    name: 'test:planned-summary-passes',
    async apply(context: ContextState): Promise<boolean> {
      calls += 1
      if (!options.passBeforeCalls.includes(calls)) return false
      const acted = await summarize.apply({ ...context, utilization: 1 })
      if (acted) {
        passes += 1
        codewords.push([])
      }
      return acted
    },
  }

  try {
    const agent = new Agent({
      model,
      auxModel: summarizer,
      systemPrompt: 'You are a careful assistant that follows the task exactly.',
      tools: [readStep],
      printer: false,
      contextManager: { strategies: [atPlannedCalls], stash: false },
    })
    const result = await agent.invoke(TASK)
    await Promise.all(reads)
    const usage = result.invocationContext!.usage
    return {
      exchanges,
      warnings,
      dropBlockWarnings: warnings.filter((warning) => warning.includes(DROP_BLOCK_WARNING)),
      codewordsAfterPass: codewords.slice(1),
      passes,
      finalText: result.toString(),
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens },
      messageZeroAfter: agent.messages[0]!.content.map((block) => block.type).join(','),
    }
  } finally {
    restore()
  }
}

/** One-line summary of a report, with counts only. */
export function describeReport(report: HarnessReport): string {
  const kinds = (kind: Exchange['kind']): Exchange[] => report.exchanges.filter((exchange) => exchange.kind === kind)
  const transformations = (kind: Exchange['kind']): string =>
    kinds(kind)
      .map((exchange) =>
        exchange.inputTransformations === undefined ? '-' : String(exchange.inputTransformations.length)
      )
      .join(',')
  return JSON.stringify({
    passes: report.passes,
    requests: {
      compaction: kinds('compaction').length,
      conversation: kinds('conversation').length,
      summarizer: kinds('summarizer').length,
    },
    statuses: report.exchanges.map((exchange) => exchange.status),
    dropBlockWarnings: report.dropBlockWarnings.length,
    inputTransformations: { compaction: transformations('compaction'), conversation: transformations('conversation') },
    codewordsAfterPass: report.codewordsAfterPass,
    finalText: report.finalText.slice(0, 80),
    usage: report.usage,
    messageZeroAfter: report.messageZeroAfter,
  })
}

function captureWarnings(warnings: string[]): () => void {
  const forward: Logger = {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
  }
  configureLogging(forward)
  return () => configureLogging(console)
}

function instrumentedFetch(exchanges: Exchange[], reads: Promise<void>[]): typeof globalThis.fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const response = await globalThis.fetch(input, init)
    const exchange: Exchange = {
      kind: body.compaction ? 'compaction' : body.tools === undefined ? 'summarizer' : 'conversation',
      model: String(body.model),
      status: response.status,
      returned: [],
      sentCompaction: blocksOfType(body.messages, 'compaction'),
      sentThinking: blocksOfType(body.messages, 'thinking').map((block) => String(block.signature)),
      returnedThinking: [],
      inputTransformations: undefined,
    }
    exchanges.push(exchange)
    if (!response.body || !response.ok) return response
    const [forClient, forHarness] = response.body.tee()
    reads.push(readEvents(forHarness, exchange))
    return new Response(forClient, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

async function readEvents(stream: ReadableStream<Uint8Array>, exchange: Exchange): Promise<void> {
  const text = await new Response(stream).text()
  const signatures = new Map<number, string>()
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const event = JSON.parse(line.slice(6)) as Record<string, unknown>
    const found = findKey(event, 'input_transformations')
    if (found !== undefined)
      exchange.inputTransformations = [...(exchange.inputTransformations ?? []), ...(found as unknown[])]
    const block = event.content_block as Record<string, unknown> | undefined
    if (event.type === 'content_block_start' && block?.type === 'compaction') exchange.returned.push(block)
    const delta = event.delta as Record<string, unknown> | undefined
    if (delta?.type === 'signature_delta') signatures.set(Number(event.index), String(delta.signature))
  }
  exchange.returnedThinking = [...signatures.values()]
}

function blocksOfType(messages: unknown, type: string): Record<string, unknown>[] {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message: { content?: unknown }) =>
    Array.isArray(message.content)
      ? (message.content as Record<string, unknown>[]).filter((block) => block.type === type)
      : []
  )
}

function findKey(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  if (key in value) return (value as Record<string, unknown>)[key] ?? []
  for (const inner of Object.values(value)) {
    const found = findKey(inner, key)
    if (found !== undefined) return found
  }
  return undefined
}
