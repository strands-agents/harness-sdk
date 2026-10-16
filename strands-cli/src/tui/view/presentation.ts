import type { JSONValue } from '@strands-agents/sdk'
import stringWidth from 'string-width'

import type { ChatDetailPanel, ChatEntry, ChatPermissionPanel, ChatSnapshot } from '../chat/controller.js'
import type { BackgroundAgentActivity } from '../background/activity.js'
import { DEFAULT_CHAT_SETTINGS, type ThemeColors } from '../chat/types.js'
import { modelDisplayName } from '../model/display.js'
import { escapePermissionText } from '../chat/panels.js'
import { FILE_TOOLS } from '../permissions/rules.js'
import { permissionModeDisplayLabel } from '../permissions/settings.js'
import { graphemes } from '../terminal/composer.js'
import {
  COMPOSER_RESOURCE_PANEL_HEIGHT,
  COMPOSER_EXPANDED_PANEL_HEIGHT,
  detailPageSize,
  permissionPanelLayout,
  permissionPreviewCapacity,
} from './interaction.js'
import { getTheme } from './theme.js'
import { isRecord } from '../values.js'

const METADATA_START_COLUMN = 2

interface MetadataPlacement {
  target: 'model' | 'cwd' | 'settings'
  text: string
  width: number
  alignment: 'flex-start' | 'center' | 'flex-end'
  controls?: { target: 'model' | 'effort' | 'permissions' | 'context'; text: string }[]
  actions?: { target: 'settings' | 'update'; text: string }[]
}

export function maxPermissionScroll(
  panel: ChatPermissionPanel,
  terminalHeight: number,
  terminalWidth: number,
  composerHeight = Math.min(COMPOSER_EXPANDED_PANEL_HEIGHT, Math.max(1, terminalHeight - 2)),
  selected = 0
): number {
  const layout = permissionPanelLayout(Math.max(1, terminalWidth - 2), composerHeight, panel.rows.length)
  const lines = permissionLines(panel, layout.previewTextWidth, undefined, selected)
  return Math.max(0, lines.length - permissionPreviewCapacity(lines.length, layout.previewHeight))
}

export interface PermissionLine {
  label: string
  text: string
  color?: string
  bold?: boolean
  dimColor?: boolean
}

export const PERMISSION_LABEL_WIDTH = 9

/** The request details: the tool, the specific action, and the raw input when the tool has no action. */
export function permissionLines(
  panel: ChatPermissionPanel,
  width: number,
  palette: ThemeColors = getTheme(DEFAULT_CHAT_SETTINGS),
  selected = 0
): PermissionLine[] {
  const { request } = panel
  const lines: PermissionLine[] = []
  const field = (label: string, value: string, style: Omit<PermissionLine, 'label' | 'text'> = {}): void => {
    for (const [index, text] of wrapCells(value, Math.max(1, width - PERMISSION_LABEL_WIDTH)).entries()) {
      lines.push({ label: index === 0 ? label : '', text, ...style })
    }
  }
  field('Tool', request.toolName, { color: palette.accent, bold: true })
  const scope = panel.stage ? request.scopes?.[selected] : undefined
  if (scope) {
    field('Rule', escapePermissionText(scope.rule), {
      color: panel.stage === 'deny-always' ? palette.error : palette.success,
      bold: true,
    })
  }
  if (request.action !== undefined) {
    field('Action', escapePermissionText(request.action), { bold: true })
  }
  const diff = request.diff
  if (diff && !FILE_TOOLS.has(request.toolName)) {
    field('File', diff.path)
  }
  const added = diff?.lines.filter((line) => line.kind === 'add').length ?? 0
  const removed = diff?.lines.filter((line) => line.kind === 'remove').length ?? 0
  if (added + removed > 0) {
    field('Changes', `+${added} -${removed} lines${diff?.truncated ? ' (preview truncated)' : ''}`, { dimColor: true })
  }
  if (request.action === undefined) {
    field('Input', panel.body ?? '')
  }
  return lines
}

