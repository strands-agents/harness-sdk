import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'

import type { ChatPanelRow, ChatPanelSlider } from '../chat/controller.js'
import { MODEL_COPY_TARGET, type ModelPanelFocus } from './interaction.js'
import { PanelOverlay, type PanelRowsProps } from './panel-components.js'
import { ProviderList } from './provider-list.js'
import { BlinkingCursor } from './text-input.js'
import { Box, Text, useTheme } from './theme.js'

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
  animateCursor,
  pressedFilter,
  hoveredFilter,
  pressedRow,
  hoveredRow,
  pressedSlider,
  hoveredSlider,
  pressedControl,
  hoveredControl,
  onPanelElement,
  onRowElement,
  onFilterElement,
  onSearchElement,
  onSliderElement,
  onControlElement,
}: PanelRowsProps & {
  allRows: readonly ChatPanelRow[]
  height: number
  query: string
  filter: string
  focus: ModelPanelFocus
  animateCursor: boolean
  pressedFilter?: string
  hoveredFilter?: string
  pressedSlider: boolean
  hoveredSlider?: boolean
  pressedControl?: string
  hoveredControl?: string
  onFilterElement?: (id: string, element: DOMElement | null) => void
  onSearchElement?: (element: DOMElement | null) => void
  onSliderElement?: (element: DOMElement | null) => void
  onControlElement?: (key: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent, hover, selection } = useTheme()
  const compact = height < 30
  const wide = width >= 72 && !compact
  const showDetails = width >= 96 && !compact
  const detailWidth = Math.min(56, Math.max(38, Math.floor(width * 0.4)))
  const condensedFilters = width < 52 || height < 20
  const filters = panel.filters ?? []
  const filterIndex = Math.max(
    0,
    filters.findIndex((item) => item.id === filter)
  )
  const previousFilter = filters[(filterIndex + filters.length - 1) % filters.length]
  const visibleFilters = condensedFilters
    ? [...new Set([previousFilter, filters[filterIndex], filters[(filterIndex + 1) % filters.length]])].filter(
        (item) => item !== undefined
      )
    : filters
  const [currentModelName = '', currentModelId = ''] = panel.body?.split('\n') ?? []
  const selectedModel = allRows[Math.max(0, Math.min(selected, allRows.length - 1))]
  const emptyMessage = query.trim()
    ? 'No matching models'
    : filter === 'all' || filter === 'current'
      ? 'No models available'
      : 'No models available. Configure this provider with /setup.'
  const modelRows = (
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
  )
  return (
    <PanelOverlay width={width} {...(onPanelElement ? { onElement: onPanelElement } : {})}>
      <Box flexDirection="column" overflow="hidden">
        <Box justifyContent="space-between">
          <Text color={accent} bold>
            Models
          </Text>
          <Text dimColor>
            {allRows.length > rows.length
              ? `${start + 1}-${Math.min(start + rows.length, allRows.length)} / ${allRows.length}`
              : `${allRows.length}`}
          </Text>
        </Box>
        {!showDetails && (currentModelName || currentModelId) ? (
          <Box flexDirection="column" alignItems="center">
            <Text wrap="truncate-end">
              <Text dimColor>Current model </Text>
              <Text bold>{currentModelName || currentModelId}</Text>
            </Text>
            {currentModelId && !compact ? (
              <Text dimColor wrap="truncate-end">
                {currentModelId}
              </Text>
            ) : null}
            {selectedModel?.value ? (
              <Box width="100%" justifyContent="center">
                <Box flexShrink={1} overflow="hidden">
                  <Text dimColor>Selected ID </Text>
                  <Text wrap="truncate-end">{selectedModel.value}</Text>
                </Box>
                <Box marginLeft={1} flexShrink={0}>
                  <ModelCopyButton
                    compact
                    focused={focus === 'copy'}
                    pressed={pressedControl === MODEL_COPY_TARGET}
                    hovered={hoveredControl === MODEL_COPY_TARGET}
                    {...(onControlElement ? { onElement: onControlElement } : {})}
                  />
                </Box>
              </Box>
            ) : null}
          </Box>
        ) : null}
        {!showDetails && panel.slider ? (
          <EffortSlider
            slider={panel.slider}
            width={Math.max(18, Math.min(36, Math.floor(width / 3)))}
            compact={compact}
            pressed={pressedSlider}
            {...(hoveredSlider !== undefined ? { hovered: hoveredSlider } : {})}
            focused={focus === 'effort'}
            {...(onSliderElement ? { onElement: onSliderElement } : {})}
          />
        ) : null}
        <Box
          ref={onSearchElement}
          marginTop={compact ? 0 : 1}
          backgroundColor={focus === 'search' ? selection : undefined}
        >
          <Text dimColor>/ </Text>
          <Text wrap="truncate-start">
            {query || <Text dimColor>Search models</Text>}
            {focus === 'search' ? <BlinkingCursor animate={animateCursor} /> : null}
          </Text>
        </Box>
        {wide ? (
          <Box marginTop={1}>
            <Box width={Math.min(26, Math.floor(width / 3))} marginRight={1} flexDirection="column" flexShrink={0}>
              <Text dimColor>Provider</Text>
              <ProviderList
                items={filters}
                selected={filter}
                width={Math.min(26, Math.floor(width / 3))}
                focused={focus === 'providers'}
                {...(hoveredFilter ? { hovered: hoveredFilter } : {})}
                {...(pressedFilter ? { pressed: pressedFilter } : {})}
                {...(onFilterElement ? { onElement: onFilterElement } : {})}
              />
            </Box>
            {modelRows}
            {showDetails ? (
              <Box
                width={detailWidth}
                marginLeft={1}
                paddingLeft={1}
                flexDirection="column"
                flexShrink={0}
                overflow="hidden"
              >
                <Text bold color={accent}>
                  Model details
                </Text>
                <Text bold wrap="truncate-end">
                  {selectedModel?.label ?? 'Select a model'}
                </Text>
                {selectedModel?.value ? (
                  <>
                    <Text dimColor>Model ID</Text>
                    <Text wrap="wrap">{selectedModel.value}</Text>
                    <ModelCopyButton
                      focused={focus === 'copy'}
                      pressed={pressedControl === MODEL_COPY_TARGET}
                      hovered={hoveredControl === MODEL_COPY_TARGET}
                      {...(onControlElement ? { onElement: onControlElement } : {})}
                    />
                  </>
                ) : null}
                {panel.slider ? (
                  <EffortSlider
                    slider={panel.slider}
                    width={26}
                    compact={false}
                    pressed={pressedSlider}
                    {...(hoveredSlider !== undefined ? { hovered: hoveredSlider } : {})}
                    focused={focus === 'effort'}
                    {...(onSliderElement ? { onElement: onSliderElement } : {})}
                  />
                ) : null}
              </Box>
            ) : null}
          </Box>
        ) : (
          <>
            <Box marginTop={compact ? 0 : 1} flexWrap={condensedFilters ? 'nowrap' : 'wrap'}>
              {condensedFilters ? <Text dimColor>Provider </Text> : null}
              {visibleFilters.map((item, index) => {
                const active = item.id === filter
                const pressed = item.id === pressedFilter
                return (
                  <Box
                    key={item.id}
                    ref={(element) => onFilterElement?.(item.id, element)}
                    backgroundColor={
                      item.id === hoveredFilter || pressed || (focus === 'providers' && active) ? selection : undefined
                    }
                  >
                    {index > 0 ? <Text dimColor>{condensedFilters ? ' ' : ' · '}</Text> : null}
                    <Text {...(pressed ? { color: hover } : active ? { color: accent } : {})} bold={active}>
                      {index === 0 && !condensedFilters ? '◆ ' : ''}
                      {condensedFilters && !active ? (item === previousFilter ? '‹' : '›') : item.label}
                    </Text>
                  </Box>
                )
              })}
            </Box>
            <Box marginTop={compact ? 0 : 1}>{modelRows}</Box>
          </>
        )}
      </Box>
    </PanelOverlay>
  )
}

