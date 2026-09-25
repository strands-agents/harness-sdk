import type { Agent, Model } from '@strands-agents/sdk'

import type { ChatEffortOption } from '../chat/controller.js'
import { PROVIDER_IDS, type ProfileEffort, type ProviderId } from '../config.js'
import type { DetectedProviderEnvironment } from '../provider/environment.js'
import type { discoverContextWindow } from '../provider/discovery.js'
import {
  defaultBedrockClient,
  listBedrockModels,
  type BedrockCatalogClientFactory,
} from '../provider/bedrock-catalog.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import { modelDisplayName } from './display.js'
import { contextWindowLimit } from './context.js'
import {
  effortOptions,
  profileEffort,
  resolveModelTarget,
  effortForModel,
  effortValue,
  validateEffortSelection,
  validateModelSelection,
  type ModelTarget,
  type ProviderModelDiscoveryFunction,
  type SelectableModel,
  type EffortInput,
} from './selection.js'

interface AgentBuildRequest {
  model: string
  thinking: EffortInput
  sessionId?: string | null
  sessionDir?: string
  preserveConversation: boolean
  preserveReasoning?: boolean
  preserveSnapshot: boolean
  backgroundTasksWaitForCompletion: boolean
}

type AgentModelFactory = (request: AgentBuildRequest, previousAgent: Agent) => Promise<Agent>

interface AgentModelRuntimeOptions {
  createBedrockClient?: BedrockCatalogClientFactory
  discoverProviderModels?: ProviderModelDiscoveryFunction
  discoverContextWindow?: typeof discoverContextWindow
  providers?: readonly ProviderId[]
  providerEnvironment?: DetectedProviderEnvironment
  initialModel?: string
  thinking?: EffortInput
  sessionId?: string
  sessionDir?: string
  backgroundTasksWaitForCompletion?: boolean
  restartAgent?: AgentModelFactory
  newSessionId?: () => string
  onModelChange?: (change: { model: string; effort: ProfileEffort }) => Promise<void> | void
}

function reasoningProvider(modelId: string): string {
  const resource = modelId.slice(modelId.lastIndexOf('/') + 1)
  return resource.replace(/^(?:global|apac|us-gov|us|eu|au|jp)\./, '').split('.')[0] ?? resource
}

export class AgentModelRuntime {
  private _sessionId: string | undefined
  private _sessionDirectory: string
  private _target: ModelTarget | undefined
  private _thinking: Exclude<EffortInput, undefined>
  private _appliedThinking: Exclude<EffortInput, undefined>
  private _backgroundTasksWaitForCompletion: boolean | undefined
  private readonly _bedrockCatalogs = new Map<string | undefined, Promise<readonly SelectableModel[]>>()
  private readonly _providerCatalogs = new Map<ProviderId, Promise<readonly SelectableModel[]>>()
  private readonly _contextWindows = new Map<string, Promise<number | undefined>>()
  private readonly _createBedrockClient: BedrockCatalogClientFactory
  private readonly _discoverProviderModels: ProviderModelDiscoveryFunction | undefined
  private readonly _discoverContextWindow: typeof discoverContextWindow | undefined
  private readonly _providers: readonly ProviderId[]
  private readonly _providerEnvironment: DetectedProviderEnvironment
  private readonly _restartAgent: AgentModelFactory | undefined
  private readonly _newSessionId: (() => string) | undefined
  private readonly _onModelChange: AgentModelRuntimeOptions['onModelChange']

  constructor(
    private _agent: Agent,
    options: AgentModelRuntimeOptions = {}
  ) {
    this._sessionId = options.sessionId
    this._sessionDirectory = options.sessionDir ?? './.agent/sessions'
    this._thinking = options.thinking === undefined ? 'auto' : options.thinking
    this._appliedThinking = this._thinking
    this._backgroundTasksWaitForCompletion = options.backgroundTasksWaitForCompletion
    this._createBedrockClient = options.createBedrockClient ?? defaultBedrockClient
    this._discoverProviderModels = options.discoverProviderModels
    this._discoverContextWindow = options.discoverContextWindow
    this._providers = options.providers ?? []
    this._providerEnvironment = options.providerEnvironment ?? {}
    this._restartAgent = options.restartAgent
    this._newSessionId = options.newSessionId
    this._onModelChange = options.onModelChange
    if (options.initialModel) {
      this._target = resolveModelTarget(options.initialModel)
    }
  }

