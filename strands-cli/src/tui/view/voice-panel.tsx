import { useEffect, useState, type ReactElement } from 'react'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'

import type { ChatPanelRow } from '../chat/controller.js'
import { panelControlTarget } from './interaction.js'
import { EffortSlider } from './model-panel.js'
import { PanelSection } from './panel-sections.js'
import { visibleOptions } from './settings-panel.js'
import { Box, Text, useTheme } from './theme.js'

interface VoiceInteraction {
  selected: number
  pressedRow?: number
  hoveredRow?: number
  pressedControl?: string
  hoveredControl?: string
  onRowElement?: (index: number, element: DOMElement | null) => void
  onControlElement?: (key: string, element: DOMElement | null) => void
  onSliderElement?: (element: DOMElement | null) => void
}

interface VoiceRow {
  index: number
  row: ChatPanelRow
  height: number
  gap: number
}

export function VoicePanel({
  title,
  rows,
  width,
  height,
  ...interaction
}: VoiceInteraction & {
  title: string
  rows: readonly ChatPanelRow[]
  width: number
  height: number
}): ReactElement {
  const indexed = rows.map((row, index) => ({ row, index }))
  const controls = indexed.filter(({ row }) => row.section !== 'Voice' && row.section !== 'Model')
  const voices = indexed.filter(({ row }) => row.section === 'Voice' || row.section === 'Model')
  const controlsWidth =
    width < 64
      ? Math.max(1, Math.floor(width * 0.45))
      : Math.min(Math.floor(width / 2), Math.max(34, Math.floor(width / 3)))
  return (
    <Box width={width} height={height} overflow="hidden">
      <VoiceSection title={title} rows={controls} width={controlsWidth} height={height} {...interaction} />
      <VoiceSection title="Speaker" rows={voices} width={width - controlsWidth} height={height} {...interaction} />
    </Box>
  )
}

