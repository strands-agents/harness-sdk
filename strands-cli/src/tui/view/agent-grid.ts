import type { Key } from 'ink'

import { moveSelection, revealPanelSelection } from './interaction.js'

export interface AgentGridLayout {
  contentWidth: number
  gridHeight: number
  columns: number
  cardWidth: number
  cardHeight: number
  visibleRows: number
  capacity: number
  columnGap: number
  rowGap: number
}

export function agentGridLayout(width: number, height: number): AgentGridLayout {
  const contentWidth = Math.max(1, width - 2)
  const gridHeight = Math.max(1, height - 4)
  const columnGap = 2
  const rowGap = 1
  const columns = Math.max(1, Math.floor((contentWidth + columnGap) / 30))
  const cardWidth = Math.min(32, Math.floor((contentWidth - columnGap * (columns - 1)) / columns))
  const cardHeight = Math.min(gridHeight, Math.ceil(cardWidth / 2))
  const visibleRows = Math.max(1, Math.floor((gridHeight + rowGap) / (cardHeight + rowGap)))
  return {
    contentWidth,
    gridHeight,
    columns,
    cardWidth,
    cardHeight,
    visibleRows,
    capacity: columns * visibleRows,
    columnGap,
    rowGap,
  }
}

export function clampAgentGridViewport(start: number, total: number, capacity: number, columns: number): number {
  const visibleRows = Math.max(1, Math.floor(capacity / columns))
  const maximumRow = Math.max(0, Math.ceil(total / columns) - visibleRows)
  return Math.max(0, Math.min(Math.floor(start / columns), maximumRow)) * columns
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

export function scrollAgentGridViewport(
  start: number,
  direction: -1 | 1,
  total: number,
  capacity: number,
  columns: number
): number {
  return clampAgentGridViewport(start + direction * columns, total, capacity, columns)
}

export function moveAgentGridSelection(
  selected: number,
  key: Partial<Key>,
  length: number,
  columns: number,
  pageSize: number
): number | undefined {
  if (length <= 0) return undefined
  const current = Math.max(0, Math.min(selected, length - 1))
  const column = current % columns
  if (key.leftArrow) return column > 0 ? current - 1 : current
  if (key.rightArrow) return column < columns - 1 && current + 1 < length ? current + 1 : current
  if (key.upArrow) return current >= columns ? current - columns : current
  if (key.downArrow) {
    return Math.floor(current / columns) < Math.floor((length - 1) / columns)
      ? Math.min(length - 1, current + columns)
      : current
  }
  return moveSelection(current, key, length, pageSize)
}
