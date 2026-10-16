import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'

import type { ChatPanel } from '../chat/types.js'
import { errorPanelLayout } from './error-panel-layout.js'
import { PanelHelpFooter } from './help-footer.js'
import { PanelSection } from './panel-sections.js'
import { Box, Text, useTheme } from './theme.js'

export function ErrorPanel({
  panel,
  width,
  height,
  scroll,
  onElement,
}: {
  panel: ChatPanel
  width: number
  height: number
  scroll: number
  onElement?: (element: DOMElement | null) => void
}): ReactElement {
  const { error } = useTheme()
  const layout = errorPanelLayout(panel, width, height)
  const start = Math.max(0, Math.min(scroll, layout.maxScroll))
  const lines = layout.lines.slice(start, start + layout.contentHeight)
  return (
    <Box ref={onElement} width={width} height={layout.height} flexDirection="column" overflow="hidden">
      <PanelSection focused width={width} height={Math.max(1, layout.height - 1)}>
        <Box paddingX={1} height={layout.contentHeight} flexDirection="column" flexShrink={0} overflow="hidden">
          {lines.map((line, index) => (
            <Text key={start + index} color={error} wrap="truncate-end">
              {line || ' '}
            </Text>
          ))}
        </Box>
      </PanelSection>
      <PanelHelpFooter width={width} scrollable={layout.maxScroll > 0} />
    </Box>
  )
}