function wrapCells(value: string, width: number): string[] {
  const lines: string[] = []
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  for (const line of value.split('\n')) {
    let current = ''
    let cells = 0
    for (const { segment } of segmenter.segment(line)) {
      const size = stringWidth(segment)
      if (current && cells + size > width) {
        lines.push(current)
        current = ''
        cells = 0
      }
      current += segment
      cells += size
    }
    lines.push(current)
  }
  return lines
}

export function maxDetailScroll(
  panel: ChatDetailPanel,
  terminalWidth: number,
  composerHeight = COMPOSER_RESOURCE_PANEL_HEIGHT
): number {
  return Math.max(0, detailLines(panel, Math.max(1, terminalWidth - 6)).length - detailPageSize(composerHeight))
}

interface DetailLine {
  text: string
  label?: string
  color?: string
  bold?: boolean
  dimColor?: boolean
  backgroundColor?: string
}

export function detailLines(
  panel: ChatDetailPanel,
  width: number,
  palette: ThemeColors = getTheme(DEFAULT_CHAT_SETTINGS)
): DetailLine[] {
  const labelWidth = Math.min(Math.max(0, ...panel.rows.map((row) => stringWidth(row.label))), Math.floor(width / 2))
  const valueWidth = Math.max(1, width - labelWidth - 2)
  const metadata = panel.rows.flatMap((row) => {
    const labels = wrapCells(normalizeDetailText(row.label), Math.max(1, labelWidth))
    const values = wrapCells(normalizeDetailText(row.description), valueWidth)
    return Array.from({ length: Math.max(labels.length, values.length) }, (_, index): DetailLine => {
      const label = labels[index] ?? ''
      return {
        label: label + ' '.repeat(Math.max(0, labelWidth - stringWidth(label)) + 2),
        text: values[index] ?? '',
      }
    })
  })
  const body = panel.activity
    ? activityDetailLines(panel.activity, width, palette)
    : wrapCells(normalizeDetailText(panel.body ?? ''), Math.max(1, width)).map((text) => ({ text }))
  return metadata.length > 0 ? [...metadata, { text: '' }, ...body] : body
}

function activityDetailLines(activity: BackgroundAgentActivity, width: number, palette: ThemeColors): DetailLine[] {
  const lines: DetailLine[] = []
  const push = (text: string, style: Omit<DetailLine, 'text'>, prefix = ''): void => {
    const contentWidth = Math.max(1, width - prefix.length)
    for (const [index, chunk] of wrapCells(normalizeDetailText(text), contentWidth).entries()) {
      lines.push({ text: `${index === 0 ? prefix : ' '.repeat(prefix.length)}${chunk}`, ...style })
    }
  }
  const spacer = (): void => {
    if (lines.at(-1)?.text !== '') {
      lines.push({ text: '' })
    }
  }

  push('TASK', { color: palette.accent, bold: true })
  push(activity.task, {}, '  ')

  for (const entry of activity.entries) {
    spacer()
    if (entry.type !== 'tool') {
      if (entry.type === 'reasoning') {
        push('◇ Reasoning', { color: palette.warning, bold: true })
        push(entry.text, { dimColor: true }, '  ')
      } else {
        push(`◆ ${activity.name}`, { color: palette.accent, bold: true })
        push(entry.text, {}, '  ')
      }
      continue
    }

    const marker = entry.status === 'running' ? '◐' : entry.status === 'success' ? '✓' : '×'
    const color =
      entry.status === 'running' ? palette.warning : entry.status === 'success' ? palette.success : palette.error
    push(`${marker} ${toolAction(entry.name)}  ${summarizeToolInput(entry.name, entry.input)}`, {
      color,
      bold: true,
      backgroundColor: palette.surface,
    })
    if (entry.result) {
      push('result', { dimColor: true }, '  ')
      for (const resultLine of normalizeDetailText(entry.result).split('\n')) {
        push(resultLine, { dimColor: true }, '  │ ')
      }
    }
    if (entry.error) {
      push(entry.error, { color: palette.error }, '  × ')
    }
  }

  if (activity.entries.length === 0 && activity.status === 'working') {
    spacer()
    push('◐ Starting agent...', { color: palette.warning })
  }
  if (activity.error) {
    spacer()
    push(activity.error, { color: palette.error }, '× ')
  }
  return lines
}

