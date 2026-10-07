export const FROG_THEMES = ['green', 'minimal', 'homeland', 'merlin', 'kikker', 'circuit', 'spectre', 'solar'] as const

export type FrogTheme = (typeof FROG_THEMES)[number]

export const FROG_THEME_LABELS: Record<FrogTheme, string> = {
  green: 'Classic',
  minimal: 'Minimal',
  circuit: 'Cyborg',
  homeland: 'Homeland',
  merlin: 'Merlin',
  kikker: 'Kikker',
  spectre: 'Spectre',
  solar: 'Solar',
}

export type ResolvedColorMode = 'light' | 'dark'

export const CONTEXT_OFFLOAD_THRESHOLD_OPTIONS = [
  { label: 'Default', value: 'default' },
  { label: '1.5K', value: 1_500 },
  { label: '2.5K', value: 2_500 },
  { label: '5K', value: 5_000 },
  { label: '10K', value: 10_000 },
] as const

export type ContextOffloadThreshold = (typeof CONTEXT_OFFLOAD_THRESHOLD_OPTIONS)[number]['value']

export const SETTINGS_CATEGORIES = [
  {
    id: 'Appearance',
    label: 'Appearance',
  },
  {
    id: 'Auto-Discovery',
    label: 'Auto-Discovery',
  },
  {
    id: 'General',
    label: 'General',
  },
] as const

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]['id']

export const DEFAULT_SETTINGS_CATEGORY = 'Appearance' satisfies SettingsCategory

export type ThemeColors = Record<(typeof THEME_COLOR_KEYS)[number], string>

export const THEME_COLOR_KEYS = [
  'background',
  'foreground',
  'muted',
  'surface',
  'panel',
  'selection',
  'border',
  'accent',
  'hover',
  'success',
  'warning',
  'error',
  'frog',
] as const

export interface ChatSettings {
  transcriptSpacing: 'compact' | 'comfortable'
  animations: boolean
  showReasoning: boolean
  toolOutput: 'hidden' | 'compact' | 'full'
  frogTheme: FrogTheme
  /** Load MCP servers configured for other tools (Claude Code, Kiro, Gemini CLI, Codex). */
  mcpDiscovery: boolean
  /** Load Agent Skills from other tools' and the workspace's conventional directories. */
  skillDiscovery: boolean
  /** Allow agents to discover and message other live conversations. */
  agentMessaging: boolean
  /** Send one anonymous usage ping per interactive start (see README → Telemetry). */
  telemetry: boolean
  /** Tool-result token cutoff for context offloading, or the selected context-manager preset's default. */
  contextOffloadThreshold: ContextOffloadThreshold
}

export type ThemeSettings = Pick<ChatSettings, 'frogTheme'>

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  transcriptSpacing: 'comfortable',
  animations: true,
  showReasoning: true,
  toolOutput: 'compact',
  frogTheme: 'green',
  mcpDiscovery: false,
  skillDiscovery: false,
  agentMessaging: true,
  telemetry: true,
  contextOffloadThreshold: 'default',
}

export type SettingKey =
  | 'frogTheme'
  | 'transcriptSpacing'
  | 'animations'
  | 'showReasoning'
  | 'toolOutput'
  | 'mcpDiscovery'
  | 'skillDiscovery'
  | 'agentMessaging'
  | 'telemetry'
  | 'contextOffloadThreshold'

