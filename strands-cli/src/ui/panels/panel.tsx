import { type ReactElement } from 'react'
import { type DOMElement } from 'ink'
import stringWidth from 'string-width'
import { type ChatPanelRow, type ChatPanel, type ChatSettings } from '../chat/controller.js'
import { type ChatContextUsage } from '../../agent/types.js'
import { PanelHelpFooter, panelModelId } from '../footer.js'
import { badgeColor, TONE_COLORS, type PanelRowsProps, PanelSection } from './shared.js'
import { SettingsControl, SettingsPicker } from './settings.js'
import { Cursor } from '../text-input.js'
import { Box, Text, useTheme } from '../theme.js'
import { type ChatDetailPanel } from '../chat/types.js'
import {
  detailPageSize,
  errorPanelLayout,
  clampViewportStart,
  COMPOSER_RESOURCE_PANEL_HEIGHT,
  panelRowCapacity,
  type ModelPanelFocus,
  type SettingsPanelFocus,
} from '../interaction.js'
import { detailLines } from '../presentation.js'
import { ContextPanel } from './context.js'
import { EffortPanel, ModelPicker } from './models.js'
import { ExportPanel } from './export.js'
import { HelpPanel } from './help.js'
import { SessionsPanel } from './sessions.js'
import { PermissionPanel, PermissionsPanel } from './permissions.js'
import { TasksPanel } from './tasks.js'
import { VoicePanel } from './voice.js'

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

export function DetailPanel({
  panel,
  width,
  height,
  scroll,
  onElement,
}: {
  panel: ChatDetailPanel
  width: number
  height: number
  scroll: number
  onElement?: (element: DOMElement | null) => void
}): ReactElement {
  const palette = useTheme()
  const body = detailLines(panel, Math.max(1, width - 4), palette)
  const capacity = detailPageSize(height)
  const maximum = Math.max(0, body.length - capacity)
  const boundedScroll = Math.max(0, Math.min(scroll, maximum))
  const start = panel.followTail ? maximum - boundedScroll : boundedScroll
  const end = Math.min(body.length, start + capacity)
  const header = (
    <Text dimColor wrap="truncate-end">
      {panel.title}
    </Text>
  )

  return (
    <Box ref={onElement} width={width} height={height} flexDirection="column" overflow="hidden">
      <PanelSection
        focused
        width={width}
        height={Math.max(1, height - 1)}
        header={header}
        {...(maximum > 0 ? { meta: `${start + 1}-${end} / ${body.length}` } : {})}
      >
        <Box paddingX={1} height={capacity} flexDirection="column" flexShrink={0} overflow="hidden">
          {body.slice(start, end).map((line, index) => (
            <Box
              key={`${panel.id}-${start + index}`}
              width="100%"
              {...(line.backgroundColor ? { backgroundColor: line.backgroundColor } : {})}
            >
              <Text
                {...(line.color ? { color: line.color } : {})}
                {...(line.bold !== undefined ? { bold: line.bold } : {})}
                {...(line.dimColor !== undefined ? { dimColor: line.dimColor } : {})}
                wrap="truncate-end"
              >
                {line.label !== undefined ? <Text dimColor>{line.label}</Text> : null}
                {line.text || ' '}
              </Text>
            </Box>
          ))}
        </Box>
      </PanelSection>
      <PanelHelpFooter width={width} />
    </Box>
  )
}

export function ErrorPanel({
  panel,
  width,
  height,
  scroll,
  onElement,
}: {
  panel: ChatPanel
  width: number
  height: number
  scroll: number
  onElement?: (element: DOMElement | null) => void
}): ReactElement {
  const { error } = useTheme()
  const layout = errorPanelLayout(panel, width, height)
  const start = Math.max(0, Math.min(scroll, layout.maxScroll))
  const lines = layout.lines.slice(start, start + layout.contentHeight)
  return (
    <Box ref={onElement} width={width} height={layout.height} flexDirection="column" overflow="hidden">
      <PanelSection focused width={width} height={Math.max(1, layout.height - 1)}>
        <Box paddingX={1} height={layout.contentHeight} flexDirection="column" flexShrink={0} overflow="hidden">
          {lines.map((line, index) => (
            <Text key={start + index} color={error} wrap="truncate-end">
              {line || ' '}
            </Text>
          ))}
        </Box>
      </PanelSection>
      <PanelHelpFooter width={width} scrollable={layout.maxScroll > 0} />
    </Box>
  )
}

