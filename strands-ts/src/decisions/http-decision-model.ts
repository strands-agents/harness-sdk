import { defaultProvider } from '@aws-sdk/credential-provider-node'
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
/** The largest delay `setTimeout` accepts; above it the timer fires after 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/** AWS credentials used to sign a request. */
export interface SigV4Credentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  /** When the credentials expire. A provider is called again shortly before this. */
  readonly expiration?: Date
}

/**
 * Returns the headers that authenticate one request, given the request about to be sent: the endpoint URL,
 * the static headers with the `content-type`, and the JSON body. It runs on every request, under the
 * request's timeout and cancellation, and its headers replace static headers of the same name.
 * Use {@link sigV4Auth} for AWS Signature Version 4.
 */
export type HttpDecisionModelAuth = (request: {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}) => Promise<Record<string, string>>

/** Options for constructing an {@link HttpDecisionModel}. */
export interface HttpDecisionModelOptions {
  /**
   * Full URL of the System One endpoint, such as `http://localhost:8000/v1/systemone`. It must not contain
   * a query string. The endpoint must not redirect: a redirect fails the request.
   *
   * With `auth` or `headers`, the URL must be `https` unless the host is `localhost`, `127.0.0.1` or `[::1]`,
   * so a credential is never sent in clear text. A server on a private network needs https as well.
   */
  readonly endpoint: string
  /**
   * Authenticates each request, such as `sigV4Auth({ service: 'lambda' })`. A static token goes in `headers`
   * instead. Omit for a server that needs no authentication, such as a local one.
   */
  readonly auth?: HttpDecisionModelAuth
  /**
   * Static request headers, such as `Authorization: Bearer <token>` or `x-api-key` for API Gateway. They are
   * treated as secrets: they need an `https` endpoint unless the host is loopback.
   */
  readonly headers?: Readonly<Record<string, string>>
  /** Default minimum confidence. Defaults to `0.5`. */
  readonly defaultMinConfidence?: number
  /**
   * Aborts a request that takes longer than this many milliseconds, counting `auth` and the response body.
   * An integer from 1 to 2147483647. Defaults to `60000`, which is longer than API Gateway's 29 second limit.
   */
  readonly timeoutMs?: number
  /** Custom fetch implementation, primarily for transport configuration and tests. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * Decision model backed by any server that speaks the System One wire format over HTTP, such as a
 * local `strands-decider` server, a Lambda Function URL, or an API Gateway route. Runs on the server only.
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
 * // An API Gateway route with a bearer token.
 * const gateway = new HttpDecisionModel({
 *   endpoint: 'https://api.example.com/v1/systemone',
 *   headers: { Authorization: `Bearer ${token}` },
 * })
 * ```
 */
export class HttpDecisionModel extends DecisionModel {
  private readonly _requestConfig: SystemOneRequestConfig
  private readonly _transport: SystemOneTransport
  private readonly _sendsCredentials: boolean

