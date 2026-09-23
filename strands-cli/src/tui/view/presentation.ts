import type { JSONValue } from '@strands-agents/sdk'
import stringWidth from 'string-width'

import type { ChatEntry, ChatPanel, ChatSnapshot } from '../chat/controller.js'
import { DEFAULT_CHAT_SETTINGS, type ThemeColors } from '../chat/types.js'
import { modelDisplayName } from '../model/display.js'
import { detailPageSize, type MetadataTarget } from './interaction.js'
import { getTheme } from './theme.js'

const METADATA_START_COLUMN = 2

interface MetadataPlacement {
  target: MetadataTarget
  text: string
  width: number
  alignment: 'flex-start' | 'center' | 'flex-end'
}

export function permissionPageSize(terminalHeight: number, optionRows: number): number {
  return Math.max(3, Math.min(12, terminalHeight - optionRows - 8))
}

export function maxPermissionScroll(panel: ChatPanel, terminalHeight: number, terminalWidth: number): number {
  const width = Math.min(panel.diff ? 100 : 68, terminalWidth - 4) - 6
  return Math.max(0, permissionLines(panel, width).length - permissionPageSize(terminalHeight, panel.rows.length))
}

export function permissionLines(
  panel: ChatPanel,
  width: number,
  palette: ThemeColors = getTheme(DEFAULT_CHAT_SETTINGS)
): DetailLine[] {
  const wrap = (value: string): string[] => {
    const lines: string[] = []
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    for (const line of value.split('\n')) {
      let current = ''
      let cells = 0
      for (const { segment } of segmenter.segment(line)) {
        const size = stringWidth(segment)
        if (current && cells + size > Math.max(1, width)) {
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
  const lines: DetailLine[] = []
  if (panel.diff) {
    lines.push(...wrap(panel.diff.path).map((text) => ({ text })))
    for (const line of panel.diff.lines) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
      const color =
        line.kind === 'add'
          ? palette.success
          : line.kind === 'remove'
            ? palette.error
            : line.kind === 'header'
              ? palette.accent
              : undefined
      const oldLine = String(line.oldLine ?? '').padStart(4)
      const newLine = String(line.newLine ?? '').padStart(4)
      const content = line.kind === 'header' ? line.text : `${oldLine} ${newLine} ${prefix}${line.text}`
      lines.push(
        ...wrap(content).map((text) => ({ text, ...(color ? { color } : {}), dimColor: line.kind === 'context' }))
      )
    }
    if (panel.diff.truncated) {
      lines.push(...wrap('Diff preview truncated; full input follows.').map((text) => ({ text, dimColor: true })))
    }
    lines.push({ text: '' })
  }
  lines.push(...wrap(panel.body ?? '').map((text) => ({ text })))
  return lines
}

export function maxDetailScroll(panel: ChatPanel, width: number, height: number): number {
  return Math.max(0, detailLines(panel, Math.max(10, width - 8)).length - detailPageSize(height, panel.rows.length))
}

interface DetailLine {
  text: string
  color?: string
  bold?: boolean
  dimColor?: boolean
  backgroundColor?: string
}

export function detailLines(
  panel: ChatPanel,
  width: number,
  palette: ThemeColors = getTheme(DEFAULT_CHAT_SETTINGS)
): DetailLine[] {
  return panel.activity
    ? activityDetailLines(panel.activity, width, palette)
    : wrapLines(panel.body ?? '', width).map((text) => ({ text }))
}

function activityDetailLines(
  activity: NonNullable<ChatPanel['activity']>,
  width: number,
  palette: ThemeColors
): DetailLine[] {
  const lines: DetailLine[] = []
  const push = (text: string, style: Omit<DetailLine, 'text'>, prefix = ''): void => {
    const contentWidth = Math.max(1, width - prefix.length)
    for (const [index, chunk] of wrapLines(text, contentWidth).entries()) {
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
    push(`${marker} ${toolAction(entry.name)}  ${summarizeValue(entry.input)}`, {
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
  if (used === undefined || !context.contextWindow) {
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

export function metadataPlacements(snapshot: ChatSnapshot, terminalWidth: number): MetadataPlacement[] {
  const available = Math.max(1, terminalWidth - METADATA_START_COLUMN)
  const baseWidth = Math.floor(available / 3)
  const remainder = available % 3
  const widths = [baseWidth + (remainder > 0 ? 1 : 0), baseWidth + (remainder > 1 ? 1 : 0), baseWidth] as const
  const contextLabel = widths[2] >= 20 ? 'context ' : ''
  const contextBarWidth = Math.max(1, Math.min(10, widths[2] - contextLabel.length - 7))
  return [
    {
      target: 'model' as const,
      value: [modelDisplayName(snapshot.runtime.model), snapshot.runtime.effort].filter(Boolean).join(' · '),
      truncate: truncateEnd,
      alignment: 'flex-start' as const,
    },
    {
      target: 'cwd' as const,
      value: snapshot.runtime.cwd,
      truncate: truncateMiddle,
      alignment: 'center' as const,
    },
    {
      target: 'context' as const,
      // Without a known context window there's nothing to measure against, so the meter is hidden.
      value: snapshot.context.contextWindow ? `${contextLabel}${formatContext(snapshot.context, contextBarWidth)}` : '',
      truncate: truncateEnd,
      alignment: 'flex-end' as const,
    },
  ].flatMap((value, index): MetadataPlacement[] => {
    const width = widths[index]!
    const text = value.truncate(value.value, width)
    const placement = {
      target: value.target,
      text,
      width,
      alignment: value.alignment,
    }
    return text ? [placement] : []
  })
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

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  if (maxLength <= 1) {
    return value.slice(0, maxLength)
  }
  const suffixLength = Math.ceil((maxLength - 1) * 0.7)
  const prefixLength = maxLength - 1 - suffixLength
  return `${value.slice(0, prefixLength)}…${value.slice(-suffixLength)}`
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
  bash: 'Run',
  edit: 'Edit',
  subagent: 'Delegate',
  read: 'Read',
  strands_manage_background_task: 'Manage task',
  todo_write: 'Update tasks',
  web_fetch: 'Fetch',
  web_search: 'Search',
  write: 'Write',
}

export function toolAction(name: string): string {
  return TOOL_ACTIONS[name.replaceAll('-', '_').toLowerCase()] ?? name
}

export function summarizeToolInput(name: string, input: JSONValue): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (name.replaceAll('-', '_').toLowerCase() === 'subagent') {
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
