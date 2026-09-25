import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'

import type { ChatContextUsage, ChatPanel, ChatPanelRow, ChatSettings } from '../chat/controller.js'
import {
  agentGridCapacity,
  agentGridColumns,
  detailPageSize,
  panelControlTarget,
  panelRowCapacity,
  type ModelPanelFocus,
} from './interaction.js'
import {
  contextColor,
  detailLines,
  permissionPageSize,
  formatContext,
  permissionLines,
  wrapLines,
} from './presentation.js'
import { AgentsPanel } from './agents-panel.js'
import { ExportPanel } from './export-panel.js'
import { EffortSlider, ModelPicker } from './model-panel.js'
import { SessionsPanel } from './sessions-panel.js'
import { PanelItemHeader, PanelOverlay, PanelTitle } from './panel-components.js'
import { SettingsControl, SettingsPanel } from './settings-panel.js'
import { BlinkingCursor } from './text-input.js'
import { Box, Text, useTheme } from './theme.js'

const MAX_COMPACT_ERROR_PANEL_HEIGHT = 10

function compactErrorDescription(value: string): string {
  return value.replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n')
}

function compactErrorPanelHeight(rows: readonly ChatPanelRow[], width: number, terminalHeight: number): number {
  const contentWidth = Math.max(10, width - 6)
  const contentHeight =
    5 +
    rows.reduce(
      (height, row) =>
        height +
        wrapLines(row.label, contentWidth).length +
        (row.description ? wrapLines(compactErrorDescription(row.description), contentWidth).length : 0),
      0
    )
  return Math.min(contentHeight, MAX_COMPACT_ERROR_PANEL_HEIGHT, Math.max(1, terminalHeight - 2))
}

