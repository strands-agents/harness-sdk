import { doesIdentityRequireRefresh, isIdentityExpired, memoizeIdentityProvider } from '@smithy/core'
import { Sha256 } from '@smithy/core/checksum'
import { SignatureV4 } from '@smithy/signature-v4'

import { ModelError } from '../errors.js'
import { DecisionModel } from './decision-model.js'
import {
  askSystemOne,
  httpTransport,
  resolveDefaultMinConfidence,
  SystemOneHttpError,
  type SystemOneRequestConfig,
  type SystemOneTransport,
} from './system-one-http-adapter.js'
import type { DecisionCallOptions, DecisionInput, DecisionResult, Question } from './types.js'

const CLASS_NAME = 'HttpDecisionModel'
const PROVIDER_NAME = 'http'
const DEFAULT_MIN_CONFIDENCE = 0.5
const DEFAULT_TIMEOUT_MS = 60_000
/** The largest delay `setTimeout` accepts; outside (0, MAX] the timer fires after 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/** AWS credentials used to sign a request. */
export interface SigV4Credentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  /** Present on temporary credentials, which are the only kind {@link sigV4Auth} accepts in a browser. */
  readonly sessionToken?: string
  /** When the credentials expire. A provider is called again shortly before this. */
  readonly expiration?: Date
}

/**
 * Authenticates one request: receives the request about to be sent and returns it with authentication added,
 * typically headers. It runs on every request, under the request's timeout and cancellation. A returned URL must
 * still be https unless its host is loopback. Use {@link sigV4Auth} for AWS Signature Version 4.
 *
 * To read the body, read a `request.clone()`: a request whose body was read cannot be sent.
 */
export type HttpDecisionModelAuth = (request: Request) => Request | Promise<Request>

/** Options for {@link sigV4Auth}. */
export interface SigV4AuthOptions {
  /**
   * Service to sign for: `lambda` for a Lambda Function URL with `AWS_IAM` auth, `execute-api` for API
   * Gateway with IAM auth.
   */
  readonly service: string
  /** AWS region to sign for. Defaults to the `AWS_REGION` or `AWS_DEFAULT_REGION` environment variable. */
  readonly region?: string
  /**
   * Static credentials or a provider such as `fromCognitoIdentityPool()`. A provider's result is reused until
   * it nears its `expiration`, as in an AWS SDK client. In Node.js it defaults to the standard AWS credential
   * chain; elsewhere it is required. In a browser the credentials must be temporary.
   */
  readonly credentials?: SigV4Credentials | (() => Promise<SigV4Credentials>)
}

/** Options for constructing an {@link HttpDecisionModel}. */
export interface HttpDecisionModelOptions {
  /**
   * Full URL of the System One endpoint, such as `http://localhost:8000/v1/systemone`. The endpoint must not
   * redirect: a redirect fails the request.
   *
   * With `auth` or `headers`, the URL must be `https` unless the host is `localhost`, `127.0.0.1` or `[::1]`,
   * so a credential is never sent in clear text. A server on a private network needs https as well.
   */
  readonly endpoint: string
  /**
   * Authenticates each request, such as `sigV4Auth({ service: 'lambda' })`. Omit for a server that needs no
   * authentication, such as a local one or your own backend behind the page's session cookie.
   */
  readonly auth?: HttpDecisionModelAuth
  /**
   * Static request headers, such as `Authorization: Bearer <token>` or `x-api-key` for API Gateway. They are
   * treated as secrets: they need an `https` endpoint unless the host is loopback, and they are rejected in a
   * browser, where every user of the page could read them; return a per-user token from `auth` instead.
   */
  readonly headers?: Readonly<Record<string, string>>
  /** Default minimum confidence. Defaults to `0.5`. */
  readonly defaultMinConfidence?: number
  /**
   * Aborts a request that takes longer than this many milliseconds, counting `auth` and the response body.
   * At most 2147483647. Defaults to `60000`, which is longer than API Gateway's 29 second limit.
   */
  readonly timeoutMs?: number
  /** Custom fetch implementation, primarily for transport configuration and tests. It receives a `Request`. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * Decision model backed by any server that speaks the System One wire format over HTTP, such as a
 * local `strands-decider` server, a Lambda Function URL, or an API Gateway route.
 *
 * Results report `http` as the provider name and the model the server names in its response.
 *
 * @example
 * ```typescript
 * import { HttpDecisionModel, sigV4Auth } from '@strands-agents/sdk/decisions/http'
 *
 * // A local server needs no authentication.
 * const local = new HttpDecisionModel({ endpoint: 'http://localhost:8000/v1/systemone' })
 *
 * // A Lambda Function URL with AWS_IAM auth, signed with the standard AWS credential chain.
 * const lambda = new HttpDecisionModel({
 *   endpoint: 'https://abc123.lambda-url.us-east-1.on.aws/v1/systemone',
 *   auth: sigV4Auth({ service: 'lambda', region: 'us-east-1' }),
 * })
 *
 * // An API Gateway route, with a token fetched per request.
 * const gateway = new HttpDecisionModel({
 *   endpoint: 'https://api.example.com/v1/systemone',
 *   auth: async (request) => {
 *     request.headers.set('authorization', `Bearer ${await getToken()}`)
 *     return request
 *   },
 * })
 * ```
 */
export class HttpDecisionModel extends DecisionModel {
  private readonly _requestConfig: SystemOneRequestConfig
  private readonly _transport: SystemOneTransport
  private readonly _sendsCredentials: boolean

