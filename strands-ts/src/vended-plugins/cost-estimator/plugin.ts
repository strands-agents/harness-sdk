/**
 * Estimate what a request cost in USD from its token usage per model and the list prices in genai-prices.
 *
 * The estimate is tokens times list price. It is not a bill: it knows nothing about regions, service tiers,
 * batch or provisioned pricing, negotiated discounts, or long-context price tiers.
 */

import { calcPrice, type TieredPrices } from '@pydantic/genai-prices'
import { InvocationContextImpl, type InvocationContext, type ModelUsage } from '../../agent/invocation-context.js'
import { normalizeError } from '../../errors.js'
import { logger } from '../../logging/logger.js'
import { InvokeModelStage } from '../../middleware/index.js'
import { modelKey } from '../../models/provider-name.js'
import { createEmptyUsage, type Usage } from '../../models/streaming.js'
import { MultiAgentResult } from '../../multiagent/state.js'
import { AgentResult } from '../../types/agent.js'
import type { InvokeModelContext, InvokeModelResult, MiddlewareNextOf } from '../../middleware/index.js'
import type { Plugin } from '../../plugins/plugin.js'
import type { AgentStreamEvent, LocalAgent } from '../../types/agent.js'
import { CostEstimateEvent, type CostEstimate, type ModelCostEstimate, type ModelPrice } from './types.js'

// Strands provider name -> genai-prices provider id. A provider that is not listed has no prices there.
const PROVIDER_IDS = new Map([
  ['anthropic', 'anthropic'],
  ['bedrock', 'aws'],
  ['google', 'google'],
  ['mistral', 'mistral'],
  ['openai', 'openai'],
])
const RATE_FIELDS = ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion'] as const
const GENAI_RATE_FIELDS = ['input_mtok', 'output_mtok', 'cache_read_mtok', 'cache_write_mtok']

/** A price and where it came from. */
interface FoundPrice {
  price: ModelPrice
  priceSource: string
}

/** Configuration for the {@link GenAIPricesEstimator} plugin. */
export interface GenAIPricesEstimatorConfig {
  /** Your own prices. They win over genai-prices, and one with a `providerName` wins over one without. */
  prices?: readonly ModelPrice[]
}

/**
 * Estimates the USD cost of a request from its token usage and the list prices bundled in genai-prices.
 *
 * Attached to an agent, it adds a {@link CostEstimateEvent} to the agent's stream after every model call. The
 * event carries the estimate for that call and the running estimate for the whole request so far, including
 * nested and auxiliary model calls. {@link estimate} computes the request's estimate and needs no agent.
 *
 * It makes no network calls: prices are as recent as the installed `@pydantic/genai-prices` package.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { GenAIPricesEstimator } from '@strands-agents/sdk/vended-plugins/cost-estimator'
 *
 * const cost = new GenAIPricesEstimator()
 * const agent = new Agent({ model, plugins: [cost] })
 *
 * const result = await agent.invoke('Compare the three proposals.')
 * console.log(cost.estimate(result).totalUsd)
 * ```
 */
export class GenAIPricesEstimator implements Plugin {
  readonly name = 'strands:genai-prices-estimator'
  private readonly _prices = new Map<string, ModelPrice>()

  /**
   * @param config - The estimator's configuration
   * @throws Error if a price has an empty `modelId` or a rate that is not a finite, non-negative number, or two
   *   prices name the same provider and model
   */
  constructor(config: GenAIPricesEstimatorConfig = {}) {
    for (const price of config.prices ?? []) {
      validatePrice(price)
      const key = priceKey(price.providerName, price.modelId)
      if (this._prices.has(key)) {
        throw new Error(
          `providerName=<${price.providerName}>, modelId=<${price.modelId}> | prices has two entries for one model`
        )
      }
      this._prices.set(key, price)
    }
  }

  /**
   * Registers the middleware that adds a {@link CostEstimateEvent} after each model call.
   *
   * @param agent - The agent to attach to
   */
  initAgent(agent: LocalAgent): void {
    agent.addMiddleware(InvokeModelStage, (context, next) => this._emitEstimate(context, next))
  }

  /**
   * Estimates the cost of a request so far, including its nested and auxiliary model calls.
   *
   * A request you continue by passing its `invocationContext` to a later call is one request: its estimate
   * grows, so do not add the estimates together.
   *
   * @param request - An agent or multi-agent result, an `InvocationContext`, or usage records such as a saved
   *   `usageByModel`
   * @returns The estimate. A model without a price has `costUsd: null` and makes `totalUsd` `null`, as does a
   *   result that carries no `invocationContext`.
   * @throws TypeError if `request` is none of the accepted types
   */
  estimate(request: AgentResult | MultiAgentResult | InvocationContext | Iterable<ModelUsage>): CostEstimate {
    let source: unknown = request
    if (source instanceof AgentResult || source instanceof MultiAgentResult) {
      if (source.invocationContext === undefined) return { totalUsd: null, models: [], unpriced: [] }
      source = source.invocationContext
    }
    if (source instanceof InvocationContextImpl) return this._estimate(source.usageByModel)
    const usageByModel = isRecords(source) ? [...source] : undefined
    if (usageByModel === undefined || !usageByModel.every(isModelUsage)) {
      const typeName = (request as object | null | undefined)?.constructor?.name ?? String(request)
      throw new TypeError(
        `request=<${typeName}> | expected an agent or multi-agent result, an InvocationContext, ` +
          'or an iterable of ModelUsage'
      )
    }
    return this._estimate(usageByModel)
  }

