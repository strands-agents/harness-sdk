import { afterEach, describe, expect, it, vi } from 'vitest'

import { ContextWindowOverflowError, ModelError, ModelThrottledError } from '../../errors.js'
import { ImageBlock } from '../../types/media.js'
import { Message, TextBlock } from '../../types/messages.js'
import { DecisionModel } from '../decision-model.js'
import { DecisionsAPIDecisionModel } from '../decisions-api-decision-model.js'
import { TypeSafeDecisionModel } from '../typesafe-decision-model.js'
import { Uncertain } from '../types.js'

interface CapturedRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

interface ProviderOptions {
  apiKey?: string
  modelId?: string
  defaultMinConfidence?: number
  fetch?: typeof globalThis.fetch
}

interface ProviderCase {
  name: string
  endpoint: string
  defaultModelId: string
  providerName: string
  apiKeyEnvironmentVariable: string
  create: (options: ProviderOptions) => DecisionModel
}

const PROVIDERS: ProviderCase[] = [
  {
    name: 'TypeSafeDecisionModel',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    defaultModelId: 'jev-latest',
    providerName: 'typesafe',
    apiKeyEnvironmentVariable: 'TYPESAFE_API_KEY',
    create: (options) => new TypeSafeDecisionModel(options),
  },
  {
    name: 'DecisionsAPIDecisionModel',
    endpoint: 'https://decisionapi.net/v1/systemone',
    defaultModelId: '~typesafe/jev-latest',
    providerName: 'decisionsApi',
    apiKeyEnvironmentVariable: 'JEV_API_KEY',
    create: (options) => new DecisionsAPIDecisionModel(options),
  },
]

function responseBody(answers: Record<string, unknown>, usage: unknown = { input_tokens: 12, output_tokens: 3 }) {
  return { model: 'resolved-model', answers, usage }
}

