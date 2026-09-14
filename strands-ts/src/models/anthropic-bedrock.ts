/**
 * Internal helpers for routing an {@link AnthropicModel} through Amazon Bedrock's
 * Anthropic-compatible "Mantle" endpoint.
 *
 * Converts a {@link BedrockMantleConfig} into the options `AnthropicBedrockMantle`
 * consumes. That client derives the Mantle base URL, sends the required
 * `anthropic-version` header, and signs every request with SigV4 on its own, so
 * unlike the OpenAI-compatible pathway nothing here mints or caches a credential.
 */

import type { AnthropicBedrockMantle, BedrockMantleClientOptions } from '@anthropic-ai/bedrock-sdk'
import type { ClientOptions } from '@anthropic-ai/sdk'

const MANTLE_DOCS_URL = 'https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.html'

// Matches AWS region identifiers such as us-east-1, ap-southeast-1, and us-gov-east-1.
// Anchored so a malformed region (e.g. one containing '@', ':', '/', '#') cannot re-point
// the Mantle endpoint URL to a non-AWS host. Mirrors the Python SDK's validate_region
// (`[0-9]` rather than `\d` keeps the two patterns character-identical).
const VALID_REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]+$/

/**
 * Config for routing an Anthropic client through Amazon Bedrock's Mantle endpoint.
 *
 * When supplied to `AnthropicModel`, this config builds the Mantle client. It cannot
 * be combined with a pre-built `client`, a top-level `apiKey`, or `clientConfig.apiKey`,
 * since authentication is derived from this config.
 */
export interface BedrockMantleConfig {
  /**
   * AWS region hosting the Bedrock Mantle endpoint. If omitted, resolved from the
   * `AWS_REGION` or `AWS_DEFAULT_REGION` environment variable. An error is thrown if
   * none resolve.
   */
  region?: string

  /**
   * AWS named profile to authenticate with. Selects SigV4 authentication.
   */
  profile?: string

  /**
   * Amazon Bedrock API key. When set, requests carry it as a bearer token instead of
   * being signed with SigV4. Omit to use the standard AWS credential chain.
   */
  apiKey?: string
}

/**
 * Validates an AWS region before it is interpolated into the Mantle endpoint URL.
 *
 * Guards against a malformed region (containing URL control characters such as `@`,
 * `:`, `/`, `#`) re-pointing a signed request to a non-AWS host.
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
 * Resolves the AWS region for Mantle, preferring explicit config and falling back to
 * the standard AWS env vars. The resolved region is validated before it is returned,
 * since `AnthropicBedrockMantle` interpolates it into the Mantle endpoint URL.
 *
 * @throws Error when no region resolves from the config or the environment, or when the
 * resolved region is not a well-formed AWS region identifier.
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
 * Resolves a Mantle config (plus optional client options) into `AnthropicBedrockMantle`
 * constructor options.
 *
 * Synchronous so a caller can fail fast on an unresolvable or malformed region without
 * waiting for the lazily imported client package.
 *
 * @throws Error when the region cannot be resolved or is malformed.
 * @internal
 */
export function resolveMantleClientOptions(
  config: BedrockMantleConfig,
  clientConfig?: Omit<ClientOptions, 'apiKey'>
): BedrockMantleClientOptions {
  // Only forward keys the caller set; the Mantle client reads auth precedence off which
  // options are not undefined, so passing an explicit undefined would change the mode.
  return {
    ...clientConfig,
    awsRegion: resolveMantleRegion(config),
    ...(config.profile !== undefined ? { awsProfile: config.profile } : {}),
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
  }
}

/**
 * Builds an `AnthropicBedrockMantle` client from resolved options.
 *
 * The `@anthropic-ai/bedrock-sdk` package is loaded lazily on first use so applications
 * that never touch the Mantle pathway don't need it installed.
 *
 * @throws Error when `@anthropic-ai/bedrock-sdk` is not installed.
 * @internal
 */
export async function createMantleClient(options: BedrockMantleClientOptions): Promise<AnthropicBedrockMantle> {
  const { AnthropicBedrockMantle: MantleClient } = await loadBedrockSdk()
  return new MantleClient(options)
}

async function loadBedrockSdk(): Promise<typeof import('@anthropic-ai/bedrock-sdk')> {
  try {
    return await import('@anthropic-ai/bedrock-sdk')
  } catch (cause) {
    throw new Error(
      "bedrockMantleConfig requires the '@anthropic-ai/bedrock-sdk' package | " +
        "install it with: npm install '@anthropic-ai/bedrock-sdk'",
      { cause }
    )
  }
}
