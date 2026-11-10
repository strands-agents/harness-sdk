import { type Key, type DOMElement } from 'ink'
import { moveSelection, panelControlTarget, revealPanelSelection } from '../interaction.js'
import { type ReactElement } from 'react'
import stringWidth from 'string-width'
import { type ChatPanelRow } from '../chat/controller.js'
import type { EditorState } from '../../terminal/composer.js'
import { PanelHelpFooter } from '../footer.js'
import { EditableText } from '../text-input.js'
import { badgeColor, type PanelRowsProps } from './shared.js'
import { Box, Text, useTheme } from '../theme.js'

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

export function AgentsPanel({
  panel,
  rows,
  selected,
  start,
  width,
  height,
  pressedRow,
  hoveredRow,
  onPanelElement,
  onRowElement,
  clipboardNotice,
  nameEditor,
  pressedControl,
  hoveredControl,
  onControlElement,
}: PanelRowsProps & {
  height: number
  clipboardNotice?: string
  nameEditor?: Pick<EditorState, 'input' | 'cursor'>
  pressedControl?: string
  hoveredControl?: string
  onControlElement?: (target: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent } = useTheme()
  const layout = agentGridLayout(width, height)
  const activeIndex = Math.max(0, Math.min(selected, panel.rows.length - 1))
  const nameInput = panel.kind === 'agents' ? panel.renameInput : undefined
  return (
    <Box
      ref={onPanelElement}
      width={width}
      height={height}
      flexShrink={0}
      paddingX={1}
      flexDirection="column"
      overflow="hidden"
    >
      <Box height={1} flexShrink={0} marginBottom={1} justifyContent="space-between">
        <Text color={accent} bold wrap="truncate-end">
          {nameInput ? 'Rename agent' : panel.title}
        </Text>
        <Box marginLeft={1} flexShrink={0}>
          <Text dimColor>
            {panel.rows.length === 0 ? 0 : activeIndex + 1}/{panel.rows.length}
          </Text>
        </Box>
      </Box>
      <Box height={layout.gridHeight} flexShrink={0} flexDirection="column" overflow="hidden">
        {rows.length === 0 ? (
          <Text dimColor>No agents</Text>
        ) : (
          Array.from({ length: Math.ceil(rows.length / layout.columns) }, (_, gridRow) => (
            <Box
              key={`${panel.id}-row-${gridRow}`}
              height={layout.cardHeight}
              flexShrink={0}
              marginTop={gridRow > 0 ? layout.rowGap : 0}
            >
              {rows.slice(gridRow * layout.columns, (gridRow + 1) * layout.columns).map((row, column) => {
                const index = start + gridRow * layout.columns + column
                const editing = row.value === `conversation:${encodeURIComponent(nameInput?.id ?? '')}`
                return (
                  <Box key={`${panel.id}-${index}`} marginLeft={column > 0 ? layout.columnGap : 0} flexShrink={0}>
                    <AgentCard
                      row={row}
                      width={layout.cardWidth}
                      height={layout.cardHeight}
                      selected={index === activeIndex}
                      highlighted={index === activeIndex || index === pressedRow || index === hoveredRow}
                      onElement={(element) => onRowElement?.(index, element)}
                      {...(editing && nameEditor ? { nameEditor } : {})}
                      actions={
                        editing
                          ? ['rename:save', 'rename:cancel']
                          : !nameInput && row.value?.startsWith('conversation:')
                            ? ['rename']
                            : []
                      }
                      {...(pressedControl ? { pressedControl } : {})}
                      {...(hoveredControl ? { hoveredControl } : {})}
                      index={index}
                      {...(onControlElement ? { onControlElement } : {})}
                    />
                  </Box>
                )
              })}
            </Box>
          ))
        )}
      </Box>
      <Box height={1} flexShrink={0} marginTop={1}>
        {clipboardNotice ? (
          <Text dimColor wrap="truncate-end">
            {clipboardNotice}
          </Text>
        ) : (
          <PanelHelpFooter width={layout.contentWidth} />
        )}
      </Box>
    </Box>
  )
}

function AgentCard({
  row,
  width,
  height,
  selected,
  highlighted,
  onElement,
  nameEditor,
  actions,
  pressedControl,
  hoveredControl,
  index,
  onControlElement,
}: {
  row: ChatPanelRow
  width: number
  height: number
  selected: boolean
  highlighted: boolean
  onElement: (element: DOMElement | null) => void
  nameEditor?: Pick<EditorState, 'input' | 'cursor'>
  actions: readonly string[]
  pressedControl?: string
  hoveredControl?: string
  index: number
  onControlElement?: (target: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent, border } = useTheme()
  const contentWidth = Math.max(1, width - 4)
  const role = row.current
    ? 'Current'
    : row.value?.startsWith('conversation:')
      ? 'Chat'
      : row.badge
        ? 'Delegate'
        : undefined
  const statusWidth = row.badge ? stringWidth(row.badge.text) + 2 : 0
  const showRole = role && contentWidth >= stringWidth(role) + statusWidth + 1
  const descriptionRows = height >= 9 ? 2 : height >= 5 ? 1 : 0
  return (
    <Box
      ref={onElement}
      width={width}
      height={height}
      flexShrink={0}
      paddingX={1}
      flexDirection="column"
      borderStyle="single"
      borderColor={selected ? accent : border}
      overflow="hidden"
    >
      {row.badge || showRole ? (
        <Box height={1} flexShrink={0} justifyContent="space-between">
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            {row.badge ? (
              <Text wrap="truncate-end">
                <Text color={badgeColor(row.badge.tone)}>●</Text>
                <Text dimColor> {row.badge.text}</Text>
              </Text>
            ) : null}
          </Box>
          {showRole ? (
            <Box marginLeft={1} flexShrink={0}>
              <Text {...(row.current ? { color: accent } : { dimColor: true })}>{role}</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" overflow="hidden">
        {nameEditor ? (
          <EditableText value={nameEditor.input} cursor={nameEditor.cursor} width={contentWidth} active />
        ) : (
          <Text
            {...(highlighted || row.current ? { color: accent } : {})}
            bold={selected || row.bold === true}
            wrap="truncate-end"
          >
            {row.label}
          </Text>
        )}
      </Box>
      {descriptionRows > 0 && row.description ? (
        <Box height={descriptionRows} flexShrink={0} overflow="hidden" justifyContent="center">
          <Text dimColor wrap={descriptionRows === 1 ? 'truncate-end' : 'wrap'}>
            {row.description}
          </Text>
        </Box>
      ) : null}
      {actions.length > 0 ? (
        <Box flexShrink={0} justifyContent="center" gap={1}>
          {actions.map((action) => {
            const target = panelControlTarget(index, action)
            const active = target === pressedControl || target === hoveredControl
            return (
              <Box
                key={action}
                ref={(element) => onControlElement?.(target, element)}
                borderStyle={height >= 8 ? 'single' : undefined}
                borderColor={active ? accent : border}
                paddingX={1}
              >
                <Text {...(active ? { color: accent } : {})}>
                  {action === 'rename:save' ? 'Save' : action === 'rename:cancel' ? 'Cancel' : 'Rename'}
                </Text>
              </Box>
            )
          })}
        </Box>
      ) : null}
    </Box>
  )
}
