import type { DOMElement, Key } from 'ink'

import type {
  ChatControllerApi,
  ChatModelPanel,
  ChatPanel,
  ChatPanelRow,
  ChatPanelSlider,
  ChatSnapshot,
} from '../chat/controller.js'
import { isActiveTask } from '../chat/controller-helpers.js'
import { resolveModelTarget } from '../model/selection.js'
import { COMPOSER_PANEL_HEIGHT, MIN_PROMPT_HEIGHT } from '../terminal/composer.js'
import type { MouseInput } from '../terminal/mouse-input.js'
import { errorPanelLayout } from './error-panel-layout.js'

export type MetadataTarget = 'model' | 'effort' | 'permissions' | 'context' | 'cwd'
export const MAX_VISIBLE_BACKGROUND_TASKS = 4
export const COMPOSER_RESOURCE_PANEL_HEIGHT = COMPOSER_PANEL_HEIGHT + 2
export const COMPOSER_EXPANDED_PANEL_HEIGHT = 16
export const PANEL_SECTION_BORDER_COLUMNS = 2
export const PANEL_SECTION_BORDER_ROWS = 2
export const PANEL_SECTION_PADDING_X = 1
export const PANEL_SECTION_HEADER_HEIGHT = 1
export const PANEL_SECTION_HEADER_GAP = 1
export const PANEL_HELP_FOOTER_HEIGHT = 1
export const PANEL_SEARCH_HEIGHT = 1
export const PANEL_TABLE_HEADER_HEIGHT = 1
export const CONFIG_DOCK_GAP = 2
// Border rows, the language tabs, and the divider under them.
export const CONFIG_DOCK_CHROME_HEIGHT = 4
export const CONFIG_DOCK_MIN_HEIGHT = 8
export const CONFIG_DOCK_MIN_TERMINAL_WIDTH = 90
export const CONFIG_DOCK_EDITOR_ROWS = MIN_PROMPT_HEIGHT + 2
// Rows above the startup lockup; chat and setup share them so the brand sits in the same place.
export const FULL_LOCKUP_TOP_PADDING = 6
export const COMPACT_LOCKUP_TOP_PADDING = 2
const CONFIG_DOCK_MIN_WIDTH = 34
const CONFIG_DOCK_MAX_WIDTH = 52
const CONFIG_DOCK_WIDTH_RATIO = 0.42
const SECTIONED_PANEL_SIDEBAR_DIVISOR = 3
const SECTIONED_PANEL_CHROME_ROWS =
  PANEL_SECTION_BORDER_ROWS + PANEL_SECTION_HEADER_HEIGHT + PANEL_SECTION_HEADER_GAP + PANEL_HELP_FOOTER_HEIGHT
/** Panels that share the plain sectioned layout and its row capacity. */
const SECTIONED_PANEL_KINDS = new Set<ChatPanel['kind']>([
  'help',
  'permission',
  'permissions',
  'tasks',
  'tools',
  'models',
  'settings',
])

export type ModelPanelFocus = 'providers' | 'search' | 'models'
export type SettingsPanelFocus = 'categories' | 'settings'

/** Panels that render inside the prompt editor instead of over the conversation. */
export function isComposerPanel(kind: ChatPanel['kind'] | undefined): boolean {
  return (
    kind === 'help' ||
    kind === 'help-detail' ||
    kind === 'detail' ||
    kind === 'models' ||
    kind === 'effort' ||
    kind === 'settings' ||
    kind === 'voice' ||
    kind === 'context' ||
    kind === 'sessions' ||
    kind === 'export' ||
    kind === 'tools' ||
    kind === 'mcp' ||
    kind === 'skills' ||
    kind === 'tasks' ||
    kind === 'permission' ||
    kind === 'permissions' ||
    kind === 'error'
  )
}

/** Composer panels that use the prompt editor's accent border instead of drawing their own sections. */
export function isOutlinedComposerPanel(panel: ChatPanel | undefined): boolean {
  return (
    panel?.kind === 'effort' ||
    panel?.kind === 'context' ||
    (panel?.kind === 'models' && panel.loading === true) ||
    (panel?.kind === 'sessions' && panel.loading === true)
  )
}

