/**
 * The cache strategy every provider resolves to, and what each mode sends.
 * `cache-strategy-baseline.test.ts` pins the wire behavior of `'auto'`, `'anthropic'` and an unset strategy.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { GoogleGenAI } from '@google/genai'
import { ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime'
import { ARN, buildModel, label, observe, type BenchCase } from './cache-bench.js'
import { Model, type BaseModelConfig, type StreamOptions } from '../model.js'
import type { ResolvedCacheStrategy } from '../cache-strategy.js'
import type { ModelInfo } from '../model-info.js'
import type { ModelStreamEvent } from '../streaming.js'
import { GoogleModel } from '../google/model.js'
import { CachePointBlock, Message, TextBlock } from '../../types/messages.js'
import { logger } from '../../logging/logger.js'

vi.mock('@aws-sdk/client-bedrock-runtime', async (importOriginal) =>
  (await import('./cache-bench-mocks.js')).mockBedrockRuntime(importOriginal)
)
vi.mock('../../logging/warn-once.js', async () => (await import('./cache-bench-mocks.js')).warnOnceWithoutDedupe())

/** Reads the internal resolution a provider gates cache placement on. */
const strategyOf = (model: Model): ResolvedCacheStrategy =>
  (model as unknown as { _cacheStrategy(): { strategy: ResolvedCacheStrategy } })._cacheStrategy().strategy

const CLAUDE_BEDROCK = 'global.anthropic.claude-sonnet-4-6'
const NOT_AUTO = 'does not support automatic caching'
const FELL_BACK = 'falling back to auto'
const IGNORED = 'cacheConfig is not applied by this model provider'

interface ResolutionRow extends BenchCase {
  expected: ResolvedCacheStrategy
}