export function wrapLines(value: string, width: number): string[] {
  return normalizeDetailText(value)
    .split('\n')
    .flatMap((line) => {
      if (!line) {
        return ['']
      }
      const chunks: string[] = []
      let remaining = line
      while (remaining.length > width) {
        chunks.push(remaining.slice(0, width))
        remaining = remaining.slice(width)
      }
      chunks.push(remaining)
      return chunks
    })
}

function normalizeDetailText(value: string): string {
  return value.replaceAll('\t', '    ').replaceAll('\r', '')
}

export function formatContext(context: ChatSnapshot['context'], width = 10): string {
  const used = context.projectedTokens ?? context.currentTokens
  if (!context.contextWindow) {
    return `${'░'.repeat(width)} —`
  }
  if (used === undefined) {
    return `${'░'.repeat(width)} 0%`
  }
  const percentage = (used / context.contextWindow) * 100
  const filled = used > 0 ? Math.max(1, Math.round(Math.min(1, used / context.contextWindow) * width)) : 0
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${formatPercentage(percentage)}`
}

function formatPercentage(value: number): string {
  if (value === 0) {
    return '0%'
  }
  if (value > 0 && value < 0.1) {
    return '<0.1%'
  }
  if (value < 1) {
    return `${value.toFixed(1)}%`
  }
  return `${value.toFixed(1).replace(/\.0$/, '')}%`
}

export function contextColor(context: ChatSnapshot['context'], palette: ThemeColors): string {
  const used = context.projectedTokens ?? context.currentTokens
  if (used === undefined || !context.contextWindow) {
    return palette.accent
  }
  const percentage = (used / context.contextWindow) * 100
  return percentage >= 90 ? palette.error : percentage >= 75 ? palette.warning : palette.accent
}

export function metadataPlacements(
  snapshot: ChatSnapshot,
  terminalWidth: number,
  availableUpdate?: string
): MetadataPlacement[] {
  const separatorWidth = 2
  const available = Math.max(0, Math.floor(terminalWidth) - METADATA_START_COLUMN)
  const model = modelDisplayName(snapshot.runtime.model)
  const effort = model && snapshot.runtime.effort ? ` • ${snapshot.runtime.effort}` : ''
  const baseModelLabel = model ? `${model}${effort}` : (snapshot.runtime.effort ?? '')
  const permission = snapshot.permissionMode
    ? permissionModeDisplayLabel(snapshot.permissionMode, snapshot.permissionPreset)
    : ''
  const permissionSuffix = permission ? `${baseModelLabel ? ' • ' : ''}${permission}` : ''
  const modelLabel = `${baseModelLabel}${permissionSuffix}`
  const settingsAction = { target: 'settings' as const, text: '/settings' }
  const fullUpdateAction = { target: 'update' as const, text: `↑ Update ${availableUpdate}` }
  const compactUpdateAction = { target: 'update' as const, text: '↑ Update' }
  const fullActionsWidth = stringWidth(`${fullUpdateAction.text}  ${settingsAction.text}`)
  const compactActionsWidth = stringWidth(`${compactUpdateAction.text}  ${settingsAction.text}`)
  const actions = !availableUpdate
    ? [{ ...settingsAction, text: truncateMetadata(settingsAction.text, available) }]
    : fullActionsWidth <= available
      ? [fullUpdateAction, settingsAction]
      : compactActionsWidth <= available
        ? [compactUpdateAction, settingsAction]
        : [{ ...compactUpdateAction, text: truncateMetadata(compactUpdateAction.text, available) }]
  const settingsText = actions.map(({ text }) => text).join('  ')
  const settingsWidth = stringWidth(settingsText)
  const leftWidth = Math.max(0, available - settingsWidth - separatorWidth)
  const context = formatContext(snapshot.context)
  const minimumContextWidth = stringWidth(formatContext(snapshot.context, 1))
  const controlSeparatorWidth = modelLabel ? stringWidth(' • ') : 0
  const permissionRequiredWidth =
    stringWidth(model ? effort : baseModelLabel) + stringWidth(permissionSuffix) + Number(Boolean(model))
  const minimumModelWidth = Math.min(stringWidth(modelLabel), Math.max(1, permissionRequiredWidth))
  const contextBudget = Math.max(0, leftWidth - minimumModelWidth - controlSeparatorWidth)
  const contextWidth =
    contextBudget >= minimumContextWidth
      ? Math.min(
          stringWidth(context),
          Math.max(minimumContextWidth, leftWidth - stringWidth(modelLabel) - controlSeparatorWidth)
        )
      : 0
  const modelWidth = Math.min(
    stringWidth(modelLabel),
    Math.max(0, leftWidth - contextWidth - (contextWidth ? controlSeparatorWidth : 0))
  )
  const showEffort = !model || (effort && modelWidth > stringWidth(effort))
  const showPermission = Boolean(permission && modelWidth >= permissionRequiredWidth)
  const visiblePermissionWidth = showPermission ? stringWidth(permissionSuffix) : 0
  const modelName = truncateMetadata(
    model,
    modelWidth - (showEffort ? stringWidth(effort) : 0) - visiblePermissionWidth
  )
  const effortLabel = showEffort ? truncateMetadata(snapshot.runtime.effort ?? '', modelWidth) : ''
  const controls = [
    { target: 'model' as const, text: modelName },
    { target: 'effort' as const, text: effortLabel },
    { target: 'permissions' as const, text: showPermission ? permission : '' },
    {
      target: 'context' as const,
      text: contextWidth ? formatContext(snapshot.context, contextWidth - minimumContextWidth + 1) : '',
    },
  ].filter((control) => control.text)
  const modelText = controls.map((control) => control.text).join(' • ')
  const pathMinimumStart = modelText ? stringWidth(modelText) + separatorWidth : 0
  const pathMaximumEnd = Math.max(0, available - settingsWidth - separatorWidth)
  const pathText = truncateMetadata(snapshot.runtime.cwd, Math.max(0, pathMaximumEnd - pathMinimumStart), true)
  const pathWidth = stringWidth(pathText)
  const pathStart = Math.max(
    pathMinimumStart,
    Math.min(Math.floor((available - pathWidth) / 2), pathMaximumEnd - pathWidth)
  )
  const modelSlotWidth = pathText ? pathStart : modelText ? available - settingsWidth : 0
  return [
    {
      target: 'model' as const,
      text: modelText,
      width: modelSlotWidth,
      alignment: 'flex-start' as const,
      controls,
    },
    {
      target: 'cwd' as const,
      text: pathText,
      width: pathWidth + (modelText ? 0 : pathStart),
      alignment: 'flex-end' as const,
    },
    {
      target: 'settings' as const,
      text: settingsText,
      width: available - modelSlotWidth - pathWidth,
      alignment: 'flex-end' as const,
      actions: actions.filter(({ text }) => text),
    },
  ].filter((placement) => placement.text)
}

function truncateMetadata(value: string, width: number, middle = false): string {
  if (width <= 0) {
    return ''
  }
  if (stringWidth(value) <= width) {
    return value
  }
  if (width === 1 && /^[\x20-\x7e]*$/u.test(value)) {
    return value[0]!
  }
  const segments = graphemes(value)
  let suffix = ''
  const suffixWidth = middle ? Math.ceil((width - 1) * 0.7) : 0
  while (segments.length && stringWidth(segments.at(-1)! + suffix) <= suffixWidth) {
    suffix = segments.pop()! + suffix
  }
  let prefix = ''
  for (const segment of segments) {
    if (stringWidth(prefix + segment + suffix) > width - 1) {
      break
    }
    prefix += segment
  }
  return `${prefix}…${suffix}`
}

export function formatTurnMetrics(durationMs: number | undefined, totalTokens: number | undefined): string {
  return [
    durationMs !== undefined ? `Worked for ${formatDuration(durationMs)}` : undefined,
    totalTokens !== undefined ? `${totalTokens.toLocaleString('en-US')} tokens used` : undefined,
  ]
    .filter((value) => value !== undefined)
    .join(' · ')
}

function formatDuration(durationMs: number): string {
  if (durationMs < 100) {
    return '<0.1s'
  }
  if (durationMs < 10_000) {
    return `${(durationMs / 1_000).toFixed(1)}s`
  }
  const totalSeconds = Math.round(durationMs / 1_000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const totalMinutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${seconds}s`
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${minutes}m`
}

function truncateEnd(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  if (maxLength <= 1) {
    return value.slice(0, maxLength)
  }
  return `${value.slice(0, maxLength - 1)}…`
}

export function formatValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function summarizeValue(value: unknown): string {
  const text = formatValue(value).replace(/\s+/g, ' ').trim()
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`
}