  get provider(): string {
    return this._target?.provider ?? modelProvider(this._agent.model)
  }

  get agent(): Agent {
    return this._agent
  }

  get sessionId(): string | undefined {
    return this._sessionId
  }

  get sessionDirectory(): string {
    return this._sessionDirectory
  }

  get current(): string {
    return this._agent.model.modelId || this._agent.model.constructor.name
  }

  get thinking(): Exclude<EffortInput, undefined> {
    return this._thinking
  }

  async contextWindow(): Promise<number | undefined> {
    const fallback = contextWindowLimit(this._agent.model)
    if (!this._discoverContextWindow) {
      return fallback
    }
    const provider = this.provider
    const key = `${provider}/${this.current}`
    let pending = this._contextWindows.get(key)
    if (!pending) {
      pending = this._discoverContextWindow(provider, this.current, this._providerEnvironment).then((limit) => {
        if (limit === undefined || provider === 'ollama') {
          this._contextWindows.delete(key)
        }
        return limit
      })
      this._contextWindows.set(key, pending)
    }
    return (await pending) ?? fallback
  }

  get backgroundTasksWaitForCompletion(): boolean | undefined {
    return this._backgroundTasksWaitForCompletion
  }

  async *stream(...args: Parameters<Agent['stream']>): ReturnType<Agent['stream']> {
    await this._applyPendingEffort()
    return yield* this._agent.stream(...args)
  }

  cancel(): void {
    this._agent.cancel()
  }

  async list(): Promise<readonly SelectableModel[]> {
    const configuredProviders =
      this._providers.length > 0
        ? this._providers
        : PROVIDER_IDS.includes(this.provider as ProviderId)
          ? [this.provider as ProviderId]
          : []
    const discovered = await Promise.all(
      configuredProviders.map((provider) => this._listProviderModels(provider).catch(() => []))
    )
    const models = discovered.flat()
    if (!models.some((model) => this._isActive(model.value ?? model.id))) {
      models.push(currentModel(this.current, this._target?.specifier, this.provider))
    }
    return models
      .map((model) => ({
        ...model,
        ...(model.active || this._isActive(model.value ?? model.id) ? { active: true } : {}),
      }))
      .sort((left, right) => {
        if (left.active) {
          return -1
        }
        if (right.active) {
          return 1
        }
        return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
      })
  }

  listEfforts(): readonly ChatEffortOption[] {
    return effortOptions(this._target?.specifier ?? this.current, this._thinking)
  }

  changeMode(modelId: string): 'live' | 'restart' {
    const target = resolveModelTarget(modelId)
    if (target.provider !== this.provider) {
      return 'restart'
    }
    if (target.modelId === this.current) {
      return 'live'
    }
    if (this.provider === 'bedrock' && bedrockLiveSwitchKey(target.modelId) === bedrockLiveSwitchKey(this.current)) {
      return 'live'
    }
    return 'restart'
  }

  async switch(modelId: string): Promise<string> {
    const target = resolveModelTarget(modelId)
    if (this.changeMode(modelId) === 'restart') {
      throw new Error(`Changing from ${this.current} to ${target.modelId} requires restarting the agent.`)
    }
    if (target.modelId !== this.current) {
      await validateModelSelection(modelId, this._discoverProviderModels, this._providerEnvironment)
      this._agent.model.updateConfig({ modelId: target.modelId })
    }
    this._target = target
    await this._notifyModelChange()
    return this.current
  }

