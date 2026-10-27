import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'

import type { ChatModelPanel, ChatPanelFilter, ChatPanelRow, ChatPanelSlider } from '../chat/controller.js'
import type { ModelPanelFocus } from './interaction.js'
import type { PanelRowsProps } from './panel-components.js'
import { ProviderList } from './provider-list.js'
import { BlinkingCursor } from './text-input.js'
import { Box, Text, useTheme } from './theme.js'
import { useSpinner } from './use-spinner.js'

export function ModelPicker({
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
  animate,
  pressedFilter,
  hoveredFilter,
  pressedRow,
  hoveredRow,
  onRowElement,
  onFilterElement,
  onSearchElement,
}: Omit<PanelRowsProps, 'panel' | 'onPanelElement'> & {
  panel: ChatModelPanel
  allRows: readonly ChatPanelRow[]
  height: number
  query: string
  filter: string
  focus: ModelPanelFocus
  animate: boolean
  pressedFilter?: string
  hoveredFilter?: string
  onFilterElement?: (id: string, element: DOMElement | null) => void
  onSearchElement?: (element: DOMElement | null) => void
}): ReactElement {
  const { accent } = useTheme()
  const spinner = useSpinner(panel.loading === true, animate)
  if (panel.loading) {
    return (
      <Box flexGrow={1} height={height} alignItems="center" justifyContent="center">
        <Text color={accent}>{spinner} </Text>
        <Text dimColor>Loading models</Text>
      </Box>
    )
  }
  const filters = panel.filters ?? []
  const emptyMessage = query.trim()
    ? 'No matching models'
    : filter === 'all' || filter === 'current'
      ? 'No models available'
      : 'No models available. Configure this provider with /setup.'
  return (
    <Box flexGrow={1} height={height} overflow="hidden">
      <ProviderColumn
        filters={filters}
        filter={filter}
        focused={focus === 'providers'}
        width={Math.max(1, Math.floor(width / 3))}
        height={height}
        {...(pressedFilter ? { pressed: pressedFilter } : {})}
        {...(hoveredFilter ? { hovered: hoveredFilter } : {})}
        {...(onFilterElement ? { onElement: onFilterElement } : {})}
      />
      <Box
        flexGrow={1}
        flexDirection="column"
        overflow="hidden"
        borderStyle="single"
        borderColor={focus === 'models' || focus === 'search' ? accent : undefined}
        borderDimColor={focus === 'providers'}
      >
        <Box paddingX={1} marginBottom={1} justifyContent="space-between">
          <Box ref={onSearchElement} flexShrink={1}>
            <Box flexShrink={0} marginRight={1}>
              <Text {...(focus === 'search' ? { color: accent } : { dimColor: true })}>/</Text>
            </Box>
            <Text {...(query ? {} : { dimColor: true })} wrap={query ? 'truncate-start' : 'truncate-end'}>
              {query || (focus === 'search' ? '' : 'Search models')}
              {focus === 'search' ? <BlinkingCursor animate={animate} /> : null}
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}>
            <Text dimColor>
              {allRows.length > rows.length
                ? `${start + 1}-${Math.min(start + rows.length, allRows.length)} / ${allRows.length}`
                : `${allRows.length}`}
            </Text>
          </Box>
        </Box>
        <ModelRows
          panel={panel}
          rows={rows}
          selected={selected}
          focused={focus === 'models'}
          start={start}
          emptyMessage={emptyMessage}
          {...(pressedRow !== undefined ? { pressed: pressedRow } : {})}
          {...(hoveredRow !== undefined ? { hovered: hoveredRow } : {})}
          {...(onRowElement ? { onRowElement } : {})}
        />
      </Box>
    </Box>
  )
}