const TOOL_ACTIONS: Readonly<Record<string, string>> = {
  bash: 'Shell',
  edit: 'Edit',
  message_agent: 'Message',
  subagent: 'Subagent',
  read: 'Read',
  retrieve_context: 'Retrieve',
  retrieve_offloaded_content: 'Retrieve',
  search_memory: 'Memory',
  shell: 'Shell',
  skills: 'Skills',
  strands_config: 'Strands Config',
  strands_manage_background_task: 'Background',
  todo_write: 'Update tasks',
  web_fetch: 'Fetch',
  web_search: 'Search',
  write: 'Write',
}

export function toolAction(name: string): string {
  return TOOL_ACTIONS[name.replaceAll('-', '_').toLowerCase()] ?? name
}

function summarizeStrandsConfigInput(input: Record<string, JSONValue>): string | undefined {
  const action = typeof input.action === 'string' ? input.action : undefined
  if (!action) {
    return undefined
  }
  if (action === 'models') {
    const detail = [input.provider, input.query].filter((value): value is string => typeof value === 'string')
    return truncateEnd(detail.length > 0 ? `models: ${detail.join(' · ')}` : 'models', 160)
  }
  if (action === 'update') {
    const profile = input.profile
    const settings = input.settings
    const profileObject = isRecord(profile) ? profile : undefined
    const profileFields = profileObject ? Object.keys(profileObject) : []
    const settingFields = isRecord(settings) ? Object.keys(settings).map((key) => `settings.${key}`) : []
    const fields = [
      ...profileFields,
      ...settingFields,
      ...(['permissionMode', 'allowedTools'] as const).filter((key) => input[key] !== undefined),
    ]
    if (fields.length === 1 && fields[0] === 'model') {
      const model = profileObject?.model
      if (typeof model === 'string') {
        return truncateEnd(`update model: ${modelDisplayName(model)}`, 160)
      }
    }
    return truncateEnd(fields.length > 0 ? `update: ${fields.join(', ')}` : 'update', 160)
  }
  return truncateEnd(action, 160)
}

