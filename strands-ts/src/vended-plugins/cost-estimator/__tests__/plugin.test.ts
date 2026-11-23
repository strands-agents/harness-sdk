import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calcPrice, TieredPrices, type PriceCalculation } from '@pydantic/genai-prices'
import { CostEstimateEvent, GenAIPricesEstimator } from '../index.js'
import type { CostEstimate, ModelCostEstimate, ModelPrice } from '../index.js'
import { Agent } from '../../../agent/agent.js'
import { InvocationContextImpl } from '../../../agent/invocation-context.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { collectGenerator } from '../../../__fixtures__/model-test-helpers.js'
import { logger } from '../../../logging/logger.js'
import { InvokeModelStage, type InvokeModelResult } from '../../../middleware/index.js'
import { BedrockModel } from '../../../models/bedrock.js'
import { MultiAgentResult } from '../../../multiagent/state.js'
import { tool } from '../../../tools/tool-factory.js'
import type { ModelUsage } from '../../../agent/invocation-context.js'
import type { StreamOptions } from '../../../models/model.js'
import type { ModelStreamEvent, Usage } from '../../../models/streaming.js'
import type { Plugin } from '../../../plugins/plugin.js'
import type { ToolContext } from '../../../tools/tool.js'
import type { AgentStreamEvent } from '../../../types/agent.js'
import type { Message } from '../../../types/messages.js'

vi.mock('@pydantic/genai-prices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pydantic/genai-prices')>()
  return { ...actual, calcPrice: vi.fn(actual.calcPrice) }
})

const MAIN_PRICE: ModelPrice = {
  modelId: 'main',
  inputPerMillion: 3.0,
  outputPerMillion: 15.0,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75,
}
const SMALL_PRICE: ModelPrice = { modelId: 'small', inputPerMillion: 1.0, outputPerMillion: 5.0 }

const MAIN_FIRST_CALL_COST = (2_000 * 3.0 + 18_000 * 3.75 + 300 * 15.0) / 1_000_000
const MAIN_SECOND_CALL_COST = (2_500 * 3.0 + 18_000 * 0.3 + 900 * 15.0) / 1_000_000
const MAIN_COST = (4_500 * 3.0 + 18_000 * 0.3 + 18_000 * 3.75 + 1_200 * 15.0) / 1_000_000
const SMALL_COST = (40_000 * 1.0 + 1_500 * 5.0) / 1_000_000

function usage(
  inputTokens: number,
  outputTokens: number,
  cache: { read?: number; write?: number; inInput?: boolean } = {}
): Usage {
  const cached = (cache.read ?? 0) + (cache.write ?? 0)
  return {
    inputTokens: inputTokens + (cache.inInput ? cached : 0),
    outputTokens,
    totalTokens: inputTokens + outputTokens + cached,
    ...(cache.read && { cacheReadInputTokens: cache.read }),
    ...(cache.write && { cacheWriteInputTokens: cache.write }),
  }
}

function price(modelId: string, inputPerMillion: number, providerName?: string): ModelPrice {
  return { modelId, inputPerMillion, outputPerMillion: 1.0, ...(providerName !== undefined && { providerName }) }
}

/** The estimate of one model; unpriced when `costUsd` and `modelPrice` are left out. */
function modelEstimate(
  providerName: string | undefined,
  modelId: string | undefined,
  modelUsage: Usage,
  costUsd?: number,
  modelPrice?: ModelPrice
): ModelCostEstimate {
  return {
    ...(providerName !== undefined && { providerName }),
    ...(modelId !== undefined && { modelId }),
    usage: modelUsage,
    ...(costUsd !== undefined && { costUsd }),
    ...(modelPrice !== undefined && { price: modelPrice, priceSource: 'user' }),
  }
}

