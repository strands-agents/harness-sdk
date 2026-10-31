import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'

import type { ChatPanel, ChatPanelRow } from '../chat/controller.js'
import type { FrogTheme } from '../chat/types.js'
import {
  PANEL_SECTION_BORDER_COLUMNS,
  PANEL_SECTION_PADDING_X,
  panelControlTarget,
  sectionedPanelSidebarWidth,
  type SettingsPanelFocus,
} from './interaction.js'
import type { PanelRowsProps } from './panel-components.js'
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
  focusActive = true,
  paintBackground = true,
  pressedRow,
  hoveredRow,
  pressedControl,
  hoveredControl,
  pressedFilter,
  hoveredFilter,
  onRowElement,
  onControlElement,
  onFilterElement,
  onCategoriesElement,
}: Omit<PanelRowsProps, 'panel' | 'onPanelElement'> & {
  panel: Extract<ChatPanel, { kind: 'settings' }>
  allRows: readonly ChatPanelRow[]
  height: number
  focus: SettingsPanelFocus
  focusActive?: boolean
  paintBackground?: boolean
  pressedControl?: string
  hoveredControl?: string
  pressedFilter?: string
  hoveredFilter?: string
  onControlElement?: (key: string, element: DOMElement | null) => void
  onFilterElement?: (id: string, element: DOMElement | null) => void
  onCategoriesElement?: (element: DOMElement | null) => void
}): ReactElement {
  const { accent, panel: panelColor, selection } = useTheme()
  const listWidth = sectionedPanelSidebarWidth(
    width,
    Math.max(0, ...(panel.filters ?? []).map(({ label }) => stringWidth(label))) + 5
  )
  const rowWidth = Math.max(1, width - listWidth - PANEL_SECTION_BORDER_COLUMNS - PANEL_SECTION_PADDING_X * 2)
  // Labels take what the widest control leaves, but at least half the row; the marker and gap add three columns.
  const labelWidth = Math.min(
    Math.max(0, ...allRows.map((row) => stringWidth(row.label))) + 3,
    Math.max(Math.floor(rowWidth / 2), rowWidth - Math.max(0, ...allRows.map(minimumControlWidth)))
  )
  const focused = focusActive && focus === 'settings'
  const sectionTitle =
    panel.filters?.find(({ id }) => id === `settings:${panel.settingsCategory}`)?.label ?? panel.settingsCategory
  return (
    <Box flexGrow={1} height={height} overflow="hidden">
      <PanelSectionList
        title="Settings"
        items={panel.filters ?? []}
        selected={`settings:${panel.settingsCategory}`}
        focused={focusActive && focus === 'categories'}
        width={listWidth}
        height={height}
        paintBackground={paintBackground}
        {...(onCategoriesElement ? { onSectionElement: onCategoriesElement } : {})}
        {...(pressedFilter ? { pressed: pressedFilter } : {})}
        {...(hoveredFilter ? { hovered: hoveredFilter } : {})}
        {...(onFilterElement ? { onElement: onFilterElement } : {})}
      />
      <PanelSection header={<Text dimColor>{sectionTitle}</Text>} focused={focused} height={height}>
        <Box flexGrow={1} flexDirection="column">
          {rows.map((row, visibleIndex) => {
            const index = start + visibleIndex
            const active = focused && index === selected
            const rowPressed = index === pressedRow
            const highlighted = active || rowPressed || (!paintBackground && index === hoveredRow)
            return (
              <Box
                key={`${panel.id}-setting-${index}`}
                ref={(element) => onRowElement?.(index, element)}
                width="100%"
                height={1}
                flexShrink={0}
                paddingX={PANEL_SECTION_PADDING_X}
                backgroundColor={paintBackground && (index === hoveredRow || rowPressed) ? selection : undefined}
              >
                <Box width={labelWidth} flexShrink={0} paddingRight={1} overflow="hidden">
                  <Text
                    wrap="truncate-end"
                    {...(highlighted ? { color: accent } : {})}
                    bold={active || (!paintBackground && highlighted)}
                  >
                    {active ? '› ' : '  '}
                    {row.label}
                  </Text>
                </Box>
                {row.control?.kind === 'toggle' ? (
                  <SettingToggle
                    checked={row.control.checked}
                    target={panelControlTarget(index, 'toggle')}
                    paintBackground={paintBackground}
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
                    paintBackground={paintBackground}
                    {...(pressedControl ? { pressedControl } : {})}
                    {...(hoveredControl ? { hoveredControl } : {})}
                    {...(onControlElement ? { onControlElement } : {})}
                  />
                ) : row.value ? (
                  <Box
                    flexShrink={1}
                    overflow="hidden"
                    backgroundColor={
                      paintBackground ? (rowPressed ? selection : active ? accent : selection) : undefined
                    }
                  >
                    <Text
                      {...(active ? { color: paintBackground ? panelColor : accent } : {})}
                      bold={active}
                      wrap="truncate-end"
                    >
                      {' '}
                      {row.description}{' '}
                    </Text>
                  </Box>
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
  if (!row.control && row.value) {
    return stringWidth(row.description) + 2
  }
  return row.control ? Math.max(...row.control.options.map((option) => stringWidth(option.label))) + 6 : 0
}

function SettingToggle({
  checked,
  target,
  paintBackground,
  pressedControl,
  hoveredControl,
  onControlElement,
}: {
  checked: boolean
  target: string
  paintBackground: boolean
  pressedControl?: string
  hoveredControl?: string
  onControlElement?: (key: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent, mode, selection } = useTheme()
  const highlighted = pressedControl === target || (!paintBackground && hoveredControl === target)
  return (
    <Box
      ref={(element) => onControlElement?.(target, element)}
      flexShrink={0}
      {...(paintBackground && (hoveredControl === target || pressedControl === target)
        ? { backgroundColor: hoverBackground(selection, mode) }
        : {})}
    >
      <Text
        {...(highlighted || checked ? { color: accent } : {})}
        bold={checked || (!paintBackground && highlighted)}
        dimColor={!checked && !highlighted}
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
  paintBackground,
  pressedControl,
  hoveredControl,
  onControlElement,
}: {
  control: SegmentedControl
  rowIndex: number
  width: number
  /** Renders each option as a swatch of the theme it names. */
  themeSwatches?: boolean
  paintBackground: boolean
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
        const background = paintBackground && option.active ? preview.accent : undefined
        const highlighted = pressed || hoveredControl === target
        const textColor =
          !paintBackground && (option.active || highlighted)
            ? preview.accent
            : option.active
              ? preview.panel
              : themeSwatches
                ? preview.accent
                : undefined
        return (
          <Box
            key={option.value}
            ref={(element) => onControlElement?.(target, element)}
            // Only an active option wider than the row shrinks; the visible window otherwise fits.
            flexShrink={1}
            overflow="hidden"
            marginLeft={visibleIndex > 0 ? 1 : 0}
            // Lightened so a hovered option stands out from its hovered row.
            {...(paintBackground && highlighted
              ? { backgroundColor: hoverBackground(background ?? current.selection, current.mode) }
              : background
                ? { backgroundColor: background }
                : {})}
          >
            <Text
              {...(pressed && !option.active ? { color: current.accent } : textColor ? { color: textColor } : {})}
              bold={option.active === true || (!paintBackground && highlighted)}
              dimColor={!themeSwatches && !option.active && !pressed && (paintBackground || !highlighted)}
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
  const { accent } = useTheme()
  const pressed = pressedControl === target
  const hovered = hoveredControl === target
  return (
    <Box ref={(element) => onControlElement?.(target, element)} flexShrink={0}>
      <Text {...(pressed || hovered ? { color: accent } : {})} dimColor={!pressed && !hovered}>
        {label}
      </Text>
    </Box>
  )
}

export function visibleOptions(
  widths: readonly number[],
  active: number,
  width: number,
  markerWidth = 2
): { start: number; end: number } {
  // Options are separated by one column, with a marker on each side that has hidden options.
  const fits = (start: number, end: number): boolean =>
    widths.slice(start, end).reduce((total, value) => total + value, end - start - 1) +
      (start > 0 ? markerWidth : 0) +
      (end < widths.length ? markerWidth : 0) <=
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

export function SettingsControl({
  pressedControl,
  hoveredControl,
  control,
  rowIndex,
  onControlElement,
}: {
  pressedControl?: string
  hoveredControl?: string
  control: NonNullable<ChatPanelRow['control']>
  rowIndex: number
  onControlElement?: (key: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent, selection } = useTheme()
  if (control.kind === 'toggle') {
    const target = panelControlTarget(rowIndex, 'toggle')
    const pressed = pressedControl === target
    return (
      <Box
        ref={(element) => onControlElement?.(target, element)}
        justifyContent="center"
        backgroundColor={hoveredControl === target ? selection : undefined}
      >
        <Text
          {...(control.checked || pressed ? { color: accent } : {})}
          bold={control.checked}
          dimColor={!control.checked}
        >
          {control.checked ? '━━●' : '●━━'}
        </Text>
      </Box>
    )
  }
  return (
    <Box flexWrap="wrap" justifyContent="center" flexShrink={1}>
      {control.options.map((option, index) => {
        const target = panelControlTarget(rowIndex, option.value)
        const pressed = pressedControl === target
        return (
          <Box
            key={option.value}
            ref={(element) => onControlElement?.(target, element)}
            marginLeft={index === 0 ? 0 : 1}
          >
            <Text
              inverse={option.active === true}
              {...(pressed || option.active ? { color: accent } : {})}
              dimColor={!option.active && !pressed}
              bold={false}
            >
              {' '}
              {option.label}{' '}
            </Text>
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
