import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'

import type { ChatPanelRow } from '../chat/controller.js'
import type { ModelPanelFocus } from './interaction.js'
import { PanelSearchHeader, type PanelRowsProps } from './panel-components.js'
import { PanelSection, PanelSectionList } from './panel-sections.js'
import { Box, Text, useTheme } from './theme.js'

export function HelpPanel({
  panel,
  rows,
  allRows,
  selected,
  start,
  width,
  height,
  query,
  filter,
  focus,
  pressedFilter,
  hoveredFilter,
  pressedRow,
  hoveredRow,
  onRowElement,
  onFilterElement,
  onSearchElement,
}: Omit<PanelRowsProps, 'onPanelElement'> & {
  allRows: readonly ChatPanelRow[]
  height: number
  query: string
  filter: string
  focus: ModelPanelFocus
  pressedFilter?: string
  hoveredFilter?: string
  onFilterElement?: (id: string, element: DOMElement | null) => void
  onSearchElement?: (element: DOMElement | null) => void
}): ReactElement {
  const { accent, selection } = useTheme()
  const filters = panel.filters ?? []
  const sidebarWidth = Math.min(
    Math.max(1, width - 12),
    Math.max(4, ...filters.map((item) => stringWidth(item.label))) + 5
  )
  const rowWidth = Math.max(1, width - sidebarWidth - 4)
  const labelWidth = Math.min(
    Math.max(1, Math.floor(rowWidth / 2)),
    Math.max(0, ...allRows.filter((row) => row.filter === 'controls').map((row) => stringWidth(row.label))) + 2
  )
  return (
    <Box flexGrow={1} height={height} overflow="hidden">
      <PanelSectionList
        title="Help"
        items={filters}
        selected={filter}
        focused={focus === 'providers'}
        width={sidebarWidth}
        height={height}
        {...(pressedFilter ? { pressed: pressedFilter } : {})}
        {...(hoveredFilter ? { hovered: hoveredFilter } : {})}
        {...(onFilterElement ? { onElement: onFilterElement } : {})}
      />
      <PanelSection
        focused={focus !== 'providers'}
        meta={
          allRows.length > rows.length
            ? `${start + 1}-${Math.min(start + rows.length, allRows.length)} / ${allRows.length}`
            : `${allRows.length}`
        }
        header={
          <PanelSearchHeader
            query={query}
            placeholder="Search help"
            focused={focus === 'search'}
            {...(onSearchElement ? { onElement: onSearchElement } : {})}
          />
        }
      >
        {rows.length === 0 ? (
          <Box paddingX={1}>
            <Text dimColor>No matching help</Text>
          </Box>
        ) : (
          rows.map((row, visibleIndex) => {
            const index = start + visibleIndex
            const active = focus === 'models' && index === selected
            const pressed = index === pressedRow
            const description = row.description.split('\n')[0] ?? ''
            const shortcut = row.filter === 'controls' ? description : undefined
            return (
              <Box
                key={`${panel.id}-help-${index}`}
                ref={(element) => onRowElement?.(index, element)}
                width="100%"
                height={1}
                flexShrink={0}
                paddingX={1}
                backgroundColor={index === hoveredRow || pressed ? selection : undefined}
              >
                <Box {...(shortcut ? { width: labelWidth, flexShrink: 0 } : { flexShrink: 1 })} overflow="hidden">
                  <Text {...(pressed || active ? { color: accent } : {})} bold={active} wrap="truncate-end">
                    {active ? '› ' : '  '}
                    {row.label}
                    {!shortcut && description ? <Text dimColor> · {description}</Text> : null}
                  </Text>
                </Box>
                {shortcut ? (
                  <Box
                    marginLeft={2}
                    width={Math.min(stringWidth(shortcut), Math.max(1, rowWidth - labelWidth - 2))}
                    flexShrink={0}
                    overflow="hidden"
                  >
                    <Text dimColor wrap="truncate-end">
                      {shortcut}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            )
          })
        )}
      </PanelSection>
    </Box>
  )
}
