import { HookableEvent, type HookableEventData } from '../../hooks/events.js'
import type { Usage } from '../../models/streaming.js'
import type { InvocationState, LocalAgent } from '../../types/agent.js'

/**
 * List price of a model in USD per one million tokens.
 */
export interface ModelPrice {
  /** The model the price is for, compared as a whole string. */
  readonly modelId: string
  /** Price of uncached input tokens. */
  readonly inputPerMillion: number
  /** Price of output tokens. */
  readonly outputPerMillion: number
  /** Price of input tokens read from cache; the input price when unset. */
  readonly cacheReadPerMillion?: number
  /** Price of input tokens written to cache; the input price when unset. */
  readonly cacheWritePerMillion?: number
  /** The provider the price is for, compared as a whole string with the usage's `providerName`; any provider when unset. */
  readonly providerName?: string
}

/**
 * Estimated cost of one model's share of a request, or of one model call.
 */
export interface ModelCostEstimate {
  /** Name of the model's provider; `undefined` when not known. */
  readonly providerName?: string
  /** The model id; `undefined` when not known. */
  readonly modelId?: string
  /** The token usage the estimate is for. */
  readonly usage: Usage
  /** The estimate in USD; `undefined` when no price was found. */
  readonly costUsd?: number
  /** The price used; `undefined` when no price was found. */
  readonly price?: ModelPrice
  /** `'user'` for a price you passed, or the genai-prices entry the price came from, such as `'genai-prices:aws/amazon.nova-lite-v1:0'`; `undefined` when no price was found. */
  readonly priceSource?: string
}

/**
 * Estimated cost of a request so far.
 */
export interface CostEstimate {
  /** The estimate in USD; `undefined` when any model in the request has no price. */
  readonly totalUsd?: number
  /** The estimate for each model the request used. */
  readonly models: readonly ModelCostEstimate[]
  /** The models no price was found for. */
  readonly unpriced: readonly ModelCostEstimate[]
}

/**
 * Event emitted after each model call, carrying its estimated cost and the request's so far.
 *
 * `modelCall` names the model the plugin saw. Wrap middleware added after the plugin that swaps the
 * model, or answers without calling one, is not reflected in it; the request's estimate is.
 */
export class CostEstimateEvent extends HookableEvent {
  readonly type = 'costEstimateEvent' as const
  readonly agent: LocalAgent
  /** The running estimate for the whole request so far. */
  readonly costEstimate: CostEstimate
  /** The estimate for the model call that just ended. */
  readonly modelCall: ModelCostEstimate
  readonly invocationState: InvocationState

  constructor(
    data: {
      agent: LocalAgent
      costEstimate: CostEstimate
      modelCall: ModelCostEstimate
      invocationState: InvocationState
    } & HookableEventData
  ) {
    super(data)
    this.agent = data.agent
    this.costEstimate = data.costEstimate
    this.modelCall = data.modelCall
    this.invocationState = data.invocationState
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<CostEstimateEvent, 'type' | 'costEstimate' | 'modelCall'> {
    return { type: this.type, costEstimate: this.costEstimate, modelCall: this.modelCall }
  }
}
