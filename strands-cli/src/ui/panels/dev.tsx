import type { DOMElement } from 'ink'
import { createContext, useContext, type ReactElement } from 'react'

import type { MouseInput } from '../../terminal/mouse-input.js'
import type { ChatDevPanel } from '../chat/types.js'
import { elementContainsMouse } from '../interaction.js'
import { Box, useTheme } from '../theme.js'

const FRAME_COLUMNS = 4
const FRAME_ROWS = 2

export class DevPanelClicks {
  private readonly targets = new Map<DOMElement, () => void>()

  target(onClick: () => void): (element: DOMElement | null) => (() => void) | undefined {
    return (element) => {
      if (!element) return undefined
      this.targets.set(element, onClick)
      return () => {
        this.targets.delete(element)
      }
    }
  }

  at(mouse: MouseInput): (() => void) | undefined {
    for (const [element, onClick] of this.targets) {
      if (elementContainsMouse(element, mouse)) return onClick
    }
    return undefined
  }
}

const DevPanelClickContext = createContext<DevPanelClicks | undefined>(undefined)

export const useDevPanelClicks = (): DevPanelClicks | undefined => useContext(DevPanelClickContext)

export const DevPanelFrame = ({
  panel,
  width,
  height,
  onElement,
  clicks,
}: {
  panel: ChatDevPanel
  width: number
  height: number
  onElement?: (element: DOMElement | null) => void
  clicks?: DevPanelClicks
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
      <DevPanelClickContext value={clicks}>
        <View
          width={Math.max(1, width - FRAME_COLUMNS)}
          height={Math.max(1, height - FRAME_ROWS)}
          close={close}
          openCommand={openCommand}
        />
      </DevPanelClickContext>
    </Box>
  )
}