/** A request with one recorded model call per `[usage, providerName, modelId]`. */
function request(...calls: [Usage, string | undefined, string | undefined][]): InvocationContextImpl {
  const invocationContext = new InvocationContextImpl()
  for (const [callUsage, providerName, modelId] of calls) {
    invocationContext.recordUsage(callUsage, {
      ...(providerName !== undefined && { providerName }),
      ...(modelId !== undefined && { modelId }),
    })
  }
  return invocationContext
}

function namedModel(modelId: string): MockMessageModel {
  const model = new MockMessageModel()
  model.updateConfig({ modelId })
  return model
}

/** A Bedrock model that replays the turns of a mock model. */
class CannedBedrockModel extends BedrockModel {
  constructor(
    modelId: string,
    private readonly _canned: MockMessageModel
  ) {
    super({ modelId, region: 'us-west-2' })
  }

  override stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    return this._canned.stream(messages, options)
  }
}

/** An agent whose first turn calls a tool that runs a sub-agent on `small` in the same request. */
function researchAgent(plugins: Plugin[], mainModel = namedModel('main')): Agent {
  const research = tool({
    name: 'research',
    description: 'Researches with a smaller model.',
    callback: async (_input: unknown, context: ToolContext) => {
      const model = namedModel('small').addTurn({ type: 'textBlock', text: 'notes' }, { usage: usage(40_000, 1_500) })
      const result = await new Agent({ model, printer: false }).invoke('go', {
        invocationContext: context.invocationContext!,
      })
      return result.toString()
    },
  })
  mainModel
    .addTurn(
      { type: 'toolUseBlock', name: 'research', toolUseId: 'tu-1', input: {} },
      { usage: usage(2_000, 300, { write: 18_000 }) }
    )
    .addTurn({ type: 'textBlock', text: 'done' }, { usage: usage(2_500, 900, { read: 18_000 }) })
  return new Agent({ model: mainModel, tools: [research], plugins, printer: false })
}

function costEvents(events: AgentStreamEvent[]): CostEstimateEvent[] {
  return events.filter((event) => event.type === 'costEstimateEvent')
}

/** Replaces the genai-prices lookup with one that lists `priced-model` at tiered rates. */
function listPricedModel(): void {
  vi.mocked(calcPrice).mockImplementation((_usage, modelId, options) => {
    if (!modelId.endsWith('priced-model')) return null
    return {
      model_price: {
        input_mtok: new TieredPrices({ base: 2, tiers: [{ start: 200_000, price: 4 }] }),
        output_mtok: 10,
        // The bundled data holds tiered rates as plain objects.
        cache_read_mtok: { base: 0.2, tiers: [{ start: 200_000, price: 0.4 }] },
      },
      provider: { id: options?.providerId },
      model: { id: 'matched-model' },
    } as unknown as PriceCalculation
  })
}

function lookups(): [string | undefined, string][] {
  return vi.mocked(calcPrice).mock.calls.map(([, modelId, options]) => [options?.providerId, modelId])
}

