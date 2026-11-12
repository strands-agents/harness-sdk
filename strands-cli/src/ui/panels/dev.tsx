import type { DOMElement } from 'ink'
import type { ReactElement } from 'react'

import type { ChatDevPanel } from '../chat/types.js'
import { Box, useTheme } from '../theme.js'

const FRAME_COLUMNS = 4
const FRAME_ROWS = 2

export const DevPanelFrame = ({
  panel,
  width,
  height,
  onElement,
}: {
  panel: ChatDevPanel
  width: number
  height: number
  onElement?: (element: DOMElement | null) => void
}): ReactElement => {
  const { border } = useTheme()
  const { view: View, close, openCommand } = panel
  return (
    <Box
      {...(onElement ? { ref: onElement } : {})}
      width={width}
      height={height}
      flexShrink={0}
      flexDirection="column"
      borderStyle="round"
      borderColor={border}
      paddingX={1}
      overflow="hidden"
    >
      <View
        width={Math.max(1, width - FRAME_COLUMNS)}
        height={Math.max(1, height - FRAME_ROWS)}
        close={close}
        openCommand={openCommand}
      />
    </Box>
  )
}
