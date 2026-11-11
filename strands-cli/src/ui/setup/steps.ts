import {
  type HarnessAgentConfig,
  DEFAULT_HARNESS_AGENT_CONFIG,
  supportsWebSearch,
  type BuiltinToolName,
  type HarnessConfigBuiltinTools,
} from '@strands-agents/harness'
import { DEFAULT_MEMORY_DIR, DEFAULT_SKILLS_DIR } from '@strands-agents/harness/internal'
import {
  PROVIDER_CREDENTIAL_KEYS,
  PROVIDER_LABELS,
  PROVIDER_IDS,
  type DetectedProviderEnvironment,
  type ProviderEnvironment,
  type ProviderId,
  type PermissionMode,
  type ProviderEnvironmentKey,
} from '../../config/store.js'
import { type AwsConfigurationDiscovery, type LiteLlmDiscovery, type OllamaDiscovery } from '../../model/discovery.js'
import { effortOptions, profileEffort, effortDisplayLabel, effortForModel } from '../../model/selection.js'
import {
  builtinToolChoices,
  enabledProfileTools,
  profileToolEnabled,
  withBuiltinToolChoice,
  withProfileTool,
  withoutProfileTool,
  withWebSearchFallback,
} from '../../agent/tools.js'
import { canUseNativePicker } from '../../terminal/directory-picker.js'
import { type ChatSettings } from '../chat/types.js'
import { SETTING_DEFINITIONS } from '../../config/settings.js'
import { PERMISSION_CHOICES, permissionToolDescription, permissionToolNames } from '../permission-options.js'
import {
  PROVIDERS,
  compatibleProfile,
  credentialSetupDescription,
  effectiveProviderEnvironment,
  exaWebSearchActive,
  providerAssessment,
  providerSelectOptions,
  sourceLabel,
} from './providers.js'

/** Whether a profile configures any skills, before optional source discovery. */
export function profileSkillsEnabled(profile: Pick<HarnessAgentConfig, 'skills'>): boolean {
  return profile.skills !== false && (!Array.isArray(profile.skills) || profile.skills.length > 0)
}

/** The skill directories a profile configures; the `true` default spells the library's default directory. */
export function profileSkillPaths(profile: Pick<HarnessAgentConfig, 'skills'>): string[] {
  const { skills } = profile
  if (skills === false) return []
  if (skills === true) return [DEFAULT_SKILLS_DIR]
  return typeof skills === 'string' ? [skills] : [...skills]
}

export function profileMemoryEnabled(profile: Pick<HarnessAgentConfig, 'memory'>): boolean {
  return profile.memory !== false
}

export function profileMemoryDir(profile: Pick<HarnessAgentConfig, 'memory'>): string {
  const { memory } = profile
  return typeof memory === 'object' ? (memory.dir ?? DEFAULT_MEMORY_DIR) : DEFAULT_MEMORY_DIR
}

/** A `memory` value with the given directory: the default directory keeps the plain `true`. */
export function memoryForDir(dir: string): HarnessAgentConfig['memory'] {
  return dir === '' || dir === DEFAULT_MEMORY_DIR ? true : { dir }
}

export function contextManagerLabel(value: HarnessAgentConfig['contextManager']): string {
  return value === false ? 'off' : value
}

export const CUSTOMIZE_STEPS = ['Model', 'Agent', 'Tools', 'Plugins & features', 'Data', 'Safety', 'Review'] as const
export const SETTINGS_STEP = CUSTOMIZE_STEPS.length + 1
export const OPENING_CHOICES = [
  { id: 'quickstart', title: 'Quickstart', description: 'Pick a model and start working with your harness!' },
  {
    id: 'customize',
    title: 'Customize',
    description: 'Customize your harness from scratch. Model, prompt, tools, and beyond.',
  },
  { id: 'import', title: 'Import', description: 'Load in your custom harness from a file or zip.' },
] as const
const SETUP_STEP_INSTRUCTIONS = {
  quickstart: ['Pick a model for your agent'],
  customize: [
    'Pick a model for your agent',
    'Name and instruct your agent',
    "Choose your agent's tools",
    'Choose plugins and features',
    'Configure context and memory',
    'Set tool permissions',
    'Review your agent',
  ],
  import: ['Choose an agent to import'],
} as const satisfies Record<SetupFlow, readonly string[]>

