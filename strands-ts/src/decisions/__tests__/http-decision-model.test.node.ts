import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import { Sha256 } from '@aws-crypto/sha256-js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelError, ModelThrottledError } from '../../errors.js'
import { HttpDecisionModel, type HttpDecisionModelOptions } from '../http-decision-model.js'
import { Uncertain } from '../types.js'

const LOCAL_ENDPOINT = 'http://localhost:8000/v1/systemone'
const LAMBDA_ENDPOINT = 'https://abc123.lambda-url.us-east-1.on.aws/v1/systemone'
const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session-token' }
const QUESTIONS = { urgent: { question: 'Is this urgent?', choices: 'boolean' } } as const

interface CapturedRequest {
  url: string
  headers: Record<string, string>
  rawBody: string
  body: Record<string, unknown>
}

function systemOneBody(noul = 0.9): unknown {
  return { model: 'resolved-model', answers: { urgent: { type: 'noul', noul } } }
}

function fakeFetch(
  payload: unknown = systemOneBody(),
  options: { status?: number; captured?: CapturedRequest[] } = {}
): typeof globalThis.fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawBody = String(init?.body)
    options.captured?.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      rawBody,
      body: JSON.parse(rawBody) as Record<string, unknown>,
    })
    return new Response(JSON.stringify(payload), {
      status: options.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof globalThis.fetch
}

/** A fetch that never answers and rejects when its signal aborts, like a real network call. */
function hangingFetch(): typeof globalThis.fetch {
  return ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })) as typeof globalThis.fetch
}

function create(options: Partial<HttpDecisionModelOptions> = {}): HttpDecisionModel {
  return new HttpDecisionModel({ endpoint: LOCAL_ENDPOINT, ...options })
}