export interface SettingDefinition {
  key: SettingKey
  label: string
  section: SettingsCategory
  control: 'segmented' | 'toggle'
  options: readonly { label: string; value: string | number | boolean }[]
}

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: 'frogTheme',
    label: 'Theme',
    section: 'Appearance',
    control: 'segmented',
    options: FROG_THEMES.map((value) => ({ label: FROG_THEME_LABELS[value], value })),
  },
  {
    key: 'transcriptSpacing',
    label: 'Transcript spacing',
    section: 'Appearance',
    control: 'segmented',
    options: [
      { label: 'Compact', value: 'compact' },
      { label: 'Comfortable', value: 'comfortable' },
    ],
  },
  {
    key: 'animations',
    label: 'Animations',
    section: 'Appearance',
    control: 'toggle',
    options: [
      { label: 'On', value: true },
      { label: 'Off', value: false },
    ],
  },
  {
    key: 'showReasoning',
    label: 'Reasoning',
    section: 'Appearance',
    control: 'toggle',
    options: [
      { label: 'Show', value: true },
      { label: 'Hide', value: false },
    ],
  },
  {
    key: 'toolOutput',
    label: 'Tool output',
    section: 'Appearance',
    control: 'segmented',
    options: [
      { label: 'Hidden', value: 'hidden' },
      { label: 'Compact', value: 'compact' },
      { label: 'Full', value: 'full' },
    ],
  },
  {
    key: 'mcpDiscovery',
    label: 'MCP',
    section: 'Auto-Discovery',
    control: 'toggle',
    options: [
      { label: 'On', value: true },
      { label: 'Off', value: false },
    ],
  },
  {
    key: 'skillDiscovery',
    label: 'Skills',
    section: 'Auto-Discovery',
    control: 'toggle',
    options: [
      { label: 'On', value: true },
      { label: 'Off', value: false },
    ],
  },
  {
    key: 'agentMessaging',
    label: 'Agents (peer-to-peer messaging)',
    section: 'Auto-Discovery',
    control: 'toggle',
    options: [
      { label: 'On', value: true },
      { label: 'Off', value: false },
    ],
  },
  {
    key: 'contextOffloadThreshold',
    label: 'Context offload threshold',
    section: 'General',
    control: 'segmented',
    options: CONTEXT_OFFLOAD_THRESHOLD_OPTIONS,
  },
  {
    key: 'telemetry',
    label: 'Usage ping (telemetry)',
    section: 'General',
    control: 'toggle',
    options: [
      { label: 'On', value: true },
      { label: 'Off', value: false },
    ],
  },
]

export const VISUAL_SETTING_DEFINITIONS = SETTING_DEFINITIONS.filter(({ section }) => section === 'Appearance')

export function settingDescription(settings: ChatSettings, key: SettingKey): string {
  switch (key) {
    case 'frogTheme':
      return FROG_THEME_LABELS[settings.frogTheme]
    case 'animations':
      return settings.animations ? 'on' : 'off'
    case 'showReasoning':
      return settings.showReasoning ? 'shown' : 'hidden'
    case 'mcpDiscovery':
      return settings.mcpDiscovery
        ? 'on · adds conventional Claude, Kiro, Gemini, Codex, and Strands sources · applies at next launch'
        : 'off · only explicit --mcp-config sources load · applies at next launch'
    case 'skillDiscovery':
      return settings.skillDiscovery
        ? 'on · adds conventional user and workspace sources · applies at next launch'
        : 'off · only configured skills directories load · applies at next launch'
    case 'agentMessaging':
      return settings.agentMessaging
        ? 'on · lets live conversations discover and message each other · applies at next launch'
        : 'off · conversations stay isolated · applies at next launch'
    case 'telemetry':
      return settings.telemetry
        ? 'on · one anonymous ping per launch: CLI version, provider, built-in tools and plugins · applies at next launch'
        : 'off · nothing is sent · applies at next launch'
    case 'contextOffloadThreshold':
      return `${CONTEXT_OFFLOAD_THRESHOLD_OPTIONS.find(({ value }) => value === settings.contextOffloadThreshold)!.label} · tool-result tokens · applies at next launch`
    default:
      return settings[key]
  }
}

