/**
 * AWS Signature Version 4 request signing for {@link HttpDecisionModel}.
 *
 * The signing packages are optional peer dependencies, loaded on the first signed request, so
 * callers that never sign do not need them and no AWS types reach the public declarations.
 *
 * @internal
 */

/** AWS credentials used to sign a request. */
export interface SigV4Credentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
}

/** Where and how to sign: the AWS region and signing service name, such as `lambda` or `execute-api`. */
export interface SigV4Config {
  readonly region: string
  readonly service: string
  /** Static credentials or a provider called on every request. Defaults to the standard AWS credential chain. */
  readonly credentials?: SigV4Credentials | (() => Promise<SigV4Credentials>)
}

/** Returns the headers that sign one POST of `body` to `endpoint`, including any `headers` it was given. */
export type SigV4Signer = (body: string, headers: Record<string, string>) => Promise<Record<string, string>>

/**
 * Builds a signer for `endpoint`. Loads the signing packages lazily and shares one load between
 * concurrent first calls; a failed load is retried on the next request.
 */
export function createSigV4Signer(endpoint: string, config: SigV4Config): SigV4Signer {
  const url = new URL(endpoint)
  let signer: Promise<SigV4Signer> | undefined

  return async (body, headers) => {
    signer ??= load(url, config)
    try {
      return await (
        await signer
      )(body, headers)
    } catch (error) {
      signer = undefined
      throw error
    }
  }
}

async function load(url: URL, config: SigV4Config): Promise<SigV4Signer> {
  const [{ SignatureV4 }, { HttpRequest }, { Sha256 }, credentials] = await Promise.all([
    importOptional(() => import('@smithy/signature-v4'), '@smithy/signature-v4'),
    importOptional(() => import('@smithy/protocol-http'), '@smithy/protocol-http'),
    importOptional(() => import('@aws-crypto/sha256-js'), '@aws-crypto/sha256-js'),
    resolveCredentials(config.credentials),
  ])

  const signatureV4 = new SignatureV4({
    service: config.service,
    region: config.region,
    sha256: Sha256,
    credentials,
  })

  return async (body, headers) => {
    const signed = await signatureV4.sign(
      new HttpRequest({
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        ...(url.port !== '' && { port: Number(url.port) }),
        path: url.pathname,
        query: queryOf(url),
        // `host` is signed here and sent by fetch itself, which derives the same value from the URL.
        headers: { ...headers, host: url.host, 'content-type': 'application/json' },
        body,
      })
    )
    // fetch derives `host` itself and the transport sets `content-type`; returning either would duplicate it.
    return Object.fromEntries(
      Object.entries(signed.headers).filter(([name]) => !['host', 'content-type'].includes(name.toLowerCase()))
    )
  }
}

function queryOf(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {}
  for (const [key, value] of url.searchParams) {
    const existing = query[key]
    query[key] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value]
  }
  return query
}

async function resolveCredentials(
  credentials: SigV4Config['credentials']
): Promise<SigV4Credentials | (() => Promise<SigV4Credentials>)> {
  if (credentials !== undefined) return credentials
  const { fromNodeProviderChain } = await importOptional(
    () => import('@aws-sdk/credential-providers'),
    '@aws-sdk/credential-providers'
  )
  return fromNodeProviderChain()
}

async function importOptional<T>(load: () => Promise<T>, packageName: string): Promise<T> {
  try {
    return await load()
  } catch (cause) {
    throw new Error(
      `HttpDecisionModel sigv4 auth requires the '${packageName}' package | ` +
        `install it with: npm install '${packageName}'`,
      { cause }
    )
  }
}
