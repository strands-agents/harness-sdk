import { type ReactElement, type ReactNode } from 'react'
import { type DOMElement } from 'ink'
import { type ChatPanel, type ChatPanelRow, type ChatPanelFilter } from '../chat/controller.js'
import { Cursor } from '../text-input.js'
import { Box, Text, useTheme } from '../theme.js'
import {
  PANEL_SECTION_BORDER_COLUMNS,
  PANEL_SECTION_BORDER_ROWS,
  PANEL_SECTION_HEADER_GAP,
  PANEL_SECTION_HEADER_HEIGHT,
  PANEL_SECTION_PADDING_X,
  trailingWindowStart,
} from '../interaction.js'

export interface PanelRowsProps {
  panel: ChatPanel
  rows: readonly ChatPanelRow[]
  selected: number
  start: number
  width: number
  pressedRow?: number
  hoveredRow?: number
  onPanelElement?: (element: DOMElement | null) => void
  onRowElement?: (index: number, element: DOMElement | null) => void
}

export const TONE_COLORS = { normal: undefined, success: 'green', warning: 'yellow', danger: 'red' } as const

/** Badge text always gets a color so a `normal` badge renders gray instead of the accent. */
export function badgeColor(tone: keyof typeof TONE_COLORS): string {
  return TONE_COLORS[tone] ?? 'gray'
}

export function PanelItemHeader({
  label,
  active,
  pressed = false,
  clickable = false,
  bold = false,
  color,
  wrap = 'truncate-end',
}: {
  label: string
  active: boolean
  pressed?: boolean
  clickable?: boolean
  bold?: boolean
  color?: string
  wrap?: 'truncate-end' | 'wrap'
}): ReactElement {
  const { accent } = useTheme()
  const markerColor = active || (pressed && clickable) ? (color ?? accent) : undefined
  const labelColor = active || pressed ? (color ?? accent) : undefined
  return (
    <Box flexShrink={1} overflow="hidden">
      <Box flexShrink={0}>
        <Text {...(markerColor ? { color: markerColor } : {})} dimColor={!active && !pressed}>
          {active && clickable ? '› ' : '  '}
        </Text>
      </Box>
      <Text {...(labelColor ? { color: labelColor } : {})} bold={bold || (active && !pressed)} wrap={wrap}>
        {label}
      </Text>
    </Box>
  )
}

export function PanelSearchHeader({
  query,
  placeholder,
  focused,
  onElement,
  paddingX,
}: {
  query: string
  placeholder: string
  focused: boolean
  onElement?: (element: DOMElement | null) => void
  paddingX?: number
}): ReactElement {
  const { accent } = useTheme()
  return (
    <Box ref={onElement} {...(paddingX === undefined ? { flexShrink: 1 } : { paddingX })}>
      <Box flexShrink={0} marginRight={1}>
        <Text {...(focused ? { color: accent } : { dimColor: true })}>/</Text>
      </Box>
      <Text {...(query ? {} : { dimColor: true })} wrap={query ? 'truncate-start' : 'truncate-end'}>
        {query || (focused ? '' : placeholder)}
        {focused ? <Cursor /> : null}
      </Text>
    </Box>
  )
}

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