const RESOLUTION: ResolutionRow[] = [
  // BedrockModel: sdk | implicit | manual
  { provider: 'bedrock', modelId: CLAUDE_BEDROCK, expected: 'manual' },
  { provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: false, expected: 'manual' },
  { provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: {}, expected: 'sdk' },
  { provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: { strategy: 'anthropic' }, expected: 'sdk' },
  { provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: { strategy: 'sdk' }, expected: 'sdk' },
  { provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: { strategy: 'manual' }, expected: 'manual' },
  { provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: { strategy: 'implicit' }, expected: 'sdk' },
  { provider: 'bedrock', modelId: 'us.anthropic.claude-unlisted-9', cacheConfig: {}, expected: 'sdk' },
  { provider: 'bedrock', modelId: ARN, cacheConfig: {}, expected: 'manual' },
  { provider: 'bedrock', modelId: ARN, cacheConfig: { strategy: 'sdk' }, expected: 'sdk' },
  { provider: 'bedrock', modelId: 'amazon.nova-pro-v1:0', cacheConfig: {}, expected: 'sdk' },
  { provider: 'bedrock', modelId: 'openai.gpt-oss-120b', expected: 'manual' },
  { provider: 'bedrock', modelId: 'openai.gpt-oss-120b', cacheConfig: {}, expected: 'manual' },
  { provider: 'bedrock', modelId: 'openai.gpt-5.6-cyber', cacheConfig: {}, expected: 'implicit' },
  { provider: 'bedrock', modelId: 'us.openai.gpt-6-luna', expected: 'implicit' },
  { provider: 'bedrock', modelId: 'us.openai.gpt-6-luna', cacheConfig: {}, expected: 'implicit' },
  { provider: 'bedrock', modelId: 'us.openai.gpt-6-luna', cacheConfig: { strategy: 'implicit' }, expected: 'implicit' },
  { provider: 'bedrock', modelId: 'openai.o3', cacheConfig: {}, expected: 'implicit' },

  // AnthropicModel: sdk | manual
  { provider: 'anthropic', modelId: 'claude-sonnet-4-6', expected: 'manual' },
  { provider: 'anthropic', modelId: 'claude-sonnet-4-6', cacheConfig: false, expected: 'manual' },
  { provider: 'anthropic', modelId: 'claude-sonnet-4-6', cacheConfig: {}, expected: 'sdk' },
  { provider: 'anthropic', modelId: 'claude-sonnet-4-6', cacheConfig: { strategy: 'sdk' }, expected: 'sdk' },
  { provider: 'anthropic', modelId: 'claude-sonnet-4-6', cacheConfig: { strategy: 'manual' }, expected: 'manual' },
  { provider: 'anthropic', modelId: 'claude-sonnet-4-6', cacheConfig: { strategy: 'implicit' }, expected: 'sdk' },
  {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    cacheConfig: {},
    modelInfo: { capabilities: { promptCaching: 'unsupported' } },
    expected: 'manual',
  },

  // OpenAIModel, Responses: sdk | implicit | manual
  { provider: 'openaiResponses', modelId: 'gpt-6-sol', expected: 'implicit' },
  { provider: 'openaiResponses', modelId: 'gpt-6-sol', cacheConfig: false, expected: 'implicit' },
  { provider: 'openaiResponses', modelId: 'gpt-6-sol', cacheConfig: {}, expected: 'sdk' },
  { provider: 'openaiResponses', modelId: 'gpt-6-sol', cacheConfig: { strategy: 'implicit' }, expected: 'implicit' },
  { provider: 'openaiResponses', modelId: 'gpt-6-sol', cacheConfig: { strategy: 'manual' }, expected: 'manual' },
  { provider: 'openaiResponses', modelId: 'gpt-5.4', cacheConfig: {}, expected: 'implicit' },
  { provider: 'openaiResponses', modelId: 'gpt-5.4', cacheConfig: { strategy: 'sdk' }, expected: 'implicit' },

  // OpenAIModel, Chat Completions: implicit | manual
  { provider: 'openaiChat', modelId: 'gpt-6-sol', cacheConfig: {}, expected: 'implicit' },
  { provider: 'openaiChat', modelId: 'gpt-5.4', expected: 'implicit' },
  { provider: 'openaiChat', modelId: 'gpt-5.4', cacheConfig: { strategy: 'manual' }, expected: 'manual' },
  { provider: 'openaiChat', modelId: 'gpt-5.4', cacheConfig: { strategy: 'sdk' }, expected: 'implicit' },

  // VercelModel: follows the wrapped provider; the ai-sdk OpenAI adapters take no checkpoints
  { provider: 'vercel:anthropic.messages', modelId: 'claude-sonnet-4-6', cacheConfig: {}, expected: 'sdk' },
  { provider: 'vercel:anthropic.messages', modelId: 'claude-sonnet-4-6', expected: 'manual' },
  { provider: 'vercel:amazon-bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: {}, expected: 'sdk' },
  { provider: 'vercel:amazon-bedrock', modelId: ARN, cacheConfig: { strategy: 'sdk' }, expected: 'sdk' },
  { provider: 'vercel:amazon-bedrock', modelId: 'openai.gpt-oss-120b', cacheConfig: {}, expected: 'manual' },
  { provider: 'vercel:amazon-bedrock', modelId: 'us.openai.gpt-6-luna', cacheConfig: {}, expected: 'implicit' },
  { provider: 'vercel:openai.responses', modelId: 'gpt-5.4', cacheConfig: {}, expected: 'implicit' },
  { provider: 'vercel:openai.responses', modelId: 'gpt-6-sol', cacheConfig: {}, expected: 'implicit' },
  { provider: 'vercel:mistral.chat', modelId: 'mistral-large', cacheConfig: {}, expected: 'manual' },
]

class StubModel extends Model<BaseModelConfig> {
  constructor(
    private readonly _info: ModelInfo,
    private readonly _stubConfig: BaseModelConfig = {}
  ) {
    super()
  }
  override get modelInfo(): ModelInfo {
    return this._info
  }
  updateConfig(): void {}
  getConfig(): BaseModelConfig {
    return { modelId: 'stub', ...this._stubConfig }
  }
  async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
  }
}

type WarnSpy = MockInstance<typeof logger.warn>