function ModelCopyButton({
  compact,
  focused,
  pressed,
  hovered,
  onElement,
}: {
  compact?: boolean
  focused: boolean
  pressed: boolean
  hovered: boolean
  onElement?: (key: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent, hover, selection, surface } = useTheme()
  return (
    <Box
      ref={(element) => onElement?.(MODEL_COPY_TARGET, element)}
      width={compact ? 11 : 18}
      marginTop={compact ? 0 : 1}
      paddingX={1}
      backgroundColor={pressed || hovered || focused ? selection : surface}
    >
      <Text {...(pressed ? { color: hover } : focused ? { color: accent } : {})} bold={focused}>
        {focused ? '› ' : '  '}
        {compact ? 'Copy ID' : 'Copy model ID'}
      </Text>
    </Box>
  )
}

export function EffortSlider({
  slider,
  width,
  compact,
  pressed,
  hovered,
  focused,
  onElement,
}: {
  slider: ChatPanelSlider
  width: number
  compact: boolean
  pressed: boolean
  hovered?: boolean
  focused: boolean
  onElement?: (element: DOMElement | null) => void
}): ReactElement {
  const { accent, hover, selection } = useTheme()
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
  track.fill('█', thumbStart, thumbStart + 3)
  const ticks = Array.from({ length: width }, () => ' ')
  for (const position of positions) {
    ticks[position] = '│'
  }
  return (
    <Box marginTop={compact ? 0 : 1} flexDirection="column" alignItems="center">
      <Box>
        <Text dimColor>{slider.label} </Text>
        <Text
          {...(slider.disabled ? { dimColor: true } : { color: pressed ? hover : accent })}
          bold={slider.disabled !== true}
        >
          {activeOption?.label ?? 'Unavailable'}
        </Text>
      </Box>
      <Box
        ref={onElement}
        width={width}
        backgroundColor={hovered || pressed || focused ? selection : undefined}
        flexDirection="column"
      >
        <Text {...(slider.disabled ? { dimColor: true } : { color: accent })}>{track.join('')}</Text>
        {!compact ? <Text dimColor>{ticks.join('')}</Text> : null}
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
  const { hover, selection } = useTheme()
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
              backgroundColor={index === hovered || pressedRow || (focused && active) ? selection : undefined}
            >
              <Text wrap="truncate-end" {...(pressedRow && row.value ? { color: hover } : {})} bold={focused && active}>
                {row.label}
              </Text>
            </Box>
          )
        })
      )}
    </Box>
  )
}
