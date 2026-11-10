import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'

import type { ChatPanel, ChatPanelSlider } from '../chat/types.js'
import { PanelHelpContext, PanelHelpFooter } from './help-footer.js'
import { EffortSlider } from './model-panel.js'
import { Box, Text, useTheme } from './theme.js'

export function EffortPanel({
  panel,
  slider,
  width,
  onElement,
  onSliderElement,
}: {
  panel: ChatPanel
  slider: ChatPanelSlider
  width: number
  onElement?: (element: DOMElement | null) => void
  onSliderElement?: (element: DOMElement | null) => void
}): ReactElement {
  const theme = useTheme()
  const [modelName = '', modelId = ''] = panel.body?.split('\n') ?? []
  const contentWidth = Math.max(1, width - 2)
  const model = modelName || modelId
  const showModel = model && stringWidth(`Reasoning effort · ${model}`) <= contentWidth
  const sliderWidth = Math.min(contentWidth, 60)
  return (
    <Box
      ref={onElement}
      width={width}
      paddingX={1}
      flexGrow={1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      overflow="hidden"
    >
      <Box width={contentWidth} justifyContent="center">
        <Text wrap="truncate-end">
          <Text bold color={theme.accent}>
            Reasoning effort
          </Text>
          {showModel ? <Text dimColor> · {model}</Text> : null}
        </Text>
      </Box>
      <EffortSlider
        slider={slider}
        width={sliderWidth}
        compact={false}
        showStops
        {...(onSliderElement ? { onElement: onSliderElement } : {})}
      />
      <Box marginTop={1} width={contentWidth}>
        <PanelHelpContext value={panel}>
          <PanelHelpFooter width={contentWidth} centered />
        </PanelHelpContext>
      </Box>
    </Box>
  )
}
