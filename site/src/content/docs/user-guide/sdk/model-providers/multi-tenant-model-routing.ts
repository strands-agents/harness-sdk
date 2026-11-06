import {
  Agent,
  BedrockModel,
  DecisionModel,
  FallbackStrategy,
  LLMDecisionModel,
  ModelRouter,
  RoutingCandidate,
  tool,
  type DecisionInput,
  type DecisionResult,
  type Question,
  type RoutingContext,
  type RoutingStrategy,
} from '@strands-agents/sdk'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { setupTracer } from '@strands-agents/sdk/telemetry'
import { z } from 'zod'

async function multiTenantTracing() {
  // --8<-- [start:mtr_tracing]
  setupTracer({ exporters: { otlp: true } })
  // --8<-- [end:mtr_tracing]
}

// --8<-- [start:mtr_candidates]
const fast = new BedrockModel({ modelId: 'us.amazon.nova-lite-v1:0' })
const strong = new AnthropicModel({ modelId: 'claude-sonnet-5', maxTokens: 1024 })
const backup = new OpenAIModel({ api: 'chat', modelId: 'gpt-5.4' })

const candidates = [
  new RoutingCandidate({
    model: fast,
    name: 'fast',
    description: 'Short factual questions and order lookups.',
    metadata: { provider: 'bedrock', tier: 'primary' },
  }),
  new RoutingCandidate({
    model: strong,
    name: 'strong',
    description: 'Multi-step reasoning, trade-offs, and recommendations.',
    metadata: { provider: 'anthropic', tier: 'primary' },
  }),
  new RoutingCandidate({
    model: backup,
    name: 'backup',
    description: 'Serves requests when the primary provider is unavailable.',
    metadata: { provider: 'openai', tier: 'backup' },
  }),
]
// --8<-- [end:mtr_candidates]

// --8<-- [start:mtr_strategy]
const TENANT_PROVIDERS: Record<string, string[]> = {
  'customer-a': ['bedrock', 'anthropic', 'openai'],
  'customer-b': ['bedrock'], // requests stay in Amazon Bedrock
}

class TenantPolicyError extends Error {}

class TenantPolicyStrategy implements RoutingStrategy {
  private readonly fallback = new FallbackStrategy()

  constructor(private readonly decisions: DecisionModel) {}

  async select(context: RoutingContext): Promise<RoutingCandidate | undefined> {
    const tenant = String(context.invocationState.tenant ?? 'None')
    const providers = Object.hasOwn(TENANT_PROVIDERS, tenant)
      ? TENANT_PROVIDERS[tenant]!
      : []
    const allowed = context.candidates.filter((c) =>
      providers.includes(String(c.metadata?.provider))
    )
    if (allowed.length === 0) {
      console.warn(`tenant=<${tenant}> | no allowed model, refusing call`)
      throw new TenantPolicyError(`tenant '${tenant}' has no allowed model`)
    }

    let choice: RoutingCandidate | undefined
    if (context.attempts.length > 0) {
      // Try the backup before the small model, so a hard request stays on a capable
      // model while one is available
      const backups = allowed.filter((c) => c.metadata?.tier === 'backup')
      const others = allowed.filter((c) => c.metadata?.tier !== 'backup')
      choice = await this.fallback.select({
        ...context,
        candidates: [...backups, ...others],
      })
    } else {
      const primary = allowed.filter((c) => c.metadata?.tier === 'primary')
      // A tenant that allows only the backup opens on it
      const primaries = primary.length > 0 ? primary : allowed
      choice = primaries[0]
      // One allowed model needs no decision
      if (primaries.length > 1) {
        try {
          choice = await this.decide(context, primaries)
        } catch (error) {
          console.warn(`error=<${error}> | decision failed`)
        }
      }
    }
    const attempt = context.attempts.length > 0 ? 'retry' : 'first'
    console.info(
      `tenant=<${tenant}>, candidate=<${choice?.name ?? 'None'}>, attempt=<${attempt}>` +
        ' | routing decision'
    )
    return choice
  }

  private async decide(
    context: RoutingContext,
    primaries: RoutingCandidate[]
  ): Promise<RoutingCandidate> {
    const lastUser = [...context.messages].reverse().find((m) => m.role === 'user')
    const request = (lastUser?.content ?? [])
      .map((block) => (block.type === 'textBlock' ? block.text : ''))
      .join('')
    const state = JSON.stringify({
      latest_request: request,
      candidates: primaries.map((c) => ({ name: c.name, description: c.description })),
    })
    const result = await this.decisions.ask(
      state,
      {
        model: {
          question: 'Which candidate should handle the latest request?',
          choices: primaries.map((c) => c.name ?? ''),
          uncertainty: false,
        },
      },
      context.invocationContext ? { invocationContext: context.invocationContext } : {}
    )
    const picked = result.answers.model
    return primaries.find((c) => c.name === picked) ?? primaries[0]!
  }
}
// --8<-- [end:mtr_strategy]

// --8<-- [start:mtr_decider]
/** Asks choice questions of a `strands-decider serve` server. */
class StrandsDecider extends DecisionModel {
  constructor(private readonly url = 'http://localhost:8000/v1/systemone') {
    super()
  }

  protected async _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q
  ): Promise<DecisionResult<Q>> {
    if (Object.values(questions).some((q) => q.choices === 'boolean')) {
      throw new Error('StrandsDecider answers choice questions only')
    }
    const wire = Object.fromEntries(
      Object.entries(questions).map(([id, q]) => [
        id,
        {
          type: 'choice',
          instructions: q.question,
          criteria: Object.fromEntries([...q.choices].map((choice) => [choice, null])),
        },
      ])
    )
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, questions: wire }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Strands Decider returned ${response.status}`)
    const reply = (await response.json()) as {
      answers: Record<string, { choice: string }>
      usage: { input_tokens: number; output_tokens: number }
      latency_ms: number
    }
    // The server always picks one of the question's choices
    const answers = Object.fromEntries(
      Object.keys(questions).map((id) => [id, reply.answers[id]!.choice])
    )
    return {
      answers: answers as DecisionResult<Q>['answers'],
      metadata: { latencyMs: Math.round(reply.latency_ms) },
      usage: {
        inputTokens: reply.usage.input_tokens,
        outputTokens: reply.usage.output_tokens,
        totalTokens: reply.usage.input_tokens + reply.usage.output_tokens,
      },
    }
  }
}
// --8<-- [end:mtr_decider]

function multiTenantSwap() {
  // --8<-- [start:mtr_swap]
  const haiku = new BedrockModel({
    modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  })
  const strategy = new TenantPolicyStrategy(new LLMDecisionModel({ model: haiku }))
  // --8<-- [end:mtr_swap]
  return strategy
}

async function multiTenantAgent() {
  // --8<-- [start:mtr_agent]
  const lookupOrder = tool({
    name: 'lookup_order',
    description: 'Look up the shipping status of an order, such as A-1001.',
    inputSchema: z.object({ orderId: z.string() }),
    callback: ({ orderId }) =>
      orderId === 'A-1001'
        ? { status: 'shipped', eta: 'Nov 6' }
        : { status: 'not found' },
  })

  const strategy = new TenantPolicyStrategy(new StrandsDecider())
  const router = new ModelRouter(candidates, { strategy })
  const agent = new Agent({ model: router, tools: [lookupOrder] })

  await agent.invoke('Where is order A-1001?', {
    invocationState: { tenant: 'customer-a' },
  })
  // --8<-- [end:mtr_agent]
}
