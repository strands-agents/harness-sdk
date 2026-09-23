import {
  PROVIDER_CREDENTIAL_KEYS,
  PROVIDER_LABELS,
  PROVIDER_IDS,
  type DetectedProviderEnvironment,
  type ProviderEnvironment,
  type ProviderId,
} from '../../config.js'
import { DEFAULT_HARNESS_AGENT_CONFIG, type HarnessAgentConfig } from '@strands-agents/harness'
import type { AwsConfigurationDiscovery, LiteLlmDiscovery, OllamaDiscovery } from '../../provider/discovery.js'
import { effortOptions, profileEffort, effortDisplayLabel, effortForModel } from '../../model/selection.js'
import {
  enabledProfileTools,
  profileToolEnabled,
  webSearchFallback,
  withProfileTool,
  withoutProfileTool,
  withWebSearchFallback,
} from '../../builtin-tools.js'
import {
  contextManagerLabel,
  profileMemoryDir,
  profileMemoryEnabled,
  profileSkillPaths,
  profileSkillsEnabled,
} from './profile-fields.js'
import { canChooseDirectory } from '../../terminal/directory-picker.js'
import type { ChatSettings } from '../../chat/types.js'
import { SETTING_DEFINITIONS, VISUAL_SETTING_DEFINITIONS } from '../../settings.js'
import { PERMISSION_CHOICES, permissionToolDescription, permissionToolNames } from '../../permissions/settings.js'
import {
  PROVIDERS,
  compatibleProfile,
  credentialSetupDescription,
  effectiveProviderEnvironment,
  providerAssessment,
  providerSelectOptions,
  providerSupportsWebSearch,
  sourceLabel,
} from './providers.js'
import type { AppearanceSettings, EditableField, SetupDraft, SetupFlow, WizardRow } from './types.js'

export const MANUAL_STEPS = ['Model', 'Agent', 'Tools', 'Plugins & features', 'Data', 'Safety', 'Review'] as const
export const APPEARANCE_STEP = MANUAL_STEPS.length + 1
export const OPENING_CHOICES = [
  { id: 'quickstart', title: 'Quickstart', description: 'Pick a model and start working with your harness!' },
  { id: 'agent', title: 'Q&A', description: 'Answer a few questions, get a custom harness. No code required.' },
  {
    id: 'manual',
    title: 'Manual',
    description: 'Customize your harness from scratch. Model, prompt, tools, and beyond.',
  },
  { id: 'import', title: 'Import', description: 'Load in your custom harness from a file or zip.' },
] as const
const SETUP_STEP_INSTRUCTIONS = {
  quickstart: ['Pick a model for your agent', "Choose your agent's tools", 'Choose plugins and features'],
  agent: ['Pick a model for the assistant'],
  manual: [
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
): { current: number; total: number; instruction: string } | undefined {
  if (!flow || step === 0 || step === APPEARANCE_STEP || (flow === 'import' && step === 1)) {
    return undefined
  }
  const total = SETUP_STEP_INSTRUCTIONS[flow].length
  return { current: step, total, instruction: SETUP_STEP_INSTRUCTIONS[flow][step - 1]! }
}

// Fits beside the widest capability label in an 80-column terminal.
export const CAPABILITY_DESCRIPTION_MAX_LENGTH = 44

const BUILTIN_TOOLS = [
  ['shell', 'Run shell commands'],
  ['read', 'Read workspace files'],
  ['write', 'Create files'],
  ['edit', 'Apply targeted file edits'],
  ['web_fetch', 'Fetch and summarize web pages'],
  ['web_search', 'Search the web'],
  ['programmatic_tool_caller', 'Orchestrate tools with sandboxed Python'],
  ['subagent', 'Delegate focused work to a fresh subagent'],
] as const
const noop = (): void => {}

export function appearanceSettings(settings: ChatSettings): AppearanceSettings {
  const { frogTheme, colorMode, customTheme, transcriptSpacing, animations, showReasoning, toolOutput } = settings
  return {
    frogTheme,
    colorMode,
    customTheme: globalThis.structuredClone(customTheme),
    transcriptSpacing,
    animations,
    showReasoning,
    toolOutput,
  }
}

export function wizardSettingsRows(
  settings: ChatSettings,
  update: (settings: ChatSettings) => void,
  openThemePicker: () => void,
  scope: 'visual' | 'all' = 'visual'
): WizardRow[] {
  return (scope === 'all' ? SETTING_DEFINITIONS : VISUAL_SETTING_DEFINITIONS).map(
    ({ key, label, section, options }) => ({
      id: key,
      label,
      description: '',
      section,
      choices: options.map(({ label: optionLabel, value }) => ({
        label: optionLabel,
        value,
        active: settings[key] === value,
        activate: (): void => {
          if (key === 'frogTheme' && value === 'custom') {
            openThemePicker()
          } else {
            update({ ...settings, [key]: value } as ChatSettings)
          }
        },
      })),
      activate: noop,
    })
  )
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
  if ((flow === 'quickstart' && step === 2) || (flow === 'manual' && step === 3)) {
    return toolSelectionRows(draft, setDraft, updateProfile)
  }
  if ((flow === 'quickstart' && step === 3) || (flow === 'manual' && step === 4)) {
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
      ...(canChooseDirectory()
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
    if (!readyProviders.includes(selectedProvider)) {
      const fields =
        selectedProvider === 'litellm' && !liteLlmDiscovery?.authenticationRequired
          ? []
          : PROVIDERS[selectedProvider].fields
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
          const rejectedCredential =
            rejectedLiteLlmKey || (selectedProvider === credentialRejectedProvider && credential)
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
    }
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
          activate: edit('name', draft.profile.name),
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
            activate: () => updateProfile({ contextManager: value }),
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
          activate: () => updateProfile({ memory: !profileMemoryEnabled(draft.profile) }),
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
            setDraft((current) => {
              const enabled = profileSkillsEnabled(current.profile)
              return {
                ...current,
                ...(enabled && current.profile.skills !== false ? { disabledSkills: current.profile.skills } : {}),
                profile: {
                  ...current.profile,
                  skills: enabled ? false : (current.disabledSkills ?? true),
                },
              }
            }),
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
    default:
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
          description: `${enabledProfileTools(compatibleProfile(draft.profile).builtinTools).length} tools`,
          activate: noop,
        },
        {
          id: 'plugins',
          label: 'Plugins & features',
          description: `${draft.profile.builtinPlugins.length} plugins`,
          activate: noop,
        },
        {
          id: 'data',
          label: 'Data',
          description: `${contextManagerLabel(draft.profile.contextManager)} context · memory ${profileMemoryEnabled(draft.profile) ? 'on' : 'off'} · skills ${profileSkillsEnabled(draft.profile) ? 'on' : 'off'}`,
          activate: noop,
        },
        {
          id: 'safety',
          label: 'Approvals',
          description: draft.customPermissions
            ? `custom · ${draft.allowedTools.length} always allowed`
            : draft.permissionMode === 'default'
              ? 'default HITL'
              : 'bypass',
          activate: noop,
        },
      ]
  }
}