export function ResourcePanel({
  panel,
  context,
  settings,
  selected,
  viewportStart,
  terminalWidth,
  terminalHeight,
  composer,
  query,
  filter,
  modelPanelFocus,
  modelProfileSelection = 0,
  settingsPanelFocus,
  pressedFilter,
  hoveredFilter,
  pressedRow,
  hoveredRow,
  pressedControl,
  hoveredControl,
  detailScroll,
  rows: allRows,
  energyFrame = 0,
  onPanelElement,
  onRowElement,
  onControlElement,
  onFilterElement,
  onSearchElement,
  onSliderElement,
}: {
  panel: ChatPanel
  context: ChatContextUsage
  settings: ChatSettings
  selected: number
  viewportStart: number
  terminalWidth: number
  terminalHeight: number
  /** Content box of the prompt editor when the panel renders inside it. */
  composer?: { width: number; height: number }
  query: string
  filter: string
  modelPanelFocus: ModelPanelFocus
  modelProfileSelection?: number
  settingsPanelFocus: SettingsPanelFocus
  pressedFilter?: string
  hoveredFilter?: string
  pressedRow?: number
  hoveredRow?: number
  pressedControl?: string
  hoveredControl?: string
  detailScroll: number
  rows: readonly ChatPanelRow[]
  energyFrame?: number
  onPanelElement?: (element: DOMElement | null) => void
  onRowElement?: (index: number, element: DOMElement | null) => void
  onControlElement?: (key: string, element: DOMElement | null) => void
  onFilterElement?: (id: string, element: DOMElement | null) => void
  onSearchElement?: (element: DOMElement | null) => void
  onSliderElement?: (element: DOMElement | null) => void
}): ReactElement {
  const width = composer?.width ?? Math.max(1, terminalWidth - 4)
  const height = composer?.height ?? COMPOSER_RESOURCE_PANEL_HEIGHT
  const capacity = panelRowCapacity(panel.kind, height)
  const start = clampViewportStart(viewportStart, allRows.length, capacity)
  const rows = allRows.slice(start, start + capacity)

  if (panel.kind === 'help') {
    return (
      <Box ref={onPanelElement} width={width} height={height} overflow="hidden" flexDirection="column">
        <HelpPanel
          panel={panel}
          rows={rows}
          allRows={allRows}
          selected={selected}
          start={start}
          width={width}
          height={Math.max(1, height - 1)}
          query={query}
          filter={filter}
          focus={modelPanelFocus}
          {...(pressedRow !== undefined ? { pressedRow } : {})}
          {...(hoveredRow !== undefined ? { hoveredRow } : {})}
          {...(pressedFilter ? { pressedFilter } : {})}
          {...(hoveredFilter ? { hoveredFilter } : {})}
          {...(onRowElement ? { onRowElement } : {})}
          {...(onFilterElement ? { onFilterElement } : {})}
          {...(onSearchElement ? { onSearchElement } : {})}
        />
        <PanelHelpFooter width={width} />
      </Box>
    )
  }

  if (panel.kind === 'error') {
    const height = composer?.height ?? errorPanelLayout(panel, width, Math.min(10, terminalHeight - 2)).height
    return (
      <ErrorPanel
        panel={panel}
        width={width}
        height={height}
        scroll={detailScroll}
        {...(onPanelElement ? { onElement: onPanelElement } : {})}
      />
    )
  }

  if (panel.kind === 'detail' || panel.kind === 'help-detail') {
    return (
      <DetailPanel
        panel={panel}
        width={width}
        height={height}
        scroll={detailScroll}
        {...(onPanelElement ? { onElement: onPanelElement } : {})}
      />
    )
  }

  if (panel.kind === 'effort') {
    return (
      <EffortPanel
        slider={panel.slider}
        {...(panel.body ? { body: panel.body } : {})}
        width={width}
        height={composer?.height ?? COMPOSER_RESOURCE_PANEL_HEIGHT - 2}
        energyFrame={energyFrame}
        {...(onPanelElement ? { onElement: onPanelElement } : {})}
        {...(onSliderElement ? { onSliderElement } : {})}
      />
    )
  }
  if (panel.kind === 'permission') {
    return (
      <PermissionPanel
        panel={panel}
        rows={allRows}
        selected={selected}
        viewportStart={viewportStart}
        scroll={detailScroll}
        width={width}
        height={height}
        {...(pressedRow !== undefined ? { pressedRow } : {})}
        {...(hoveredRow !== undefined ? { hoveredRow } : {})}
        {...(onPanelElement ? { onPanelElement } : {})}
        {...(onRowElement ? { onRowElement } : {})}
      />
    )
  }
  if (panel.kind === 'sessions') {
    return (
      <Box ref={onPanelElement} width={width} height={height} overflow="hidden" flexDirection="column">
        <SessionsPanel
          panel={panel}
          rows={rows}
          allRows={allRows}
          selected={selected}
          start={start}
          width={width}
          height={Math.max(1, height - 1)}
          query={query}
          filter={filter}
          focus={modelPanelFocus}
          animate={settings.animations}
          {...(pressedFilter ? { pressedFilter } : {})}
          {...(hoveredFilter ? { hoveredFilter } : {})}
          {...(pressedRow !== undefined ? { pressedRow } : {})}
          {...(hoveredRow !== undefined ? { hoveredRow } : {})}
          {...(onFilterElement ? { onFilterElement } : {})}
          {...(onSearchElement ? { onSearchElement } : {})}
          {...(onRowElement ? { onRowElement } : {})}
        />
        <PanelHelpFooter width={width} />
      </Box>
    )
  }
  if (panel.kind === 'voice') {
    return (
      <Box ref={onPanelElement} width={width} height={height} overflow="hidden" flexDirection="column">
        <VoicePanel
          title={panel.title}
          rows={allRows}
          selected={selected}
          width={width}
          height={Math.max(1, height - 1)}
          {...(pressedRow !== undefined ? { pressedRow } : {})}
          {...(hoveredRow !== undefined ? { hoveredRow } : {})}
          {...(pressedControl ? { pressedControl } : {})}
          {...(hoveredControl ? { hoveredControl } : {})}
          {...(onRowElement ? { onRowElement } : {})}
          {...(onControlElement ? { onControlElement } : {})}
          {...(onSliderElement ? { onSliderElement } : {})}
        />
        <PanelHelpFooter width={width} />
      </Box>
    )
  }
  if (panel.kind === 'models' || panel.kind === 'settings') {
    const modelId = panelModelId(panel, allRows[hoveredRow ?? selected])
    const sectionProps = {
      rows,
      allRows,
      selected,
      start,
      width,
      // The help footer takes the last row.
      height: Math.max(1, height - 1),
      ...(pressedRow !== undefined ? { pressedRow } : {}),
      ...(hoveredRow !== undefined ? { hoveredRow } : {}),
      ...(onRowElement ? { onRowElement } : {}),
      ...(pressedFilter ? { pressedFilter } : {}),
      ...(hoveredFilter ? { hoveredFilter } : {}),
      ...(onFilterElement ? { onFilterElement } : {}),
    }
    return (
      <Box ref={onPanelElement} width={width} height={height} overflow="hidden" flexDirection="column">
        {panel.kind === 'models' ? (
          <ModelPicker
            {...sectionProps}
            panel={panel}
            query={query}
            filter={filter}
            focus={modelPanelFocus}
            profileSelected={modelProfileSelection}
            animate={settings.animations}
            {...(onSearchElement ? { onSearchElement } : {})}
          />
        ) : (
          <SettingsPicker
            {...sectionProps}
            panel={panel}
            focus={settingsPanelFocus}
            {...(pressedControl ? { pressedControl } : {})}
            {...(hoveredControl ? { hoveredControl } : {})}
            {...(onControlElement ? { onControlElement } : {})}
          />
        )}
        <PanelHelpFooter width={width} {...(modelId ? { modelId } : {})} />
      </Box>
    )
  }
  if (panel.kind === 'export') {
    return (
      <ExportPanel
        panel={panel}
        rows={rows}
        selected={selected}
        start={start}
        width={width}
        height={height}
        query={query}
        {...(pressedRow !== undefined ? { pressedRow } : {})}
        {...(hoveredRow !== undefined ? { hoveredRow } : {})}
        {...(onPanelElement ? { onPanelElement } : {})}
        {...(onRowElement ? { onRowElement } : {})}
      />
    )
  }
  if (panel.kind === 'tasks') {
    return (
      <Box ref={onPanelElement} width={width} height={height} overflow="hidden" flexDirection="column">
        <TasksPanel
          panel={panel}
          rows={rows}
          allRows={allRows}
          selected={selected}
          start={start}
          height={Math.max(1, height - 1)}
          query={query}
          focus={modelPanelFocus}
          {...(pressedRow !== undefined ? { pressedRow } : {})}
          {...(hoveredRow !== undefined ? { hoveredRow } : {})}
          {...(onRowElement ? { onRowElement } : {})}
          {...(onSearchElement ? { onSearchElement } : {})}
        />
        <PanelHelpFooter width={width} />
      </Box>
    )
  }
  if (panel.kind === 'permissions') {
    return (
      <Box ref={onPanelElement} width={width} height={height} overflow="hidden" flexDirection="column">
        <PermissionsPanel
          panel={panel}
          rows={rows}
          allRows={allRows}
          selected={selected}
          start={start}
          width={width}
          height={Math.max(1, height - 1)}
          query={query}
          focus={modelPanelFocus}
          {...(pressedRow !== undefined ? { pressedRow } : {})}
          {...(hoveredRow !== undefined ? { hoveredRow } : {})}
          {...(pressedControl ? { pressedControl } : {})}
          {...(hoveredControl ? { hoveredControl } : {})}
          {...(onRowElement ? { onRowElement } : {})}
          {...(onControlElement ? { onControlElement } : {})}
          {...(onSearchElement ? { onSearchElement } : {})}
          {...(onSliderElement ? { onSliderElement } : {})}
        />
        <PanelHelpFooter width={width} />
      </Box>
    )
  }
  if (panel.kind === 'tools' || panel.kind === 'mcp' || panel.kind === 'skills') {
    return (
      <ComposerListPanel
        panel={panel}
        rows={rows}
        allRows={allRows}
        selected={selected}
        start={start}
        width={width}
        height={height}
        query={query}
        searchFocused={panel.kind !== 'mcp' || modelPanelFocus === 'search'}
        {...(pressedRow !== undefined ? { pressedRow } : {})}
        {...(hoveredRow !== undefined ? { hoveredRow } : {})}
        {...(pressedControl ? { pressedControl } : {})}
        {...(hoveredControl ? { hoveredControl } : {})}
        {...(onPanelElement ? { onPanelElement } : {})}
        {...(onRowElement ? { onRowElement } : {})}
        {...(onControlElement ? { onControlElement } : {})}
      />
    )
  }
  return (
    <ContextPanel
      context={context}
      title={panel.title}
      width={width}
      {...(composer ? { height: composer.height } : {})}
      {...(onPanelElement ? { onPanelElement } : {})}
    />
  )
}