function fakeFetch(
  payload: unknown,
  options: { status?: number; captured?: CapturedRequest[] } = {}
): typeof globalThis.fetch {
  const status = options.status ?? 200
  return vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    options.captured?.push({ url: String(input), headers, body })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof globalThis.fetch
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each(PROVIDERS)('$name', ({ create, endpoint, defaultModelId, providerName, apiKeyEnvironmentVariable }) => {
  describe('ask', () => {
    it('maps questions and returns typed answers with confidence metadata', async () => {
      const captured: CapturedRequest[] = []
      const fetch = fakeFetch(
        responseBody({
          urgent: { type: 'noul', noul: 0.9 },
          department: {
            type: 'choice',
            choice: 'billing',
            probabilities: { billing: 0.7, support: 0.2, sales: 0.1 },
            confidence: 0.55,
          },
        }),
        { captured }
      )
      const decision = create({ apiKey: 'test-key', fetch })

      const result = await decision.ask('Refund this today', {
        urgent: { question: 'Is this urgent?', choices: 'boolean' },
        department: {
          question: 'Which team should handle this?',
          choices: ['billing', 'support', 'sales'],
        },
      })

      expect(captured).toEqual([
        {
          url: endpoint,
          headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
          body: {
            state: 'Refund this today',
            model: defaultModelId,
            questions: {
              urgent: { type: 'noul', instructions: 'Is this urgent?' },
              department: {
                type: 'choice',
                instructions: 'Which team should handle this?',
                criteria: { billing: null, support: null, sales: null },
              },
            },
          },
        },
      ])
      expect(result).toEqual({
        answers: { urgent: true, department: 'billing' },
        usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        metadata: {
          latencyMs: expect.any(Number),
          providerName,
          modelId: 'resolved-model',
          probabilities: {
            urgent: { true: 0.9, false: 0.09999999999999998 },
            department: { billing: 0.7, support: 0.2, sales: 0.1 },
          },
          confidence: { urgent: 0.8, department: 0.55 },
        },
      })
    })

    it('applies the provider-wide default minimum confidence', async () => {
      const decision = create({
        apiKey: 'test-key',
        fetch: fakeFetch(responseBody({ q: { type: 'noul', noul: 0.625 } })),
      })

      const result = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

      expect(result.answers).toEqual({ q: new Uncertain() })
      expect(result.metadata.confidence).toEqual({ q: 0.25 })
    })

    it('applies question override, provider default, and disabled uncertainty in precedence order', async () => {
      const fetch = fakeFetch(
        responseBody({
          providerDefault: { type: 'noul', noul: 0.8 },
          questionOverride: { type: 'noul', noul: 0.8 },
          disabled: { type: 'noul', noul: 0.5 },
        })
      )
      const decision = create({ apiKey: 'test-key', defaultMinConfidence: 0.7, fetch })

      const result = await decision.ask('state', {
        providerDefault: { question: 'default?', choices: 'boolean' },
        questionOverride: {
          question: 'override?',
          choices: 'boolean',
          uncertainty: { minConfidence: 0.5 },
        },
        disabled: { question: 'forced?', choices: 'boolean', uncertainty: false },
      })

      expect(result.answers).toEqual({
        providerDefault: new Uncertain(),
        questionOverride: true,
        disabled: true,
      })
      expect(result.metadata.confidence).toEqual({
        providerDefault: 0.6000000000000001,
        questionOverride: 0.6000000000000001,
        disabled: 0,
      })
    })

    it('thresholds Choice answers on provider confidence while allowing per-question overrides', async () => {
      const fetch = fakeFetch(
        responseBody({
          providerDefault: {
            type: 'choice',
            choice: 'a',
            probabilities: { a: 0.9, b: 0.1 },
            confidence: 0.65,
          },
          questionOverride: {
            type: 'choice',
            choice: 'a',
            probabilities: { a: 0.9, b: 0.1 },
            confidence: 0.65,
          },
        })
      )
      const decision = create({ apiKey: 'test-key', defaultMinConfidence: 0.7, fetch })

      const result = await decision.ask('state', {
        providerDefault: { question: 'pick?', choices: ['a', 'b'] },
        questionOverride: {
          question: 'pick?',
          choices: ['a', 'b'],
          uncertainty: { minConfidence: 0.6 },
        },
      })

      expect(result.answers).toEqual({ providerDefault: new Uncertain(), questionOverride: 'a' })
      expect(result.metadata.confidence).toEqual({ providerDefault: 0.65, questionOverride: 0.65 })
    })

    it('projects messages without internal tracking ids or metadata', async () => {
      const captured: CapturedRequest[] = []
      const fetch = fakeFetch(responseBody({ q: { type: 'noul', noul: 1 } }), { captured })
      const decision = create({ apiKey: 'test-key', fetch })
      const message = new Message({
        role: 'user',
        content: [new TextBlock('hello')],
        trackingId: 'internal-id',
        metadata: { custom: { private: 'framework-value' } },
      })

      await decision.ask([message], { q: { question: 'Greeting?', choices: 'boolean' } })

      expect(captured[0]?.body['state']).toEqual([{ role: 'user', content: [{ text: 'hello' }] }])
    })

    it('rejects binary content blocks before sending', async () => {
      const fetch = fakeFetch(responseBody({}))
      const decision = create({ apiKey: 'test-key', fetch })
      const image = new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } })

      await expect(decision.ask([image], { q: { question: 'What is shown?', choices: 'boolean' } })).rejects.toThrow(
        /do not support binary ContentBlock state/
      )
      expect(fetch).not.toHaveBeenCalled()
    })

    it('honors an explicit model id', async () => {
      const captured: CapturedRequest[] = []
      const fetch = fakeFetch(responseBody({ q: { type: 'noul', noul: 1 } }), { captured })
      const decision = create({ apiKey: 'test-key', modelId: 'pinned-model', fetch })

      await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

      expect(captured[0]?.body['model']).toBe('pinned-model')
    })

    it.each([429, 529])('maps HTTP %s to ModelThrottledError with the HTTP failure as cause', async (status) => {
      const decision = create({
        apiKey: 'test-key',
        fetch: fakeFetch({ error: 'retry later' }, { status }),
      })

      const error = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } }).then(
        () => undefined,
        (caught: unknown) => caught
      )

      expect(error).toBeInstanceOf(ModelThrottledError)
      expect((error as Error).cause).toBeDefined()
    })

    it('wraps transport failures as ModelError with the original cause', async () => {
      const fetch = vi.fn(async (): Promise<Response> => {
        throw new Error('offline')
      }) as typeof globalThis.fetch
      const decision = create({ apiKey: 'test-key', fetch })

      const error = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } }).then(
        () => undefined,
        (caught: unknown) => caught
      )

      expect(error).toBeInstanceOf(ModelError)
      expect((error as Error).cause).toEqual(new Error('offline'))
    })

    it('omits usage when the provider returns null token counters', async () => {
      const decision = create({
        apiKey: 'test-key',
        fetch: fakeFetch(responseBody({ q: { type: 'noul', noul: 1 } }, { input_tokens: null, output_tokens: null })),
      })

      const result = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

      expect(result.usage).toBeUndefined()
    })

    it('rejects an invalid response model id', async () => {
      const decision = create({
        apiKey: 'test-key',
        fetch: fakeFetch({ model: '', answers: { q: { type: 'noul', noul: 1 } } }),
      })

      await expect(decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })).rejects.toThrow(
        /model must be a non-empty string/
      )
    })

    it('rejects a Choice answer whose selection is not the most probable', async () => {
      const decision = create({
        apiKey: 'test-key',
        fetch: fakeFetch(
          responseBody({ q: { type: 'choice', choice: 'a', probabilities: { a: 0.4, b: 0.6 }, confidence: 0.2 } })
        ),
      })

      await expect(decision.ask('state', { q: { question: 'pick?', choices: ['a', 'b'] } })).rejects.toThrow(
        /must have the highest probability/
      )
    })

    it('rejects malformed probability distributions', async () => {
      const decision = create({
        apiKey: 'test-key',
        fetch: fakeFetch(
          responseBody({
            q: { type: 'choice', choice: 'a', probabilities: { a: 0.4, b: 0.4 }, confidence: 0.1 },
          })
        ),
      })

      await expect(decision.ask('state', { q: { question: 'pick?', choices: ['a', 'b'] } })).rejects.toThrow(
        /must sum to 1/
      )
    })

    it('rejects more than 255 Choice options before sending', async () => {
      const fetch = fakeFetch(responseBody({}))
      const decision = create({ apiKey: 'test-key', fetch })
      const choices = Array.from({ length: 256 }, (_, index) => `choice-${index}`)

      await expect(decision.ask('state', { q: { question: 'pick?', choices } })).rejects.toThrow(/at most 255 choices/)
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('construction', () => {
    it('requires its provider-specific API key', () => {
      vi.stubEnv(apiKeyEnvironmentVariable, '')

      expect(() => create({})).toThrow(new RegExp(apiKeyEnvironmentVariable))
    })

    it('refuses to expose its API key in a browser runtime', () => {
      vi.stubGlobal('window', {})

      expect(() => create({ apiKey: 'test-key' })).toThrow(/cannot run in a browser/)
    })

    it('rejects an invalid provider default threshold', () => {
      expect(() => create({ apiKey: 'test-key', defaultMinConfidence: 1.1 })).toThrow(
        /defaultMinConfidence must be in \[0.0, 1.0\]/
      )
    })
  })
})

