import {
  PROVIDER_ENVIRONMENT_KEYS,
  PROVIDER_IDS,
  withAwsProfileRegion,
  type DetectedProviderEnvironment,
  type DetectedProviderEnvironmentValue,
  type ProviderEnvironment,
  type ProviderEnvironmentKey,
  type ProviderId,
} from '../../config.js'
import { DEFAULT_HARNESS_AGENT_CONFIG, supportsWebSearch, type HarnessAgentConfig } from '@strands-agents/harness'
import type { AwsConfigurationDiscovery, LiteLlmDiscovery, OllamaDiscovery } from '../../provider/discovery.js'
import { webSearchFallback, withoutProfileTool } from '../../builtin-tools.js'
import { missingProviderPackage } from '../../provider/packages.js'
import type { SelectOption, SetupDraft } from './types.js'

const COMMON_AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'ap-northeast-1',
  'ap-southeast-1',
  'ap-southeast-2',
] as const

interface ProviderField {
  key: ProviderEnvironmentKey
  label: string
  placeholder: string
  selector?: 'aws-region' | 'aws-profile'
}

const AWS_FIELDS: readonly ProviderField[] = [
  providerField('AWS_REGION', 'AWS region', 'Use AWS configuration', 'aws-region'),
  providerField('AWS_PROFILE', 'AWS profile', 'Default credential chain', 'aws-profile'),
  providerField('AWS_BEARER_TOKEN_BEDROCK', 'Bedrock API token', 'Set AWS_BEARER_TOKEN_BEDROCK'),
]

export const PROVIDERS: Readonly<
  Record<
    ProviderId,
    {
      model(environment: DetectedProviderEnvironment): string
      fields: readonly ProviderField[]
    }
  >
> = {
  bedrock: {
    model: () => DEFAULT_HARNESS_AGENT_CONFIG.model,
    fields: AWS_FIELDS,
  },
  'bedrock-mantle': {
    model: () => 'bedrock-mantle/openai.gpt-5.6-sol',
    fields: AWS_FIELDS,
  },
  anthropic: {
    model: () => 'anthropic/claude-opus-4-8',
    fields: [providerField('ANTHROPIC_API_KEY', 'Enter API Key', 'Enter API key')],
  },
  openai: {
    model: () => 'openai/gpt-5.6-sol',
    fields: [providerField('OPENAI_API_KEY', 'Enter API Key', 'Enter API key')],
  },
  google: {
    model: () => 'google/gemini-3.5-flash',
    fields: [providerField('GEMINI_API_KEY', 'Enter API Key', 'Enter API key')],
  },
  ollama: {
    model: (environment) => `ollama/${environment.OLLAMA_MODEL?.value || 'llama3.2'}`,
    fields: [],
  },
  litellm: {
    model: (environment) => `litellm/${environment.LITELLM_MODEL?.value || 'openai/gpt-4o-mini'}`,
    fields: [providerField('LITELLM_API_KEY', 'Enter API Key', 'Enter API key')],
  },
}

export function quickstartDraft(provider: ProviderId, environment: DetectedProviderEnvironment): SetupDraft {
  const localProvider = provider === 'ollama' || provider === 'litellm'
  return {
    providers: [provider],
    profile: compatibleProfile({
      ...DEFAULT_HARNESS_AGENT_CONFIG,
      model: PROVIDERS[provider].model(environment),
      caching: !localProvider,
      effort: localProvider ? 'off' : DEFAULT_HARNESS_AGENT_CONFIG.effort,
    }),
    permissionMode: 'default',
    allowedTools: [],
    customPermissions: false,
    settings: { mcpDiscovery: false, skillDiscovery: false, agentMessaging: true },
  }
}

/** Whether this profile's `web_search` will actually go to Exa: opted in, on a model without native search. */
export function exaWebSearchActive(profile: HarnessAgentConfig): boolean {
  return !providerSupportsWebSearch(profile.model) && webSearchFallback(profile.builtinTools) === 'exa'
}

/** Without native search, `web_search` is only kept as the explicit Exa opt-in; the plain default would refuse to start. */
export function compatibleProfile(profile: HarnessAgentConfig): HarnessAgentConfig {
  return providerSupportsWebSearch(profile.model) || webSearchFallback(profile.builtinTools) === 'exa'
    ? profile
    : { ...profile, builtinTools: withoutProfileTool(profile.builtinTools, 'web_search') }
}

export function providerFromModel(model: string): ProviderId | undefined {
  const prefix = model.includes('/') ? model.slice(0, model.indexOf('/')) : 'bedrock'
  return PROVIDER_IDS.find((provider) => provider === prefix)
}

export function providerSupportsWebSearch(model: string): boolean {
  return supportsWebSearch(model)
}

export interface ProviderAssessment {
  description: string
  status: 'success' | 'warning' | 'error'
  facts?: readonly {
    label: string
    value: string
    status: 'success' | 'warning' | 'error'
  }[]
  warning?: string
}

