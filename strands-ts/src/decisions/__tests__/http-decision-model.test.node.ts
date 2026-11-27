import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { sigV4Auth, type HttpDecisionModelAuth, type HttpDecisionModelOptions } from '../http-decision-model.node.js'
import {
  CREDENTIALS,
  LOCAL_ENDPOINT,
  LAMBDA_ENDPOINT,
  QUESTIONS,
  systemOneBody,
  fakeFetch,
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

describe('HttpDecisionModel in Node.js', () => {
  const auth: HttpDecisionModelAuth = (request) => request

  it('allows static headers over remote HTTP only with an explicit opt-in', async () => {
    const endpoint = 'http://decider:8000/v1/systemone'
    const headers = { 'x-api-key': 'key-1' }
    expect(() => create({ endpoint, headers, allowInsecureHttp: false })).toThrow(
      'auth and headers require an https endpoint'
    )
    const captured: CapturedRequest[] = []
    await create({
      endpoint,
      headers,
      allowInsecureHttp: true,
      fetch: fakeFetch(systemOneBody(), { captured }),
    }).ask('state', QUESTIONS)

    expect(captured[0]).toMatchObject({
      url: endpoint,
      headers: { 'x-api-key': 'key-1', 'content-type': 'application/json' },
      redirect: 'manual',
    })
  })

  it('adds a generic hint when an endpoint with static headers answers 403', async () => {
    const decision = create({
      endpoint: LAMBDA_ENDPOINT,
      headers: { 'x-api-key': 'key-1' },
      fetch: fakeFetch({ Message: 'Forbidden' }, { status: 403 }),
    })

    await expectModelError(
      decision.ask('state', QUESTIONS),
      'http decision request failed with HTTP 403: Forbidden | check the credentials and endpoint permissions'
    )
  })

  it('adds no hint without auth, or for other statuses', async () => {
    const unauthenticated = create({ fetch: fakeFetch({ Message: 'Forbidden' }, { status: 403 }) })
    const serverError = create({
      endpoint: LAMBDA_ENDPOINT,
      headers: { Authorization: 'Bearer t' },
      fetch: fakeFetch({ message: 'boom' }, { status: 500 }),
    })

    await expectModelError(
      unauthenticated.ask('state', QUESTIONS),
      'http decision request failed with HTTP 403: Forbidden'
    )
    await expect(serverError.ask('state', QUESTIONS)).rejects.toThrow(/HTTP 500: boom$/)
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
          'redirected (HTTP 307): set the endpoint to the redirect target'
        )
        expect(received).not.toHaveBeenCalled()
      } finally {
        await origin.close()
        await target.close()
      }
    })
  })

  it('sends a bearer token from the static headers, trimmed', async () => {
    const captured: CapturedRequest[] = []
    const decision = create({
      endpoint: 'https://gateway.example.com/prod/v1/systemone',
      headers: { Authorization: ' Bearer tok \n', 'x-api-key': 'key-1' },
      fetch: fakeFetch(systemOneBody(), { captured }),
    })

    await decision.ask('state', QUESTIONS)

    expect(captured[0]?.headers).toEqual({
      authorization: 'Bearer tok',
      'x-api-key': 'key-1',
      'content-type': 'application/json',
    })
  })

  it('passes auth the request about to be sent', async () => {
    const captured: CapturedRequest[] = []
    const seen: { url: string; headers: Record<string, string>; body: string }[] = []
    const auth: HttpDecisionModelAuth = async (request) => {
      seen.push({
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.clone().text(),
      })
      return request
    }
    const decision = create({
      auth,
      headers: { 'x-api-key': 'key-1' },
      fetch: fakeFetch(systemOneBody(), { captured }),
    })

    await decision.ask('state', QUESTIONS)

    expect(seen).toEqual([
      {
        url: LOCAL_ENDPOINT,
        headers: { 'x-api-key': 'key-1', 'content-type': 'application/json' },
        body: captured[0]?.rawBody,
      },
    ])
  })

  it('sends the request auth returns, which may be the same one, synchronously', async () => {
    const captured: CapturedRequest[] = []
    const decision = create({
      auth: (request) => {
        request.headers.set('authorization', 'Bearer tok')
        return request
      },
      headers: { 'content-type': 'text/plain', Authorization: 'Bearer other' },
      fetch: fakeFetch(systemOneBody(), { captured }),
    })

    await decision.ask('state', QUESTIONS)

    expect(captured[0]).toMatchObject({
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      redirect: 'manual',
    })
  })

  it('sends static headers without auth', async () => {
    const captured: CapturedRequest[] = []
    const decision = create({ headers: { 'x-api-key': 'key-1' }, fetch: fakeFetch(systemOneBody(), { captured }) })

    await decision.ask('state', QUESTIONS)

    expect(captured[0]?.headers).toEqual({ 'x-api-key': 'key-1', 'content-type': 'application/json' })
  })

  it.each([
    ['AWS_REGION', 'us-west-2'],
    ['AWS_DEFAULT_REGION', 'eu-central-1'],
  ])('takes the region from %s when none is given', async (variable, region) => {
    vi.stubEnv('AWS_REGION', undefined)
    vi.stubEnv('AWS_DEFAULT_REGION', undefined)
    vi.stubEnv(variable, region)
    const captured: CapturedRequest[] = []
    const decision = create({
      endpoint: LAMBDA_ENDPOINT,
      auth: sigV4Auth({ service: 'lambda', credentials: CREDENTIALS }),
      fetch: fakeFetch(systemOneBody(), { captured }),
    })

    await decision.ask('state', QUESTIONS)

    expect(captured[0]?.headers['authorization']).toContain(`/${region}/lambda/aws4_request`)
  })

  it('prefers an explicit region to the environment', async () => {
    vi.stubEnv('AWS_REGION', 'us-west-2')
    const captured: CapturedRequest[] = []
    const decision = create({
      endpoint: LAMBDA_ENDPOINT,
      auth: sigV4Auth({ service: 'lambda', region: 'ap-south-1', credentials: CREDENTIALS }),
      fetch: fakeFetch(systemOneBody(), { captured }),
    })

    await decision.ask('state', QUESTIONS)

    expect(captured[0]?.headers['authorization']).toContain('/ap-south-1/lambda/aws4_request')
  })

  it('signs a non-default port, a path, and static headers', async () => {
    const captured: CapturedRequest[] = []
    const decision = create({
      endpoint: 'http://127.0.0.1:8123/prod/v1/system%20one',
      auth: sigV4Auth({ service: 'execute-api', region: 'eu-west-1', credentials: CREDENTIALS }),
      headers: { 'x-api-key': 'key-1' },
      fetch: fakeFetch(systemOneBody(), { captured }),
    })

    await decision.ask('state', QUESTIONS)

    const [request] = captured
    expect(request?.headers['authorization']).toMatch(/SignedHeaders=[^,]*x-api-key/)
    expect(request?.headers['authorization']).toBe(await expectedSignature(request!, 'execute-api', 'eu-west-1'))
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
      auth: sigV4Auth({ service: 'lambda', region: 'us-east-1' }),
      fetch: fakeFetch(systemOneBody(), { captured }),
    })

    await decision.ask('state', QUESTIONS)

    expect(captured[0]?.headers['authorization']).toContain('Credential=AKIDFROMENV/')
  })

  it.each([
    ['an invalid endpoint', { endpoint: 'not a url' }, 'endpoint must be a valid URL'],
    ['an endpoint without a scheme', { endpoint: 'localhost:8000/v1/systemone' }, 'endpoint must use http or https'],
    [
      'credentials in the endpoint',
      { endpoint: 'https://user:hunter2@example.com/v1/systemone' },
      'endpoint must not contain credentials',
    ],
    [
      'an auth that is not a function',
      { auth: { type: 'bearer', token: 't' } as unknown as HttpDecisionModelOptions['auth'] },
      'auth must be a function',
    ],
    [
      'auth over plain http to a remote host',
      { endpoint: 'http://example.com/v1/systemone', auth },
      'auth and headers require an https endpoint',
    ],
    [
      'auth over plain http to a host that only starts with localhost',
      { endpoint: 'http://localhost.evil.com/v1/systemone', auth },
      'auth and headers require an https endpoint',
    ],
    [
      'sigv4 over plain http to a remote host',
      {
        endpoint: 'http://abc.lambda-url.us-east-1.on.aws/v1/systemone',
        auth: sigV4Auth({ service: 'lambda', region: 'us-east-1' }),
      },
      'auth and headers require an https endpoint',
    ],
    ['an invalid header name', { headers: { 'bad name': 'x' } }, 'headers must have valid names'],
    ['a header value with a newline inside', { headers: { 'x-api-key': 'abc\ndef' } }, 'headers must have valid names'],
    [
      'a secret header over plain http to a remote host',
      { endpoint: 'http://example.com/v1/systemone', headers: { 'x-api-key': 'k' } },
      'auth and headers require an https endpoint',
    ],
    ['a zero timeout', { timeoutMs: 0 }, 'timeoutMs must be greater than 0 and at most 2147483647'],
    ['a non-numeric timeout', { timeoutMs: Number.NaN }, 'timeoutMs must be greater than 0'],
    ['a timeout above the timer limit', { timeoutMs: 2 ** 31 }, 'timeoutMs must be greater than 0'],
    ['an out-of-range confidence', { defaultMinConfidence: 1.5 }, 'defaultMinConfidence must be in [0.0, 1.0]'],
  ] as const)('rejects %s', (_name, options, message) => {
    expect(() => create(options as Partial<HttpDecisionModelOptions>)).toThrow(message)
  })

  it('allows an authorization header when no auth is set', () => {
    expect(() => create({ headers: { Authorization: 'Custom abc' } })).not.toThrow()
  })

  it('allows a signature header name without sigv4', () => {
    expect(() => create({ headers: { 'x-amz-date': 'x' } })).not.toThrow()
  })

  it('requires a region from the option or the environment', () => {
    vi.stubEnv('AWS_REGION', undefined)
    vi.stubEnv('AWS_DEFAULT_REGION', undefined)

    expect(() => sigV4Auth({ service: 'lambda' })).toThrow(
      'sigV4Auth requires a region: pass region or set AWS_REGION or AWS_DEFAULT_REGION'
    )
  })
})
