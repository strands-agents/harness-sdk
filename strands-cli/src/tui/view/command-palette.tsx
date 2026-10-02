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
  width,
  capacity,
  onRowElement,
}: {
  commands: readonly LocalCommandSpec[]
  assistance: CommandAssistance
  selected: number
  pressed?: number
  hovered?: number
  width: number
  capacity: number
  onRowElement?: (index: number, element: DOMElement | null) => void
}): ReactElement {
  const theme = useTheme()
  const start = Math.max(0, Math.min(selected - capacity + 1, commands.length - capacity))
  const usageWidth = Math.max(
    1,
    Math.min(Math.max(0, ...commands.map((command) => stringWidth(command.usage))) + 2, Math.floor((width - 3) / 2))
  )
  return (
    <Box
      width={width}
      borderStyle="single"
      borderColor={theme.accent}
      flexDirection="column"
      flexShrink={0}
      overflow="hidden"
    >
      {assistance.message ? (
        <Box height={1} paddingX={1} flexShrink={0}>
          <Text dimColor wrap="truncate-end">
            {assistance.message}
          </Text>
        </Box>
      ) : null}
      {assistance.signature ? (
        <Box height={1} paddingX={1} flexShrink={0}>
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
            flexShrink={0}
            paddingX={1}
            backgroundColor={index === hovered || pressedRow ? theme.selection : undefined}
          >
            <Box width={usageWidth} marginRight={1} flexShrink={0} overflow="hidden">
              <PanelItemHeader label={command.usage} active={index === selected} pressed={pressedRow} clickable />
            </Box>
            <Text dimColor wrap="truncate-end">
              {command.description}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
