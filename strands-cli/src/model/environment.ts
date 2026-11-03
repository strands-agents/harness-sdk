import { lstatSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseEnv } from 'node:util'

import { errorMessage } from '../terminal/text.js'
import { discoverAwsConfiguration, type AwsConfigurationDiscovery } from './aws-config.js'

export const PROVIDER_ENVIRONMENT_KEYS = [
  'AWS_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'OLLAMA_HOST',
  'OLLAMA_MODEL',
  'LITELLM_BASE_URL',
  'LITELLM_API_KEY',
  'LITELLM_MODEL',
] as const

export type ProviderEnvironmentKey = (typeof PROVIDER_ENVIRONMENT_KEYS)[number]
export const PROVIDER_CREDENTIAL_KEYS: readonly ProviderEnvironmentKey[] = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'LITELLM_API_KEY',
]

export type ProviderEnvironment = Partial<Record<ProviderEnvironmentKey, string>>
export type ProviderEnvironmentSource =
  'process' | 'session' | 'config' | '.env.local' | '.env' | 'env-file' | 'aws-profile'

const appliedEnvironment = new Map<string, { original: string | undefined; value: string | undefined }>()

function processEnvironmentValue(key: string): string | undefined {
  return Object.hasOwn(process.env, key) ? process.env[key] : undefined
}

export function applyProviderEnvironmentValues(
  environment: Readonly<Record<string, string>>,
  useAwsProfile = false
): void {
  for (const [key, applied] of appliedEnvironment) {
    if (processEnvironmentValue(key) === applied.value) {
      if (applied.original === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = applied.original
      }
    }
  }
  appliedEnvironment.clear()
  for (const [key, value] of Object.entries(environment)) {
    const original = processEnvironmentValue(key)
    if (value && (!original || (key === 'AWS_PROFILE' && useAwsProfile))) {
      appliedEnvironment.set(key, { original, value })
      process.env[key] = value
    }
  }
  if (useAwsProfile) {
    const key = 'AWS_BEARER_TOKEN_BEDROCK'
    appliedEnvironment.set(key, { original: processEnvironmentValue(key), value: undefined })
    delete process.env[key]
  }
}

export interface DetectedProviderEnvironmentValue {
  value: string
  source: ProviderEnvironmentSource
}

export type DetectedProviderEnvironment = Partial<Record<ProviderEnvironmentKey, DetectedProviderEnvironmentValue>>
type DetectedEnvironment = Partial<Record<string, DetectedProviderEnvironmentValue>>

export function detectEnvironment(
  paths: readonly string[],
  stored: ProviderEnvironment,
  session: ProviderEnvironment = {}
): DetectedEnvironment {
  const files = new Map<string, DetectedProviderEnvironmentValue>()
  for (const path of paths) {
    const name = basename(path)
    const source = name === '.env' || name === '.env.local' ? name : 'env-file'
    for (const [key, value] of readEnvironmentFile(path)) {
      files.set(key, { value, source })
    }
  }
  const detected: DetectedEnvironment = Object.fromEntries(files)
  for (const key of PROVIDER_ENVIRONMENT_KEYS) {
    const value = stored[key]
    if (value) {
      detected[key] = { value, source: 'config' }
    }
  }
  for (const key of PROVIDER_ENVIRONMENT_KEYS) {
    const value = session[key]
    if (value) {
      detected[key] = { value, source: 'session' }
    }
  }
  for (const key of new Set([...PROVIDER_ENVIRONMENT_KEYS, ...files.keys()])) {
    const applied = appliedEnvironment.get(key)
    const current = processEnvironmentValue(key)
    const raw = applied && current === applied.value ? applied.original : current
    const processValue = key === 'AWS_CONFIG_FILE' || key === 'AWS_SHARED_CREDENTIALS_FILE' ? raw : raw?.trim()
    if (processValue && (key !== 'AWS_PROFILE' || !(session.AWS_PROFILE || stored.AWS_PROFILE))) {
      detected[key] = { value: processValue, source: 'process' }
    }
  }
  return withAwsProfile(detected)
}

export function withAwsProfile(
  environment: DetectedEnvironment,
  aws: AwsConfigurationDiscovery = discoverAwsConfiguration({
    AWS_CONFIG_FILE: environment.AWS_CONFIG_FILE?.value,
    AWS_SHARED_CREDENTIALS_FILE: environment.AWS_SHARED_CREDENTIALS_FILE?.value,
  })
): DetectedEnvironment {
  const resolved = { ...environment }
  if (resolved.AWS_PROFILE?.source === 'config' || resolved.AWS_PROFILE?.source === 'session') {
    delete resolved.AWS_BEARER_TOKEN_BEDROCK
  }
  if (resolved.AWS_REGION?.source === 'aws-profile') {
    delete resolved.AWS_REGION
  }
  if (!resolved.AWS_REGION && !resolved.AWS_DEFAULT_REGION) {
    const profile = resolved.AWS_PROFILE?.value ?? 'default'
    const region = aws.profileRegions?.[profile]
    if (region) {
      resolved.AWS_REGION = { value: region, source: 'aws-profile' }
    }
  }
  return resolved
}

function readEnvironmentFile(path: string): Map<string, string> {
  try {
    const stats = lstatSync(path)
    if (!stats.isFile() || stats.size > 1_048_576) {
      throw new Error('expected a regular file no larger than 1 MiB')
    }
    const environment = new Map<string, string>()
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line.trim())
      if (!match) {
        continue
      }
      // Node's plain-object result drops literal keys such as __proto__; parse only the value.
      const value = parseEnv(`VALUE=${match[2] ?? ''}`).VALUE
      if (value) {
        environment.set(match[1]!, value)
      }
    }
    return environment
  } catch (error) {
    throw new Error(`Cannot load environment file ${path}: ${errorMessage(error)}`, { cause: error })
  }
}
