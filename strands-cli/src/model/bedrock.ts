import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type FoundationModelSummary,
  type InferenceProfileSummary,
} from '@aws-sdk/client-bedrock'
import { GetCallerIdentityCommand, STSClient, type STSClientConfig } from '@aws-sdk/client-sts'
import { sanitizeTerminalText } from '../terminal/text.js'
import { awsConfigurationFiles, type AwsConfigurationDiscovery } from './aws-config.js'
import { type DetectedProviderEnvironment } from './environment.js'
import { modelDisplayName } from './metadata.js'
import { type SelectableModel } from './selection.js'

export const MODEL_DISCOVERY_TIMEOUT_MS = 4_000

export interface BedrockCatalogClient {
  send(
    command: ListInferenceProfilesCommand | ListFoundationModelsCommand,
    options?: { abortSignal?: AbortSignal }
  ): Promise<{
    inferenceProfileSummaries?: InferenceProfileSummary[]
    modelSummaries?: FoundationModelSummary[]
    nextToken?: string
  }>
  destroy(): void
}

export type BedrockCatalogClientFactory = (region?: string) => BedrockCatalogClient
export async function listBedrockModels(client: BedrockCatalogClient): Promise<{
  models: SelectableModel[]
  knownModelIds: string[]
  complete: boolean
}> {
  const abortSignal = AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS)
  try {
    const [profiles, foundations] = await Promise.allSettled([
      listInferenceProfiles(client, abortSignal),
      client.send(new ListFoundationModelsCommand({}), { abortSignal }),
    ])
    const models = new Map<string, SelectableModel>()
    const addModel = (modelId: string, name: string): void => {
      const id = sanitizeTerminalText(modelId)
      models.set(id, {
        id,
        name: modelDisplayName(sanitizeTerminalText(name)),
        description: '',
      })
    }
    const knownModelIds = new Set<string>()
    const textStreamingModels = new Set<string>()

    if (foundations.status === 'fulfilled') {
      for (const model of foundations.value.modelSummaries ?? []) {
        if (model.modelId) {
          knownModelIds.add(sanitizeTerminalText(model.modelId))
        }
        if (model.modelId && isTextStreamingModel(model)) {
          textStreamingModels.add(model.modelId)
          if (model.inferenceTypesSupported?.includes('ON_DEMAND')) {
            addModel(model.modelId, model.modelName || model.modelId)
          }
        }
      }
    }

    if (profiles.status === 'fulfilled') {
      for (const profile of profiles.value) {
        if (profile.inferenceProfileId) {
          knownModelIds.add(sanitizeTerminalText(profile.inferenceProfileId))
        }
        const supportsChat =
          foundations.status === 'rejected' ||
          profile.models?.some((model) => {
            const modelId = model.modelArn?.slice(model.modelArn.lastIndexOf('/') + 1)
            return modelId ? textStreamingModels.has(modelId) : false
          })
        if (profile.inferenceProfileId && profile.status === 'ACTIVE' && supportsChat) {
          addModel(profile.inferenceProfileId, profile.inferenceProfileName || profile.inferenceProfileId)
        }
      }
    }

    if (models.size === 0) {
      if (profiles.status === 'rejected') {
        throw profiles.reason
      }
      if (foundations.status === 'rejected') {
        throw foundations.reason
      }
    }

    return {
      models: [...models.values()].sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
      ),
      knownModelIds: [...knownModelIds],
      complete: profiles.status === 'fulfilled' && foundations.status === 'fulfilled',
    }
  } finally {
    client.destroy()
  }
}

function isTextStreamingModel(model: FoundationModelSummary): boolean {
  return (
    model.modelLifecycle?.status === 'ACTIVE' &&
    model.outputModalities?.includes('TEXT') === true &&
    model.responseStreamingSupported === true
  )
}

async function listInferenceProfiles(
  client: BedrockCatalogClient,
  abortSignal: AbortSignal
): Promise<InferenceProfileSummary[]> {
  const profiles: InferenceProfileSummary[] = []
  let nextToken: string | undefined
  do {
    const page = await client.send(new ListInferenceProfilesCommand({ maxResults: 100, nextToken }), { abortSignal })
    profiles.push(...(page.inferenceProfileSummaries ?? []))
    nextToken = page.nextToken
  } while (nextToken)
  return profiles
}

export function defaultBedrockClient(region?: string): BedrockCatalogClient {
  return new BedrockClient(region ? { region } : {})
}

export async function discoverAwsCredentials(
  environment: DetectedProviderEnvironment
): Promise<NonNullable<AwsConfigurationDiscovery['credentialStatus']>> {
  if (environment.AWS_BEARER_TOKEN_BEDROCK?.value) {
    return 'valid'
  }
  const client = new STSClient({
    ...awsClientConfiguration(environment),
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
  // Detection folds the profile's configured region into AWS_REGION, so this default only covers a profile without one.
  const region = environment.AWS_REGION?.value ?? environment.AWS_DEFAULT_REGION?.value ?? 'us-east-1'
  const profile = environment.AWS_PROFILE?.value ?? 'default'
  return {
    ...awsConfigurationFiles({
      AWS_CONFIG_FILE: environment.AWS_CONFIG_FILE?.value,
      AWS_SHARED_CREDENTIALS_FILE: environment.AWS_SHARED_CREDENTIALS_FILE?.value,
    }),
    region,
    profile,
    ...(credentials ? { credentials } : {}),
    // forceRefresh reruns the credential chain but retains its cached INI files.
    ignoreCache: true,
  }
}