export function summarizeToolInput(name: string, input: JSONValue): string {
  if (isRecord(input)) {
    const normalizedName = name.replaceAll('-', '_').toLowerCase()
    if (normalizedName === 'strands_config') {
      const summary = summarizeStrandsConfigInput(input)
      if (summary) {
        return summary
      }
    }
    if (normalizedName === 'subagent') {
      return truncateEnd(typeof input.task === 'string' ? input.task : '', 160)
    }
    if (typeof input.command === 'string') {
      return truncateEnd(input.command, 160)
    }
    if (typeof input.path === 'string') {
      const offset = typeof input.offset === 'number' ? input.offset : undefined
      const limit = typeof input.limit === 'number' ? input.limit : undefined
      const range =
        offset !== undefined ? `:${offset}${limit !== undefined ? `-${offset + Math.max(0, limit - 1)}` : ''}` : ''
      return truncateEnd(`${input.path}${range}`, 160)
    }
    if (typeof input.url === 'string') {
      return truncateEnd(input.url, 160)
    }
    if (typeof input.query === 'string') {
      return truncateEnd(input.query, 160)
    }
    const action =
      typeof input.action === 'string' ? input.action : typeof input.mode === 'string' ? input.mode : undefined
    const taskId =
      typeof input.task_id === 'string' ? input.task_id : typeof input.taskId === 'string' ? input.taskId : undefined
    if (action || taskId) {
      return truncateEnd([action, taskId].filter(Boolean).join(' · '), 160)
    }
    if (Object.keys(input).length === 0) {
      return ''
    }
  }
  return summarizeValue(input)
}