/** Rows above a startup lockup `height` rows tall; the full frog lockup sits lower than the compact wordmarks. */
export function startupLockupTopPadding(fullLockup: boolean, height: number): number {
  return fullLockup ? FULL_LOCKUP_TOP_PADDING : height > 2 ? COMPACT_LOCKUP_TOP_PADDING : 1
}

/** The column that centers a `lockupWidth`-wide startup lockup in `width` columns, shared by chat and setup. */
export function startupLockupLeft(width: number, lockupWidth: number, offset = 0): number {
  return Math.max(0, Math.min(width - lockupWidth, Math.round((width - lockupWidth) / 2 + offset)))
}

export function composerPanelContentHeight(panel: ChatPanel | undefined, height: number): number {
  return Math.max(1, height - (isOutlinedComposerPanel(panel) ? 2 : 0))
}

export function composerPanelHeight(
  snapshot: ChatSnapshot,
  terminalHeight: number,
  party = false,
  terminalWidth = 80
): number {
  const availableHeight = Math.max(party ? 3 : 1, terminalHeight - composerStatusRows(snapshot) - 2)
  if (snapshot.panel?.kind === 'error') {
    return errorPanelLayout(snapshot.panel, Math.max(1, terminalWidth - 2), Math.min(10, availableHeight)).height
  }
  const panelHeight =
    snapshot.panel?.kind === 'voice' ||
    snapshot.panel?.kind === 'permission' ||
    (snapshot.panel?.kind === 'context' && snapshot.context.breakdown)
      ? COMPOSER_EXPANDED_PANEL_HEIGHT
      : isComposerPanel(snapshot.panel?.kind)
        ? COMPOSER_RESOURCE_PANEL_HEIGHT
        : COMPOSER_PANEL_HEIGHT
  return Math.min(availableHeight, panelHeight + (party ? 2 : 0))
}

export function composerStatusRows(snapshot: ChatSnapshot): number {
  const activeBackgroundTasks = snapshot.tasks.filter(
    (task) => task.source === 'background' && isActiveTask(task.status)
  ).length
  return (
    snapshot.pendingSteering.length +
    (snapshot.queuedPrompts.length > 0 || snapshot.status === 'interrupting'
      ? Math.max(1, snapshot.queuedPrompts.length)
      : 0) +
    Number(snapshot.mcpStartup !== undefined) +
    Number(snapshot.voice !== undefined && snapshot.voice.status !== 'off') +
    Math.min(activeBackgroundTasks, MAX_VISIBLE_BACKGROUND_TASKS) +
    Number(activeBackgroundTasks > MAX_VISIBLE_BACKGROUND_TASKS)
  )
}

export function sectionedPanelSidebarWidth(panelWidth: number, preferredWidth = Infinity): number {
  return Math.max(1, Math.min(Math.floor(panelWidth / SECTIONED_PANEL_SIDEBAR_DIVISOR), preferredWidth))
}

export function configurationDockWidth(terminalWidth: number, explicit = false): number {
  const contentWidth = Math.max(1, terminalWidth - 2)
  const splitWidth = Math.min(
    CONFIG_DOCK_MAX_WIDTH,
    Math.max(CONFIG_DOCK_MIN_WIDTH, Math.floor(contentWidth * CONFIG_DOCK_WIDTH_RATIO))
  )
  return explicit && terminalWidth < CONFIG_DOCK_MIN_TERMINAL_WIDTH ? contentWidth : Math.min(contentWidth, splitWidth)
}

export function configurationDockHeight(snapshot: ChatSnapshot, terminalHeight: number, party = false): number {
  return Math.max(1, terminalHeight - composerStatusRows(snapshot) - CONFIG_DOCK_EDITOR_ROWS - (party ? 2 : 0))
}

export function configurationDockCodeSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(1, width - 4),
    height: Math.max(1, height - CONFIG_DOCK_CHROME_HEIGHT),
  }
}

/** The settings row activation for ← or →: the neighboring option, or Off and On for a toggle. */
export function settingArrowValue(row: ChatPanelRow, direction: -1 | 1): string | undefined {
  const { control, value } = row
  if (!value || !control) {
    return undefined
  }
  if (control.kind === 'toggle') {
    return control.checked === direction > 0 ? undefined : value
  }
  const active = Math.max(
    0,
    control.options.findIndex((option) => option.active)
  )
  const option = control.options[active + direction]
  return option ? `${value}=${option.value}` : undefined
}