export function providerAssessment(
  provider: ProviderId,
  environment: DetectedProviderEnvironment,
  aws: AwsConfigurationDiscovery,
  ollama: OllamaDiscovery | undefined,
  litellm: LiteLlmDiscovery | undefined = undefined
): ProviderAssessment {
  const missingPackage = missingProviderPackage(provider)
  if (missingPackage) {
    return {
      description: `Requires ${missingPackage}`,
      status: 'error',
      warning: `Install ${missingPackage} next to strands-cli, then choose Refresh:\nnpm install -g ${missingPackage}`,
    }
  }
  if (provider === 'bedrock' || provider === 'bedrock-mantle') {
    if (environment.AWS_BEARER_TOKEN_BEDROCK && !environment.AWS_REGION && !environment.AWS_DEFAULT_REGION) {
      return {
        description: 'Setup incomplete',
        status: 'warning',
        warning: 'Set AWS_REGION or AWS_DEFAULT_REGION to the region that issued your Bedrock API token.',
      }
    }
    if (aws.credentialStatus === 'valid') {
      return { description: 'Credentials detected', status: 'success' }
    }
    if (aws.credentialStatus === undefined) {
      return {
        description: 'Checking credentials...',
        status: 'warning',
        warning: 'Checking AWS credentials...',
      }
    }
    const problem =
      aws.credentialStatus === 'missing'
        ? 'were not detected'
        : aws.credentialStatus === 'expired'
          ? 'expired'
          : 'could not be verified'
    const profileArgument = environment.AWS_PROFILE?.value ? ` --profile ${environment.AWS_PROFILE.value}` : ''
    return {
      description:
        aws.credentialStatus === 'missing'
          ? 'Credentials not found'
          : aws.credentialStatus === 'expired'
            ? 'Credentials expired'
            : 'Credentials unavailable',
      status: 'error',
      warning: `AWS credentials ${problem}.
For Midway credentials, run mwinit, then:
ada credentials update --account=<account-id> --provider=isengard --role=<role-name> --once

Otherwise: aws sso login${profileArgument} or aws configure${profileArgument}.

For an API token, set AWS_BEARER_TOKEN_BEDROCK and its AWS_REGION.
Choose Refresh after updating credentials or a selected env file.
New shell exports require restarting strands.`,
    }
  }
  if (provider === 'ollama') {
    if (!ollama) {
      return {
        description: 'Checking installation and models...',
        status: 'warning',
        facts: [
          { label: 'Ollama', value: 'Checking...', status: 'warning' },
          { label: 'Models', value: 'Checking...', status: 'warning' },
        ],
        warning: 'Checking local setup...',
      }
    }
    if (!ollama.running) {
      return ollama.installed
        ? {
            description: 'Setup incomplete',
            status: 'warning',
            facts: [
              { label: 'Ollama', value: 'Found', status: 'success' },
              { label: 'Models', value: 'Not checked', status: 'warning' },
            ],
            warning: 'Start Ollama with ollama serve, then choose Refresh.',
          }
        : {
            description: 'Setup required',
            status: 'error',
            facts: [
              { label: 'Ollama', value: 'Not found', status: 'error' },
              { label: 'Models', value: 'Not checked', status: 'warning' },
            ],
            warning: environment.OLLAMA_HOST?.value
              ? 'Start Ollama at OLLAMA_HOST, then choose Refresh.'
              : 'Install Ollama from https://ollama.com/download, then choose Refresh.',
          }
    }
    if (ollama.models.length === 0) {
      return {
        description: 'Setup incomplete',
        status: 'warning',
        facts: [
          { label: 'Ollama', value: 'Found', status: 'success' },
          { label: 'Models', value: '0 found', status: 'warning' },
        ],
        warning: 'Run ollama pull {model id}, then choose Refresh.',
      }
    }
    const configuredModel = environment.OLLAMA_MODEL?.value
    if (
      configuredModel &&
      !ollama.models.some((model) => model.replace(/:latest$/, '') === configuredModel.replace(/:latest$/, ''))
    ) {
      return {
        description: 'Setup incomplete',
        status: 'warning',
        facts: [
          { label: 'Ollama', value: 'Found', status: 'success' },
          { label: 'Models', value: `${modelCount(ollama.models.length)} found`, status: 'success' },
          { label: 'Selected model', value: 'Not found', status: 'warning' },
        ],
        warning: 'Run ollama pull {model id}, or unset OLLAMA_MODEL to use an installed model. Then choose Refresh.',
      }
    }
    return {
      description: `Ready · ${modelCount(ollama.models.length)} found`,
      status: 'success',
    }
  }
  if (provider === 'litellm') {
    if (!litellm) {
      return {
        description: 'Checking proxy and models...',
        status: 'warning',
        facts: [
          { label: 'LiteLLM', value: 'Checking...', status: 'warning' },
          { label: 'Models', value: 'Checking...', status: 'warning' },
        ],
        warning: 'Checking local setup...',
      }
    }
    if (!litellm.reachable) {
      return {
        description: 'Setup required',
        status: 'error',
        facts: [
          { label: 'LiteLLM', value: 'Not found', status: 'error' },
          { label: 'Models', value: 'Not checked', status: 'warning' },
        ],
        warning: environment.LITELLM_BASE_URL
          ? 'Start the LiteLLM proxy at LITELLM_BASE_URL, then choose Refresh.'
          : 'Start the LiteLLM proxy on localhost:4000, then choose Refresh.',
      }
    }
    if (litellm.authenticationRequired) {
      return {
        description: 'Setup incomplete',
        status: 'warning',
        facts: [
          { label: 'LiteLLM', value: 'Found', status: 'success' },
          { label: 'Models', value: 'Authentication required', status: 'warning' },
        ],
        warning: environment.LITELLM_API_KEY
          ? 'Update LITELLM_API_KEY below, then choose Refresh.'
          : 'Enter LITELLM_API_KEY below, then choose Refresh.',
      }
    }
    if (litellm.status !== undefined && (litellm.status < 200 || litellm.status >= 300)) {
      return {
        description: 'Setup incomplete',
        status: 'warning',
        facts: [
          { label: 'LiteLLM', value: 'Found', status: 'success' },
          { label: 'Models', value: `HTTP ${litellm.status}`, status: 'warning' },
        ],
        warning: 'Check the proxy configuration, then choose Refresh.',
      }
    }
    if (litellm.models.length === 0) {
      return {
        description: 'Setup incomplete',
        status: 'warning',
        facts: [
          { label: 'LiteLLM', value: 'Found', status: 'success' },
          { label: 'Models', value: '0 found', status: 'warning' },
        ],
        warning: 'Configure at least one model, then choose Refresh.',
      }
    }
    return {
      description: `Ready · ${modelCount(litellm.models.length)} found`,
      status: 'success',
    }
  }
  const key = PROVIDERS[provider].fields[0]!.key
  return environment[key]
    ? { description: 'Credentials detected', status: 'success' }
    : {
        description: 'Setup required',
        status: 'error',
        warning: `${key} was not detected.`,
      }
}

