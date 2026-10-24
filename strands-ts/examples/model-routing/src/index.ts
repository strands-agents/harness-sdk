import {
  AfterModelCallEvent,
  Agent,
  BedrockModel,
  ClassifierStrategy,
  DecisionModel,
  DecisionStrategy,
  LLMDecisionModel,
  ModelRouter,
  RoutingCandidate,
  type AskOptions,
  type DecisionInput,
  type DecisionResult,
  type Model,
  type Question,
} from '@strands-agents/sdk'

const CLASSIFIER_MODEL_ID = 'global.anthropic.claude-haiku-5-5'
/** Small open-weight model that answers the routing question in scenario 2. */
const DECISION_MODEL_ID = 'mistral.ministral-3-8b-instruct'
/** Small open-weight model that serves routine requests. */
const ROUTINE_MODEL_ID = 'openai.gpt-oss-20b-1:0'
const ADVANCED_MODEL_ID = 'global.anthropic.claude-opus-5'

const ROUTINE_REQUEST = 'What is the capital of France? Answer in one word.'
const ADVANCED_REQUEST =
  'Design a backward-compatible migration from region-local to globally unique idempotency keys for an ' +
  'active-active payment service. Account for concurrent requests, mixed-version deployments, and rollback. ' +
  'Return exactly three concise bullets.'

/** Picks the advanced candidate when the request mentions design work. Runs locally, no model call. */
class KeywordDecisionModel extends DecisionModel {
  lastState: DecisionInput | undefined
  lastQuestions: Record<string, Question> | undefined

  protected async _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
    _options: AskOptions
  ): Promise<DecisionResult<Q>> {
    this.lastState = state
    this.lastQuestions = questions
    const choices = questions['candidate']!.choices as readonly string[]
    const answer = JSON.stringify(state).toLowerCase().includes('design') ? choices[1] : choices[0]
    return { answers: { candidate: answer } as DecisionResult<Q>['answers'], metadata: { latencyMs: 0 } }
  }
}

/** Never answers on its own; records whether the strategy's timeout aborted it. */
class SlowDecisionModel extends DecisionModel {
  aborted = false

  protected _ask<const Q extends Record<string, Question>>(
    _state: DecisionInput,
    _questions: Q,
    options: AskOptions
  ): Promise<DecisionResult<Q>> {
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        this.aborted = true
        reject(new Error('decision aborted'))
      })
    })
  }
}

function candidates(routine: Model, advanced: Model): RoutingCandidate[] {
  return [
    new RoutingCandidate({
      model: routine,
      name: 'routine',
      description: 'Concise factual questions and routine requests.',
      metadata: { modelId: ROUTINE_MODEL_ID, cost: 'low' },
    }),
    new RoutingCandidate({
      model: advanced,
      name: 'advanced',
      description: 'Systems design with several interacting constraints.',
      metadata: { modelId: ADVANCED_MODEL_ID, cost: 'high' },
    }),
  ]
}

/** Invoke a fresh agent and return the model id that actually served the first model call. */
async function servedBy(router: ModelRouter, request: string): Promise<string> {
  const agent = new Agent({ model: router, printer: false })
  const served: string[] = []
  agent.addHook(AfterModelCallEvent, (event) => {
    served.push(event.model.modelId ?? 'unknown')
  })
  await agent.invoke(request)
  return served[0] ?? 'none'
}

function report(label: string, actual: string, expected: string): boolean {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      served=${actual}\n      expected=${expected}`)
  return ok
}

async function main(): Promise<void> {
  // gpt-oss and Claude Opus 5 both emit reasoning before their answer, so they need headroom beyond the reply.
  const routine = new BedrockModel({ modelId: ROUTINE_MODEL_ID, maxTokens: 2048 })
  const advanced = new BedrockModel({ modelId: ADVANCED_MODEL_ID, maxTokens: 8192 })
  // Claude Haiku 5.5 rejects `temperature`, so the classifier relies on the model default.
  const classifierModel = new BedrockModel({ modelId: CLASSIFIER_MODEL_ID, maxTokens: 64 })
  const decisionModel = new BedrockModel({ modelId: DECISION_MODEL_ID, maxTokens: 64, temperature: 0 })
  const results: boolean[] = []

  console.log('\n=== 1. ClassifierStrategy (existing API, now a DecisionStrategy preset) ===')
  const classifier = new ModelRouter(candidates(routine, advanced), {
    strategy: new ClassifierStrategy(classifierModel, { timeoutMs: 15_000 }),
  })
  results.push(report('routine request', await servedBy(classifier, ROUTINE_REQUEST), ROUTINE_MODEL_ID))
  results.push(report('advanced request', await servedBy(classifier, ADVANCED_REQUEST), ADVANCED_MODEL_ID))

  console.log('\n=== 2. DecisionStrategy + LLMDecisionModel over a small open-weight model ===')
  const llmDecision = new ModelRouter(candidates(routine, advanced), {
    strategy: new DecisionStrategy(new LLMDecisionModel({ model: decisionModel }), { timeoutMs: 15_000 }),
  })
  results.push(report('advanced request', await servedBy(llmDecision, ADVANCED_REQUEST), ADVANCED_MODEL_ID))

  console.log('\n=== 3. DecisionStrategy + custom DecisionModel (no classifier call) ===')
  const keywordModel = new KeywordDecisionModel()
  const keyword = new ModelRouter(candidates(routine, advanced), { strategy: new DecisionStrategy(keywordModel) })
  results.push(report('advanced request', await servedBy(keyword, ADVANCED_REQUEST), ADVANCED_MODEL_ID))
  console.log('      question sent:', JSON.stringify(keywordModel.lastQuestions))
  console.log('      state sent:   ', String(keywordModel.lastState).slice(0, 300), '...')

  console.log('\n=== 4. Timeout aborts the decision call and serves candidate c0 ===')
  const slowModel = new SlowDecisionModel()
  const slow = new ModelRouter(candidates(routine, advanced), {
    strategy: new DecisionStrategy(slowModel, { timeoutMs: 200 }),
  })
  results.push(report('advanced request after timeout', await servedBy(slow, ADVANCED_REQUEST), ROUTINE_MODEL_ID))
  console.log(`      decision call aborted: ${slowModel.aborted}`)
  results.push(slowModel.aborted)

  const failed = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  if (failed > 0) process.exitCode = 1
}

await main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
