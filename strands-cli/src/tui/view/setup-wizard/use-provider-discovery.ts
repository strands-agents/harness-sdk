import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'

import {
  PROVIDER_IDS,
  type DetectedProviderEnvironment,
  type ProviderEnvironment,
  type CliConfigStore,
  type ProviderId,
} from '../../config.js'
import {
  discoverAwsConfiguration,
  discoverAwsCredentials,
  discoverLiteLlm,
  discoverOllama,
  discoverProviderModels,
  type AwsConfigurationDiscovery,
  type LiteLlmDiscovery,
  type OllamaDiscovery,
  type ProviderModelDiscovery,
} from '../../provider/discovery.js'
import { refreshProviderPackages } from '../../provider/packages.js'
import { effectiveProviderEnvironment, providerAssessment } from './providers.js'

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
  const [detectedEnvironment, setDetectedEnvironment] = useState(() => config.providerEnvironment())
  const [providerEnvironment, setProviderEnvironment] = useState(() => config.configuredProviderEnvironment())
  const [awsDiscovery, setAwsDiscovery] = useState(() =>
    discoverAwsConfiguration({
      AWS_CONFIG_FILE: detectedEnvironment.AWS_CONFIG_FILE?.value,
      AWS_SHARED_CREDENTIALS_FILE: detectedEnvironment.AWS_SHARED_CREDENTIALS_FILE?.value,
    })
  )
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
    refreshProviderPackages()
    const environment = config.providerEnvironment()
    setDetectedEnvironment(environment)
    setAwsDiscovery(
      discoverAwsConfiguration({
        AWS_CONFIG_FILE: environment.AWS_CONFIG_FILE?.value,
        AWS_SHARED_CREDENTIALS_FILE: environment.AWS_SHARED_CREDENTIALS_FILE?.value,
      })
    )
    setRefreshVersion((version) => version + 1)
  }, [config])

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
  quickstartProvider: ProviderId,
  setModelViewportStart: Dispatch<SetStateAction<number>>
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
      setModelViewportStart(0)
      setProviderModels({
        provider: 'litellm',
        models: liteLlmDiscovery.models,
        available: true,
        loading: false,
      })
      return
    }
    let cancelled = false
    setModelViewportStart(0)
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
