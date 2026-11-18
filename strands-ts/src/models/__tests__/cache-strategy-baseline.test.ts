/**
 * Pins the prompt-caching wire behavior of `strategy` unset, `'auto'` and `'anthropic'` for every provider that
 * reads `cacheConfig`, so the strategy modes cannot change what those configurations send.
 *
 * `warnings: null` marks a row whose warnings are not pinned; only `placed` is checked there.
 */
import { describe, it, expect, vi } from 'vitest'
import { ARN, label, observe, type BenchCase } from './cache-bench.js'

vi.mock('@aws-sdk/client-bedrock-runtime', async (importOriginal) =>
  (await import('./cache-bench-mocks.js')).mockBedrockRuntime(importOriginal as never)
)
vi.mock('../../logging/warn-once.js', async () => (await import('./cache-bench-mocks.js')).warnOnceWithoutDedupe())

interface Row extends BenchCase {
  placed: boolean
  warnings: string[] | null
  cacheKey?: string
}

const CLAUDE_BEDROCK = 'global.anthropic.claude-sonnet-4-6'
const NOT_AUTO = 'does not support automatic caching'
const INFO_UNSUPPORTED = { capabilities: { promptCaching: 'unsupported' as const } }
const INFO_SAYS_NO = 'model info says this model does not support prompt caching'
const MANTLE_CACHE_POINTS = 'cache points are supported through the openai model provider'

