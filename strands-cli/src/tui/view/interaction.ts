import type { DOMElement, Key } from 'ink'

import type { ChatControllerApi, ChatPanel, ChatPanelRow, ChatPanelSlider, ChatSnapshot } from '../chat/controller.js'
import { resolveModelTarget } from '../model/selection.js'
import type { MouseInput } from '../terminal/mouse-input.js'

export type MetadataTarget = 'model' | 'context' | 'cwd'
export const MODEL_COPY_TARGET = 'model:copy-id'

export type ModelPanelFocus = 'effort' | 'search' | 'providers' | 'models' | 'copy'

export function settingsLayout(
  panelWidth: number,
  setting?: string
): {
  contentWidth: number
  labelWidth: number
  columns: number
  optionWidth: number
} {
  const contentWidth = Math.max(1, Math.min(68, panelWidth - 4))
  const longLabel = setting === 'agentMessaging' || setting === 'setupOnLaunch' || setting === 'telemetry'
  const labelWidth =
    setting === 'frogTheme'
      ? Math.floor(contentWidth / 3)
      : longLabel
        ? Math.min(contentWidth, 32, Math.max(15, contentWidth - 14))
        : Math.min(contentWidth, 23, Math.max(15, Math.floor(contentWidth / 3)))
  const optionWidth = setting === 'frogTheme' ? 11 : 14
  return {
    contentWidth,
    labelWidth,
    columns: Math.min(4, Math.max(1, Math.floor((contentWidth - labelWidth) / optionWidth))),
    optionWidth,
  }
}

export function settingsThemeLayout(panelWidth: number): {
  columns: number
  optionWidth: number
  optionHeight: number
  offset: number
} {
  const { contentWidth, labelWidth } = settingsLayout(panelWidth)
  const offset = contentWidth >= 54 ? labelWidth : 0
  const gridWidth = contentWidth - offset
  const columns = gridWidth >= 30 ? 3 : gridWidth >= 20 ? 2 : 1
  return {
    columns,
    optionWidth: Math.floor(gridWidth / columns),
    optionHeight: contentWidth >= 54 ? 3 : 1,
    offset,
  }
}

export function adjacentSettingOption(
  control: NonNullable<ChatPanelRow['control']>,
  key: Partial<Key>,
  columns: number
): number | undefined {
  if (control.kind !== 'segmented') {
    return undefined
  }
  const active = Math.max(
    0,
    control.options.findIndex((option) => option.active)
  )
  if (key.leftArrow || key.rightArrow) {
    return Math.max(0, Math.min(control.options.length - 1, active + (key.leftArrow ? -1 : 1)))
  }
  if (key.upArrow && active >= columns) {
    return active - columns
  }
  if (key.downArrow && Math.floor(active / columns) < Math.floor((control.options.length - 1) / columns)) {
    return Math.min(control.options.length - 1, active + columns)
  }
  return undefined
}

const AGENT_GRID_TILE_ROWS = 8

export function agentGridColumns(terminalWidth: number): number {
  const panelWidth = terminalWidth - 4
  return panelWidth >= 96 ? 3 : panelWidth >= 60 ? 2 : 1
}

export function agentGridCapacity(terminalWidth: number, terminalHeight: number): number {
  const rows = Math.max(1, Math.floor((terminalHeight - 14) / AGENT_GRID_TILE_ROWS))
  return agentGridColumns(terminalWidth) * rows
}

export function scrollAgentGridViewport(
  start: number,
  direction: -1 | 1,
  total: number,
  capacity: number,
  columns: number
): number {
  const visibleRows = Math.max(1, Math.floor(capacity / columns))
  const row = Math.max(0, Math.min(Math.floor(start / columns) + direction, Math.ceil(total / columns) - visibleRows))
  return row * columns
}

