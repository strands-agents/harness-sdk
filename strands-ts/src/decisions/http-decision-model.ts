import { DecisionModel } from './decision-model.js'
import {
  askSystemOne,
  httpTransport,
  resolveDefaultMinConfidence,
  type SystemOneProviderConfig,
} from './system-one-http-adapter.js'
import { createSigV4Signer, type SigV4Credentials } from './sigv4-signer.js'
import type { DecisionCallOptions, DecisionInput, DecisionResult, Question } from './types.js'

const HTTP_PROVIDER_NAME = 'http'
const HTTP_DEFAULT_MIN_CONFIDENCE = 0.5
const HTTP_DEFAULT_TIMEOUT_MS = 60_000

/** Header names the transport sets itself, so a caller cannot supply them. */
const RESERVED_HEADERS = new Set(['content-type', 'content-length', 'host'])

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
  /** Full URL of the System One endpoint, such as `http://localhost:8000/v1/systemone`. */
  readonly endpoint: string
  /** How requests authenticate. Omit for a server that needs no authentication, such as a local one. */
  readonly auth?: HttpDecisionModelAuth
  /** Static request headers that are not credentials, such as `x-api-key` for API Gateway. */
  readonly headers?: Readonly<Record<string, string>>
  /** Sent as the request's `model`. Omitted when unset, so the server uses its own. */
  readonly modelId?: string
  /** Default minimum confidence. Defaults to `0.5`. */
  readonly defaultMinConfidence?: number
  /** Aborts a request that takes longer than this many milliseconds. Defaults to `60000`. */
  readonly timeoutMs?: number
  /** Custom fetch implementation, primarily for transport configuration and tests. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * Decision model backed by any server that speaks the System One wire format over HTTP, such as a
 * local `strands-decider` server, a Lambda Function URL, or an API Gateway route.
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

  /**
   * @param options - Endpoint, authentication, and request configuration.
   * @throws Error if the endpoint, authentication, headers, timeout, or confidence threshold is invalid,
   * or if constructed in a browser.
   */
  constructor(options: HttpDecisionModelOptions) {
    super()
    const className = 'HttpDecisionModel'
    if (typeof window !== 'undefined') {
      throw new Error(`${className} cannot run in a browser because that would expose its credentials`)
    }

    const endpoint = parseEndpoint(options.endpoint, className)
    const { auth } = options
    const staticHeaders = validateHeaders(options.headers, auth !== undefined, className)
    if (auth !== undefined) validateAuth(auth, endpoint, className)

    const timeoutMs = options.timeoutMs ?? HTTP_DEFAULT_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`${className} timeoutMs must be a positive number`)
    }

    const fetchImplementation = options.fetch ?? globalThis.fetch
    if (typeof fetchImplementation !== 'function') {
      throw new Error(`${className} requires a fetch implementation`)
    }

    const modelId = options.modelId?.trim()
    this._providerConfig = {
      providerName: HTTP_PROVIDER_NAME,
      endpoint: endpoint.href,
      requestHeaders: authHeaders(auth, endpoint.href, staticHeaders),
      defaultMinConfidence: resolveDefaultMinConfidence(
        options.defaultMinConfidence ?? HTTP_DEFAULT_MIN_CONFIDENCE,
        className
      ),
      timeoutMs,
      fetch: (input, init): Promise<Response> => fetchImplementation(input, init),
      ...(modelId && { modelId }),
    }
  }

  protected _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
    options: DecisionCallOptions
  ): Promise<DecisionResult<Q>> {
    return askSystemOne(
      this._providerConfig,
      httpTransport(this._providerConfig),
      state,
      questions,
      options.cancelSignal
    )
  }
}

function parseEndpoint(endpoint: string, className: string): URL {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch (cause) {
    throw new Error(`${className} endpoint must be a valid URL`, { cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${className} endpoint must use http or https`)
  }
  return url
}

function validateHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  hasAuth: boolean,
  className: string
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lowerName = name.toLowerCase()
    if (RESERVED_HEADERS.has(lowerName)) throw new Error(`${className} headers cannot set '${name}'`)
    if (hasAuth && lowerName === 'authorization') {
      throw new Error(`${className} headers cannot set 'authorization' when auth is set`)
    }
    result[name] = value
  }
  return result
}

function validateAuth(auth: HttpDecisionModelAuth, endpoint: URL, className: string): void {
  if (auth.type === 'bearer') {
    if (typeof auth.token !== 'string' || auth.token.trim().length === 0) {
      throw new Error(`${className} bearer auth requires a non-empty token`)
    }
  } else if (auth.type === 'sigv4') {
    if (!auth.region?.trim() || !auth.service?.trim()) {
      throw new Error(`${className} sigv4 auth requires a region and a service`)
    }
  } else {
    throw new Error(`${className} auth type must be 'bearer' or 'sigv4'`)
  }

  // A credential or signature sent in clear text is readable on the network.
  if (endpoint.protocol === 'http:' && !isLoopback(endpoint.hostname)) {
    throw new Error(`${className} auth requires an https endpoint unless the host is loopback`)
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function authHeaders(
  auth: HttpDecisionModelAuth | undefined,
  endpoint: string,
  staticHeaders: Record<string, string>
): SystemOneProviderConfig['requestHeaders'] {
  if (auth?.type === 'bearer') {
    const headers = { ...staticHeaders, Authorization: `Bearer ${auth.token.trim()}` }
    return () => headers
  }
  if (auth?.type === 'sigv4') {
    const sign = createSigV4Signer(endpoint, {
      region: auth.region.trim(),
      service: auth.service.trim(),
      ...(auth.credentials !== undefined && { credentials: auth.credentials }),
    })
    return async (body) => ({ ...staticHeaders, ...(await sign(body, staticHeaders)) })
  }
  return () => staticHeaders
}
