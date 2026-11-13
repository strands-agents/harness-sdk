import {
  PROVIDER_ENVIRONMENT_KEYS,
  PROVIDER_IDS,
  withAwsProfile,
  type DetectedProviderEnvironment,
  type DetectedProviderEnvironmentValue,
  type ProviderEnvironment,
  type ProviderEnvironmentKey,
  type ProviderId,
  type CliConfigStore,
} from '../../config/store.js'
import { DEFAULT_HARNESS_AGENT_CONFIG, supportsWebSearch, type HarnessAgentConfig } from '@strands-agents/harness'
import {
  type AwsConfigurationDiscovery,
  type LiteLlmDiscovery,
  type OllamaDiscovery,
  discoverAwsConfiguration,
  discoverAwsCredentials,
  discoverLiteLlm,
  discoverOllama,
  discoverProviderModels,
  type ProviderModelDiscovery,
} from '../../model/discovery.js'
import { webSearchFallback, withoutProfileTool } from '../../agent/tools.js'
import { missingProviderPackage } from '../../model/packages.js'
import { effortForModel, profileEffort } from '../../model/selection.js'
import { type SelectOption, type SetupDraft } from './steps.js'
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'

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
      fields: readonly ProviderField[]
    }
  >
> = {
  bedrock: {
    fields: AWS_FIELDS,
  },
  'bedrock-mantle': {
    fields: AWS_FIELDS,
  },
  anthropic: {
    fields: [providerField('ANTHROPIC_API_KEY', 'Enter API Key', 'Enter API key')],
  },
  openai: {
    fields: [providerField('OPENAI_API_KEY', 'Enter API Key', 'Enter API key')],
  },
  google: {
    fields: [providerField('GEMINI_API_KEY', 'Enter API Key', 'Enter API key')],
  },
  ollama: {
    fields: [],
  },
  litellm: {
    fields: [providerField('LITELLM_API_KEY', 'Enter API Key', 'Enter API key')],
  },
}

export function quickstartDraft(model = DEFAULT_HARNESS_AGENT_CONFIG.model): SetupDraft {
  const provider = providerFromModel(model) ?? 'bedrock'
  const localProvider = provider === 'ollama' || provider === 'litellm'
  return {
    providers: [provider],
    profile: compatibleProfile({
      ...DEFAULT_HARNESS_AGENT_CONFIG,
      model,
      builtinTools: withoutProfileTool(DEFAULT_HARNESS_AGENT_CONFIG.builtinTools, 'web_search'),
      caching: !localProvider,
      effort: localProvider ? 'off' : DEFAULT_HARNESS_AGENT_CONFIG.effort,
    }),
    permissionMode: 'default',
    allowedTools: [],
    customPermissions: false,
    settings: { mcpDiscovery: true, skillDiscovery: true, agentMessaging: true },
  }
}

/** An explicit Exa selection wins even when the model also supports native search. */
export function exaWebSearchActive(profile: HarnessAgentConfig): boolean {
  return webSearchFallback(profile.builtinTools) === 'exa'
}

/** Without native search, `web_search` is only kept as the explicit Exa opt-in; the plain default would refuse to start. */
export function compatibleProfile(profile: HarnessAgentConfig): HarnessAgentConfig {
  const effort = compatibleEffort(profile)
  const withEffort = effort === profile.effort ? profile : { ...profile, effort }
  return supportsWebSearch(profile.model) || webSearchFallback(profile.builtinTools) === 'exa'
    ? withEffort
    : { ...withEffort, builtinTools: withoutProfileTool(profile.builtinTools, 'web_search') }
}

/** An effort level the model doesn't support falls back to `auto`, matching what the Reasoning row shows. */
function compatibleEffort({ model, effort }: HarnessAgentConfig): HarnessAgentConfig['effort'] {
  return effort === 'auto' || effort === 'off' ? effort : profileEffort(effortForModel(model, effort))
}