/** Sends one request by reading the first event; a fake client's empty stream may fail after it, which is ignored. */
async function sendRequest(model: Model, messages: Message[], options: StreamOptions): Promise<void> {
  const events = model.stream(messages, options)[Symbol.asyncIterator]()
  await events.next().catch(() => undefined)
}

function cacheWarnings(warnSpy: WarnSpy): string[] {
  return warnSpy.mock.calls.map(([message]) => String(message)).filter((message) => /cach|strategy/i.test(message))
}

describe('resolved cache strategy', () => {
  it.each(RESOLUTION.map((row) => [label(row), row] as const))('%s', (_label, row) => {
    expect(strategyOf(buildModel(row))).toBe(row.expected)
  })

  it('reflects updateConfig', () => {
    const model = buildModel({ provider: 'bedrock', modelId: CLAUDE_BEDROCK })
    expect(strategyOf(model)).toBe('manual')
    model.updateConfig({ cacheConfig: {} })
    expect(strategyOf(model)).toBe('sdk')
    model.updateConfig({ cacheConfig: { strategy: 'manual' } })
    expect(strategyOf(model)).toBe('manual')
    model.updateConfig({ cacheConfig: false })
    expect(strategyOf(model)).toBe('manual')
  })

  describe('a provider that does not apply cacheConfig', () => {
    it.each([
      ['auto', 'implicit'],
      ['cachePoints', 'manual'],
      ['unsupported', 'manual'],
      [undefined, 'manual'],
    ] as const)('promptCaching=%s → %s', (promptCaching, expected) => {
      const info: ModelInfo = promptCaching ? { capabilities: { promptCaching } } : {}
      expect(strategyOf(new StubModel(info))).toBe(expected)
      expect(strategyOf(new StubModel(info, { cacheConfig: { strategy: 'sdk' } }))).toBe(expected)
    })

    it('resolves Google to implicit', () => {
      const model = new GoogleModel({ client: {} as GoogleGenAI, modelId: 'gemini-2.5-flash', cacheConfig: {} })
      expect(strategyOf(model)).toBe('implicit')
    })

    it('resolves Google to manual under a modelInfo override that says the model does not cache', () => {
      const model = new GoogleModel({
        client: {} as GoogleGenAI,
        modelId: 'gemini-2.5-flash',
        modelInfo: { capabilities: { promptCaching: 'unsupported' } },
      })
      expect(strategyOf(model)).toBe('manual')
    })
  })
})

