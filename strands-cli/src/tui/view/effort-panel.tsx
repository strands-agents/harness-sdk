import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'

import type { ChatPanelSlider } from '../chat/types.js'
import { PanelHelpFooter } from './help-footer.js'
import { EffortSlider } from './model-panel.js'
import { Box, Text, useTheme } from './theme.js'

export function EffortPanel({
  slider,
  body,
  width,
  onElement,
  onSliderElement,
}: {
  slider: ChatPanelSlider
  body?: string
  width: number
  onElement?: (element: DOMElement | null) => void
  onSliderElement?: (element: DOMElement | null) => void
}): ReactElement {
  const theme = useTheme()
  const [modelName = '', modelId = ''] = body?.split('\n') ?? []
  const contentWidth = Math.max(1, width)
  const model = modelName || modelId
  const showModel = model && stringWidth(`Reasoning effort · ${model}`) <= contentWidth
  const sliderWidth = Math.min(contentWidth, 60)
  return (
    <Box
      ref={onElement}
      width={width}
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
        <PanelHelpFooter width={contentWidth} centered />
      </Box>
    </Box>
  )
}
