import { afterEach, describe, expect, it, vi } from 'vitest'

import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { Agent } from '../../../agent/agent.js'
import { InvocationContextImpl } from '../../../agent/invocation-context.js'
import { DecisionModel } from '../../../decisions/decision-model.js'
import { Uncertain } from '../../../decisions/types.js'
import { logger } from '../../../logging/logger.js'
import { AudioBlock, DocumentBlock, ImageBlock, VideoBlock } from '../../../types/media.js'
import { CachePointBlock, GuardContentBlock, Message, TextBlock } from '../../../types/messages.js'
import { candidateKey, DecisionStrategy, QUESTION_ID } from '../decision-strategy.js'
import { ModelRouter, RoutingCandidate } from '../router.js'
import type { AskOptions, DecisionInput, DecisionResult, Question } from '../../../decisions/types.js'
import type { SystemPrompt } from '../../../types/messages.js'
import type { RoutingContext } from '../strategy.js'

type Answer = string | boolean | Uncertain | Error

/** Records each ask and answers the `candidate` question with a scripted value. */
class FakeDecisionModel extends DecisionModel {
  readonly states: DecisionInput[] = []
  readonly questions: Record<string, Question>[] = []
  readonly options: AskOptions[] = []
  delayMs = 0
  usage: DecisionResult['usage']

  constructor(private readonly _answer: Answer) {
    super()
  }

  protected async _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
    options: AskOptions
  ): Promise<DecisionResult<Q>> {
    this.states.push(state)
    this.questions.push(questions)
    this.options.push(options)
    if (this.delayMs > 0) await abortableDelay(this.delayMs, options.signal)
    if (this._answer instanceof Error) throw this._answer
    return {
      answers: { [QUESTION_ID]: this._answer } as DecisionResult<Q>['answers'],
      ...(this.usage !== undefined && { usage: this.usage }),
      metadata: { latencyMs: 1 },
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    })
  })
}

function responseModel(text: string): MockMessageModel {
  return new MockMessageModel().addTurn({ type: 'textBlock', text })
}

function candidate(name: string): RoutingCandidate {
  return new RoutingCandidate({ model: responseModel(name), name, description: `Model for ${name} requests.` })
}

function routingContext(
  router: ModelRouter,
  overrides: Partial<Pick<RoutingContext, 'messages' | 'systemPrompt' | 'attempts'>> = {}
): RoutingContext {
  return {
    messages: overrides.messages ?? [new Message({ role: 'user', content: [new TextBlock('Plan a migration')] })],
    systemPrompt: overrides.systemPrompt ?? 'Be precise',
    toolSpecs: [],
    candidates: router.candidates,
    invocationState: {},
    attempts: overrides.attempts ?? [],
  }
}

function sentState(model: FakeDecisionModel): {
  latestRequest: string
  agentInstructions: string
  candidates: unknown[]
} {
  return JSON.parse(model.states[0] as string)
}

afterEach(() => {
  vi.restoreAllMocks()
})

const bytes = new Uint8Array([1])