export function revealAgentGridSelection(
  selected: number,
  start: number,
  capacity: number,
  total: number,
  columns: number
): number {
  const visibleRows = Math.max(1, Math.floor(capacity / columns))
  const selectedRow = Math.floor(Math.max(0, Math.min(selected, total - 1)) / columns)
  return (
    revealPanelSelection(selectedRow, Math.floor(start / columns), visibleRows, Math.ceil(total / columns)) * columns
  )
}

export function moveAgentGridSelection(
  selected: number,
  key: Partial<Key>,
  length: number,
  columns: number,
  pageSize: number
): number | undefined {
  if (length <= 0) {
    return undefined
  }
  const current = Math.max(0, Math.min(selected, length - 1))
  const column = current % columns
  if (key.leftArrow) {
    return column > 0 ? current - 1 : current
  }
  if (key.rightArrow) {
    return column < columns - 1 && current + 1 < length ? current + 1 : current
  }
  if (key.upArrow) {
    return Math.max(0, current - columns)
  }
  if (key.downArrow) {
    return Math.min(length - 1, current + columns)
  }
  return moveSelection(current, key, length, pageSize)
}

export function moveSelection(
  selected: number,
  key: Partial<Key>,
  length: number,
  pageSize: number
): number | undefined {
  if (length <= 0) {
    return undefined
  }
  const current = Math.max(0, Math.min(selected, length - 1))
  if (key.upArrow) {
    return Math.max(0, current - 1)
  }
  if (key.downArrow) {
    return Math.min(length - 1, current + 1)
  }
  if (key.pageUp) {
    return Math.max(0, current - pageSize)
  }
  if (key.pageDown) {
    return Math.min(length - 1, current + pageSize)
  }
  if (key.home) {
    return 0
  }
  if (key.end) {
    return length - 1
  }
  return undefined
}

export function scrollPanelViewport(
  start: number,
  direction: -1 | 1,
  total: number,
  capacity: number,
  step = 1
): number {
  return Math.max(0, Math.min(total - capacity, start + direction * step))
}

export function revealPanelSelection(selected: number, start: number, capacity: number, total: number): number {
  const maximum = Math.max(0, total - capacity)
  const boundedStart = Math.max(0, Math.min(start, maximum))
  const boundedSelection = Math.max(0, Math.min(selected, total - 1))
  if (boundedSelection < boundedStart) {
    return boundedSelection
  }
  if (boundedSelection >= boundedStart + capacity) {
    return Math.min(maximum, boundedSelection - capacity + 1)
  }
  return boundedStart
}

export function scrollTranscript(current: number, direction: -1 | 1, maximum: number, step = 3): number {
  const bounded = Math.max(0, Math.min(current, maximum))
  return Math.max(0, Math.min(maximum, bounded - direction * step))
}

export function scrollDetail(
  current: number,
  direction: -1 | 1,
  maximum: number,
  followTail: boolean,
  step = 3
): number {
  return followTail
    ? scrollTranscript(current, direction, maximum, step)
    : Math.max(0, Math.min(maximum, current + direction * step))
}

export function filterPanelRows(
  rows: readonly ChatPanelRow[],
  query: string,
  filter: string,
  customModel = false
): ChatPanelRow[] {
  const normalized = query.trim().toLowerCase()
  const filtered = rows.filter(
    (row) =>
      (filter === 'all' || row.filter === filter) &&
      (!normalized || `${row.label} ${row.description} ${row.section ?? ''}`.toLowerCase().includes(normalized))
  )
  const customSpecifier = customModelSpecifier(query)
  if (filtered.length === 0 && customModel && customSpecifier) {
    return [{ label: customSpecifier, description: 'Switch to this model ID', value: customSpecifier }]
  }
  return filtered
}

function customModelSpecifier(query: string): string | undefined {
  const trimmed = query.trim()
  if (!trimmed) {
    return undefined
  }
  try {
    const target = resolveModelTarget(trimmed)
    return target.provider === 'bedrock' && !trimmed.startsWith('bedrock/')
      ? `bedrock/${target.modelId}`
      : target.specifier
  } catch {
    return undefined
  }
}