function toolSelectionRows(
  draft: SetupDraft,
  setDraft: (update: (current: SetupDraft) => SetupDraft) => void,
  updateProfile: (update: Partial<HarnessAgentConfig>) => void
): WizardRow[] {
  const tools = toolRows(draft, updateProfile)
  const nativeSearch = providerSupportsWebSearch(draft.profile.model)
  const bulkTools = BUILTIN_TOOLS.map(([id]) => id).filter((id) => nativeSearch || id !== 'web_search')
  const allSelected = tools.every((row) => (row.id === 'web_search' && !nativeSearch) || row.disabled || row.active)
  return [
    {
      id: 'select-all',
      label: allSelected ? 'Deselect all' : 'Select all',
      description: '',
      activate: (): void => {
        const enabled = !allSelected
        setDraft((current) => ({
          ...current,
          profile: compatibleProfile({
            ...current.profile,
            builtinTools: enabled
              ? webSearchFallback(current.profile.builtinTools) === 'exa'
                ? withWebSearchFallback(bulkTools)
                : bulkTools
              : [],
          }),
        }))
      },
    },
    ...tools.map((row): WizardRow => ({ ...row, section: 'Tools' })),
  ]
}

function pluginSelectionRows(
  draft: SetupDraft,
  setDraft: (update: (current: SetupDraft) => SetupDraft) => void,
  updateProfile: (update: Partial<HarnessAgentConfig>) => void
): WizardRow[] {
  const skillsEnabled = profileSkillsEnabled(draft.profile) || draft.settings.skillDiscovery
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
      activate: (): void =>
        setDraft((current) => ({
          ...current,
          settings: { ...current.settings, skillDiscovery: !skillsEnabled },
          profile: {
            ...current.profile,
            skills: !skillsEnabled,
          },
        })),
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
      activate: () => updateProfile({ memory: !profileMemoryEnabled(draft.profile) }),
    },
    {
      id: 'context',
      label: 'Context management',
      description: 'Manage long conversations and large outputs',
      active: draft.profile.contextManager !== false,
      activate: () =>
        updateProfile({
          contextManager: draft.profile.contextManager === false ? 'auto' : false,
        }),
    },
    {
      id: 'background-tasks',
      label: 'Background tasks',
      description: 'Run long-running tools in the background',
      active: draft.profile.agentConfig.backgroundTasks !== false,
      activate: () =>
        updateProfile({
          agentConfig: {
            ...draft.profile.agentConfig,
            backgroundTasks: draft.profile.agentConfig.backgroundTasks === false,
          },
        }),
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
        setDraft((current) => ({
          ...current,
          settings: { mcpDiscovery: enabled, skillDiscovery: enabled, agentMessaging: enabled },
          profile: compatibleProfile({
            ...current.profile,
            builtinPlugins: enabled ? DEFAULT_HARNESS_AGENT_CONFIG.builtinPlugins : [],
            skills: enabled,
            memory: enabled,
            contextManager: enabled ? DEFAULT_HARNESS_AGENT_CONFIG.contextManager : false,
            agentConfig: { ...current.profile.agentConfig, backgroundTasks: enabled },
          }),
        }))
      },
    },
    ...pluginsAndFeatures.map((row): WizardRow => ({
      ...row,
      section: row.id === 'todos' || row.id === 'environment' ? 'Plugins' : 'Features',
    })),
  ]
}

function toolRows(draft: SetupDraft, updateProfile: (update: Partial<HarnessAgentConfig>) => void): WizardRow[] {
  const nativeSearch = providerSupportsWebSearch(draft.profile.model)
  return BUILTIN_TOOLS.map(([id, description]) => {
    // Without native search, web_search is the third-party Exa fallback: off unless opted into here.
    const exa = id === 'web_search' && !nativeSearch
    const active = exa
      ? webSearchFallback(draft.profile.builtinTools) === 'exa'
      : profileToolEnabled(draft.profile.builtinTools, id)
    return {
      id,
      label: id,
      description,
      active,
      activate: (): void => {
        updateProfile({
          builtinTools: active
            ? withoutProfileTool(draft.profile.builtinTools, id)
            : exa
              ? withWebSearchFallback(draft.profile.builtinTools)
              : withProfileTool(draft.profile.builtinTools, id),
        })
      },
    }
  })
}

function toggle<const T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value]
}