export function setupStepProgress(
  flow: SetupFlow | undefined,
  step: number
): { current: number; total: number; instruction: string; label?: string } | undefined {
  if (!flow || step === 0 || step === SETTINGS_STEP || (flow === 'import' && step === 1)) {
    return undefined
  }
  const instruction = SETUP_STEP_INSTRUCTIONS[flow][step - 1]!
  if (flow !== 'customize') {
    return { current: step, total: SETUP_STEP_INSTRUCTIONS[flow].length, instruction }
  }
  // Review closes the flow rather than counting as a step.
  const total = CUSTOMIZE_STEPS.length - 1
  return step > total ? { current: total, total, instruction, label: 'Review' } : { current: step, total, instruction }
}

const noop = (): void => {}

export function appearanceSettings(settings: ChatSettings): AppearanceSettings {
  const { frogTheme, transcriptSpacing, animations, showReasoning, toolOutput } = settings
  return {
    frogTheme,
    transcriptSpacing,
    animations,
    showReasoning,
    toolOutput,
  }
}

export function wizardSettingsRows(settings: ChatSettings, update: (settings: ChatSettings) => void): WizardRow[] {
  return SETTING_DEFINITIONS.map(({ key, label, section, options }) => ({
    id: key,
    label,
    description: '',
    section,
    choices: options.map(({ label: optionLabel, value }) => ({
      label: optionLabel,
      value,
      active: settings[key] === value,
      activate: (): void => {
        update({ ...settings, [key]: value } as ChatSettings)
      },
    })),
    activate: noop,
  }))
}

