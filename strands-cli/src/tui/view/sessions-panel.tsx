import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'

import type { ChatSessionsPanel } from '../chat/controller.js'
import { sectionedPanelSidebarWidth, type ModelPanelFocus } from './interaction.js'
import { PanelItemHeader, PanelSearchHeader, type PanelRowsProps } from './panel-components.js'
import { PanelSection, PanelSectionList } from './panel-sections.js'
import { Box, Text, useTheme } from './theme.js'
import { useSpinner } from './use-spinner.js'

interface SessionColumnWidths {
  label: number
  directory: number
  messages: number
  time: number
}

const SESSION_COLUMN_GAP = 2
const SESSION_LABEL_MIN_WIDTH = 16
const SESSION_LABEL_MAX_WIDTH = 40
const SESSION_DIRECTORY_MAX_WIDTH = 20
const SESSION_COLUMN_GAPS = SESSION_COLUMN_GAP * 3

function sessionColumnWidths(width: number, rows: PanelRowsProps['rows']): SessionColumnWidths {
  const contentWidth = Math.max(4, width - SESSION_COLUMN_GAPS)
  const messages = contentWidth >= 50 ? 10 : Math.max(1, Math.min(4, Math.floor(contentWidth / 4)))
  const timestampWidth = Math.max(4, ...rows.map((row) => stringWidth(row.columns?.[2] ?? '')))
  const time =
    contentWidth >= 30
      ? Math.min(timestampWidth, contentWidth - messages - 2)
      : Math.max(1, Math.min(4, contentWidth - messages - 2))
  const remaining = Math.max(2, contentWidth - messages - time)
  const directory = Math.max(
    1,
    Math.min(SESSION_DIRECTORY_MAX_WIDTH, Math.floor(remaining * 0.4), Math.max(3, remaining - SESSION_LABEL_MIN_WIDTH))
  )
  return {
    label: Math.max(1, Math.min(SESSION_LABEL_MAX_WIDTH, remaining - directory)),
    directory,
    messages,
    time,
  }
}

export function SessionsPanel({
  panel,
  rows,
  allRows,
  selected,
  start,
  width,
  height,
  query,
  filter,
  focus,
  animate,
  pressedFilter,
  hoveredFilter,
  pressedRow,
  hoveredRow,
  onRowElement,
  onFilterElement,
  onSearchElement,
}: Omit<PanelRowsProps, 'panel' | 'onPanelElement'> & {
  panel: ChatSessionsPanel
  allRows: PanelRowsProps['rows']
  height: number
  query: string
  filter: string
  focus: ModelPanelFocus
  animate: boolean
  pressedFilter?: string
  hoveredFilter?: string
  onFilterElement?: (id: string, element: DOMElement | null) => void
  onSearchElement?: (element: DOMElement | null) => void
}): ReactElement {
  const { accent, selection } = useTheme()
  const spinner = useSpinner(panel.loading === true, animate)
  if (panel.loading) {
    return (
      <Box flexGrow={1} height={height} alignItems="center" justifyContent="center">
        <Text color={accent}>{spinner} </Text>
        <Text dimColor>Loading sessions</Text>
      </Box>
    )
  }
  const sidebarWidth = sectionedPanelSidebarWidth(width)
  const tableWidth = Math.max(1, width - sidebarWidth - 4)
  const columnWidths = sessionColumnWidths(tableWidth, panel.rows)
  const total = `${panel.rows.length}`
  const meta = query || filter !== 'all' ? `${allRows.length} / ${total}` : total
  return (
    <Box flexGrow={1} height={height} overflow="hidden">
      <PanelSectionList
        title="Directories"
        items={panel.filters ?? []}
        selected={filter}
        focused={focus === 'providers'}
        width={sidebarWidth}
        height={height}
        {...(pressedFilter ? { pressed: pressedFilter } : {})}
        {...(hoveredFilter ? { hovered: hoveredFilter } : {})}
        {...(onFilterElement ? { onElement: onFilterElement } : {})}
      />
      <PanelSection focused={focus !== 'providers'} meta={meta} header={<Text dimColor>Sessions</Text>}>
        <PanelSearchHeader
          query={query}
          placeholder="Search sessions"
          focused={focus === 'search'}
          paddingX={1}
          {...(onSearchElement ? { onElement: onSearchElement } : {})}
        />
        <Box paddingX={1}>
          <Box width={columnWidths.label} flexShrink={0} />
          <SessionColumns
            widths={columnWidths}
            values={['dir', columnWidths.messages >= 10 ? '# messages' : 'msgs', 'time']}
          />
        </Box>
        {rows.length === 0 ? (
          <Box paddingX={1}>
            <Text dimColor>{panel.rows.length === 0 ? 'No saved sessions' : 'No matching sessions'}</Text>
          </Box>
        ) : (
          rows.map((row, visibleIndex) => {
            const index = start + visibleIndex
            const selectedRow = index === selected
            const rowPressed = index === pressedRow
            return (
              <Box
                key={`${panel.id}-${index}`}
                ref={(element) => onRowElement?.(index, element)}
                paddingX={1}
                height={1}
                backgroundColor={index === hoveredRow || rowPressed ? selection : undefined}
              >
                <Box width={columnWidths.label} flexShrink={0}>
                  <PanelItemHeader
                    label={row.label}
                    active={focus === 'models' && selectedRow}
                    pressed={rowPressed}
                    clickable={row.value !== undefined}
                    bold={row.current === true}
                  />
                </Box>
                <SessionColumns widths={columnWidths} values={row.columns ?? ['', '', '']} />
              </Box>
            )
          })
        )}
      </PanelSection>
    </Box>
  )
}

function SessionColumns({ widths, values }: { widths: SessionColumnWidths; values: readonly string[] }): ReactElement {
  const columns = [
    [widths.directory, values[0] ?? ''],
    [widths.messages, values[1] ?? ''],
    [widths.time, values[2] ?? ''],
  ] as const
  return (
    <>
      {columns.map(([width, value], index) => (
        <Box key={index} flexShrink={0}>
          <Box width={SESSION_COLUMN_GAP} flexShrink={0} />
          <Box width={width} flexShrink={0}>
            <Text dimColor wrap="truncate-end">
              {value}
            </Text>
          </Box>
        </Box>
      ))}
    </>
  )
}