export function ResourcePanel({
  panel,
  context,
  settings,
  selected,
  viewportStart,
  terminalWidth,
  terminalHeight,
  query,
  filter,
  modelPanelFocus,
  pressedFilter,
  hoveredFilter,
  pressedRow,
  hoveredRow,
  pressedControl,
  hoveredControl,
  pressedSlider,
  hoveredSlider,
  detailScroll,
  rows: allRows,
  onPanelElement,
  onRowElement,
  onControlElement,
  onFilterElement,
  onSearchElement,
  onSliderElement,
  commandDeckHeight,
}: {
  panel: ChatPanel
  context: ChatContextUsage
  settings: ChatSettings
  selected: number
  viewportStart: number
  terminalWidth: number
  terminalHeight: number
  query: string
  filter: string
  modelPanelFocus: ModelPanelFocus
  pressedFilter?: string
  hoveredFilter?: string
  pressedRow?: number
  hoveredRow?: number
  pressedControl?: string
  hoveredControl?: string
  pressedSlider: boolean
  hoveredSlider?: boolean
  detailScroll: number
  rows: readonly ChatPanelRow[]
  onPanelElement?: (element: DOMElement | null) => void
  onRowElement?: (index: number, element: DOMElement | null) => void
  onControlElement?: (key: string, element: DOMElement | null) => void
  onFilterElement?: (id: string, element: DOMElement | null) => void
  onSearchElement?: (element: DOMElement | null) => void
  onSliderElement?: (element: DOMElement | null) => void
  commandDeckHeight?: number
}): ReactElement {
  const palette = useTheme()
  const { surface, warning, selection, accent } = palette
  // Tool lists render as a checklist with a warning-colored body.
  const checklist = panel.kind === 'permissions' || panel.kind === 'tools'
  const preferredWidth =
    panel.kind === 'detail'
      ? 100
      : panel.kind === 'models'
        ? 144
        : panel.kind === 'settings'
          ? 112
          : panel.kind === 'agents'
            ? 112
            : checklist
              ? 96
              : panel.kind === 'context' || panel.kind === 'effort'
                ? 52
                : panel.kind === 'permission' && panel.diff
                  ? 100
                  : panel.kind === 'permission' || panel.kind === 'error'
                    ? 68
                    : 84
  const width = Math.max(1, Math.min(preferredWidth, terminalWidth - 4))
  const color = panel.kind === 'error' ? 'red' : accent

  if (panel.kind === 'error' && allRows.length === 1 && allRows[0]!.value === undefined) {
    const message = compactErrorDescription(
      [panel.body, ...allRows.map((row) => row.description || row.label)].filter(Boolean).join('\n')
    )
    const lines = wrapLines(message, Math.max(1, width - 4))
    const height = Math.min(lines.length + 4, MAX_COMPACT_ERROR_PANEL_HEIGHT, Math.max(1, terminalHeight - 2))
    return (
      <PanelOverlay width={width} height={height} {...(onPanelElement ? { onElement: onPanelElement } : {})}>
        <Text color="red">{lines.join('\n')}</Text>
      </PanelOverlay>
    )
  }

  if (panel.kind === 'detail') {
    const body = detailLines(panel, Math.max(10, width - 4), palette)
    const capacity = detailPageSize(terminalHeight, panel.rows.length)
    const maximum = Math.max(0, body.length - capacity)
    const boundedScroll = Math.max(0, Math.min(detailScroll, maximum))
    const start = panel.followTail ? maximum - boundedScroll : boundedScroll
    return (
      <PanelOverlay width={width} {...(onPanelElement ? { onElement: onPanelElement } : {})}>
        <Box flexDirection="column" overflow="hidden">
          <PanelTitle title={panel.title} color={color} />
          {panel.rows.map((row, index) => (
            <Text key={`${panel.id}-meta-${index}`} wrap="truncate-end">
              <Text dimColor>{row.label.padEnd(16)}</Text>
              {row.description}
            </Text>
          ))}
          {body.slice(start, start + capacity).map((line, index) => (
            <Box
              key={`${panel.id}-body-${start + index}`}
              width="100%"
              {...(line.backgroundColor ? { backgroundColor: line.backgroundColor } : {})}
            >
              <Text
                {...(line.color ? { color: line.color } : {})}
                {...(line.bold !== undefined ? { bold: line.bold } : {})}
                {...(line.dimColor !== undefined ? { dimColor: line.dimColor } : {})}
                wrap="truncate-end"
              >
                {line.text || ' '}
              </Text>
            </Box>
          ))}
          {body.length > capacity ? (
            <Text dimColor>
              {start + 1}-{start + capacity}/{body.length}
            </Text>
          ) : null}
        </Box>
      </PanelOverlay>
    )
  }

  const capacity =
    panel.kind === 'agents'
      ? agentGridCapacity(terminalWidth, terminalHeight)
      : panelRowCapacity(panel.kind, terminalHeight, terminalWidth, allRows)
  const start = Math.max(0, Math.min(viewportStart, allRows.length - capacity))
  const rows = allRows.slice(start, start + capacity)
  const rowProps = {
    panel,
    rows,
    selected,
    start,
    width,
    ...(pressedRow !== undefined ? { pressedRow } : {}),
    ...(hoveredRow !== undefined ? { hoveredRow } : {}),
    ...(onPanelElement ? { onPanelElement } : {}),
    ...(onRowElement ? { onRowElement } : {}),
  }
  const searchable = panel.searchable === true
  const compactList = ['help', 'skills', 'mcp', 'tasks', 'permissions', 'tools'].includes(panel.kind)
  const wrapLongContent = panel.kind === 'error' || allRows.length === 0
  const errorHeight = panel.kind === 'error' ? compactErrorPanelHeight(rows, width, terminalHeight) : undefined
  if (panel.kind === 'models') {
    return (
      <ModelPicker
        {...rowProps}
        allRows={allRows}
        height={terminalHeight}
        query={query}
        filter={filter}
        focus={modelPanelFocus}
        animateCursor={settings.animations}
        {...(pressedFilter ? { pressedFilter } : {})}
        {...(hoveredFilter ? { hoveredFilter } : {})}
        pressedSlider={pressedSlider}
        {...(hoveredSlider !== undefined ? { hoveredSlider } : {})}
        {...(pressedControl ? { pressedControl } : {})}
        {...(hoveredControl ? { hoveredControl } : {})}
        {...(onFilterElement ? { onFilterElement } : {})}
        {...(onControlElement ? { onControlElement } : {})}
        {...(onSearchElement ? { onSearchElement } : {})}
        {...(onSliderElement ? { onSliderElement } : {})}
      />
    )
  }
  if (panel.kind === 'effort' && panel.slider) {
    const [modelName = '', modelId = ''] = panel.body?.split('\n') ?? []
    return (
      <PanelOverlay
        width={width}
        {...(commandDeckHeight !== undefined ? { bottomOffset: commandDeckHeight + 1 } : {})}
        {...(onPanelElement ? { onElement: onPanelElement } : {})}
      >
        <Box flexDirection="column" alignItems="center" overflow="hidden">
          <Text bold color={accent} wrap="truncate-end">
            Reasoning effort
          </Text>
          <Text dimColor wrap="truncate-end">
            {modelName || modelId}
          </Text>
          <EffortSlider
            slider={panel.slider}
            width={Math.max(18, Math.min(36, width - 8))}
            compact={false}
            pressed={pressedSlider}
            {...(hoveredSlider !== undefined ? { hovered: hoveredSlider } : {})}
            focused
            {...(onSliderElement ? { onElement: onSliderElement } : {})}
          />
        </Box>
      </PanelOverlay>
    )
  }
  if (panel.kind === 'context') {
    const used = context.projectedTokens ?? context.currentTokens
    return (
      <PanelOverlay width={width} {...(onPanelElement ? { onElement: onPanelElement } : {})}>
        <Box flexDirection="column" overflow="hidden">
          <Box justifyContent="space-between">
            <Text bold color={accent} wrap="truncate-end">
              {panel.title}
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {context.contextWindow ? (
              <Text color={contextColor(context, palette)} wrap="truncate-end">
                {formatContext(context, Math.max(1, width - 12))}
              </Text>
            ) : null}
            <Text dimColor wrap="truncate-end">
              {used?.toLocaleString() ?? '—'}
              {context.contextWindow ? ` / ${context.contextWindow.toLocaleString()}` : ''} tokens
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Box justifyContent="space-between">
              <Text bold>Last turn</Text>
              <Text>{context.totalTokens?.toLocaleString() ?? '—'} tokens</Text>
            </Box>
            {(
              [
                ['Input', context.inputTokens],
                ['Output', context.outputTokens],
                ['Cache read', context.cacheReadInputTokens],
                ['Cache write', context.cacheWriteInputTokens],
              ] as const
            ).map(([label, tokens]) => (
              <Box key={label} justifyContent="space-between">
                <Text dimColor>{label}</Text>
                <Text>{tokens?.toLocaleString() ?? '—'}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      </PanelOverlay>
    )
  }
  if (panel.kind === 'settings' || panel.kind === 'voice') {
    return (
      <SettingsPanel
        height={terminalHeight}
        {...(pressedFilter ? { pressedFilter } : {})}
        {...(hoveredFilter ? { hoveredFilter } : {})}
        appearance={settings}
        {...(pressedControl ? { pressedControl } : {})}
        {...(hoveredControl ? { hoveredControl } : {})}
        {...rowProps}
        {...(onFilterElement ? { onFilterElement } : {})}
        {...(onControlElement ? { onControlElement } : {})}
      />
    )
  }
  if (panel.kind === 'agents') {
    return (
      <AgentsPanel {...rowProps} height={Math.max(5, terminalHeight - 8)} columns={agentGridColumns(terminalWidth)} />
    )
  }
  if (panel.kind === 'export') {
    return <ExportPanel {...rowProps} width={Math.min(68, width)} />
  }
  if (panel.kind === 'sessions') {
    return <SessionsPanel {...rowProps} allRows={allRows} query={query} animateCursor={settings.animations} />
  }

  return (
    <PanelOverlay
      width={width}
      {...(errorHeight === undefined ? {} : { height: errorHeight })}
      {...(onPanelElement ? { onElement: onPanelElement } : {})}
    >
      <Box flexDirection="column" overflow="hidden">
        <Box paddingX={1} justifyContent="space-between">
          <PanelTitle title={panel.title} color={color} />
          {panel.kind !== 'permissions' && allRows.length > capacity ? (
            <Text dimColor>
              {selected + 1}/{allRows.length}
            </Text>
          ) : null}
        </Box>
        {panel.body || (panel.kind === 'permission' && panel.diff) ? (
          panel.kind === 'permission' ? (
            <PermissionPreview panel={panel} width={width - 6} terminalHeight={terminalHeight} scroll={detailScroll} />
          ) : wrapLongContent || checklist ? (
            <Box paddingX={1} flexDirection="column">
              {wrapLines(panel.body ?? '', Math.max(10, width - 5)).map((line, index) => (
                <Text key={`${panel.id}-body-${index}`} {...(checklist ? { color: warning } : {})}>
                  {line || ' '}
                </Text>
              ))}
              {checklist ? <Text> </Text> : null}
            </Box>
          ) : (
            <Box paddingX={1}>
              <Text dimColor wrap="truncate-end">
                {(panel.body ?? '').replace(/\n/g, ' | ')}
              </Text>
            </Box>
          )
        ) : null}
        {panel.filters?.length ? (
          <Box paddingX={1} flexWrap="wrap">
            {panel.filters.map((item, index) => {
              const pressed = item.id === pressedFilter
              return (
                <Box
                  key={item.id}
                  flexShrink={0}
                  marginRight={index < panel.filters!.length - 1 ? 1 : 0}
                  backgroundColor={item.id === hoveredFilter || pressed ? selection : undefined}
                >
                  <Box ref={(element) => onFilterElement?.(item.id, element)}>
                    <Text
                      {...(item.id === filter ? { color: accent } : {})}
                      bold={item.id === filter}
                      dimColor={item.id !== filter}
                      underline={item.id === filter}
                    >
                      {item.label}
                    </Text>
                  </Box>
                </Box>
              )
            })}
          </Box>
        ) : null}
        {searchable ? (
          <Box paddingX={1}>
            <Text dimColor>Search: </Text>
            <Text>
              {query}
              <BlinkingCursor animate={settings.animations} />
            </Text>
          </Box>
        ) : null}
        {rows.length === 0 && !panel.body ? (
          <Box paddingX={1}>
            <Text dimColor>No matches</Text>
          </Box>
        ) : (
          rows.map((row, visibleIndex) => {
            const index = start + visibleIndex
            const selectedRow = index === selected && row.value !== undefined
            const rowPressed = index === pressedRow
            const rowColor = row.tone === 'warning' ? warning : row.tone === 'danger' ? 'red' : undefined
            const description = panel.kind === 'error' ? compactErrorDescription(row.description) : row.description
            return (
              <Box key={`${panel.id}-${index}`} flexDirection="column">
                {row.section &&
                row.section !== rows[visibleIndex - 1]?.section &&
                (panel.kind !== 'help' || filter === 'all') ? (
                  <Box paddingX={checklist ? 2 : 1} marginTop={checklist ? 1 : 0}>
                    <Text {...(checklist ? { color: accent } : {})} dimColor bold>
                      {row.section}
                    </Text>
                  </Box>
                ) : null}
                <Box
                  ref={(element) => onRowElement?.(index, element)}
                  paddingX={checklist ? 2 : 1}
                  flexDirection="column"
                  backgroundColor={
                    index === hoveredRow || rowPressed || selectedRow ? selection : row.current ? surface : undefined
                  }
                >
                  <Box justifyContent={panel.kind === 'tools' ? 'flex-start' : 'space-between'}>
                    <PanelItemHeader
                      label={row.label}
                      active={selectedRow}
                      pressed={rowPressed}
                      clickable={row.value !== undefined}
                      {...(row.bold !== undefined ? { bold: row.bold } : {})}
                      color={rowColor ?? accent}
                      wrap={wrapLongContent ? 'wrap' : 'truncate-end'}
                    />
                    {row.control ? (
                      <Box marginLeft={panel.kind === 'tools' ? 2 : 0}>
                        {panel.kind === 'tools' && row.control.kind === 'toggle' ? (
                          <Box
                            ref={(element) => onControlElement?.(panelControlTarget(index, 'toggle'), element)}
                            width={1}
                          >
                            <Text {...(row.control.checked ? { color: accent } : {})} dimColor={!row.control.checked}>
                              {row.control.checked ? '☑' : '☐'}
                            </Text>
                          </Box>
                        ) : (
                          <SettingsControl
                            {...(pressedControl ? { pressedControl } : {})}
                            control={row.control}
                            rowIndex={index}
                            {...(onControlElement ? { onControlElement } : {})}
                          />
                        )}
                      </Box>
                    ) : panel.kind === 'help' && row.section === 'Controls' ? (
                      <Text dimColor wrap="truncate-end">
                        {' '}
                        {row.description.split('\n')[0]}
                      </Text>
                    ) : row.badge ? (
                      <Text
                        color={row.badge.tone === 'success' ? 'green' : row.badge.tone === 'danger' ? 'red' : warning}
                      >
                        {' '}
                        {row.badge.text}
                      </Text>
                    ) : null}
                  </Box>
                  {description && !compactList && panel.kind !== 'permission' ? (
                    <Text dimColor wrap={wrapLongContent ? 'wrap' : 'truncate-end'}>
                      {'  '}
                      {panel.kind === 'help' ? description.replace(/\s+/gu, ' ') : description}
                    </Text>
                  ) : null}
                </Box>
              </Box>
            )
          })
        )}
        {panel.kind !== 'permissions' &&
        (compactList || panel.kind === 'permission') &&
        allRows[selected]?.description ? (
          <Box paddingX={1} flexDirection="column">
            {wrapLines(
              panel.kind === 'help' && allRows[selected]!.section === 'Controls'
                ? allRows[selected]!.description.split('\n').slice(1).join(' ')
                : allRows[selected]!.description.split('\n')[0]!,
              Math.max(1, width - 6)
            )
              .slice(0, 3)
              .map((line, index) => (
                <Text key={index} dimColor>
                  {line}
                </Text>
              ))}
          </Box>
        ) : null}
      </Box>
    </PanelOverlay>
  )
}

function PermissionPreview({
  panel,
  width,
  terminalHeight,
  scroll,
}: {
  panel: ChatPanel
  width: number
  terminalHeight: number
  scroll: number
}): ReactElement {
  const palette = useTheme()
  const lines = permissionLines(panel, width, palette)
  const capacity = permissionPageSize(terminalHeight, panel.rows.length)
  const start = Math.max(0, Math.min(scroll, lines.length - capacity))
  return (
    <Box
      paddingX={1}
      flexDirection="column"
      height={Math.min(capacity, lines.length) + Number(lines.length > capacity)}
      flexShrink={0}
      overflow="hidden"
    >
      {lines.slice(start, start + capacity).map((line, index) => (
        <Text
          key={`${panel.id}-input-${start + index}`}
          {...(line.color ? { color: line.color } : {})}
          dimColor={line.dimColor === true}
        >
          {line.text || ' '}
        </Text>
      ))}
      {lines.length > capacity ? (
        <Text dimColor>
          {start + 1}-{start + capacity}/{lines.length}
        </Text>
      ) : null}
    </Box>
  )
}
