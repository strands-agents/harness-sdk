import { ModelError } from '../errors.js'
import { DecisionModel } from './decision-model.js'
import {
  askSystemOne,
  httpTransport,
  resolveDefaultMinConfidence,
  SystemOneHttpError,
  type SystemOneProviderConfig,
} from './system-one-http-adapter.js'
import type { DecisionCallOptions, DecisionInput, DecisionResult, Question } from './types.js'

const CLASS_NAME = 'HttpDecisionModel'
const PROVIDER_NAME = 'http'
const DEFAULT_MIN_CONFIDENCE = 0.5
const DEFAULT_TIMEOUT_MS = 60_000
/** The largest delay a timer accepts; above it `AbortSignal.timeout` fires after 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647

/** AWS credentials used to sign a request. */
export interface SigV4Credentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
}

/** How an {@link HttpDecisionModel} authenticates its requests. */
export type HttpDecisionModelAuth =
  /** Sends `Authorization: Bearer <token>`. */
  | { readonly type: 'bearer'; readonly token: string }
  /**
   * Signs each request with AWS Signature Version 4. Use service `lambda` for a Lambda Function URL
   * with `AWS_IAM` auth and `execute-api` for API Gateway with IAM auth.
   *
   * Signing needs `@smithy/signature-v4`, `@smithy/protocol-http`, and `@aws-crypto/sha256-js`, plus
   * `@aws-sdk/credential-providers` when `credentials` is omitted. These are optional peer
   * dependencies, loaded on the first request.
   */
  | {
      readonly type: 'sigv4'
      /** AWS region to sign for. Defaults to the `AWS_REGION` or `AWS_DEFAULT_REGION` environment variable. */
      readonly region?: string
      readonly service: string
      /** Static credentials or a provider called on every request. Defaults to the standard AWS credential chain. */
      readonly credentials?: SigV4Credentials | (() => Promise<SigV4Credentials>)
    }

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
  /** How requests authenticate. Omit for a server that needs no authentication, such as a local one. */
  readonly auth?: HttpDecisionModelAuth
  /**
   * Static request headers, such as `x-api-key` for API Gateway. They are treated as secrets: they need an
   * `https` endpoint unless the host is loopback, and a browser cannot send them.
   */
  readonly headers?: Readonly<Record<string, string>>
  /** Sent as the request's `model`. Omitted when unset, so the server uses its own. */
  readonly modelId?: string
  /** Default minimum confidence. Defaults to `0.5`. */
  readonly defaultMinConfidence?: number
  /**
   * Aborts a request that takes longer than this many milliseconds, counting the response body. An integer
   * from 1 to 2147483647. Defaults to `60000`, which is longer than API Gateway's 29 second limit.
   */
  readonly timeoutMs?: number
  /** Custom fetch implementation, primarily for transport configuration and tests. */
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
 * // A local server needs no authentication.
 * const local = new HttpDecisionModel({ endpoint: 'http://localhost:8000/v1/systemone' })
 *
 * // A Lambda Function URL with AWS_IAM auth, signed with the standard AWS credential chain.
 * const lambda = new HttpDecisionModel({
 *   endpoint: 'https://abc123.lambda-url.us-east-1.on.aws/v1/systemone',
 *   auth: { type: 'sigv4', region: 'us-east-1', service: 'lambda' },
 * })
 * ```
 */
export class HttpDecisionModel extends DecisionModel {
  private readonly _providerConfig: SystemOneProviderConfig
  private readonly _authenticated: boolean

  /**
   * @param options - Endpoint, authentication, and request configuration.
   * @throws Error if the endpoint, authentication, headers, timeout, or confidence threshold is invalid, or if
   * `auth` or `headers` is set in a browser.
   */
  constructor(options: HttpDecisionModelOptions) {
    super()

    let endpoint: URL
    try {
      endpoint = new URL(options.endpoint)
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
    // `new Headers` rejects an invalid name or value, but its message quotes the value, which may be a secret.
    let headers: Record<string, string>
    try {
      headers = Object.fromEntries(new Headers(options.headers))
    } catch {
      throw new Error(`${CLASS_NAME} headers must have valid names and printable values`)
    }
    const { auth } = options
    this._authenticated = auth !== undefined
    const sendsSecrets = auth !== undefined || Object.keys(headers).length > 0
    // A page's users could read credentials sent from a browser. A public endpoint that needs none is fine.
    if (sendsSecrets && typeof window !== 'undefined') {
      throw new Error(`${CLASS_NAME} cannot send auth or headers from a browser because that would expose them`)
    }
    // A credential, signature or secret header sent in clear text is readable on the network.
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    if (sendsSecrets && endpoint.protocol !== 'https:' && !loopback) {
      throw new Error(`${CLASS_NAME} auth and headers require an https endpoint unless the host is loopback`)
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`${CLASS_NAME} timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`)
    }
    const baseFetch = options.fetch ?? globalThis.fetch
    if (typeof baseFetch !== 'function') throw new Error(`${CLASS_NAME} requires a fetch implementation`)

    let apiKey: string | undefined
    if (auth?.type === 'bearer') {
      apiKey = auth.token?.trim()
      if (!apiKey || /\s/.test(apiKey))
        throw new Error(`${CLASS_NAME} bearer token must be non-empty text without spaces`)
    } else if (auth !== undefined && auth.type !== 'sigv4') {
      throw new Error(`${CLASS_NAME} auth type must be 'bearer' or 'sigv4'`)
    }
    const sign = auth?.type === 'sigv4' ? sigV4Signer(endpoint, auth) : undefined

    // The shared transport only POSTs. Signing, the timeout and redirect handling wrap `fetch` here, so they stay local.
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const signal = AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)])
      // A credential lookup can stall, so it runs under the same timeout and cancel signal as the request.
      const signed = sign ? await abortable(sign(String(init?.body), headers), signal) : {}
      // `redirect: 'manual'`: following a redirect would replay the request's headers and body to another host.
      const response = await baseFetch(input, {
        ...init,
        headers: mergeHeaders(headers, signed, init?.headers),
        redirect: 'manual',
        signal,
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`redirected (HTTP ${response.status}): set the endpoint to the redirect target`)
      }
      // Read the body here, under the timeout, so a slow or dropped body fails as a request error. The shared
      // transport reads the returned copy.
      const text = await response.text()
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
    }

    this._providerConfig = {
      providerName: PROVIDER_NAME,
      endpoint: endpoint.href,
      defaultMinConfidence: resolveDefaultMinConfidence(
        options.defaultMinConfidence ?? DEFAULT_MIN_CONFIDENCE,
        CLASS_NAME
      ),
      fetch,
      ...(apiKey && { apiKey }),
      ...(options.modelId?.trim() && { modelId: options.modelId.trim() }),
    }
  }

  protected async _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
    options: DecisionCallOptions
  ): Promise<DecisionResult<Q>> {
    try {
      return await askSystemOne(
        this._providerConfig,
        httpTransport(this._providerConfig),
        state,
        questions,
        options.cancelSignal
      )
    } catch (error) {
      // The server's own message, such as a Lambda's "Forbidden", does not say what to check.
      if (
        this._authenticated &&
        error instanceof ModelError &&
        error.cause instanceof SystemOneHttpError &&
        (error.cause.status === 401 || error.cause.status === 403)
      ) {
        throw new ModelError(
          `${error.message} | check the credentials, and for sigv4 the IAM permission, region and service`,
          {
            cause: error.cause,
          }
        )
      }
      throw error
    }
  }
}

type SigV4Signer = (body: string, headers: Record<string, string>) => Promise<Record<string, string>>

/**
 * Returns a function that gives the headers signing one POST of `body` to `url`, including the static `headers`
 * it is given. They omit `host` and `content-type`: fetch derives the first and the transport sets the second.
 *
 * The region is resolved like the SDK's other AWS paths, and a missing region or service fails here, at
 * construction. The signing packages are optional peers: they load on the first call, concurrent calls share
 * the load, and a failed load is retried on the next call.
 */
function sigV4Signer(url: URL, auth: Extract<HttpDecisionModelAuth, { type: 'sigv4' }>): SigV4Signer {
  const service = auth.service?.trim()
  if (!service) throw new Error(`${CLASS_NAME} sigv4 auth requires a service`)
  const env = globalThis.process?.env
  const region = auth.region?.trim() || env?.AWS_REGION || env?.AWS_DEFAULT_REGION
  if (!region) {
    throw new Error(`${CLASS_NAME} sigv4 auth requires a region: pass region or set AWS_REGION or AWS_DEFAULT_REGION`)
  }

  let runtime: Promise<SigV4Runtime> | undefined
  return async (body, headers) => {
    runtime ??= loadSigV4(region, service, auth.credentials).catch((error: unknown) => {
      runtime = undefined
      throw error
    })
    const { signer, HttpRequest } = await runtime
    const signed = await signer.sign(
      new HttpRequest({
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname,
        // The signed `host` carries a non-default port, as fetch's does.
        headers: { ...headers, host: url.host, 'content-type': 'application/json' },
        body,
      })
    )
    return Object.fromEntries(
      Object.entries(signed.headers).filter(([name]) => !['host', 'content-type'].includes(name.toLowerCase()))
    )
  }
}

interface SigV4Runtime {
  signer: import('@smithy/signature-v4').SignatureV4
  HttpRequest: typeof import('@smithy/protocol-http').HttpRequest
}

async function loadSigV4(
  region: string,
  service: string,
  credentials: SigV4Credentials | (() => Promise<SigV4Credentials>) | undefined
): Promise<SigV4Runtime> {
  const [{ SignatureV4 }, { HttpRequest }, { Sha256 }] = await Promise.all([
    importOptional(() => import('@smithy/signature-v4'), '@smithy/signature-v4'),
    importOptional(() => import('@smithy/protocol-http'), '@smithy/protocol-http'),
    importOptional(() => import('@aws-crypto/sha256-js'), '@aws-crypto/sha256-js'),
  ])
  const resolved =
    credentials ??
    (
      await importOptional(() => import('@aws-sdk/credential-providers'), '@aws-sdk/credential-providers')
    ).fromNodeProviderChain()
  return { HttpRequest, signer: new SignatureV4({ service, region, sha256: Sha256, credentials: resolved }) }
}

async function importOptional<T>(load: () => Promise<T>, packageName: string): Promise<T> {
  try {
    return await load()
  } catch (cause) {
    throw new Error(
      `${CLASS_NAME} sigv4 auth requires the '${packageName}' package | install it with: npm install '${packageName}'`,
      { cause }
    )
  }
}

/** Merges header sets case-insensitively, later sets winning, so the transport's `Content-Type` replaces a static one. */
function mergeHeaders(...sets: (HeadersInit | undefined)[]): Headers {
  const merged = new Headers()
  for (const set of sets) new Headers(set).forEach((value, name) => merged.set(name, value))
  return merged
}

/** Settles like `promise`, or rejects with the signal's reason as soon as the signal aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
