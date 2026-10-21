import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'

import type { ChatDetailPanel } from '../chat/types.js'
import { PanelHelpFooter } from './help-footer.js'
import { detailPageSize } from './interaction.js'
import { PanelSection } from './panel-sections.js'
import { detailLines } from './presentation.js'
import { Box, Text, useTheme } from './theme.js'

export function DetailPanel({
  panel,
  width,
  height,
  scroll,
  onElement,
}: {
  panel: ChatDetailPanel
  width: number
  height: number
  scroll: number
  onElement?: (element: DOMElement | null) => void
}): ReactElement {
  const palette = useTheme()
  const body = detailLines(panel, Math.max(1, width - 4), palette)
  const capacity = detailPageSize(height)
  const maximum = Math.max(0, body.length - capacity)
  const boundedScroll = Math.max(0, Math.min(scroll, maximum))
  const start = panel.followTail ? maximum - boundedScroll : boundedScroll
  const end = Math.min(body.length, start + capacity)
  const header = (
    <Text dimColor wrap="truncate-end">
      {panel.title}
    </Text>
  )

  return (
    <Box ref={onElement} width={width} height={height} flexDirection="column" overflow="hidden">
      <PanelSection
        focused
        width={width}
        height={Math.max(1, height - 1)}
        header={header}
        {...(maximum > 0 ? { meta: `${start + 1}-${end} / ${body.length}` } : {})}
      >
        <Box paddingX={1} height={capacity} flexDirection="column" flexShrink={0} overflow="hidden">
          {body.slice(start, end).map((line, index) => (
            <Box
              key={`${panel.id}-${start + index}`}
              width="100%"
              {...(line.backgroundColor ? { backgroundColor: line.backgroundColor } : {})}
            >
              <Text
                {...(line.color ? { color: line.color } : {})}
                {...(line.bold !== undefined ? { bold: line.bold } : {})}
                {...(line.dimColor !== undefined ? { dimColor: line.dimColor } : {})}
                wrap="truncate-end"
              >
                {line.label !== undefined ? <Text dimColor>{line.label}</Text> : null}
                {line.text || ' '}
              </Text>
            </Box>
          ))}
        </Box>
      </PanelSection>
      <PanelHelpFooter width={width} />
    </Box>
  )
}
