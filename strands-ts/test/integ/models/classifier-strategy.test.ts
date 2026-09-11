import { describe, expect, it } from 'vitest'
import { Agent, AfterModelCallEvent, ClassifierStrategy, ModelRouter, RoutingCandidate } from '@strands-agents/sdk'
import type { Model } from '@strands-agents/sdk'
import { bedrock } from '../__fixtures__/model-providers.js'

const HAIKU_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
const NOVA_LITE_MODEL_ID = 'us.amazon.nova-lite-v1:0'
const NOVA_PRO_MODEL_ID = 'us.amazon.nova-pro-v1:0'

describe.skipIf(bedrock.skip)('ClassifierStrategy Integration Tests', () => {
  // Retried once because Bedrock capacity may be transiently unavailable.
  it('classifies and serves a request on the expected candidate', { timeout: 120_000, retry: 1 }, async () => {
    const fastModel = bedrock.createModel({ modelId: HAIKU_MODEL_ID, maxTokens: 512 })
    const balancedModel = bedrock.createModel({ modelId: NOVA_LITE_MODEL_ID, maxTokens: 512 })
    const advancedModel = bedrock.createModel({ modelId: NOVA_PRO_MODEL_ID, maxTokens: 512 })
    const router = new ModelRouter(
      [
        new RoutingCandidate({
          model: fastModel,
          name: 'fast model',
          description: 'Best suited to concise factual questions and routine requests.',
          metadata: { provider: 'bedrock', modelId: HAIKU_MODEL_ID },
        }),
        new RoutingCandidate({
          model: advancedModel,
          name: 'advanced model',
          description: 'Best suited to complex systems design with several interacting constraints.',
          metadata: { provider: 'bedrock', modelId: NOVA_PRO_MODEL_ID },
        }),
        new RoutingCandidate({
          model: balancedModel,
          name: 'balanced model',
          description: 'Best suited to summaries and moderately complex general requests.',
          metadata: { provider: 'bedrock', modelId: NOVA_LITE_MODEL_ID },
        }),
      ],
      {
        strategy: new ClassifierStrategy(
          bedrock.createModel({ modelId: HAIKU_MODEL_ID, maxTokens: 64, temperature: 0 })
        ),
      }
    )
    const agent = new Agent({ model: router, systemPrompt: 'You are just an agent', printer: false })
    const servedModels: Model[] = []
    agent.addHook(AfterModelCallEvent, (event) => {
      servedModels.push(event.model)
    })
    const request =
      'Design a backward-compatible migration from region-local to globally unique idempotency keys for an ' +
      'active-active payment service. Account for concurrent requests, mixed-version deployments, rollback, ' +
      'reconciliation, and monitoring. Return exactly three concise bullets.'

    const result = await agent.invoke(request)

    expect(result.stopReason).toBe('endTurn')
    expect(String(result).trim().length).toBeGreaterThan(0)
    expect(servedModels[0]).toBe(advancedModel)
  })
})
