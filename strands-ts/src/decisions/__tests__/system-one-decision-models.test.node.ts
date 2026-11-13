import { afterEach, describe, expect, it, vi } from 'vitest'

import { ContextWindowOverflowError, ModelError, ModelThrottledError } from '../../errors.js'
import { ImageBlock } from '../../types/media.js'
import { Message, TextBlock } from '../../types/messages.js'
import { DecisionModel } from '../decision-model.js'
import { DecisionsAPIDecisionModel } from '../decisions-api-decision-model.js'
import { GeminiDecisionModel } from '../gemini-decision-model.js'
import { OpenAIDecisionModel } from '../openai-decision-model.js'
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

    it('passes the cancel signal to fetch and sets none without one', async () => {
      const fetch = fakeFetch(responseBody({ q: { type: 'noul', noul: 1 } }))
      const decision = create({ apiKey: 'test-key', fetch })
      const controller = new AbortController()

      await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } }, { cancelSignal: controller.signal })
      await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

      const inits = vi.mocked(fetch).mock.calls.map(([, init]) => init)
      expect(inits[0]?.signal).toBe(controller.signal)
      expect(inits[1]).not.toHaveProperty('signal')
    })

    it('rejects with ModelError when the cancel signal aborts the request', async () => {
      const controller = new AbortController()
      const fetch = vi.fn(
        (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          })
      ) as typeof globalThis.fetch
      const decision = create({ apiKey: 'test-key', fetch })

      const pending = decision.ask(
        'state',
        { q: { question: 'ok?', choices: 'boolean' } },
        { cancelSignal: controller.signal }
      )
      controller.abort()

      await expect(pending).rejects.toBeInstanceOf(ModelError)
    })

    it.each([429, 503, 529])('maps HTTP %s to ModelThrottledError with the HTTP failure as cause', async (status) => {
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

    it('sends an oversized request and maps the server HTTP 413 to ContextWindowOverflowError', async () => {
      const fetch = fakeFetch({ error: 'request body too large' }, { status: 413 })
      const decision = create({ apiKey: 'test-key', fetch })

      const error = await decision.ask('x'.repeat(64 * 1024), { q: { question: 'ok?', choices: 'boolean' } }).then(
        () => undefined,
        (caught: unknown) => caught
      )

      expect(error).toBeInstanceOf(ContextWindowOverflowError)
      expect(fetch).toHaveBeenCalledTimes(1)
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

    it('accepts Choice probabilities rounded to 4 decimals', async () => {
      // Live strands-decider output: ten probabilities rounded to 4 decimals sum to 1.0001.
      const probabilities = {
        payments: 0.1056,
        fraud: 0.0067,
        onboarding: 0.0053,
        tax: 0.0032,
        identity: 0.0035,
        payouts: 0.8215,
        disputes: 0.0089,
        refunds: 0.0076,
        pricing: 0.0031,
        support: 0.0347,
      }
      const decision = create({
        apiKey: 'test-key',
        fetch: fakeFetch(responseBody({ q: { type: 'choice', choice: 'payouts', probabilities, confidence: 0.8017 } })),
      })

      const result = await decision.ask('state', { q: { question: 'pick?', choices: Object.keys(probabilities) } })

      expect(result.answers).toEqual({ q: 'payouts' })
    })

    it.each([
      // Rounded to 4 decimals, but the sum is past the rounding bound of 2 * 5e-5.
      { a: 0.5001, b: 0.5001 },
      // Within the rounding bound, but rounding can't produce values off the 4-decimal grid.
      { a: 0.50003, b: 0.50003 },
    ])('rejects Choice probabilities %o that sum just past the bound', async (probabilities) => {
      const decision = create({
        apiKey: 'test-key',
        fetch: fakeFetch(responseBody({ q: { type: 'choice', choice: 'a', probabilities, confidence: 0 } })),
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
  })
})

describe('GeminiDecisionModel', () => {
  it('sends the Gemini request shape and maps a response without a model id', async () => {
    const captured: CapturedRequest[] = []
    const fetch = fakeFetch(
      {
        answers: {
          urgent: { type: 'noul', noul: 0.9, confidence: 0.9 },
          department: {
            type: 'choice',
            choice: 'billing',
            probabilities: { billing: 0.7, support: 0.3 },
            confidence: 0.7,
          },
        },
        usage: { total_input_tokens: 12, total_output_tokens: 0, total_tokens: 12 },
      },
      { captured }
    )
    const decision = new GeminiDecisionModel({ apiKey: 'test-key', fetch })

    const result = await decision.ask('Refund this today', {
      urgent: { question: 'Is this urgent?', choices: 'boolean' },
      department: { question: 'Which team should handle this?', choices: ['billing', 'support'] },
    })

    expect(captured).toEqual([
      {
        url: 'https://generativelanguage.googleapis.com/v1beta/decisions',
        headers: { 'x-goog-api-key': 'test-key', 'content-type': 'application/json' },
        body: {
          model: 'gemini-decision-1',
          input: 'Refund this today',
          questions: {
            urgent: { type: 'noul', instructions: 'Is this urgent?' },
            department: {
              type: 'choice',
              instructions: 'Which team should handle this?',
              criteria: { billing: '', support: '' },
            },
          },
        },
      },
    ])
    expect(result).toEqual({
      answers: { urgent: true, department: 'billing' },
      usage: { inputTokens: 12, outputTokens: 0, totalTokens: 12 },
      metadata: {
        latencyMs: expect.any(Number),
        providerName: 'gemini',
        modelId: 'gemini-decision-1',
        probabilities: {
          urgent: { true: 0.9, false: 0.09999999999999998 },
          department: { billing: 0.7, support: 0.3 },
        },
        confidence: { urgent: 0.9, department: 0.7 },
      },
    })
  })

  it('reports Gemini Noul confidence but thresholds on the normalized scale', async () => {
    const fetch = fakeFetch({ answers: { q: { type: 'noul', noul: 0.74, confidence: 0.74 } } })
    const decision = new GeminiDecisionModel({ apiKey: 'test-key', fetch })

    const result = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

    expect(result.answers.q).toEqual(new Uncertain())
    expect(result.metadata.confidence).toEqual({ q: 0.74 })
  })

  it('sends message state as JSON text input', async () => {
    const captured: CapturedRequest[] = []
    const fetch = fakeFetch({ answers: { q: { type: 'noul', noul: 0.99, confidence: 0.99 } } }, { captured })
    const decision = new GeminiDecisionModel({ apiKey: 'test-key', fetch })

    await decision.ask([new Message({ role: 'user', content: [new TextBlock('hello')] })], {
      q: { question: 'Greeting?', choices: 'boolean' },
    })

    expect(captured[0]?.body['input']).toBe('[{"role":"user","content":[{"text":"hello"}]}]')
  })

  it('reads GEMINI_API_KEY', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'gemini-env-key')
    const captured: CapturedRequest[] = []
    const decision = new GeminiDecisionModel({
      fetch: fakeFetch({ answers: { q: { type: 'noul', noul: 0.99, confidence: 0.99 } } }, { captured }),
    })

    await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

    expect(captured[0]?.headers['x-goog-api-key']).toBe('gemini-env-key')
  })

  it('maps Gemini safety blocks to ModelError and throttling to ModelThrottledError', async () => {
    const question = { q: { question: 'ok?', choices: 'boolean' } } as const
    const blocked = new GeminiDecisionModel({
      apiKey: 'test-key',
      fetch: fakeFetch({ error: { code: 'safety', message: 'Request blocked' } }, { status: 400 }),
    })
    const throttled = new GeminiDecisionModel({
      apiKey: 'test-key',
      fetch: fakeFetch({ error: { code: 429, message: 'Resource exhausted' } }, { status: 429 }),
    })

    const blockedError = await blocked.ask('state', question).catch((error: unknown) => error)
    expect(blockedError).toBeInstanceOf(ModelError)
    expect(blockedError).not.toBeInstanceOf(ModelThrottledError)
    expect((blockedError as Error).message).toMatch(/HTTP 400: Request blocked/)
    await expect(throttled.ask('state', question)).rejects.toThrow(ModelThrottledError)
  })

  it('rejects a Noul answer without the Gemini confidence', async () => {
    const fetch = fakeFetch({ answers: { q: { type: 'noul', noul: 0.9 } } })
    const decision = new GeminiDecisionModel({ apiKey: 'test-key', fetch })

    await expect(decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })).rejects.toThrow(
      /confidence for question id=<q>/
    )
  })

  it('caps the normalized Noul confidence at 0.98 for the threshold', async () => {
    const fetch = fakeFetch({ answers: { q: { type: 'noul', noul: 0.99, confidence: 0.99 } } })
    const decision = new GeminiDecisionModel({ apiKey: 'test-key', fetch })

    const passes = await decision.ask('state', {
      q: { question: 'ok?', choices: 'boolean', uncertainty: { minConfidence: 0.98 } },
    })
    const blocked = await decision.ask('state', {
      q: { question: 'ok?', choices: 'boolean', uncertainty: { minConfidence: 0.99 } },
    })

    expect(passes.answers.q).toBe(true)
    expect(blocked.answers.q).toEqual(new Uncertain())
  })

  it('rejects binary content blocks before sending', async () => {
    const fetch = fakeFetch({ answers: {} })
    const decision = new GeminiDecisionModel({ apiKey: 'test-key', fetch })
    const image = new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } })

    await expect(decision.ask([image], { q: { question: 'What is shown?', choices: 'boolean' } })).rejects.toThrow(
      /do not support binary ContentBlock state/
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('OpenAIDecisionModel', () => {
  it('sends the OpenAI request shape and maps its answer array', async () => {
    const captured: CapturedRequest[] = []
    const fetch = fakeFetch(
      {
        answers: [
          { type: 'predicate', name: 'urgent', probability: 0.9 },
          {
            type: 'choice',
            name: 'department',
            choice: 'billing',
            probabilities: [
              { value: 'billing', probability: 0.7 },
              { value: 'support', probability: 0.3 },
            ],
            confidence: 0.7,
          },
        ],
        usage: { input_tokens: 12, output_tokens: 0, total_tokens: 12 },
      },
      { captured }
    )
    const decision = new OpenAIDecisionModel({ apiKey: 'test-key', fetch })

    const result = await decision.ask('Refund this today', {
      urgent: { question: 'Is this urgent?', choices: 'boolean' },
      department: { question: 'Which team should handle this?', choices: ['billing', 'support'] },
    })

    expect(captured).toEqual([
      {
        url: 'https://api.openai.com/v1/decisions',
        headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
        body: {
          model: 'gpt-6-luna',
          input: 'Refund this today',
          questions: [
            { name: 'urgent', type: 'predicate', instructions: 'Is this urgent?' },
            {
              name: 'department',
              type: 'choice',
              instructions: 'Which team should handle this?',
              choices: [{ value: 'billing' }, { value: 'support' }],
            },
          ],
        },
      },
    ])
    expect(result).toEqual({
      answers: { urgent: true, department: 'billing' },
      usage: { inputTokens: 12, outputTokens: 0, totalTokens: 12 },
      metadata: {
        latencyMs: expect.any(Number),
        providerName: 'openai',
        modelId: 'gpt-6-luna',
        probabilities: {
          urgent: { true: 0.9, false: 0.09999999999999998 },
          department: { billing: 0.7, support: 0.3 },
        },
        confidence: { urgent: 0.8, department: 0.7 },
      },
    })
  })

  it('reports a refused question as Uncertain and keeps the answers it did return', async () => {
    const fetch = fakeFetch({
      answers: [
        { type: 'refusal', name: 'refused' },
        { type: 'predicate', name: 'answered', probability: 0.99 },
      ],
    })
    const decision = new OpenAIDecisionModel({ apiKey: 'test-key', fetch })

    const result = await decision.ask('state', {
      refused: { question: 'ok?', choices: 'boolean' },
      answered: { question: 'also ok?', choices: 'boolean' },
    })

    expect(result.answers).toEqual({ refused: new Uncertain('openai declined to answer'), answered: true })
    expect(result.metadata.probabilities).toEqual({
      refused: {},
      answered: { true: 0.99, false: 0.010000000000000009 },
    })
  })

  it('throws when a refused question disabled uncertainty', async () => {
    const fetch = fakeFetch({ answers: [{ type: 'refusal', name: 'q' }] })
    const decision = new OpenAIDecisionModel({ apiKey: 'test-key', fetch })

    await expect(
      decision.ask('state', { q: { question: 'ok?', choices: 'boolean', uncertainty: false } })
    ).rejects.toThrow(/question id=<q> \| decision provider declined to answer/)
  })

  it('ignores an answer naming a question that was not asked', async () => {
    const fetch = fakeFetch({
      answers: [
        { type: 'refusal', name: 'never-asked' },
        { type: 'predicate', name: 'q', probability: 0.99 },
      ],
    })
    const decision = new OpenAIDecisionModel({ apiKey: 'test-key', fetch })

    const result = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

    expect(result.answers).toEqual({ q: true })
  })

  it('reads OPENAI_API_KEY', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'openai-env-key')
    const captured: CapturedRequest[] = []
    const decision = new OpenAIDecisionModel({
      fetch: fakeFetch(
        { model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'q', probability: 0.99 }] },
        { captured }
      ),
    })

    await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

    expect(captured[0]?.headers['authorization']).toBe('Bearer openai-env-key')
  })
})