export function cyclePanelFilter(filters: readonly { id: string }[], current: string, direction: number): string {
  if (filters.length === 0) {
    return current
  }
  const index = Math.max(
    0,
    filters.findIndex((filter) => filter.id === current)
  )
  return filters[(index + direction + filters.length) % filters.length]!.id
}

export function cycleModelPanelFocus(
  current: ModelPanelFocus,
  panel: Pick<ChatPanel, 'slider' | 'filters'>,
  direction: number,
  includeCopy = false
): ModelPanelFocus {
  const order: ModelPanelFocus[] = [
    ...(panel.slider && !panel.slider.disabled ? (['effort'] as const) : []),
    'search',
    ...(panel.filters?.length ? (['providers'] as const) : []),
    'models',
    ...(includeCopy ? (['copy'] as const) : []),
  ]
  const currentIndex = Math.max(0, order.indexOf(current))
  return order[(currentIndex + (direction < 0 ? -1 : 1) + order.length) % order.length]!
}

export function panelPageSize(terminalHeight: number): number {
  return Math.max(1, Math.min(10, Math.floor((terminalHeight - 13) / 2)))
}

export function panelRowCapacity(
  kind: ChatPanel['kind'],
  terminalHeight: number,
  terminalWidth = 80,
  rows: readonly ChatPanelRow[] = []
): number {
  if (kind === 'settings') {
    if (rows.length === 0) {
      return Math.max(1, Math.floor((terminalHeight - 10) / 2))
    }
    const heights = rows.map((row) => {
      const { columns, labelWidth } = settingsLayout(Math.min(84, terminalWidth - 4), row.value)
      let labelHeight = 1
      let lineWidth = 0
      for (const word of row.label.split(' ')) {
        if (lineWidth && lineWidth + 1 + word.length > labelWidth) {
          labelHeight++
          lineWidth = 0
        }
        lineWidth += (lineWidth ? 1 : 0) + word.length
      }
      const controlRows = row.control?.kind === 'segmented' ? Math.ceil(row.control.options.length / columns) : 1
      if (row.value === 'frogTheme') {
        const { columns: themeColumns, optionHeight } = settingsThemeLayout(terminalWidth - 4)
        const themeOptions = row.control?.kind === 'segmented' ? row.control.options.length : 1
        return 2 + Math.ceil(themeOptions / themeColumns) * optionHeight
      }
      return 1 + Math.max(labelHeight, controlRows)
    })
    let capacity = Math.max(1, rows.length)
    for (let start = 0; start < rows.length; start++) {
      let height = 0
      for (let index = start; index < rows.length; index++) {
        const row = rows[index]!
        const section = row.section && (index === start || row.section !== rows[index - 1]?.section)
        height += heights[index]! + (section ? (index === start ? 2 : 3) : 0)
        if (height > terminalHeight - 10) {
          capacity = Math.min(capacity, Math.max(1, index - start))
          break
        }
      }
    }
    return capacity
  }
  if (kind === 'permissions') {
    const sections = new Set(rows.map((row) => row.section).filter(Boolean)).size
    return Math.max(1, Math.min(10, terminalHeight - 15 - sections * 2))
  }
  if (kind === 'models') {
    return Math.max(1, Math.min(20, terminalHeight - 13))
  }
  if (['help', 'skills', 'mcp', 'tasks'].includes(kind)) {
    const sections = new Set(rows.map((row) => row.section).filter(Boolean)).size
    return Math.max(1, Math.min(12, terminalHeight - 13 - sections))
  }
  return kind === 'voice' || kind === 'sessions' ? Math.max(1, terminalHeight - 10) : panelPageSize(terminalHeight)
}

export function detailPageSize(terminalHeight: number, metadataRows: number): number {
  return Math.max(1, terminalHeight - metadataRows - 14)
}

export function registerElement<K>(elements: Map<K, DOMElement>, key: K, element: DOMElement | null): void {
  if (element) {
    elements.set(key, element)
  } else {
    elements.delete(key)
  }
}