describe('TypeSafeDecisionModel construction', () => {
  it('reads TYPESAFE_API_KEY', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'typesafe-env-key')
    const captured: CapturedRequest[] = []
    const decision = new TypeSafeDecisionModel({
      fetch: fakeFetch(responseBody({ q: { type: 'noul', noul: 1 } }), { captured }),
    })

    await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

    expect(captured[0]?.headers['authorization']).toBe('Bearer typesafe-env-key')
  })
})

describe('DecisionsAPIDecisionModel', () => {
  describe('construction', () => {
    it('reads JEV_API_KEY', async () => {
      vi.stubEnv('JEV_API_KEY', 'decisions-env-key')
      const captured: CapturedRequest[] = []
      const decision = new DecisionsAPIDecisionModel({
        fetch: fakeFetch(responseBody({ q: { type: 'noul', noul: 1 } }), { captured }),
      })

      await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

      expect(captured[0]?.headers['authorization']).toBe('Bearer decisions-env-key')
    })
  })

  describe('ask', () => {
    it('enforces the provider question-count limit before sending', async () => {
      const fetch = fakeFetch(responseBody({}))
      const decision = new DecisionsAPIDecisionModel({ apiKey: 'test-key', fetch })
      const questions = Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [
          `q${index}`,
          { question: `question ${index}?`, choices: 'boolean' as const },
        ])
      )

      await expect(decision.ask('state', questions)).rejects.toThrow(/at most 8 questions/)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('enforces the provider request-body limit before sending', async () => {
      const fetch = fakeFetch(responseBody({}))
      const decision = new DecisionsAPIDecisionModel({ apiKey: 'test-key', fetch })

      const error = await decision.ask('x'.repeat(33 * 1024), { q: { question: 'ok?', choices: 'boolean' } }).then(
        () => undefined,
        (caught: unknown) => caught
      )

      expect(error).toBeInstanceOf(ContextWindowOverflowError)
      expect(fetch).not.toHaveBeenCalled()
    })
  })
})
