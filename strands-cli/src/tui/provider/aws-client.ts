import { GetCallerIdentityCommand, STSClient, type STSClientConfig } from '@aws-sdk/client-sts'

import { awsConfigurationFiles, type AwsConfigurationDiscovery } from './aws-config.js'
import { MODEL_DISCOVERY_TIMEOUT_MS } from './bedrock-catalog.js'
import type { DetectedProviderEnvironment } from './environment.js'

export async function discoverAwsCredentials(
  environment: DetectedProviderEnvironment
): Promise<NonNullable<AwsConfigurationDiscovery['credentialStatus']>> {
  if (environment.AWS_BEARER_TOKEN_BEDROCK?.value) {
    return 'valid'
  }
  const client = new STSClient({
    ...awsClientConfiguration(environment),
    region: environment.AWS_REGION?.value ?? environment.AWS_DEFAULT_REGION?.value ?? 'us-east-1',
    maxAttempts: 1,
  })
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), MODEL_DISCOVERY_TIMEOUT_MS)
  try {
    await Promise.race([
      client.send(new GetCallerIdentityCommand({}), { abortSignal: abort.signal }),
      new Promise<never>((_, reject) => {
        abort.signal.addEventListener('abort', () => reject(new Error('AWS credential check timed out')), {
          once: true,
        })
      }),
    ])
    return 'valid'
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'ExpiredToken' || name === 'ExpiredTokenException') {
      return 'expired'
    }
    if (
      [
        'CredentialsProviderError',
        'TokenProviderError',
        'InvalidClientTokenId',
        'UnrecognizedClientException',
      ].includes(name)
    ) {
      return 'missing'
    }
    return 'unavailable'
  } finally {
    clearTimeout(timeout)
    client.destroy()
  }
}

export function awsClientConfiguration(environment: DetectedProviderEnvironment): Pick<
  STSClientConfig,
  'region' | 'profile' | 'credentials'
> & {
  filepath: string
  configFilepath: string
  ignoreCache: boolean
} {
  const accessKeyId = environment.AWS_ACCESS_KEY_ID?.value
  const secretAccessKey = environment.AWS_SECRET_ACCESS_KEY?.value
  const sessionToken = environment.AWS_SESSION_TOKEN?.value
  const credentials =
    !environment.AWS_PROFILE?.value && accessKeyId && secretAccessKey
      ? { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
      : undefined
  const region = environment.AWS_REGION?.value ?? environment.AWS_DEFAULT_REGION?.value
  const profile = environment.AWS_PROFILE?.value ?? 'default'
  return {
    ...awsConfigurationFiles({
      AWS_CONFIG_FILE: environment.AWS_CONFIG_FILE?.value,
      AWS_SHARED_CREDENTIALS_FILE: environment.AWS_SHARED_CREDENTIALS_FILE?.value,
    }),
    ...(region ? { region } : {}),
    profile,
    ...(credentials ? { credentials } : {}),
    // forceRefresh reruns the credential chain but retains its cached INI files.
    ignoreCache: true,
  }
}
