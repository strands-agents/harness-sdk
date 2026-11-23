import { Agent, tool } from '@strands-agents/sdk'
import type { AgentResult } from '@strands-agents/sdk'
import {
  CostEstimateEvent,
  GenAIPricesEstimator,
} from '@strands-agents/sdk/vended-plugins/cost-estimator'
import { z } from 'zod'

// =====================
// Read the Estimate from the Stream
// =====================

async function streamExample() {
  // --8<-- [start:stream]
  const cost = new GenAIPricesEstimator()
  const agent = new Agent({ plugins: [cost], printer: false })

  const prompt = 'Why is the sky blue? Answer in one sentence.'
  for await (const event of agent.stream(prompt)) {
    if (event.type === 'costEstimateEvent') {
      const call = event.modelCall
      console.log('call:', call.modelId, call.costUsd)
      console.log('so far:', event.costEstimate.totalUsd)
    }
    if (event.type === 'agentResultEvent') {
      const estimate = cost.estimate(event.result)
      console.log('request:', estimate.totalUsd)
      for (const model of estimate.models) {
        console.log(' ', model.modelId, model.costUsd, model.priceSource)
      }
    }
  }
  // --8<-- [end:stream]
}
void streamExample

function hookExample(agent: Agent) {
  // --8<-- [start:hook]
  agent.addHook(CostEstimateEvent, (event) => {
    console.log('so far:', event.costEstimate.totalUsd)
  })
  // --8<-- [end:hook]
}
void hookExample

// =====================
// Estimate a Request
// =====================

async function estimateRequestExample() {
  // --8<-- [start:estimate_request]
  const research = tool({
    name: 'research',
    description: 'Research a topic and return short notes.',
    inputSchema: z.object({ topic: z.string() }),
    callback: async ({ topic }, context) => {
      const researcher = new Agent({
        model: 'us.amazon.nova-lite-v1:0',
        printer: false,
      })
      const result = await researcher.invoke(topic, {
        ...(context?.invocationContext && {
          invocationContext: context.invocationContext,
        }),
      })
      return result.toString()
    },
  })

  const cost = new GenAIPricesEstimator()
  const agent = new Agent({ tools: [research], printer: false })

  const result = await agent.invoke(
    'Research why the sky is blue, then answer in one sentence.'
  )
  const estimate = cost.estimate(result)

  console.log(estimate.totalUsd)
  for (const model of estimate.models) {
    console.log(' ', model.modelId, model.costUsd, model.priceSource)
  }
  // --8<-- [end:estimate_request]
}
void estimateRequestExample

// =====================
// Use Your Own Prices
// =====================

function ownPricesExample() {
  // --8<-- [start:own_prices]
  const cost = new GenAIPricesEstimator({
    prices: [
      { modelId: 'my-endpoint', inputPerMillion: 0.2, outputPerMillion: 0.6 },
      {
        modelId: 'us.amazon.nova-lite-v1:0',
        providerName: 'bedrock',
        inputPerMillion: 0.06,
        outputPerMillion: 0.24,
        cacheReadPerMillion: 0.015,
        cacheWritePerMillion: 0,
      },
    ],
  })
  // --8<-- [end:own_prices]
  void cost
}
void ownPricesExample

// =====================
// When a Model Has No Price
// =====================

function unpricedExample(cost: GenAIPricesEstimator, result: AgentResult) {
  // --8<-- [start:unpriced]
  const estimate = cost.estimate(result)

  if (estimate.totalUsd === undefined) {
    console.log(
      'No price for:',
      estimate.unpriced.map((model) => model.modelId)
    )
  }
  // --8<-- [end:unpriced]
}
void unpricedExample
