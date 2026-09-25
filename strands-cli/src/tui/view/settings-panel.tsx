import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'

import type { ChatPanelRow } from '../chat/controller.js'
import type { ChatSettings, FrogTheme } from '../chat/types.js'
import { DEFAULT_CHAT_SETTINGS } from '../settings.js'
import { panelControlTarget, settingsLayout, settingsThemeLayout } from './interaction.js'
import { PanelItemHeader, PanelOverlay, PanelTitle, type PanelRowsProps } from './panel-components.js'
import { Box, getTheme, Text, useTheme, type Theme } from './theme.js'

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
  appearance,
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
  appearance?: Pick<ChatSettings, 'frogTheme' | 'colorMode' | 'customTheme'>
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
                {!panel.settingsCategory && row.section && row.section !== rows[visibleIndex - 1]?.section ? (
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
                        {...(appearance ? { appearance } : {})}
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
  appearance,
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
  appearance?: Pick<ChatSettings, 'frogTheme' | 'colorMode' | 'customTheme'>
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
        {...(appearance ? { appearance } : {})}
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
        const customTheme = setting === 'frogTheme' && option.value === 'custom'
        return (
          <Box
            key={option.value}
            ref={(element) => onControlElement?.(target, element)}
            marginLeft={spacious || index === 0 ? 0 : 1}
            {...(spacious ? { width: optionWidth, paddingRight: 1, backgroundColor: panel } : {})}
          >
            <Text
              inverse={!spacious && option.active === true && !customTheme}
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
              {customTheme && option.active ? '◆ ' : null}
              {customTheme ? <RainbowLabel label={option.label} /> : label}{' '}
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
  appearance,
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
  appearance?: Pick<ChatSettings, 'frogTheme' | 'colorMode' | 'customTheme'>
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
        const preview = getTheme(
          {
            frogTheme: option.value as FrogTheme,
            colorMode: current.mode,
            customTheme: appearance?.customTheme ?? DEFAULT_CHAT_SETTINGS.customTheme,
          },
          current.mode
        )
        const customTheme = option.value === 'custom'
        const background = option.active && !customTheme ? preview.accent : current.selection
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
                {customTheme && option.active ? <Text color={current.accent}>◆ </Text> : null}
                {customTheme ? <RainbowLabel label={option.label} /> : option.label}
              </Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function RainbowLabel({ label }: { label: string }): ReactElement {
  const { mode } = useTheme()
  const colors =
    mode === 'dark'
      ? ['#ff6b82', '#ffb454', '#ffe066', '#68f58a', '#5ad3f4', '#79aaff', '#c49bff']
      : ['#b42332', '#934600', '#766000', '#166534', '#006581', '#234e96', '#7036a8']
  return (
    <Text>
      {[...label].map((character, index) => (
        <Text key={`${character}-${index}`} color={colors[index % colors.length]!}>
          {character}
        </Text>
      ))}
    </Text>
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
