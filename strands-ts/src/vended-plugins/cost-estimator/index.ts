/**
 * Cost estimate plugin for Strands Agents.
 *
 * Estimates what a request cost in USD from its token usage per model and the list prices bundled in the
 * third-party `@pydantic/genai-prices` package. The estimate is not a bill.
 *
 * Requires the optional peer dependency `@pydantic/genai-prices` (`npm install @pydantic/genai-prices`);
 * importing this module without it fails.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { GenAIPricesEstimator } from '@strands-agents/sdk/vended-plugins/cost-estimator'
 *
 * const cost = new GenAIPricesEstimator()
 * const agent = new Agent({ model, plugins: [cost] })
 *
 * for await (const event of agent.stream('Compare the three proposals.')) {
 *   if (event.type === 'costEstimateEvent') console.log('so far:', event.costEstimate.totalUsd)
 *   if (event.type === 'agentResultEvent') console.log('request:', cost.estimate(event.result).totalUsd)
 * }
 * ```
 */

export { GenAIPricesEstimator } from './plugin.js'
export type { GenAIPricesEstimatorConfig } from './plugin.js'
export { CostEstimateEvent } from './types.js'
export type { CostEstimate, ModelCostEstimate, ModelPrice } from './types.js'
