import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'

import type { ChatContextUsage, ChatPanel, ChatPanelRow, ChatSettings } from '../chat/controller.js'
import {
  clampViewportStart,
  COMPOSER_RESOURCE_PANEL_HEIGHT,
  panelRowCapacity,
  type ModelPanelFocus,
  type SettingsPanelFocus,
} from './interaction.js'
import { ComposerListPanel } from './composer-list-panel.js'
import { ContextPanel } from './context-panel.js'
import { DetailPanel } from './detail-panel.js'
import { EffortPanel } from './effort-panel.js'
import { ErrorPanel } from './error-panel.js'
import { errorPanelLayout } from './error-panel-layout.js'
import { ExportPanel } from './export-panel.js'
import { HelpPanel } from './help-panel.js'
import { ModelPicker } from './model-panel.js'
import { SessionsPanel } from './sessions-panel.js'
import { PanelHelpFooter } from './help-footer.js'
import { PermissionPanel } from './permission-panel.js'
import { PermissionsPanel } from './permissions-panel.js'
import { SettingsPicker } from './settings-panel.js'
import { TasksPanel } from './tasks-panel.js'
import { Box } from './theme.js'
import { VoicePanel } from './voice-panel.js'

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
    const modelId = panel.kind === 'models' ? allRows[hoveredRow ?? selected]?.value : undefined
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
          width={width}
          height={Math.max(1, height - 1)}
          query={query}
          focus={modelPanelFocus}
          {...(pressedRow !== undefined ? { pressedRow } : {})}
          {...(hoveredRow !== undefined ? { hoveredRow } : {})}
          {...(onRowElement ? { onRowElement } : {})}
          {...(onSearchElement ? { onSearchElement } : {})}
          {...(onSliderElement ? { onSliderElement } : {})}
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