  /**
   * @param options - Endpoint, authentication, and request configuration.
   * @throws Error if run in a browser, or if the endpoint, authentication, headers, timeout, or confidence
   * threshold is invalid.
   */
  constructor(options: HttpDecisionModelOptions) {
    super()
    if (typeof window !== 'undefined') {
      throw new Error(`${CLASS_NAME} cannot run in a browser because it would expose its credentials`)
    }

    const endpoint = parseEndpoint(options.endpoint)
    const headers = parseHeaders(options.headers)
    const { auth } = options
    if (auth !== undefined && typeof auth !== 'function') {
      throw new Error(`${CLASS_NAME} auth must be a function, such as sigV4Auth()`)
    }
    this._sendsCredentials = auth !== undefined || Object.keys(headers).length > 0
    // A credential, signature or secret header sent in clear text is readable on the network.
    if (this._sendsCredentials && endpoint.protocol !== 'https:' && !LOOPBACK_HOSTS.includes(endpoint.hostname)) {
      throw new Error(`${CLASS_NAME} auth and headers require an https endpoint unless the host is loopback`)
    }
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

function isAuthFailure(error: unknown): error is ModelError & { cause: SystemOneHttpError } {
  return (
    error instanceof ModelError &&
    error.cause instanceof SystemOneHttpError &&
    (error.cause.status === 401 || error.cause.status === 403)
  )
}

function parseEndpoint(value: string): URL {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch (cause) {
    throw new Error(`${CLASS_NAME} endpoint must be a valid URL`, { cause })
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error(`${CLASS_NAME} endpoint must use http or https`)
  }
  // A URL password is echoed in fetch's own error message, so it is rejected before any request.
  if (endpoint.username !== '' || endpoint.password !== '') {
    throw new Error(`${CLASS_NAME} endpoint must not contain credentials: use auth instead`)
  }
  if (endpoint.search !== '') throw new Error(`${CLASS_NAME} endpoint must not contain a query string`)
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
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`${CLASS_NAME} timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`)
  }
  return timeoutMs
}

/**
 * Returns an {@link HttpDecisionModelAuth} that signs each request with AWS Signature Version 4.
 *
 * @param options - What to sign for and with.
 * @throws Error if the service is empty, or no region is given or set in the environment.
 */
export function sigV4Auth(options: {
  /**
   * Service to sign for: `lambda` for a Lambda Function URL with `AWS_IAM` auth, `execute-api` for API
   * Gateway with IAM auth.
   */
  readonly service: string
  /** AWS region to sign for. Defaults to the `AWS_REGION` or `AWS_DEFAULT_REGION` environment variable. */
  readonly region?: string
  /**
   * Static credentials or a provider such as `fromTemporaryCredentials()`. A provider's result is reused until
   * it nears its `expiration`, as in an AWS SDK client. Defaults to the standard AWS credential chain.
   */
  readonly credentials?: SigV4Credentials | (() => Promise<SigV4Credentials>)
}): HttpDecisionModelAuth {
  const service = options.service?.trim()
  if (!service) throw new Error('sigV4Auth requires a service')
  const env = globalThis.process?.env
  const region = options.region?.trim() || env?.AWS_REGION || env?.AWS_DEFAULT_REGION
  if (!region) throw new Error('sigV4Auth requires a region: pass region or set AWS_REGION or AWS_DEFAULT_REGION')
  const signer = new SignatureV4({
    service,
    region,
    sha256: Sha256,
    // Defined, because the provider passed in is.
    credentials: memoizeIdentityProvider(
      options.credentials ?? defaultProvider(),
      isIdentityExpired,
      doesIdentityRequireRefresh
    )!,
  })

  return async ({ url, headers, body }) => {
    const { protocol, hostname, host, pathname } = new URL(url)
    // The signed `host` carries a non-default port, as fetch's does.
    const signed = await signer.sign({
      method: 'POST',
      protocol,
      hostname,
      path: pathname,
      query: {},
      headers: { ...headers, host },
      body,
    })
    // fetch sets `host` and the transport sets `content-type`.
    return Object.fromEntries(
      Object.entries(signed.headers).filter(([name]) => !['host', 'content-type'].includes(name.toLowerCase()))
    )
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
      // `auth` can stall on a credential lookup, so it runs under the same timeout and cancel signal as the
      // request. It sees the `content-type` the transport sends, so a signature can cover it.
      const authHeaders = auth
        ? await abortable(
            auth({
              url: String(input),
              headers: { ...headers, 'content-type': 'application/json' },
              body: String(init?.body),
            }),
            signal
          )
        : {}
      // `redirect: 'manual'`: following a redirect would replay the request's headers and body to another host.
      const response = await baseFetch(input, {
        ...init,
        headers: mergeHeaders(headers, authHeaders, init?.headers),
        redirect: 'manual',
        signal,
      })
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
