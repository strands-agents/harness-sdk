import http from 'node:http'
import type { AddressInfo } from 'node:net'

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
  redirect: RequestRedirect | undefined
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
      redirect: init?.redirect,
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

/** A fetch that answers with headers at once and then streams a body that fails or stalls, like a dropped connection. */
function brokenBodyFetch(mode: 'reset' | 'stall'): typeof globalThis.fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = new ReadableStream({
      start(controller) {
        if (mode === 'reset') controller.error(new TypeError('terminated'))
        else init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason))
      },
    })
    return new Response(body, { status: 200 })
  }) as typeof globalThis.fetch
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
          redirect: 'manual',
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

    it('defaults the minimum confidence to 0.5', async () => {
      // A yes probability of 0.7 is a confidence of 0.4.
      const fetch = fakeFetch(systemOneBody(0.7))

      const result = await create({ fetch }).ask('state', QUESTIONS)
      const permissive = await create({ fetch, defaultMinConfidence: 0 }).ask('state', QUESTIONS)

      expect(result.answers.urgent).toBeInstanceOf(Uncertain)
      expect(permissive.answers.urgent).toBe(true)
    })

    it.each([
      [
        'a sigv4 endpoint',
        { type: 'sigv4', region: 'us-east-1', service: 'lambda', credentials: CREDENTIALS },
        'check the IAM permission, region and service name',
      ],
      ['a bearer endpoint', { type: 'bearer', token: 't' }, 'check the token'],
    ] as const)('adds a hint when %s answers 403', async (_name, auth, hint) => {
      const decision = create({
        endpoint: LAMBDA_ENDPOINT,
        auth,
        fetch: fakeFetch({ Message: 'Forbidden' }, { status: 403 }),
      })

      const error = await decision.ask('state', QUESTIONS).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ModelError)
      expect((error as Error).message).toBe(`http decision request failed with HTTP 403: Forbidden | ${hint}`)
    })

    it('adds no hint without auth, or for other statuses', async () => {
      const unauthenticated = create({ fetch: fakeFetch({ Message: 'Forbidden' }, { status: 403 }) })
      const serverError = create({
        endpoint: LAMBDA_ENDPOINT,
        auth: { type: 'bearer', token: 't' },
        fetch: fakeFetch({ message: 'boom' }, { status: 500 }),
      })

      await expect(unauthenticated.ask('state', QUESTIONS)).rejects.toThrow(/HTTP 403: Forbidden$/)
      await expect(serverError.ask('state', QUESTIONS)).rejects.toThrow(/HTTP 500: boom$/)
    })

    it('maps HTTP failures to model errors that name the provider and status', async () => {
      const throttled = create({ fetch: fakeFetch({ error: 'slow down' }, { status: 429 }) })
      const forbidden = create({ fetch: fakeFetch({ message: 'Forbidden' }, { status: 403 }) })

      await expect(throttled.ask('state', QUESTIONS)).rejects.toBeInstanceOf(ModelThrottledError)
      await expect(forbidden.ask('state', QUESTIONS)).rejects.toThrow('http decision request failed with HTTP 403')
      await expect(forbidden.ask('state', QUESTIONS)).rejects.toBeInstanceOf(ModelError)
    })

    it.each([
      ['a capitalized Message, as a Lambda Function URL answers', 403, { Message: 'Forbidden' }, 'HTTP 403: Forbidden'],
      [
        'a validation error list, as strands-decider answers',
        422,
        { detail: [{ loc: ['body', 'questions'], msg: 'Field required' }, { msg: 'Too short' }] },
        'HTTP 422: Field required; Too short',
      ],
    ])('reports the detail of %s', async (_name, status, payload, message) => {
      const decision = create({ fetch: fakeFetch(payload, { status }) })

      await expect(decision.ask('state', QUESTIONS)).rejects.toThrow(message)
    })

    it('reports a connection that drops mid-body as a model error', async () => {
      const decision = create({ fetch: brokenBodyFetch('reset') })

      const error = await decision.ask('state', QUESTIONS).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ModelError)
      expect((error as Error).message).toBe('http decision request failed: terminated')
    })
  })

  describe('redirects', () => {
    /** Starts a loopback server that answers every request with `handler` and returns its URL. */
    async function serve(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
      const server = http.createServer(handler)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      }
    }

    it('fails instead of replaying the request to the redirect target', async () => {
      const received = vi.fn()
      const target = await serve((_req, res) => {
        received()
        res.end('{}')
      })
      const origin = await serve((_req, res) => {
        res.writeHead(307, { Location: `${target.url}/v1/systemone` }).end()
      })
      try {
        const decision = create({ endpoint: `${origin.url}/v1/systemone`, headers: { 'x-api-key': 'key-1' } })

        await expect(decision.ask('state', QUESTIONS)).rejects.toThrow(
          `redirected (HTTP 307) to ${target.url}/v1/systemone: set the endpoint to the redirect target`
        )
        expect(received).not.toHaveBeenCalled()
      } finally {
        await origin.close()
        await target.close()
      }
    })

    it('names the target of a trailing-slash redirect without its query', async () => {
      const origin = await serve((_req, res) => {
        res.writeHead(307, { Location: '/v1/systemone?token=abc' }).end()
      })
      try {
        const decision = create({ endpoint: `${origin.url}/v1/systemone/` })

        await expect(decision.ask('state', QUESTIONS)).rejects.toThrow(
          `redirected (HTTP 307) to ${origin.url}/v1/systemone: set the endpoint`
        )
      } finally {
        await origin.close()
      }
    })
  })

  describe('timeout', () => {
    it('defaults to 60 seconds', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout')

      await create({ fetch: fakeFetch() }).ask('state', QUESTIONS)

      expect(timeout).toHaveBeenCalledWith(60_000)
    })

    it('aborts a request that exceeds timeoutMs', async () => {
      const decision = create({ fetch: hangingFetch(), timeoutMs: 20 })

      const error = await decision.ask('state', QUESTIONS).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ModelError)
      expect((error as Error).message).toBe('http decision request timed out after 20ms')
    })

    it('covers reading the response body', async () => {
      const decision = create({ fetch: brokenBodyFetch('stall'), timeoutMs: 20 })

      await expect(decision.ask('state', QUESTIONS)).rejects.toThrow('timed out after 20ms')
    })

    it('reports a caller cancel as a failed request, not a timeout', async () => {
      const decision = create({ fetch: hangingFetch(), timeoutMs: 60_000 })
      const controller = new AbortController()

      const pending = decision.ask('state', QUESTIONS, { cancelSignal: controller.signal })
      controller.abort(new Error('stop'))

      const error = await pending.catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ModelError)
      expect((error as Error).message).toBe('http decision request failed: stop')
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

      await expect(pending).rejects.toThrow('http decision request failed: boom')
    })
  })

  describe('bearer auth', () => {
    it('sends the token and static headers', async () => {
      const captured: CapturedRequest[] = []
      const decision = create({
        endpoint: 'https://gateway.example.com/prod/v1/systemone',
        auth: { type: 'bearer', token: ' tok \n' },
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
          ...(url.port !== '' && { port: Number(url.port) }),
          path: url.pathname,
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

    it('signs a non-default port, a path, and static headers', async () => {
      const captured: CapturedRequest[] = []
      const decision = create({
        endpoint: 'http://127.0.0.1:8123/prod/v1/system%20one',
        auth: { type: 'sigv4', region: 'eu-west-1', service: 'execute-api', credentials: CREDENTIALS },
        headers: { 'x-api-key': 'key-1' },
        fetch: fakeFetch(systemOneBody(), { captured }),
      })

      await decision.ask('state', QUESTIONS)

      const [request] = captured
      expect(request?.headers['authorization']).toMatch(/SignedHeaders=[^,]*x-api-key/)
      expect(request?.headers['authorization']).toBe(await expectedSignature(request!, 'execute-api', 'eu-west-1'))
    })

    it('signs the body that is sent, whatever the state contains', async () => {
      const captured: CapturedRequest[] = []
      const decision = create({
        endpoint: LAMBDA_ENDPOINT,
        auth: { type: 'sigv4', region: 'us-east-1', service: 'lambda', credentials: CREDENTIALS },
        fetch: fakeFetch(systemOneBody(), { captured }),
      })

      await decision.ask('Remboursement \u00e9t\u00e9 \u2603 \u{1F600}', QUESTIONS)

      expect(captured[0]?.headers['authorization']).toBe(await expectedSignature(captured[0]!, 'lambda', 'us-east-1'))
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

    it('does not report a credential failure as a failed request, and recovers on the next call', async () => {
      const fetch = fakeFetch()
      const provider = vi
        .fn<() => Promise<typeof CREDENTIALS>>()
        .mockRejectedValueOnce(new Error('no credentials'))
        .mockResolvedValue(CREDENTIALS)
      const decision = create({
        endpoint: LAMBDA_ENDPOINT,
        auth: { type: 'sigv4', region: 'us-east-1', service: 'lambda', credentials: provider },
        fetch,
      })

      await expect(decision.ask('state', QUESTIONS)).rejects.toThrow('no credentials')
      expect(fetch).not.toHaveBeenCalled()

      await expect(decision.ask('state', QUESTIONS)).resolves.toBeDefined()
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('stalled credentials', () => {
    const stalled = (): Promise<typeof CREDENTIALS> => new Promise(() => {})
    const sigv4 = { type: 'sigv4', region: 'us-east-1', service: 'lambda', credentials: stalled } as const

    it('times out a credential lookup that never answers', async () => {
      const fetch = fakeFetch()
      const decision = create({ endpoint: LAMBDA_ENDPOINT, auth: sigv4, timeoutMs: 20, fetch })

      await expect(decision.ask('state', QUESTIONS)).rejects.toThrow('http decision request timed out after 20ms')
      expect(fetch).not.toHaveBeenCalled()
    })

    it('cancels a credential lookup that never answers', async () => {
      const decision = create({ endpoint: LAMBDA_ENDPOINT, auth: sigv4, fetch: fakeFetch() })
      const controller = new AbortController()

      const pending = decision.ask('state', QUESTIONS, { cancelSignal: controller.signal })
      controller.abort(new Error('stop'))

      await expect(pending).rejects.toThrow('http decision request failed: stop')
    })
  })

  describe('constructor validation', () => {
    const bearer = { type: 'bearer', token: 't' } as const

    it.each([
      ['an invalid endpoint', { endpoint: 'not a url' }, 'endpoint must be a valid URL'],
      ['a non-http endpoint', { endpoint: 'ftp://example.com/x' }, 'endpoint must use http or https'],
      [
        'credentials in the endpoint',
        { endpoint: 'https://user:hunter2@example.com/v1/systemone' },
        'endpoint must not contain credentials',
      ],
      [
        'a query string in the endpoint',
        { endpoint: 'https://example.com/v1/systemone?stage=a' },
        'endpoint must not contain a query string or fragment',
      ],
      [
        'a fragment in the endpoint',
        { endpoint: 'https://example.com/v1/systemone#frag' },
        'endpoint must not contain a query string or fragment',
      ],
      ['an empty bearer token', { auth: { type: 'bearer', token: '  ' } }, 'bearer token must be non-empty'],
      ['a bearer token with a space', { auth: { type: 'bearer', token: 'a b' } }, 'bearer token must be non-empty'],
      ['a bearer token with a newline', { auth: { type: 'bearer', token: 'a\nb' } }, 'bearer token must be non-empty'],
      [
        'sigv4 without a region',
        { endpoint: LAMBDA_ENDPOINT, auth: { type: 'sigv4', region: '', service: 'lambda' } },
        'sigv4 region must contain only',
      ],
      [
        'sigv4 with a space in the region',
        { endpoint: LAMBDA_ENDPOINT, auth: { type: 'sigv4', region: 'us east', service: 'lambda' } },
        'sigv4 region must contain only',
      ],
      [
        'sigv4 without a service',
        { endpoint: LAMBDA_ENDPOINT, auth: { type: 'sigv4', region: 'us-east-1', service: ' ' } },
        'sigv4 service must contain only',
      ],
      [
        'an unknown auth type',
        { auth: { type: 'basic' } as unknown as HttpDecisionModelOptions['auth'] },
        "auth type must be 'bearer' or 'sigv4'",
      ],
      [
        'a bearer token over plain http to a remote host',
        { endpoint: 'http://example.com/v1/systemone', auth: bearer },
        'auth and headers require an https endpoint',
      ],
      [
        'a bearer token over plain http to a host that only starts with localhost',
        { endpoint: 'http://localhost.evil.com/v1/systemone', auth: bearer },
        'auth and headers require an https endpoint',
      ],
      [
        'sigv4 over plain http to a remote host',
        {
          endpoint: 'http://abc.lambda-url.us-east-1.on.aws/v1/systemone',
          auth: { type: 'sigv4', region: 'us-east-1', service: 'lambda' },
        },
        'auth and headers require an https endpoint',
      ],
      [
        'an authorization header alongside auth',
        { auth: bearer, headers: { Authorization: 'x' } },
        "cannot set 'Authorization'",
      ],
      ['a content-type header', { headers: { 'Content-Type': 'text/plain' } }, "cannot set 'Content-Type'"],
      ['a content-length header', { headers: { 'Content-Length': '1' } }, "cannot set 'Content-Length'"],
      ['a host header', { headers: { host: 'other' } }, "cannot set 'host'"],
      [
        'a signature header alongside sigv4',
        {
          endpoint: LAMBDA_ENDPOINT,
          auth: { type: 'sigv4', region: 'us-east-1', service: 'lambda' },
          headers: { 'X-Amz-Date': '20240101T000000Z' },
        },
        "cannot set 'X-Amz-Date'",
      ],
      ['an invalid header name', { headers: { 'bad name': 'x' } }, "header name 'bad name' is not valid"],
      ['a header value with a newline', { headers: { 'x-api-key': 'abc\n' } }, "header 'x-api-key' must be a string"],
      [
        'a header value above U+00FF',
        { headers: { 'x-note': 'a\u2028b' } },
        "header 'x-note' must be a string of printable characters up to U+00FF",
      ],
      ['a transfer-encoding header', { headers: { 'Transfer-Encoding': 'chunked' } }, "cannot set 'Transfer-Encoding'"],
      ['an expect header', { headers: { Expect: '100-continue' } }, "cannot set 'Expect'"],
      ['an upgrade header', { headers: { Upgrade: 'websocket' } }, "cannot set 'Upgrade'"],
      ['a keep-alive header', { headers: { 'Keep-Alive': 'timeout=5' } }, "cannot set 'Keep-Alive'"],
      [
        'header names that differ only by case',
        { headers: { 'X-Foo': 'a', 'x-foo': 'b' } },
        "header 'x-foo' is set more than once",
      ],
      [
        'a secret header over plain http to a remote host',
        { endpoint: 'http://example.com/v1/systemone', headers: { 'x-api-key': 'k' } },
        'auth and headers require an https endpoint',
      ],
      ['a zero timeout', { timeoutMs: 0 }, 'timeoutMs must be an integer from 1 to 2147483647'],
      ['a fractional timeout', { timeoutMs: 1.5 }, 'timeoutMs must be an integer'],
      ['a non-finite timeout', { timeoutMs: Number.POSITIVE_INFINITY }, 'timeoutMs must be an integer'],
      ['a timeout above the timer limit', { timeoutMs: 2 ** 31 }, 'timeoutMs must be an integer'],
      ['an out-of-range confidence', { defaultMinConfidence: 1.5 }, 'defaultMinConfidence must be in [0.0, 1.0]'],
    ] as const)('rejects %s', (_name, options, message) => {
      expect(() => create(options as Partial<HttpDecisionModelOptions>)).toThrow(message)
    })

    it('never echoes a secret in a validation error', () => {
      const errors = [
        () => create({ endpoint: 'https://user:hunter2@example.com/v1/systemone' }),
        () => create({ headers: { 'x-api-key': 'hunter2\n' } }),
        () => create({ auth: { type: 'bearer', token: 'hunter2 with space' } }),
      ].map((attempt) => {
        try {
          attempt()
        } catch (error) {
          return (error as Error).message
        }
        return ''
      })

      expect(errors).toHaveLength(3)
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
      expect(() => create({ endpoint, auth: bearer })).not.toThrow()
    })

    it('allows an authorization header when no auth is set', () => {
      expect(() => create({ headers: { Authorization: 'Custom abc' } })).not.toThrow()
    })

    it('allows a signature header name without sigv4', () => {
      expect(() => create({ headers: { 'x-amz-date': 'x' } })).not.toThrow()
    })

    it('rejects construction in a browser', () => {
      vi.stubGlobal('window', {})

      expect(() => create()).toThrow('cannot run in a browser')
    })
  })
})
