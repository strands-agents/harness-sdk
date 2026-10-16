import type { BackgroundAgentActivity } from '../background/activity.js'
import { PROVIDER_IDS, PROVIDER_LABELS } from '../config.js'
import type { LoadedMcp } from '../mcp.js'
import { mcpFailure } from '../mcp/diagnostics.js'
import { modelDisplayName } from '../model/display.js'
import { sanitizeDiffPreview } from '../permissions/file-change-preview.js'
import { PERMISSION_CHOICES, permissionToolDescription, permissionToolNames } from '../permissions/settings.js'
import { sessionWorkspaceLabel, type ChatSessionRuntime } from '../session/sessions.js'
import type { SkillInfo } from '../skills.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import { isActiveTask } from './controller-helpers.js'
import {
  type ChatBackend,
  type ChatBuiltinToolChoice,
  type ChatEffortOption,
  type ChatModelOption,
  type ChatPanel,
  type ChatPanelBase,
  type ChatPanelFilter,
  type ChatPanelRow,
  type ChatPanelSlider,
  type ChatPermissionOption,
  type ChatPermissionRequest,
  type ChatPermissionStatus,
  type ChatRuntimeInfo,
  type ChatSettings,
  type ChatTask,
  type NewChatPanel,
  type SettingsCategory,
  type ChatPermissionPreset,
} from './types.js'
import { SETTINGS_CATEGORIES, SETTING_DEFINITIONS, settingDescription } from '../settings.js'

export const BACKGROUND_TASK_WAIT_TOGGLE = 'background-tasks:toggle-wait-for-completion'
export const SETTINGS_SETUP_ACTION = 'settings-action:setup'
export const SETTINGS_UPDATE_ACTION = 'settings-action:update'
export type SettingsUpdateStatus = 'checking' | 'current' | 'available' | 'development' | 'error'

export type PermissionStage = 'allow-always' | 'deny-always'

const PERMISSION_DESCRIPTIONS: Record<ChatPermissionOption['kind'], string> = {
  allow_once: 'Run only this call',
  allow_always: 'Always allow',
  reject_once: 'Block this call and tell the agent',
  reject_always: 'Always block',
}

const PERMISSION_TONES: Record<ChatPermissionOption['kind'], NonNullable<ChatPanelRow['tone']>> = {
  allow_once: 'success',
  allow_always: 'success',
  reject_once: 'danger',
  reject_always: 'danger',
}

/** The main choices, or the scopes of a forever choice followed by a row back to the main choices. */
export function permissionRequestRows(request: ChatPermissionRequest, stage?: PermissionStage): ChatPanelRow[] {
  return stage
    ? permissionScopeRows(request, stage)
    : request.options.map((option) => permissionOptionRow(request, option))
}

export function permissionValue(requestId: string, optionId: string, rule?: string): string {
  const value = `permission:${encodeURIComponent(requestId)}:${encodeURIComponent(optionId)}`
  return rule === undefined ? value : `${value}:${encodeURIComponent(rule)}`
}

/** The row Escape activates: back out of a scope list, otherwise deny this call once. */
export function permissionEscapeRow(rows: readonly ChatPanelRow[], stage?: PermissionStage): ChatPanelRow | undefined {
  return stage ? rows.find((row) => row.value?.endsWith(':back')) : rows.find((row) => row.tone === 'danger')
}

export function permissionChoosesScope(request: ChatPermissionRequest, optionId: string): boolean {
  return (optionId === 'allow-always' || optionId === 'deny-always') && (request.scopes?.length ?? 0) > 1
}

function permissionOptionRow(request: ChatPermissionRequest, option: ChatPermissionOption): ChatPanelRow {
  const forever = option.kind === 'allow_always' || option.kind === 'reject_always'
  const choosesScope = permissionChoosesScope(request, option.id)
  const description = option.description ?? PERMISSION_DESCRIPTIONS[option.kind]
  return {
    label: choosesScope ? `${option.label}…` : option.label,
    description: !forever
      ? description
      : choosesScope
        ? `${description} · choose how broadly`
        : `${description} ${request.toolName} · remember in CLI settings`,
    value: permissionValue(request.id, option.id),
    tone: PERMISSION_TONES[option.kind],
  }
}

