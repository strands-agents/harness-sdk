import { afterEach, describe, expect, it, vi } from 'vitest'

import { InvocationContextImpl } from '../../agent/invocation-context.js'
import { ContextWindowOverflowError, ModelError, ModelThrottledError } from '../../errors.js'
import { DocumentBlock, ImageBlock, VideoBlock } from '../../types/media.js'
import { GuardContentBlock, JsonBlock, Message, TextBlock, ToolResultBlock } from '../../types/messages.js'
import { DecisionModel } from '../decision-model.js'
import { DecisionsAPIDecisionModel } from '../decisions-api-decision-model.js'
import { GeminiDecisionModel } from '../gemini-decision-model.js'
import { OpenAIDecisionModel } from '../openai-decision-model.js'
import { TypeSafeDecisionModel } from '../typesafe-decision-model.js'
import { Uncertain } from '../types.js'
import type { Question } from '../types.js'

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

function envelope(result: unknown) {
  return { code: 0, message: 'ok', data: { result, creditsUsed: 1 } }
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
    it.each([1, 0.5])('preserves prototype-named question ids with noul probability %s', async (noul) => {
      const ids = ['__proto__', 'constructor', 'toString']
      const questions = Object.fromEntries(
        ids.map((id) => [id, { question: 'ok?', choices: 'boolean' } satisfies Question])
      )
      const decision = create({
        apiKey: 'test-key',
        fetch: fakeFetch(responseBody(Object.fromEntries(ids.map((id) => [id, { type: 'noul', noul }])))),
      })

      const result = await decision.ask('state', questions)

      expect(result).toEqual({
        answers: Object.fromEntries(ids.map((id) => [id, noul === 1 ? true : new Uncertain()])),
        usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        metadata: {
          latencyMs: expect.any(Number),
          providerName,
          modelId: 'resolved-model',
          probabilities: Object.fromEntries(ids.map((id) => [id, { true: noul, false: 1 - noul }])),
          confidence: Object.fromEntries(ids.map((id) => [id, Math.abs(2 * noul - 1)])),
        },
      })
      for (const map of [result.answers, result.metadata.probabilities, result.metadata.confidence]) {
        expect(Object.keys(map!)).toEqual(ids)
        expect(Object.getPrototypeOf(map)).toBe(Object.prototype)
      }
    })

    it.each(['__proto__', 'constructor', 'toString'])('rejects a missing own answer for %s', async (id) => {
      const decision = create({ apiKey: 'test-key', fetch: fakeFetch(responseBody({})) })
      const questions = Object.fromEntries([[id, { question: 'ok?', choices: 'boolean' } satisfies Question]])

      await expect(decision.ask('state', questions)).rejects.toThrow(`omitted answer for question id=<${id}>`)
    })

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

    it.each([
      new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } }),
      new VideoBlock({ format: 'mp4', source: { bytes: new Uint8Array([1, 2, 3]) } }),
      new DocumentBlock({ format: 'pdf', name: 'fixture', source: { bytes: new Uint8Array([1, 2, 3]) } }),
    ])('rejects a binary $type inside a tool result before sending', async (media) => {
      const fetch = fakeFetch(responseBody({}))
      const decision = create({ apiKey: 'test-key', fetch })
      const toolResult = new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [media] })

      for (const state of [[toolResult], [new Message({ role: 'user', content: [toolResult] })]]) {
        await expect(decision.ask(state, { q: { question: 'ok?', choices: 'boolean' } })).rejects.toThrow(
          /do not support binary ContentBlock state/
        )
      }
      expect(fetch).not.toHaveBeenCalled()
    })

    it('rejects byte-backed guard content before sending', async () => {
      const fetch = fakeFetch(responseBody({}))
      const decision = create({ apiKey: 'test-key', fetch })
      const guard = new GuardContentBlock({
        image: { format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } },
      })

      await expect(decision.ask([guard], { q: { question: 'ok?', choices: 'boolean' } })).rejects.toThrow(
        /do not support binary ContentBlock state/
      )
      expect(fetch).not.toHaveBeenCalled()
    })

    it('preserves JSON fields named bytes and text in tool results', async () => {
      const captured: CapturedRequest[] = []
      const fetch = fakeFetch(responseBody({ q: { type: 'noul', noul: 1 } }), { captured })
      const decision = create({ apiKey: 'test-key', fetch })
      const toolResult = new ToolResultBlock({
        toolUseId: 'tool-1',
        status: 'success',
        content: [new JsonBlock({ json: { bytes: [1, 2, 3] } }), new TextBlock('hello')],
      })

      await decision.ask([toolResult], { q: { question: 'ok?', choices: 'boolean' } })

      expect(captured[0]?.body['state']).toEqual([
        {
          toolResult: {
            toolUseId: 'tool-1',
            status: 'success',
            content: [{ json: { bytes: [1, 2, 3] } }, { text: 'hello' }],
          },
        },
      ])
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
      expect((error as Error).cause).toMatchObject({ status: 413, body: { error: 'request body too large' } })
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it.each([
      {
        status: 400,
        errorType: 'max_tokens_exceeded',
        expectedClass: { typesafe: ContextWindowOverflowError, decisionsApi: ModelError },
      },
      { status: 400, errorType: 'invalid_request', expectedClass: { typesafe: ModelError, decisionsApi: ModelError } },
      {
        status: 500,
        errorType: 'max_tokens_exceeded',
        expectedClass: { typesafe: ModelError, decisionsApi: ModelError },
      },
    ])('scopes vendor context overflow for HTTP $status/$errorType', async ({ status, errorType, expectedClass }) => {
      const body = { detail: { error_type: errorType } }
      const decision = create({ apiKey: 'test-key', fetch: fakeFetch(body, { status }) })
      const error = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } }).then(
        () => undefined,
        (caught: unknown) => caught
      )

      expect((error as Error).constructor).toBe(expectedClass[providerName as 'typesafe' | 'decisionsApi'])
      expect((error as Error).message).toBe(`${providerName} decision request failed with HTTP ${status}: ${errorType}`)
      expect((error as Error).cause).toMatchObject({ status, body })
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

    it.each([
      '{"input_tokens":1e999,"output_tokens":3}',
      '{"input_tokens":12,"output_tokens":1e999}',
      '{"input_tokens":-1e999,"output_tokens":3}',
      '{"input_tokens":1e308,"output_tokens":1e308}',
      '{"input_tokens":12.5,"output_tokens":3}',
    ])('omits non-integer usage %s without changing invocation counters', async (usage) => {
      const raw = `{"model":"resolved-model","answers":{"q":{"type":"noul","noul":1}},"usage":${usage}}`
      const fetch = vi.fn(async (): Promise<Response> => new Response(raw)) as typeof globalThis.fetch
      const decision = create({ apiKey: 'test-key', fetch })
      const invocationContext = new InvocationContextImpl()
      invocationContext.recordUsage({ inputTokens: 5, outputTokens: 2, totalTokens: 7 })
      const originalUsage = { ...invocationContext.usage }

      const result = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } }, { invocationContext })

      expect(result.answers).toEqual({ q: true })
      expect(result.usage).toBeUndefined()
      expect(invocationContext.usage).toEqual(originalUsage)
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

    it('rejects a flat response that omits the model', async () => {
      const decision = create({
        apiKey: 'test-key',
        fetch: fakeFetch({ answers: { q: { type: 'noul', noul: 1 } } }),
      })

      await expect(decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })).rejects.toThrow(
        /model must be a non-empty string/
      )
    })

    it('rejects a server answer typed as refused instead of treating it as Uncertain', async () => {
      const decision = create({
        apiKey: 'test-key',
        fetch: fakeFetch(responseBody({ q: { type: 'refused', reason: 'policy' } })),
      })

      await expect(decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })).rejects.toThrow(
        /must have type 'noul'/
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

    it('reads the enveloped decisionapi.net response and reports the requested model', async () => {
      const decision = new DecisionsAPIDecisionModel({
        apiKey: 'test-key',
        fetch: fakeFetch({
          code: 0,
          message: 'ok',
          data: {
            result: {
              answers: { q: { type: 'noul', noul: 0.99 } },
              usage: { input_tokens: 281, output_tokens: 23 },
              elapsedMs: 1879,
            },
            creditsUsed: 1,
          },
        }),
      })

      const result = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

      expect(result).toEqual({
        answers: { q: true },
        usage: { inputTokens: 281, outputTokens: 23, totalTokens: 304 },
        metadata: {
          latencyMs: expect.any(Number),
          providerName: 'decisionsApi',
          modelId: '~typesafe/jev-latest',
          probabilities: { q: { true: 0.99, false: expect.closeTo(0.01) } },
          confidence: { q: expect.closeTo(0.98) },
        },
      })
    })

    it('reports a non-default requested model for an enveloped response', async () => {
      const decision = new DecisionsAPIDecisionModel({
        apiKey: 'test-key',
        modelId: 'pinned-model',
        fetch: fakeFetch(envelope({ answers: { q: { type: 'noul', noul: 0.99 } } })),
      })

      const result = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

      expect(result.metadata.modelId).toBe('pinned-model')
    })

    it('reports the model named by an enveloped result', async () => {
      const decision = new DecisionsAPIDecisionModel({
        apiKey: 'test-key',
        modelId: 'pinned-model',
        fetch: fakeFetch(envelope({ model: 'served-model', answers: { q: { type: 'noul', noul: 0.99 } } })),
      })

      const result = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

      expect(result.metadata.modelId).toBe('served-model')
    })

    it('leaves TypeSafeDecisionModel rejecting the envelope', async () => {
      const decision = new TypeSafeDecisionModel({
        apiKey: 'test-key',
        fetch: fakeFetch(envelope({ answers: { q: { type: 'noul', noul: 0.99 } } })),
      })

      await expect(decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })).rejects.toThrow(
        /model must be a non-empty string/
      )
    })

    it.each([-1, false])('rejects an enveloped error body with code %s sent with HTTP 200', async (code) => {
      const decision = new DecisionsAPIDecisionModel({
        apiKey: 'test-key',
        fetch: fakeFetch({ code, message: 'request rejected' }),
      })

      await expect(decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })).rejects.toThrow(
        `error code ${String(code)}: request rejected`
      )
    })

    it.each([
      { payload: { code: 0 }, message: 'data must be an object' },
      { payload: { code: 0, data: { result: [] } }, message: 'result must be an object' },
    ])('rejects the malformed envelope $payload', async ({ payload, message }) => {
      const decision = new DecisionsAPIDecisionModel({ apiKey: 'test-key', fetch: fakeFetch(payload) })

      await expect(decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })).rejects.toThrow(message)
    })

    it('maps an enveloped HTTP 401 to an HTTP failure rather than an envelope error', async () => {
      const decision = new DecisionsAPIDecisionModel({
        apiKey: 'test-key',
        fetch: fakeFetch({ code: -1, message: 'Invalid API key.' }, { status: 401 }),
      })

      const error = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } }).then(
        () => undefined,
        (caught: unknown) => caught
      )

      expect(error).toBeInstanceOf(ModelError)
      expect((error as Error).message).toMatch(/HTTP 401: Invalid API key\./)
      expect((error as Error).cause).toBeDefined()
    })

    it.each([429, 503, 529])('maps an enveloped HTTP %s to ModelThrottledError', async (status) => {
      const decision = new DecisionsAPIDecisionModel({
        apiKey: 'test-key',
        fetch: fakeFetch({ code: -1, message: 'retry later' }, { status }),
      })

      await expect(decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })).rejects.toBeInstanceOf(
        ModelThrottledError
      )
    })

    it('maps an enveloped HTTP 413 to ContextWindowOverflowError', async () => {
      const decision = new DecisionsAPIDecisionModel({
        apiKey: 'test-key',
        fetch: fakeFetch({ code: -1, message: 'request too large' }, { status: 413 }),
      })

      await expect(decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })).rejects.toBeInstanceOf(
        ContextWindowOverflowError
      )
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
            probabilities: { billing: 0.8, support: 0.2 },
            confidence: 0.8,
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
          department: { billing: 0.8, support: 0.2 },
        },
        confidence: { urgent: 0.9, department: 0.8 },
      },
    })
  })

  it('thresholds on Gemini confidence with 0.75 for Noul and 0.5 for Choice by default', async () => {
    const noul = (p: number): GeminiDecisionModel =>
      new GeminiDecisionModel({
        apiKey: 'test-key',
        fetch: fakeFetch({ answers: { q: { type: 'noul', noul: p, confidence: Math.max(p, 1 - p) } } }),
      })
    const choiceFetch = fakeFetch({
      answers: {
        q: { type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.1, c: 0.1, d: 0.1 }, confidence: 0.7 },
      },
    })

    const unsure = await noul(0.74).ask('state', { q: { question: 'ok?', choices: 'boolean' } })
    const sure = await noul(0.99).ask('state', {
      q: { question: 'ok?', choices: 'boolean', uncertainty: { minConfidence: 0.99 } },
    })
    const choice = await new GeminiDecisionModel({ apiKey: 'test-key', fetch: choiceFetch }).ask('state', {
      q: { question: 'Which?', choices: ['a', 'b', 'c', 'd'] },
    })

    expect(unsure.answers.q).toEqual(new Uncertain())
    expect(unsure.metadata.confidence).toEqual({ q: 0.74 })
    expect(sure.answers.q).toBe(true)
    expect(choice.answers.q).toBe('a')
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

  it('accepts Choice probabilities rounded by Gemini but rejects a malformed distribution', async () => {
    const askChoice = (probabilities: Record<string, number>): Promise<unknown> => {
      const choices = Object.keys(probabilities)
      const confidence = Math.max(...Object.values(probabilities))
      const fetch = fakeFetch({
        answers: { q: { type: 'choice', choice: choices[0], probabilities, confidence } },
      })
      return new GeminiDecisionModel({ apiKey: 'test-key', fetch })
        .ask('state', { q: { question: 'Which?', choices } })
        .then((result) => result.answers.q)
    }

    expect(await askChoice({ billing: 0.99, shipping: 0.004, other: 0.003, technical: 0.002 })).toBe('billing')
    // Near-uniform answers round furthest from 1 and come back Uncertain rather than throwing.
    expect(await askChoice({ a: 0.33, b: 0.33, c: 0.33 })).toEqual(new Uncertain())
    expect(await askChoice({ a: 0.17, b: 0.17, c: 0.17, d: 0.17, e: 0.17, f: 0.17 })).toEqual(new Uncertain())
    await expect(askChoice({ billing: 0.9, shipping: 0.004, other: 0.003, technical: 0.002 })).rejects.toThrow(
      /must sum to 1/
    )
  })

  it('reports a prompt blocked through prompt_feedback with its reason', async () => {
    const fetch = fakeFetch({
      answers: {},
      prompt_feedback: { block_reason: 'safety', block_reason_message: 'Harmful content' },
    })
    const decision = new GeminiDecisionModel({ apiKey: 'test-key', fetch })

    await expect(decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })).rejects.toThrow(
      new ModelError('gemini decision prompt was blocked (safety): Harmful content')
    )
  })

  it('fills a missing Noul confidence on Gemini scale', async () => {
    const fetch = fakeFetch({ answers: { q: { type: 'noul', noul: 0.2 } } })
    const decision = new GeminiDecisionModel({ apiKey: 'test-key', fetch })

    const result = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

    expect(result.answers.q).toBe(false)
    expect(result.metadata.confidence).toEqual({ q: 0.8 })
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

    expect(result).toEqual({
      answers: { refused: new Uncertain('openai refused to answer'), answered: true },
      metadata: {
        latencyMs: expect.any(Number),
        providerName: 'openai',
        modelId: 'gpt-6-luna',
        probabilities: { refused: {}, answered: { true: 0.99, false: 0.010000000000000009 } },
        confidence: { refused: 0, answered: 0.98 },
      },
    })
  })

  it('reports the model id the API echoes over the configured one', async () => {
    const fetch = fakeFetch({
      model: 'gpt-6-luna-2026-11',
      answers: [{ type: 'predicate', name: 'q', probability: 0.99 }],
    })
    const decision = new OpenAIDecisionModel({ apiKey: 'test-key', fetch })

    const result = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

    expect(result.metadata.modelId).toBe('gpt-6-luna-2026-11')
  })

  it('throws when a refused question disabled uncertainty', async () => {
    const fetch = fakeFetch({ answers: [{ type: 'refusal', name: 'q' }] })
    const decision = new OpenAIDecisionModel({ apiKey: 'test-key', fetch })

    await expect(
      decision.ask('state', { q: { question: 'ok?', choices: 'boolean', uncertainty: false } })
    ).rejects.toThrow(/question id=<q> \| decision provider refused to answer/)
  })

  it.each([
    { name: 'a non-object response', payload: null },
    { name: 'a non-object answer', payload: { answers: [null] } },
    {
      name: 'a non-object choice probability',
      payload: { answers: [{ type: 'choice', name: 'q', choice: 'a', probabilities: [null], confidence: 1 }] },
    },
  ])('rejects $name with ModelError', async ({ payload }) => {
    const decision = new OpenAIDecisionModel({ apiKey: 'test-key', fetch: fakeFetch(payload) })

    await expect(decision.ask('state', { q: { question: 'Which?', choices: ['a', 'b'] } })).rejects.toThrow(ModelError)
  })

  it.each([
    { status: 400, message: 'Decision input exceeds the token limit.', expectedClass: ContextWindowOverflowError },
    { status: 400, message: 'Invalid question type.', expectedClass: ModelError },
    { status: 500, message: 'Decision input exceeds the token limit.', expectedClass: ModelError },
  ])('scopes context overflow for HTTP $status: $message', async ({ status, message, expectedClass }) => {
    const body = { error: { message, type: 'invalid_request_error', code: null } }
    const decision = new OpenAIDecisionModel({ apiKey: 'test-key', fetch: fakeFetch(body, { status }) })
    const error = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } }).then(
      () => undefined,
      (caught: unknown) => caught
    )

    expect((error as Error).constructor).toBe(expectedClass)
    expect((error as Error).message).toBe(`openai decision request failed with HTTP ${status}: ${message}`)
    expect((error as Error).cause).toMatchObject({ status, body })
  })

  it('sends message state as JSON text input', async () => {
    const captured: CapturedRequest[] = []
    const fetch = fakeFetch({ answers: [{ type: 'predicate', name: 'q', probability: 0.99 }] }, { captured })
    const decision = new OpenAIDecisionModel({ apiKey: 'test-key', fetch })

    await decision.ask([new Message({ role: 'user', content: [new TextBlock('hello')] })], {
      q: { question: 'Greeting?', choices: 'boolean' },
    })

    expect(captured[0]?.body['input']).toBe('[{"role":"user","content":[{"text":"hello"}]}]')
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
