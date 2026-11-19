import { ModelError } from '../errors.js'
import { DecisionModel } from './decision-model.js'
import {
  askSystemOne,
  httpTransport,
  resolveDefaultMinConfidence,
  SystemOneHttpError,
  type SystemOneProviderConfig,
} from './system-one-http-adapter.js'
import { createSigV4Signer, type SigV4Credentials } from './sigv4-signer.js'
import type { DecisionCallOptions, DecisionInput, DecisionResult, Question } from './types.js'

export type { SigV4Credentials } from './sigv4-signer.js'

const CLASS_NAME = 'HttpDecisionModel'
const DEFAULT_MIN_CONFIDENCE = 0.5
const DEFAULT_TIMEOUT_MS = 60_000
/** The largest delay a timer accepts; `AbortSignal.timeout` misbehaves above it. */
const MAX_TIMEOUT_MS = 2_147_483_647

/** Headers the transport or the connection sets itself. */
const RESERVED_HEADERS = [
  'content-type',
  'content-length',
  'host',
  'transfer-encoding',
  'expect',
  'upgrade',
  'keep-alive',
]
/** Headers a SigV4 signature sets itself, besides `authorization`, which any `auth` sets. */
const SIGV4_HEADERS = ['x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256']

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
/** What fetch accepts in a header value: tab, printable ASCII, and Latin-1. */
const HEADER_VALUE = /^[\t\u0020-\u007e\u0080-\u00ff]*$/
const TOKEN = /^[\u0021-\u007e]+$/
const REGION = /^[A-Za-z0-9-]+$/
const SERVICE = /^[A-Za-z0-9._-]+$/

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
      readonly region: string
      readonly service: string
      /** Static credentials or a provider called on every request. Defaults to the standard AWS credential chain. */
      readonly credentials?: SigV4Credentials | (() => Promise<SigV4Credentials>)
    }

