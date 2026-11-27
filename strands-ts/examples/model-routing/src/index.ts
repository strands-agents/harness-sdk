import {
  AfterModelCallEvent,
  Agent,
  BedrockModel,
  ClassifierStrategy,
  ModelRouter,
  RoutingCandidate,
} from '@strands-agents/sdk'

const FAST_MODEL_ID = 'us.amazon.nova-lite-v1:0'
const ADVANCED_MODEL_ID = 'us.amazon.nova-pro-v1:0'
const CLASSIFIER_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'

const EASY_REQUEST = 'What is the capital of France? Answer in one word.'
const HARD_REQUEST =
  'Design a backward-compatible migration from region-local to globally unique idempotency keys for an ' +
  'active-active payment service. Account for concurrent requests, mixed-version deployments, and rollback. ' +
  'Return exactly three concise bullets.'

const router = new ModelRouter(
  [
    new RoutingCandidate({
      model: new BedrockModel({ modelId: FAST_MODEL_ID, maxTokens: 512 }),
      name: 'fast',
      description: 'Concise factual questions and routine requests.',
    }),
    new RoutingCandidate({
      model: new BedrockModel({ modelId: ADVANCED_MODEL_ID, maxTokens: 1024 }),
      name: 'advanced',
      description: 'Systems design with several interacting constraints.',
    }),
  ],
  { strategy: new ClassifierStrategy(new BedrockModel({ modelId: CLASSIFIER_MODEL_ID, maxTokens: 64 })) }
)

async function ask(label: string, request: string): Promise<void> {
  const agent = new Agent({ model: router, printer: false })
  let servedBy = 'none'
  agent.addHook(AfterModelCallEvent, (event) => {
    servedBy = event.model.modelId ?? 'unknown'
  })
  await agent.invoke(request)
  console.log(`${label} request served by ${servedBy}`)
}

await ask('easy', EASY_REQUEST)
await ask('hard', HARD_REQUEST)
