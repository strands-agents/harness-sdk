import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Box, useWindowSize } from 'ink'

import type { FrogTheme } from '../chat/types.js'
import { FROG_INTRO_DURATION_MS, renderFrogSpiralFrame } from './frog-intro-renderer.js'
import { Text, useTheme } from './theme.js'

const HOLD_MS = 250

export function DnaVortexIntro({
  onComplete,
  ready = true,
  theme = 'green',
  customBase = 'green',
}: {
  onComplete(exitCode: 0 | 130): void
  ready?: boolean
  theme?: FrogTheme
  customBase?: Exclude<FrogTheme, 'custom'>
}): ReactElement {
  const colors = useTheme()
  const { columns, rows } = useWindowSize()
  const [elapsedMs, setElapsedMs] = useState(0)
  const completed = useRef(false)
  const startedAt = useRef(Date.now())
  const terminalWidth = Math.max(1, columns)
  const terminalHeight = Math.max(1, rows)
  const fps = terminalWidth * terminalHeight > 8_000 ? 12 : terminalWidth * terminalHeight > 4_500 ? 16 : 20

  useEffect(() => {
    const tick = (): void => {
      const elapsed = Date.now() - startedAt.current
      setElapsedMs(elapsed)
      if (elapsed >= FROG_INTRO_DURATION_MS + HOLD_MS && ready && !completed.current) {
        completed.current = true
        onComplete(0)
      }
    }
    tick()
    const timer = setInterval(tick, 1_000 / fps)
    return (): void => clearInterval(timer)
  }, [onComplete, fps, ready])

  const artwork = renderFrogSpiralFrame(
    terminalWidth - 2,
    terminalHeight,
    elapsedMs / FROG_INTRO_DURATION_MS,
    elapsedMs,
    true,
    theme,
    { colorMode: colors.mode, customBase, ...(theme === 'custom' ? { frogColor: colors.frog } : {}) }
  )

  return (
    <Box
      width={terminalWidth}
      height={terminalHeight}
      overflow="hidden"
      position="relative"
      backgroundColor={colors.background}
    >
      <Text>
        {artwork
          .split('\n')
          .map((row) => (terminalWidth > 1 ? ` ${row}${terminalWidth > 2 ? ' ' : ''}` : row))
          .join('\n')}
      </Text>
      <Box
        position="absolute"
        width="100%"
        height="100%"
        flexDirection="column"
        alignItems="center"
        justifyContent="flex-end"
      >
        <Text dimColor>[ space to skip ]</Text>
      </Box>
    </Box>
  )
}
