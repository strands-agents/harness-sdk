import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'

import type { CommandAssistance, LocalCommandSpec } from '../chat/commands.js'
import { PanelItemHeader } from './panel-components.js'
import { Box, Text, useTheme } from './theme.js'

export function CommandPalette({
  commands,
  assistance,
  selected,
  pressed,
  hovered,
  terminalWidth,
  terminalHeight,
  bottomPadding,
  onRowElement,
}: {
  commands: readonly LocalCommandSpec[]
  assistance: CommandAssistance
  selected: number
  pressed?: number
  hovered?: number
  terminalWidth: number
  terminalHeight: number
  bottomPadding: number
  onRowElement?: (index: number, element: DOMElement | null) => void
}): ReactElement {
  const theme = useTheme()
  const helpRows = Number(assistance.signature !== undefined)
  const capacity = Math.max(1, terminalHeight - bottomPadding - 5 - helpRows)
  const start = Math.max(0, Math.min(selected - capacity + 1, commands.length - capacity))
  const usageWidth = Math.max(0, ...commands.map((command) => stringWidth(command.usage))) + 2
  const width = Math.max(
    1,
    Math.min(
      Math.max(
        44,
        assistance.signature ? stringWidth(assistance.signature) + 4 : 0,
        ...commands.map((command) => usageWidth + stringWidth(command.description) + 4)
      ),
      terminalWidth - 4
    )
  )
  return (
    <Box
      position="absolute"
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="flex-end"
      paddingBottom={bottomPadding}
      paddingLeft={1}
    >
      <Box width={width} backgroundColor={theme.panel} flexDirection="column" overflow="hidden">
        {assistance.signature ? (
          <Box height={1} paddingX={1}>
            <Text dimColor wrap="truncate-end">
              {assistance.signature}
            </Text>
          </Box>
        ) : null}
        {commands.slice(start, start + capacity).map((command, visibleIndex) => {
          const index = start + visibleIndex
          const pressedRow = index === pressed
          return (
            <Box
              key={command.replacement ?? command.name}
              ref={(element) => onRowElement?.(index, element)}
              height={1}
              paddingX={1}
              backgroundColor={index === hovered || pressedRow || index === selected ? theme.selection : undefined}
            >
              <Box width={usageWidth} marginRight={1} flexShrink={0}>
                <PanelItemHeader label={command.usage} active={index === selected} pressed={pressedRow} clickable />
              </Box>
              <Text dimColor wrap="truncate-end">
                {command.description}
              </Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
