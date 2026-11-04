import {
  Agent,
  BedrockModel,
  ClassifierStrategy,
  FallbackStrategy,
  ModelRouter,
  RoutingCandidate,
  tool,
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

  constructor(private readonly classifier: ClassifierStrategy) {}

  async select(context: RoutingContext): Promise<RoutingCandidate | undefined> {
    const tenant = String(context.invocationState.tenant ?? 'None')
    const providers = TENANT_PROVIDERS[tenant] ?? []
    const allowed = context.candidates.filter((c) =>
      providers.includes(String(c.metadata?.provider))
    )
    if (allowed.length === 0) {
      console.warn(`tenant=<${tenant}> | no allowed model, refusing call`)
      throw new TenantPolicyError(`tenant '${tenant}' has no allowed model`)
    }

    let choice: RoutingCandidate | undefined
    if (context.attempts.length > 0) {
      // Fail over to the backup first, so a hard request never drops to the small model
      const backups = allowed.filter((c) => c.metadata?.tier === 'backup')
      const others = allowed.filter((c) => c.metadata?.tier !== 'backup')
      choice = await this.fallback.select({
        ...context,
        candidates: [...backups, ...others],
      })
    } else {
      const primary = allowed.filter((c) => c.metadata?.tier === 'primary')
      const primaries = primary.length > 0 ? primary : allowed
      // A declined classification would serve the router's first candidate,
      // which this tenant may not be allowed to use
      choice =
        (await this.classifier.select({ ...context, candidates: primaries })) ??
        primaries[0]
    }
    const attempt = context.attempts.length > 0 ? 'retry' : 'first'
    console.info(
      `tenant=<${tenant}>, candidate=<${choice?.name ?? 'None'}>, attempt=<${attempt}>` +
        ' | routing decision'
    )
    return choice
  }
}
// --8<-- [end:mtr_strategy]

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

  const classifier = new ClassifierStrategy(
    new BedrockModel({
      modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      maxTokens: 64,
      temperature: 0,
    })
  )
  const router = new ModelRouter(candidates, {
    strategy: new TenantPolicyStrategy(classifier),
  })
  const agent = new Agent({ model: router, tools: [lookupOrder] })

  await agent.invoke('Where is order A-1001?', {
    invocationState: { tenant: 'customer-a' },
  })
  // --8<-- [end:mtr_agent]
}