/** Arrow movement over permission choices: a two-column grid, or linear in the list form. */
export function movePermissionSelection(
  selected: number,
  key: Partial<Key>,
  length: number,
  grid: boolean
): number | undefined {
  if (length <= 0) {
    return undefined
  }
  const current = Math.max(0, Math.min(selected, length - 1))
  if (!grid) {
    if (key.upArrow || key.leftArrow) return Math.max(0, current - 1)
    if (key.downArrow || key.rightArrow) return Math.min(length - 1, current + 1)
    return undefined
  }
  if (key.leftArrow) return current % 2 === 1 ? current - 1 : current
  if (key.rightArrow) return current % 2 === 0 && current + 1 < length ? current + 1 : current
  if (key.upArrow) return current - 2 >= 0 ? current - 2 : current
  if (key.downArrow) return current + 2 < length ? current + 2 : current
  return undefined
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

export function clampViewportStart(start: number, total: number, capacity: number): number {
  return Math.max(0, Math.min(start, total - capacity))
}

/** The window start that keeps the selection on the last visible row without scrolling past the end. */
export function trailingWindowStart(selected: number, capacity: number, total: number): number {
  return Math.max(0, Math.min(selected - capacity + 1, total - capacity))
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
      (!normalized ||
        `${row.label} ${row.description} ${row.badge?.text ?? ''} ${row.columns?.join(' ') ?? ''} ${row.section ?? ''}`
          .toLowerCase()
          .includes(normalized))
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

export function initialPanelFilter(panel: ChatPanel | undefined): string {
  if (panel?.kind === 'help') {
    return 'controls'
  }
  if (panel?.kind === 'settings' && panel.settingsCategory) {
    return `settings:${panel.settingsCategory}`
  }
  if (panel?.kind === 'models') {
    const current = panel.rows.find((row) => row.badge?.text === 'current')?.filter
    if (current && panel.filters?.some((filter) => filter.id === current)) {
      return current
    }
  }
  if (panel?.kind === 'config') {
    return panel.language
  }
  return 'all'
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

/** Tab order between the `/model` provider and model sections. */
export function cycleModelPanelFocus(
  current: ModelPanelFocus,
  panel: ChatModelPanel,
  direction: number
): ModelPanelFocus {
  const sections: ModelPanelFocus[] = [...(panel.filters?.length ? (['providers'] as const) : []), 'models']
  const section = current === 'search' ? 'models' : current
  const index = Math.max(0, sections.indexOf(section))
  return sections[(index + (direction < 0 ? -1 : 1) + sections.length) % sections.length]!
}

export function cycleMultiColumnPanelSelection(
  kind: ChatPanel['kind'],
  rows: readonly ChatPanelRow[],
  selected: number,
  direction: number
): number | undefined {
  const columns = multiColumnPanelRows(kind, rows)
  if (columns.length < 2) {
    return undefined
  }
  const columnIndex = Math.max(
    0,
    columns.findIndex((column) => column.includes(selected))
  )
  const column = columns[columnIndex]!
  const rowIndex = Math.max(0, column.indexOf(selected))
  const nextColumn = columns[(columnIndex + (direction < 0 ? -1 : 1) + columns.length) % columns.length]!
  return nextColumn[Math.min(rowIndex, nextColumn.length - 1)]
}

export function moveMultiColumnPanelSelection(
  kind: ChatPanel['kind'],
  rows: readonly ChatPanelRow[],
  selected: number,
  key: Partial<Key>,
  pageSize: number
): number | undefined {
  const column = multiColumnPanelRows(kind, rows).find((candidate) => candidate.includes(selected))
  if (!column) {
    return undefined
  }
  const next = moveSelection(Math.max(0, column.indexOf(selected)), key, column.length, pageSize)
  return next === undefined ? undefined : column[next]
}

function multiColumnPanelRows(kind: ChatPanel['kind'], rows: readonly ChatPanelRow[]): number[][] {
  if (kind === 'voice') {
    const controls: number[] = []
    const speakers: number[] = []
    rows.forEach((row, index) => {
      if (row.value) {
        const column = row.section === 'Voice' || row.section === 'Model' ? speakers : controls
        column.push(index)
      }
    })
    return [controls, speakers].filter((column) => column.length > 0)
  }
  return kind === 'export' ? rows.map((_, index) => [index]) : []
}

export function panelPageSize(terminalHeight: number): number {
  return Math.max(1, Math.min(10, Math.floor((terminalHeight - 13) / 2)))
}

export interface PermissionPanelLayout {
  wide: boolean
  bodyHeight: number
  /** Bordered two-column buttons, with a compact list for very small terminals. */
  optionGrid: boolean
  /** The request details: the larger right section when wide, above the choices otherwise. */
  previewWidth: number
  previewTextWidth: number
  previewHeight: number
  /** Rows under the choices for the selected choice's description, including a spacer. */
  descriptionHeight: number
  optionsWidth: number
  optionCapacity: number
}

const PERMISSION_WIDE_MIN_WIDTH = 84

export function permissionPanelLayout(width: number, height: number, optionRows: number): PermissionPanelLayout {
  const bodyHeight = Math.max(1, height - SECTIONED_PANEL_CHROME_ROWS)
  const wide = width >= PERMISSION_WIDE_MIN_WIDTH
  const contentWidth = Math.max(1, width - PANEL_SECTION_BORDER_COLUMNS)
  const optionsWidth = wide ? Math.min(48, Math.max(40, Math.floor(width / 3))) : contentWidth
  const previewWidth = wide ? Math.max(1, width - optionsWidth) : contentWidth
  const optionsHeight = wide ? bodyHeight : Math.max(1, bodyHeight - 3)
  const optionGrid = optionsWidth >= 36 && optionsHeight >= 3
  const columns = optionGrid ? 2 : 1
  const optionHeight = optionGrid ? 3 : 1
  const optionCapacity = Math.max(1, Math.floor(optionsHeight / optionHeight) * columns)
  const visibleOptions = Math.min(optionRows, optionCapacity)
  const choicesHeight = Math.ceil(visibleOptions / columns) * optionHeight
  const descriptionHeight = Math.max(0, Math.min(wide ? 2 : 1, optionsHeight - choicesHeight))
  return {
    wide,
    bodyHeight,
    optionGrid,
    previewWidth,
    previewTextWidth: Math.max(
      1,
      previewWidth - (wide ? PANEL_SECTION_BORDER_COLUMNS : 0) - PANEL_SECTION_PADDING_X * 2
    ),
    previewHeight: wide ? bodyHeight : Math.max(1, bodyHeight - choicesHeight - descriptionHeight),
    descriptionHeight,
    optionsWidth,
    optionCapacity,
  }
}

export function permissionPreviewCapacity(lineCount: number, height: number): number {
  return Math.max(1, height - Number(lineCount > height && height > 1))
}

export function panelRowCapacity(kind: ChatPanel['kind'], terminalHeight: number): number {
  if (SECTIONED_PANEL_KINDS.has(kind)) {
    return Math.max(1, terminalHeight - SECTIONED_PANEL_CHROME_ROWS)
  }
  if (kind === 'voice') {
    return Math.max(1, (terminalHeight - SECTIONED_PANEL_CHROME_ROWS) * 2)
  }
  if (kind === 'sessions') {
    return Math.max(1, terminalHeight - SECTIONED_PANEL_CHROME_ROWS - PANEL_SEARCH_HEIGHT - PANEL_TABLE_HEADER_HEIGHT)
  }
  if (kind === 'skills' || kind === 'mcp') {
    return Math.max(1, terminalHeight - SECTIONED_PANEL_CHROME_ROWS - PANEL_SEARCH_HEIGHT)
  }
  if (kind === 'export') {
    return 2
  }
  return panelPageSize(terminalHeight)
}

export function detailPageSize(height: number): number {
  return Math.max(1, height - SECTIONED_PANEL_CHROME_ROWS)
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
  controller: Pick<ChatControllerApi, 'openContextPanel' | 'openModelPanel' | 'submit'>,
  target: MetadataTarget
): Promise<void> {
  if (target === 'cwd') {
    return
  }
  if (target === 'model') {
    await controller.openModelPanel()
  } else if (target === 'effort') {
    await controller.submit('/effort')
  } else if (target === 'permissions') {
    await controller.submit('/permissions')
  } else {
    controller.openContextPanel()
  }
}
