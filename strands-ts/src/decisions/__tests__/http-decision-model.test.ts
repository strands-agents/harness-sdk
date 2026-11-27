import { trace, type Tracer } from '@opentelemetry/api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isNode } from '../../__fixtures__/environment.js'
import { MockSpan } from '../../__fixtures__/mock-span.js'
import { ModelError, ModelThrottledError } from '../../errors.js'
import { sigV4Auth, type HttpDecisionModelAuth } from '../http-decision-model.js'
import { Uncertain } from '../types.js'
import {
  CREDENTIALS,
  LOCAL_ENDPOINT,
  LAMBDA_ENDPOINT,
  QUESTIONS,
  systemOneBody,
  fakeFetch,
  hangingFetch,
  brokenBodyFetch,
  create,
  expectModelError,
  expectedSignature,
  type CapturedRequest,
} from '../__fixtures__/http-decision-model.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('HttpDecisionModel', () => {
  describe('ask', () => {
    it('posts the System One request to the endpoint without credentials', async () => {
      const captured: CapturedRequest[] = []
      const decision = create({ fetch: fakeFetch(systemOneBody(), { captured }) })

      const result = await decision.ask('Refund this today', QUESTIONS)

      expect(captured).toEqual([
        {
          url: LOCAL_ENDPOINT,
          headers: { 'content-type': 'application/json' },
          rawBody: expect.any(String),
          redirect: 'manual',
          body: {
            state: 'Refund this today',
            questions: { urgent: { type: 'noul', instructions: 'Is this urgent?' } },
          },
        },
      ])
      expect(result).toEqual({
        answers: { urgent: true },
        metadata: {
          latencyMs: expect.any(Number),
          providerName: 'http',
          modelId: 'resolved-model',
          probabilities: { urgent: { true: 0.9, false: expect.closeTo(0.1) } },
          confidence: { urgent: expect.closeTo(0.8) },
        },
      })
    })

    it('sends no model, so the server answers with its own', async () => {
      const captured: CapturedRequest[] = []

      await create({ fetch: fakeFetch(systemOneBody(), { captured }) }).ask('state', QUESTIONS)

      expect(captured[0]?.body).not.toHaveProperty('model')
    })

    it('applies defaultMinConfidence to the answers', async () => {
      // A yes probability of 0.9 is a confidence of 0.8.
      const fetch = fakeFetch(systemOneBody(0.9))

      const result = await create({ fetch, defaultMinConfidence: 0.5 }).ask('state', QUESTIONS)
      const strict = await create({ fetch, defaultMinConfidence: 0.85 }).ask('state', QUESTIONS)

      expect(result.answers).toEqual({ urgent: true })
      expect(strict.answers).toEqual({ urgent: new Uncertain() })
    })

    it('defaults the minimum confidence to 0.5', async () => {
      // A yes probability of 0.7 is a confidence of 0.4.
      const fetch = fakeFetch(systemOneBody(0.7))

      const result = await create({ fetch }).ask('state', QUESTIONS)
      const permissive = await create({ fetch, defaultMinConfidence: 0 }).ask('state', QUESTIONS)

      expect(result.answers).toEqual({ urgent: new Uncertain() })
      expect(permissive.answers).toEqual({ urgent: true })
    })

    it.each([
      ['a sigv4 endpoint', { auth: sigV4Auth({ service: 'lambda', region: 'us-east-1', credentials: CREDENTIALS }) }],
      ['an endpoint with a custom auth function', { auth: (request: Request) => request }],
    ] as const)('adds a hint when %s answers 403', async (_name, options) => {
      const decision = create({
        endpoint: LAMBDA_ENDPOINT,
        ...options,
        // What a Lambda Function URL answers: AWS services capitalize `Message`.
        fetch: fakeFetch({ Message: 'Forbidden' }, { status: 403 }),
      })

      await expectModelError(
        decision.ask('state', QUESTIONS),
        'http decision request failed with HTTP 403: Forbidden | check the credentials and endpoint permissions'
      )
    })

    it('maps HTTP failures to model errors that name the provider and status', async () => {
      const throttled = create({ fetch: fakeFetch({ error: 'slow down' }, { status: 429 }) })
      const forbidden = create({ fetch: fakeFetch({ message: 'Forbidden' }, { status: 403 }) })

      await expect(throttled.ask('state', QUESTIONS)).rejects.toBeInstanceOf(ModelThrottledError)
      await expect(forbidden.ask('state', QUESTIONS)).rejects.toThrow('http decision request failed with HTTP 403')
      await expect(forbidden.ask('state', QUESTIONS)).rejects.toBeInstanceOf(ModelError)
    })

    it.each([204, 205])('reports an empty HTTP %s answer as an invalid response', async (status) => {
      const fetch = vi.fn(async () => new Response(null, { status })) as unknown as typeof globalThis.fetch
      const decision = create({ fetch })

      await expectModelError(decision.ask('state', QUESTIONS), 'decision provider response must be an object')
    })

    it('reports a connection that drops mid-body as a model error', async () => {
      const decision = create({ fetch: brokenBodyFetch('reset') })

      const error = await decision.ask('state', QUESTIONS).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ModelError)
      expect((error as Error).message).toBe(
        `http decision request failed: ${isNode ? 'terminated' : 'Failed to fetch'}`
      )
    })
  })

  describe('timeout', () => {
    it('defaults to 60 seconds', async () => {
      const timer = vi.spyOn(globalThis, 'setTimeout')

      await create({ fetch: fakeFetch() }).ask('state', QUESTIONS)

      expect(timer).toHaveBeenCalledWith(expect.any(Function), 60_000)
    })

    it('clears its timer when the request settles', async () => {
      const clear = vi.spyOn(globalThis, 'clearTimeout')

      await create({ fetch: fakeFetch() }).ask('state', QUESTIONS)

      expect(clear).toHaveBeenCalledTimes(1)
    })

    it('aborts a request that exceeds timeoutMs', async () => {
      const decision = create({ fetch: hangingFetch(), timeoutMs: 20 })

      await expectModelError(
        decision.ask('state', QUESTIONS),
        'http decision request failed: The operation was aborted due to timeout'
      )
    })

    it('covers reading the response body', async () => {
      const decision = create({ fetch: brokenBodyFetch('stall'), timeoutMs: 20 })

      await expectModelError(
        decision.ask('state', QUESTIONS),
        'http decision request failed: The operation was aborted due to timeout'
      )
    })

    it('reports a caller cancel as a failed request, not a timeout', async () => {
      const decision = create({ fetch: hangingFetch(), timeoutMs: 60_000 })
      const controller = new AbortController()

      const pending = decision.ask('state', QUESTIONS, { cancelSignal: controller.signal })
      controller.abort(new Error('stop'))

      await expectModelError(pending, 'http decision request failed: stop')
    })

    it('honors cancellation when fetch returns a response after the signal aborted', async () => {
      const controller = new AbortController()
      const decision = create({
        fetch: async () => {
          controller.abort(new Error('stop'))
          return new Response(JSON.stringify(systemOneBody()))
        },
      })

      await expectModelError(
        decision.ask('state', QUESTIONS, { cancelSignal: controller.signal }),
        'http decision request failed: stop'
      )
    })

    it('reports a failure as a failed request when the caller cancelled and the timeout fired too', async () => {
      // The request outlives its timeout and is then cancelled, so both signals have fired when it fails.
      const slowFailure = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        throw new Error('boom')
      }) as unknown as typeof globalThis.fetch
      const decision = create({ fetch: slowFailure, timeoutMs: 10 })
      const controller = new AbortController()

      const pending = decision.ask('state', QUESTIONS, { cancelSignal: controller.signal })
      setTimeout(() => controller.abort(), 30)

      await expectModelError(pending, 'http decision request failed: boom')
    })
  })

  describe('auth', () => {
    it('authenticates a request synchronously without consuming its body', async () => {
      const captured: CapturedRequest[] = []
      const decision = create({
        auth: (request) => {
          request.headers.set('authorization', 'Bearer tok')
          return request
        },
        fetch: fakeFetch(systemOneBody(), { captured }),
      })

      await decision.ask('state', QUESTIONS)

      expect(captured[0]).toMatchObject({
        url: LOCAL_ENDPOINT,
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: { state: 'state', questions: { urgent: { type: 'noul', instructions: 'Is this urgent?' } } },
        redirect: 'manual',
      })
    })

    it('sends a new request returned asynchronously by auth with redirect and cancellation enforced', async () => {
      const captured: CapturedRequest[] = []
      const fetch = fakeFetch(systemOneBody(), { captured })
      const decision = create({
        auth: async (request) =>
          new Request(`${LAMBDA_ENDPOINT}?version=live`, {
            method: request.method,
            headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
            body: await request.clone().text(),
            redirect: 'follow',
          }),
        fetch,
      })

      await decision.ask('state', QUESTIONS)

      expect(captured[0]).toMatchObject({
        url: `${LAMBDA_ENDPOINT}?version=live`,
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        redirect: 'manual',
      })
      expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    })

    it('omits invalid auth header values from errors and telemetry', async () => {
      // Invalid credentials must not appear in exception messages (#6395).
      const span = new MockSpan()
      vi.spyOn(trace, 'getTracer').mockReturnValue({ startSpan: () => span } as unknown as Tracer)
      const fetch = fakeFetch()
      const decision = create({
        auth: (request) => {
          request.headers.set('authorization', 'Bearer private-token\nvalue')
          return request
        },
        fetch,
      })

      const error = await decision.ask('state', QUESTIONS).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(ModelError)
      expect((error as Error).message).toBe('http decision request failed: authentication failed')
      expect((error as Error).cause).toBeInstanceOf(TypeError)
      expect(String((error as Error).cause)).toBe('TypeError: authentication failed')
      expect(span.calls.setStatus[0]?.status.message).toBe('http decision request failed: authentication failed')
      expect(span.calls.recordException[0]?.exception).toBe(error)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('rejects a request that auth points at plain http', async () => {
      const fetch = fakeFetch()
      const decision = create({ auth: (request) => new Request('http://example.com/v1/systemone', request), fetch })

      await expectModelError(
        decision.ask('state', QUESTIONS),
        'http decision request failed: HttpDecisionModel auth and headers require an https endpoint unless the host is loopback'
      )
      expect(fetch).not.toHaveBeenCalled()
    })

    it('reports an auth failure as a model error without sending the request', async () => {
      const fetch = fakeFetch()
      const decision = create({
        auth: async () => {
          throw new Error('token expired')
        },
        fetch,
      })

      await expectModelError(decision.ask('state', QUESTIONS), 'http decision request failed: token expired')
      expect(fetch).not.toHaveBeenCalled()
    })

    it('allows remote HTTP at construction and after auth only with an explicit opt-in', async () => {
      const endpoint = 'http://decider:8000/v1/systemone'
      const auth: HttpDecisionModelAuth = (request) => new Request('http://other-decider:8000/v1/systemone', request)
      expect(() => create({ endpoint, auth, allowInsecureHttp: false })).toThrow(
        'auth and headers require an https endpoint'
      )
      const captured: CapturedRequest[] = []
      await create({
        endpoint,
        auth,
        allowInsecureHttp: true,
        fetch: fakeFetch(systemOneBody(), { captured }),
      }).ask('state', QUESTIONS)

      expect(captured[0]?.url).toBe('http://other-decider:8000/v1/systemone')
    })

    it('rejects unsupported protocols returned by auth even with insecure HTTP enabled', async () => {
      const fetch = fakeFetch()
      const decision = create({
        auth: (request) => new Request('ftp://localhost/v1/systemone', request),
        allowInsecureHttp: true,
        fetch,
      })

      await expectModelError(
        decision.ask('state', QUESTIONS),
        'http decision request failed: HttpDecisionModel endpoint must use http or https'
      )
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('redirects', () => {
    it('reports opaque browser redirects without reconstructing a status-zero response', async () => {
      // Browser manual redirects must produce a useful endpoint error (#6395).
      const response = new Response(null)
      Object.defineProperties(response, {
        type: { value: 'opaqueredirect' },
        status: { value: 0 },
      })
      const fetch = vi.fn(async () => response)

      await expectModelError(
        create({ fetch }).ask('state', QUESTIONS),
        'http decision request failed: redirected: set the endpoint to the redirect target'
      )
      expect(response.bodyUsed).toBe(false)
    })

    it('rejects redirects even with insecure HTTP enabled', async () => {
      const fetch = vi.fn(async () => Response.redirect('http://other-decider:8000/v1/systemone', 307))

      await expectModelError(
        create({
          endpoint: 'http://decider:8000/v1/systemone',
          auth: (request) => request,
          allowInsecureHttp: true,
          fetch,
        }).ask('state', QUESTIONS),
        'http decision request failed: redirected (HTTP 307): set the endpoint to the redirect target'
      )
    })
  })

  describe('sigv4 auth', () => {
    it('sends exactly the headers a reference implementation signs', async () => {
      // botocore, an independent SigV4 implementation, signs this request with the same credentials and clock
      // and produces the same signature and `x-amz-content-sha256`.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
      const captured: CapturedRequest[] = []
      const decision = create({
        endpoint: LAMBDA_ENDPOINT,
        auth: sigV4Auth({ service: 'lambda', region: 'us-east-1', credentials: CREDENTIALS }),
        fetch: fakeFetch(systemOneBody(), { captured }),
      })

      await decision.ask('Refund this today', QUESTIONS)

      expect(captured).toEqual([
        {
          url: LAMBDA_ENDPOINT,
          redirect: 'manual',
          rawBody:
            '{"state":"Refund this today","questions":{"urgent":{"type":"noul","instructions":"Is this urgent?"}}}',
          body: {
            state: 'Refund this today',
            questions: { urgent: { type: 'noul', instructions: 'Is this urgent?' } },
          },
          headers: {
            authorization:
              'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20250101/us-east-1/lambda/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=28c06bbba2d7124a34910841b248e482099aff90df4ae39081c9eb05549cf83a',
            'content-type': 'application/json',
            'x-amz-content-sha256': 'ece0a488cf6a03d34d97a98a7fc8e2fc5977d41a09624b292eb34551d0b461e5',
            'x-amz-date': '20250101T000000Z',
            'x-amz-security-token': 'session-token',
          },
        },
      ])
    })

    it('signs the query string', async () => {
      const captured: CapturedRequest[] = []
      const decision = create({
        endpoint: `${LAMBDA_ENDPOINT}?Qualifier=live&note=a%20b`,
        auth: sigV4Auth({ service: 'lambda', region: 'us-east-1', credentials: CREDENTIALS }),
        fetch: fakeFetch(systemOneBody(), { captured }),
      })

      await decision.ask('state', QUESTIONS)

      expect(captured[0]?.headers['authorization']).toBe(await expectedSignature(captured[0]!, 'lambda', 'us-east-1'))
    })

    it('signs repeated query parameters', async () => {
      // Every query parameter must contribute to the signature (#6395).
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
      const captured: CapturedRequest[] = []
      await create({
        endpoint: `${LAMBDA_ENDPOINT}?a=2&a=1`,
        auth: sigV4Auth({ service: 'lambda', region: 'us-east-1', credentials: CREDENTIALS }),
        fetch: fakeFetch(systemOneBody(), { captured }),
      }).ask('state', QUESTIONS)

      // Reference signature computed with Node crypto, independently of Smithy.
      expect(captured[0]?.headers['authorization']).toBe(
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20250101/us-east-1/lambda/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=656e5384c656ce1dfbc280b54d68f9e230666486b31ce460e14eea43280c9b7f'
      )
    })

    it('rejects query keys the signer cannot canonicalize without sending a request', async () => {
      // Unsupported canonicalization must fail before transmitting a bad signature (#6395).
      const fetch = fakeFetch()
      const decision = create({
        endpoint: `${LAMBDA_ENDPOINT}?__proto__=value`,
        auth: sigV4Auth({ service: 'lambda', region: 'us-east-1', credentials: CREDENTIALS }),
        fetch,
      })

      await expectModelError(
        decision.ask('state', QUESTIONS),
        'http decision request failed: sigV4Auth does not support a query parameter named __proto__'
      )
      expect(fetch).not.toHaveBeenCalled()
    })

    it('signs the body that is sent, whatever the state contains', async () => {
      const captured: CapturedRequest[] = []
      const decision = create({
        endpoint: LAMBDA_ENDPOINT,
        auth: sigV4Auth({ service: 'lambda', region: 'us-east-1', credentials: CREDENTIALS }),
        fetch: fakeFetch(systemOneBody(), { captured }),
      })

      await decision.ask('Remboursement \u00e9t\u00e9 \u2603 \u{1F600}', QUESTIONS)

      expect(captured[0]?.headers['authorization']).toBe(await expectedSignature(captured[0]!, 'lambda', 'us-east-1'))
    })

    it.each([
      ['without an expiration', undefined, 1],
      ['an hour from expiring', 60 * 60_000, 1],
      ['a minute from expiring', 60_000, 2],
    ])(
      'reuses or refreshes credentials %s across concurrent and sequential requests',
      async (_name, expiresIn, calls) => {
        const provider = vi
          .fn<() => Promise<typeof CREDENTIALS & { expiration?: Date }>>()
          .mockResolvedValue({
            ...CREDENTIALS,
            ...(expiresIn !== undefined && { expiration: new Date(Date.now() + 60 * 60_000) }),
          })
          .mockResolvedValueOnce({
            ...CREDENTIALS,
            ...(expiresIn !== undefined && { expiration: new Date(Date.now() + expiresIn) }),
          })
        const decision = create({
          endpoint: LAMBDA_ENDPOINT,
          auth: sigV4Auth({ service: 'lambda', region: 'us-east-1', credentials: provider }),
          fetch: fakeFetch(),
        })

        await Promise.all([decision.ask('one', QUESTIONS), decision.ask('two', QUESTIONS)])
        await decision.ask('three', QUESTIONS)

        expect(provider).toHaveBeenCalledTimes(calls)
      }
    )

    it('reports a credential failure as a model error, and recovers on the next call', async () => {
      const fetch = fakeFetch()
      const provider = vi
        .fn<() => Promise<typeof CREDENTIALS>>()
        .mockRejectedValueOnce(new Error('no credentials'))
        .mockResolvedValue(CREDENTIALS)
      const decision = create({
        endpoint: LAMBDA_ENDPOINT,
        auth: sigV4Auth({ service: 'lambda', region: 'us-east-1', credentials: provider }),
        fetch,
      })

      await expectModelError(decision.ask('state', QUESTIONS), 'http decision request failed: no credentials')
      expect(fetch).not.toHaveBeenCalled()

      await expect(decision.ask('state', QUESTIONS)).resolves.toBeDefined()
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('stalled credentials', () => {
    const stalled = (): Promise<typeof CREDENTIALS> => new Promise(() => {})
    const sigv4 = sigV4Auth({ service: 'lambda', region: 'us-east-1', credentials: stalled })

    it('times out a credential lookup that never answers', async () => {
      const fetch = fakeFetch()
      const decision = create({ endpoint: LAMBDA_ENDPOINT, auth: sigv4, timeoutMs: 20, fetch })

      await expectModelError(
        decision.ask('state', QUESTIONS),
        'http decision request failed: The operation was aborted due to timeout'
      )
      expect(fetch).not.toHaveBeenCalled()
    })

    it('does not start signing for a request cancelled before it is sent', async () => {
      const provider = vi.fn(async () => {
        throw new Error('no credentials')
      })
      const decision = create({
        endpoint: LAMBDA_ENDPOINT,
        auth: sigV4Auth({ service: 'lambda', region: 'us-east-1', credentials: provider }),
        fetch: fakeFetch(),
      })

      await expectModelError(
        decision.ask('state', QUESTIONS, { cancelSignal: AbortSignal.abort(new Error('stop')) }),
        'http decision request failed: stop'
      )
      expect(provider).not.toHaveBeenCalled()
    })

    it('cancels a credential lookup that never answers', async () => {
      const decision = create({ endpoint: LAMBDA_ENDPOINT, auth: sigv4, fetch: fakeFetch() })
      const controller = new AbortController()

      const pending = decision.ask('state', QUESTIONS, { cancelSignal: controller.signal })
      controller.abort(new Error('stop'))

      await expectModelError(pending, 'http decision request failed: stop')
    })
  })

  describe('constructor validation', () => {
    const auth: HttpDecisionModelAuth = (request) => request

    it('never echoes a secret in a validation error', () => {
      const errors = [
        () => create({ endpoint: 'https://user:hunter2@example.com/v1/systemone' }),
        () => create({ endpoint: 'https://user:hunter2@bad host/v1/systemone' }),
        () => create({ headers: { Authorization: 'Bearer hunter2\u0000' } }),
        () => create({ headers: { 'x-api-key': 'hunter2\nX-Injected: 1' } }),
      ].map((attempt) => {
        try {
          attempt()
        } catch (error) {
          expect(JSON.stringify(error)).not.toContain('hunter2')
          return (error as Error).message
        }
        return ''
      })

      expect(errors).toHaveLength(4)
      for (const message of errors) {
        expect(message).not.toBe('')
        expect(message).not.toContain('hunter2')
      }
    })

    it.each([
      'http://localhost:8000/v1/systemone',
      'http://127.0.0.1:8000/v1/systemone',
      'http://[::1]:8000/v1/systemone',
    ])('allows credentials over plain http to loopback %s', (endpoint) => {
      expect(() => create({ endpoint, auth })).not.toThrow()
    })

    describe('in a browser', () => {
      beforeEach(() => {
        if (isNode) vi.stubGlobal('window', {})
      })

      it('allows an endpoint that needs no auth or headers', () => {
        expect(() => create()).not.toThrow()
      })

      it('rejects static headers, which every user of the page could read', () => {
        expect(() => create({ headers: { 'x-api-key': 'k' } })).toThrow(
          'HttpDecisionModel headers would be readable by every user of the page'
        )
      })

      it('signs with temporary credentials', async () => {
        const captured: CapturedRequest[] = []
        const decision = create({
          endpoint: LAMBDA_ENDPOINT,
          auth: sigV4Auth({ service: 'lambda', region: 'us-east-1', credentials: CREDENTIALS }),
          fetch: fakeFetch(systemOneBody(), { captured }),
        })

        await decision.ask('state', QUESTIONS)

        expect(captured[0]?.headers['x-amz-security-token']).toBe('session-token')
      })

      it('refuses to sign with long-term access keys', async () => {
        const fetch = fakeFetch()
        const { sessionToken: _sessionToken, ...longTerm } = CREDENTIALS
        const decision = create({
          endpoint: LAMBDA_ENDPOINT,
          auth: sigV4Auth({ service: 'lambda', region: 'us-east-1', credentials: longTerm }),
          fetch,
        })

        await expectModelError(
          decision.ask('state', QUESTIONS),
          'http decision request failed: sigV4Auth in a browser requires temporary credentials with a sessionToken'
        )
        expect(fetch).not.toHaveBeenCalled()
      })

      it('signs with long-term access keys in a browser only with an explicit opt-in', async () => {
        const { sessionToken: _sessionToken, ...credentials } = CREDENTIALS
        const captured: CapturedRequest[] = []
        await create({
          endpoint: LAMBDA_ENDPOINT,
          auth: sigV4Auth({
            service: 'lambda',
            region: 'us-east-1',
            credentials,
            dangerouslyAllowBrowser: true,
          }),
          fetch: fakeFetch(systemOneBody(), { captured }),
        }).ask('state', QUESTIONS)

        expect(captured[0]?.headers['authorization']).toContain('Credential=AKIDEXAMPLE/')
        expect(captured[0]?.headers).not.toHaveProperty('x-amz-security-token')
      })
    })
  })

  describe('sigV4Auth validation', () => {
    it('requires a service', () => {
      expect(() => sigV4Auth({ service: ' ', region: 'us-east-1' })).toThrow('sigV4Auth requires a service')
    })

    it('requires credentials outside Node.js, where there is no default credential chain', () => {
      expect(() => sigV4Auth({ service: 'lambda', region: 'us-east-1' })).toThrow(
        'sigV4Auth requires credentials outside Node.js'
      )
    })
  })
})