export function providerFromModel(model: string): ProviderId | undefined {
  const prefix = model.includes('/') ? model.slice(0, model.indexOf('/')) : 'bedrock'
  return PROVIDER_IDS.find((provider) => provider === prefix)
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
      description: 'Setup required',
      status: 'error',
      warning: `CLI installation is missing ${missingPackage} · reinstall @strands-agents/cli`,
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
Run aws login${profileArgument} or aws configure${profileArgument}.

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
    if (
      value &&
      (key === 'AWS_PROFILE' || (detected[key]?.source !== 'process' && detected[key]?.source !== 'session'))
    ) {
      environment[key] = { value, source: 'config' }
    }
  }
  return withAwsProfile(environment, aws)
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

type ProviderModels = ProviderModelDiscovery & { provider?: ProviderId; loading: boolean }

interface ProviderDiscovery {
  detectedEnvironment: DetectedProviderEnvironment
  providerEnvironment: ProviderEnvironment
  setProviderEnvironment: Dispatch<SetStateAction<ProviderEnvironment>>
  awsDiscovery: AwsConfigurationDiscovery
  setAwsDiscovery: Dispatch<SetStateAction<AwsConfigurationDiscovery>>
  ollamaDiscovery: OllamaDiscovery | undefined
  setOllamaDiscovery: Dispatch<SetStateAction<OllamaDiscovery | undefined>>
  liteLlmDiscovery: LiteLlmDiscovery | undefined
  setLiteLlmDiscovery: Dispatch<SetStateAction<LiteLlmDiscovery | undefined>>
  providerModels: ProviderModels
  setProviderModels: Dispatch<SetStateAction<ProviderModels>>
  effectiveEnvironment: DetectedProviderEnvironment
  readyProviders: ProviderId[]
  refreshVersion: number
  recheck(): void
}

export function useProviderDiscovery(config: CliConfigStore): ProviderDiscovery {
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [detectedEnvironment, setDetectedEnvironment] = useState(() => config.providerEnvironment({}))
  const [providerEnvironment, setProviderEnvironment] = useState(() => config.configuredProviderEnvironment())
  const [awsDiscovery, setAwsDiscovery] = useState(() => {
    const environment = config.providerEnvironment()
    return discoverAwsConfiguration({
      AWS_CONFIG_FILE: environment.AWS_CONFIG_FILE?.value,
      AWS_SHARED_CREDENTIALS_FILE: environment.AWS_SHARED_CREDENTIALS_FILE?.value,
    })
  })
  const [ollamaDiscovery, setOllamaDiscovery] = useState<OllamaDiscovery>()
  const [liteLlmDiscovery, setLiteLlmDiscovery] = useState<LiteLlmDiscovery>()
  const [providerModels, setProviderModels] = useState<ProviderModels>({
    models: [],
    available: false,
    loading: false,
  })
  const effectiveEnvironment = useMemo(
    () => effectiveProviderEnvironment(providerEnvironment, detectedEnvironment, awsDiscovery),
    [awsDiscovery, detectedEnvironment, providerEnvironment]
  )
  const readyProviders = useMemo(
    () =>
      PROVIDER_IDS.filter(
        (provider) =>
          providerAssessment(provider, effectiveEnvironment, awsDiscovery, ollamaDiscovery, liteLlmDiscovery)
            .warning === undefined
      ),
    [awsDiscovery, effectiveEnvironment, liteLlmDiscovery, ollamaDiscovery]
  )

  const recheck = useCallback((): void => {
    const detected = config.providerEnvironment({})
    const environment = effectiveProviderEnvironment(providerEnvironment, detected)
    setDetectedEnvironment(detected)
    setAwsDiscovery(
      discoverAwsConfiguration({
        AWS_CONFIG_FILE: environment.AWS_CONFIG_FILE?.value,
        AWS_SHARED_CREDENTIALS_FILE: environment.AWS_SHARED_CREDENTIALS_FILE?.value,
      })
    )
    setRefreshVersion((version) => version + 1)
  }, [config, providerEnvironment])

  return {
    detectedEnvironment,
    providerEnvironment,
    setProviderEnvironment,
    awsDiscovery,
    setAwsDiscovery,
    ollamaDiscovery,
    setOllamaDiscovery,
    liteLlmDiscovery,
    setLiteLlmDiscovery,
    providerModels,
    setProviderModels,
    effectiveEnvironment,
    readyProviders,
    refreshVersion,
    recheck,
  }
}