describe('DecisionStrategy', () => {
  describe('select', () => {
    it('maps the answered positional key to the configured candidate instance', async () => {
      const decisionModel = new FakeDecisionModel(candidateKey(1))
      const strategy = new DecisionStrategy(decisionModel)
      const router = new ModelRouter([candidate('routine'), candidate('complex')], { strategy })

      const selected = await strategy.select(routingContext(router))

      expect(selected).toBe(router.candidates[1])
    })

    it('asks one question over positional keys with uncertainty disabled', async () => {
      const decisionModel = new FakeDecisionModel(candidateKey(0))
      const strategy = new DecisionStrategy(decisionModel, { question: 'Which model fits?' })
      const router = new ModelRouter([candidate('a'), responseModel('unnamed'), candidate('uncertain')], {
        strategy,
      })

      await strategy.select(routingContext(router))

      expect(decisionModel.questions[0]).toEqual({
        [QUESTION_ID]: {
          question: 'Which model fits?',
          choices: [candidateKey(0), candidateKey(1), candidateKey(2)],
          uncertainty: false,
        },
      })
    })

    it('sends bounded request, instructions, and keyed candidate evidence as JSON state', async () => {
      const decisionModel = new FakeDecisionModel(candidateKey(0))
      const strategy = new DecisionStrategy(decisionModel, { maxMessageChars: 100, maxAgentInstructionsChars: 50 })
      const router = new ModelRouter(
        [new RoutingCandidate({ model: responseModel('a'), name: 'a', metadata: { cost: 'low' } }), responseModel('b')],
        { strategy }
      )
      const systemPrompt: SystemPrompt = [new TextBlock('B'.repeat(200)), new CachePointBlock({ cacheType: 'default' })]
      const messages = [new Message({ role: 'user', content: [new TextBlock('A'.repeat(300))] })]

      await strategy.select(routingContext(router, { messages, systemPrompt }))

      const state = sentState(decisionModel)
      expect({
        requestLength: state.latestRequest.length,
        requestOmitted: state.latestRequest.includes('...[content omitted for routing]...'),
        instructionsLength: state.agentInstructions.length,
        candidates: state.candidates,
      }).toEqual({
        requestLength: 100,
        requestOmitted: true,
        instructionsLength: 50,
        candidates: [{ key: candidateKey(0), name: 'a', metadata: { cost: 'low' } }, { key: candidateKey(1) }],
      })
    })

    it.each([
      { name: 'audio', block: new AudioBlock({ format: 'wav', source: { bytes } }), expected: '[Audio]' },
      { name: 'image', block: new ImageBlock({ format: 'png', source: { bytes } }), expected: '[Image]' },
      {
        name: 'document',
        block: new DocumentBlock({ format: 'pdf', name: 'doc-secret', source: { bytes } }),
        expected: '[Document]',
      },
      { name: 'video', block: new VideoBlock({ format: 'mp4', source: { bytes } }), expected: '[Video]' },
      {
        name: 'guarded image',
        block: new GuardContentBlock({ image: { format: 'png', source: { bytes } } }),
        expected: '[Guarded content]',
      },
    ])('routes a $name-only latest request by placeholder, not stale history', async ({ block, expected }) => {
      const decisionModel = new FakeDecisionModel(candidateKey(0))
      const strategy = new DecisionStrategy(decisionModel)
      const router = new ModelRouter([candidate('a'), candidate('b')], { strategy })
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('Stale earlier request')] }),
        new Message({ role: 'user', content: [block] }),
      ]

      await strategy.select(routingContext(router, { messages }))

      expect(sentState(decisionModel).latestRequest).toBe(expected)
    })

    it('bypasses the decision model for a single candidate', async () => {
      const decisionModel = new FakeDecisionModel(candidateKey(0))
      const strategy = new DecisionStrategy(decisionModel)
      const router = new ModelRouter([candidate('only')], { strategy })

      const selected = await strategy.select(routingContext(router))

      expect({ selected, asks: decisionModel.states.length }).toEqual({ selected: router.candidates[0], asks: 0 })
    })

    it('declines after an attempt without asking', async () => {
      const decisionModel = new FakeDecisionModel(candidateKey(0))
      const strategy = new DecisionStrategy(decisionModel)
      const router = new ModelRouter([candidate('a'), candidate('b')], { strategy })
      const attempts = [{ candidate: router.candidates[0]!, exception: new Error('down') }]

      const selected = await strategy.select(routingContext(router, { attempts }))

      expect({ selected, asks: decisionModel.states.length }).toEqual({ selected: undefined, asks: 0 })
    })

    it('throws when candidate evidence exceeds the budget, without asking', async () => {
      const decisionModel = new FakeDecisionModel(candidateKey(0))
      const strategy = new DecisionStrategy(decisionModel, { maxCandidateChars: 50 })
      const router = new ModelRouter(
        [new RoutingCandidate({ model: responseModel('a'), description: 'x'.repeat(100) }), candidate('b')],
        { strategy }
      )

      await expect(strategy.select(routingContext(router))).rejects.toThrow(
        'exceeding maxCandidateChars=50; trim candidate'
      )
      expect(decisionModel.states).toHaveLength(0)
    })
  })

  describe('failure handling', () => {
    it.each([
      { name: 'unknown key', answer: candidateKey(9) as Answer, reason: 'unknown_candidate_key' },
      { name: 'candidate name instead of key', answer: 'b' as Answer, reason: 'unknown_candidate_key' },
      { name: 'boolean answer', answer: true as Answer, reason: 'unknown_candidate_key' },
      { name: 'Uncertain answer', answer: new Uncertain('ambiguous') as Answer, reason: 'decision_uncertain' },
      { name: 'decision error', answer: new Error('provider-secret') as Answer, reason: 'decision_error' },
    ])('warns safely and declines on a $name', async ({ answer, reason }) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const strategy = new DecisionStrategy(new FakeDecisionModel(answer))
      const router = new ModelRouter([candidate('a'), candidate('b')], { strategy })

      const selected = await strategy.select(routingContext(router))

      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n')
      expect(selected).toBeUndefined()
      expect(logged).toContain(`strategy=<DecisionStrategy>, reason=<${reason}>`)
      expect(logged).toContain('selection declined')
      expect(logged).not.toContain('provider-secret')
    })

    it('times out, aborts the decision call, and declines', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const decisionModel = new FakeDecisionModel(candidateKey(1))
      decisionModel.delayMs = 1_000
      const strategy = new DecisionStrategy(decisionModel, { timeoutMs: 5 })
      const router = new ModelRouter([candidate('a'), candidate('b')], { strategy })

      const selected = await strategy.select(routingContext(router))

      expect({
        selected,
        aborted: decisionModel.options[0]?.signal?.aborted,
        logged: String(warn.mock.calls[0]![0]),
      }).toEqual({
        selected: undefined,
        aborted: true,
        logged: expect.stringContaining('reason=<decision_timeout>, error_type=<TimeoutError>'),
      })
    })
  })

  describe('request usage', () => {
    it('adds the decision usage to the request total even when the request limit is used up', async () => {
      const decisionModel = new FakeDecisionModel(candidateKey(1))
      decisionModel.usage = { inputTokens: 4, outputTokens: 5, totalTokens: 9 }
      const strategy = new DecisionStrategy(decisionModel)
      const router = new ModelRouter([candidate('first'), candidate('second')], { strategy })
      const invocationContext = new InvocationContextImpl({ turns: 1 })
      invocationContext.usage.turnsTaken = 5

      const selected = await strategy.select({ ...routingContext(router), invocationContext })

      expect(selected).toBe(router.candidates[1])
      expect(invocationContext.usage).toEqual({ turnsTaken: 5, inputTokens: 4, outputTokens: 5, totalTokens: 9 })
    })

    it('adds nothing when the decision model reports no usage', async () => {
      const strategy = new DecisionStrategy(new FakeDecisionModel(candidateKey(1)))
      const router = new ModelRouter([candidate('first'), candidate('second')], { strategy })
      const invocationContext = new InvocationContextImpl()

      await strategy.select({ ...routingContext(router), invocationContext })

      expect(invocationContext.usage).toEqual({ turnsTaken: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    })

    it('counts the routing decision in the agent result usage', async () => {
      const decisionModel = new FakeDecisionModel(candidateKey(1))
      decisionModel.usage = { inputTokens: 100, outputTokens: 7, totalTokens: 107 }
      const router = new ModelRouter([candidate('routine'), candidate('complex')], {
        strategy: new DecisionStrategy(decisionModel),
      })
      const agent = new Agent({ model: router, printer: false })

      const result = await agent.invoke('hello')

      expect(result.invocationContext?.usage.inputTokens).toBeGreaterThanOrEqual(100)
      expect(result.invocationContext?.usage.outputTokens).toBeGreaterThanOrEqual(7)
    })
  })

  describe('agent integration', () => {
    it('serves the chosen candidate', async () => {
      const router = new ModelRouter([candidate('routine'), candidate('complex')], {
        strategy: new DecisionStrategy(new FakeDecisionModel(candidateKey(1))),
      })
      const agent = new Agent({ model: router, printer: false })

      const result = await agent.invoke('hello')

      expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'complex' })
    })

    it('serves candidate zero when the decision fails', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const router = new ModelRouter([candidate('default'), candidate('other')], {
        strategy: new DecisionStrategy(new FakeDecisionModel(new Error('down'))),
      })
      const agent = new Agent({ model: router, retryStrategy: null, printer: false })

      const result = await agent.invoke('hello')

      expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'default' })
    })
  })

  describe('constructor', () => {
    it('rejects a non-DecisionModel', () => {
      expect(() => new DecisionStrategy({} as never)).toThrow('decisionModel must be a DecisionModel')
    })

    it('rejects an empty question', () => {
      expect(() => new DecisionStrategy(new FakeDecisionModel(candidateKey(0)), { question: '  ' })).toThrow(
        'question must be a non-empty string'
      )
    })

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects timeoutMs %s', (timeoutMs) => {
      expect(() => new DecisionStrategy(new FakeDecisionModel(candidateKey(0)), { timeoutMs })).toThrow(
        'timeoutMs must be finite and greater than zero'
      )
    })

    it.each(['maxMessageChars', 'maxAgentInstructionsChars', 'maxCandidateChars'] as const)(
      'rejects a non-positive or non-integer %s',
      (name) => {
        for (const value of [0, -1, 1.5, Number.NaN]) {
          expect(() => new DecisionStrategy(new FakeDecisionModel(candidateKey(0)), { [name]: value })).toThrow(
            `${name} must be a positive integer`
          )
        }
      }
    )
  })
})
