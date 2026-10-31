import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'

import type { ChatPanelRow, ChatPermissionPreset, ChatPermissionsPanel } from '../chat/controller.js'
import { PERMISSION_CHOICES } from '../permissions/settings.js'
import { PANEL_SECTION_PADDING_X, sectionedPanelSidebarWidth, type ModelPanelFocus } from './interaction.js'
import { EffortSlider } from './model-panel.js'
import { PanelSearchHeader } from './panel-components.js'
import { PanelSection } from './panel-sections.js'
import { SettingsControl } from './settings-panel.js'
import { Box, Text, useTheme } from './theme.js'

export function PermissionsPanel({
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
  pressedControl,
  hoveredControl,
  onRowElement,
  onControlElement,
  onSearchElement,
  onSliderElement,
}: {
  panel: ChatPermissionsPanel
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
  pressedControl?: string
  hoveredControl?: string
  onRowElement?: (index: number, element: DOMElement | null) => void
  onControlElement?: (key: string, element: DOMElement | null) => void
  onSearchElement?: (element: DOMElement | null) => void
  onSliderElement?: (element: DOMElement | null) => void
}): ReactElement {
  const { accent, error, selection, warning } = useTheme()
  const sidebarWidth = sectionedPanelSidebarWidth(width)
  const availableSliderWidth = Math.max(5, sidebarWidth - 4)
  // Keep all three stop labels readable when space allows.
  const sliderWidth = Math.min(availableSliderWidth, Math.max(21, Math.round((availableSliderWidth * 2) / 3)))
  const rowWidth = Math.max(1, width - sidebarWidth - 4)
  // Reserve the three-column switch and its two-column gap.
  const labelWidth = Math.min(
    Math.max(1, rowWidth - 5),
    Math.max(0, ...allRows.map((row) => stringWidth(row.label))) + 2
  )
  const activeId = panel.slider.options.find((option) => option.active)?.id
  const activeMode: ChatPermissionPreset = activeId === 'bypass' || activeId === 'custom' ? activeId : 'ask'
  const total = panel.rows.length
  const meta = query ? `${allRows.length} / ${total}` : `${total}`
  const custom = activeMode === 'custom'
  const searchLabel = custom ? 'Search tools' : 'Search tools · choose Custom to edit'
  return (
    <Box flexGrow={1} height={height} overflow="hidden">
      <PanelSection
        focused={focus === 'providers'}
        width={sidebarWidth}
        height={height}
        header={
          <Text dimColor wrap="truncate-end">
            {sidebarWidth < 16 ? 'Mode' : panel.title}
          </Text>
        }
      >
        <Box
          flexGrow={1}
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          paddingX={1}
          overflow="hidden"
        >
          <Text color={accent} bold wrap="truncate-end">
            {PERMISSION_CHOICES[activeMode].label}
          </Text>
          {sidebarWidth >= 24 ? (
            <Text {...(activeMode === 'bypass' ? { color: warning } : { dimColor: true })} wrap="truncate-end">
              {PERMISSION_CHOICES[activeMode].description}
            </Text>
          ) : null}
          <EffortSlider
            slider={panel.slider}
            width={sliderWidth}
            compact
            showStops
            {...(onSliderElement ? { onElement: onSliderElement } : {})}
          />
        </Box>
      </PanelSection>
      <PanelSection
        focused={focus !== 'providers'}
        meta={meta}
        header={
          <PanelSearchHeader
            query={query}
            placeholder={searchLabel}
            focused={focus === 'search'}
            {...(onSearchElement ? { onElement: onSearchElement } : {})}
          />
        }
      >
        {rows.length === 0 ? (
          <Box paddingX={PANEL_SECTION_PADDING_X}>
            <Text dimColor>{total === 0 ? 'No tools available' : 'No matching tools'}</Text>
          </Box>
        ) : (
          rows.map((row, visibleIndex) => {
            const index = start + visibleIndex
            const active = custom && focus === 'models' && index === selected
            const pressed = index === pressedRow
            return (
              <Box
                key={`${panel.id}-tool-${index}`}
                ref={(element) => onRowElement?.(index, element)}
                width="100%"
                height={1}
                flexShrink={0}
                paddingX={PANEL_SECTION_PADDING_X}
                backgroundColor={index === hoveredRow || pressed ? selection : undefined}
              >
                <Box width={labelWidth} flexShrink={0} overflow="hidden">
                  <Text
                    {...(pressed || active ? { color: accent } : row.tone === 'danger' ? { color: error } : {})}
                    bold={active}
                    dimColor={!custom}
                    wrap="truncate-end"
                  >
                    {active ? '› ' : '  '}
                    {row.label}
                  </Text>
                </Box>
                {row.control ? (
                  <Box flexShrink={0} marginLeft={2}>
                    <SettingsControl
                      control={row.control}
                      rowIndex={index}
                      {...(pressedControl ? { pressedControl } : {})}
                      {...(hoveredControl ? { hoveredControl } : {})}
                      {...(onControlElement ? { onControlElement } : {})}
                    />
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
