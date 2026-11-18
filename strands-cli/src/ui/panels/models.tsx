import { type ReactElement } from 'react'
import { type DOMElement } from 'ink'
import { type ChatModelPanel, type ChatPanelRow, type ChatPanelSlider } from '../chat/controller.js'
import {
  awsProfileItems,
  sectionedPanelSidebarWidth,
  trailingWindowStart,
  type ModelPanelFocus,
} from '../interaction.js'
import {
  PanelSearchHeader,
  badgeColor,
  type PanelRowsProps,
  PanelSection,
  PanelSectionList,
  ProviderList,
} from './shared.js'
import { Box, Text, useTheme } from '../theme.js'
import { useSpinner, mixHexColors } from '../animation.js'
import stringWidth from 'string-width'
import { PanelHelpFooter } from '../footer.js'
import { hash01 } from '../frog-drawing.js'

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
  profileSelected = 0,
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
  profileSelected?: number
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
  const profiles = awsProfileItems(panel, filter)
  const sidebarWidth = profiles.length
    ? Math.max(sectionedPanelSidebarWidth(width), Math.min(58, Math.floor(width / 2)))
    : sectionedPanelSidebarWidth(width)
  const contentWidth = Math.max(1, sidebarWidth - 4)
  const providerWidth = Math.max(1, Math.floor(contentWidth / 2))
  const profileWidth = Math.max(1, contentWidth - providerWidth)
  const capacity = Math.max(1, height - 4)
  const providerStart = trailingWindowStart(
    filters.findIndex((item) => item.id === filter),
    capacity,
    filters.length
  )
  const profileCapacity = Math.max(1, capacity - 1)
  const profileStart = trailingWindowStart(profileSelected, profileCapacity, profiles.length)
  const emptyMessage = query.trim()
    ? 'No matching models'
    : filter === 'all' || filter === 'current'
      ? 'No models available'
      : 'No models available. Configure this provider with /setup.'
  return (
    <Box flexGrow={1} height={height} overflow="hidden">
      {profiles.length ? (
        <PanelSection
          header={<Text dimColor>Providers</Text>}
          focused={focus === 'providers' || focus === 'profiles'}
          width={sidebarWidth}
          height={height}
        >
          <Box paddingX={1}>
            <Box width={providerWidth} flexShrink={0} flexDirection="column">
              <ProviderList
                items={filters.slice(providerStart, providerStart + capacity).map((item) => ({
                  ...item,
                  label: providerWidth < 25 && item.id === 'bedrock-mantle' ? 'Mantle' : item.label,
                }))}
                selected={filter}
                focused={focus === 'providers'}
                width={providerWidth}
                {...(pressedFilter ? { pressed: pressedFilter } : {})}
                {...(hoveredFilter ? { hovered: hoveredFilter } : {})}
                {...(onFilterElement ? { onElement: onFilterElement } : {})}
              />
            </Box>
            <Box width={profileWidth} flexShrink={0} flexDirection="column">
              <Text dimColor wrap="truncate-end">
                AWS profile
              </Text>
              <ProviderList
                items={profiles.slice(profileStart, profileStart + profileCapacity)}
                selected={profiles[profileSelected]?.id ?? 'aws-profile:toggle'}
                focused={focus === 'profiles'}
                width={profileWidth}
                {...(pressedFilter ? { pressed: pressedFilter } : {})}
                {...(hoveredFilter ? { hovered: hoveredFilter } : {})}
                {...(onFilterElement ? { onElement: onFilterElement } : {})}
              />
            </Box>
          </Box>
        </PanelSection>
      ) : (
        <PanelSectionList
          title="Providers"
          items={filters}
          selected={filter}
          focused={focus === 'providers'}
          width={sidebarWidth}
          height={height}
          {...(pressedFilter ? { pressed: pressedFilter } : {})}
          {...(hoveredFilter ? { hovered: hoveredFilter } : {})}
          {...(onFilterElement ? { onElement: onFilterElement } : {})}
        />
      )}
      <PanelSection
        focused={focus === 'models' || focus === 'search'}
        meta={
          allRows.length > rows.length
            ? `${start + 1}-${Math.min(start + rows.length, allRows.length)} / ${allRows.length}`
            : `${allRows.length}`
        }
        header={
          <PanelSearchHeader
            query={query}
            placeholder="Search models"
            focused={focus === 'search'}
            {...(onSearchElement ? { onElement: onSearchElement } : {})}
          />
        }
      >
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
      </PanelSection>
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
  paintBackground = true,
}: {
  slider: ChatPanelSlider
  width: number
  compact: boolean
  focused?: boolean
  onElement?: (element: DOMElement | null) => void
  showStops?: boolean
  paintBackground?: boolean
}): ReactElement {
  const { accent, selection } = useTheme()
  const highlightFocus = !paintBackground && focused && !slider.disabled
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
          <Text {...(highlightFocus ? { color: accent, bold: true } : { dimColor: true })}>{slider.label} </Text>
          <Text {...(slider.disabled ? { dimColor: true } : { color: accent })} bold={slider.disabled !== true}>
            {activeOption?.label ?? 'Unavailable'}
          </Text>
        </Box>
      ) : null}
      <Box
        ref={onElement}
        width={width}
        backgroundColor={paintBackground && !showStops && focused ? selection : undefined}
        flexDirection="column"
      >
        <Text {...(slider.disabled ? { dimColor: true } : { color: accent })} bold={highlightFocus}>
          {track.join('')}
        </Text>
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
  const { accent, selection } = useTheme()
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
                  {...(pressedRow && row.value ? { color: accent } : focused && active ? { color: accent } : {})}
                  bold={focused && active}
                >
                  {focused && active ? '› ' : '  '}
                  {row.label}
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
    </Box>
  )
}

