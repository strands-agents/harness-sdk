/**
 * Internal helpers for routing an {@link OpenAIModel} through Amazon Bedrock's
 * OpenAI-compatible "Mantle" endpoint.
 *
 * Converts a {@link BedrockMantleConfig} into the `baseURL` and `apiKey` the
 * OpenAI SDK consumes. Tokens are minted on demand via
 * `@aws/bedrock-token-generator` so long-running agents survive the bearer
 * token's maximum lifetime.
 */

import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types'

const MANTLE_DOCS_URL = 'https://docs.aws.amazon.com/bedrock/latest/userguide/inference-openai.html'

/**
 * Mantle model lines served from `/openai/v1`; every other Mantle model uses
 * `/v1`, and the wrong base path fails with HTTP 400. The base path is a
 * per-model property that no Mantle API reports, so these prefixes were
 * verified against the `us-east-1` catalog on 2026-08-05. Scope each prefix to
 * a single model line, never a vendor: one vendor's lines can split across base
 * paths (`google.gemma-4-*` is on `/openai/v1`, `google.gemma-3-*` is on
 * `/v1`). An unmatched new line falls through to `/v1`; the `mantle-routing`
 * integ test fails naming any id that routes wrong.
 */
const OPENAI_PATH_MODEL_PREFIXES = ['openai.gpt-5.', 'openai.gpt-6-', 'xai.grok-4.', 'google.gemma-4-'] as const

// Matches AWS region identifiers such as us-east-1, ap-southeast-1, and us-gov-east-1.
// Anchored so a malformed region (e.g. one containing '@', ':', '/', '#') cannot re-point
// the Mantle endpoint URL to a non-AWS host. Mirrors the Python SDK's validate_region
// (`[0-9]` rather than `\d` keeps the two patterns character-identical).
const VALID_REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]+$/

/**
 * Async function that returns a freshly minted Bedrock Mantle bearer token.
 * Matches the shape returned by `@aws/bedrock-token-generator`'s
 * `getTokenProvider`.
 *
 * @internal
 */
export type TokenProvider = () => Promise<string>

/**
 * Config for routing an OpenAI-compatible client through Amazon Bedrock's
 * Mantle endpoint.
 *
 * When supplied to `OpenAIModel`, this config derives the OpenAI client's
 * `baseURL` and `apiKey`. It cannot be combined with a pre-built `client`,
 * a top-level `apiKey`, or `clientConfig.baseURL` / `clientConfig.apiKey`,
 * since those are derived from this config.
 */
export interface BedrockMantleConfig {
  /**
   * AWS region hosting the Bedrock Mantle endpoint. If omitted, resolved from
   * the `AWS_REGION` or `AWS_DEFAULT_REGION` environment variable. An error is
   * thrown if none resolve.
   */
  region?: string

  /**
   * AWS credentials forwarded to the bearer token generator. Accepts either a
   * static credential identity or a credential provider function (e.g. the
   * result of `fromNodeProviderChain()` from `@aws-sdk/credential-providers`).
   * When omitted, the token generator resolves credentials from the standard
   * AWS credential chain.
   */
  credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider

  /**
   * Bearer token lifetime in seconds, forwarded to the token generator.
   * Capped at 12 hours by AWS. When omitted, the generator's default applies.
   * @see https://docs.aws.amazon.com/bedrock/latest/userguide/inference-openai.html
   */
  expiresInSeconds?: number
}

/**
 * Validates an AWS region before it is interpolated into the Mantle endpoint URL.
 *
 * Guards against a malformed region (containing URL control characters such as
 * `@`, `:`, `/`, `#`) re-pointing a signed request to a non-AWS host, which would
 * exfiltrate the minted bearer token.
 *
 * @internal
 */
function validateRegion(region: string): string {
  if (!VALID_REGION.test(region)) {
    throw new Error(`invalid AWS region: '${region}'`)
  }
  return region
}

/**
 * Resolves the AWS region for Mantle, preferring explicit config and falling
 * back to the standard AWS env vars. The resolved region is validated before it
 * is returned, since it is interpolated into the Mantle endpoint URL.
 *
 * @internal
 */
export function resolveMantleRegion(config: BedrockMantleConfig): string {
  if (config.region) {
    return validateRegion(config.region)
  }

  const envRegion = globalThis?.process?.env?.AWS_REGION || globalThis?.process?.env?.AWS_DEFAULT_REGION
  if (envRegion) {
    return validateRegion(envRegion)
  }

  throw new Error(
    "could not resolve an AWS region for Bedrock Mantle. Pass 'region' in " +
      'bedrockMantleConfig or set AWS_REGION in the environment. ' +
      `See ${MANTLE_DOCS_URL} for supported regions.`
  )
}

/**
 * Resolves the Mantle base path for a model id.
 *
 * Mirrors the Python SDK's `_resolve_mantle_base_path`. Exported for the
 * `mantle-routing` integ test, which asserts this resolution against the live
 * Mantle catalog.
 *
 * @internal
 */
export function resolveMantleBasePath(modelId: string): '/v1' | '/openai/v1' {
  return OPENAI_PATH_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix)) ? '/openai/v1' : '/v1'
}

/**
 * Builds the Mantle base URL for a region and model id.
 *
 * @internal
 */
export function bedrockMantleBaseUrl(region: string, modelId: string): string {
  return `https://bedrock-mantle.${region}.api.aws${resolveMantleBasePath(modelId)}`
}

/**
 * Builds an async `apiKey` setter (matching the OpenAI SDK's `ApiKeySetter`
 * signature) that mints a fresh bearer token on every request.
 *
 * The `@aws/bedrock-token-generator` package is loaded lazily on first use so
 * applications that never touch the Mantle pathway don't need it installed.
 *
 * @internal
 */
export function createMantleApiKeySetter(config: BedrockMantleConfig, region: string): () => Promise<string> {
  let tokenProviderPromise: Promise<TokenProvider> | null = null

  const initProvider = async (): Promise<TokenProvider> => {
    const { getTokenProvider } = await loadTokenGenerator()
    return getTokenProvider({
      region,
      ...(config.credentials !== undefined ? { credentials: config.credentials } : {}),
      ...(config.expiresInSeconds !== undefined ? { expiresInSeconds: config.expiresInSeconds } : {}),
    })
  }

  return async (): Promise<string> => {
    if (tokenProviderPromise === null) {
      tokenProviderPromise = initProvider()
    }
    const provideToken = await tokenProviderPromise
    try {
      return await provideToken()
    } catch (cause) {
      throw new Error(
        `failed to mint Bedrock Mantle bearer token for region '${region}' | ` +
          'verify your AWS credentials and network connectivity',
        { cause }
      )
    }
  }
}

async function loadTokenGenerator(): Promise<typeof import('@aws/bedrock-token-generator')> {
  try {
    return await import('@aws/bedrock-token-generator')
  } catch (cause) {
    throw new Error(
      "bedrockMantleConfig requires the '@aws/bedrock-token-generator' package | " +
        "install it with: npm install '@aws/bedrock-token-generator'",
      { cause }
    )
  }
}