afterEach(() => {
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
          body: {
            state: 'Refund this today',
            questions: { urgent: { type: 'noul', instructions: 'Is this urgent?' } },
          },
        },
      ])
      expect(result.answers.urgent).toBe(true)
      expect(result.metadata.providerName).toBe('http')
      expect(result.metadata.modelId).toBe('resolved-model')
    })

    it('sends modelId only when one is configured', async () => {
      const captured: CapturedRequest[] = []
      const fetch = fakeFetch(systemOneBody(), { captured })

      await create({ fetch, modelId: ' my-model ' }).ask('state', QUESTIONS)

      expect(captured[0]?.body.model).toBe('my-model')
    })

    it('applies defaultMinConfidence to the answers', async () => {
      // A yes probability of 0.9 is a confidence of 0.8.
      const fetch = fakeFetch(systemOneBody(0.9))

      const result = await create({ fetch, defaultMinConfidence: 0.5 }).ask('state', QUESTIONS)
      const strict = await create({ fetch, defaultMinConfidence: 0.85 }).ask('state', QUESTIONS)

      expect(result.answers.urgent).toBe(true)
      expect(strict.answers.urgent).toBeInstanceOf(Uncertain)
    })

    it('maps HTTP failures to model errors that name the provider and status', async () => {
      const throttled = create({ fetch: fakeFetch({ error: 'slow down' }, { status: 429 }) })
      const forbidden = create({ fetch: fakeFetch({ message: 'Forbidden' }, { status: 403 }) })

      await expect(throttled.ask('state', QUESTIONS)).rejects.toBeInstanceOf(ModelThrottledError)
      await expect(forbidden.ask('state', QUESTIONS)).rejects.toThrow('http decision request failed with HTTP 403')
      await expect(forbidden.ask('state', QUESTIONS)).rejects.toBeInstanceOf(ModelError)
    })
  })

  describe('timeout', () => {
    it('aborts a request that exceeds timeoutMs', async () => {
      const decision = create({ fetch: hangingFetch(), timeoutMs: 20 })

      const error = await decision.ask('state', QUESTIONS).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ModelError)
      expect((error as Error).message).toBe('http decision request timed out after 20ms')
    })

    it('reports a caller cancel as a failed request, not a timeout', async () => {
      const decision = create({ fetch: hangingFetch(), timeoutMs: 60_000 })
      const controller = new AbortController()

      const pending = decision.ask('state', QUESTIONS, { cancelSignal: controller.signal })
      controller.abort(new Error('stop'))

      const error = await pending.catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ModelError)
      expect((error as Error).message).not.toContain('timed out')
    })
  })

  describe('bearer auth', () => {
    it('sends the token and static headers', async () => {
      const captured: CapturedRequest[] = []
      const decision = create({
        endpoint: 'https://gateway.example.com/prod/v1/systemone',
        auth: { type: 'bearer', token: ' tok ' },
        headers: { 'x-api-key': 'key-1' },
        fetch: fakeFetch(systemOneBody(), { captured }),
      })

      await decision.ask('state', QUESTIONS)

      expect(captured[0]?.headers).toEqual({
        authorization: 'Bearer tok',
        'x-api-key': 'key-1',
        'content-type': 'application/json',
      })
    })

    it('sends static headers without auth', async () => {
      const captured: CapturedRequest[] = []
      const decision = create({ headers: { 'x-api-key': 'key-1' }, fetch: fakeFetch(systemOneBody(), { captured }) })

      await decision.ask('state', QUESTIONS)

      expect(captured[0]?.headers).toEqual({ 'x-api-key': 'key-1', 'content-type': 'application/json' })
    })
  })

  describe('sigv4 auth', () => {
    /** Signs the captured request again with the same credentials and signing time; a match proves what was sent is what was signed. */
    async function expectedSignature(request: CapturedRequest, service: string, region: string): Promise<string> {
      const url = new URL(request.url)
      const query: Record<string, string> = Object.fromEntries(url.searchParams)
      const signer = new SignatureV4({ service, region, sha256: Sha256, credentials: CREDENTIALS })
      const signingDate = new Date(
        request.headers['x-amz-date']!.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')
      )
      const staticHeaders = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name === 'x-api-key'))
      const signed = await signer.sign(
        new HttpRequest({
          method: 'POST',
          protocol: url.protocol,
          hostname: url.hostname,
          path: url.pathname,
          query,
          headers: { ...staticHeaders, host: url.host, 'content-type': 'application/json' },
          body: request.rawBody,
        }),
        { signingDate }
      )
      return signed.headers['authorization']!
    }

    it('signs the exact request that is sent', async () => {
      const captured: CapturedRequest[] = []
      const decision = create({
        endpoint: LAMBDA_ENDPOINT,
        auth: { type: 'sigv4', region: 'us-east-1', service: 'lambda', credentials: CREDENTIALS },
        fetch: fakeFetch(systemOneBody(), { captured }),
      })

      await decision.ask('Refund this today', QUESTIONS)

      const [request] = captured
      expect(request?.headers['authorization']).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/lambda\/aws4_request, SignedHeaders=.*host.*, Signature=[0-9a-f]{64}$/
      )
      expect(request?.headers['x-amz-security-token']).toBe('session-token')
      expect(request?.headers['content-type']).toBe('application/json')
      expect(request?.headers['authorization']).toBe(await expectedSignature(request!, 'lambda', 'us-east-1'))
    })

    it('signs static headers and the query string', async () => {
      const captured: CapturedRequest[] = []
      const decision = create({
        endpoint: 'https://abc123.execute-api.eu-west-1.amazonaws.com/prod/v1/systemone?stage=a',
        auth: { type: 'sigv4', region: 'eu-west-1', service: 'execute-api', credentials: CREDENTIALS },
        headers: { 'x-api-key': 'key-1' },
        fetch: fakeFetch(systemOneBody(), { captured }),
      })

      await decision.ask('state', QUESTIONS)

      const [request] = captured
      expect(request?.headers['authorization']).toContain('SignedHeaders=')
      expect(request?.headers['authorization']).toMatch(/SignedHeaders=[^,]*x-api-key/)
      expect(request?.headers['authorization']).toBe(await expectedSignature(request!, 'execute-api', 'eu-west-1'))
    })

    it('resolves credentials from a provider on every request', async () => {
      const provider = vi.fn(async () => CREDENTIALS)
      const decision = create({
        endpoint: LAMBDA_ENDPOINT,
        auth: { type: 'sigv4', region: 'us-east-1', service: 'lambda', credentials: provider },
        fetch: fakeFetch(),
      })

      await decision.ask('one', QUESTIONS)
      await decision.ask('two', QUESTIONS)

      expect(provider).toHaveBeenCalledTimes(2)
    })

    it('uses the standard AWS credential chain when credentials are omitted', async () => {
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDFROMENV')
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'env-secret')
      vi.stubEnv('AWS_SESSION_TOKEN', undefined)
      // A profile outranks environment credentials, so a developer's own profile must not leak in.
      vi.stubEnv('AWS_PROFILE', undefined)
      const captured: CapturedRequest[] = []
      const decision = create({
        endpoint: LAMBDA_ENDPOINT,
        auth: { type: 'sigv4', region: 'us-east-1', service: 'lambda' },
        fetch: fakeFetch(systemOneBody(), { captured }),
      })

      await decision.ask('state', QUESTIONS)

      expect(captured[0]?.headers['authorization']).toContain('Credential=AKIDFROMENV/')
    })

    it('does not report a credential failure as a failed request', async () => {
      const fetch = fakeFetch()
      const decision = create({
        endpoint: LAMBDA_ENDPOINT,
        auth: {
          type: 'sigv4',
          region: 'us-east-1',
          service: 'lambda',
          credentials: async () => {
            throw new Error('no credentials')
          },
        },
        fetch,
      })

      await expect(decision.ask('state', QUESTIONS)).rejects.toThrow('no credentials')
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('constructor validation', () => {
    it.each([
      ['an invalid endpoint', { endpoint: 'not a url' }, 'endpoint must be a valid URL'],
      ['a non-http endpoint', { endpoint: 'ftp://example.com/x' }, 'endpoint must use http or https'],
      ['an empty bearer token', { auth: { type: 'bearer', token: '  ' } }, 'requires a non-empty token'],
      [
        'sigv4 without a region',
        { endpoint: LAMBDA_ENDPOINT, auth: { type: 'sigv4', region: '', service: 'lambda' } },
        'requires a region and a service',
      ],
      [
        'sigv4 without a service',
        { endpoint: LAMBDA_ENDPOINT, auth: { type: 'sigv4', region: 'us-east-1', service: ' ' } },
        'requires a region and a service',
      ],
      [
        'an unknown auth type',
        { auth: { type: 'basic' } as unknown as HttpDecisionModelOptions['auth'] },
        "auth type must be 'bearer' or 'sigv4'",
      ],
      [
        'a bearer token over plain http to a remote host',
        { endpoint: 'http://example.com/v1/systemone', auth: { type: 'bearer', token: 't' } },
        'auth requires an https endpoint',
      ],
      [
        'sigv4 over plain http to a remote host',
        {
          endpoint: 'http://abc.lambda-url.us-east-1.on.aws/v1/systemone',
          auth: { type: 'sigv4', region: 'us-east-1', service: 'lambda' },
        },
        'auth requires an https endpoint',
      ],
      [
        'an authorization header alongside auth',
        { auth: { type: 'bearer', token: 't' }, headers: { Authorization: 'x' } },
        "cannot set 'authorization' when auth is set",
      ],
      ['a content-type header', { headers: { 'Content-Type': 'text/plain' } }, "cannot set 'Content-Type'"],
      ['a host header', { headers: { host: 'other' } }, "cannot set 'host'"],
      ['a zero timeout', { timeoutMs: 0 }, 'timeoutMs must be a positive number'],
      ['a non-finite timeout', { timeoutMs: Number.POSITIVE_INFINITY }, 'timeoutMs must be a positive number'],
      ['an out-of-range confidence', { defaultMinConfidence: 1.5 }, 'defaultMinConfidence must be in [0.0, 1.0]'],
    ] as const)('rejects %s', (_name, options, message) => {
      expect(() => create(options as Partial<HttpDecisionModelOptions>)).toThrow(message)
    })

    it.each([
      'http://localhost:8000/v1/systemone',
      'http://127.0.0.1:8000/v1/systemone',
      'http://[::1]:8000/v1/systemone',
    ])('allows credentials over plain http to loopback %s', (endpoint) => {
      expect(() => create({ endpoint, auth: { type: 'bearer', token: 't' } })).not.toThrow()
    })

    it('allows an authorization header when no auth is set', () => {
      expect(() => create({ headers: { Authorization: 'Custom abc' } })).not.toThrow()
    })

    it('rejects construction in a browser', () => {
      vi.stubGlobal('window', {})

      expect(() => create()).toThrow('cannot run in a browser')
    })
  })
})