export function EffortPanel({
  slider,
  body,
  width,
  height,
  energyFrame,
  onElement,
  onSliderElement,
}: {
  slider: ChatPanelSlider
  body?: string
  width: number
  height: number
  energyFrame: number
  onElement?: (element: DOMElement | null) => void
  onSliderElement?: (element: DOMElement | null) => void
}): ReactElement {
  const theme = useTheme()
  const [modelName = '', modelId = ''] = body?.split('\n') ?? []
  const contentWidth = Math.max(1, width)
  const model = modelName || modelId
  const showModel = model && stringWidth(`Reasoning effort · ${model}`) <= contentWidth
  const sliderWidth = Math.min(contentWidth, 60)
  const energized = isMaxEffort(slider)
  return (
    <Box
      ref={onElement}
      width={width}
      height={height}
      flexGrow={1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      overflow="hidden"
    >
      {energized ? <EffortEnergyField width={contentWidth} height={height} frame={energyFrame} /> : null}
      <Box width={contentWidth} justifyContent="center">
        <Text wrap="truncate-end">
          <Text bold color={theme.accent}>
            Reasoning effort
          </Text>
          {showModel ? <Text dimColor> · {model}</Text> : null}
        </Text>
      </Box>
      <EffortSlider
        slider={slider}
        width={sliderWidth}
        compact={false}
        showStops
        {...(onSliderElement ? { onElement: onSliderElement } : {})}
      />
      <Box marginTop={1} width={contentWidth}>
        <PanelHelpFooter width={contentWidth} centered />
      </Box>
    </Box>
  )
}

export function isMaxEffort(slider: ChatPanelSlider | undefined): boolean {
  return (
    slider?.options.some(
      (option) => option.active && (option.id.toLowerCase() === 'max' || option.label.toLowerCase() === 'max')
    ) === true
  )
}

function EffortEnergyField({ width, height, frame }: { width: number; height: number; frame: number }): ReactElement {
  const { accent, muted } = useTheme()
  if (width < 12 || height < 8) {
    return <></>
  }
  const glyphs = energyDischargeGlyphs(width, height, frame)
  return (
    <Box
      position="absolute"
      marginTop={0}
      marginLeft={0}
      width={width}
      height={height}
      alignSelf="flex-start"
      aria-hidden
    >
      {glyphs.map((glyph) => (
        <Box
          key={`${glyph.row}:${glyph.column}`}
          position="absolute"
          marginLeft={glyph.column}
          marginTop={glyph.row}
          width={1}
          height={1}
        >
          <Text color={mixHexColors(muted, accent, glyph.intensity)} bold={glyph.intensity > 0.78}>
            {glyph.character}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

interface EnergyGlyph {
  row: number
  column: number
  character: string
  intensity: number
}

function energyDischargeGlyphs(width: number, height: number, frame: number): EnergyGlyph[] {
  const glyphs = new Map<string, EnergyGlyph>()
  const phase = Math.floor(frame / 3)
  const arcCount = width >= 100 ? 3 : width >= 52 ? 2 : 1
  const zoneWidth = Math.floor(width / arcCount)
  const arcWidth = Math.max(8, Math.min(16, zoneWidth - 4))

  for (let zone = 0; zone < arcCount; zone += 1) {
    addEnergyArc(glyphs, {
      width,
      row: 0,
      column: energyArcColumn(zone, zoneWidth, arcWidth, phase, 17),
      length: arcWidth,
      phase,
      seed: zone * 31 + 7,
      mirrored: false,
    })
    addEnergyArc(glyphs, {
      width,
      row: height - 2,
      column: energyArcColumn(zone, zoneWidth, arcWidth, phase, 43),
      length: arcWidth,
      phase,
      seed: zone * 37 + 19,
      mirrored: true,
    })
  }
  return [...glyphs.values()]
}

function energyArcColumn(zone: number, zoneWidth: number, arcWidth: number, phase: number, seed: number): number {
  const available = Math.max(1, zoneWidth - arcWidth - 2)
  return zone * zoneWidth + 1 + Math.floor(hash01(phase * 5 + zone + seed) * available)
}

function addEnergyArc(
  glyphs: Map<string, EnergyGlyph>,
  {
    width,
    row,
    column,
    length,
    phase,
    seed,
    mirrored,
  }: {
    width: number
    row: number
    column: number
    length: number
    phase: number
    seed: number
    mirrored: boolean
  }
): void {
  let pathRow = hash01(seed + phase * 3) > 0.5 ? 1 : 0
  const hotspot = 2 + Math.floor(hash01(seed + phase * 7 + 11) * Math.max(1, length - 4))
  const branch = 1 + Math.floor(hash01(seed + phase * 11 + 23) * Math.max(1, length - 3))

  for (let offset = 0; offset < length && column + offset < width - 1; offset += 1) {
    const nextRow = hash01(seed + phase * 13 + offset * 17) > 0.56 ? 1 - pathRow : pathRow
    const displayRow = mirrored ? 1 - pathRow : pathRow
    const distance = Math.abs(offset - hotspot)
    const intensity = Math.min(1, 0.48 + Math.max(0, 1 - distance / 4) * 0.46 + hash01(seed + offset) * 0.12)
    const character =
      offset === hotspot
        ? phase % 2 === 0
          ? 'ϟ'
          : '✦'
        : pathRow === nextRow
          ? intensity > 0.75
            ? '━'
            : '─'
          : pathRow === 0
            ? mirrored
              ? '╱'
              : '╲'
            : mirrored
              ? '╲'
              : '╱'
    setEnergyGlyph(glyphs, {
      row: row + displayRow,
      column: column + offset,
      character,
      intensity,
    })

    if (offset === branch) {
      setEnergyGlyph(glyphs, {
        row: row + (mirrored ? pathRow : 1 - pathRow),
        column: column + offset,
        character: pathRow === 0 ? '╱' : '╲',
        intensity: 0.82,
      })
    }
    pathRow = nextRow
  }
}

function setEnergyGlyph(glyphs: Map<string, EnergyGlyph>, glyph: EnergyGlyph): void {
  const key = `${glyph.row}:${glyph.column}`
  if ((glyphs.get(key)?.intensity ?? 0) <= glyph.intensity) {
    glyphs.set(key, glyph)
  }
}
