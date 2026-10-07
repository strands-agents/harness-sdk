import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'

import type { ChatPanel, ChatPanelRow } from '../chat/controller.js'
import type { FrogTheme } from '../chat/types.js'
import {
  panelControlTarget,
  sectionedPanelSidebarWidth,
  settingsLayout,
  settingsThemeLayout,
  type SettingsPanelFocus,
} from './interaction.js'
import { PanelItemHeader, PanelOverlay, PanelTitle, type PanelRowsProps } from './panel-components.js'
import { PanelSection, PanelSectionList } from './panel-sections.js'
import { Box, getTheme, Text, useTheme, type Theme } from './theme.js'

type SegmentedControl = Extract<NonNullable<ChatPanelRow['control']>, { kind: 'segmented' }>

/** `/settings` inside the prompt editor: categories on the left, the category's settings on the right. */
export function SettingsPicker({
  panel,
  rows,
  allRows,
  selected,
  start,
  width,
  height,
  focus,
  pressedRow,
  hoveredRow,
  pressedControl,
  hoveredControl,
  pressedFilter,
  hoveredFilter,
  onRowElement,
  onControlElement,
  onFilterElement,
}: Omit<PanelRowsProps, 'panel' | 'onPanelElement'> & {
  panel: Extract<ChatPanel, { kind: 'settings' }>
  allRows: readonly ChatPanelRow[]
  height: number
  focus: SettingsPanelFocus
  pressedControl?: string
  hoveredControl?: string
  pressedFilter?: string
  hoveredFilter?: string
  onControlElement?: (key: string, element: DOMElement | null) => void
  onFilterElement?: (id: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent, hover, selection } = useTheme()
  const listWidth = sectionedPanelSidebarWidth(
    width,
    Math.max(0, ...(panel.filters ?? []).map(({ label }) => stringWidth(label))) + 5
  )
  // Section borders and row padding.
  const rowWidth = Math.max(1, width - listWidth - 4)
  // Labels take what the widest control leaves, but at least half the row; the marker and gap add three columns.
  const labelWidth = Math.min(
    Math.max(0, ...allRows.map((row) => stringWidth(row.label))) + 3,
    Math.max(Math.floor(rowWidth / 2), rowWidth - Math.max(0, ...allRows.map(minimumControlWidth)))
  )
  const focused = focus === 'settings'
  return (
    <Box flexGrow={1} height={height} overflow="hidden">
      <PanelSectionList
        title="Settings"
        items={panel.filters ?? []}
        selected={`settings:${panel.settingsCategory}`}
        focused={focus === 'categories'}
        width={listWidth}
        height={height}
        {...(pressedFilter ? { pressed: pressedFilter } : {})}
        {...(hoveredFilter ? { hovered: hoveredFilter } : {})}
        {...(onFilterElement ? { onElement: onFilterElement } : {})}
      />
      <PanelSection focused={focused} height={height}>
        <Box flexGrow={1} flexDirection="column" justifyContent="center">
          {rows.map((row, visibleIndex) => {
            const index = start + visibleIndex
            const active = focused && index === selected
            const rowPressed = index === pressedRow
            return (
              <Box
                key={`${panel.id}-setting-${index}`}
                ref={(element) => onRowElement?.(index, element)}
                width="100%"
                height={1}
                flexShrink={0}
                paddingX={1}
                backgroundColor={index === hoveredRow || rowPressed ? selection : undefined}
              >
                <Box width={labelWidth} flexShrink={0} paddingRight={1} overflow="hidden">
                  <Text
                    wrap="truncate-end"
                    {...(rowPressed ? { color: hover } : active ? { color: accent } : {})}
                    bold={active}
                  >
                    {active ? '› ' : '  '}
                    {row.label}
                  </Text>
                </Box>
                {row.control?.kind === 'toggle' ? (
                  <SettingToggle
                    checked={row.control.checked}
                    target={panelControlTarget(index, 'toggle')}
                    {...(pressedControl ? { pressedControl } : {})}
                    {...(hoveredControl ? { hoveredControl } : {})}
                    {...(onControlElement ? { onControlElement } : {})}
                  />
                ) : row.control ? (
                  <SettingOptions
                    control={row.control}
                    rowIndex={index}
                    width={Math.max(1, rowWidth - labelWidth)}
                    themeSwatches={row.value === 'frogTheme'}
                    {...(pressedControl ? { pressedControl } : {})}
                    {...(hoveredControl ? { hoveredControl } : {})}
                    {...(onControlElement ? { onControlElement } : {})}
                  />
                ) : null}
              </Box>
            )
          })}
        </Box>
      </PanelSection>
    </Box>
  )
}

// A toggle, or one option framed by both overflow markers.
function minimumControlWidth(row: ChatPanelRow): number {
  if (row.control?.kind === 'toggle') {
    return stringWidth(' ●━━ Off ')
  }
  return row.control ? Math.max(...row.control.options.map((option) => stringWidth(option.label))) + 6 : 0
}

function SettingToggle({
  checked,
  target,
  pressedControl,
  hoveredControl,
  onControlElement,
}: {
  checked: boolean
  target: string
  pressedControl?: string
  hoveredControl?: string
  onControlElement?: (key: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent, hover, mode, selection } = useTheme()
  return (
    <Box
      ref={(element) => onControlElement?.(target, element)}
      flexShrink={0}
      {...(hoveredControl === target || pressedControl === target
        ? { backgroundColor: hoverBackground(selection, mode) }
        : {})}
    >
      <Text
        {...(pressedControl === target ? { color: hover } : checked ? { color: accent } : {})}
        bold={checked}
        dimColor={!checked && pressedControl !== target}
      >
        {checked ? ' ━━● On ' : ' ●━━ Off '}
      </Text>
    </Box>
  )
}

/** One row of options that scrolls to keep the active option in view when they do not all fit. */
function SettingOptions({
  control,
  rowIndex,
  width,
  themeSwatches = false,
  pressedControl,
  hoveredControl,
  onControlElement,
}: {
  control: SegmentedControl
  rowIndex: number
  width: number
  /** Renders each option as a swatch of the theme it names. */
  themeSwatches?: boolean
  pressedControl?: string
  hoveredControl?: string
  onControlElement?: (key: string, element: DOMElement | null) => void
}): ReactElement {
  const current = useTheme()
  const active = Math.max(
    0,
    control.options.findIndex((option) => option.active)
  )
  const { start, end } = visibleOptions(
    control.options.map((option) => stringWidth(option.label) + 2),
    active,
    width
  )
  return (
    <Box flexShrink={1} overflow="hidden">
      {start > 0 ? (
        <OverflowMarker
          label="‹ "
          target={panelControlTarget(rowIndex, control.options[start - 1]!.value)}
          {...(pressedControl ? { pressedControl } : {})}
          {...(hoveredControl ? { hoveredControl } : {})}
          {...(onControlElement ? { onControlElement } : {})}
        />
      ) : null}
      {control.options.slice(start, end).map((option, visibleIndex) => {
        const target = panelControlTarget(rowIndex, option.value)
        const pressed = pressedControl === target
        // A theme option previews its own accent.
        const preview = themeSwatches ? getTheme({ frogTheme: option.value as FrogTheme }, current.mode) : current
        const background = option.active ? preview.accent : undefined
        const highlighted = pressed || hoveredControl === target
        const textColor = option.active ? preview.panel : themeSwatches ? preview.accent : undefined
        return (
          <Box
            key={option.value}
            ref={(element) => onControlElement?.(target, element)}
            // Only an active option wider than the row shrinks; the visible window otherwise fits.
            flexShrink={1}
            overflow="hidden"
            marginLeft={visibleIndex > 0 ? 1 : 0}
            // Lightened so a hovered option stands out from its hovered row.
            {...(highlighted
              ? { backgroundColor: hoverBackground(background ?? current.selection, current.mode) }
              : background
                ? { backgroundColor: background }
                : {})}
          >
            <Text
              {...(pressed ? { color: current.hover } : textColor ? { color: textColor } : {})}
              bold={option.active === true}
              dimColor={!themeSwatches && !option.active && !pressed}
              wrap="truncate-end"
            >
              {' '}
              {option.label}{' '}
            </Text>
          </Box>
        )
      })}
      {end < control.options.length ? (
        <OverflowMarker
          label=" ›"
          target={panelControlTarget(rowIndex, control.options[end]!.value)}
          {...(pressedControl ? { pressedControl } : {})}
          {...(hoveredControl ? { hoveredControl } : {})}
          {...(onControlElement ? { onControlElement } : {})}
        />
      ) : null}
    </Box>
  )
}

/** Steps to the nearest hidden option on its side. */
function OverflowMarker({
  label,
  target,
  pressedControl,
  hoveredControl,
  onControlElement,
}: {
  label: string
  target: string
  pressedControl?: string
  hoveredControl?: string
  onControlElement?: (key: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent, hover } = useTheme()
  const pressed = pressedControl === target
  const hovered = hoveredControl === target
  return (
    <Box ref={(element) => onControlElement?.(target, element)} flexShrink={0}>
      <Text {...(pressed ? { color: hover } : hovered ? { color: accent } : {})} dimColor={!pressed && !hovered}>
        {label}
      </Text>
    </Box>
  )
}

function visibleOptions(widths: readonly number[], active: number, width: number): { start: number; end: number } {
  // Options are separated by one column; hidden options cost a two-column marker on that side.
  const fits = (start: number, end: number): boolean =>
    widths.slice(start, end).reduce((total, value) => total + value, end - start - 1) +
      (start > 0 ? 2 : 0) +
      (end < widths.length ? 2 : 0) <=
    width
  let start = active
  let end = Math.min(widths.length, active + 1)
  // Grow one option per side per pass so the active option stays near the middle.
  for (let grew = true; grew;) {
    grew = false
    if (end < widths.length && fits(start, end + 1)) {
      end++
      grew = true
    }
    if (start > 0 && fits(start - 1, end)) {
      start--
      grew = true
    }
  }
  return { start, end }
}

export function SettingsPanel({
  panel,
  rows,
  selected,
  start,
  width,
  pressedRow,
  hoveredRow,
  pressedControl,
  hoveredControl,
  pressedFilter,
  hoveredFilter,
  embedded = false,
  height,
  onPanelElement,
  onRowElement,
  onControlElement,
  onFilterElement,
}: PanelRowsProps & {
  pressedControl?: string
  hoveredControl?: string
  pressedFilter?: string
  hoveredFilter?: string
  embedded?: boolean
  height?: number
  onControlElement?: (key: string, element: DOMElement | null) => void
  onFilterElement?: (id: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent, error, hover, selection, surface, foreground } = useTheme()
  const settings = panel.kind === 'settings'
  const wide = settings && panel.settingsCategory !== undefined && width >= 90
  const detailWidth = wide ? width - 24 : width
  const { contentWidth, labelWidth: defaultLabelWidth } = settingsLayout(detailWidth)
  const compact = settings && height !== undefined && height < 18
  const themeRows = Math.max(1, Math.floor(((height ?? 24) - (embedded ? (compact ? 3 : 6) : 8)) / 3))
  const content = (
    <Box flexDirection="column" overflow="hidden">
      <Box paddingX={settings ? 0 : 1} justifyContent="space-between">
        {settings ? (
          <Text color={accent} bold>
            Settings
          </Text>
        ) : (
          <PanelTitle title={panel.title} color={accent} />
        )}
        {panel.rows.length > rows.length ? (
          <Text dimColor>
            {selected + 1}/{panel.rows.length}
          </Text>
        ) : null}
      </Box>
      <Box marginTop={settings && !compact ? 1 : 0} flexDirection={wide ? 'row' : 'column'} overflow="hidden">
        {wide ? (
          <Box width={22} marginRight={2} flexDirection="column" flexShrink={0}>
            {panel.settingsCategories?.map((item) => {
              const target = `settings:${item.id}`
              const active = item.id === panel.settingsCategory
              const pressed = target === pressedFilter
              const hovered = target === hoveredFilter
              return (
                <Box
                  key={item.id}
                  ref={(element) => onFilterElement?.(target, element)}
                  height={3}
                  paddingX={1}
                  alignItems="center"
                  backgroundColor={active || pressed || hovered ? selection : undefined}
                >
                  <PanelItemHeader label={item.label} active={active} pressed={pressed} clickable />
                </Box>
              )
            })}
          </Box>
        ) : null}
        <Box width={contentWidth} alignSelf={wide ? 'flex-start' : 'center'} flexDirection="column" overflow="hidden">
          {settings && panel.settingsCategory ? (
            <Text color={accent} bold>
              {panel.title}
            </Text>
          ) : null}
          {rows.map((row, visibleIndex) => {
            const { columns, optionWidth, labelWidth } = settingsLayout(detailWidth, row.value)
            const index = start + visibleIndex
            const selectedRow = index === selected
            const rowPressed = index === pressedRow
            const themeRow = settings && row.value === 'frogTheme'
            const {
              columns: themeColumns,
              optionWidth: themeOptionWidth,
              optionHeight: themeOptionHeight,
              offset: themeOffset,
            } = settingsThemeLayout(detailWidth)
            if (panel.kind === 'voice' && (row.value === 'voice:start' || row.value === 'voice:stop')) {
              const stopping = row.value === 'voice:stop'
              return (
                <Box
                  key={`${panel.id}-${index}`}
                  ref={(element) => onRowElement?.(index, element)}
                  flexDirection="column"
                  alignItems="center"
                >
                  <Box
                    height={3}
                    paddingX={4}
                    alignItems="center"
                    backgroundColor={
                      rowPressed
                        ? selection
                        : selectedRow
                          ? stopping
                            ? error
                            : accent
                          : index === hoveredRow
                            ? selection
                            : surface
                    }
                  >
                    <Text color={rowPressed ? hover : selectedRow ? surface : stopping ? error : foreground} bold>
                      {row.label}
                    </Text>
                  </Box>
                  <Text dimColor>{row.description}</Text>
                </Box>
              )
            }
            return (
              <Box
                key={`${panel.id}-${index}`}
                flexDirection="column"
                {...(settings ? { width: contentWidth, alignSelf: 'center' } : {})}
              >
                {!(settings && panel.settingsCategory) &&
                row.section &&
                row.section !== rows[visibleIndex - 1]?.section ? (
                  <Box
                    paddingX={settings ? 0 : 1}
                    marginTop={settings ? (visibleIndex > 0 ? 2 : 1) : visibleIndex > 0 ? 1 : 0}
                  >
                    <Text dimColor bold>
                      {row.section}
                    </Text>
                  </Box>
                ) : null}
                <Box
                  ref={(element) => onRowElement?.(index, element)}
                  paddingX={settings ? 0 : 1}
                  marginTop={settings && !compact ? 1 : 0}
                  flexDirection={themeRow ? 'column' : 'row'}
                  justifyContent={settings ? 'flex-start' : 'space-between'}
                  backgroundColor={
                    !settings && (index === hoveredRow || rowPressed || selectedRow) ? selection : undefined
                  }
                >
                  {settings ? (
                    <Box width={themeRow ? contentWidth : labelWidth} flexShrink={0} alignItems="center">
                      <Text
                        {...(rowPressed ? { color: hover } : selectedRow ? { color: accent } : {})}
                        bold={selectedRow}
                        wrap="wrap"
                      >
                        {row.label}
                      </Text>
                    </Box>
                  ) : (
                    <PanelItemHeader
                      label={row.label}
                      active={selectedRow}
                      pressed={rowPressed}
                      clickable={row.value !== undefined}
                    />
                  )}
                  <Box
                    {...(settings
                      ? {
                          width: themeRow ? contentWidth : contentWidth - labelWidth,
                          justifyContent: 'center',
                          ...(themeRow
                            ? {
                                marginTop: compact ? 0 : 1,
                                paddingLeft: themeOffset,
                                justifyContent: 'flex-start',
                              }
                            : {
                                paddingRight: Math.min(
                                  Math.max(0, labelWidth - defaultLabelWidth),
                                  Math.max(0, contentWidth - labelWidth - 10)
                                ),
                              }),
                        }
                      : {})}
                  >
                    {row.control ? (
                      <SettingsControl
                        {...(pressedControl ? { pressedControl } : {})}
                        {...(hoveredControl ? { hoveredControl } : {})}
                        control={row.control}
                        rowIndex={index}
                        spacious={settings}
                        {...(row.value ? { setting: row.value } : {})}
                        {...(themeRow ? { maxThemeRows: themeRows } : {})}
                        {...(settings
                          ? {
                              columns: themeRow ? themeColumns : columns,
                              optionWidth: themeRow ? themeOptionWidth : optionWidth,
                              ...(themeRow ? { themeOptionHeight } : {}),
                            }
                          : {})}
                        {...(onControlElement ? { onControlElement } : {})}
                      />
                    ) : (
                      <Text dimColor wrap="truncate-end">
                        {row.description}
                      </Text>
                    )}
                  </Box>
                </Box>
              </Box>
            )
          })}
        </Box>
      </Box>
    </Box>
  )
  return embedded ? (
    content
  ) : (
    <PanelOverlay width={width} {...(onPanelElement ? { onElement: onPanelElement } : {})}>
      {content}
    </PanelOverlay>
  )
}

export function SettingsControl({
  pressedControl,
  hoveredControl,
  control,
  rowIndex,
  setting,
  spacious = false,
  columns = 1,
  optionWidth = 14,
  themeOptionHeight,
  maxThemeRows,
  onControlElement,
}: {
  pressedControl?: string
  hoveredControl?: string
  control: NonNullable<ChatPanelRow['control']>
  rowIndex: number
  setting?: string
  spacious?: boolean
  columns?: number
  optionWidth?: number
  themeOptionHeight?: number
  maxThemeRows?: number
  onControlElement?: (key: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent, hover, selection, panel, mode } = useTheme()
  if (control.kind === 'toggle') {
    const target = panelControlTarget(rowIndex, 'toggle')
    const pressed = pressedControl === target
    const background = control.checked ? accent : selection
    return (
      <Box
        ref={(element) => onControlElement?.(target, element)}
        width={spacious ? 14 : undefined}
        justifyContent="center"
        backgroundColor={
          spacious
            ? hoveredControl === target || pressed
              ? hoverBackground(background, mode)
              : background
            : hoveredControl === target
              ? selection
              : undefined
        }
      >
        <Text
          {...(spacious && control.checked
            ? { color: panel }
            : control.checked
              ? { color: accent }
              : pressed
                ? { color: hover }
                : {})}
          bold={control.checked}
          dimColor={!control.checked && !spacious}
        >
          {spacious ? (control.checked ? ' On    ━━● ' : ' Off   ●━━ ') : control.checked ? '━━●' : '●━━'}
        </Text>
      </Box>
    )
  }
  if (spacious && setting === 'frogTheme') {
    return (
      <ThemeChoices
        control={control}
        rowIndex={rowIndex}
        columns={columns}
        optionWidth={optionWidth}
        {...(themeOptionHeight !== undefined ? { optionHeight: themeOptionHeight } : {})}
        {...(maxThemeRows !== undefined ? { maxRows: maxThemeRows } : {})}
        {...(pressedControl ? { pressedControl } : {})}
        {...(hoveredControl ? { hoveredControl } : {})}
        {...(onControlElement ? { onControlElement } : {})}
      />
    )
  }
  return (
    <Box
      flexWrap="wrap"
      justifyContent={spacious && control.options.length > columns ? 'flex-start' : 'center'}
      flexShrink={1}
      {...(spacious ? { width: columns * optionWidth } : {})}
    >
      {control.options.map((option, index) => {
        const target = panelControlTarget(rowIndex, option.value)
        const pressed = pressedControl === target
        const hovered = hoveredControl === target
        const background = option.active ? (pressed ? hover : accent) : selection
        const label = spacious
          ? option.label.padStart((optionWidth - 3 + option.label.length) / 2).padEnd(optionWidth - 3)
          : option.label
        return (
          <Box
            key={option.value}
            ref={(element) => onControlElement?.(target, element)}
            marginLeft={spacious || index === 0 ? 0 : 1}
            {...(spacious ? { width: optionWidth, paddingRight: 1, backgroundColor: panel } : {})}
          >
            <Text
              inverse={!spacious && option.active === true}
              {...(spacious ? { backgroundColor: hovered ? hoverBackground(background, mode) : background } : {})}
              {...(spacious && option.active
                ? { color: panel }
                : pressed
                  ? { color: hover }
                  : option.active
                    ? { color: accent }
                    : {})}
              dimColor={!spacious && !option.active && !pressed}
              bold={spacious && option.active === true}
            >
              {' '}
              {label}{' '}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

function ThemeChoices({
  control,
  rowIndex,
  columns,
  optionWidth,
  optionHeight = 3,
  maxRows,
  pressedControl,
  hoveredControl,
  onControlElement,
}: {
  control: Extract<NonNullable<ChatPanelRow['control']>, { kind: 'segmented' }>
  rowIndex: number
  columns: number
  optionWidth: number
  optionHeight?: number
  maxRows?: number
  pressedControl?: string
  hoveredControl?: string
  onControlElement?: (key: string, element: DOMElement | null) => void
}): ReactElement {
  const current = useTheme()
  const active = Math.max(
    0,
    control.options.findIndex((option) => option.active)
  )
  const visibleCount = Math.min(control.options.length, Math.max(1, (maxRows ?? Infinity) * columns))
  const start = Math.max(0, Math.min(active - Math.floor(visibleCount / 2), control.options.length - visibleCount))
  const options = control.options.slice(start, start + visibleCount)
  return (
    <Box width={columns * optionWidth} flexWrap="wrap">
      {options.map((option) => {
        const target = panelControlTarget(rowIndex, option.value)
        const pressed = pressedControl === target
        const hovered = hoveredControl === target
        const preview = getTheme({ frogTheme: option.value as FrogTheme }, current.mode)
        const background = option.active ? preview.accent : current.selection
        return (
          <Box key={option.value} width={optionWidth} height={optionHeight} paddingRight={1}>
            <Box
              ref={(element) => onControlElement?.(target, element)}
              width={Math.max(1, optionWidth - 1)}
              height={optionHeight}
              paddingX={optionWidth >= 12 ? 1 : 0}
              alignItems="center"
              justifyContent="center"
              backgroundColor={hovered || pressed ? hoverBackground(background, preview.mode) : background}
            >
              <Text color={option.active ? preview.panel : preview.accent} bold>
                {option.label}
              </Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function hoverBackground(color: string, mode: Theme['mode']): string {
  const channels = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(color)
  if (!channels) {
    return color
  }
  return `#${channels
    .slice(1)
    .map((channel) => {
      const value = Number.parseInt(channel, 16)
      return Math.round(value + ((mode === 'light' ? 0 : 255) - value) * 0.2)
        .toString(16)
        .padStart(2, '0')
    })
    .join('')}`
}