export function sentPeerMessage(
  entry: Extract<ChatEntry, { type: 'tool' }>
): { recipient: string; body: string } | undefined {
  if (
    entry.name.replaceAll('-', '_').toLowerCase() !== 'message_agent' ||
    !entry.input ||
    typeof entry.input !== 'object' ||
    Array.isArray(entry.input) ||
    entry.input.action !== 'send' ||
    typeof entry.input.to !== 'string' ||
    typeof entry.input.message !== 'string'
  ) {
    return undefined
  }
  let recipient = entry.input.to
  if (entry.status === 'success') {
    for (const result of entry.result ?? []) {
      if (
        result.type === 'json' &&
        result.value &&
        typeof result.value === 'object' &&
        !Array.isArray(result.value) &&
        typeof result.value.recipient === 'string'
      ) {
        recipient = result.value.recipient
        break
      }
    }
  }
  return {
    recipient: truncateEnd(recipient, 80),
    body: entry.input.message,
  }
}

export function isBackgroundAgent(entry: Extract<ChatEntry, { type: 'tool' }>): boolean {
  return entry.background === true || backgroundTaskDispatch(entry) !== undefined
}

export function backgroundTaskDispatch(
  entry: Extract<ChatEntry, { type: 'tool' }>
): { taskId: string; toolName: string } | undefined {
  for (const item of entry.result ?? []) {
    if (item.type !== 'text' || !item.text.startsWith('Background task dispatched.')) {
      continue
    }
    const taskId = item.text.match(/^Task ID:\s*(.+)$/m)?.[1]?.trim()
    const toolName = item.text.match(/^Tool:\s*(.+)$/m)?.[1]?.trim()
    if (taskId && toolName) {
      return { taskId, toolName }
    }
  }
  return undefined
}

export function summarizeToolResult(result: NonNullable<Extract<ChatEntry, { type: 'tool' }>['result']>): {
  lines: string[]
  hiddenLines: number
} {
  const lines = result
    .map((item) => {
      if (item.type === 'text') {
        return item.text
      }
      if (item.type === 'json') {
        return formatValue(item.value)
      }
      return `[${item.type}]`
    })
    .join('\n')
    .split('\n')
    .map((line) => line.trimEnd())
  while (lines[0] === '') {
    lines.shift()
  }
  while (lines.at(-1) === '') {
    lines.pop()
  }
  const visible = lines.slice(0, 3).map((line) => truncateEnd(line, 180))
  return { lines: visible, hiddenLines: lines.length - visible.length }
}