export function rowsForStep(
  step: number,
  flow: SetupFlow | undefined,
  draft: SetupDraft,
  importPath: string,
  providerEnvironment: ProviderEnvironment,
  detectedEnvironment: DetectedProviderEnvironment,
  selectedProvider: ProviderId,
  readyProviders: readonly ProviderId[],
  awsDiscovery: AwsConfigurationDiscovery,
  ollamaDiscovery: OllamaDiscovery | undefined,
  setDraft: (update: (current: SetupDraft) => SetupDraft) => void,
  updateProfile: (update: Partial<HarnessAgentConfig>) => void,
  setEditing: (editing: { field: EditableField; value: string }) => void,
  liteLlmDiscovery?: LiteLlmDiscovery,
  credentialRejectedProvider?: ProviderId,
  credentialValidationProvider?: ProviderId,
  credentialRejectionMessage?: string
): WizardRow[] {
  const environment = effectiveProviderEnvironment(providerEnvironment, detectedEnvironment, awsDiscovery)
  if (flow === 'customize' && step === 3) {
    return toolSelectionRows(draft, setDraft)
  }
  if (flow === 'customize' && step === 4) {
    return pluginSelectionRows(draft, setDraft, updateProfile)
  }
  const edit =
    (field: EditableField, value: string): (() => void) =>
    () =>
      setEditing({ field, value })
  if (step === 0) {
    return OPENING_CHOICES.map((choice) => ({
      id: choice.id,
      label: choice.title,
      description: choice.description,
      activate: noop,
    }))
  }
  if (step === 1 && flow === 'import') {
    return [
      {
        id: 'import-path',
        label: 'Path to ZIP, file, or folder',
        description: importPath,
        input: true,
        field: 'importPath',
        activate: edit('importPath', importPath),
      },
      ...(canUseNativePicker()
        ? [
            {
              id: 'import-browse',
              label: 'Browse',
              description: 'Choose an agent ZIP, source file, or project folder',
              activate: noop,
            },
          ]
        : []),
    ]
  }
  if (step === 1) {
    const rows: WizardRow[] = PROVIDER_IDS.map((id) => {
      const enabled = readyProviders.includes(id)
      const assessment = providerAssessment(id, environment, awsDiscovery, ollamaDiscovery, liteLlmDiscovery)
      const credentialRejected = id === credentialRejectedProvider
      const credentialValidating = id === credentialValidationProvider
      return {
        id,
        label: PROVIDER_LABELS[id],
        description: credentialRejected
          ? 'Setup required'
          : credentialValidating
            ? 'Validating'
            : assessment.description,
        active: enabled,
        status: credentialRejected ? 'error' : credentialValidating ? 'warning' : assessment.status,
        activate: noop,
      }
    })
    const fields =
      selectedProvider === 'litellm' && !liteLlmDiscovery?.authenticationRequired
        ? []
        : PROVIDERS[selectedProvider].fields.filter(
            (field) => field.key === 'AWS_PROFILE' || !readyProviders.includes(selectedProvider)
          )
    rows.push(
      ...fields.map((field): WizardRow => {
        const configured = providerEnvironment[field.key]
        const detected = environment[field.key]
        const selectOptions = providerSelectOptions(field, environment, awsDiscovery)
        const credential = PROVIDER_CREDENTIAL_KEYS.includes(field.key)
        const rejectedLiteLlmKey =
          selectedProvider === 'litellm' &&
          field.key === 'LITELLM_API_KEY' &&
          liteLlmDiscovery?.authenticationRequired === true
        const rejectedCredential = rejectedLiteLlmKey || (selectedProvider === credentialRejectedProvider && credential)
        const validatingCredential = selectedProvider === credentialValidationProvider && credential
        const editable = !credential || !detected || rejectedCredential
        return {
          id: `${selectedProvider}:${field.key}`,
          label: field.label,
          description: credential
            ? detected
              ? rejectedCredential && credentialRejectionMessage
                ? credentialRejectionMessage
                : validatingCredential
                  ? 'Checking API key...'
                  : `${rejectedCredential ? 'Rejected' : 'Detected'} · ${sourceLabel(detected.source)}`
              : credentialSetupDescription()
            : field.key === 'AWS_PROFILE' && environment.AWS_BEARER_TOKEN_BEDROCK
              ? `${field.placeholder}  ▾`
              : configured
                ? `${configured}${selectOptions ? '  ▾' : ''}`
                : detected
                  ? `${detected.value} · ${sourceLabel(detected.source)}${selectOptions ? '  ▾' : ''}`
                  : `${field.placeholder}${selectOptions ? '  ▾' : ''}`,
          input: editable,
          field: field.key,
          ...(selectOptions ? { selectOptions } : {}),
          activate: editable
            ? edit(field.key, configured ?? (rejectedCredential ? '' : (detected?.value ?? '')))
            : noop,
        }
      })
    )
    if (readyProviders.includes(selectedProvider)) {
      const thinking = effortForModel(draft.profile.model, draft.profile.effort)
      const efforts = effortOptions(draft.profile.model, thinking)
      if (efforts.length > 0) {
        rows.push({
          id: 'thinking',
          label: 'Reasoning',
          description: effortDisplayLabel(thinking),
          choices: efforts.map((option) => ({
            label: option.label,
            active: option.active === true,
            activate: (): void => updateProfile({ effort: profileEffort(option.id) }),
          })),
          activate: noop,
        })
      }
      if (flow === 'quickstart') {
        const nativeSearch = supportsWebSearch(draft.profile.model)
        const exaSearch = exaWebSearchActive(draft.profile) || !nativeSearch
        const enabled = profileToolEnabled(draft.profile.builtinTools, 'web_search')
        rows.push({
          id: 'quickstart-web-search',
          label: 'Web search',
          // The Exa-on note is a warning rendered by the wizard.
          description: enabled
            ? exaSearch
              ? 'Third-party search via Exa'
              : "Provider's built-in search"
            : nativeSearch
              ? 'Built-in search available'
              : 'No built-in search',
          choices: [
            {
              label: 'Off',
              active: !enabled,
              activate: (): void =>
                updateProfile({ builtinTools: withoutProfileTool(draft.profile.builtinTools, 'web_search') }),
            },
            {
              label: exaSearch ? 'Exa' : 'Native',
              active: enabled,
              activate: (): void => {
                const withoutSearch = withoutProfileTool(draft.profile.builtinTools, 'web_search')
                updateProfile({
                  builtinTools: exaSearch
                    ? withWebSearchFallback(withoutSearch)
                    : withProfileTool(withoutSearch, 'web_search'),
                })
              },
            },
          ],
          activate: noop,
        })
      }
    }
    return rows
  }
  switch (step) {
    case 2:
      return [
        {
          id: 'name',
          label: 'Name',
          description: draft.profile.name,
          field: 'name',
          activate: edit('name', draft.profile.name === DEFAULT_HARNESS_AGENT_CONFIG.name ? '' : draft.profile.name),
        },
        {
          id: 'instructions',
          label: 'Instructions',
          description: draft.profile.instructions,
          field: 'instructions',
          activate: edit('instructions', draft.profile.instructions),
        },
      ]
    case 5: {
      const skillsEnabled = profileSkillsEnabled(draft.profile)
      return [
        {
          id: 'context',
          label: 'Context strategy',
          description: contextManagerLabel(draft.profile.contextManager),
          choices: (['auto', 'agentic', false] as const).map((value) => ({
            label: value === 'auto' ? 'Automatic' : value === 'agentic' ? 'Agentic' : 'Off',
            active: draft.profile.contextManager === value,
            activate: () =>
              value === false
                ? setDraft((current) => setFeatureEnabled(current, 'contextManager', false))
                : updateProfile({ contextManager: value }),
          })),
          activate: noop,
        },
        {
          id: 'caching',
          label: 'Prompt caching',
          description: draft.profile.caching ? 'on' : 'off',
          active: draft.profile.caching,
          activate: () => updateProfile({ caching: !draft.profile.caching }),
        },
        {
          id: 'memory',
          label: 'Long-term memory',
          description: profileMemoryEnabled(draft.profile) ? profileMemoryDir(draft.profile) : 'off',
          active: profileMemoryEnabled(draft.profile),
          activate: () =>
            setDraft((current) => setFeatureEnabled(current, 'memory', !profileMemoryEnabled(current.profile))),
        },
        {
          id: 'memory-dir',
          label: 'Memory directory',
          description: profileMemoryDir(draft.profile),
          disabled: !profileMemoryEnabled(draft.profile),
          field: 'memoryDir',
          activate: edit('memoryDir', profileMemoryDir(draft.profile)),
        },
        {
          id: 'skills',
          label: 'Agent Skills',
          description: skillsEnabled ? 'On · load reusable SKILL.md instructions on demand' : 'Off · no skills loaded',
          active: skillsEnabled,
          activate: () =>
            setDraft((current) => setFeatureEnabled(current, 'skills', !profileSkillsEnabled(current.profile))),
        },
        ...(skillsEnabled
          ? [
              {
                id: 'skills-dir',
                label: 'Skill sources',
                description: profileSkillPaths(draft.profile).join(', '),
                field: 'skills' as const,
                activate: edit('skills', profileSkillPaths(draft.profile).join(', ')),
              },
            ]
          : []),
      ]
    }
    case 6: {
      const allowedTools = new Set(draft.allowedTools)
      const customToolNames = permissionToolNames(enabledProfileTools(draft.profile.builtinTools), draft.allowedTools)
      return [
        {
          id: 'permission-default',
          label: PERMISSION_CHOICES.default.label,
          description: PERMISSION_CHOICES.default.description,
          active: draft.permissionMode === 'default' && !draft.customPermissions,
          activate: () =>
            setDraft((current) => ({
              ...current,
              permissionMode: 'default',
              customPermissions: false,
            })),
        },
        {
          id: 'permission-bypass',
          label: PERMISSION_CHOICES.bypassPermissions.label,
          description: PERMISSION_CHOICES.bypassPermissions.description,
          active: draft.permissionMode === 'bypassPermissions',
          activate: () =>
            setDraft((current) => ({
              ...current,
              permissionMode: 'bypassPermissions',
              customPermissions: false,
            })),
        },
        {
          id: 'permission-custom',
          label: PERMISSION_CHOICES.custom.label,
          description: PERMISSION_CHOICES.custom.description,
          active: draft.customPermissions,
          activate: () =>
            setDraft((current) => ({
              ...current,
              permissionMode: 'default',
              customPermissions: true,
            })),
        },
        ...(draft.customPermissions
          ? customToolNames.map((toolName): WizardRow => ({
              id: `permission-tool:${toolName}`,
              label: toolName,
              description: permissionToolDescription(allowedTools.has(toolName)),
              section: 'Per-tool behavior',
              active: allowedTools.has(toolName),
              activate: () =>
                setDraft((current) => ({
                  ...current,
                  allowedTools: current.allowedTools.includes(toolName)
                    ? current.allowedTools.filter((candidate) => candidate !== toolName)
                    : permissionToolNames(current.allowedTools, [toolName]),
                })),
            }))
          : []),
      ]
    }
    default: {
      const context =
        draft.profile.contextManager === false
          ? 'Context off'
          : draft.profile.contextManager === 'auto'
            ? 'Automatic context'
            : 'Agentic context'
      return [
        {
          id: 'provider',
          label: 'Providers',
          description: draft.providers.map((id) => PROVIDER_LABELS[id]).join(', '),
          activate: noop,
        },
        { id: 'agent', label: 'Agent', description: draft.profile.name, activate: noop },
        { id: 'model', label: 'Model', description: draft.profile.model, activate: noop },
        {
          id: 'tools',
          label: 'Tools',
          description: `${enabledProfileTools(compatibleProfile(draft.profile).builtinTools).length} enabled`,
          activate: noop,
        },
        {
          id: 'plugins',
          label: 'Plugins & features',
          description: `${draft.profile.builtinPlugins.length} plugins · MCP ${draft.settings.mcpDiscovery ? 'on' : 'off'}`,
          activate: noop,
        },
        {
          id: 'data',
          label: 'Data',
          description: `${context} · Memory ${profileMemoryEnabled(draft.profile) ? 'on' : 'off'} · Skills ${profileSkillsEnabled(draft.profile) ? 'on' : 'off'}`,
          activate: noop,
        },
        {
          id: 'safety',
          label: 'Approvals',
          description: draft.customPermissions
            ? `Custom · ${draft.allowedTools.length} ${draft.allowedTools.length === 1 ? 'tool' : 'tools'} allowed without asking`
            : draft.permissionMode === 'default'
              ? 'Ask before sensitive actions'
              : PERMISSION_CHOICES.bypassPermissions.label,
          activate: noop,
        },
      ]
    }
  }
}

