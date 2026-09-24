import type { ReactElement } from 'react'

import { PanelOverlay, PanelTitle, type PanelRowsProps } from './panel-components.js'
import { Box, Text, useTheme } from './theme.js'

export function AgentsPanel({
  panel,
  rows,
  selected,
  start,
  width,
  height,
  columns,
  pressedRow,
  hoveredRow,
  onPanelElement,
  onRowElement,
}: PanelRowsProps & {
  height: number
  columns: number
}): ReactElement {
  const { surface, hover, warning, selection, accent } = useTheme()
  const activeIndex = Math.max(0, Math.min(selected, panel.rows.length - 1))
  const gridWidth = Math.max(1, width - 6)
  const tileGap = 1
  const tileWidth = Math.floor((gridWidth - tileGap * (columns - 1)) / columns)
  const compact = height < 14
  return (
    <PanelOverlay width={width} height={height} {...(onPanelElement ? { onElement: onPanelElement } : {})}>
      <Box flexDirection="column" overflow="hidden">
        <Box paddingX={1} justifyContent="space-between">
          <PanelTitle title={panel.title} color={accent} />
          <Text dimColor>
            {activeIndex + 1}/{panel.rows.length}
          </Text>
        </Box>
        <Box paddingX={1} marginTop={compact ? 0 : 1} flexDirection="row" flexWrap="wrap">
          {rows.map((row, visibleIndex) => {
            const index = start + visibleIndex
            const selectedRow = index === activeIndex
            const rowPressed = index === pressedRow
            const clickable = row.value !== undefined
            const column = visibleIndex % columns
            const badgeColor = row.badge?.tone === 'success' ? 'green' : row.badge?.tone === 'danger' ? 'red' : warning
            return (
              <Box
                key={`${panel.id}-${index}`}
                ref={(element) => onRowElement?.(index, element)}
                width={tileWidth}
                height={compact ? 3 : 7}
                marginRight={column < columns - 1 ? tileGap : 0}
                marginBottom={compact ? 0 : 1}
                paddingX={1}
                flexDirection="column"
                backgroundColor={
                  rowPressed ? selection : selectedRow ? accent : index === hoveredRow ? selection : surface
                }
              >
                {!compact ? (
                  <Box justifyContent="space-between">
                    <Text>
                      <Text color={badgeColor}>●</Text>
                      <Text dimColor> {row.badge?.text ?? ''}</Text>
                    </Text>
                    <Text
                      {...(selectedRow ? { color: surface } : row.current ? { color: accent } : {})}
                      dimColor={!row.current}
                    >
                      {row.current ? 'CURRENT' : clickable ? 'CHAT' : 'DELEGATE'}
                    </Text>
                  </Box>
                ) : null}
                <Box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column" overflow="hidden">
                  {!compact ? (
                    <Text {...(selectedRow ? { color: surface } : row.current ? { color: accent } : {})}>◆</Text>
                  ) : null}
                  <Text
                    {...(rowPressed ? { color: hover } : selectedRow ? { color: surface } : {})}
                    {...(row.bold !== undefined ? { bold: row.bold } : {})}
                    wrap="truncate-end"
                  >
                    {row.label}
                  </Text>
                </Box>
                {!compact ? (
                  <Text
                    {...(selectedRow || rowPressed ? { color: surface } : {})}
                    dimColor={!selectedRow && !rowPressed}
                    wrap="truncate-end"
                  >
                    {row.description}
                  </Text>
                ) : null}
              </Box>
            )
          })}
        </Box>
      </Box>
    </PanelOverlay>
  )
}