describe('wire behavior of the modes', () => {
  it.each([
    { provider: 'bedrock', modelId: ARN, cacheConfig: { strategy: 'sdk' } },
    { provider: 'anthropic', modelId: 'claude-sonnet-4-6', cacheConfig: { strategy: 'sdk' } },
    { provider: 'openaiResponses', modelId: 'gpt-6-sol', cacheConfig: { strategy: 'sdk' } },
    { provider: 'vercel:anthropic.messages', modelId: 'claude-sonnet-4-6', cacheConfig: { strategy: 'sdk' } },
    { provider: 'vercel:amazon-bedrock', modelId: ARN, cacheConfig: { strategy: 'sdk' } },
  ] satisfies BenchCase[])("'sdk' places cache points like 'anthropic' does: $provider × $modelId", async (row) => {
    const seen = await observe(row)
    expect(seen).toMatchObject({ placed: true, warnings: [] })
  })

  it.each([
    { provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: { strategy: 'manual' } },
    { provider: 'anthropic', modelId: 'claude-sonnet-4-6', cacheConfig: { strategy: 'manual' } },
    { provider: 'openaiResponses', modelId: 'gpt-6-sol', cacheConfig: { strategy: 'manual' } },
    { provider: 'openaiResponses', modelId: 'gpt-6-sol', cacheConfig: { strategy: 'implicit' } },
    { provider: 'vercel:anthropic.messages', modelId: 'claude-sonnet-4-6', cacheConfig: { strategy: 'manual' } },
    { provider: 'vercel:amazon-bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: { strategy: 'manual' } },
    { provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: false },
    { provider: 'anthropic', modelId: 'claude-sonnet-4-6', cacheConfig: false },
    { provider: 'openaiResponses', modelId: 'gpt-6-sol', cacheConfig: false },
    { provider: 'openaiChat', modelId: 'gpt-5.4', cacheConfig: false },
  ] satisfies BenchCase[])('cacheConfig=$cacheConfig places nothing: $provider × $modelId', async (row) => {
    const seen = await observe(row)
    expect(seen).toStrictEqual({ placed: false, cacheKey: undefined, warnings: [] })
  })

  it.each([
    { provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: { strategy: 'anthropic' } },
    { provider: 'anthropic', modelId: 'claude-sonnet-4-6', cacheConfig: { strategy: 'anthropic' } },
  ] satisfies BenchCase[])("'anthropic' places cache points without a deprecation warning: $provider", async (row) => {
    const seen = await observe(row)
    expect(seen).toMatchObject({ placed: true, warnings: [] })
  })

  it("'manual' sends a configured cacheKey and no checkpoints on OpenAI Responses", async () => {
    const seen = await observe({
      provider: 'openaiResponses',
      modelId: 'gpt-6-sol',
      cacheConfig: { strategy: 'manual', cacheKey: 'k' },
    })
    expect(seen).toStrictEqual({ placed: false, cacheKey: 'k', warnings: [] })
  })

  it("'manual' sends the session-derived cacheKey on OpenAI Responses", async () => {
    const sink: { request: unknown } = { request: null }
    const model = buildModel(
      { provider: 'openaiResponses', modelId: 'gpt-6-sol', cacheConfig: { strategy: 'manual' } },
      sink
    )
    const messages = [new Message({ role: 'user', content: [new TextBlock('durable prefix')] })]
    await sendRequest(model, messages, { agentMetadata: { sessionId: 's1' } })
    expect(sink.request).toMatchObject({ prompt_cache_key: 'strands-s1' })
    expect(JSON.stringify(sink.request)).not.toContain('prompt_cache_breakpoint')
  })

  it('Bedrock openai.gpt-oss-120b resolves to manual with the existing unsupported warning', async () => {
    const seen = await observe({ provider: 'bedrock', modelId: 'openai.gpt-oss-120b', cacheConfig: {} })
    expect(seen.placed).toBe(false)
    expect(seen.warnings).toHaveLength(1)
    expect(seen.warnings[0]).toContain(NOT_AUTO)
  })

  it.each(['openai.gpt-5.6-cyber', 'openai.o3'])('Bedrock %s resolves to implicit with no warning', async (modelId) => {
    const seen = await observe({ provider: 'bedrock', modelId, cacheConfig: {} })
    expect(seen).toStrictEqual({ placed: false, cacheKey: undefined, warnings: [] })
  })

  it.each([
    { provider: 'anthropic', modelId: 'claude-sonnet-4-6', cacheConfig: { strategy: 'implicit' }, placed: true },
    { provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: { strategy: 'implicit' }, placed: true },
    { provider: 'openaiChat', modelId: 'gpt-5.4', cacheConfig: { strategy: 'sdk' }, placed: false },
    {
      provider: 'vercel:anthropic.messages',
      modelId: 'claude-sonnet-4-6',
      cacheConfig: { strategy: 'implicit' },
      placed: true,
    },
  ] satisfies (BenchCase & { placed: boolean })[])(
    'an unsupported $cacheConfig.strategy warns once and falls back to auto: $provider × $modelId',
    async ({ placed, ...row }) => {
      const seen = await observe(row)
      expect(seen.placed).toBe(placed)
      expect(seen.warnings).toHaveLength(1)
      expect(seen.warnings[0]).toContain(`strategy=<${row.cacheConfig.strategy}>`)
      expect(seen.warnings[0]).toContain(FELL_BACK)
    }
  )

  describe("'manual' sends caller-placed cache points as written", () => {
    const messages = [
      new Message({
        role: 'user',
        content: [new TextBlock('earlier'), new CachePointBlock({ cacheType: 'default', ttl: '1h' })],
      }),
      new Message({ role: 'assistant', content: [new TextBlock('ok')] }),
      new Message({ role: 'user', content: [new TextBlock('latest')] }),
    ]
    const systemPrompt = [new TextBlock('You are terse.'), new CachePointBlock({ cacheType: 'default' })]
    const cacheConfig = { strategy: 'manual', ttl: '5m' } as const

    it('on Bedrock', async () => {
      const send = async (bench: BenchCase): Promise<unknown> => {
        await sendRequest(buildModel(bench), messages, { systemPrompt })
        return vi.mocked(ConverseStreamCommand).mock.lastCall?.[0]
      }
      const manual = await send({ provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig })
      expect(manual).toMatchObject({
        system: [{ text: 'You are terse.' }, { cachePoint: { type: 'default' } }],
        messages: [
          { role: 'user', content: [{ text: 'earlier' }, { cachePoint: { type: 'default', ttl: '1h' } }] },
          { role: 'assistant', content: [{ text: 'ok' }] },
          { role: 'user', content: [{ text: 'latest' }] },
        ],
      })
      expect(manual).toStrictEqual(await send({ provider: 'bedrock', modelId: CLAUDE_BEDROCK }))
    })

    it('on Anthropic', async () => {
      const send = async (bench: BenchCase): Promise<unknown> => {
        const sink: { request: unknown } = { request: null }
        await sendRequest(buildModel(bench, sink), messages, { systemPrompt })
        return sink.request
      }
      const manual = await send({ provider: 'anthropic', modelId: 'claude-sonnet-4-6', cacheConfig })
      expect(manual).toMatchObject({
        system: [{ type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'earlier', cache_control: { type: 'ephemeral', ttl: '1h' } }],
          },
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          { role: 'user', content: [{ type: 'text', text: 'latest' }] },
        ],
      })
      expect(manual).toStrictEqual(await send({ provider: 'anthropic', modelId: 'claude-sonnet-4-6' }))
    })
  })
})