  private async *_emitEstimate(
    context: InvokeModelContext,
    next: MiddlewareNextOf<typeof InvokeModelStage>
  ): AsyncGenerator<AgentStreamEvent, InvokeModelResult, undefined> {
    const result = yield* next(context)
    const event = this._eventAfterCall(context, result.result.metadata?.usage ?? createEmptyUsage())
    if (event !== undefined) yield event
    return result
  }

  /** The event for a model call that has ended, or `undefined` so a pricing error never fails the call. */
  private _eventAfterCall(context: InvokeModelContext, usage: Usage): CostEstimateEvent | undefined {
    try {
      const modelCall = this._estimateModel({ ...modelKey(context.model), usage })
      return new CostEstimateEvent({
        agent: context.agent,
        // The agent loop always sets the request; estimate() rejects a missing one.
        costEstimate: this.estimate(context.invocationContext as InvocationContext),
        modelCall,
        invocationState: context.invocationState,
        invocationContext: context.invocationContext,
      })
    } catch (error) {
      logger.warn(
        `error=<${normalizeError(error).message}> | cost estimate failed | no estimate emitted for this model call`
      )
      return undefined
    }
  }

  private _estimate(usageByModel: readonly ModelUsage[]): CostEstimate {
    const models = usageByModel.map((modelUsage) => this._estimateModel(modelUsage))
    const totalUsd = models.reduce<number | null>(
      (total, { costUsd }) => (total === null || costUsd === null ? null : total + costUsd),
      0
    )
    return { totalUsd, models, unpriced: models.filter((model) => model.costUsd === null) }
  }

  private _estimateModel(modelUsage: ModelUsage): ModelCostEstimate {
    const { providerName, modelId, usage } = modelUsage
    const found = this._findPrice(providerName, modelId)
    return {
      providerName,
      modelId,
      usage,
      costUsd: found ? cost(usage, found.price) : null,
      price: found?.price ?? null,
      priceSource: found?.priceSource ?? null,
    }
  }

  private _findPrice(providerName: string | null, modelId: string | null): FoundPrice | undefined {
    if (modelId === null) return undefined
    const price = this._prices.get(priceKey(providerName, modelId)) ?? this._prices.get(priceKey(null, modelId))
    return price ? { price, priceSource: 'user' } : genaiPrice(providerName, modelId)
  }
}

function priceKey(providerName: string | null | undefined, modelId: string): string {
  return JSON.stringify([providerName ?? null, modelId])
}

function validatePrice(price: ModelPrice): void {
  if (typeof price.modelId !== 'string' || !price.modelId) {
    throw new Error(`modelId=<${price.modelId}> | a price needs the id of the model it is for`)
  }
  for (const name of RATE_FIELDS) {
    const value = price[name]
    if (value === undefined && name.startsWith('cache')) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${name}=<${value}> | a price must be a finite, non-negative number`)
    }
  }
}

function isRecords(value: unknown): value is Iterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.iterator in value && !(value instanceof Map)
}

function isModelUsage(value: unknown): value is ModelUsage {
  const usage = (value as Partial<ModelUsage> | null | undefined)?.usage
  return typeof usage === 'object' && usage !== null
}

/** Looks a model up in genai-prices, returning its base rates and the entry that matched, if any. */
function genaiPrice(providerName: string | null, modelId: string): FoundPrice | undefined {
  const providerId = PROVIDER_IDS.get(providerName ?? '')
  if (providerName === null || providerId === undefined) return undefined
  const matched = calcPrice({ input_tokens: 0, output_tokens: 0 }, modelId, { providerId })
  if (matched === null) return undefined
  const [inputRate, outputRate, cacheReadRate, cacheWriteRate] = GENAI_RATE_FIELDS.map((field) =>
    baseRate(matched.model_price[field])
  )
  // A fee per request cannot be worked out from token counts, so an entry that has one is left unpriced.
  if (inputRate === undefined || outputRate === undefined || matched.model_price.requests_kcount !== undefined) {
    return undefined
  }
  const price = {
    modelId,
    providerName,
    inputPerMillion: inputRate,
    outputPerMillion: outputRate,
    ...(cacheReadRate !== undefined && { cacheReadPerMillion: cacheReadRate }),
    ...(cacheWriteRate !== undefined && { cacheWritePerMillion: cacheWriteRate }),
  }
  return { price, priceSource: `genai-prices:${matched.provider.id}/${matched.model.id}` }
}

/** A model's total cannot say which calls crossed a long-context tier, so a tiered rate is read at its base. */
function baseRate(rate: number | TieredPrices | undefined): number | undefined {
  return typeof rate === 'object' ? rate.base : rate
}

/** Tokens times price, charging cached tokens once whether or not `inputTokens` includes them. */
function cost(usage: Usage, price: ModelPrice): number {
  const cacheRead = usage.cacheReadInputTokens ?? 0
  const cacheWrite = usage.cacheWriteInputTokens ?? 0
  let uncachedInput = usage.inputTokens
  if (usage.inputTokens + usage.outputTokens === usage.totalTokens) {
    uncachedInput = Math.max(uncachedInput - cacheRead - cacheWrite, 0)
  }
  return (
    (uncachedInput * price.inputPerMillion +
      cacheRead * (price.cacheReadPerMillion ?? price.inputPerMillion) +
      cacheWrite * (price.cacheWritePerMillion ?? price.inputPerMillion) +
      usage.outputTokens * price.outputPerMillion) /
    1_000_000
  )
}
