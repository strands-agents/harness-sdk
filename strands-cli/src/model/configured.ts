import type { HarnessAgentConfig } from '@strands-agents/harness'

import type { DetectedProviderEnvironment } from './environment.js'
import { discoverAwsConfiguration } from './aws-config.js'

export function providerIsConfigured(
  profile: HarnessAgentConfig,
  detected: DetectedProviderEnvironment,
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  if (profile.modelModule) return true
  const provider = profile.model.split('/')[0]
  const value = (key: keyof DetectedProviderEnvironment): string | undefined => detected[key]?.value
  switch (provider) {
    case 'anthropic':
      return Boolean(value('ANTHROPIC_API_KEY'))
    case 'openai':
      return Boolean(value('OPENAI_API_KEY'))
    case 'google':
      return Boolean(value('GEMINI_API_KEY'))
    case 'ollama':
      return true
    case 'litellm':
      return Boolean(value('LITELLM_BASE_URL'))
  }
  const region = value('AWS_REGION') || value('AWS_DEFAULT_REGION')
  if (value('AWS_BEARER_TOKEN_BEDROCK')) return Boolean(region)
  if (region && value('AWS_ACCESS_KEY_ID') && value('AWS_SECRET_ACCESS_KEY')) return true
  if (
    region &&
    ((environment.AWS_ROLE_ARN && environment.AWS_WEB_IDENTITY_TOKEN_FILE) ||
      environment.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      environment.AWS_CONTAINER_CREDENTIALS_FULL_URI)
  ) {
    return true
  }
  const aws = discoverAwsConfiguration({
    ...environment,
    ...Object.fromEntries(Object.entries(detected).map(([key, entry]) => [key, entry.value])),
  })
  const selected = value('AWS_PROFILE') || 'default'
  return Boolean((region || aws.profileRegions?.[selected]) && aws.credentialProfiles?.includes(selected))
}