// Register effects after the wizard's input/viewport effects to preserve their commit order.
export function useProviderDiscoveryEffects(
  discovery: ProviderDiscovery,
  isProviderSetup: boolean,
  quickstartProvider: ProviderId
): void {
  const {
    effectiveEnvironment,
    readyProviders,
    ollamaDiscovery,
    liteLlmDiscovery,
    refreshVersion,
    setAwsDiscovery,
    setOllamaDiscovery,
    setLiteLlmDiscovery,
    setProviderModels,
    setProviderEnvironment,
  } = discovery
  const ollamaHost = effectiveEnvironment.OLLAMA_HOST?.value ?? 'http://127.0.0.1:11434'

  useEffect(() => {
    let cancelled = false
    setAwsDiscovery(({ credentialStatus: _, ...configuration }) => configuration)
    void discoverAwsCredentials(effectiveEnvironment).then((credentialStatus) => {
      if (!cancelled) {
        setAwsDiscovery((configuration) => ({ ...configuration, credentialStatus }))
      }
    })
    return (): void => {
      cancelled = true
    }
  }, [
    effectiveEnvironment.AWS_PROFILE?.value,
    effectiveEnvironment.AWS_CONFIG_FILE?.value,
    effectiveEnvironment.AWS_SHARED_CREDENTIALS_FILE?.value,
    effectiveEnvironment.AWS_REGION?.value,
    effectiveEnvironment.AWS_DEFAULT_REGION?.value,
    effectiveEnvironment.AWS_BEARER_TOKEN_BEDROCK?.value,
    effectiveEnvironment.AWS_ACCESS_KEY_ID?.value,
    effectiveEnvironment.AWS_SECRET_ACCESS_KEY?.value,
    effectiveEnvironment.AWS_SESSION_TOKEN?.value,
    refreshVersion,
  ])

  useEffect(() => {
    let cancelled = false
    setOllamaDiscovery(undefined)
    void discoverOllama(ollamaHost).then((discovery) => {
      if (!cancelled) {
        setOllamaDiscovery(discovery)
      }
    })
    return (): void => {
      cancelled = true
    }
  }, [ollamaHost, refreshVersion])

  useEffect(() => {
    if (!isProviderSetup) {
      setLiteLlmDiscovery(undefined)
      return
    }
    let cancelled = false
    setLiteLlmDiscovery(undefined)
    void discoverLiteLlm(effectiveEnvironment).then((discovery) => {
      if (!cancelled) {
        setLiteLlmDiscovery(discovery)
      }
    })
    return (): void => {
      cancelled = true
    }
  }, [
    effectiveEnvironment.LITELLM_API_KEY?.value,
    effectiveEnvironment.LITELLM_BASE_URL?.value,
    isProviderSetup,
    refreshVersion,
  ])

  useEffect(() => {
    if (!isProviderSetup || !readyProviders.includes(quickstartProvider)) {
      setProviderModels({ models: [], available: false, loading: false })
      return
    }
    if (quickstartProvider === 'litellm' && liteLlmDiscovery) {
      setProviderModels({
        provider: 'litellm',
        models: liteLlmDiscovery.models,
        available: true,
        loading: false,
      })
      return
    }
    let cancelled = false
    setProviderModels({ provider: quickstartProvider, models: [], available: false, loading: true })
    void discoverProviderModels(quickstartProvider, effectiveEnvironment, ollamaDiscovery).then((discovery) => {
      if (!cancelled) {
        setProviderModels({ provider: quickstartProvider, ...discovery, loading: false })
      }
    })
    return (): void => {
      cancelled = true
    }
  }, [effectiveEnvironment, isProviderSetup, liteLlmDiscovery, ollamaDiscovery, quickstartProvider, readyProviders])

  useEffect(() => {
    const detectedModel = ollamaDiscovery?.models[0]
    if (effectiveEnvironment.OLLAMA_MODEL || !detectedModel) {
      return
    }
    setProviderEnvironment((current) => ({ ...current, OLLAMA_MODEL: detectedModel }))
  }, [effectiveEnvironment.OLLAMA_MODEL, ollamaDiscovery])
}
