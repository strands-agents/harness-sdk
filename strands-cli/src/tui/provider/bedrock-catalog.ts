import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type FoundationModelSummary,
  type InferenceProfileSummary,
} from '@aws-sdk/client-bedrock'

import type { SelectableModel } from '../model/selection.js'
import { modelDisplayName } from '../model/display.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'

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
