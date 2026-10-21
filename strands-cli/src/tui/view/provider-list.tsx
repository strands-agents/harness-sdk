import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'

import { PanelItemHeader } from './panel-components.js'
import { Box, Text, useTheme } from './theme.js'

export interface ProviderListItem {
  id: string
  label: string
  description?: string
  status?: 'success' | 'warning' | 'error'
}

export function ProviderList({
  items,
  selected,
  width,
  rowHeight = 1,
  focused = false,
  selectedBackground = false,
  paintBackground = true,
  hovered,
  pressed,
  onElement,
}: {
  items: readonly ProviderListItem[]
  selected: string
  width: number
  rowHeight?: number
  focused?: boolean
  selectedBackground?: boolean
  paintBackground?: boolean
  hovered?: string
  pressed?: string
  onElement?: (id: string, element: DOMElement | null) => void
}): ReactElement {
  const palette = useTheme()
  return (
    <>
      {items.map((item) => {
        const active = item.id === selected
        const itemPressed = item.id === pressed
        const highlighted = item.id === hovered || itemPressed || (active && (focused || selectedBackground))
        const emphasized = !paintBackground && (active || highlighted)
        return (
          <Box
            key={item.id}
            ref={(element) => onElement?.(item.id, element)}
            width={width}
            height={rowHeight}
            flexShrink={0}
            paddingX={item.status ? 1 : 0}
            flexDirection="column"
            justifyContent="center"
            backgroundColor={paintBackground && highlighted ? palette.selection : undefined}
          >
            {item.status ? (
              <Text wrap="truncate-end">
                <Text color={palette[item.status]}>● </Text>
                <Text {...(active || emphasized ? { color: palette.accent } : {})} bold={emphasized}>
                  {item.label}
                </Text>
                {item.description && rowHeight >= 2 ? (
                  <Text color={palette[item.status]}>
                    {`
${item.description}`}
                  </Text>
                ) : null}
              </Text>
            ) : (
              <PanelItemHeader
                label={item.label}
                active={active}
                pressed={itemPressed || (!paintBackground && highlighted)}
                bold={emphasized}
                clickable
              />
            )}
          </Box>
        )
      })}
    </>
  )
}