  async restart(modelId: string): Promise<string> {
    if (!this._restartAgent) {
      throw new Error('This runtime cannot rebuild the agent.')
    }
    const target = resolveModelTarget(modelId)
    if (!this._isActive(modelId)) {
      await validateModelSelection(modelId, this._discoverProviderModels, this._providerEnvironment)
    }
    const thinking = effortForModel(target.specifier, this._thinking)
    const currentModelId = this._target?.modelId ?? this.current
    this._agent = await this._restartAgent(
      {
        model: target.specifier,
        thinking,
        ...(this._sessionId ? { sessionId: this._sessionId } : {}),
        sessionDir: this._sessionDirectory,
        preserveConversation: true,
        preserveReasoning: reasoningProvider(currentModelId) === reasoningProvider(target.modelId),
        preserveSnapshot: false,
        backgroundTasksWaitForCompletion: this._backgroundTasksWaitForCompletion ?? false,
      },
      this._agent
    )
    this._thinking = thinking
    this._appliedThinking = thinking
    this._target = target
    await this._notifyModelChange()
    return this.current
  }

  async setEffort(effort: string): Promise<string> {
    validateEffortSelection(effort, this.listEfforts())
    if (this._thinking === effort) {
      return effort
    }
    if (!this._restartAgent && effortValue(this._appliedThinking) !== effortValue(effort)) {
      throw new Error('This runtime cannot rebuild the agent.')
    }
    this._thinking = effort
    await this._notifyModelChange()
    return effort
  }

  async clear(): Promise<void> {
    if (!this._restartAgent) {
      throw new Error('This runtime cannot rebuild the agent.')
    }
    const target = resolveModelTarget(this._target?.specifier ?? this.current)
    const sessionId = this._newSessionId?.()
    this._agent = await this._restartAgent(
      {
        model: target.specifier,
        thinking: this._thinking,
        sessionId: sessionId ?? null,
        sessionDir: this._sessionDirectory,
        preserveConversation: false,
        preserveSnapshot: false,
        backgroundTasksWaitForCompletion: this._backgroundTasksWaitForCompletion ?? false,
      },
      this._agent
    )
    this._appliedThinking = this._thinking
    this._sessionId = sessionId
    this._target = target
  }

  async setBackgroundTasksWaitForCompletion(waitForCompletion: boolean): Promise<void> {
    if (this._backgroundTasksWaitForCompletion === undefined) {
      throw new Error('Background Tasks are disabled for this agent.')
    }
    if (!this._restartAgent) {
      throw new Error('This runtime cannot rebuild the agent.')
    }
    if (this._backgroundTasksWaitForCompletion === waitForCompletion) {
      return
    }
    const target = resolveModelTarget(this._target?.specifier ?? this.current)
    this._agent = await this._restartAgent(
      {
        model: target.specifier,
        thinking: this._thinking,
        ...(this._sessionId ? { sessionId: this._sessionId } : {}),
        sessionDir: this._sessionDirectory,
        preserveConversation: false,
        preserveSnapshot: true,
        backgroundTasksWaitForCompletion: waitForCompletion,
      },
      this._agent
    )
    this._appliedThinking = this._thinking
    this._backgroundTasksWaitForCompletion = waitForCompletion
    this._target = target
  }

  forkConfiguration(): {
    model: string
    thinking: Exclude<EffortInput, undefined>
    backgroundTasksWaitForCompletion: boolean
  } {
    const target = resolveModelTarget(this._target?.specifier ?? this.current)
    return {
      model: target.specifier,
      thinking: this._thinking,
      backgroundTasksWaitForCompletion: this._backgroundTasksWaitForCompletion ?? false,
    }
  }

  private async _notifyModelChange(): Promise<void> {
    await this._onModelChange?.({
      model: this._target?.specifier ?? this.current,
      effort: profileEffort(this._thinking),
    })
  }

