import { useEffect, useState, type ReactElement } from 'react'
import { Box } from 'ink'

import type { FrogTheme } from '../chat/types.js'
import { renderFrogAnimationRuns, type FrogAnimationVariant } from './frog-intro-renderer.js'
import { Text, useTheme } from './theme.js'

export type FrogVariant = FrogAnimationVariant

export const FROG_ANIMATION_HEIGHT = 14

const ANIMATIONS: Record<FrogVariant, { durationMs: number; staticProgress: number }> = {
  hop: { durationMs: 3_000, staticProgress: 0.5 },
  fly: { durationMs: 3_400, staticProgress: 0.7 },
  peek: { durationMs: 2_200, staticProgress: 0.5 },
  firefly: { durationMs: 3_800, staticProgress: 0.66 },
}
const FROG_VARIANTS = Object.keys(ANIMATIONS) as FrogVariant[]

export function parseFrogCommand(input: string, previous?: FrogVariant): FrogVariant | undefined {
  const match = input.trim().match(/^\/frog(?:\s+(hop|fly|peek|firefly))?$/i)
  if (!match) {
    return undefined
  }
  const requested = match[1]?.toLowerCase() as FrogVariant | undefined
  if (requested) {
    return requested
  }
  const previousIndex = previous ? FROG_VARIANTS.indexOf(previous) : -1
  return FROG_VARIANTS[(previousIndex + 1) % FROG_VARIANTS.length]
}

export function FrogEasterEgg({
  animationId,
  variant,
  width,
  top,
  animate,
  theme,
  customBase = 'green',
  onComplete,
}: {
  animationId: number
  variant: FrogVariant
  width: number
  top: number
  animate: boolean
  theme: FrogTheme
  customBase?: Exclude<FrogTheme, 'custom'>
  onComplete(id: number): void
}): ReactElement {
  const colors = useTheme()
  const [elapsedMs, setElapsedMs] = useState(0)
  const durationMs = animate ? ANIMATIONS[variant].durationMs : 1_200

  useEffect(() => {
    let completed = false
    const startedAt = Date.now()
    const tick = (): void => {
      const elapsed = Date.now() - startedAt
      setElapsedMs(elapsed)
      if (elapsed >= durationMs && !completed) {
        completed = true
        onComplete(animationId)
      }
    }
    tick()
    const timer = setInterval(tick, animate ? 80 : durationMs)
    return (): void => clearInterval(timer)
  }, [animate, animationId, durationMs, onComplete])

  const progress = animate ? elapsedMs / durationMs : ANIMATIONS[variant].staticProgress
  const runs = renderFrogAnimationRuns(width, FROG_ANIMATION_HEIGHT, variant, progress, elapsedMs, true, theme, {
    colorMode: colors.mode,
    customBase,
    ...(theme === 'custom' ? { frogColor: colors.frog } : {}),
  })
  return (
    <Box
      position="absolute"
      marginTop={top}
      width={Math.max(1, width)}
      height={FROG_ANIMATION_HEIGHT}
      overflow="hidden"
      aria-hidden
    >
      {runs.map((run) => (
        <Box key={`${run.row}:${run.column}`} position="absolute" marginTop={run.row} marginLeft={run.column}>
          <Text>{run.text}</Text>
        </Box>
      ))}
    </Box>
  )
}