function toolSelectionRows(
  draft: SetupDraft,
  setDraft: (update: (current: SetupDraft) => SetupDraft) => void
): WizardRow[] {
  const choices = builtinToolChoices(draft.profile)
  const nativeSearch = supportsWebSearch(draft.profile.model)
  const allSelected = choices.every((choice) => (choice.id === 'web_search' && !nativeSearch) || choice.active)
  return [
    {
      id: 'select-all',
      label: allSelected ? 'Deselect all' : 'Select all',
      description: '',
      activate: (): void => {
        const enabled = !allSelected
        setDraft((current) => {
          const next = builtinToolChoices(current.profile).reduce(
            (next, choice) =>
              enabled && choice.thirdParty && current.disabledTools?.web_search !== 'exa'
                ? next
                : setToolEnabled(next, choice.id, enabled),
            current
          )
          return { ...next, profile: compatibleProfile(next.profile) }
        })
      },
    },
    ...choices.map((choice): WizardRow => ({
      id: choice.id,
      description: choice.description,
      label: choice.id,
      active: choice.active,
      section: 'Tools',
      activate: () => setDraft((current) => setToolEnabled(current, choice.id, !choice.active)),
    })),
  ]
}

function pluginSelectionRows(
  draft: SetupDraft,
  setDraft: (update: (current: SetupDraft) => SetupDraft) => void,
  updateProfile: (update: Partial<HarnessAgentConfig>) => void
): WizardRow[] {
  const skillsEnabled = profileSkillsEnabled(draft.profile)
  const pluginsAndFeatures: WizardRow[] = [
    {
      id: 'todos',
      label: 'Todos',
      description: 'Maintain and re-surface a task list',
      active: draft.profile.builtinPlugins.includes('todos'),
      activate: () => updateProfile({ builtinPlugins: toggle(draft.profile.builtinPlugins, 'todos') }),
    },
    {
      id: 'environment',
      label: 'Environment context',
      description: 'Inject date, cwd, and project guidance',
      active: draft.profile.builtinPlugins.includes('environment'),
      activate: () => updateProfile({ builtinPlugins: toggle(draft.profile.builtinPlugins, 'environment') }),
    },
    {
      id: 'skills',
      label: 'Skills',
      description: 'Discover skills across workspace and tools',
      active: skillsEnabled,
      activate: () =>
        setDraft((current) => setFeatureEnabled(current, 'skills', !profileSkillsEnabled(current.profile))),
    },
    {
      id: 'mcp',
      label: 'MCP servers',
      description: 'Auto-discover MCP servers on this machine',
      active: draft.settings.mcpDiscovery,
      activate: (): void =>
        setDraft((current) => ({
          ...current,
          settings: { ...current.settings, mcpDiscovery: !current.settings.mcpDiscovery },
        })),
    },
    {
      id: 'agent-messaging',
      label: 'Agent messaging',
      description: 'Discover and message other live agents',
      active: draft.settings.agentMessaging,
      activate: (): void =>
        setDraft((current) => ({
          ...current,
          settings: { ...current.settings, agentMessaging: !current.settings.agentMessaging },
        })),
    },
    {
      id: 'memory',
      label: 'Memory',
      description: 'Remember information between conversations',
      active: profileMemoryEnabled(draft.profile),
      activate: () =>
        setDraft((current) => setFeatureEnabled(current, 'memory', !profileMemoryEnabled(current.profile))),
    },
    {
      id: 'context',
      label: 'Context management',
      description: 'Manage long conversations and large outputs',
      active: draft.profile.contextManager !== false,
      activate: () =>
        setDraft((current) => setFeatureEnabled(current, 'contextManager', current.profile.contextManager === false)),
    },
    {
      id: 'background-tasks',
      label: 'Background tasks',
      description: 'Run long-running tools in the background',
      active: draft.profile.agentConfig.backgroundTasks !== false,
      activate: () =>
        setDraft((current) =>
          setBackgroundTasksEnabled(current, current.profile.agentConfig.backgroundTasks === false)
        ),
    },
  ]
  const allSelected = pluginsAndFeatures.every((row) => row.disabled || row.active)
  return [
    {
      id: 'select-all',
      label: allSelected ? 'Deselect all' : 'Select all',
      description: '',
      activate: (): void => {
        const enabled = !allSelected
        setDraft((current) => {
          let next = setBackgroundTasksEnabled(current, enabled)
          for (const key of ['skills', 'memory', 'contextManager'] as const) {
            next = setFeatureEnabled(next, key, enabled)
          }
          return {
            ...next,
            settings: { ...next.settings, mcpDiscovery: enabled, agentMessaging: enabled },
            profile: {
              ...next.profile,
              builtinPlugins: enabled ? DEFAULT_HARNESS_AGENT_CONFIG.builtinPlugins : [],
            },
          }
        })
      },
    },
    ...pluginsAndFeatures.map((row): WizardRow => ({
      ...row,
      section: row.id === 'todos' || row.id === 'environment' ? 'Plugins' : 'Features',
    })),
  ]
}

