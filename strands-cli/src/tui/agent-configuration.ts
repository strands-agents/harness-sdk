import {
  DEFAULT_HARNESS_AGENT_CONFIG,
  harnessAgentOptionsFromConfig,
  supportsWebSearch,
  type HarnessAgentConfig,
} from '@strands-agents/harness'
import {
  normalizeHarnessAgentConfig,
  resolveBuiltinTools,
  resolveModel,
  webSearchExplicit,
  webSearchMode,
} from '@strands-agents/harness/internal'
import { Message, TextBlock, tool, type Agent, type JSONSchema, type Tool } from '@strands-agents/sdk'

import { validateNoConfigSecrets } from './project/configuration.js'
import { EXA_WEB_SEARCH_WARNING, withoutProfileTool } from './builtin-tools.js'
import { PROVIDER_IDS, CliConfigStore, normalizeToolName, type SetupConfiguration, type ProviderId } from './config.js'
import { resolveModelTarget, validateModelSelection } from './model/selection.js'
import { discoverProviderModels } from './provider/discovery.js'
import type { ChatDiffPreview } from './chat/types.js'
import { createDiffPreview } from './permissions/file-change-preview.js'
import { SETTING_DEFINITIONS, VISUAL_SETTING_DEFINITIONS, parseSettings } from './settings.js'

const CONFIGURATION_SETTING_KEYS = new Set([
  ...VISUAL_SETTING_DEFINITIONS.map(({ key }) => key),
  'mcpDiscovery',
  'skillDiscovery',
  'agentMessaging',
])
const CONFIGURATION_SETTING_PROPERTIES: NonNullable<JSONSchema['properties']> = Object.fromEntries(
  SETTING_DEFINITIONS.filter(({ key }) => CONFIGURATION_SETTING_KEYS.has(key)).map(({ key, options }) => {
    const values = options.map(({ value }) => value)
    return [
      key,
      values.every((value) => typeof value === 'boolean') ? { type: 'boolean' } : { type: 'string', enum: values },
    ]
  })
)

export interface SetupChange {
  configuration?: SetupConfiguration
  agentProject?: string
  newConversation?: boolean
  conversationId?: string
  onFailure?: (message: string) => Promise<void>
}

export type RequestSetup = (change?: SetupChange) => void

export interface AgentSetupSelection {
  model: string
  effort: HarnessAgentConfig['effort']
  configuration: SetupConfiguration
}

export function configurationFromStore(config: CliConfigStore): SetupConfiguration {
  const snapshot = config.snapshot()
  return {
    providers: snapshot.providers.enabled,
    profile: snapshot.profile,
    profileBaseDir: snapshot.profileBaseDir ?? null,
    permissionMode: snapshot.permissions.mode,
    allowedTools: snapshot.permissions.allow,
    providerEnvironment: config.configuredProviderEnvironment(),
    settings: snapshot.settings,
  }
}

interface ConfigurationToolOptions {
  config: CliConfigStore
  profile(): HarnessAgentConfig
  agent(): Agent | undefined
  draft?: SetupConfiguration
  source?: string
}

