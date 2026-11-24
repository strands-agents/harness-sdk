import type { DOMElement } from 'ink'
import { createContext, useContext, type ReactElement } from 'react'

import type { MouseInput } from '../../terminal/mouse-input.js'
import type { ChatDevPanel } from '../chat/types.js'
import { elementContainsMouse } from '../interaction.js'
import { Box, useTheme } from '../theme.js'

/** The border and the padding a frame takes from its width. */
export const DEV_PANEL_FRAME_COLUMNS = 4
const FRAME_ROWS = 2

interface DevPanelTarget {
  readonly click: () => void
  readonly hover?: () => void
}

type DevPanelWheel = (direction: -1 | 1) => void

export class DevPanelClicks {
  private readonly targets = new Map<DOMElement, DevPanelTarget>()
  private readonly wheels = new Map<DOMElement, DevPanelWheel>()

  /** Registers an area the mouse wheel scrolls, for content longer than the panel. */
  wheel(onScroll: DevPanelWheel): (element: DOMElement | null) => (() => void) | undefined {
    return (element) => {
      if (!element) return undefined
      this.wheels.set(element, onScroll)
      return () => {
        this.wheels.delete(element)
      }
    }
  }

  wheelAt(mouse: MouseInput): DevPanelWheel | undefined {
    for (const [element, onScroll] of this.wheels) {
      if (elementContainsMouse(element, mouse)) return onScroll
    }
    return undefined
  }

  target(onClick: () => void, onHover?: () => void): (element: DOMElement | null) => (() => void) | undefined {
    return (element) => {
      if (!element) return undefined
      this.targets.set(element, { click: onClick, ...(onHover ? { hover: onHover } : {}) })
      return () => {
        this.targets.delete(element)
      }
    }
  }

  at(mouse: MouseInput): (() => void) | undefined {
    return this.under(mouse)?.click
  }

  hoverAt(mouse: MouseInput): (() => void) | undefined {
    return this.under(mouse)?.hover
  }

  private under(mouse: MouseInput): DevPanelTarget | undefined {
    for (const [element, target] of this.targets) {
      if (elementContainsMouse(element, mouse)) return target
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
  active,
  blur,
  onElement,
  clicks,
}: {
  panel: ChatDevPanel
  width: number
  height: number
  active: boolean
  blur?: () => void
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
          width={Math.max(1, width - DEV_PANEL_FRAME_COLUMNS)}
          height={Math.max(1, height - FRAME_ROWS)}
          close={close}
          openCommand={openCommand}
          active={active}
          {...(blur ? { blur } : {})}
        />
      </DevPanelClickContext>
    </Box>
  )
}
