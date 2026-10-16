import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'

import type { ChatPanelRow, ChatPanelSlider, ChatTasksPanel } from '../chat/controller.js'
import { sectionedPanelSidebarWidth, type ModelPanelFocus } from './interaction.js'
import { EffortSlider } from './model-panel.js'
import { PanelSearchHeader, badgeColor } from './panel-components.js'
import { PanelSection } from './panel-sections.js'
import { Box, Text, useTheme } from './theme.js'

export function TasksPanel({
  panel,
  rows,
  allRows,
  selected,
  start,
  width,
  height,
  query,
  focus,
  pressedRow,
  hoveredRow,
  onRowElement,
  onSearchElement,
  onSliderElement,
}: {
  panel: ChatTasksPanel
  rows: readonly ChatPanelRow[]
  allRows: readonly ChatPanelRow[]
  selected: number
  start: number
  width: number
  height: number
  query: string
  focus: ModelPanelFocus
  pressedRow?: number
  hoveredRow?: number
  onRowElement?: (index: number, element: DOMElement | null) => void
  onSearchElement?: (element: DOMElement | null) => void
  onSliderElement?: (element: DOMElement | null) => void
}): ReactElement {
  const { accent, selection } = useTheme()
  const sidebarWidth = sectionedPanelSidebarWidth(width)
  const total = `${panel.rows.length}`
  const meta = query ? `${allRows.length} / ${total}` : total
  return (
    <Box flexGrow={1} height={height} overflow="hidden">
      <PanelSection
        focused={focus === 'providers'}
        width={sidebarWidth}
        height={height}
        header={<Text dimColor>Behavior</Text>}
      >
        <Box
          flexGrow={1}
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          paddingX={1}
          overflow="hidden"
        >
          <Text {...(focus === 'providers' ? { color: accent } : {})} bold={focus === 'providers'} wrap="truncate-end">
            Wait for completion
          </Text>
          {panel.waitForCompletion === undefined ? (
            <Text dimColor>Unavailable</Text>
          ) : (
            <EffortSlider
              slider={waitForCompletionSlider(panel.waitForCompletion)}
              width={Math.max(6, Math.floor((sidebarWidth - 4) / 2))}
              compact
              showStops
              {...(onSliderElement ? { onElement: onSliderElement } : {})}
            />
          )}
        </Box>
      </PanelSection>
      <PanelSection
        focused={focus !== 'providers'}
        meta={meta}
        header={
          <PanelSearchHeader
            query={query}
            placeholder="Search tasks"
            focused={focus === 'search'}
            {...(onSearchElement ? { onElement: onSearchElement } : {})}
          />
        }
      >
        {rows.length === 0 ? (
          <Box paddingX={1}>
            <Text dimColor>{panel.rows.length === 0 ? 'No background tasks' : 'No matching tasks'}</Text>
          </Box>
        ) : (
          rows.map((row, visibleIndex) => {
            const index = start + visibleIndex
            const active = focus === 'models' && index === selected
            const pressed = index === pressedRow
            return (
              <Box
                key={`${panel.id}-task-${index}`}
                ref={(element) => onRowElement?.(index, element)}
                width="100%"
                paddingX={1}
                justifyContent="space-between"
                backgroundColor={index === hoveredRow || pressed ? selection : undefined}
              >
                <Box flexShrink={1} overflow="hidden">
                  <Text {...(pressed || active ? { color: accent } : {})} bold={active} wrap="truncate-end">
                    {active ? '› ' : '  '}
                    {row.label}
                    {row.description ? <Text dimColor> · {row.description}</Text> : null}
                  </Text>
                </Box>
                {row.badge ? (
                  <Box marginLeft={1} flexShrink={0}>
                    <Text color={badgeColor(row.badge.tone)}>{row.badge.text}</Text>
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

export function waitForCompletionSlider(waitForCompletion: boolean | undefined): ChatPanelSlider {
  return {
    label: 'Wait for completion',
    options: [
      { id: 'off', label: 'Off', active: waitForCompletion === false },
      { id: 'on', label: 'On', active: waitForCompletion === true },
    ],
    ...(waitForCompletion === undefined ? { disabled: true } : {}),
  }
}
