import type { ReactElement, ReactNode } from 'react'
import type { DOMElement } from 'ink'

import type { ChatPanelFilter } from '../chat/controller.js'
import { ProviderList } from './provider-list.js'
import {
  PANEL_SECTION_BORDER_COLUMNS,
  PANEL_SECTION_BORDER_ROWS,
  PANEL_SECTION_HEADER_GAP,
  PANEL_SECTION_HEADER_HEIGHT,
  PANEL_SECTION_PADDING_X,
  trailingWindowStart,
} from './interaction.js'
import { Box, Text, useTheme } from './theme.js'

/** Bordered list that picks what the neighboring {@link PanelSection} shows. */
export function PanelSectionList({
  title,
  items,
  selected,
  focused,
  width,
  height,
  paintBackground = true,
  pressed,
  hovered,
  onSectionElement,
  onElement,
}: {
  title: string
  items: readonly ChatPanelFilter[]
  selected: string
  focused: boolean
  width: number
  height: number
  paintBackground?: boolean
  pressed?: string
  hovered?: string
  onSectionElement?: (element: DOMElement | null) => void
  onElement?: (id: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent } = useTheme()
  const capacity = Math.max(1, height - PANEL_SECTION_BORDER_ROWS - PANEL_SECTION_HEADER_HEIGHT)
  const index = Math.max(
    0,
    items.findIndex((item) => item.id === selected)
  )
  const start = trailingWindowStart(index, capacity, items.length)
  return (
    <Box
      ref={onSectionElement}
      width={width}
      height={height}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
      borderStyle="single"
      borderColor={focused ? accent : undefined}
      borderDimColor={!focused}
    >
      <PanelSectionHeader>
        <Text dimColor>{title}</Text>
      </PanelSectionHeader>
      <Box flexDirection="column" paddingLeft={PANEL_SECTION_PADDING_X}>
        <ProviderList
          items={items.slice(start, start + capacity)}
          selected={selected}
          width={Math.max(1, width - PANEL_SECTION_BORDER_COLUMNS - PANEL_SECTION_PADDING_X)}
          focused={focused}
          paintBackground={paintBackground}
          {...(hovered ? { hovered } : {})}
          {...(pressed ? { pressed } : {})}
          {...(onElement ? { onElement } : {})}
        />
      </Box>
    </Box>
  )
}

/** Bordered content section with an optional one-row header. */
export function PanelSection({
  header,
  meta,
  focused,
  width,
  height,
  children,
}: {
  header?: ReactNode
  meta?: string
  focused: boolean
  width?: number
  height?: number
  children: ReactNode
}): ReactElement {
  const { accent } = useTheme()
  return (
    <Box
      flexGrow={width === undefined ? 1 : 0}
      flexShrink={width === undefined ? 1 : 0}
      {...(width === undefined ? {} : { width })}
      {...(height === undefined ? {} : { height })}
      flexDirection="column"
      overflow="hidden"
      borderStyle="single"
      borderColor={focused ? accent : undefined}
      borderDimColor={!focused}
    >
      {header || meta ? (
        <PanelSectionHeader gap>
          {header}
          {meta ? (
            <Box flexShrink={0} marginLeft={1}>
              <Text dimColor>{meta}</Text>
            </Box>
          ) : null}
        </PanelSectionHeader>
      ) : null}
      {children}
    </Box>
  )
}

function PanelSectionHeader({ gap = false, children }: { gap?: boolean; children: ReactNode }): ReactElement {
  return (
    <Box
      height={PANEL_SECTION_HEADER_HEIGHT}
      flexShrink={0}
      paddingX={PANEL_SECTION_PADDING_X}
      marginBottom={gap ? PANEL_SECTION_HEADER_GAP : 0}
      justifyContent="space-between"
    >
      {children}
    </Box>
  )
}
