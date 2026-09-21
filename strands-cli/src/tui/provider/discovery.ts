import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { getTokenProvider } from '@aws/bedrock-token-generator'
import { BedrockClient } from '@aws-sdk/client-bedrock'
import { STSClient } from '@aws-sdk/client-sts'

import type { ProviderId } from '../config.js'
import type { DetectedProviderEnvironment } from './environment.js'
import { listBedrockModels, MODEL_DISCOVERY_TIMEOUT_MS } from './bedrock-catalog.js'
import { modelDisplayName } from '../model/display.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import { awsClientConfiguration } from './aws-client.js'

export { discoverAwsConfiguration, type AwsConfigurationDiscovery } from './aws-config.js'
export { discoverAwsCredentials } from './aws-client.js'

const run = promisify(execFile)

export interface OllamaDiscovery {
  installed: boolean
  running: boolean
  models: readonly string[]
}

export interface LiteLlmDiscovery {
  reachable: boolean
  authenticationRequired: boolean
  models: readonly ProviderModel[]
  status?: number
}

export interface ProviderModelDiscovery {
  models: readonly ProviderModel[]
  available: boolean
  complete?: boolean
  knownModelIds?: readonly string[]
}

export interface ProviderModel {
  id: string
  name: string
}

export async function discoverOllama(host: string): Promise<OllamaDiscovery> {
  let installed = true
  try {
    const { stdout } = await run('ollama', ['ls'], {
      env: { ...process.env, OLLAMA_HOST: host },
      timeout: 3_000,
      maxBuffer: 1_048_576,
    })
    const models = stdout
      .trim()
      .split(/\r?\n/u)
      .slice(1)
      .map((line) => sanitizeTerminalText(line.trim().split(/\s+/u)[0] ?? ''))
      .filter(Boolean)
    return { installed, running: true, models: [...new Set(models)].sort() }
  } catch (error) {
    installed = (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
  const models = await ollamaModels(host)
  return {
    installed,
    running: models !== undefined,
    models: models ?? [],
  }
}

export async function discoverLiteLlm(environment: DetectedProviderEnvironment): Promise<LiteLlmDiscovery> {
  const baseUrl = environment.LITELLM_BASE_URL?.value ?? 'http://127.0.0.1:4000'
  const root = baseUrl.trim().replace(/\/+$/u, '')
  let response: globalThis.Response
  try {
    response = await globalThis.fetch(`${root.endsWith('/v1') ? root : `${root}/v1`}/models`, {
      headers: environment.LITELLM_API_KEY?.value
        ? { authorization: `Bearer ${environment.LITELLM_API_KEY.value}` }
        : {},
      signal: AbortSignal.timeout(1_000),
    })
  } catch {
    return { reachable: false, authenticationRequired: false, models: [] }
  }
  if (response.status === 401 || response.status === 403) {
    return { reachable: true, authenticationRequired: true, models: [], status: response.status }
  }
  if (!response.ok) {
    return { reachable: true, authenticationRequired: false, models: [], status: response.status }
  }
  try {
    const value = (await response.json()) as unknown
    if (!isRecord(value)) {
      return { reachable: true, authenticationRequired: false, models: [] }
    }
    const models = recordArray(value, 'data')
      .map((model) => providerModel(model.id, model.name))
      .filter((model) => model !== undefined)
    return {
      reachable: true,
      authenticationRequired: false,
      models: cleanModels(models),
      status: response.status,
    }
  } catch {
    return { reachable: true, authenticationRequired: false, models: [], status: response.status }
  }
}

export async function discoverProviderModels(
  provider: ProviderId,
  environment: DetectedProviderEnvironment,
  ollama?: OllamaDiscovery
): Promise<ProviderModelDiscovery> {
  try {
    if (provider === 'bedrock') {
      const catalog = await listBedrockModels(new BedrockClient(awsClientConfiguration(environment)))
      return { ...catalog, models: cleanModels(catalog.models), available: true }
    }
    const models = await listProviderModels(provider, environment, ollama)
    return { models: cleanModels(models), available: true }
  } catch {
    return { models: [], available: false }
  }
}

export async function providerModelExists(
  provider: 'anthropic' | 'google',
  modelId: string,
  environment: DetectedProviderEnvironment
): Promise<boolean | undefined> {
  try {
    let response: globalThis.Response
    if (provider === 'anthropic') {
      response = await fetchResponse(`https://api.anthropic.com/v1/models/${encodeURIComponent(modelId)}`, {
        'anthropic-version': '2023-06-01',
        'x-api-key': requiredEnvironmentValue(environment, 'ANTHROPIC_API_KEY'),
      })
    } else {
      const collection = modelId.startsWith('tunedModels/') ? 'tunedModels' : 'models'
      const name = modelId.replace(/^(?:models|tunedModels)\//u, '')
      if (name.includes('/')) {
        return undefined
      }
      response = await fetchResponse(
        `https://generativelanguage.googleapis.com/v1beta/${collection}/${encodeURIComponent(name)}`,
        { 'x-goog-api-key': requiredEnvironmentValue(environment, 'GEMINI_API_KEY') }
      )
    }
    if (response.ok) {
      return true
    }
    if (response.status === 404) {
      const value: unknown = await response.json()
      if (
        isRecord(value) &&
        isRecord(value.error) &&
        (provider === 'anthropic' ? value.error.type === 'not_found_error' : value.error.status === 'NOT_FOUND')
      ) {
        return false
      }
    }
  } catch {
    // A failed lookup cannot establish that the model is invalid.
  }
  return undefined
}

export async function discoverContextWindow(
  provider: string,
  modelId: string,
  environment: DetectedProviderEnvironment
): Promise<number | undefined> {
  let limit: unknown
  try {
    switch (provider) {
      case 'anthropic': {
        const model = await fetchJson(`https://api.anthropic.com/v1/models/${encodeURIComponent(modelId)}`, {
          'anthropic-version': '2023-06-01',
          'x-api-key': requiredEnvironmentValue(environment, 'ANTHROPIC_API_KEY'),
        })
        limit = model.max_input_tokens
        break
      }
      case 'google': {
        const model = await fetchJson(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId.replace(/^models\//, ''))}`,
          { 'x-goog-api-key': requiredEnvironmentValue(environment, 'GEMINI_API_KEY') }
        )
        limit = model.inputTokenLimit
        break
      }
      case 'ollama': {
        const running = await fetchJson(
          `${ollamaApiRoot(environment.OLLAMA_HOST?.value ?? 'http://127.0.0.1:11434')}/api/ps`
        )
        const models = recordArray(running, 'models')
        const name = modelId.split('/').at(-1)?.includes(':') ? modelId : `${modelId}:latest`
        limit = models.find((model) => model.name === name || model.model === name)?.context_length
        break
      }
      default:
        return undefined
    }
  } catch {
    return undefined
  }
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined
}

async function ollamaModels(host: string): Promise<readonly string[] | undefined> {
  try {
    const response = await globalThis.fetch(`${ollamaApiRoot(host)}/api/tags`, {
      signal: AbortSignal.timeout(1_000),
    })
    if (!response.ok) {
      return undefined
    }
    const value = (await response.json()) as unknown
    if (!isRecord(value) || !Array.isArray(value.models)) {
      return undefined
    }
    return [
      ...new Set(
        value.models
          .filter(isRecord)
          .map((model) => model.name)
          .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      ),
    ].sort((left, right) => left.localeCompare(right))
  } catch {
    return undefined
  }
}

async function listProviderModels(
  provider: Exclude<ProviderId, 'bedrock'>,
  environment: DetectedProviderEnvironment,
  ollama: OllamaDiscovery | undefined
): Promise<readonly ProviderModel[]> {
  switch (provider) {
    case 'bedrock-mantle':
      return listBedrockMantleModels(environment)
    case 'anthropic':
      return listAnthropicModels(requiredEnvironmentValue(environment, 'ANTHROPIC_API_KEY'))
    case 'openai':
      return listOpenAiCompatibleModels(
        'https://api.openai.com/v1',
        requiredEnvironmentValue(environment, 'OPENAI_API_KEY')
      )
    case 'google':
      return listGoogleModels(requiredEnvironmentValue(environment, 'GEMINI_API_KEY'))
    case 'ollama': {
      const discovery = ollama ?? (await discoverOllama(environment.OLLAMA_HOST?.value ?? 'http://127.0.0.1:11434'))
      if (!discovery.running) {
        throw new Error('Ollama is not running')
      }
      return discovery.models.map((id) => ({ id, name: modelDisplayName(id) }))
    }
    case 'litellm':
      return listOpenAiCompatibleModels(
        environment.LITELLM_BASE_URL?.value ?? 'http://127.0.0.1:4000',
        environment.LITELLM_API_KEY?.value
      )
  }
}

async function listBedrockMantleModels(environment: DetectedProviderEnvironment): Promise<readonly ProviderModel[]> {
  const region = environment.AWS_REGION?.value ?? environment.AWS_DEFAULT_REGION?.value
  if (!region) {
    throw new Error('AWS_REGION is not configured')
  }
  const configuredToken = environment.AWS_BEARER_TOKEN_BEDROCK?.value
  if (configuredToken) {
    return listOpenAiCompatibleModels(`https://bedrock-mantle.${region}.api.aws`, configuredToken)
  }
  const client = new STSClient(awsClientConfiguration(environment))
  try {
    const token = await getTokenProvider({ region, credentials: client.config.credentials })()
    return await listOpenAiCompatibleModels(`https://bedrock-mantle.${region}.api.aws`, token)
  } finally {
    client.destroy()
  }
}

async function listAnthropicModels(apiKey: string): Promise<readonly ProviderModel[]> {
  const value = await fetchJson('https://api.anthropic.com/v1/models?limit=1000', {
    'anthropic-version': '2023-06-01',
    'x-api-key': apiKey,
  })
  return recordArray(value, 'data')
    .map((model) => providerModel(model.id, model.display_name))
    .filter((model) => model !== undefined)
}

async function listGoogleModels(apiKey: string): Promise<readonly ProviderModel[]> {
  const value = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`
  )
  return recordArray(value, 'models')
    .filter(
      (model) =>
        !Array.isArray(model.supportedGenerationMethods) || model.supportedGenerationMethods.includes('generateContent')
    )
    .map((model) =>
      providerModel(
        typeof model.name === 'string' ? model.name.replace(/^models\//u, '') : model.name,
        model.displayName
      )
    )
    .filter((model) => model !== undefined)
}

async function listOpenAiCompatibleModels(
  baseUrl: string,
  apiKey: string | undefined
): Promise<readonly ProviderModel[]> {
  const root = baseUrl.trim().replace(/\/+$/u, '')
  const value = await fetchJson(`${root.endsWith('/v1') ? root : `${root}/v1`}/models`, {
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  })
  return recordArray(value, 'data')
    .map((model) => providerModel(model.id, model.name))
    .filter((model) => model !== undefined)
}

async function fetchResponse(url: string, headers: Record<string, string>): Promise<globalThis.Response> {
  return globalThis.fetch(url, {
    headers,
    signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
  })
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await fetchResponse(url, headers)
  if (!response.ok) {
    throw new Error(`Model catalog request failed with status ${response.status}`)
  }
  const value = (await response.json()) as unknown
  if (!isRecord(value)) {
    throw new Error('Model catalog returned an invalid response')
  }
  return value
}

function requiredEnvironmentValue(
  environment: DetectedProviderEnvironment,
  key: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY'
): string {
  const value = environment[key]?.value
  if (!value) {
    throw new Error(`${key} is not configured`)
  }
  return value
}

function recordArray(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const items = value[key]
  return Array.isArray(items) ? items.filter(isRecord) : []
}

function cleanModels(models: readonly ProviderModel[]): ProviderModel[] {
  const clean = new Map<string, ProviderModel>()
  for (const model of models) {
    const id = sanitizeTerminalText(model.id).trim()
    if (!id) {
      continue
    }
    const sourceName = sanitizeTerminalText(model.name).trim()
    const derivedName = modelDisplayName(id)
    const name = derivedName !== id ? derivedName : sourceName || derivedName
    clean.set(id, { id, name })
  }
  const cleanedModels = [...clean.values()]
  const nameCounts = new Map<string, number>()
  for (const model of cleanedModels) {
    nameCounts.set(model.name, (nameCounts.get(model.name) ?? 0) + 1)
  }
  return cleanedModels
    .map((model) =>
      (nameCounts.get(model.name) ?? 0) > 1
        ? { ...model, name: `${model.name} · ${modelVariantName(model.id)}` }
        : model
    )
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

function providerModel(id: unknown, name: unknown): ProviderModel | undefined {
  if (typeof id !== 'string' || !id.trim()) {
    return undefined
  }
  return {
    id,
    name: typeof name === 'string' && name.trim() ? name : modelDisplayName(id),
  }
}

function modelVariantName(id: string): string {
  const labels: Record<string, string> = {
    global: 'Global',
    us: 'US',
    eu: 'EU',
    apac: 'APAC',
    au: 'Australia',
    jp: 'Japan',
  }
  return labels[/^(global|us|eu|apac|au|jp)\./u.exec(id)?.[1] ?? ''] ?? 'On-demand'
}

function ollamaApiRoot(host: string): string {
  return host.trim().replace(/\/+$/u, '').replace(/\/v1$/u, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
