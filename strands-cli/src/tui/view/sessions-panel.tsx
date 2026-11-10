import type { ReactElement } from 'react'

import { PanelItemHeader, PanelOverlay, PanelTitle, type PanelRowsProps } from './panel-components.js'
import { BlinkingCursor } from './text-input.js'
import { Box, Text, useTheme } from './theme.js'

export function SessionsPanel({
  panel,
  rows,
  allRows,
  selected,
  start,
  width,
  query,
  animateCursor,
  pressedRow,
  hoveredRow,
  onPanelElement,
  onRowElement,
}: PanelRowsProps & {
  allRows: PanelRowsProps['rows']
  query: string
  animateCursor: boolean
}): ReactElement {
  const { selection, accent } = useTheme()
  const labelWidth = Math.max(22, Math.floor(width * 0.38))
  return (
    <PanelOverlay width={width} {...(onPanelElement ? { onElement: onPanelElement } : {})}>
      <Box flexDirection="column" overflow="hidden">
        <Box paddingX={1} justifyContent="space-between">
          <PanelTitle title={panel.title} color={accent} />
          <Text dimColor>
            {allRows.length === 0 ? '0' : `${Math.min(selected + 1, allRows.length)}/${allRows.length}`}
          </Text>
        </Box>
        <Box paddingX={1}>
          <Text dimColor>Search: </Text>
          <Text>
            {query}
            <BlinkingCursor animate={animateCursor} />
          </Text>
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
                backgroundColor={index === hoveredRow || rowPressed || selectedRow ? selection : undefined}
              >
                <Box width={labelWidth} flexShrink={0}>
                  <PanelItemHeader
                    label={row.label}
                    active={selectedRow}
                    pressed={rowPressed}
                    clickable={row.value !== undefined}
                    bold={row.current === true}
                  />
                </Box>
                <Text dimColor wrap="truncate-end">
                  {row.description}
                </Text>
              </Box>
            )
          })
        )}
      </Box>
    </PanelOverlay>
  )
}
