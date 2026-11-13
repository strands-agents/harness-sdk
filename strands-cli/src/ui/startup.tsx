import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { Box, type DOMElement, useStdout } from 'ink'
import { type FrogTheme } from './chat/controller.js'
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
} from './frog-renderer.js'
import { startupLockupLeft, startupLockupTopPadding, COMPACT_LOCKUP_TOP_PADDING } from './interaction.js'
import { Text, useTheme } from './theme.js'
import { useTerminalSize } from './terminal-size.js'
import { type AppearanceSettings } from './setup/steps.js'
import { useSpinner } from './animation.js'

const LOCKUP_SLIDE_DURATION_MS = 400

export function StartupStatus({ status, animate }: { status: string; animate: boolean }): ReactElement {
  const spinner = useSpinner(true, animate)
  return (
    <Text dimColor wrap="truncate-end">
      {spinner} {status}
    </Text>
  )
}

export const StartupContentRows = createContext<number | undefined>(undefined)

export const useStartupContentRows = (): number => {
  const rows = useContext(StartupContentRows)
  const { rows: terminalRows } = useTerminalSize()
  return rows ?? terminalRows
}

export const startupHeaderLayout = (
  terminalWidth: number,
  availableHeight: number,
  reservedRightWidth = 0
): {
  maxWidth: number
  lockupWidth: number
  lockupHeight: number
  fullLockup: boolean
  paddingTop: number
  headerHeight: number
} => {
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
  return { maxWidth, lockupWidth, lockupHeight, fullLockup, paddingTop, headerHeight }
}

