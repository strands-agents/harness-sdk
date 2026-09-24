import type { BackgroundAgentActivity } from '../background/activity.js'
import { PROVIDER_IDS, PROVIDER_LABELS } from '../config.js'
import type { LoadedMcp } from '../mcp.js'
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
  type ChatPanelFilter,
  type ChatPanelOptions,
  type ChatPanelRow,
  type ChatPanelSlider,
  type ChatPermissionRequest,
  type ChatPermissionStatus,
  type ChatRuntimeInfo,
  type ChatSettings,
  type ChatTask,
  type SettingsCategory,
} from './types.js'
import { SETTINGS_CATEGORIES, SETTING_DEFINITIONS, settingDescription } from '../settings.js'

export const BACKGROUND_TASK_WAIT_TOGGLE = 'background-tasks:toggle-wait-for-completion'

export function permissionRequestRows(request: ChatPermissionRequest): ChatPanelRow[] {
  return request.options.map((option) => ({
    label: option.label,
    description:
      option.description ??
      (option.kind === 'allow_once'
        ? 'Run only this call'
        : option.kind === 'allow_always'
          ? 'Allow future calls without prompting'
          : 'Block this call and return the denial to the agent'),
    value: `permission:${encodeURIComponent(request.id)}:${encodeURIComponent(option.id)}`,
    tone: option.kind.startsWith('reject') ? 'danger' : 'normal',
  }))
}