function toggle<const T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value]
}

function setFeatureEnabled(
  current: SetupDraft,
  key: 'skills' | 'memory' | 'contextManager',
  enabled: boolean
): SetupDraft {
  const active = key === 'skills' ? profileSkillsEnabled(current.profile) : current.profile[key] !== false
  if (active === enabled) return current
  return {
    ...current,
    ...(!enabled ? { disabledFeatures: { ...current.disabledFeatures, [key]: current.profile[key] } } : {}),
    profile: {
      ...current.profile,
      [key]: enabled ? (current.disabledFeatures?.[key] ?? DEFAULT_HARNESS_AGENT_CONFIG[key]) : false,
    },
  }
}

function setBackgroundTasksEnabled(current: SetupDraft, enabled: boolean): SetupDraft {
  const value = current.profile.agentConfig.backgroundTasks
  if ((value !== false) === enabled) return current
  return {
    ...current,
    ...(!enabled ? { disabledBackgroundTasks: value } : {}),
    profile: {
      ...current.profile,
      agentConfig: {
        ...current.profile.agentConfig,
        backgroundTasks: enabled ? (current.disabledBackgroundTasks ?? true) : false,
      },
    },
  }
}

function setToolEnabled(current: SetupDraft, name: BuiltinToolName, enabled: boolean): SetupDraft {
  const choice = builtinToolChoices(current.profile).find((choice) => choice.id === name)!
  if (choice.active === enabled) return current
  const mapping = Array.isArray(current.profile.builtinTools)
    ? undefined
    : (current.profile.builtinTools as HarnessConfigBuiltinTools)
  const saved = current.disabledTools?.[choice.id]
  return {
    ...current,
    ...(!enabled ? { disabledTools: { ...current.disabledTools, [choice.id]: mapping?.[choice.id] } } : {}),
    profile: {
      ...current.profile,
      builtinTools:
        enabled && mapping && saved !== undefined
          ? { ...mapping, [choice.id]: saved }
          : withBuiltinToolChoice(current.profile, choice, enabled),
    },
  }
}

