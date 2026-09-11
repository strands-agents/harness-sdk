import {
  Agent,
  BedrockModel,
  ClassifierStrategy,
  FallbackStrategy,
  ModelRouter,
  RoutingCandidate,
  type RoutingContext,
  type RoutingStrategy,
} from '@strands-agents/sdk'

async function modelRoutingOrderedFallback() {
  // --8<-- [start:mr_fallback]
  const primaryModel = new BedrockModel({
    modelId: 'us.amazon.nova-pro-v1:0',
  })
  const backupModel = new BedrockModel({
    modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  })

  const router = new ModelRouter([primaryModel, backupModel], {
    maxSwitches: 1,
  })
  const agent = new Agent({ model: router })

  await agent.invoke('Summarize the tradeoffs of active-active deployment.')
  // --8<-- [end:mr_fallback]
}

async function modelRoutingClassifier() {
  // --8<-- [start:mr_classify]
  const routingPolicy =
    'Choose the lowest-latency candidate that satisfies every request requirement. ' +
    'Use candidate metadata as evidence.'
  const classifierModel = new BedrockModel({
    modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    maxTokens: 64,
    temperature: 0,
  })
  const routineModel = new BedrockModel({
    modelId: 'us.amazon.nova-lite-v1:0',
  })
  const advancedModel = new BedrockModel({
    modelId: 'us.amazon.nova-pro-v1:0',
  })

  const router = new ModelRouter(
    [
      new RoutingCandidate({
        model: routineModel,
        name: 'routine',
        description: 'Concise factual questions and routine requests.',
        metadata: { cost: 'low', latency: 'low', complexity: 'routine' },
      }),
      new RoutingCandidate({
        model: advancedModel,
        name: 'advanced',
        description: 'Systems design with several interacting constraints.',
        metadata: { cost: 'high', latency: 'medium', complexity: 'advanced' },
      }),
    ],
    {
      strategy: new ClassifierStrategy(classifierModel, {
        systemPrompt: routingPolicy,
      }),
    }
  )
  const agent = new Agent({ model: router })

  await agent.invoke(
    'Design a rollback-safe migration from regional to global idempotency keys.'
  )
  // --8<-- [end:mr_classify]
}

async function modelRoutingComposedStrategy() {
  // --8<-- [start:mr_composed]
  class ClassifyThenFallback implements RoutingStrategy {
    private readonly _classifier: ClassifierStrategy
    private readonly _fallback = new FallbackStrategy()

    constructor(classifier: ClassifierStrategy) {
      this._classifier = classifier
    }

    async select(context: RoutingContext): Promise<RoutingCandidate | undefined> {
      if (context.attempts.length === 0) {
        return this._classifier.select(context)
      }
      return this._fallback.select(context)
    }
  }

  const classifierModel = new BedrockModel({
    modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    maxTokens: 64,
    temperature: 0,
  })
  const strategy = new ClassifyThenFallback(new ClassifierStrategy(classifierModel))
  const router = new ModelRouter(
    [
      new RoutingCandidate({
        model: new BedrockModel({
          modelId: 'us.amazon.nova-lite-v1:0',
        }),
        name: 'routine',
        description: 'Concise factual questions and routine requests.',
      }),
      new RoutingCandidate({
        model: new BedrockModel({
          modelId: 'us.amazon.nova-pro-v1:0',
        }),
        name: 'advanced',
        description: 'Systems design with several interacting constraints.',
      }),
    ],
    { strategy }
  )
  const agent = new Agent({ model: router })
  await agent.invoke(
    'Design a rollback-safe migration from regional to global idempotency keys.'
  )
  // --8<-- [end:mr_composed]
}
