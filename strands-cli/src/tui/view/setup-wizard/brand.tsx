import type { ReactElement } from 'react'
import { Box, type DOMElement } from 'ink'

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
} from '../frog-intro-renderer.js'
import { COMPACT_LOCKUP_TOP_PADDING, startupLockupLeft, startupLockupTopPadding } from '../interaction.js'
import { useStartupIntro } from '../startup-view.js'
import { Text, useTheme } from '../theme.js'
import type { AppearanceSettings } from './types.js'

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
