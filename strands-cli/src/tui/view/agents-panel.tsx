import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'

import type { ChatPanelRow } from '../chat/controller.js'
import { agentGridLayout } from './agent-grid.js'
import { PanelHelpFooter } from './help-footer.js'
import { badgeColor, type PanelRowsProps } from './panel-components.js'
import { Box, Text, useTheme } from './theme.js'

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
}: PanelRowsProps & { height: number; clipboardNotice?: string }): ReactElement {
  const { accent } = useTheme()
  const layout = agentGridLayout(width, height)
  const activeIndex = Math.max(0, Math.min(selected, panel.rows.length - 1))
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
          {panel.title}
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
                return (
                  <Box key={`${panel.id}-${index}`} marginLeft={column > 0 ? layout.columnGap : 0} flexShrink={0}>
                    <AgentCard
                      row={row}
                      width={layout.cardWidth}
                      height={layout.cardHeight}
                      selected={index === activeIndex}
                      highlighted={index === activeIndex || index === pressedRow || index === hoveredRow}
                      onElement={(element) => onRowElement?.(index, element)}
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
}: {
  row: ChatPanelRow
  width: number
  height: number
  selected: boolean
  highlighted: boolean
  onElement: (element: DOMElement | null) => void
}): ReactElement {
  const { accent, border } = useTheme()
  const contentWidth = Math.max(1, width - 4)
  const role = row.current ? 'Current' : row.value !== undefined ? 'Chat' : row.badge ? 'Delegate' : undefined
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
        <Text
          {...(highlighted || row.current ? { color: accent } : {})}
          bold={selected || row.bold === true}
          wrap="truncate-end"
        >
          {row.label}
        </Text>
      </Box>
      {descriptionRows > 0 && row.description ? (
        <Box height={descriptionRows} flexShrink={0} overflow="hidden" justifyContent="center">
          <Text dimColor wrap={descriptionRows === 1 ? 'truncate-end' : 'wrap'}>
            {row.description}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
