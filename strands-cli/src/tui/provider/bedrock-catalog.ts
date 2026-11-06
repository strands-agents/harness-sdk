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

// Models the CLI lists but that cannot run an agent: they do not support tool use with response
// streaming, or they are not chat models. Matched after stripping any cross-region inference prefix.
// Confirmed by the live ConverseStream tool-use runs recorded in #5562.
const UNRUNNABLE_BEDROCK_MODEL_PREFIXES = [
  'meta.llama',
  'mistral.mistral-7b-instruct',
  'mistral.mistral-large-2402',
  'mistral.mistral-small-2402',
  'mistral.mixtral-8x7b-instruct',
  'mistral.pixtral-large-2502',
  'deepseek.r1',
  'writer.palmyra',
  'amazon.nova-2-sonic',
  'amazon.nova-2-5-sonic',
  'twelvelabs.',
  'amazon.titan-text',
  'cohere.command-text',
  'cohere.command-light',
  'anthropic.claude-v2',
  'anthropic.claude-instant',
  'ai21.j2',
] as const

const BEDROCK_INFERENCE_PREFIXES = ['global.', 'apac.', 'us-gov.', 'us.', 'eu.', 'au.', 'jp.', 'ap.', 'in.'] as const

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
        if (model.modelId && isAgentRunnableModel(model)) {
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

function isAgentRunnableModel(model: FoundationModelSummary): boolean {
  return isTextStreamingModel(model) && !isUnrunnableBedrockModel(model.modelId ?? '')
}

function isUnrunnableBedrockModel(modelId: string): boolean {
  const family = bedrockModelFamily(modelId)
  return UNRUNNABLE_BEDROCK_MODEL_PREFIXES.some((prefix) => family.startsWith(prefix))
}

function bedrockModelFamily(modelId: string): string {
  const prefix = BEDROCK_INFERENCE_PREFIXES.find((candidate) => modelId.startsWith(candidate))
  return prefix ? modelId.slice(prefix.length) : modelId
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
