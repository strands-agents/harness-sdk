import type { ReactElement, ReactNode } from 'react'
import type { DOMElement } from 'ink'

import type { ChatPanelFilter } from '../chat/controller.js'
import { ProviderList } from './provider-list.js'
import { Box, Text, useTheme } from './theme.js'

/** Bordered list that picks what the neighboring {@link PanelSection} shows. */
export function PanelSectionList({
  title,
  items,
  selected,
  focused,
  width,
  height,
  pressed,
  hovered,
  onElement,
}: {
  title: string
  items: readonly ChatPanelFilter[]
  selected: string
  focused: boolean
  width: number
  height: number
  pressed?: string
  hovered?: string
  onElement?: (id: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent } = useTheme()
  // Borders and the title row.
  const capacity = Math.max(1, height - 3)
  const index = Math.max(
    0,
    items.findIndex((item) => item.id === selected)
  )
  const start = Math.max(0, Math.min(index - capacity + 1, items.length - capacity))
  return (
    <Box
      width={width}
      height={height}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
      borderStyle="single"
      borderColor={focused ? accent : undefined}
      borderDimColor={!focused}
      paddingLeft={1}
    >
      <Text dimColor>{title}</Text>
      <ProviderList
        items={items.slice(start, start + capacity)}
        selected={selected}
        width={Math.max(1, width - 3)}
        focused={focused}
        {...(hovered ? { hovered } : {})}
        {...(pressed ? { pressed } : {})}
        {...(onElement ? { onElement } : {})}
      />
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
        <Box paddingX={1} marginBottom={1} justifyContent="space-between">
          {header}
          {meta ? (
            <Box flexShrink={0} marginLeft={1}>
              <Text dimColor>{meta}</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {children}
    </Box>
  )
}