const ROWS: Row[] = [
  // BedrockModel
  { provider: 'bedrock', modelId: CLAUDE_BEDROCK, placed: false, warnings: [] },
  { provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: {}, placed: true, warnings: [] },
  { provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: { strategy: 'auto' }, placed: true, warnings: [] },
  { provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: { strategy: 'anthropic' }, placed: true, warnings: [] },
  { provider: 'bedrock', modelId: 'us.anthropic.claude-unlisted-9', cacheConfig: {}, placed: true, warnings: [] },
  { provider: 'bedrock', modelId: ARN, cacheConfig: {}, placed: false, warnings: [NOT_AUTO] },
  { provider: 'bedrock', modelId: ARN, cacheConfig: { strategy: 'anthropic' }, placed: true, warnings: [] },
  { provider: 'bedrock', modelId: 'amazon.nova-pro-v1:0', cacheConfig: {}, placed: true, warnings: [] },
  {
    provider: 'bedrock',
    modelId: 'meta.llama4-maverick-17b-instruct-v1:0',
    cacheConfig: {},
    placed: false,
    warnings: [NOT_AUTO],
  },
  {
    provider: 'bedrock',
    modelId: CLAUDE_BEDROCK,
    cacheConfig: {},
    modelInfo: INFO_UNSUPPORTED,
    placed: false,
    warnings: [NOT_AUTO],
  },
  // Converse caches OpenAI GPT models implicitly but not gpt-oss, so gpt-oss warns, and a GPT model that takes cache
  // points on Mantle warns that they are available there.
  { provider: 'bedrock', modelId: 'openai.gpt-oss-120b', cacheConfig: {}, placed: false, warnings: [NOT_AUTO] },
  { provider: 'bedrock', modelId: 'openai.gpt-5.6-cyber', cacheConfig: {}, placed: false, warnings: [] },
  {
    provider: 'bedrock',
    modelId: 'us.openai.gpt-6-luna',
    cacheConfig: {},
    placed: false,
    warnings: [MANTLE_CACHE_POINTS],
  },

  // AnthropicModel
  { provider: 'anthropic', modelId: 'claude-sonnet-4-6', placed: false, warnings: [] },
  { provider: 'anthropic', modelId: 'claude-sonnet-4-6', cacheConfig: {}, placed: true, warnings: [] },
  {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    cacheConfig: { strategy: 'anthropic' },
    placed: true,
    warnings: [],
  },
  { provider: 'anthropic', modelId: 'claude-unlisted-9', cacheConfig: {}, placed: true, warnings: [] },
  {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    cacheConfig: {},
    modelInfo: INFO_UNSUPPORTED,
    placed: false,
    warnings: [INFO_SAYS_NO],
  },
  {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    cacheConfig: { strategy: 'anthropic' },
    modelInfo: INFO_UNSUPPORTED,
    placed: true,
    warnings: [],
  },

  // OpenAIModel, Responses API
  { provider: 'openaiResponses', modelId: 'gpt-6-sol', placed: false, warnings: [] },
  { provider: 'openaiResponses', modelId: 'gpt-6-sol', cacheConfig: {}, placed: true, warnings: [] },
  {
    provider: 'openaiResponses',
    modelId: 'gpt-6-sol',
    cacheConfig: { strategy: 'anthropic' },
    placed: true,
    warnings: [],
  },
  { provider: 'openaiResponses', modelId: 'gpt-5.4', cacheConfig: {}, placed: false, warnings: [] },
  // `'anthropic'` on a Responses model without cache points is a strategy it cannot apply, so it falls back to `'auto'`.
  {
    provider: 'openaiResponses',
    modelId: 'gpt-5.4',
    cacheConfig: { strategy: 'anthropic' },
    placed: false,
    warnings: null,
  },
  {
    provider: 'openaiResponses',
    modelId: 'gpt-5.4',
    cacheConfig: { cacheKey: 'k' },
    placed: false,
    warnings: [],
    cacheKey: 'k',
  },

  // OpenAIModel, Chat Completions
  { provider: 'openaiChat', modelId: 'gpt-6-sol', cacheConfig: {}, placed: false, warnings: [] },
  {
    provider: 'openaiChat',
    modelId: 'gpt-5.4',
    cacheConfig: { cacheKey: 'k' },
    placed: false,
    warnings: [],
    cacheKey: 'k',
  },

  // VercelModel, routed by the wrapped provider
  { provider: 'vercel:anthropic.messages', modelId: 'claude-sonnet-4-6', cacheConfig: {}, placed: true, warnings: [] },
  {
    provider: 'vercel:anthropic.messages',
    modelId: 'claude-sonnet-4-6',
    cacheConfig: {},
    modelInfo: INFO_UNSUPPORTED,
    placed: false,
    warnings: [INFO_SAYS_NO],
  },
  { provider: 'vercel:amazon-bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: {}, placed: true, warnings: [] },
  {
    provider: 'vercel:amazon-bedrock',
    modelId: ARN,
    cacheConfig: { strategy: 'anthropic' },
    placed: true,
    warnings: [],
  },
  {
    provider: 'vercel:amazon-bedrock',
    modelId: 'openai.gpt-oss-120b',
    cacheConfig: {},
    placed: false,
    warnings: ['not known to support automatic caching'],
  },
  {
    provider: 'vercel:amazon-bedrock',
    modelId: 'us.openai.gpt-6-luna',
    cacheConfig: {},
    placed: false,
    warnings: [MANTLE_CACHE_POINTS],
  },
  { provider: 'vercel:openai.responses', modelId: 'gpt-5.4', cacheConfig: {}, placed: false, warnings: [] },
  {
    provider: 'vercel:mistral.chat',
    modelId: 'mistral-large',
    cacheConfig: {},
    placed: false,
    warnings: ['cacheConfig is not supported for this vercel provider'],
  },
]

describe('prompt caching baseline for unset, auto and anthropic strategies', () => {
  it.each(ROWS.map((row) => [label(row), row] as const))('%s', async (_label, row) => {
    const seen = await observe(row)

    expect(seen.placed).toBe(row.placed)
    if (row.cacheKey !== undefined) expect(seen.cacheKey).toBe(row.cacheKey)
    if (row.warnings === null) return
    expect(seen.warnings).toHaveLength(row.warnings.length)
    row.warnings.forEach((fragment, index) => expect(seen.warnings[index]).toContain(fragment))
  })
})
