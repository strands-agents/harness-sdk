export const FROG_THEMES = [
  'green',
  'minimal',
  'homeland',
  'merlin',
  'kikker',
  'circuit',
  'spectre',
  'solar',
  'custom',
] as const

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
  custom: 'Custom',
}

export type ColorMode = 'auto' | 'light' | 'dark'
export type ResolvedColorMode = Exclude<ColorMode, 'auto'>

export const SETTINGS_CATEGORIES = [
  {
    id: 'Appearance',
    label: 'Appearance',
    description: 'Theme, transcript, reasoning, tool output, and animations',
  },
  {
    id: 'Auto-Discovery',
    label: 'Auto-Discovery',
    description: 'MCP servers, agent skills, and peer-to-peer messaging',
  },
  {
    id: 'General',
    label: 'General',
    description: 'Launch behavior and telemetry',
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

export interface CustomTheme {
  base: Exclude<FrogTheme, 'custom'>
  light: Partial<ThemeColors>
  dark: Partial<ThemeColors>
}

export interface ChatSettings {
  transcriptSpacing: 'compact' | 'comfortable'
  animations: boolean
  showReasoning: boolean
  toolOutput: 'hidden' | 'compact' | 'full'
  frogTheme: FrogTheme
  colorMode: ColorMode
  customTheme: CustomTheme
  /** Load MCP servers configured for other tools (Claude Code, Kiro, Gemini CLI, Codex). */
  mcpDiscovery: boolean
  /** Load Agent Skills from other tools' and the workspace's conventional directories. */
  skillDiscovery: boolean
  /** Allow agents to discover and message other live conversations. */
  agentMessaging: boolean
  /** Open the setup screen when starting an interactive session. */
  setupOnLaunch: boolean
  /** Send one anonymous usage ping per interactive start (see README → Telemetry). */
  telemetry: boolean
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  transcriptSpacing: 'comfortable',
  animations: true,
  showReasoning: true,
  toolOutput: 'compact',
  frogTheme: 'green',
  colorMode: 'auto',
  customTheme: { base: 'green', light: {}, dark: {} },
  mcpDiscovery: false,
  skillDiscovery: false,
  agentMessaging: true,
  setupOnLaunch: true,
  telemetry: true,
}

export type SettingKey =
  | 'colorMode'
  | 'frogTheme'
  | 'transcriptSpacing'
  | 'animations'
  | 'showReasoning'
  | 'toolOutput'
  | 'mcpDiscovery'
  | 'skillDiscovery'
  | 'agentMessaging'
  | 'setupOnLaunch'
  | 'telemetry'

export interface SettingDefinition {
  key: SettingKey
  label: string
  section: SettingsCategory
  control: 'segmented' | 'toggle'
  options: readonly { label: string; value: string | boolean }[]
}

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: 'colorMode',
    label: 'Color mode',
    section: 'Appearance',
    control: 'segmented',
    options: [
      { label: 'Auto', value: 'auto' },
      { label: 'Light', value: 'light' },
      { label: 'Dark', value: 'dark' },
    ],
  },
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
    key: 'setupOnLaunch',
    label: 'Launch into Setup by default',
    section: 'General',
    control: 'toggle',
    options: [
      { label: 'On', value: true },
      { label: 'Off', value: false },
    ],
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
    case 'setupOnLaunch':
      return settings.setupOnLaunch ? 'on · applies at next launch' : 'off · applies at next launch'
    case 'telemetry':
      return settings.telemetry
        ? 'on · one anonymous ping per launch: CLI version, provider, built-in tools and plugins · applies at next launch'
        : 'off · nothing is sent · applies at next launch'
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
  const selectedFrogTheme =
    value.frogTheme === 'aurora' || value.frogTheme === 'moonlight' || value.frogTheme === 'magma'
      ? DEFAULT_CHAT_SETTINGS.frogTheme
      : (value.frogTheme ?? DEFAULT_CHAT_SETTINGS.frogTheme)
  const frogTheme = FROG_THEMES.find((theme) => theme === selectedFrogTheme)
  if (frogTheme === undefined) {
    throw new Error(`Invalid CLI config at ${path}: settings.frogTheme must be one of ${FROG_THEMES.join(', ')}`)
  }
  const colorMode = value.colorMode ?? DEFAULT_CHAT_SETTINGS.colorMode
  if (colorMode !== 'auto' && colorMode !== 'light' && colorMode !== 'dark') {
    throw new Error(`Invalid CLI config at ${path}: settings.colorMode must be "auto", "light", or "dark"`)
  }
  const customTheme = parseCustomTheme(value.customTheme, path)

  return {
    transcriptSpacing,
    animations,
    showReasoning,
    toolOutput,
    frogTheme,
    colorMode,
    customTheme,
    mcpDiscovery: booleanSetting('mcpDiscovery'),
    skillDiscovery: booleanSetting('skillDiscovery'),
    agentMessaging: booleanSetting('agentMessaging'),
    setupOnLaunch: booleanSetting('setupOnLaunch'),
    telemetry: booleanSetting('telemetry'),
  }
}

