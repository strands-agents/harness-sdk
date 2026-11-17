/**
 * Shared harness for the cache strategy suites: builds a model for a provider, streams one request through a fake
 * client, and reports what landed on the wire.
 *
 * Test files that import this must apply the mocks in `cache-bench-mocks.ts`, since `vi.mock` only hoists inside
 * the test file.
 */
import { vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamResult } from '@ai-sdk/provider'
import { ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime'
import { BedrockModel } from '../bedrock.js'
import { AnthropicModel } from '../anthropic.js'
import { OpenAIModel } from '../openai/model.js'
import { VercelModel } from '../vercel.js'
import type { CacheConfig, Model, StreamOptions } from '../model.js'
import type { ModelInfo } from '../model-info.js'
import { Message, TextBlock } from '../../types/messages.js'
import { logger } from '../../logging/logger.js'

export type BenchProvider =
  | 'bedrock'
  | 'anthropic'
  | 'openaiResponses'
  | 'openaiChat'
  | 'vercel:anthropic.messages'
  | 'vercel:amazon-bedrock'
  | 'vercel:openai.responses'
  | 'vercel:mistral.chat'

export interface BenchCase {
  provider: BenchProvider
  modelId: string
  cacheConfig?: CacheConfig | false | undefined
  modelInfo?: ModelInfo | undefined
}

export interface WireObservation {
  /** Whether the SDK put any cache point / breakpoint / cache_control on the request. */
  placed: boolean
  /** The prompt-cache routing key sent, OpenAI only. */
  cacheKey: string | undefined
  /** Distinct caching-related `logger.warn` messages emitted while building and streaming. */
  warnings: string[]
}

export const ARN = 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123'

const toolSpecs = [{ name: 'calculator', description: 'Calculate', inputSchema: { type: 'object' as const } }]
const messages = [new Message({ role: 'user', content: [new TextBlock('durable prefix')] })]
const streamOptions = { toolSpecs, systemPrompt: 'You are terse.' } as StreamOptions

/** Recursively reports whether `value` contains any key in `keys`. */
function containsKey(value: unknown, keys: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, keys))
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => keys.has(key) || containsKey(child, keys))
}

const BEDROCK_MARKERS = new Set(['cachePoint'])
const ANTHROPIC_MARKERS = new Set(['cache_control'])
const OPENAI_MARKERS = new Set(['prompt_cache_breakpoint'])
const VERCEL_MARKERS = new Set(['cacheControl', 'cachePoint'])

function fakeVercelProvider(provider: string, modelId: string, sink: { request: unknown }): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(async (callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> => {
      sink.request = callOptions
      return { stream: new ReadableStream({ start: (controller) => controller.close() }) }
    }),
  } as unknown as LanguageModelV3
}

function emptyStream(sink: { request: unknown }) {
  return vi.fn(async (request: unknown) => {
    sink.request = request
    return (async function* () {})()
  })
}

/** Builds the model for `bench`, wired to a fake client that records the outgoing request in `sink`. */
export function buildModel(bench: BenchCase, sink: { request: unknown } = { request: null }): Model {
  const shared = {
    modelId: bench.modelId,
    ...(bench.cacheConfig !== undefined && { cacheConfig: bench.cacheConfig }),
    ...(bench.modelInfo && { modelInfo: bench.modelInfo }),
  }
  switch (bench.provider) {
    case 'bedrock':
      return new BedrockModel(shared)
    case 'anthropic': {
      const client = { messages: { stream: emptyStream(sink) } } as unknown as Anthropic
      return new AnthropicModel({ ...shared, client })
    }
    case 'openaiResponses':
    case 'openaiChat': {
      const create = emptyStream(sink)
      const client = { responses: { create }, chat: { completions: { create } } } as unknown as OpenAI
      const api = bench.provider === 'openaiChat' ? 'chat' : 'responses'
      return new OpenAIModel({ ...shared, api, client })
    }
    default: {
      const providerName = bench.provider.slice('vercel:'.length)
      const { modelId: _modelId, ...rest } = shared
      return new VercelModel({ ...rest, provider: fakeVercelProvider(providerName, bench.modelId, sink) })
    }
  }
}

function markersFor(provider: BenchProvider): ReadonlySet<string> {
  if (provider === 'bedrock') return BEDROCK_MARKERS
  if (provider === 'anthropic') return ANTHROPIC_MARKERS
  if (provider === 'openaiResponses' || provider === 'openaiChat') return OPENAI_MARKERS
  return VERCEL_MARKERS
}

/** Streams one request for `bench` and reports what reached the wire. */
export async function observe(bench: BenchCase): Promise<WireObservation> {
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  try {
    const sink: { request: unknown } = { request: null }
    const model = buildModel(bench, sink)
    try {
      for await (const _event of model.stream(messages, streamOptions)) {
        // drain
      }
    } catch {
      // Empty fake streams may fail to finalize; only the request matters here.
    }
    const request = bench.provider === 'bedrock' ? vi.mocked(ConverseStreamCommand).mock.lastCall?.[0] : sink.request
    const cacheKey = (request as { prompt_cache_key?: string } | null)?.prompt_cache_key
    return {
      placed: containsKey(request, markersFor(bench.provider)),
      cacheKey,
      warnings: [...new Set(warnSpy.mock.calls.map(([msg]) => String(msg)))].filter((msg) =>
        /cach|strategy/i.test(msg)
      ),
    }
  } finally {
    warnSpy.mockRestore()
  }
}

/** Label for `it.each`. */
export function label(bench: BenchCase): string {
  const info = bench.modelInfo ? ` info=${JSON.stringify(bench.modelInfo.capabilities)}` : ''
  return `${bench.provider} × ${bench.modelId} cacheConfig=${JSON.stringify(bench.cacheConfig)}${info}`
}