/** Options for constructing an {@link HttpDecisionModel}. */
export interface HttpDecisionModelOptions {
  /**
   * Full URL of the System One endpoint, such as `http://localhost:8000/v1/systemone`. It must not contain
   * a query string or credentials. The endpoint must not redirect: a redirect fails the request.
   */
  readonly endpoint: string
  /** How requests authenticate. Omit for a server that needs no authentication, such as a local one. */
  readonly auth?: HttpDecisionModelAuth
  /** Static request headers that are not credentials, such as `x-api-key` for API Gateway. */
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
 *
 * const result = await lambda.ask('A customer needs a refund today.', {
 *   urgent: { question: 'Is this urgent?', choices: 'boolean' },
 * })
 * ```
 */
export class HttpDecisionModel extends DecisionModel {
  private readonly _providerConfig: SystemOneProviderConfig
  /** What to suggest checking when the server rejects the request's credentials. */
  private readonly _authHint: string | undefined

  /**
   * @param options - Endpoint, authentication, and request configuration.
   * @throws Error if the endpoint, authentication, headers, timeout, or confidence threshold is invalid,
   * or if constructed in a browser.
   */
  constructor(options: HttpDecisionModelOptions) {
    super()
    if (typeof window !== 'undefined') {
      throw new Error(`${CLASS_NAME} cannot run in a browser because that would expose its credentials`)
    }

    const endpoint = parseEndpoint(options.endpoint)
    const auth = options.auth && validateAuth(options.auth)
    const headers = validateHeaders(options.headers, auth)
    // A credential, signature or secret header sent in clear text is readable on the network.
    const sendsSecrets = auth !== undefined || Object.keys(headers).length > 0
    if (sendsSecrets && endpoint.protocol === 'http:' && !isLoopback(endpoint)) {
      throw new Error(`${CLASS_NAME} auth and headers require an https endpoint unless the host is loopback`)
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`${CLASS_NAME} timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`)
    }

    const fetchImplementation = options.fetch ?? globalThis.fetch
    if (typeof fetchImplementation !== 'function') {
      throw new Error(`${CLASS_NAME} requires a fetch implementation`)
    }

    const modelId = options.modelId?.trim()
    this._authHint =
      auth?.type === 'sigv4'
        ? 'check the IAM permission, region and service name'
        : auth?.type === 'bearer'
          ? 'check the token'
          : undefined
    this._providerConfig = {
      providerName: 'http',
      endpoint: endpoint.href,
      requestHeaders: requestHeaders(endpoint, auth, headers),
      defaultMinConfidence: resolveDefaultMinConfidence(
        options.defaultMinConfidence ?? DEFAULT_MIN_CONFIDENCE,
        CLASS_NAME
      ),
      timeoutMs,
      fetch: (input, init): Promise<Response> => fetchImplementation(input, init),
      ...(modelId && { modelId }),
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
        this._authHint !== undefined &&
        error instanceof ModelError &&
        error.cause instanceof SystemOneHttpError &&
        (error.cause.status === 401 || error.cause.status === 403)
      ) {
        throw new ModelError(`${error.message} | ${this._authHint}`, { cause: error.cause })
      }
      throw error
    }
  }
}

function parseEndpoint(endpoint: string): URL {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch (cause) {
    throw new Error(`${CLASS_NAME} endpoint must be a valid URL`, { cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${CLASS_NAME} endpoint must use http or https`)
  }
  // Neither is part of a System One request, and a URL password would be echoed in fetch error messages.
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${CLASS_NAME} endpoint must not contain credentials: use auth instead`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`${CLASS_NAME} endpoint must not contain a query string or fragment`)
  }
  return url
}

/** Returns `auth` with a trimmed bearer token, or throws without echoing any value. */
function validateAuth(auth: HttpDecisionModelAuth): HttpDecisionModelAuth {
  if (auth.type === 'bearer') {
    const token = typeof auth.token === 'string' ? auth.token.trim() : ''
    if (!TOKEN.test(token)) {
      throw new Error(`${CLASS_NAME} bearer token must be non-empty printable text without spaces`)
    }
    return { type: 'bearer', token }
  }
  if (auth.type === 'sigv4') {
    if (typeof auth.region !== 'string' || !REGION.test(auth.region)) {
      throw new Error(`${CLASS_NAME} sigv4 region must contain only letters, digits and hyphens`)
    }
    if (typeof auth.service !== 'string' || !SERVICE.test(auth.service)) {
      throw new Error(`${CLASS_NAME} sigv4 service must contain only letters, digits, dots, hyphens and underscores`)
    }
    return auth
  }
  throw new Error(`${CLASS_NAME} auth type must be 'bearer' or 'sigv4'`)
}

function isLoopback({ hostname }: URL): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/** Rejects headers the transport or the auth owns, repeated names, and names or values that fetch would refuse. */
function validateHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  auth: HttpDecisionModelAuth | undefined
): Record<string, string> {
  const owned = [
    ...RESERVED_HEADERS,
    ...(auth ? ['authorization'] : []),
    ...(auth?.type === 'sigv4' ? SIGV4_HEADERS : []),
  ]
  const result: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADER_NAME.test(name)) throw new Error(`${CLASS_NAME} header name '${name}' is not valid`)
    if (typeof value !== 'string' || !HEADER_VALUE.test(value)) {
      throw new Error(`${CLASS_NAME} header '${name}' must be a string of printable characters up to U+00FF`)
    }
    const lowerName = name.toLowerCase()
    if (owned.includes(lowerName)) throw new Error(`${CLASS_NAME} headers cannot set '${name}'`)
    // Names are case-insensitive: fetch would join the two values, and a signature would cover only one.
    if (seen.has(lowerName)) throw new Error(`${CLASS_NAME} header '${name}' is set more than once`)
    seen.add(lowerName)
    result[name] = value
  }
  return result
}

function requestHeaders(
  endpoint: URL,
  auth: HttpDecisionModelAuth | undefined,
  headers: Record<string, string>
): SystemOneProviderConfig['requestHeaders'] {
  if (auth?.type === 'bearer') {
    const withAuth = { ...headers, Authorization: `Bearer ${auth.token}` }
    return () => withAuth
  }
  if (auth?.type === 'sigv4') {
    const sign = createSigV4Signer(endpoint, auth)
    return async (body) => ({ ...headers, ...(await sign(body, headers)) })
  }
  return () => headers
}
