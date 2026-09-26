import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'

import type { ChatPanel } from '../chat/types.js'
import { graphemes } from '../terminal/composer.js'
import { PanelOverlay, PanelTitle } from './panel-components.js'
import { EditableText } from './text-input.js'
import { Box, Text, useTheme } from './theme.js'

export function RenamePanel({
  panel,
  value,
  width,
  animateCursor,
  onPanelElement,
}: {
  panel: ChatPanel
  value: string
  width: number
  animateCursor: boolean
  onPanelElement?: (element: DOMElement | null) => void
}): ReactElement {
  const { accent, surface } = useTheme()
  const currentName = panel.rows[0]?.description
  return (
    <PanelOverlay width={width} {...(onPanelElement ? { onElement: onPanelElement } : {})}>
      <Box paddingX={1} flexDirection="column">
        <PanelTitle title={panel.title} color={accent} />
        {currentName ? (
          <Text dimColor wrap="truncate-end">
            Current name: {currentName}
          </Text>
        ) : null}
        <Box marginTop={1}>
          <Text dimColor>New name</Text>
        </Box>
        <Box paddingX={1} height={3} alignItems="center" backgroundColor={surface}>
          <EditableText
            value={value}
            cursor={graphemes(value).length}
            width={Math.max(1, width - 6)}
            active
            animate={animateCursor}
            placeholder="Enter a new name"
          />
        </Box>
      </Box>
    </PanelOverlay>
  )
}
