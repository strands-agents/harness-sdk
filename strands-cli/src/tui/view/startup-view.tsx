import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { Box, type DOMElement, useStdout } from 'ink'

import type { FrogTheme } from '../chat/controller.js'
import {
  FROG_BRAND_EASTER_EGG_DURATION_MS,
  FROG_FULL_LOCKUP_MIN_WIDTH,
  FROG_INTRO_DURATION_MS,
  frogStartupHeight,
  frogStartupHitbox,
  frogStartupWidth,
  renderFrogBrandEasterEggFrame,
  renderFrogSpiralFrame,
  renderFrogStartupLockup,
} from './frog-intro-renderer.js'
import { startupLockupLeft, startupLockupTopPadding } from './interaction.js'
import { Text, useTheme } from './theme.js'

const LOCKUP_SLIDE_DURATION_MS = 400

export function StartupView({
  terminalWidth,
  availableHeight,
  animate,
  reservedRightWidth = 0,
  introStartedAt,
  frogBrandElapsedMs,
  onFrogElement,
  theme,
  party = false,
  partyElapsedMs = 0,
}: {
  terminalWidth: number
  availableHeight: number
  animate: boolean
  reservedRightWidth?: number
  introStartedAt?: number
  frogBrandElapsedMs?: number
  onFrogElement?: (element: DOMElement | null) => void
  theme: FrogTheme
  party?: boolean
  partyElapsedMs?: number
}): ReactElement {
  const palette = useTheme()
  const frogOptions = { colorMode: palette.mode }
  const maxWidth = Math.max(1, terminalWidth - 2)
  const artworkMaxWidth = Math.max(1, maxWidth - reservedRightWidth)
  // Sized to the artwork so the column centers it.
  const lockupWidth = frogStartupWidth(artworkMaxWidth, frogStartupHeight(artworkMaxWidth, availableHeight))
  const lockupHeight = frogStartupHeight(lockupWidth, availableHeight)
  const fullLockup =
    lockupWidth >= FROG_FULL_LOCKUP_MIN_WIDTH && lockupHeight >= frogStartupHeight(lockupWidth, Infinity)
  const paddingTop = startupLockupTopPadding(fullLockup, lockupHeight)
  // The hopping frog needs more headroom than the resting artwork.
  const headerHeight = fullLockup ? 24 : paddingTop + lockupHeight + 1
  const introElapsedMs = useStartupIntro(introStartedAt, animate && fullLockup)
  const frogHitbox = frogStartupHitbox(lockupWidth, lockupHeight)
  const brandElapsedMs = useBrandAnimationFrame(
    frogBrandElapsedMs ?? FROG_BRAND_EASTER_EGG_DURATION_MS,
    lockupWidth,
    lockupHeight
  )
  const horizontalOffset = useLockupSlide(-reservedRightWidth / 2, animate)
  const lockupLeft = startupLockupLeft(maxWidth, lockupWidth, horizontalOffset)
  const animationOrigin = frogBrandElapsedMs === undefined ? { x: 0, y: 0 } : { x: lockupLeft, y: paddingTop }
  const brandProgress = animate ? brandElapsedMs / FROG_BRAND_EASTER_EGG_DURATION_MS : brandElapsedMs < 800 ? 0.54 : 1
  if (introElapsedMs < FROG_INTRO_DURATION_MS && frogBrandElapsedMs === undefined) {
    return (
      <Box width="100%" height={headerHeight} flexShrink={0} overflow="hidden">
        <Text>
          {renderFrogSpiralFrame(
            maxWidth,
            headerHeight,
            introElapsedMs / FROG_INTRO_DURATION_MS,
            introElapsedMs,
            true,
            theme,
            frogOptions,
            lockupHeight,
            lockupLeft,
            paddingTop
          )}
        </Text>
      </Box>
    )
  }
  return (
    <Box height={headerHeight} width="100%" flexShrink={0} overflow="hidden" position="relative">
      <Box
        width={lockupWidth + animationOrigin.x}
        height={lockupHeight + animationOrigin.y}
        flexShrink={0}
        overflow="hidden"
        position="absolute"
        marginLeft={lockupLeft - animationOrigin.x}
        marginTop={paddingTop - animationOrigin.y}
      >
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
                lockupHeight,
                animationOrigin
              )}
        </Text>
        {onFrogElement && lockupHeight > 1 ? (
          <Box
            ref={onFrogElement}
            position="absolute"
            marginLeft={frogHitbox.left + animationOrigin.x}
            marginTop={frogHitbox.top + animationOrigin.y}
            width={frogHitbox.width}
            height={frogHitbox.height}
          />
        ) : null}
      </Box>
    </Box>
  )
}

function useLockupSlide(target: number, animate: boolean): number {
  const { stdout } = useStdout()
  const enabled = animate && stdout.isTTY
  const current = useRef(0)
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    if (!enabled) {
      current.current = target
      setOffset(target)
      return
    }
    const from = current.current
    if (from === target) {
      return
    }
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const elapsed = Math.min(1, (Date.now() - startedAt) / LOCKUP_SLIDE_DURATION_MS)
      const eased = elapsed * elapsed * (3 - 2 * elapsed)
      const next = from + (target - from) * eased
      current.current = next
      setOffset(next)
      if (elapsed === 1) {
        clearInterval(timer)
      }
    }, 32)
    return (): void => clearInterval(timer)
  }, [enabled, target])

  return enabled ? offset : target
}

export function useStartupIntro(startedAt: number | undefined, animate: boolean): number {
  const [elapsedMs, setElapsedMs] = useState(() =>
    startedAt === undefined ? FROG_INTRO_DURATION_MS : Math.min(FROG_INTRO_DURATION_MS, Date.now() - startedAt)
  )
  useEffect(() => {
    if (startedAt === undefined || !animate || Date.now() - startedAt >= FROG_INTRO_DURATION_MS) {
      setElapsedMs(FROG_INTRO_DURATION_MS)
      return
    }
    const timer = setInterval(() => {
      const elapsed = Math.min(FROG_INTRO_DURATION_MS, Date.now() - startedAt)
      setElapsedMs(elapsed)
      if (elapsed >= FROG_INTRO_DURATION_MS) clearInterval(timer)
    }, 50)
    return (): void => clearInterval(timer)
  }, [startedAt, animate])
  return animate ? elapsedMs : FROG_INTRO_DURATION_MS
}

export function useBrandAnimationFrame(elapsedMs: number, width: number, height: number): number {
  const previous = useRef({ elapsedMs, complete: false })
  const fits = width >= FROG_FULL_LOCKUP_MIN_WIDTH && height >= frogStartupHeight(width, Infinity)
  // A decreasing clock starts a new click animation; expanding the canvas does not.
  const complete = !fits || (elapsedMs >= previous.current.elapsedMs && previous.current.complete)
  useLayoutEffect(() => {
    previous.current = { elapsedMs, complete }
  }, [elapsedMs, complete])
  return complete ? FROG_BRAND_EASTER_EGG_DURATION_MS : elapsedMs
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