export function StartupView({
  terminalWidth,
  availableHeight,
  animate,
  reservedRightWidth = 0,
  maxHeight = Infinity,
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
  maxHeight?: number
  introStartedAt?: number
  frogBrandElapsedMs?: number
  onFrogElement?: (element: DOMElement | null) => void
  theme: FrogTheme
  party?: boolean
  partyElapsedMs?: number
}): ReactElement {
  const palette = useTheme()
  const frogOptions = { colorMode: palette.mode }
  const { maxWidth, lockupWidth, lockupHeight, fullLockup, paddingTop, headerHeight } = startupHeaderLayout(
    terminalWidth,
    availableHeight,
    reservedRightWidth
  )
  const headerRows = Math.max(1, Math.min(headerHeight, maxHeight))
  const lockupTop = Math.max(0, Math.min(paddingTop, headerRows - lockupHeight))
  const introElapsedMs = useStartupIntro(introStartedAt, animate && fullLockup)
  const frogHitbox = frogStartupHitbox(lockupWidth, lockupHeight)
  const brandElapsedMs = useBrandAnimationFrame(
    frogBrandElapsedMs ?? FROG_BRAND_EASTER_EGG_DURATION_MS,
    lockupWidth,
    lockupHeight
  )
  const horizontalOffset = useLockupSlide(-reservedRightWidth / 2, animate)
  const lockupLeft = startupLockupLeft(maxWidth, lockupWidth, horizontalOffset)
  const animationOrigin = frogBrandElapsedMs === undefined ? { x: 0, y: 0 } : { x: lockupLeft, y: lockupTop }
  const brandProgress = animate ? brandElapsedMs / FROG_BRAND_EASTER_EGG_DURATION_MS : brandElapsedMs < 800 ? 0.54 : 1
  if (introElapsedMs < FROG_INTRO_DURATION_MS && frogBrandElapsedMs === undefined) {
    return (
      <Box width="100%" height={headerRows} flexShrink={0} overflow="hidden">
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
            lockupTop
          )}
        </Text>
      </Box>
    )
  }
  return (
    <Box height={headerRows} width="100%" flexShrink={0} overflow="hidden" position="relative">
      <Box
        width={lockupWidth + animationOrigin.x}
        height={lockupHeight + animationOrigin.y}
        flexShrink={0}
        overflow="hidden"
        position="absolute"
        marginLeft={lockupLeft - animationOrigin.x}
        marginTop={lockupTop - animationOrigin.y}
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

// Sized for the tallest step so the brand never resizes between steps.
const SETUP_CONTENT_MIN_HEIGHT = 24

/** Sizes the lockup for the room setup leaves it and centers it exactly as the chat startup view does. */
export function setupBrandFrame(
  width: number,
  terminalHeight: number
): { left: number; width: number; height: number; top: number } {
  const maxWidth = Math.max(1, width)
  const fullHeight = frogStartupHeight(maxWidth, Number.POSITIVE_INFINITY)
  const fullTop = startupLockupTopPadding(maxWidth >= FROG_FULL_LOCKUP_MIN_WIDTH, fullHeight)
  const placed = (height: number, top: number): { left: number; width: number; height: number; top: number } => {
    const lockupWidth = frogStartupWidth(maxWidth, height)
    return { left: startupLockupLeft(maxWidth, lockupWidth), width: lockupWidth, height, top }
  }
  if (terminalHeight - SETUP_CONTENT_MIN_HEIGHT - fullTop >= fullHeight) {
    return placed(fullHeight, fullTop)
  }
  const availableHeight = Math.max(1, terminalHeight - SETUP_CONTENT_MIN_HEIGHT - COMPACT_LOCKUP_TOP_PADDING)
  // Compact startup sizing reserves eight surrounding rows; setup already reserves its content and padding.
  const height = Math.min(availableHeight, frogStartupHeight(maxWidth, availableHeight + 8))
  return placed(height, startupLockupTopPadding(false, height))
}

export function SetupBrand({
  frame,
  containerWidth,
  appearance,
  animationId,
  introStartedAt,
  elapsedMs,
  onFrogElement,
}: {
  frame: { left: number; width: number; height: number; top: number }
  containerWidth: number
  appearance: AppearanceSettings
  animationId: number | undefined
  introStartedAt?: number
  elapsedMs: number
  onFrogElement(element: DOMElement | null): void
}): ReactElement {
  const palette = useTheme()
  const frogTheme = appearance.frogTheme
  const frogOptions = { colorMode: palette.mode }
  const { left, width, height, top } = frame
  const animationOrigin = animationId === undefined ? { x: 0, y: 0 } : { x: left, y: top }
  const frogHitbox = frogStartupHitbox(width, height)
  const introElapsedMs = useStartupIntro(introStartedAt, appearance.animations)
  if (introElapsedMs < FROG_INTRO_DURATION_MS && animationId === undefined) {
    return (
      <Box width={containerWidth} height={height + top} flexShrink={0} overflow="hidden">
        <Text>
          {renderFrogSpiralFrame(
            containerWidth,
            height + top,
            introElapsedMs / FROG_INTRO_DURATION_MS,
            introElapsedMs,
            true,
            frogTheme,
            frogOptions,
            height,
            left,
            top
          )}
        </Text>
      </Box>
    )
  }
  return (
    <Box
      height={height + top}
      paddingTop={top - animationOrigin.y}
      paddingLeft={left - animationOrigin.x}
      flexShrink={0}
      overflow="hidden"
      position="relative"
    >
      <Box width={width + animationOrigin.x} height={height + animationOrigin.y} overflow="hidden" position="relative">
        <Text>
          {animationId === undefined
            ? renderFrogStartupLockup(width, true, 0, frogTheme, false, frogOptions, height)
            : renderFrogBrandEasterEggFrame(
                width,
                elapsedMs / FROG_BRAND_EASTER_EGG_DURATION_MS,
                elapsedMs,
                true,
                frogTheme,
                false,
                0,
                frogOptions,
                height,
                animationOrigin
              )}
        </Text>
        <Box
          ref={onFrogElement}
          position="absolute"
          marginLeft={frogHitbox.left + animationOrigin.x}
          marginTop={frogHitbox.top + animationOrigin.y}
          width={frogHitbox.width}
          height={frogHitbox.height}
        />
      </Box>
    </Box>
  )
}