export function parseSettings(value: unknown, path: string): ChatSettings {
  if (value === undefined) {
    return globalThis.structuredClone(DEFAULT_CHAT_SETTINGS)
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid CLI config at ${path}: settings must be an object`)
  }
  const booleanSetting = (key: keyof ChatSettings): boolean => {
    const selected = value[key] ?? DEFAULT_CHAT_SETTINGS[key]
    if (typeof selected !== 'boolean') {
      throw new Error(`Invalid CLI config at ${path}: settings.${key} must be a boolean`)
    }
    return selected
  }

  const transcriptSpacing = value.transcriptSpacing ?? DEFAULT_CHAT_SETTINGS.transcriptSpacing
  if (transcriptSpacing !== 'compact' && transcriptSpacing !== 'comfortable') {
    throw new Error(`Invalid CLI config at ${path}: settings.transcriptSpacing must be "compact" or "comfortable"`)
  }
  const animations = booleanSetting('animations')
  const showReasoning = booleanSetting('showReasoning')
  const toolOutput = value.toolOutput ?? DEFAULT_CHAT_SETTINGS.toolOutput
  if (toolOutput !== 'hidden' && toolOutput !== 'compact' && toolOutput !== 'full') {
    throw new Error(`Invalid CLI config at ${path}: settings.toolOutput must be "hidden", "compact", or "full"`)
  }
  const selectedFrogTheme = legacyFrogTheme(value) ?? value.frogTheme
  const frogTheme = FROG_THEMES.find((theme) => theme === selectedFrogTheme)
  if (frogTheme === undefined) {
    throw new Error(`Invalid CLI config at ${path}: settings.frogTheme must be one of ${FROG_THEMES.join(', ')}`)
  }
  const contextOffloadThreshold = value.contextOffloadThreshold ?? DEFAULT_CHAT_SETTINGS.contextOffloadThreshold
  if (!CONTEXT_OFFLOAD_THRESHOLD_OPTIONS.some(({ value: option }) => option === contextOffloadThreshold)) {
    throw new Error(
      `Invalid CLI config at ${path}: settings.contextOffloadThreshold must be "default", 1500, 2500, 5000, or 10000`
    )
  }

  return {
    transcriptSpacing,
    animations,
    showReasoning,
    toolOutput,
    frogTheme,
    mcpDiscovery: booleanSetting('mcpDiscovery'),
    skillDiscovery: booleanSetting('skillDiscovery'),
    agentMessaging: booleanSetting('agentMessaging'),
    telemetry: booleanSetting('telemetry'),
    contextOffloadThreshold: contextOffloadThreshold as ContextOffloadThreshold,
  }
}

/** The preset that replaces a removed theme saved by an earlier version, if `settings` names one. */
function legacyFrogTheme(settings: Record<string, unknown>): FrogTheme | undefined {
  if (settings.frogTheme === undefined || ['aurora', 'moonlight', 'magma'].includes(settings.frogTheme as string)) {
    return DEFAULT_CHAT_SETTINGS.frogTheme
  }
  if (settings.frogTheme !== 'custom') {
    return undefined
  }
  // Custom themes layered colors over a preset; keep that preset.
  const base = isRecord(settings.customTheme) ? settings.customTheme.base : undefined
  return FROG_THEMES.find((theme) => theme === base) ?? DEFAULT_CHAT_SETTINGS.frogTheme
}

export function parseSettingUpdate(setting: string, current: ChatSettings): Partial<ChatSettings> | undefined {
  const [name, selected, extra] = setting.split('=')
  if (extra !== undefined) {
    return undefined
  }
  switch (name) {
    case 'transcriptSpacing':
      if (selected !== undefined && selected !== 'compact' && selected !== 'comfortable') {
        return undefined
      }
      return {
        transcriptSpacing: selected ?? (current.transcriptSpacing === 'comfortable' ? 'compact' : 'comfortable'),
      }
    case 'animations':
    case 'showReasoning':
    case 'mcpDiscovery':
    case 'skillDiscovery':
    case 'agentMessaging':
    case 'telemetry':
      return { [name]: !current[name] }
    case 'toolOutput':
      if (selected !== undefined && selected !== 'hidden' && selected !== 'compact' && selected !== 'full') {
        return undefined
      }
      return {
        toolOutput:
          selected ??
          (current.toolOutput === 'hidden' ? 'compact' : current.toolOutput === 'compact' ? 'full' : 'hidden'),
      }
    case 'frogTheme': {
      const frogTheme = FROG_THEMES.find((theme) => theme === selected)
      return frogTheme === undefined ? undefined : { frogTheme }
    }
    case 'contextOffloadThreshold': {
      const threshold =
        selected === 'default'
          ? 'default'
          : CONTEXT_OFFLOAD_THRESHOLD_OPTIONS.find(({ value }) => String(value) === selected)?.value
      return threshold === undefined ? undefined : { contextOffloadThreshold: threshold }
    }
    default:
      return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
