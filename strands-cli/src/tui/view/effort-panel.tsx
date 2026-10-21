import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'

import type { ChatPanelSlider } from '../chat/types.js'
import { PanelHelpFooter } from './help-footer.js'
import { EffortSlider } from './model-panel.js'
import { mixHexColors } from './fade-in.js'
import { hash01 } from './frog-drawing.js'
import { Box, Text, useTheme } from './theme.js'

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
