import type { ReactElement } from 'react'

import { PanelOverlay, PanelTitle, type PanelRowsProps } from './panel-components.js'
import { Box, Text, useTheme } from './theme.js'

export function ExportPanel({
  panel,
  rows,
  selected,
  start,
  width,
  pressedRow,
  hoveredRow,
  onPanelElement,
  onRowElement,
}: PanelRowsProps): ReactElement {
  const { hover, selection, accent, surface, foreground } = useTheme()
  return (
    <PanelOverlay width={width} {...(onPanelElement ? { onElement: onPanelElement } : {})}>
      <Box paddingX={1} flexDirection="column">
        <PanelTitle title={panel.title} color={accent} />
        {panel.body?.split('\n').map((line, index) => (
          <Text key={index} dimColor wrap="truncate-middle">
            {line}
          </Text>
        ))}
        <Box marginTop={1} flexDirection="column">
          {rows.map((row, visibleIndex) => {
            const index = start + visibleIndex
            const active = index === selected
            const pressed = index === pressedRow
            const hovered = index === hoveredRow
            return (
              <Box
                key={`${panel.id}-${index}`}
                ref={(element) => onRowElement?.(index, element)}
                height={4}
                marginBottom={visibleIndex < rows.length - 1 ? 1 : 0}
                alignItems="center"
                justifyContent="center"
                flexDirection="column"
                backgroundColor={hovered ? selection : active ? accent : pressed ? selection : surface}
              >
                <Text bold color={pressed ? hover : hovered ? accent : active ? surface : foreground}>
                  {row.label}
                </Text>
                <Text
                  {...(hovered ? { color: foreground } : active ? { color: surface } : {})}
                  dimColor={!active && !hovered}
                  wrap="truncate-middle"
                >
                  {row.description}
                </Text>
              </Box>
            )
          })}
        </Box>
      </Box>
    </PanelOverlay>
  )
}