function parseCustomTheme(value: unknown, path: string): CustomTheme {
  if (value === undefined) {
    return globalThis.structuredClone(DEFAULT_CHAT_SETTINGS.customTheme)
  }
  if (
    !isRecord(value) ||
    typeof value.base !== 'string' ||
    value.base === 'custom' ||
    !FROG_THEMES.includes(value.base as FrogTheme)
  ) {
    throw new Error(`Invalid CLI config at ${path}: customTheme.base must name a preset theme`)
  }
  const colors = (mode: 'light' | 'dark'): Partial<ThemeColors> => {
    const candidate = value[mode] ?? {}
    if (!isRecord(candidate)) {
      throw new Error(`Invalid CLI config at ${path}: customTheme.${mode} must be an object`)
    }
    const result: Partial<ThemeColors> = {}
    for (const key of THEME_COLOR_KEYS) {
      const color = candidate[key]
      if (color === undefined) continue
      if (typeof color !== 'string' || !/^#[\da-f]{6}$/iu.test(color)) {
        throw new Error(`Invalid CLI config at ${path}: customTheme.${mode}.${key} must be a #RRGGBB color`)
      }
      result[key] = color.toLowerCase()
    }
    return result
  }
  return { base: value.base as CustomTheme['base'], light: colors('light'), dark: colors('dark') }
}

export function parseSettingUpdate(setting: string, current: ChatSettings): Partial<ChatSettings> | undefined {
  const [name, selected, extra] = setting.split('=')
  if (extra !== undefined) {
    return undefined
  }
  switch (name) {
    case 'colorMode':
      if (selected !== 'auto' && selected !== 'light' && selected !== 'dark') {
        return undefined
      }
      return { colorMode: selected }
    case 'customTheme': {
      let theme: unknown
      try {
        theme = JSON.parse(decodeURIComponent(selected ?? ''))
      } catch {
        return undefined
      }
      if (
        !isRecord(theme) ||
        Object.keys(theme).some((key) => !['base', 'light', 'dark'].includes(key)) ||
        theme.base === 'custom' ||
        !FROG_THEMES.includes(theme.base as FrogTheme)
      ) {
        return undefined
      }
      for (const mode of ['light', 'dark'] as const) {
        const colors = theme[mode]
        if (
          !isRecord(colors) ||
          Object.entries(colors).some(
            ([key, color]) =>
              !THEME_COLOR_KEYS.includes(key as (typeof THEME_COLOR_KEYS)[number]) ||
              typeof color !== 'string' ||
              !/^#[\da-f]{6}$/iu.test(color)
          )
        ) {
          return undefined
        }
      }
      return { frogTheme: 'custom', customTheme: theme as unknown as CustomTheme }
    }
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
    case 'setupOnLaunch':
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
    default:
      return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