export function panelControlTarget(index: number, value: string): string {
  return `${index}:${encodeURIComponent(value)}`
}

export function parsePanelControlTarget(target: string): { index: number; value: string } | undefined {
  const separator = target.indexOf(':')
  if (separator < 1) {
    return undefined
  }
  const index = Number(target.slice(0, separator))
  if (!Number.isInteger(index)) {
    return undefined
  }
  return {
    index,
    value: decodeURIComponent(target.slice(separator + 1)),
  }
}

export function elementAtMouse<K>(elements: ReadonlyMap<K, DOMElement>, mouse: MouseInput): K | undefined {
  for (const [key, element] of elements) {
    if (elementContainsMouse(element, mouse)) {
      return key
    }
  }
  return undefined
}

export function elementContainsMouse(element: DOMElement, mouse: MouseInput): boolean {
  const bounds = elementBounds(element)
  if (!bounds) {
    return false
  }
  const column = mouse.column - 1
  const row = mouse.row - 1
  return (
    column >= bounds.left &&
    column < bounds.left + bounds.width &&
    row >= bounds.top &&
    row < bounds.top + bounds.height
  )
}

function elementBounds(element: DOMElement): { left: number; top: number; width: number; height: number } | undefined {
  let current = element
  let left = 0
  let top = 0
  while (current.parentNode) {
    if (!current.yogaNode) {
      return undefined
    }
    left += current.yogaNode.getComputedLeft()
    top += current.yogaNode.getComputedTop()
    current = current.parentNode
  }
  if (!element.yogaNode) {
    return undefined
  }
  return {
    left,
    top,
    width: element.yogaNode.getComputedWidth(),
    height: element.yogaNode.getComputedHeight(),
  }
}

export function adjacentSliderOption(
  slider: ChatPanelSlider,
  direction: -1 | 1
): ChatPanelSlider['options'][number] | undefined {
  if (slider.disabled || slider.options.length <= 1) {
    return undefined
  }
  const active = Math.max(
    0,
    slider.options.findIndex((option) => option.active)
  )
  const index = Math.max(0, Math.min(slider.options.length - 1, active + direction))
  return index === active ? undefined : slider.options[index]
}

export function sliderOptionAtMouse(
  slider: ChatPanelSlider,
  element: DOMElement,
  mouse: MouseInput
): ChatPanelSlider['options'][number] | undefined {
  const bounds = elementBounds(element)
  if (!bounds || slider.disabled || slider.options.length <= 1) {
    return undefined
  }
  const offset = Math.max(0, Math.min(bounds.width - 1, mouse.column - 1 - bounds.left))
  const index = Math.round((offset / Math.max(1, bounds.width - 1)) * (slider.options.length - 1))
  return slider.options[index]
}

export function mouseScrollDirection(mouse: MouseInput): -1 | 1 | undefined {
  if (mouse.action !== 'press' || (mouse.button & 64) === 0) {
    return undefined
  }
  const wheelButton = mouse.button & 3
  return wheelButton === 0 ? -1 : wheelButton === 1 ? 1 : undefined
}

export function shouldToggleVoiceMute(
  character: string,
  key: Partial<Key>,
  editorInput: string,
  voiceStatus: NonNullable<ChatSnapshot['voice']>['status'] | undefined
): boolean {
  return (
    character === ' ' &&
    !key.ctrl &&
    !key.meta &&
    !key.super &&
    !key.shift &&
    editorInput.length === 0 &&
    voiceStatus !== undefined &&
    voiceStatus !== 'off' &&
    voiceStatus !== 'error'
  )
}

export async function activateMetadataTarget(
  controller: Pick<ChatControllerApi, 'openContextPanel' | 'openModelPanel'>,
  target: MetadataTarget
): Promise<void> {
  if (target === 'cwd') {
    return
  }
  if (target === 'model') {
    await controller.openModelPanel()
  } else {
    controller.openContextPanel()
  }
}