export function formatPermissionPanelBody(request: ChatPermissionRequest): string {
  const value = request.input
  let input: string
  try {
    input = JSON.stringify(value, null, 2)
  } catch {
    input = String(value)
  }
  input = input.replace(
    /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
  return `Tool: ${request.toolName}\nInputs:\n${input}`
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

export function clonePanel(panel: ChatPanel): ChatPanel {
  return {
    ...panel,
    rows: panel.rows.map((row) => ({
      ...row,
      ...(row.control?.kind === 'toggle'
        ? { control: { ...row.control } }
        : row.control?.kind === 'segmented'
          ? { control: { ...row.control, options: row.control.options.map((option) => ({ ...option })) } }
          : {}),
    })),
    ...(panel.filters ? { filters: panel.filters.map((filter) => ({ ...filter })) } : {}),
    ...(panel.slider
      ? {
          slider: {
            ...panel.slider,
            options: panel.slider.options.map((option) => ({ ...option })),
          },
        }
      : {}),
    ...(panel.diff ? { diff: sanitizeDiffPreview(panel.diff) } : {}),
    ...(panel.settingsCategories
      ? { settingsCategories: panel.settingsCategories.map((category) => ({ ...category })) }
      : {}),
  }
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString().replace('T', ' ').slice(0, 16)
}

export function settingsCategoryFilters(): ChatPanelFilter[] {
  return SETTINGS_CATEGORIES.map(({ id, label }) => ({ id: `settings:${id}`, label }))
}

export function settingsRows(
  settings: ChatSettings,
  setupAvailable = false,
  category?: SettingsCategory
): ChatPanelRow[] {
  return SETTING_DEFINITIONS.filter(({ section }) => category === undefined || section === category).flatMap(
    ({ key, label, section, control, options }): ChatPanelRow[] => [
      {
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
      },
      ...(setupAvailable && key === 'setupOnLaunch'
        ? [
            {
              label: 'Setup',
              description: 'Providers and agent ›',
              value: 'setup',
              ...(category ? {} : { section: 'General' }),
              ...(category ? { filter: `settings:${category}` } : {}),
            },
          ]
        : []),
    ]
  )
}

export function taskRows(tasks: readonly ChatTask[], waitForCompletion: boolean | undefined): ChatPanelRow[] {
  const controls: ChatPanelRow[] =
    waitForCompletion === undefined
      ? []
      : [
          {
            label: 'Wait for completion',
            description: waitForCompletion
              ? 'Finish background work and continue the agent before returning the turn.'
              : 'Keep chatting while work runs; resume the agent automatically when results arrive.',
            value: BACKGROUND_TASK_WAIT_TOGGLE,
            section: 'Background behavior',
            badge: {
              text: waitForCompletion ? 'on' : 'off',
              tone: waitForCompletion ? 'success' : 'warning',
            },
          },
        ]
  const rows =
    tasks.length === 0
      ? [{ label: 'none', description: 'No todos, agent plans, or background tasks are active.' }]
      : tasks.map((task) => ({
          label: task.label,
          description: [task.status.replaceAll('_', ' '), task.detail].filter(Boolean).join(' | '),
          section: task.source === 'todo' ? 'Todos' : task.source === 'acp' ? 'ACP plan' : 'Background tasks',
          value: `task:${encodeURIComponent(task.id)}`,
        }))
  return [...controls, ...rows]
}

export function sanitizePanelRow(row: ChatPanelRow): ChatPanelRow {
  return {
    label: sanitizeTerminalText(row.label),
    description: sanitizeTerminalText(row.description),
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

export function makePanel(
  id: string,
  kind: ChatPanel['kind'],
  title: string,
  rows: ChatPanel['rows'],
  options: ChatPanelOptions
): ChatPanel {
  return {
    id,
    kind,
    title: sanitizeTerminalText(title),
    rows: sanitizeRows(rows),
    ...(options.searchable !== undefined ? { searchable: options.searchable } : {}),
    ...(options.filters
      ? {
          filters: options.filters.map((filter) => ({
            id: sanitizeTerminalText(filter.id),
            label: sanitizeTerminalText(filter.label),
          })),
        }
      : {}),
    ...(options.slider
      ? {
          slider: {
            label: sanitizeTerminalText(options.slider.label),
            options: options.slider.options.map((option) => ({
              id: sanitizeTerminalText(option.id),
              label: sanitizeTerminalText(option.label),
              ...(option.active ? { active: true } : {}),
            })),
            ...(options.slider.disabled ? { disabled: true } : {}),
            ...(options.slider.focused ? { focused: true } : {}),
          },
        }
      : {}),
    ...(options.body !== undefined ? { body: sanitizeTerminalText(options.body) } : {}),
    ...(options.diff ? { diff: sanitizeDiffPreview(options.diff) } : {}),
    ...(options.followTail !== undefined ? { followTail: options.followTail } : {}),
    ...(options.activity ? { activity: options.activity } : {}),
    ...(options.settingsCategory ? { settingsCategory: options.settingsCategory } : {}),
    ...(options.settingsCategories
      ? {
          settingsCategories: options.settingsCategories.map(({ id: categoryId, label, description }) => ({
            id: categoryId,
            label: sanitizeTerminalText(label),
            description: sanitizeTerminalText(description),
          })),
        }
      : {}),
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

export function sessionRows(
  sessions: Awaited<ReturnType<ChatSessionRuntime['list']>>,
  directory: string
): ChatPanelRow[] {
  return sessions.length > 0
    ? sessions.map((session) => ({
        label: session.name ?? session.id,
        description: [
          sessionWorkspaceLabel(session.workspace, session.directory),
          session.messageCount === undefined
            ? undefined
            : `${session.messageCount} ${session.messageCount === 1 ? 'message' : 'messages'}`,
          session.updatedAt ? formatDate(session.updatedAt) : 'not saved yet',
          session.preview,
        ]
          .filter(Boolean)
          .join(' · '),
        value: session.reference ?? session.id,
        ...(session.active ? { current: true } : {}),
      }))
    : [{ label: 'none', description: `No sessions found in ${directory}.` }]
}

export function skillRows(skills: readonly SkillInfo[]): ChatPanelRow[] {
  return skills.length > 0
    ? skills.map((skill) => ({
        label: skill.active ? `active ${skill.name}` : skill.name,
        description: skill.description,
        value: skill.name,
        section: skill.active ? 'Active skills' : 'Available skills',
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

export function permissionSettingsRows(status: ChatPermissionStatus, tools: ChatRuntimeInfo['tools']): ChatPanelRow[] {
  const allowedTools = new Set(status.allowedTools)
  const allToolsAllowed = status.mode === 'bypassPermissions'
  const toolDescriptions = new Map(tools.map((tool) => [tool.name, tool.description]))
  const toolNames = permissionToolNames(
    tools.map((tool) => tool.name),
    status.allowedTools
  )
  return [
    {
      label: PERMISSION_CHOICES.default.label,
      description: PERMISSION_CHOICES.default.description,
      value: 'permissions:mode:default',
      section: 'Permission mode',
      ...(status.mode === 'default' ? { badge: { text: 'Active', tone: 'success' } as const } : {}),
    },
    {
      label: PERMISSION_CHOICES.bypassPermissions.label,
      description: PERMISSION_CHOICES.bypassPermissions.description,
      value: 'permissions:mode:bypassPermissions',
      section: 'Permission mode',
      tone: 'danger',
      ...(status.mode === 'bypassPermissions' ? { badge: { text: 'Active', tone: 'danger' } as const } : {}),
    },
    ...toolNames.map((toolName): ChatPanelRow => {
      const allowed = allToolsAllowed || allowedTools.has(toolName)
      const toolDescription = toolDescriptions.get(toolName)
      return {
        label: toolName,
        description: allToolsAllowed
          ? `Allowed by “Allow all tools”${toolDescription ? ` · ${toolDescription}` : ''}`
          : permissionToolDescription(allowed, toolDescription),
        ...(!allToolsAllowed ? { value: `permissions:tool:${encodeURIComponent(toolName)}` } : {}),
        section: 'Run without asking',
        control: { kind: 'toggle', checked: allowed },
      }
    }),
    {
      label: 'config',
      description: status.configPath,
      section: 'Configuration',
    },
  ]
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

export function mcpRows(servers: Awaited<ReturnType<LoadedMcp['list']>>): ChatPanelRow[] {
  return servers.map((server) => ({
    label: server.name,
    description: [
      server.state,
      server.transport,
      server.toolCount === undefined ? undefined : `${server.toolCount} tools`,
      server.target,
    ]
      .filter(Boolean)
      .join(' | '),
    section: server.state === 'connected' ? 'Connected' : 'Unavailable',
    tone: server.state === 'failed' ? 'danger' : 'normal',
  }))
}

export function mcpOptions(
  servers: Awaited<ReturnType<LoadedMcp['list']>>,
  paths: readonly string[],
  messages: readonly string[]
): Pick<ChatPanel, 'body' | 'searchable'> {
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