function permissionScopeRows(request: ChatPermissionRequest, stage: PermissionStage): ChatPanelRow[] {
  const verb = stage === 'allow-always' ? 'Always allow' : 'Always block'
  return [
    ...(request.scopes ?? []).map((scope): ChatPanelRow => ({
      label: escapePermissionText(scope.label),
      description: `${verb} ${escapePermissionText(scope.rule)} · remember in CLI settings`,
      value: permissionValue(request.id, stage, scope.rule),
      tone: stage === 'deny-always' ? 'danger' : 'success',
    })),
    { label: '← Back', description: 'Return to the main choices', value: permissionValue(request.id, 'back') },
  ]
}

/** Shows control and bidirectional characters as escapes, so displayed input never hides what runs. */
export function escapePermissionText(value: string): string {
  return [...value].map((character) => (hiddenCharacter(character) ? unicodeEscape(character) : character)).join('')
}

function hiddenCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return (
    (code <= 0x1f && character !== '\n') ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

function unicodeEscape(character: string): string {
  return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`
}

export function formatPermissionPanelBody(request: ChatPermissionRequest): string {
  try {
    return escapePermissionText(JSON.stringify(request.input, null, 2))
  } catch {
    return escapePermissionText(String(request.input))
  }
}

export function modelFilters(catalogs: readonly string[], protocol: ChatBackend['protocol']): ChatPanelFilter[] {
  const labels: Readonly<Record<string, string>> = { ...PROVIDER_LABELS, current: 'Current' }
  const available = new Set(protocol === 'strands' ? [...PROVIDER_IDS, ...catalogs] : catalogs)
  return [{ id: 'all', label: 'All' }, ...[...available].map((id) => ({ id, label: labels[id] ?? id }))]
}

export function effortSlider(efforts: readonly ChatEffortOption[]): ChatPanelSlider | undefined {
  if (efforts.length === 0) {
    return undefined
  }
  return {
    label: 'Effort',
    options: efforts.map((effort) => ({
      id: effort.id,
      label: effort.label,
      ...(effort.active ? { active: true } : {}),
    })),
    ...(efforts.length <= 1 ? { disabled: true } : {}),
  }
}

export function taskDetailTitle(task: ChatTask, activity: BackgroundAgentActivity | undefined): string {
  if (activity) {
    return `agent ${activity.name} | ${activity.status}`
  }
  return `${task.source === 'background' ? 'background task' : 'task'} | ${task.status.replaceAll('_', ' ')}`
}

export function taskDetailRows(task: ChatTask, activity: BackgroundAgentActivity | undefined): ChatPanelRow[] {
  return [
    { label: 'task id', description: task.id },
    { label: 'status', description: activity?.status ?? task.status.replaceAll('_', ' ') },
    ...(task.deliveryState ? [{ label: 'delivery', description: task.deliveryState }] : []),
    ...(activity ? [{ label: 'agent', description: activity.name }] : []),
  ]
}

export function formatTaskActivity(task: ChatTask): string {
  const lines = [task.label]
  if (task.error) {
    lines.push('', `Error: ${task.error}`)
  } else if (task.result) {
    lines.push('', 'Result', task.result)
  } else if (isActiveTask(task.status)) {
    lines.push('', 'Waiting for live agent activity...')
  } else {
    lines.push('', 'No live event stream was retained for this task.')
  }
  return lines.join('\n')
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  })
    .format(date)
    .replace(',', '')
}

export function settingsCategoryFilters(): ChatPanelFilter[] {
  return SETTINGS_CATEGORIES.map(({ id, label }) => ({ id: `settings:${id}`, label }))
}

export function settingsRows(
  settings: ChatSettings,
  category?: SettingsCategory,
  includeSetupAction = false
): ChatPanelRow[] {
  const rows = SETTING_DEFINITIONS.filter(({ section }) => category === undefined || section === category).map(
    ({ key, label, section, control, options }): ChatPanelRow => ({
      label,
      description: settingDescription(settings, key),
      value: key,
      ...(category ? {} : { section }),
      ...(category ? { filter: `settings:${category}` } : {}),
      control:
        control === 'toggle'
          ? { kind: 'toggle', checked: settings[key] as boolean }
          : {
              kind: 'segmented',
              options: options.map((option) => ({
                label: option.label,
                value: String(option.value),
                ...(settings[key] === option.value ? { active: true } : {}),
              })),
            },
    })
  )
  return includeSetupAction && category === 'Agent'
    ? [
        ...rows,
        {
          label: 'Providers & default agent',
          description: 'Open setup',
          value: SETTINGS_SETUP_ACTION,
        },
      ]
    : rows
}

export function settingsUpdateRow(version: string, status: SettingsUpdateStatus): ChatPanelRow {
  const description =
    status === 'development'
      ? 'Development Checkout'
      : `${sanitizeTerminalText(version)} (${
          {
            checking: 'checking…',
            current: 'latest',
            available: 'update available!',
            error: 'check failed',
          }[status]
        })`
  return {
    label: 'CLI version',
    description,
    value: SETTINGS_UPDATE_ACTION,
  }
}

export function taskRows(tasks: readonly ChatTask[]): ChatPanelRow[] {
  return tasks
    .filter((task) => task.source === 'background')
    .sort((left, right) => taskStatusRank(left.status) - taskStatusRank(right.status))
    .map((task) => {
      const status = taskStatusLabel(task.status)
      return {
        label: task.label,
        description: task.detail?.replaceAll(' | ', ' · ') ?? '',
        value: `task:${encodeURIComponent(task.id)}`,
        badge: {
          text: status,
          tone: taskStatusTone(status),
        },
      }
    })
}

function taskStatusLabel(status: ChatTask['status']): string {
  if (status === 'working' || status === 'in_progress') return 'running'
  if (status === 'pending' || status === 'queued' || status === 'paused') return 'waiting'
  return status
}

function taskStatusRank(status: ChatTask['status']): number {
  const label = taskStatusLabel(status)
  return label === 'running' ? 0 : label === 'waiting' ? 1 : label === 'completed' ? 2 : 3
}

function taskStatusTone(status: string): 'success' | 'warning' | 'danger' {
  return status === 'running' || status === 'completed' ? 'success' : status === 'waiting' ? 'warning' : 'danger'
}

export function sanitizePanelRow(row: ChatPanelRow): ChatPanelRow {
  return {
    label: sanitizeTerminalText(row.label),
    description: sanitizeTerminalText(row.description),
    ...(row.columns ? { columns: row.columns.map(sanitizeTerminalText) } : {}),
    ...(row.value !== undefined ? { value: sanitizeTerminalText(row.value) } : {}),
    ...(row.bold !== undefined ? { bold: row.bold } : {}),
    ...(row.current !== undefined ? { current: row.current } : {}),
    ...(row.tone !== undefined ? { tone: row.tone } : {}),
    ...(row.control?.kind === 'toggle'
      ? {
          control: {
            kind: 'toggle',
            checked: row.control.checked,
          },
        }
      : row.control?.kind === 'segmented'
        ? {
            control: {
              kind: 'segmented',
              options: row.control.options.map((option) => ({
                label: sanitizeTerminalText(option.label),
                value: sanitizeTerminalText(option.value),
                ...(option.active ? { active: true } : {}),
              })),
            },
          }
        : {}),
    ...(row.badge
      ? {
          badge: {
            text: sanitizeTerminalText(row.badge.text),
            tone: row.badge.tone,
          },
        }
      : {}),
  }
}

export function sanitizeRows(rows: ChatPanel['rows']): ChatPanelRow[] {
  return rows.map((row) => ({
    ...sanitizePanelRow(row),
    ...(row.section ? { section: sanitizeTerminalText(row.section) } : {}),
    ...(row.filter ? { filter: sanitizeTerminalText(row.filter) } : {}),
  }))
}

export function makePanel(id: string, panel: NewChatPanel): ChatPanel {
  const common = {
    ...panel,
    id,
    title: sanitizeTerminalText(panel.title),
    rows: sanitizeRows(panel.rows),
    ...(panel.filters
      ? {
          filters: panel.filters.map((filter) => ({
            id: sanitizeTerminalText(filter.id),
            label: sanitizeTerminalText(filter.label),
          })),
        }
      : {}),
    ...(panel.body !== undefined ? { body: sanitizeTerminalText(panel.body) } : {}),
  }
  switch (panel.kind) {
    case 'effort':
    case 'permissions':
      return {
        ...common,
        kind: panel.kind,
        slider: sanitizeSlider(panel.slider),
      }
    case 'permission':
      return {
        ...common,
        kind: panel.kind,
        request: {
          ...panel.request,
          ...(panel.request.diff ? { diff: sanitizeDiffPreview(panel.request.diff) } : {}),
        },
      }
    case 'config':
      return {
        ...common,
        kind: panel.kind,
        configuration: panel.configuration,
        language: panel.language,
      }
    default:
      return { ...common, kind: panel.kind }
  }
}

function sanitizeSlider(slider: ChatPanelSlider): ChatPanelSlider {
  return {
    label: sanitizeTerminalText(slider.label),
    options: slider.options.map((option) => ({
      id: sanitizeTerminalText(option.id),
      label: sanitizeTerminalText(option.label),
      ...(option.active ? { active: true } : {}),
    })),
    ...(slider.disabled ? { disabled: true } : {}),
  }
}

export function modelRows(models: readonly ChatModelOption[], currentModel: string): ChatPanelRow[] {
  const orderedModels = [...models].sort((left, right) => {
    if (left.active !== right.active) {
      return left.active ? -1 : 1
    }
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  })
  return orderedModels.length > 0
    ? orderedModels.map((model) => {
        const value = model.value ?? model.id
        const description = [...(model.name === model.id ? [] : [model.id]), model.description]
          .filter(Boolean)
          .join(' · ')
        return {
          label: model.name,
          description,
          value,
          ...(model.active
            ? {
                section: 'Current model',
                badge: { text: 'current', tone: 'success' },
              }
            : {}),
          ...(model.catalog ? { filter: model.catalog } : {}),
        }
      })
    : [
        {
          label: modelDisplayName(currentModel),
          description: `${currentModel} · Current model`,
        },
      ]
}

type SessionList = Awaited<ReturnType<ChatSessionRuntime['list']>>

function sessionDirectoryId(session: SessionList[number]): string {
  return `directory:${session.directory ?? session.workspace ?? 'unknown'}`
}

export function sessionFilters(sessions: SessionList): ChatPanelFilter[] {
  const directories = new Map<string, string>()
  for (const session of sessions) {
    const id = sessionDirectoryId(session)
    if (!directories.has(id)) {
      const label = sessionWorkspaceLabel(session.workspace, session.directory)
      directories.set(id, session.active ? `${label} (current)` : label)
    }
  }
  return [{ id: 'all', label: 'All' }, ...[...directories].map(([id, label]) => ({ id, label }))]
}

export function sessionRows(sessions: SessionList): ChatPanelRow[] {
  return sessions.map((session) => ({
    label: session.name ?? session.id,
    description: session.preview ?? '',
    columns: [
      sessionWorkspaceLabel(session.workspace, session.directory),
      session.messageCount === undefined ? '—' : String(session.messageCount),
      session.updatedAt ? formatDate(session.updatedAt) : 'not saved yet',
    ],
    filter: sessionDirectoryId(session),
    value: session.reference ?? session.id,
    ...(session.active ? { current: true } : {}),
  }))
}

export function skillRows(skills: readonly SkillInfo[]): ChatPanelRow[] {
  return skills.length > 0
    ? skills.map((skill) => ({
        label: skill.name,
        description: skill.description,
        value: skill.name,
        section: skill.active ? 'Active skills' : 'Available skills',
        ...(skill.active ? { badge: { text: 'Active', tone: 'success' } as const } : {}),
      }))
    : [{ label: 'none', description: 'No valid SKILL.md files were found.' }]
}

export function skillDetailRows(skill: SkillInfo): ChatPanelRow[] {
  return [
    { label: 'status', description: skill.active ? 'active in this conversation' : 'available on demand' },
    { label: 'description', description: skill.description },
    ...(skill.path ? [{ label: 'path', description: skill.path }] : []),
    ...(skill.allowedTools?.length ? [{ label: 'allowed tools', description: skill.allowedTools.join(', ') }] : []),
    ...(skill.license ? [{ label: 'license', description: skill.license }] : []),
    ...(skill.compatibility ? [{ label: 'compatibility', description: skill.compatibility }] : []),
  ]
}

export function permissionSettingsSlider(selected: ChatPermissionPreset): ChatPanelSlider {
  return {
    label: 'Permission mode',
    options: (['ask', 'bypass', 'custom'] as const).map((id) => ({
      id,
      label: PERMISSION_CHOICES[id].label,
      ...(id === selected ? { active: true } : {}),
    })),
  }
}

export function permissionPreset(status: ChatPermissionStatus): ChatPermissionPreset {
  if (status.mode === 'bypassPermissions') {
    return 'bypass'
  }
  return status.allowedTools.length > 0 ? 'custom' : 'ask'
}

export function permissionSettingsRows(
  status: ChatPermissionStatus,
  tools: ChatRuntimeInfo['tools'],
  selected: ChatPermissionPreset
): ChatPanelRow[] {
  const allowedTools = new Set(status.allowedTools)
  const allToolsAllowed = selected === 'bypass'
  const custom = selected === 'custom'
  const toolDescriptions = new Map(tools.map((tool) => [tool.name, tool.description]))
  const toolNames = permissionToolNames(
    tools.map((tool) => tool.name),
    status.allowedTools
  )
  const toolRows = toolNames.map((toolName): ChatPanelRow => {
    const allowed = allToolsAllowed || allowedTools.has(toolName)
    const toolDescription = toolDescriptions.get(toolName)
    return {
      label: toolName,
      description: permissionToolDescription(allowed, toolDescription),
      ...(custom ? { value: `permissions:tool:${encodeURIComponent(toolName)}` } : {}),
      control: { kind: 'toggle', checked: allowed },
    }
  })
  const denyRows = status.deniedTools.map((rule): ChatPanelRow => ({
    label: `✕ ${rule}`,
    description: custom
      ? 'Denied forever · Enter removes this rule'
      : 'Denied forever, even when all tools are allowed',
    ...(custom ? { value: `permissions:deny:${encodeURIComponent(rule)}` } : {}),
    tone: 'danger',
  }))
  return [...toolRows, ...denyRows]
}

export function builtinToolRows(
  choices: readonly ChatBuiltinToolChoice[],
  selection: ReadonlySet<string>
): ChatPanelRow[] {
  return choices.map((choice) => ({
    label: choice.name,
    // A footer description, so the Exa note never resizes the panel.
    description: choice.thirdParty
      ? '⚠ Third-party search via Exa · https://exa.ai/privacy-policy'
      : choice.description,
    ...(choice.thirdParty ? { tone: 'warning' as const } : {}),
    value: `tools:toggle:${encodeURIComponent(choice.name)}`,
    control: { kind: 'toggle', checked: selection.has(choice.name) },
  }))
}

export function mcpRows(servers: Awaited<ReturnType<LoadedMcp['list']>>, toggles = false): ChatPanelRow[] {
  const transportWidth = Math.max(0, ...servers.map((server) => server.transport.length))
  return servers.map((server) => ({
    label: server.name,
    description: [
      server.transport.padEnd(transportWidth),
      server.toolCount === undefined ? undefined : `${server.toolCount} tools`,
      server.state === 'failed' ? mcpFailure(server).summary : server.target,
    ]
      .filter(Boolean)
      .join(' | '),
    section: server.state === 'connected' ? 'Connected' : 'Unavailable',
    tone: server.state === 'failed' ? 'danger' : 'normal',
    badge: {
      text: server.state,
      tone:
        server.state === 'connected'
          ? 'success'
          : server.state === 'failed'
            ? 'danger'
            : server.state === 'disabled'
              ? 'normal'
              : 'warning',
    },
    value: `mcp:toggle:${encodeURIComponent(server.name)}`,
    ...(toggles
      ? {
          control: { kind: 'toggle' as const, checked: server.state !== 'disabled' },
        }
      : {}),
  }))
}

export function mcpOptions(
  servers: Awaited<ReturnType<LoadedMcp['list']>>,
  paths: readonly string[],
  messages: readonly string[]
): Pick<ChatPanelBase, 'body' | 'searchable'> {
  const checkedPaths = paths.join(', ') || 'the configured paths'
  const warnings = messages.map((warning) => `Skipped: ${warning}`)
  return servers.length === 0
    ? {
        body: [
          'No MCP servers are configured.',
          `Checked: ${checkedPaths}`,
          'Add one there or start with --mcp-config <path>.',
          ...warnings,
        ].join('\n'),
      }
    : { searchable: true, ...(warnings.length > 0 ? { body: warnings.join('\n') } : {}) }
}
