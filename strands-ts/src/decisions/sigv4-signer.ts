/**
 * AWS Signature Version 4 request signing for {@link HttpDecisionModel}.
 *
 * The signing packages are optional peer dependencies, loaded on the first signed request, so
 * callers that never sign do not need them and no AWS types reach the public declarations.
 */

/** AWS credentials used to sign a request. */
export interface SigV4Credentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
}

/** @internal Where and how to sign: the AWS region and signing service name, such as `lambda` or `execute-api`. */
export interface SigV4Config {
  readonly region: string
  readonly service: string
  /** Static credentials or a provider called on every request. Defaults to the standard AWS credential chain. */
  readonly credentials?: SigV4Credentials | (() => Promise<SigV4Credentials>)
}

/**
 * @internal Returns the headers that sign one POST of `body`, including the static `headers` it was given. The
 * returned headers omit `host` and `content-type`: fetch derives the first and the transport sets the second.
 */
export type SigV4Signer = (body: string, headers: Record<string, string>) => Promise<Record<string, string>>

/**
 * @internal Builds a signer for the endpoint `url`, which must not carry a query string. The signing packages load on the
 * first call and are shared by concurrent calls; a failed load is retried on the next call.
 */
export function createSigV4Signer(url: URL, config: SigV4Config): SigV4Signer {
  let runtime: Promise<Runtime> | undefined

  return async (body, headers) => {
    runtime ??= load(config).catch((error: unknown) => {
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

interface Runtime {
  signer: import('@smithy/signature-v4').SignatureV4
  HttpRequest: typeof import('@smithy/protocol-http').HttpRequest
}

async function load(config: SigV4Config): Promise<Runtime> {
  const [{ SignatureV4 }, { HttpRequest }, { Sha256 }] = await Promise.all([
    importOptional(() => import('@smithy/signature-v4'), '@smithy/signature-v4'),
    importOptional(() => import('@smithy/protocol-http'), '@smithy/protocol-http'),
    importOptional(() => import('@aws-crypto/sha256-js'), '@aws-crypto/sha256-js'),
  ])
  const credentials =
    config.credentials ??
    (
      await importOptional(() => import('@aws-sdk/credential-providers'), '@aws-sdk/credential-providers')
    ).fromNodeProviderChain()

  return {
    HttpRequest,
    signer: new SignatureV4({ service: config.service, region: config.region, sha256: Sha256, credentials }),
  }
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
