import type { ReactElement } from 'react'

import { PanelHelpFooter } from './help-footer.js'
import { badgeColor, type PanelRowsProps } from './panel-components.js'
import { Cursor } from './text-input.js'
import { Box, Text, useTheme } from './theme.js'

export function ExportPanel({
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
  query,
}: PanelRowsProps & { height: number; query: string }): ReactElement {
  const { accent, selection } = useTheme()
  const nameInput = panel.kind === 'export' ? panel.nameInput : undefined
  return (
    <Box ref={onPanelElement} width={width} height={height} flexDirection="column" overflow="hidden">
      <Box
        height={2}
        flexShrink={0}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        overflow="hidden"
      >
        <Text color={accent} bold wrap="truncate-end">
          {panel.title}
        </Text>
        {panel.body ? (
          <Text dimColor wrap="truncate-middle">
            {panel.body}
          </Text>
        ) : null}
      </Box>
      <Box flexGrow={1} overflow="hidden">
        {nameInput ? (
          <Box flexGrow={1} alignItems="center" justifyContent="center" paddingX={2}>
            <Box
              width={Math.min(48, Math.max(12, width - 8))}
              borderStyle="single"
              borderColor={accent}
              paddingX={1}
              overflow="hidden"
            >
              <Text {...(query ? {} : { dimColor: true })} wrap="truncate-start">
                {query || nameInput.defaultName}
                <Cursor />
              </Text>
            </Box>
          </Box>
        ) : (
          rows.map((row, visibleIndex) => {
            const index = start + visibleIndex
            const active = index === selected
            const pressed = index === pressedRow
            const hovered = index === hoveredRow
            return (
              <Box
                key={`${panel.id}-${index}`}
                ref={(element) => onRowElement?.(index, element)}
                flexBasis={0}
                flexGrow={1}
                flexDirection="column"
                alignItems="center"
                justifyContent="center"
                overflow="hidden"
                borderStyle="single"
                borderColor={active ? accent : undefined}
                borderDimColor={!active}
                backgroundColor={pressed || hovered ? selection : undefined}
                {...(visibleIndex < rows.length - 1 ? { marginRight: 1 } : {})}
              >
                <Text {...(active || pressed ? { color: accent } : {})} bold wrap="truncate-end">
                  {row.label}
                </Text>
                {row.description ? (
                  <Box paddingX={1} justifyContent="center" overflow="hidden">
                    <Text dimColor wrap="truncate-middle">
                      {row.description}
                    </Text>
                  </Box>
                ) : null}
                {row.badge ? <Text color={badgeColor(row.badge.tone)}>{row.badge.text}</Text> : null}
              </Box>
            )
          })
        )}
      </Box>
      <PanelHelpFooter width={width} centered />
    </Box>
  )
}