  private async _applyPendingEffort(): Promise<void> {
    if (effortValue(this._appliedThinking) === effortValue(this._thinking)) {
      return
    }
    if (!this._restartAgent) {
      throw new Error('This runtime cannot rebuild the agent.')
    }
    const target = resolveModelTarget(this._target?.specifier ?? this.current)
    this._agent = await this._restartAgent(
      {
        model: target.specifier,
        thinking: this._thinking,
        ...(this._sessionId ? { sessionId: this._sessionId } : {}),
        sessionDir: this._sessionDirectory,
        preserveConversation: true,
        preserveSnapshot: false,
        backgroundTasksWaitForCompletion: this._backgroundTasksWaitForCompletion ?? false,
      },
      this._agent
    )
    this._appliedThinking = this._thinking
    this._target = target
  }

  private _listBedrockModels(region: string | undefined): Promise<readonly SelectableModel[]> {
    const cached = this._bedrockCatalogs.get(region)
    if (cached) {
      return cached
    }
    const pending = listBedrockModels(this._createBedrockClient(region)).then(({ models }) =>
      models.map((model) => ({
        ...model,
        value: `bedrock/${model.id}`,
        catalog: 'bedrock' as const,
      }))
    )
    this._bedrockCatalogs.set(region, pending)
    void pending.catch(() => {
      if (this._bedrockCatalogs.get(region) === pending) {
        this._bedrockCatalogs.delete(region)
      }
    })
    return pending
  }

  private _listProviderModels(provider: ProviderId): Promise<readonly SelectableModel[]> {
    if (provider === 'bedrock') {
      const config = this._agent.model.getConfig() as { region?: unknown }
      const configRegion = typeof config.region === 'string' ? config.region : undefined
      const region =
        configRegion ??
        this._providerEnvironment.AWS_REGION?.value ??
        this._providerEnvironment.AWS_DEFAULT_REGION?.value
      return this._listBedrockModels(region)
    }
    if (!this._discoverProviderModels) {
      return Promise.resolve([])
    }
    const cached = this._providerCatalogs.get(provider)
    if (cached) {
      return cached
    }
    const pending = this._discoverProviderModels(provider, this._providerEnvironment).then((discovery) => {
      if (!discovery.available) {
        this._providerCatalogs.delete(provider)
        return []
      }
      return discovery.models.map((model) => ({
        id: model.id,
        name: model.name,
        description: '',
        value: `${provider}/${model.id}`,
        catalog: provider,
      }))
    })
    this._providerCatalogs.set(provider, pending)
    void pending.catch(() => {
      if (this._providerCatalogs.get(provider) === pending) {
        this._providerCatalogs.delete(provider)
      }
    })
    return pending
  }

  private _isActive(specifier: string): boolean {
    const target = resolveModelTarget(specifier)
    const provider = this.provider
    const modelId = this._target?.modelId ?? this.current
    return target.provider === provider && target.modelId === modelId
  }
}

function modelProvider(model: Model): string {
  switch (model.constructor.name) {
    case 'BedrockModel':
      return 'bedrock'
    case 'AnthropicModel':
      return 'anthropic'
    case 'OpenAIModel':
      return 'openai'
    case 'GoogleModel':
      return 'google'
    default:
      return model.constructor.name
  }
}

function bedrockLiveSwitchKey(modelId: string): string {
  const resource = modelId.slice(modelId.lastIndexOf('/') + 1)
  const withoutRegion = resource.replace(/^(?:global|apac|us-gov|us|eu|au|jp)\./, '')
  const claude = withoutRegion.match(/^anthropic\.claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d+))?/)
  if (claude) {
    return `anthropic.claude-${claude[1]}-${claude[2]}-${claude[3] ?? '0'}`
  }
  return withoutRegion.replace(/(?:[-.]v?\d[\w.:-]*)$/, '')
}

function currentModel(id: string, value: string | undefined, provider: string): SelectableModel {
  const catalog: SelectableModel['catalog'] = PROVIDER_IDS.includes(provider as ProviderId)
    ? (provider as ProviderId)
    : 'current'
  const cleanId = sanitizeTerminalText(id)
  return {
    id: cleanId,
    name: modelDisplayName(cleanId),
    description: '',
    catalog,
    ...(provider !== 'bedrock' ? { active: true } : {}),
    ...(value ? { value: sanitizeTerminalText(value) } : {}),
  }
}