  /**
   * @param options - Endpoint, authentication, and request configuration.
   * @throws Error if the endpoint, authentication, headers, timeout, or confidence threshold is invalid, or if
   * `headers` is set in a browser.
   */
  constructor(options: HttpDecisionModelOptions) {
    super()
    const endpoint = parseEndpoint(options.endpoint)
    const headers = parseHeaders(options.headers)
    const { auth } = options
    if (auth !== undefined && typeof auth !== 'function') {
      throw new Error(`${CLASS_NAME} auth must be a function, such as sigV4Auth()`)
    }
    const hasHeaders = Object.keys(headers).length > 0
    if (hasHeaders && inBrowser()) {
      throw new Error(
        `${CLASS_NAME} headers would be readable by every user of the page: return a per-user token from auth instead`
      )
    }
    this._sendsCredentials = auth !== undefined || hasHeaders
    if (this._sendsCredentials) requireHttps(endpoint)
    const baseFetch = options.fetch ?? globalThis.fetch
    if (typeof baseFetch !== 'function') throw new Error(`${CLASS_NAME} requires a fetch implementation`)

    const config = {
      providerName: PROVIDER_NAME,
      endpoint: endpoint.href,
      defaultMinConfidence: resolveDefaultMinConfidence(
        options.defaultMinConfidence ?? DEFAULT_MIN_CONFIDENCE,
        CLASS_NAME
      ),
      fetch: guardedFetch(baseFetch, headers, auth, parseTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    }
    this._requestConfig = config
    this._transport = httpTransport(config)
  }

  protected async _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
    options: DecisionCallOptions
  ): Promise<DecisionResult<Q>> {
    try {
      return await askSystemOne(this._requestConfig, this._transport, state, questions, options.cancelSignal)
    } catch (error) {
      // The server's own message, such as a Lambda's "Forbidden", does not say what to check.
      if (this._sendsCredentials && isAuthFailure(error)) {
        throw new ModelError(
          `${error.message} | check the credentials, and for sigv4 the IAM permission, region and service`,
          { cause: error.cause }
        )
      }
      throw error
    }
  }
}

/**
 * Returns an {@link HttpDecisionModelAuth} that signs each request with AWS Signature Version 4.
 *
 * @param options - What to sign for and with.
 * @throws Error if the service is empty, no region is given or set in the environment, or credentials are
 * omitted outside Node.js.
 */
export function sigV4Auth(options: SigV4AuthOptions): HttpDecisionModelAuth {
  const service = options.service?.trim()
  if (!service) throw new Error('sigV4Auth requires a service')
  const env = globalThis.process?.env
  const region = options.region?.trim() || env?.AWS_REGION || env?.AWS_DEFAULT_REGION
  if (!region) throw new Error('sigV4Auth requires a region: pass region or set AWS_REGION or AWS_DEFAULT_REGION')
  if (options.credentials === undefined) {
    throw new Error('sigV4Auth requires credentials outside Node.js, such as from fromCognitoIdentityPool()')
  }
  // Defined, because the provider passed in is.
  const credentials = memoizeIdentityProvider(options.credentials, isIdentityExpired, doesIdentityRequireRefresh)!
  const signer = new SignatureV4({
    service,
    region,
    sha256: Sha256,
    credentials: inBrowser() ? (): Promise<SigV4Credentials> => requireTemporary(credentials()) : credentials,
  })

  return async (request) => {
    const url = new URL(request.url)
    const signed = await signer.sign({
      method: request.method,
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query: queryOf(url.searchParams),
      // The signed `host` carries a non-default port, as fetch's does.
      headers: { ...Object.fromEntries(request.headers), host: url.host },
      body: await request.clone().text(),
    })
    // fetch derives `host` itself.
    const { host: _host, ...headers } = signed.headers
    return new Request(request, { headers })
  }
}

/** Long-term access keys sent from a browser are readable by every user of the page. */
async function requireTemporary(pending: Promise<SigV4Credentials>): Promise<SigV4Credentials> {
  const credentials = await pending
  if (!credentials.sessionToken) {
    throw new Error('sigV4Auth in a browser requires temporary credentials with a sessionToken')
  }
  return credentials
}

function queryOf(params: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {}
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name)
    query[name] = values.length === 1 ? values[0]! : values
  }
  return query
}

