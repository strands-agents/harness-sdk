import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'

import type { ChatPanelRow, ChatPermissionPanel } from '../chat/controller.js'
import {
  permissionPanelLayout,
  permissionPreviewCapacity,
  revealPanelSelection,
  type PermissionPanelLayout,
} from './interaction.js'
import { PanelHelpFooter } from './help-footer.js'
import { PanelSection } from './panel-sections.js'
import { PERMISSION_LABEL_WIDTH, permissionLines } from './presentation.js'
import { Box, Text, useTheme } from './theme.js'

export function PermissionPanel({
  panel,
  rows,
  selected,
  viewportStart,
  scroll,
  width,
  height,
  pressedRow,
  hoveredRow,
  onPanelElement,
  onRowElement,
}: {
  panel: ChatPermissionPanel
  rows: readonly ChatPanelRow[]
  selected: number
  viewportStart: number
  scroll: number
  width: number
  height: number
  pressedRow?: number
  hoveredRow?: number
  onPanelElement?: (element: DOMElement | null) => void
  onRowElement?: (index: number, element: DOMElement | null) => void
}): ReactElement {
  const { warning } = useTheme()
  const layout = permissionPanelLayout(width, height, rows.length)
  const columns = layout.optionGrid ? 2 : 1
  const start =
    revealPanelSelection(
      Math.floor(selected / columns),
      Math.floor(viewportStart / columns),
      Math.max(1, Math.floor(layout.optionCapacity / columns)),
      Math.ceil(rows.length / columns)
    ) * columns
  const visibleRows = rows.slice(start, start + layout.optionCapacity)
  const description = rows[selected]?.description ?? ''
  const title = (
    <Text color={warning} bold wrap="truncate-end">
      {panel.title}
    </Text>
  )
  const choicesWidth = layout.wide ? Math.max(1, layout.optionsWidth - 4) : layout.optionsWidth
  const choices = (
    <PermissionChoices
      rows={visibleRows}
      selected={selected}
      start={start}
      width={choicesWidth}
      grid={layout.optionGrid}
      {...(pressedRow !== undefined ? { pressedRow } : {})}
      {...(hoveredRow !== undefined ? { hoveredRow } : {})}
      {...(onRowElement ? { onRowElement } : {})}
    />
  )
  const sectionHeight = Math.max(1, height - 1)

  return (
    <Box ref={onPanelElement} width={width} height={height} flexDirection="column" overflow="hidden">
      {layout.wide ? (
        <Box height={sectionHeight} overflow="hidden">
          <PanelSection
            focused
            width={layout.optionsWidth}
            height={sectionHeight}
            header={
              <Text bold wrap="truncate-end">
                {panel.stage === 'allow-always'
                  ? 'Allow forever'
                  : panel.stage === 'deny-always'
                    ? 'Deny forever'
                    : 'Choose an action'}
              </Text>
            }
          >
            <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" overflow="hidden">
              {choices}
              {layout.descriptionHeight > 0 ? (
                <Box
                  width={choicesWidth}
                  marginTop={layout.descriptionHeight > 1 ? 1 : 0}
                  flexShrink={0}
                  overflow="hidden"
                >
                  <Text dimColor wrap="truncate-end">
                    {description.split('\n')[0]}
                  </Text>
                </Box>
              ) : null}
            </Box>
          </PanelSection>
          <PanelSection focused={false} height={sectionHeight} header={title}>
            <PermissionDetails panel={panel} layout={layout} scroll={scroll} selected={selected} />
          </PanelSection>
        </Box>
      ) : (
        <PanelSection focused height={sectionHeight} header={title}>
          <PermissionDetails panel={panel} layout={layout} scroll={scroll} selected={selected} />
          {choices}
          {layout.descriptionHeight > 0 ? (
            <Box paddingX={1} flexShrink={0} overflow="hidden">
              <Text dimColor wrap="truncate-end">
                {description.split('\n')[0]}
              </Text>
            </Box>
          ) : null}
        </PanelSection>
      )}
      <PanelHelpFooter width={width} />
    </Box>
  )
}