function VoiceSection({
  title,
  rows,
  width,
  height,
  selected,
  ...interaction
}: VoiceInteraction & {
  title: string
  rows: readonly Pick<VoiceRow, 'index' | 'row'>[]
  width: number
  height: number
}): ReactElement {
  const { accent } = useTheme()
  const [viewportStart, setViewportStart] = useState(0)
  const contentWidth = Math.max(1, width - 4)
  const capacity = Math.max(1, height - 4)
  const outlined = contentWidth >= 27 && capacity >= 10
  const layout = rows.map(({ row, index }, position): VoiceRow => {
    const action = row.value === 'voice:enabled'
    const endpointing = row.value === 'voice:endpointing'
    const provider = row.value === 'voice:provider'
    const stackedToggle = row.control?.kind === 'toggle' && contentWidth < 26
    const rowHeight = action
      ? Math.min(3, capacity)
      : endpointing
        ? outlined
          ? 4
          : 2
        : provider && outlined
          ? 3
          : stackedToggle
            ? 2
            : !row.value
              ? Math.min(2, capacity)
              : 1
    return {
      row,
      index,
      height: Math.min(rowHeight, capacity),
      gap:
        capacity >= 10 && position < rows.length - 1 && (action || provider || row.control?.kind === 'toggle') ? 1 : 0,
    }
  })
  const window = rowWindow(layout, selected, capacity, viewportStart)
  useEffect(() => setViewportStart(window.start), [window.start])
  const meta = [
    window.start > 0 ? `↑${window.start}` : '',
    window.end < rows.length ? `↓${rows.length - window.end}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <PanelSection
      focused={rows.some(({ index }) => index === selected)}
      width={width}
      height={height}
      header={
        <Text bold color={accent}>
          {title}
        </Text>
      }
      {...(meta ? { meta } : {})}
    >
      <Box paddingX={1} flexDirection="column" overflow="hidden">
        {layout.slice(window.start, window.end).map((entry) => (
          <VoiceControlRow
            key={entry.row.value === 'voice:voice' ? entry.row.label : (entry.row.value ?? 'detail')}
            entry={entry}
            width={contentWidth}
            outlined={outlined}
            selected={selected}
            {...interaction}
          />
        ))}
      </Box>
    </PanelSection>
  )
}

function VoiceControlRow({
  entry: { row, index, height, gap },
  width,
  outlined,
  selected,
  pressedRow,
  hoveredRow,
  pressedControl,
  hoveredControl,
  onRowElement,
  onControlElement,
  onSliderElement,
}: VoiceInteraction & { entry: VoiceRow; width: number; outlined: boolean }): ReactElement {
  const theme = useTheme()
  const focused = index === selected
  const highlighted = focused || index === pressedRow || index === hoveredRow
  const action = row.value === 'voice:enabled'
  const endpointing = row.value === 'voice:endpointing'
  const provider = row.value === 'voice:provider'
  const toggle = row.control?.kind === 'toggle' ? row.control : undefined
  const stacked = endpointing || (toggle !== undefined && height > 1)
  const language = row.value === 'voice:voice'
  const narrow = width < 28
  const label = endpointing
    ? width < 15
      ? 'Turn end'
      : 'End of turn'
    : toggle
      ? width < 26
        ? 'Replies'
        : 'Spoken replies'
      : provider
        ? narrow
          ? ''
          : 'Provider'
        : row.section === 'Model'
          ? narrow
            ? ''
            : 'Model'
          : narrow && language
            ? compactLanguage(row.label)
            : row.label
  const labelWidth = !label ? 0 : stacked ? width : Math.min(narrow && !toggle ? 6 : 16, Math.max(1, width - 9))
  const controlWidth = stacked ? width : Math.max(1, width - labelWidth)
  const labelElement = label ? (
    <Box width={labelWidth} height={1} flexShrink={0} overflow="hidden">
      <Text color={highlighted ? theme.accent : theme.foreground} bold={focused} wrap="truncate-end">
        {focused ? '› ' : '  '}
        {label}
      </Text>
    </Box>
  ) : null
  const options =
    row.control?.kind === 'segmented' ? (
      <VoiceOptions
        control={row.control}
        rowIndex={index}
        width={controlWidth}
        outlined={outlined && (provider || endpointing)}
        {...(pressedControl ? { pressedControl } : {})}
        {...(hoveredControl ? { hoveredControl } : {})}
        {...(onControlElement ? { onControlElement } : {})}
      />
    ) : null
  const toggleTarget = panelControlTarget(index, 'toggle')
  const toggleHighlighted = highlighted || pressedControl === toggleTarget || hoveredControl === toggleTarget
  return (
    <Box
      ref={(element) => onRowElement?.(index, element)}
      width={width}
      height={height}
      marginBottom={gap}
      flexShrink={0}
      flexDirection={stacked ? 'column' : 'row'}
      alignItems={stacked ? 'flex-start' : 'center'}
      overflow="hidden"
    >
      {action && row.control?.kind === 'segmented' ? (
        <Box width={width} justifyContent="center">
          <EffortSlider
            slider={{
              label: 'Voice',
              options: row.control.options.map((option) => ({ id: option.value, ...option })),
            }}
            width={Math.max(5, Math.min(24, width - 2))}
            compact
            showStops
            focused={highlighted}
            paintBackground={false}
            {...(onSliderElement ? { onElement: onSliderElement } : {})}
          />
        </Box>
      ) : !row.value ? (
        <Text color={theme.error} wrap="wrap">
          {row.description}
        </Text>
      ) : (
        <>
          {labelElement}
          {toggle ? (
            <Box ref={(element) => onControlElement?.(toggleTarget, element)} width={9} flexShrink={0}>
              <Text
                color={toggle.checked || toggleHighlighted ? theme.accent : theme.foreground}
                bold={toggle.checked || toggleHighlighted}
              >
                {toggle.checked ? ' ━━● On ' : ' ●━━ Off'}
              </Text>
            </Box>
          ) : (
            (options ?? (
              <Box width={controlWidth} height={1} overflow="hidden">
                <Box flexShrink={0}>
                  <Text color={theme.foreground} bold wrap="truncate-end">
                    {narrow && focused ? '› ' : ''}
                    {row.label}
                  </Text>
                </Box>
                {row.description && controlWidth >= stringWidth(row.label) + 10 ? (
                  <Box marginLeft={1} flexShrink={1} overflow="hidden">
                    <Text dimColor wrap="truncate-end">
                      {row.description}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            ))
          )}
        </>
      )}
    </Box>
  )
}

function VoiceOptions({
  control,
  rowIndex,
  width,
  outlined,
  pressedControl,
  hoveredControl,
  onControlElement,
}: Pick<VoiceInteraction, 'pressedControl' | 'hoveredControl' | 'onControlElement'> & {
  control: Extract<NonNullable<ChatPanelRow['control']>, { kind: 'segmented' }>
  rowIndex: number
  width: number
  outlined: boolean
}): ReactElement {
  const { accent, foreground, border } = useTheme()
  const padding = outlined && width >= 33 ? 1 : 0
  const optionWidths = control.options.map((option) => stringWidth(option.label) + 2 + padding * 2)
  const active = Math.max(
    0,
    control.options.findIndex((option) => option.active)
  )
  const { start, end } = visibleOptions(optionWidths, active, width, 1)
  const markerWidth = Number(start > 0) + Number(end < control.options.length)
  const marker = (index: number, label: string): ReactElement => {
    const target = panelControlTarget(rowIndex, control.options[index]!.value)
    return (
      <Box ref={(element) => onControlElement?.(target, element)} width={1} flexShrink={0}>
        <Text color={pressedControl === target || hoveredControl === target ? accent : border}>{label}</Text>
      </Box>
    )
  }
  return (
    <Box width={width} height={outlined ? 3 : 1} flexShrink={0} alignItems="center" overflow="hidden">
      {start > 0 ? marker(start - 1, '‹') : null}
      {control.options.slice(start, end).map((option, visibleIndex) => {
        const target = panelControlTarget(rowIndex, option.value)
        const highlighted = pressedControl === target || hoveredControl === target || option.active
        return (
          <Box
            key={option.value}
            ref={(element) => onControlElement?.(target, element)}
            marginLeft={visibleIndex ? 1 : 0}
            width={Math.min(optionWidths[start + visibleIndex]!, Math.max(1, width - markerWidth))}
            height={outlined ? 3 : 1}
            flexShrink={0}
            {...(outlined
              ? { borderStyle: 'single' as const, borderColor: highlighted ? accent : border, paddingX: padding }
              : {})}
            justifyContent="center"
            alignItems="center"
            overflow="hidden"
          >
            <Text color={highlighted ? accent : foreground} bold={Boolean(highlighted)} wrap="truncate-end">
              {outlined ? option.label : `[${option.label}]`}
            </Text>
          </Box>
        )
      })}
      {end < control.options.length ? marker(end, '›') : null}
    </Box>
  )
}

function compactLanguage(label: string): string {
  return (
    (
      {
        'English (US)': 'US',
        'English (GB)': 'GB',
        French: 'FR',
        Italian: 'IT',
        German: 'DE',
        Spanish: 'ES',
        OpenAI: 'AI',
      } as Record<string, string>
    )[label] ?? label
  )
}

function rowWindow(
  rows: readonly VoiceRow[],
  selected: number,
  capacity: number,
  previousStart: number
): { start: number; end: number } {
  const cost = (index: number): number => rows[index]!.height + rows[index]!.gap
  const endAt = (start: number): number => {
    let used = 0
    let end = start
    while (end < rows.length && used + rows[end]!.height <= capacity) {
      used += cost(end++)
    }
    return end
  }
  const focused = rows.findIndex(({ index }) => index === selected)
  let start = Math.min(previousStart, Math.max(0, rows.length - 1))
  if (focused >= 0 && focused < start) start = focused
  if (focused >= endAt(start)) {
    start = focused
    while (start > 0 && endAt(start - 1) > focused) start--
  }
  while (start > 0 && endAt(start - 1) === rows.length) start--
  return { start, end: endAt(start) }
}
