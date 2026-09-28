import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useStdout } from 'ink'

import { Box, Text, useTheme } from '../theme.js'

const PARTIAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const
const PROGRESS_DURATION_MS = 240

export function SetupProgress({
  current,
  total,
  label = `${current} of ${total}`,
  width,
  animate,
}: {
  current: number
  total: number
  label?: string
  width: number
  animate: boolean
}): ReactElement {
  const { stdout } = useStdout()
  const { accent } = useTheme()
  const target = Math.max(0, Math.min(1, current / Math.max(1, total)))
  const progressRef = useRef(target)
  const [progress, setProgress] = useState(target)
  const enabled = animate && stdout.isTTY

  useEffect(() => {
    if (!enabled) {
      progressRef.current = target
      setProgress(target)
      return
    }
    const start = progressRef.current
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const elapsed = Math.min(1, (Date.now() - startedAt) / PROGRESS_DURATION_MS)
      const eased = elapsed * elapsed * (3 - 2 * elapsed)
      const next = start + (target - start) * eased
      progressRef.current = next
      setProgress(next)
      if (elapsed === 1) {
        clearInterval(timer)
      }
    }, 24)
    return (): void => clearInterval(timer)
  }, [enabled, target])

  const barWidth = Math.max(3, width - label.length - 2)
  const eighths = Math.round(progress * barWidth * 8)
  const fullBlocks = Math.floor(eighths / 8)
  const partialBlock = PARTIAL_BLOCKS[eighths % 8]
  const remainingBlocks = Math.max(0, barWidth - fullBlocks - Number(Boolean(partialBlock)))

  return (
    <Box width={width} height={1} flexShrink={0}>
      <Text color={accent}>
        {'█'.repeat(fullBlocks)}
        {partialBlock}
      </Text>
      <Text dimColor>{'░'.repeat(remainingBlocks)}</Text>
      <Box flexGrow={1} />
      <Text dimColor>{label}</Text>
    </Box>
  )
}