function PermissionDetails({
  panel,
  layout,
  scroll,
  selected,
}: {
  panel: ChatPermissionPanel
  layout: PermissionPanelLayout
  scroll: number
  selected: number
}): ReactElement {
  const palette = useTheme()
  const lines = permissionLines(panel, layout.previewTextWidth, palette, selected)
  const height = layout.previewHeight
  const capacity = permissionPreviewCapacity(lines.length, height)
  const start = Math.max(0, Math.min(scroll, lines.length - capacity))
  const showPage = lines.length > capacity && height > 1
  return (
    <Box flexDirection="column" flexShrink={0} paddingX={1} overflow="hidden">
      <Box height={height} flexShrink={0} flexDirection="column" overflow="hidden">
        {lines.slice(start, start + capacity).map((line, index) => (
          <Box key={`${panel.id}-detail-${start + index}`} height={1} flexShrink={0} overflow="hidden">
            <Box width={PERMISSION_LABEL_WIDTH} flexShrink={0}>
              <Text dimColor>{line.label}</Text>
            </Box>
            <Text
              {...(line.color ? { color: line.color } : {})}
              bold={line.bold === true}
              dimColor={line.dimColor === true}
              wrap="truncate-end"
            >
              {line.text || ' '}
            </Text>
          </Box>
        ))}
        {showPage ? (
          <Text dimColor wrap="truncate-end">
            {' '.repeat(PERMISSION_LABEL_WIDTH)}
            {start + 1}-{start + capacity}/{lines.length} · PgUp/PgDn
          </Text>
        ) : null}
      </Box>
    </Box>
  )
}

function PermissionChoices({
  rows,
  selected,
  start,
  width,
  grid,
  pressedRow,
  hoveredRow,
  onRowElement,
}: {
  rows: readonly ChatPanelRow[]
  selected: number
  start: number
  width: number
  grid: boolean
  pressedRow?: number
  hoveredRow?: number
  onRowElement?: (index: number, element: DOMElement | null) => void
}): ReactElement {
  const { accent, border, error, selection, success } = useTheme()
  const state = (
    index: number,
    tone: ChatPanelRow['tone']
  ): { active: boolean; highlighted: boolean; color: string } => {
    const active = index === selected
    return {
      active,
      highlighted: active || index === pressedRow || index === hoveredRow,
      color: tone === 'danger' ? error : tone === 'success' ? success : accent,
    }
  }
  if (grid) {
    const pairs: ChatPanelRow[][] = []
    for (let index = 0; index < rows.length; index += 2) {
      pairs.push(rows.slice(index, index + 2))
    }
    return (
      <Box width={width} flexShrink={0} flexDirection="column" overflow="hidden">
        {pairs.map((pair, pairIndex) => (
          <Box key={pairIndex} height={3} flexShrink={0} overflow="hidden">
            {pair.map((row, column) => {
              const index = start + pairIndex * 2 + column
              const { active, highlighted, color } = state(index, row.tone)
              return (
                <Box
                  key={`${index}:${row.label}`}
                  ref={(element) => onRowElement?.(index, element)}
                  flexBasis={0}
                  flexGrow={1}
                  height={3}
                  overflow="hidden"
                  borderStyle="single"
                  borderColor={highlighted ? accent : border}
                  borderDimColor={!highlighted}
                  justifyContent="center"
                >
                  <Text color={color} bold={highlighted} wrap="truncate-end">
                    {active ? '▸ ' : ''}
                    {row.label}
                  </Text>
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
    )
  }
  return (
    <Box width={width} flexShrink={0} flexDirection="column" overflow="hidden">
      {rows.map((row, visibleIndex) => {
        const index = start + visibleIndex
        const { active, highlighted, color } = state(index, row.tone)
        return (
          <Box
            key={`${index}:${row.label}`}
            ref={(element) => onRowElement?.(index, element)}
            height={1}
            flexShrink={0}
            paddingX={1}
            backgroundColor={highlighted ? selection : undefined}
          >
            <Text {...(highlighted || row.tone !== 'normal' ? { color } : {})} bold={highlighted} wrap="truncate-end">
              {active ? '▸ ' : '  '}
              {row.label}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
