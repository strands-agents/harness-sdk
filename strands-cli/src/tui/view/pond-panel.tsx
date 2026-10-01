import { useEffect, useState, type ReactElement } from 'react'

import type { ChatSettings } from '../chat/controller.js'
import { PanelOverlay, PanelTitle, type PanelRowsProps } from './panel-components.js'
import { pondCanvasSize, renderPond } from './pond-drawing.js'
import { Box, Text, useTheme } from './theme.js'

const FRAME_MS = 150

export function PondPanel({
  panel,
  selected,
  terminalWidth,
  terminalHeight,
  scroll,
  hoveredRow,
  settings,
  onPanelElement,
  onRowElement,
}: Omit<PanelRowsProps, 'width' | 'start'> & {
  terminalWidth: number
  terminalHeight: number
  /** Rows of pond scrolled past the top of the view. */
  scroll: number
  settings: ChatSettings
}): ReactElement {
  const colors = useTheme()
  const elapsedMs = useElapsed(settings.animations)
  const frogs = panel.pond ?? []
  const { width: canvasWidth, height: canvasHeight } = pondCanvasSize(terminalWidth, terminalHeight)
  const width = canvasWidth + 2
  const height = canvasHeight + 4
  const highlighted = hoveredRow ?? selected
  const scene = renderPond(
    frogs,
    panel.rows.map((row) => row.label),
    canvasWidth,
    canvasHeight,
    {
      elapsedMs,
      highlighted,
      scroll,
      color: true,
      theme: settings.frogTheme,
      render: {
        colorMode: colors.mode,
        customBase: settings.customTheme.base,
        ...(settings.frogTheme === 'custom' ? { frogColor: colors.frog } : {}),
      },
    }
  )
  const count = (state: string): number => frogs.filter((frog) => frog.state === state).length
  const summary = [
    `${count('working')} working`,
    `${count('awake')} awake`,
    `${count('asleep')} asleep`,
    ...(count('failed') > 0 ? [`${count('failed')} failed`] : []),
    ...(scene.worldHeight > canvasHeight
      ? [
          `${Math.round((Math.min(scroll, scene.worldHeight - canvasHeight) / (scene.worldHeight - canvasHeight)) * 100)}% ↕`,
        ]
      : []),
  ].join(' · ')
  const focus = panel.rows[highlighted]
  return (
    <PanelOverlay width={width} height={height} {...(onPanelElement ? { onElement: onPanelElement } : {})}>
      <Box justifyContent="space-between" flexShrink={0}>
        <PanelTitle title={panel.title} color={colors.accent} />
        <Text dimColor>{summary}</Text>
      </Box>
      <Box width={canvasWidth} height={canvasHeight} flexDirection="column" flexShrink={0}>
        {scene.lines.map((line, index) => (
          <Text key={index}>{line}</Text>
        ))}
        {scene.hitBoxes.map((box) => (
          <Box
            key={box.index}
            ref={(element) => onRowElement?.(box.index, element)}
            position="absolute"
            marginLeft={Math.max(0, box.left)}
            marginTop={Math.max(0, box.top)}
            width={box.width}
            height={box.height}
          />
        ))}
      </Box>
      <Box flexDirection="column" height={2} flexShrink={0}>
        {frogs.length === 0 ? (
          <Text dimColor>The pond is quiet: no live agents or recent sessions.</Text>
        ) : focus ? (
          <>
            <Text bold wrap="truncate-end">
              {focus.label}
            </Text>
            <Text dimColor wrap="truncate-end">
              {focus.description}
            </Text>
          </>
        ) : null}
      </Box>
    </PanelOverlay>
  )
}

function useElapsed(animate: boolean): number {
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    if (!animate) {
      return
    }
    const startedAt = Date.now()
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), FRAME_MS)
    return (): void => clearInterval(timer)
  }, [animate])
  return elapsedMs
}