function modelCount(count: number): string {
  return `${count} ${count === 1 ? 'model' : 'models'}`
}

export function providerSelectOptions(
  field: ProviderField,
  environment: DetectedProviderEnvironment,
  aws: AwsConfigurationDiscovery
): readonly SelectOption[] | undefined {
  const current = environment[field.key]?.value
  if (field.selector === 'aws-profile') {
    return selectOptions(
      [
        { label: 'Default credential chain', value: '' },
        ...aws.profiles.map((profile) => ({ label: profile, value: profile })),
      ],
      current,
      'Enter profile name...'
    )
  }
  if (field.selector === 'aws-region') {
    return selectOptions(
      [...new Set([...aws.regions, ...COMMON_AWS_REGIONS])].map((region) => ({ label: region, value: region })),
      current,
      'Enter region...'
    )
  }
  return undefined
}

export function effectiveProviderEnvironment(
  configured: ProviderEnvironment,
  detected: DetectedProviderEnvironment,
  aws?: AwsConfigurationDiscovery
): DetectedProviderEnvironment {
  const environment = { ...detected }
  for (const key of PROVIDER_ENVIRONMENT_KEYS) {
    const value = configured[key]
    if (value && detected[key]?.source !== 'process') {
      environment[key] = { value, source: 'config' }
    }
  }
  return withAwsProfileRegion(environment, aws)
}

export function sourceLabel(source: DetectedProviderEnvironmentValue['source']): string {
  switch (source) {
    case 'process':
      return 'environment'
    case 'session':
      return 'this session'
    case 'config':
      return 'CLI config'
    case '.env.local':
    case '.env':
      return source
    case 'env-file':
      return 'selected env file'
    case 'aws-profile':
      return 'AWS profile'
  }
}

export function credentialSetupDescription(): string {
  return `Session only · Add to ${shellProfileHint()} for future sessions`
}

function shellProfileHint(shell = process.env.SHELL): string {
  if (shell?.endsWith('/zsh')) {
    return '~/.zshrc'
  }
  if (shell?.endsWith('/bash')) {
    return '~/.bashrc'
  }
  if (shell?.endsWith('/fish')) {
    return '~/.config/fish/config.fish'
  }
  return 'your shell profile'
}

function selectOptions(
  options: readonly SelectOption[],
  current: string | undefined,
  customLabel: string
): readonly SelectOption[] {
  const includesCurrent = options.some((option) => option.value === current)
  return [
    ...(current !== undefined && !includesCurrent ? [{ label: `${current} (current)`, value: current }] : []),
    ...options,
    { label: customLabel, custom: true },
  ]
}

function providerField(
  key: ProviderEnvironmentKey,
  label: string,
  placeholder: string,
  selector?: ProviderField['selector']
): ProviderField {
  return { key, label, placeholder, ...(selector ? { selector } : {}) }
}