function inBrowser(): boolean {
  return typeof window !== 'undefined'
}

function isAuthFailure(error: unknown): error is ModelError & { cause: SystemOneHttpError } {
  return (
    error instanceof ModelError &&
    error.cause instanceof SystemOneHttpError &&
    (error.cause.status === 401 || error.cause.status === 403)
  )
}

function parseEndpoint(value: string): URL {
  const endpoint = new URL(value)
  // `localhost:8000/v1` parses with the scheme `localhost:`, and fetch would only fail on the first request.
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error(`${CLASS_NAME} endpoint must use http or https`)
  }
  // fetch echoes a URL's password in its own error message.
  if (endpoint.username !== '' || endpoint.password !== '') {
    throw new Error(`${CLASS_NAME} endpoint must not contain credentials: use auth instead`)
  }
  return endpoint
}

function parseHeaders(headers: HttpDecisionModelOptions['headers']): Record<string, string> {
  try {
    return Object.fromEntries(new Headers(headers))
  } catch {
    // `new Headers` quotes the offending value, which may be a secret.
    throw new Error(`${CLASS_NAME} headers must have valid names and printable values`)
  }
}

function parseTimeout(timeoutMs: number): number {
  if (!(timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
    throw new Error(`${CLASS_NAME} timeoutMs must be greater than 0 and at most ${MAX_TIMEOUT_MS}`)
  }
  return timeoutMs
}

/** A credential, signature or secret header sent in clear text is readable on the network. */
function requireHttps(url: URL): void {
  if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new Error(`${CLASS_NAME} auth and headers require an https endpoint unless the host is loopback`)
  }
}

/**
 * Wraps `fetch` with the static headers, `auth`, the timeout and redirect handling, so the shared transport
 * stays unaware of them. The timeout covers `auth`, the request and the response body.
 */
function guardedFetch(
  baseFetch: typeof globalThis.fetch,
  headers: Record<string, string>,
  auth: HttpDecisionModelAuth | undefined,
  timeoutMs: number
): typeof globalThis.fetch {
  return async (input, init) => {
    const cancelSignal = init?.signal ?? undefined
    cancelSignal?.throwIfAborted()
    const controller = new AbortController()
    const { signal } = controller
    const timer = setTimeout(
      () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      timeoutMs
    )
    const cancel = (): void => controller.abort(cancelSignal?.reason)
    cancelSignal?.addEventListener('abort', cancel, { once: true })
    try {
      // `redirect: 'manual'`: following a redirect would replay the request's headers and body to another host.
      const request = new Request(input, {
        ...init,
        headers: mergeHeaders(headers, init?.headers),
        redirect: 'manual',
        signal,
      })
      // `auth` can stall on a credential lookup, so it runs under the same timeout and cancel signal.
      const authenticated = auth ? await abortable(Promise.resolve(request).then(auth), signal) : request
      if (auth) requireHttps(new URL(authenticated.url))
      const response = await baseFetch(authenticated, { redirect: 'manual', signal })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`redirected (HTTP ${response.status}): set the endpoint to the redirect target`)
      }
      // Read the body here, under the timeout, so a slow or dropped body fails as a request error. A 204 or 205
      // cannot be rebuilt with a body, even an empty one.
      const text = await response.text()
      return new Response(text === '' ? null : text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } finally {
      clearTimeout(timer)
      cancelSignal?.removeEventListener('abort', cancel)
    }
  }
}

/** Merges header sets case-insensitively, later sets winning, so the transport's `Content-Type` replaces a static one. */
function mergeHeaders(...sets: (HeadersInit | undefined)[]): Headers {
  const merged = new Headers()
  for (const set of sets) new Headers(set).forEach((value, name) => merged.set(name, value))
  return merged
}

/** Settles like `promise`, or rejects with the signal's reason when the not-yet-aborted `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