export function createConfigurationTool(options: ConfigurationToolOptions): {
  tool: Tool
  profile(): HarnessAgentConfig
  preview(): ChatDiffPreview
  takePending(): SetupChange | undefined
} {
  let draft: SetupConfiguration | undefined = options.draft
  let pending: SetupChange | undefined
  let revision = 0
  const current = (): SetupConfiguration => {
    const saved = configurationFromStore(options.config)
    return draft
      ? { ...draft, settings: { ...saved.settings, ...draft.settings } }
      : { ...saved, profile: options.profile() }
  }

  const configurationTool = tool({
    name: 'strands_config',
    description:
      'Inspect, recommend, and change the persistent CLI configuration. inspect shows all supported profile fields and current values. ' +
      'Credential-bearing values are shown as [redacted]; omit them from patches to preserve their existing values. ' +
      'Use environment placeholders such as ${env:API_KEY} for new credentials. ' +
      'models lists provider models. update stages a patch; arrays replace existing arrays and object fields merge one level. ' +
      'apply requires the latest revision returned by inspect, update, or reset. ' +
      (options.draft
        ? 'reset starts a fresh setup draft from defaults, preserving detected providers. apply finishes setup and starts a new chat. '
        : 'apply saves the draft and reloads the agent after this turn, keeping the conversation. ') +
      'Use this for model, effort, prompt, tools, skills, plugins, memory, context management, appearance, and discovery settings. ' +
      'For a source-backed agent, inspect identifies its source; edit that code, then apply to reload it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['inspect', 'models', 'update', 'apply', ...(options.draft ? ['reset'] : [])] },
        revision: { type: 'integer', description: 'For apply: the revision returned by inspect, update, or reset.' },
        provider: { type: 'string', enum: [...PROVIDER_IDS] },
        query: { type: 'string', description: 'Optional model-name filter for models.' },
        profile: {
          type: 'object',
          description:
            'A patch using HarnessAgentConfig field names from inspect. builtinTools/builtinPlugins select built-ins; ' +
            'tools/plugins use portable module references, for example ' +
            '{"kind":"plugin","module":"./plugins/example.ts","export":"plugin","language":"typescript"}. ' +
            'contextManagement is auto, agentic, or off. ' +
            'Use agentConfig.backgroundTasks to enable/disable background tasks.',
          additionalProperties: true,
        },
        settings: {
          type: 'object',
          description:
            'CLI presentation and discovery settings. Appearance options include colorMode, frogTheme, transcriptSpacing, animations, showReasoning, and toolOutput.',
          properties: CONFIGURATION_SETTING_PROPERTIES,
          additionalProperties: false,
        },
        permissionMode: { type: 'string', enum: ['default', 'bypassPermissions'] },
        allowedTools: {
          type: 'array',
          description: 'Tool names that skip approval prompts when permissionMode is default.',
          items: { type: 'string' },
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    callback: async (input, context) => {
      const agent = options.agent()
      if (!agent || !context || context.agent !== agent) {
        throw new Error('Only the main conversation agent can change its configuration.')
      }
      const request = record(input, 'configuration request')
      if (request.action === 'models') {
        const provider = request.provider ?? resolveModelTarget(current().profile.model).provider
        if (!PROVIDER_IDS.includes(provider as ProviderId)) throw new Error('Unknown model provider.')
        const catalog = await discoverProviderModels(provider as ProviderId, options.config.providerEnvironment())
        const query = typeof request.query === 'string' ? request.query.toLowerCase() : ''
        return JSON.stringify({
          provider,
          available: catalog.available,
          models: catalog.models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query)),
        })
      }
      if (request.action === 'inspect') {
        const configuration = current()
        return JSON.stringify({
          revision,
          target: options.source ? { source: options.source } : { config: options.config.snapshot().path },
          ...(options.source
            ? {
                runtime: {
                  name: options.agent()?.name,
                  model: options.agent()?.model.modelId,
                  tools: options.agent()?.tools.map((tool) => tool.name),
                },
              }
            : { profile: redactedProfile(configuration.profile) }),
          settings: configuration.settings,
          permissionMode: configuration.permissionMode,
          allowedTools: configuration.allowedTools,
          providers: configuration.providers,
          builtins: {
            tools: DEFAULT_HARNESS_AGENT_CONFIG.builtinTools,
            plugins: DEFAULT_HARNESS_AGENT_CONFIG.builtinPlugins,
          },
          ...(options.draft ? { mode: 'setup draft; the assistant model is separate from this target model' } : {}),
        })
      }
      if (request.action === 'reset' && options.draft) {
        const setupDraft = options.draft
        const nextDraft: SetupConfiguration = {
          ...configurationFromStore(CliConfigStore.memory()),
          providers: setupDraft.providers,
          providerEnvironment: setupDraft.providerEnvironment,
          settings: current().settings ?? options.config.snapshot().settings,
        }
        if (!supportsWebSearch(nextDraft.profile.model)) {
          nextDraft.profile = {
            ...nextDraft.profile,
            builtinTools: withoutProfileTool(nextDraft.profile.builtinTools, 'web_search'),
          }
        }
        draft = nextDraft
        revision++
        pending = undefined
        return JSON.stringify({
          status: 'fresh setup draft; saved configuration is unchanged',
          revision,
          profile: nextDraft.profile,
        })
      }
      if (request.action === 'update') {
        if (options.source) {
          throw new Error(`This agent is defined in ${options.source}. Edit that source, then use apply to reload it.`)
        }
        const previous = current()
        const patch = request.profile === undefined ? {} : record(request.profile, 'profile')
        assertNoRedactedValues(patch)
        for (const key of Object.keys(patch)) {
          if (!Object.hasOwn(DEFAULT_HARNESS_AGENT_CONFIG, key)) {
            throw new Error(`Unknown profile field: ${key}. Use inspect for supported field names.`)
          }
        }
        validateNoConfigSecrets(
          { ...DEFAULT_HARNESS_AGENT_CONFIG, ...patch },
          typeof patch.mcpServers === 'string' ? {} : undefined
        )
        const profile = { ...previous.profile } as Record<string, unknown>
        for (const [key, value] of Object.entries(patch)) {
          const existing = profile[key]
          profile[key] =
            existing &&
            value &&
            typeof existing === 'object' &&
            typeof value === 'object' &&
            !Array.isArray(existing) &&
            !Array.isArray(value)
              ? { ...existing, ...value }
              : value
        }
        if (patch.model !== undefined && patch.modelModule === undefined) profile.modelModule = null
        const settingsPatch = request.settings === undefined ? {} : record(request.settings, 'settings')
        for (const key of Object.keys(settingsPatch)) {
          if (!CONFIGURATION_SETTING_KEYS.has(key)) {
            throw new Error(`Invalid setting: ${key}.`)
          }
        }
        const settings = parseSettings({ ...previous.settings, ...settingsPatch }, 'strands_config')
        const permissionMode = request.permissionMode ?? previous.permissionMode
        if (permissionMode !== 'default' && permissionMode !== 'bypassPermissions') {
          throw new Error('permissionMode must be default or bypassPermissions.')
        }
        const allowedTools =
          request.allowedTools === undefined ? previous.allowedTools : parseAllowedTools(request.allowedTools)
        draft = {
          ...previous,
          profile: normalizeHarnessAgentConfig(profile),
          settings: { ...previous.settings!, ...settings },
          permissionMode,
          ...(allowedTools === undefined ? {} : { allowedTools }),
        }
        revision++
        pending = undefined
        return JSON.stringify({
          status: 'draft updated; use apply when the user is ready',
          revision,
          profile: redactedProfile(draft.profile),
          settings: draft.settings,
          permissionMode,
          allowedTools,
        })
      }
      if (request.action === 'apply') {
        if (request.revision !== revision) {
          throw new Error('Inspect the latest configuration and pass its revision to apply.')
        }
        let exaNotice = ''
        if (options.source) {
          pending = {}
        } else {
          const configuration = current()
          const validatingRevision = revision
          const environment = options.config.providerEnvironment()
          const profile = configuration.profile
          const agentOptions = await harnessAgentOptionsFromConfig(
            profile,
            configuration.profileBaseDir ?? process.cwd()
          )
          if (!profile.modelModule) {
            await validateModelSelection(
              profile.model,
              discoverProviderModels,
              environment,
              'Use strands_config with action "models" to list available model IDs, then update the model and apply again.'
            )
            const webSearch = webSearchMode(
              resolveBuiltinTools(agentOptions.builtinTools).web_search,
              webSearchExplicit(agentOptions.builtinTools),
              profile.model
            )
            if (webSearch === 'exa') {
              exaNotice = `\nNote: ${EXA_WEB_SEARCH_WARNING}`
            }
            await resolveModel(
              profile.model,
              DEFAULT_HARNESS_AGENT_CONFIG.model,
              agentOptions.effort,
              webSearch === 'native',
              agentOptions.caching === undefined ? DEFAULT_HARNESS_AGENT_CONFIG.caching : Boolean(agentOptions.caching),
              agentOptions.caching !== undefined
            )
          }
          const provider = resolveModelTarget(profile.model).provider as ProviderId
          if (validatingRevision !== revision) {
            throw new Error('The configuration changed during validation. Inspect the latest draft and apply it again.')
          }
          pending = {
            ...(options.draft ? { newConversation: true } : {}),
            configuration: {
              ...configuration,
              providers: [...new Set([provider, ...configuration.providers])],
            },
          }
        }
        pending.onFailure = async (message): Promise<void> => {
          agent.messages.push(
            new Message({
              role: 'user',
              content: [
                new TextBlock(
                  `Setup result: the proposed configuration was not applied. The previous agent remains active.\n` +
                    `Reason: ${message}\n` +
                    'Use strands_config inspect/update to correct the draft before applying again.'
                ),
              ],
            })
          )
          await agent.sessionManager?.saveSnapshot({ target: agent, isLatest: true })
        }
        return (
          (options.draft
            ? 'Configuration validated. Your custom agent will launch in a fresh chat after this turn.'
            : 'Configuration validated. It will be applied after this turn, preserving the conversation.') + exaNotice
        )
      }
      throw new Error('Unknown strands_config action.')
    },
  })
  return {
    tool: configurationTool,
    profile(): HarnessAgentConfig {
      return current().profile
    },
    preview(): ChatDiffPreview {
      if (options.source) {
        return {
          path: options.source,
          lines: [{ kind: 'header', text: 'Reload the agent defined in this file.' }],
        }
      }
      const serialize = (configuration: SetupConfiguration): string =>
        JSON.stringify(
          {
            permissionMode: configuration.permissionMode,
            allowedTools: configuration.allowedTools,
            profile: redactedProfile(configuration.profile),
            settings: configuration.settings,
          },
          null,
          2
        )
      return createDiffPreview(
        options.config.snapshot().path,
        serialize(configurationFromStore(options.config)),
        serialize(current())
      )
    },
    takePending(): SetupChange | undefined {
      const change = pending
      pending = undefined
      return change
    },
  }
}

function assertNoRedactedValues(value: unknown): void {
  if (value === '[redacted]') {
    throw new Error('Do not copy [redacted] values from inspect. Send only changed fields and omit credential fields.')
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) assertNoRedactedValues(entry)
  }
}

function parseAllowedTools(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error('allowedTools must be an array of tool names.')
  }
  return [...new Set(value.map(normalizeToolName))].sort((left, right) => left.localeCompare(right))
}

function redactedProfile(profile: HarnessAgentConfig): unknown {
  return redactConfigValue(profile, (value) => {
    const candidate = { ...DEFAULT_HARNESS_AGENT_CONFIG, ...record(value, 'profile') }
    validateNoConfigSecrets(candidate, typeof candidate.mcpServers === 'string' ? {} : undefined)
  })
}

function redactConfigValue(value: unknown, validate: (value: unknown) => void): unknown {
  try {
    validate(value)
    return value
  } catch {
    // Keep argument arrays together so credentials following flags cannot lose their context.
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return '[redacted]'
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactConfigValue(entry, (candidate) => validate({ [key]: candidate })),
      ])
    )
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected an object for ${label}.`)
  return value as Record<string, unknown>
}