describe('cacheConfig on a provider that does not apply it', () => {
  let warnSpy: WarnSpy

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('warns that Google ignores it', () => {
    const model = new GoogleModel({
      client: {} as GoogleGenAI,
      modelId: 'gemini-2.5-flash',
      cacheConfig: { strategy: 'auto' },
    })
    expect(strategyOf(model)).toBe('implicit')
    expect(cacheWarnings(warnSpy)).toStrictEqual([
      'provider=<GoogleModel>, model_id=<gemini-2.5-flash> | cacheConfig is not applied by this model provider, ignoring',
    ])
  })

  it('warns that a custom provider ignores it when the agent streams', async () => {
    const model = new StubModel({}, { cacheConfig: {} })
    for await (const _event of model.streamAggregated([
      new Message({ role: 'user', content: [new TextBlock('hi')] }),
    ])) {
      // drain
    }
    expect(cacheWarnings(warnSpy)).toHaveLength(1)
    expect(cacheWarnings(warnSpy)[0]).toContain(IGNORED)
  })

  it('logs nothing for Google with cacheConfig false', () => {
    const model = new GoogleModel({ client: {} as GoogleGenAI, modelId: 'gemini-2.5-flash', cacheConfig: false })
    expect(strategyOf(model)).toBe('implicit')
    expect(cacheWarnings(warnSpy)).toStrictEqual([])
  })

  it.each([
    ['false', { cacheConfig: false }],
    ['unset', {}],
  ] as const)('logs nothing for a custom provider with cacheConfig %s', async (_name, config) => {
    const model = new StubModel({}, config)
    expect(strategyOf(model)).toBe('manual')
    for await (const _event of model.streamAggregated([
      new Message({ role: 'user', content: [new TextBlock('hi')] }),
    ])) {
      // drain
    }
    expect(cacheWarnings(warnSpy)).toStrictEqual([])
  })

  it('does not warn for a provider that applies it', () => {
    expect(strategyOf(buildModel({ provider: 'bedrock', modelId: CLAUDE_BEDROCK, cacheConfig: {} }))).toBe('sdk')
    expect(cacheWarnings(warnSpy)).toStrictEqual([])
  })
})
