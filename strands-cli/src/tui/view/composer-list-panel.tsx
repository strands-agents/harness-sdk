import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'

import type { ChatPanelRow } from '../chat/controller.js'
import { PanelHelpFooter } from './help-footer.js'
import { badgeColor, TONE_COLORS, type PanelRowsProps } from './panel-components.js'
import { PanelSection } from './panel-sections.js'
import { SettingsControl } from './settings-panel.js'
import { Cursor } from './text-input.js'
import { Box, Text, useTheme } from './theme.js'

export function ComposerListPanel({
  panel,
  rows,
  allRows,
  selected,
  start,
  width,
  height,
  query,
  searchFocused = true,
  pressedRow,
  hoveredRow,
  pressedControl,
  hoveredControl,
  onPanelElement,
  onRowElement,
  onControlElement,
}: PanelRowsProps & {
  allRows: readonly ChatPanelRow[]
  height: number
  query: string
  searchFocused?: boolean
  pressedControl?: string
  hoveredControl?: string
  onControlElement?: (key: string, element: DOMElement | null) => void
}): ReactElement {
  const { accent, selection } = useTheme()
  const meta =
    allRows.length > rows.length
      ? `${start + 1}-${Math.min(start + rows.length, allRows.length)} / ${allRows.length}`
      : `${allRows.length}`
  const searchLabel = panel.kind === 'mcp' ? 'Search MCP servers' : 'Search skills'
  const describedTool = hoveredRow ?? selected
  const labelWidth = Math.max(4, Math.min(32, width - 8, Math.max(...rows.map((row) => stringWidth(row.label) + 2))))
  // Fixed-width badge column so per-row state labels of different lengths stay aligned.
  const badgeWidth = Math.max(0, ...rows.map((row) => (row.badge ? stringWidth(row.badge.text) : 0)))

  return (
    <Box ref={onPanelElement} width={width} height={height} flexDirection="column" overflow="hidden">
      <PanelSection
        focused
        height={Math.max(1, height - 1)}
        meta={meta}
        header={
          <Text dimColor wrap="truncate-end">
            {panel.title}
          </Text>
        }
      >
        {panel.searchable ? (
          <Box paddingX={1} flexShrink={0}>
            <Box flexShrink={0} marginRight={1}>
              <Text color={accent}>/</Text>
            </Box>
            <Text {...(query ? {} : { dimColor: true })} wrap={query ? 'truncate-start' : 'truncate-end'}>
              {query || searchLabel}
              {searchFocused ? <Cursor /> : null}
            </Text>
          </Box>
        ) : null}
        {rows.length === 0 ? (
          <Box paddingX={1} flexDirection="column">
            {(panel.body?.split('\n') ?? ['No matches']).slice(0, 4).map((line, index) => (
              <Text key={index} dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        ) : (
          rows.map((row, visibleIndex) => {
            const index = start + visibleIndex
            const active = index === selected && row.value !== undefined
            const pressed = index === pressedRow
            const background = index === hoveredRow || pressed || active ? selection : undefined
            const rowColor = TONE_COLORS[row.tone ?? 'normal']
            return (
              <Box
                key={`${panel.id}-${index}`}
                ref={(element) => onRowElement?.(index, element)}
                paddingX={1}
                height={1}
                flexShrink={0}
                backgroundColor={background}
              >
                <Box width={labelWidth} flexShrink={0} overflow="hidden">
                  <Text
                    {...(active ? { color: accent } : rowColor ? { color: rowColor } : {})}
                    bold={row.bold === true}
                    wrap="truncate-end"
                  >
                    {active ? '› ' : '  '}
                    {row.label}
                  </Text>
                </Box>
                <Box flexGrow={1} overflow="hidden">
                  {row.control ? (
                    <Box flexShrink={0} marginLeft={1}>
                      <SettingsControl
                        control={row.control}
                        rowIndex={index}
                        {...(pressedControl ? { pressedControl } : {})}
                        {...(hoveredControl ? { hoveredControl } : {})}
                        {...(onControlElement ? { onControlElement } : {})}
                      />
                    </Box>
                  ) : null}
                  {row.badge ? (
                    <Box width={badgeWidth} flexShrink={0} marginLeft={1} overflow="hidden">
                      <Text color={badgeColor(row.badge.tone)}>{row.badge.text}</Text>
                    </Box>
                  ) : null}
                  {row.description &&
                  (panel.kind === 'tools' ? index === describedTool : panel.kind === 'mcp' || !row.control) ? (
                    <Box flexShrink={1} marginLeft={2} overflow="hidden">
                      <Text dimColor wrap="truncate-end">
                        {row.description}
                      </Text>
                    </Box>
                  ) : null}
                </Box>
              </Box>
            )
          })
        )}
      </PanelSection>
      <PanelHelpFooter width={width} />
    </Box>
  )
}
