import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expandHome } from '../paths.js'

export interface AwsConfigurationDiscovery {
  profiles: readonly string[]
  regions: readonly string[]
  profileRegions?: Readonly<Record<string, string>>
  credentialProfiles?: readonly string[]
  credentialStatus?: 'valid' | 'missing' | 'expired' | 'unavailable'
}

export function requireBedrockRegion(model: unknown): void {
  if (
    model !== undefined &&
    (typeof model !== 'string' ||
      (model.includes('/') && !model.startsWith('bedrock/') && !model.startsWith('bedrock-mantle/')))
  ) {
    return
  }
  if (
    process.env.AWS_BEARER_TOKEN_BEDROCK &&
    !process.env.AWS_REGION &&
    !process.env.AWS_DEFAULT_REGION &&
    !discoverAwsConfiguration().profileRegions?.[process.env.AWS_PROFILE || 'default']
  ) {
    throw new Error(
      'A Bedrock API token is configured, but its region is missing. Set AWS_REGION or AWS_DEFAULT_REGION ' +
        'to the region that issued AWS_BEARER_TOKEN_BEDROCK.'
    )
  }
}

export function discoverAwsConfiguration(environment: NodeJS.ProcessEnv = process.env): AwsConfigurationDiscovery {
  const profiles = new Set<string>()
  const regions = new Set<string>()
  const profileRegions: Record<string, string> = Object.create(null)
  const profileFields = new Map<string, Set<string>>()
  const { filepath, configFilepath } = awsConfigurationFiles(environment)
  for (const [path, isConfigFile] of [
    [filepath, false],
    [configFilepath, true],
  ] as const) {
    const text = readConfiguration(path)
    let currentProfile: string | undefined
    for (const rawLine of text?.split(/\r?\n/u) ?? []) {
      const line = rawLine.trim()
      const section = /^\[([^\]]+)\]$/u.exec(line)?.[1]?.trim()
      if (section) {
        currentProfile =
          !isConfigFile || section === 'default'
            ? section
            : section.startsWith('profile ')
              ? section.slice('profile '.length).trim()
              : undefined
        if (currentProfile) {
          profiles.add(currentProfile)
          if (!profileFields.has(currentProfile)) profileFields.set(currentProfile, new Set())
        }
        continue
      }
      const region = /^region\s*=\s*([a-z0-9-]+)(?:\s*[#;].*)?$/iu.exec(line)?.[1]
      if (currentProfile && region) {
        regions.add(region)
        profileRegions[currentProfile] = region
      }
      const field = /^([a-z_]+)\s*=\s*\S/iu.exec(line)?.[1]?.toLowerCase()
      if (currentProfile && field) profileFields.get(currentProfile)!.add(field)
    }
  }
  return {
    profiles: [...profiles].sort(),
    regions: [...regions].sort(),
    profileRegions,
    credentialProfiles: [...profileFields].flatMap(([profile, fields]) =>
      (fields.has('aws_access_key_id') && fields.has('aws_secret_access_key')) ||
      fields.has('credential_process') ||
      fields.has('sso_session') ||
      fields.has('sso_start_url') ||
      (fields.has('role_arn') &&
        ['source_profile', 'credential_source', 'web_identity_token_file'].some((key) => fields.has(key)))
        ? [profile]
        : []
    ),
  }
}

export function awsConfigurationFiles(environment: NodeJS.ProcessEnv): { filepath: string; configFilepath: string } {
  return {
    filepath: environment.AWS_SHARED_CREDENTIALS_FILE || join(homedir(), '.aws', 'credentials'),
    configFilepath: environment.AWS_CONFIG_FILE || join(homedir(), '.aws', 'config'),
  }
}

function readConfiguration(path: string): string | undefined {
  try {
    path = expandHome(path)
    const stats = statSync(path)
    if (!stats.isFile() || stats.size > 1_048_576) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
