import { useEffect, useState, type ReactElement } from 'react'
import { Box, type DOMElement } from 'ink'

import type { FrogTheme } from '../chat/controller.js'
import {
  FROG_BRAND_EASTER_EGG_DURATION_MS,
  frogStartupHeight,
  frogStartupHitbox,
  frogStartupWidth,
  renderFrogBrandEasterEggFrame,
  renderFrogStartupLockup,
} from './frog-intro-renderer.js'
import { Text, useTheme } from './theme.js'

export function StartupView({
  terminalWidth,
  availableHeight,
  animate,
  frogBrandElapsedMs,
  onFrogElement,
  theme,
  customBase,
  party = false,
  partyElapsedMs = 0,
}: {
  terminalWidth: number
  availableHeight: number
  animate: boolean
  frogBrandElapsedMs?: number
  onFrogElement?: (element: DOMElement | null) => void
  theme: FrogTheme
  customBase?: Exclude<FrogTheme, 'custom'>
  party?: boolean
  partyElapsedMs?: number
}): ReactElement {
  const palette = useTheme()
  const frogOptions = {
    colorMode: palette.mode,
    ...(theme === 'custom' ? { frogColor: palette.frog } : {}),
    ...(customBase ? { customBase } : {}),
  }
  const maxWidth = Math.max(1, terminalWidth - 2)
  // Sized to the artwork so the column centers it.
  const lockupWidth = frogStartupWidth(maxWidth, frogStartupHeight(maxWidth, availableHeight))
  const lockupHeight = frogStartupHeight(lockupWidth, availableHeight)
  const frogHitbox = frogStartupHitbox(lockupWidth, lockupHeight)
  const brandElapsedMs = frogBrandElapsedMs ?? FROG_BRAND_EASTER_EGG_DURATION_MS
  const brandProgress = animate ? brandElapsedMs / FROG_BRAND_EASTER_EGG_DURATION_MS : brandElapsedMs < 800 ? 0.54 : 1
  return (
    <Box flexDirection="column" alignItems="center" paddingTop={lockupHeight > 2 ? 2 : 1} width="100%" flexShrink={0}>
      <Box width={lockupWidth} height={lockupHeight} overflow="hidden" position="relative">
        <Text>
          {frogBrandElapsedMs === undefined
            ? renderFrogStartupLockup(lockupWidth, true, partyElapsedMs, theme, party, frogOptions, lockupHeight)
            : renderFrogBrandEasterEggFrame(
                lockupWidth,
                brandProgress,
                brandElapsedMs,
                true,
                theme,
                party,
                partyElapsedMs,
                frogOptions,
                lockupHeight
              )}
        </Text>
        {onFrogElement && lockupHeight > 1 ? (
          <Box
            ref={onFrogElement}
            position="absolute"
            marginLeft={frogHitbox.left}
            marginTop={frogHitbox.top}
            width={frogHitbox.width}
            height={frogHitbox.height}
          />
        ) : null}
      </Box>
    </Box>
  )
}

export function useBrandAnimation(animationId: number | undefined, animate = true): number {
  const [elapsedMs, setElapsedMs] = useState(FROG_BRAND_EASTER_EGG_DURATION_MS)

  useEffect(() => {
    if (animationId === undefined) {
      return
    }
    const durationMs = animate ? FROG_BRAND_EASTER_EGG_DURATION_MS : 800
    const startedAt = Date.now()
    setElapsedMs(0)
    const timer = setInterval(() => {
      const elapsedMs = Date.now() - startedAt
      setElapsedMs(Math.min(durationMs, elapsedMs))
      if (elapsedMs >= durationMs) {
        clearInterval(timer)
      }
    }, 32)
    return (): void => clearInterval(timer)
  }, [animate, animationId])

  return elapsedMs
}