describe('GenAIPricesEstimator', () => {
  beforeEach(() => {
    vi.mocked(calcPrice).mockReset()
  })

  describe('constructor', () => {
    it.each([
      ['same model id', [price('a', 1.0), price('a', 2.0)]],
      ['same provider and model id', [price('a', 1.0, 'p'), price('a', 2.0, 'p')]],
    ])('rejects two prices for one model: %s', (_name, prices) => {
      expect(() => new GenAIPricesEstimator({ prices })).toThrow('two entries for one model')
    })

    it.each(['', undefined])('rejects a price with an empty model id: %s', (modelId) => {
      const prices = [{ modelId, inputPerMillion: 1.0, outputPerMillion: 1.0 } as ModelPrice]

      expect(() => new GenAIPricesEstimator({ prices })).toThrow('a price needs the id of the model')
    })

    it.each([
      ['negative', { inputPerMillion: -1.0 }],
      ['NaN', { outputPerMillion: NaN }],
      ['infinite', { cacheReadPerMillion: Infinity }],
      ['string', { cacheWritePerMillion: '1' }],
      ['boolean', { inputPerMillion: true }],
      ['missing output', { outputPerMillion: undefined }],
    ])('rejects a price with a rate that is not a finite, non-negative number: %s', (_name, rates) => {
      const prices = [{ modelId: 'main', inputPerMillion: 1.0, outputPerMillion: 1.0, ...rates } as ModelPrice]

      expect(() => new GenAIPricesEstimator({ prices })).toThrow('finite, non-negative number')
    })

    it('keeps the prices it was built with when the config object changes later', () => {
      const smallPrice = { ...SMALL_PRICE }
      const cost = new GenAIPricesEstimator({ prices: [smallPrice] })

      smallPrice.inputPerMillion = -1.0

      const estimate = cost.estimate(request([usage(1_000, 100), undefined, 'small']))
      expect(estimate.totalUsd).toBe((1_000 * 1.0 + 100 * 5.0) / 1_000_000)
      expect(Object.isFrozen(estimate.models[0]!.price)).toBe(true)
    })
  })

  describe('estimate', () => {
    it.each([true, false])('charges cached tokens once when inputTokens includes them: %s', (inInput) => {
      const callUsage = usage(1_000, 100, { read: 6_000, write: 2_000, inInput })

      const estimate = new GenAIPricesEstimator({ prices: [MAIN_PRICE] }).estimate(
        request([callUsage, 'bedrock', 'main'])
      )

      const expectedCost = (1_000 * 3.0 + 6_000 * 0.3 + 2_000 * 3.75 + 100 * 15.0) / 1_000_000
      expect(estimate).toStrictEqual({
        totalUsd: expectedCost,
        models: [modelEstimate('bedrock', 'main', callUsage, expectedCost, MAIN_PRICE)],
        unpriced: [],
      })
    })

    it('charges no uncached input when the cached tokens exceed inputTokens', () => {
      const callUsage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadInputTokens: 500 }

      const estimate = new GenAIPricesEstimator({ prices: [MAIN_PRICE] }).estimate(
        request([callUsage, 'bedrock', 'main'])
      )

      expect(estimate.totalUsd).toBe((500 * 0.3 + 10 * 15.0) / 1_000_000)
    })

    it('charges cached tokens at the input rate when the price has no cache rate', () => {
      const callUsage = usage(1_000, 100, { read: 6_000, write: 2_000 })

      const estimate = new GenAIPricesEstimator({ prices: [SMALL_PRICE] }).estimate(
        request([callUsage, undefined, 'small'])
      )

      expect(estimate.totalUsd).toBe((9_000 * 1.0 + 100 * 5.0) / 1_000_000)
    })

    it('adds the models of a request together', () => {
      const invocationContext = request(
        [usage(1_000, 100), undefined, 'main'],
        [usage(2_000, 200), undefined, 'small'],
        [usage(1_000, 100), undefined, 'main']
      )

      const estimate = new GenAIPricesEstimator({ prices: [MAIN_PRICE, SMALL_PRICE] }).estimate(invocationContext)

      const expectedCosts = [(2_000 * 3.0 + 200 * 15.0) / 1_000_000, (2_000 * 1.0 + 200 * 5.0) / 1_000_000]
      expect(estimate.models.map((model) => model.costUsd)).toStrictEqual(expectedCosts)
      expect(estimate.totalUsd).toBe(expectedCosts[0]! + expectedCosts[1]!)
      expect(estimate.unpriced).toStrictEqual([])
    })

    it.each([
      ['provider entry wins', 'bedrock', 'priced-model', 7.0],
      ['any-provider entry', 'openai', 'priced-model', 5.0],
      ['model without provider', undefined, 'priced-model', 5.0],
      ['id with slash', 'litellm', 'openai/priced-model', 9.0],
      ['arn', 'bedrock', 'arn:aws:bedrock:us-west-2:1:application-inference-profile/abc', 11.0],
    ])(
      'prefers your price and compares the model id as a whole: %s',
      (_name, providerName, modelId, expectedInputRate) => {
        listPricedModel()
        const prices = [
          price('priced-model', 5.0),
          price('priced-model', 7.0, 'bedrock'),
          price('openai/priced-model', 9.0),
          price('arn:aws:bedrock:us-west-2:1:application-inference-profile/abc', 11.0),
        ]

        const estimate = new GenAIPricesEstimator({ prices }).estimate(request([usage(1, 1), providerName, modelId]))

        expect(estimate.models[0]).toMatchObject({
          price: { inputPerMillion: expectedInputRate },
          priceSource: 'user',
        })
        expect(lookups()).toStrictEqual([])
      }
    )

    it('skips your price for another provider', () => {
      listPricedModel()
      const prices = [price('priced-model', 7.0, 'bedrock')]

      const estimate = new GenAIPricesEstimator({ prices }).estimate(request([usage(1, 1), 'openai', 'priced-model']))

      expect(estimate.models[0]!.priceSource).toBe('genai-prices:openai/matched-model')
    })

    it('leaves the total empty when a model has no price', () => {
      listPricedModel()
      const invocationContext = request(
        [usage(1_000, 100), undefined, 'main'],
        [usage(1, 1), 'bedrock', 'unlisted'],
        [usage(1, 1), undefined, 'no-provider'],
        [usage(1, 1), undefined, undefined]
      )

      const estimate = new GenAIPricesEstimator({ prices: [MAIN_PRICE] }).estimate(invocationContext)

      expect(estimate).not.toHaveProperty('totalUsd')
      expect(estimate.unpriced).toStrictEqual([
        modelEstimate('bedrock', 'unlisted', usage(1, 1)),
        modelEstimate(undefined, 'no-provider', usage(1, 1)),
        modelEstimate(undefined, undefined, usage(1, 1)),
      ])
      expect(estimate.models[0]!.costUsd).toBe((1_000 * 3.0 + 100 * 15.0) / 1_000_000)
    })

    it('uses the base rate of a tiered genai price', () => {
      listPricedModel()
      const callUsage = usage(300_000, 1_000, { read: 100_000, write: 50_000 })

      const model = new GenAIPricesEstimator().estimate(request([callUsage, 'openai', 'priced-model'])).models[0]!

      expect(model.price).toStrictEqual({
        modelId: 'priced-model',
        providerName: 'openai',
        inputPerMillion: 2.0,
        outputPerMillion: 10.0,
        cacheReadPerMillion: 0.2,
      })
      expect(model.priceSource).toBe('genai-prices:openai/matched-model')
      expect(model.costUsd).toBeCloseTo((300_000 * 2.0 + 100_000 * 0.2 + 50_000 * 2.0 + 1_000 * 10.0) / 1_000_000)
    })

    it.each([
      ['bedrock', 'priced-model', ['aws', 'priced-model']],
      ['anthropic', 'priced-model', ['anthropic', 'priced-model']],
      ['openai', 'priced-model', ['openai', 'priced-model']],
      ['google', 'priced-model', ['google', 'priced-model']],
      ['mistral', 'priced-model', ['mistral', 'priced-model']],
      ['litellm', 'groq/meta/priced-model', ['groq', 'meta/priced-model']],
    ])('looks a %s model up under the genai-prices provider: %s', (providerName, modelId, lookup) => {
      listPricedModel()

      const model = new GenAIPricesEstimator().estimate(request([usage(1, 1), providerName, modelId])).models[0]!

      expect(lookups()).toStrictEqual([lookup])
      expect(model).toMatchObject({
        providerName,
        modelId,
        priceSource: `genai-prices:${lookup[0]}/matched-model`,
      })
    })

    it.each(['ollama', 'sagemaker', 'constructor', undefined])(
      'does not look up a provider genai-prices does not list: %s',
      (providerName) => {
        listPricedModel()

        const estimate = new GenAIPricesEstimator().estimate(request([usage(1, 1), providerName, 'priced-model']))

        expect(lookups()).toStrictEqual([])
        expect(estimate.totalUsd).toBeUndefined()
      }
    )

    it('leaves a genai price without token rates unpriced', () => {
      vi.mocked(calcPrice).mockReturnValue({ model_price: { input_mtok: 1 } } as unknown as PriceCalculation)

      const estimate = new GenAIPricesEstimator().estimate(request([usage(1, 1), 'openai', 'input-only-model']))

      expect(estimate.unpriced).toStrictEqual(estimate.models)
    })

    it('prices a well-known Bedrock model from the bundled data', () => {
      const invocationContext = request([usage(1_000, 100), 'bedrock', 'us.anthropic.claude-sonnet-4-20250514-v1:0'])

      const estimate = new GenAIPricesEstimator().estimate(invocationContext)

      expect(estimate.totalUsd).toBeGreaterThan(0)
      expect(estimate.models[0]!.priceSource).toMatch(/^genai-prices:aws\//)
    })

    it('reads the base rate of a tiered price in the bundled data', () => {
      const bundled = calcPrice({ input_tokens: 0, output_tokens: 0 }, 'gemini-2.5-pro', { providerId: 'google' })
      const tiered = bundled!.model_price.input_mtok as TieredPrices
      expect(tiered.tiers.length).toBeGreaterThan(0)

      const model = new GenAIPricesEstimator().estimate(request([usage(1_000, 100), 'google', 'gemini-2.5-pro']))
        .models[0]!

      expect(model.price!.inputPerMillion).toBe(tiered.base)
      expect(model.costUsd).toBeGreaterThan(0)
    })

    it('prices a LiteLLM model id without a provider prefix from the bundled data', () => {
      const estimate = new GenAIPricesEstimator().estimate(request([usage(1_000, 100), 'litellm', 'gpt-4o']))

      expect(estimate.models[0]!.priceSource).toBe('genai-prices:openai/gpt-4o')
    })

    it('leaves a LiteLLM model id with an empty provider prefix unpriced', () => {
      const estimate = new GenAIPricesEstimator().estimate(request([usage(1_000, 100), 'litellm', '/gpt-4o']))

      expect(estimate.unpriced).toStrictEqual(estimate.models)
    })

    it('leaves a bundled price with a fee per request unpriced', () => {
      const bundled = calcPrice({ input_tokens: 1_000, output_tokens: 100 }, 'sonar', {
        providerId: 'perplexity',
      })!.model_price
      expect([bundled.input_mtok, bundled.output_mtok, bundled.requests_kcount]).not.toContain(undefined)

      const estimate = new GenAIPricesEstimator().estimate(request([usage(1_000, 100), 'litellm', 'perplexity/sonar']))

      expect(estimate.totalUsd).toBeUndefined()
      expect(estimate.unpriced).toStrictEqual(estimate.models)
    })

    it.each([
      ['bedrock', { providerId: 'aws' }],
      ['litellm', {}],
    ])('leaves a model id the bundled data does not match unpriced: %s', (providerName, options) => {
      expect(calcPrice({ input_tokens: 1, output_tokens: 1 }, 'no-such-model', options)).toBeNull()

      const estimate = new GenAIPricesEstimator().estimate(request([usage(1, 1), providerName, 'no-such-model']))

      expect(estimate.unpriced).toStrictEqual(estimate.models)
    })

    it('accepts an agent result, a multi-agent result, and an invocation context', async () => {
      const cost = new GenAIPricesEstimator({ prices: [MAIN_PRICE] })
      const model = namedModel('main').addTurn({ type: 'textBlock', text: 'done' }, { usage: usage(1_000, 100) })

      const result = await new Agent({ model, printer: false }).invoke('go')

      const invocationContext = result.invocationContext!
      const requests = [
        result,
        new MultiAgentResult({ results: [], duration: 0, invocationContext }),
        invocationContext,
      ]
      expect(requests.map((source) => cost.estimate(source).totalUsd)).toStrictEqual(
        Array(3).fill((1_000 * 3.0 + 100 * 15.0) / 1_000_000)
      )
    })

    it('accepts usage records', () => {
      const cost = new GenAIPricesEstimator({ prices: [MAIN_PRICE, SMALL_PRICE] })
      function* usageByModel(): Generator<ModelUsage> {
        for (const modelId of ['main', 'small']) yield { modelId, usage: usage(1_000, 100) }
      }

      const estimate = cost.estimate(usageByModel())

      const expectedCosts = [(1_000 * 3.0 + 100 * 15.0) / 1_000_000, (1_000 * 1.0 + 100 * 5.0) / 1_000_000]
      expect(estimate.models.map((model) => model.costUsd)).toStrictEqual(expectedCosts)
      expect(estimate.totalUsd).toBe(expectedCosts[0]! + expectedCosts[1]!)
    })

    it('accepts usage records revived from JSON, whose unknown names are absent', () => {
      const invocationContext = request([usage(1_000, 100), undefined, 'main'], [usage(1, 1), 'openai', undefined])
      const saved = JSON.stringify(invocationContext.usageByModel)
      const mainCost = (1_000 * 3.0 + 100 * 15.0) / 1_000_000

      const estimate = new GenAIPricesEstimator({ prices: [MAIN_PRICE] }).estimate(JSON.parse(saved))

      const unpriced = [modelEstimate('openai', undefined, usage(1, 1))]
      expect(estimate).toStrictEqual({
        models: [modelEstimate(undefined, 'main', usage(1_000, 100), mainCost, MAIN_PRICE), ...unpriced],
        unpriced,
      })
    })

    it.each<[string, () => unknown, string]>([
      ['undefined', () => undefined, 'undefined'],
      ['null', () => null, 'null'],
      ['agent', () => new Agent({ model: namedModel('main'), printer: false }), 'Agent'],
      ['object', () => ({}), 'Object'],
      ['usage objects', () => [usage(1, 1)], 'Array'],
      ['usage without token counts', () => [{ modelId: 'a', usage: {} }], 'Array'],
      ['usage with a string count', () => [{ modelId: 'a', usage: { ...usage(1, 1), outputTokens: '1' } }], 'Array'],
      ['usage with a NaN count', () => [{ modelId: 'a', usage: { ...usage(1, 1), totalTokens: NaN } }], 'Array'],
      [
        'usage with a NaN cache count',
        () => [{ modelId: 'a', usage: { ...usage(1, 1), cacheReadInputTokens: NaN } }],
        'Array',
      ],
      ['null provider name', () => [{ providerName: null, modelId: 'a', usage: usage(1, 1) }], 'Array'],
      ['null model id', () => [{ providerName: 'openai', modelId: null, usage: usage(1, 1) }], 'Array'],
      ['string', () => '', 'String'],
      ['map', () => new Map(), 'Map'],
    ])('rejects what is not a request or usage records: %s', (_name, createRequest, typeName) => {
      const source = createRequest() as ModelUsage[]

      expect(() => new GenAIPricesEstimator().estimate(source)).toThrow(
        new TypeError(
          `request=<${typeName}> | expected an agent or multi-agent result, an InvocationContext, ` +
            'or an iterable of ModelUsage'
        )
      )
    })

    it('has no total for a result without an invocation context', () => {
      const result = new MultiAgentResult({ results: [], duration: 0 })

      expect(new GenAIPricesEstimator().estimate(result)).toStrictEqual({ models: [], unpriced: [] })
    })

    it('is zero for a request without model calls', () => {
      const estimate = new GenAIPricesEstimator().estimate(new InvocationContextImpl())

      expect(estimate).toStrictEqual({ totalUsd: 0, models: [], unpriced: [] })
    })
  })

  describe('when attached to an agent', () => {
    it('emits the model call and the request estimate after each model call', async () => {
      const cost = new GenAIPricesEstimator({ prices: [MAIN_PRICE, SMALL_PRICE] })
      const agent = researchAgent([cost])
      const hookEvents: CostEstimateEvent[] = []
      agent.addHook(CostEstimateEvent, (event) => {
        hookEvents.push(event)
      })

      const { items, result } = await collectGenerator(agent.stream('go'))

      const events = costEvents(items)
      expect(events.map((event) => event.modelCall)).toStrictEqual([
        modelEstimate(undefined, 'main', usage(2_000, 300, { write: 18_000 }), MAIN_FIRST_CALL_COST, MAIN_PRICE),
        modelEstimate(undefined, 'main', usage(2_500, 900, { read: 18_000 }), MAIN_SECOND_CALL_COST, MAIN_PRICE),
      ])
      expect(events.map((event) => event.costEstimate.totalUsd)).toStrictEqual([
        expect.closeTo(MAIN_FIRST_CALL_COST),
        expect.closeTo(MAIN_COST + SMALL_COST),
      ])
      expect(events.map((event) => event.costEstimate.models.map((model) => model.modelId))).toStrictEqual([
        ['main'],
        ['main', 'small'],
      ])
      expect(hookEvents).toStrictEqual(events)
      expect(events.at(-1)!.costEstimate).toStrictEqual(cost.estimate(result))
      expect(events.map((event) => [event.agent, event.invocationContext])).toStrictEqual(
        Array(2).fill([agent, result.invocationContext])
      )
    })

    it('names the model an input middleware routed the call to', async () => {
      const routed = namedModel('small').addTurn({ type: 'textBlock', text: 'done' }, { usage: usage(1_000, 100) })
      const agent = new Agent({
        model: namedModel('main'),
        plugins: [new GenAIPricesEstimator({ prices: [MAIN_PRICE, SMALL_PRICE] })],
        printer: false,
      })
      agent.addMiddleware(InvokeModelStage.Input, (context) => ({ ...context, model: routed }))

      const { items } = await collectGenerator(agent.stream('go'))

      expect(costEvents(items).map((event) => event.modelCall.modelId)).toStrictEqual(['small'])
    })

    it('reports a model call without a price as unpriced', async () => {
      const model = namedModel('unlisted').addTurn({ type: 'textBlock', text: 'done' }, { usage: usage(1_000, 100) })
      const agent = new Agent({ model, plugins: [new GenAIPricesEstimator()], printer: false })

      const { items } = await collectGenerator(agent.stream('go'))

      expect(costEvents(items).map((event) => event.modelCall)).toStrictEqual([
        modelEstimate(undefined, 'unlisted', usage(1_000, 100)),
      ])
    })

    it('leaves the total empty when a model without a price reports no usage', async () => {
      const cost = new GenAIPricesEstimator()
      const model = namedModel('unlisted').addTurn({ type: 'textBlock', text: 'done' })
      const agent = new Agent({ model, plugins: [cost], printer: false })

      const { items, result } = await collectGenerator(agent.stream('go'))

      const unpriced = [modelEstimate(undefined, 'unlisted', usage(0, 0))]
      expect(cost.estimate(result)).toStrictEqual({ models: unpriced, unpriced })
      expect(costEvents(items).map((event) => event.costEstimate)).toStrictEqual([{ models: unpriced, unpriced }])
    })

    it('lets an error of the model stage through without emitting an estimate', async () => {
      const agent = new Agent({ model: namedModel('main'), printer: false })
      new GenAIPricesEstimator({ prices: [MAIN_PRICE] }).initAgent(agent)
      agent.addMiddleware(InvokeModelStage, () => {
        throw new Error('stage failed')
      })
      const items: AgentStreamEvent[] = []

      await expect(async () => {
        for await (const event of agent.stream('go')) items.push(event)
      }).rejects.toThrow('stage failed')

      expect(costEvents(items)).toStrictEqual([])
    })

    it('returns the result of the model stage unchanged', async () => {
      const model = namedModel('main').addTurn({ type: 'textBlock', text: 'done' }, { usage: usage(1_000, 100) })
      const agent = new Agent({ model, printer: false })
      const stageResults: InvokeModelResult[] = []
      const recordStageResult = (): void => {
        agent.addMiddleware(InvokeModelStage, async function* (context, next) {
          const stageResult = yield* next(context)
          stageResults.push(stageResult)
          return stageResult
        })
      }
      // The first handler registered is the outermost: one records what the estimator returns, one what it got.
      recordStageResult()
      new GenAIPricesEstimator({ prices: [MAIN_PRICE] }).initAgent(agent)
      recordStageResult()

      await agent.invoke('go')

      expect(stageResults).toHaveLength(2)
      expect(stageResults[1]).toBe(stageResults[0])
    })

    it('prices a vended model class from the bundled data', async () => {
      const canned = new MockMessageModel().addTurn({ type: 'textBlock', text: 'done' }, { usage: usage(1_000, 100) })
      const model = new CannedBedrockModel('us.anthropic.claude-sonnet-4-20250514-v1:0', canned)
      const agent = new Agent({ model, plugins: [new GenAIPricesEstimator()], printer: false })

      const { items } = await collectGenerator(agent.stream('go'))

      const modelCall = costEvents(items)[0]!.modelCall
      expect(modelCall.providerName).toBe('bedrock')
      expect(modelCall.priceSource).toMatch(/^genai-prices:aws\//)
      expect(modelCall.costUsd).toBeGreaterThan(0)
    })

    it('emits the estimate last in the model stage', async () => {
      const agent = researchAgent([])
      const stageEvents: string[] = []
      // The first handler registered is the outermost, so it sees what the estimator adds.
      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        const stage = next(context)
        let step = await stage.next()
        while (!step.done) {
          stageEvents.push(step.value.type)
          yield step.value
          step = await stage.next()
        }
        stageEvents.push('stageResult')
        return step.value
      })
      new GenAIPricesEstimator({ prices: [MAIN_PRICE, SMALL_PRICE] }).initAgent(agent)

      await collectGenerator(agent.stream('go'))

      const preceding = stageEvents.filter((_type, index) => stageEvents[index + 1] === 'stageResult')
      expect(preceding).toStrictEqual(['costEstimateEvent', 'costEstimateEvent'])
      expect(stageEvents.filter((type) => type === 'costEstimateEvent')).toHaveLength(2)
    })

    it('finishes without an estimate when pricing throws', async () => {
      vi.mocked(calcPrice).mockImplementation(() => {
        throw new Error('pricing failed')
      })
      class OpenAINamedModel extends MockMessageModel {
        override get _providerName(): string {
          return 'openai'
        }
      }
      const agent = researchAgent([new GenAIPricesEstimator({ prices: [SMALL_PRICE] })], new OpenAINamedModel())
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      const { items, result } = await collectGenerator(agent.stream('go'))

      expect(result.stopReason).toBe('endTurn')
      expect(costEvents(items)).toStrictEqual([])
      expect(warnSpy.mock.calls).toStrictEqual(
        Array(2).fill(['error=<pricing failed> | cost estimate failed | no estimate emitted for this model call'])
      )
      warnSpy.mockRestore()
    })
  })
})

describe('CostEstimateEvent', () => {
  it('carries the request and the model call estimates, and serializes without the agent', () => {
    const modelCall = modelEstimate(undefined, 'main', usage(1_000, 100), 0.0045, MAIN_PRICE)
    const costEstimate: CostEstimate = { totalUsd: 0.0045, models: [modelCall], unpriced: [] }
    const agent = new Agent({ model: namedModel('main'), printer: false })

    const event = new CostEstimateEvent({ agent, costEstimate, modelCall, invocationState: {} })

    expect(event).toEqual({ type: 'costEstimateEvent', agent, costEstimate, modelCall, invocationState: {} })
    expect(JSON.parse(JSON.stringify(event))).toStrictEqual({ type: 'costEstimateEvent', costEstimate, modelCall })
  })
})