function ProviderColumn({
  width,
  height,
  ...props
}: {
  width: number
  height: number
  filters: readonly ChatPanelFilter[]
  filter: string
  focused: boolean
  pressed?: string
  hovered?: string
  onElement?: (id: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent } = useTheme()
  const capacity = Math.max(1, height - 3)
  const index = Math.max(
    0,
    props.filters.findIndex((item) => item.id === props.filter)
  )
  const start = Math.max(0, Math.min(index - capacity + 1, props.filters.length - capacity))
  return (
    <Box
      width={width}
      height={height}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
      borderStyle="single"
      borderColor={props.focused ? accent : undefined}
      borderDimColor={!props.focused}
      paddingLeft={1}
    >
      <Text dimColor>Providers</Text>
      <ProviderList
        items={props.filters.slice(start, start + capacity)}
        selected={props.filter}
        width={Math.max(1, width - 3)}
        focused={props.focused}
        {...(props.hovered ? { hovered: props.hovered } : {})}
        {...(props.pressed ? { pressed: props.pressed } : {})}
        {...(props.onElement ? { onElement: props.onElement } : {})}
      />
    </Box>
  )
}

export function EffortSlider({
  slider,
  width,
  compact,
  focused = false,
  onElement,
  showStops = false,
}: {
  slider: ChatPanelSlider
  width: number
  compact: boolean
  focused?: boolean
  onElement?: (element: DOMElement | null) => void
  showStops?: boolean
}): ReactElement {
  const { accent, selection } = useTheme()
  const activeIndex = Math.max(
    0,
    slider.options.findIndex((option) => option.active)
  )
  const activeOption = slider.options[activeIndex]
  const positions = slider.options.map((_, index) =>
    slider.options.length <= 1 ? 0 : Math.round((index / (slider.options.length - 1)) * (width - 1))
  )
  const thumbCenter = positions[activeIndex] ?? 0
  const thumbStart = Math.max(0, Math.min(width - 3, thumbCenter - 1))
  const track = Array.from({ length: width }, () => '─')
  if (showStops) {
    for (const position of positions) track[position] = '┬'
  }
  track.fill('█', thumbStart, thumbStart + 3)
  const ticks = Array.from({ length: width }, () => ' ')
  for (const position of positions) {
    ticks[position] = '│'
  }
  return (
    <Box marginTop={compact ? 0 : 1} flexDirection="column" alignItems="center">
      {!showStops ? (
        <Box>
          <Text dimColor>{slider.label} </Text>
          <Text {...(slider.disabled ? { dimColor: true } : { color: accent })} bold={slider.disabled !== true}>
            {activeOption?.label ?? 'Unavailable'}
          </Text>
        </Box>
      ) : null}
      <Box
        ref={onElement}
        width={width}
        backgroundColor={!showStops && focused ? selection : undefined}
        flexDirection="column"
      >
        <Text {...(slider.disabled ? { dimColor: true } : { color: accent })}>{track.join('')}</Text>
        {showStops ? (
          <Box width={width} height={1}>
            {slider.options.map((option, index) => {
              // Label cells follow sliderOptionAtMouse's rounding, including ties.
              const intervals = Math.max(1, slider.options.length - 1)
              const span = Math.max(1, width - 1)
              const start = index === 0 ? 0 : Math.min(width, Math.ceil(((index - 0.5) * span) / intervals))
              const end =
                index === slider.options.length - 1
                  ? width
                  : Math.min(width, Math.ceil(((index + 0.5) * span) / intervals))
              return (
                <Box
                  key={option.id}
                  width={Math.max(0, end - start)}
                  flexShrink={0}
                  justifyContent={index === 0 ? 'flex-start' : index === positions.length - 1 ? 'flex-end' : 'center'}
                  overflow="hidden"
                >
                  <Text
                    {...(index === activeIndex ? { color: accent } : {})}
                    dimColor={index !== activeIndex}
                    wrap="truncate-end"
                  >
                    {option.label}
                  </Text>
                </Box>
              )
            })}
          </Box>
        ) : !compact ? (
          <Text dimColor>{ticks.join('')}</Text>
        ) : null}
      </Box>
    </Box>
  )
}

function ModelRows({
  panel,
  rows,
  selected,
  start,
  pressed,
  hovered,
  focused,
  emptyMessage,
  onRowElement,
}: Pick<PanelRowsProps, 'panel' | 'rows' | 'selected' | 'start' | 'onRowElement'> & {
  pressed?: number
  hovered?: number
  focused: boolean
  emptyMessage: string
}): ReactElement {
  const { accent, hover, selection, warning } = useTheme()
  return (
    <Box flexGrow={1} flexDirection="column" overflow="hidden">
      {rows.length === 0 ? (
        <Text dimColor>{emptyMessage}</Text>
      ) : (
        rows.map((row, visibleIndex) => {
          const index = start + visibleIndex
          const active = index === selected
          const pressedRow = index === pressed
          return (
            <Box
              key={`${panel.id}-model-${index}`}
              ref={(element) => onRowElement?.(index, element)}
              width="100%"
              paddingX={1}
              justifyContent="space-between"
              backgroundColor={index === hovered || pressedRow ? selection : undefined}
            >
              <Box flexShrink={1} overflow="hidden">
                <Text
                  wrap="truncate-end"
                  {...(pressedRow && row.value ? { color: hover } : focused && active ? { color: accent } : {})}
                  bold={focused && active}
                >
                  {focused && active ? '› ' : '  '}
                  {row.label}
                </Text>
              </Box>
              {row.badge ? (
                <Box marginLeft={1} flexShrink={0}>
                  <Text color={row.badge.tone === 'success' ? 'green' : row.badge.tone === 'danger' ? 'red' : warning}>
                    {row.badge.text}
                  </Text>
                </Box>
              ) : null}
            </Box>
          )
        })
      )}
    </Box>
  )
}