export type EditableField = 'name' | 'instructions' | 'skills' | 'memoryDir' | 'importPath' | ProviderEnvironmentKey
export type SetupFlow = 'quickstart' | 'customize' | 'import'

export type AppearanceSettings = Pick<
  ChatSettings,
  'frogTheme' | 'transcriptSpacing' | 'animations' | 'showReasoning' | 'toolOutput'
>

export interface SetupDraft {
  providers: ProviderId[]
  profile: HarnessAgentConfig
  permissionMode: PermissionMode
  allowedTools: string[]
  customPermissions: boolean
  disabledFeatures?: Partial<Pick<HarnessAgentConfig, 'skills' | 'memory' | 'contextManager'>>
  disabledTools?: HarnessConfigBuiltinTools
  disabledBackgroundTasks?: unknown
  settings: Pick<ChatSettings, 'mcpDiscovery' | 'skillDiscovery' | 'agentMessaging'>
}

export interface WizardRow {
  id: string
  label: string
  description: string
  section?: string
  active?: boolean
  disabled?: boolean
  input?: boolean
  field?: EditableField
  selectOptions?: readonly SelectOption[]
  status?: 'success' | 'warning' | 'error'
  descriptionColor?: string
  choices?: readonly { label: string; value?: string | number | boolean; active: boolean; activate(): void }[]
  activate(): void
}

export interface SelectOption {
  label: string
  value?: string
  custom?: boolean
}
