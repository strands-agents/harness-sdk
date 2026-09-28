import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AwsConfigurationDiscovery {
  profiles: readonly string[]
  regions: readonly string[]
  profileRegions?: Readonly<Record<string, string>>
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
  const profileRegions: Record<string, string> = {}
  const { filepath, configFilepath } = awsConfigurationFiles(environment)
  for (const path of [filepath, configFilepath]) {
    const text = readConfiguration(path)
    let currentProfile: string | undefined
    for (const rawLine of text?.split(/\r?\n/u) ?? []) {
      const line = rawLine.trim()
      const section = /^\[([^\]]+)\]$/u.exec(line)?.[1]?.trim()
      if (section) {
        currentProfile = section.startsWith('profile ') ? section.slice('profile '.length).trim() : section
        if (currentProfile) profiles.add(currentProfile)
        continue
      }
      const region = /^region\s*=\s*([a-z0-9-]+)(?:\s*[#;].*)?$/iu.exec(line)?.[1]
      if (currentProfile && region) {
        regions.add(region)
        profileRegions[currentProfile] = region
      }
    }
  }
  return {
    profiles: [...profiles].sort(),
    regions: [...regions].sort(),
    profileRegions,
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
    path = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
    const stats = statSync(path)
    if (!stats.isFile() || stats.size > 1_048_576) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
