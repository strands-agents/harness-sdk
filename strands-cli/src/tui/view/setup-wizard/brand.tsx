import type { ReactElement } from 'react'
import { Box, type DOMElement } from 'ink'

import {
  FROG_BRAND_EASTER_EGG_DURATION_MS,
  frogStartupHitbox,
  renderFrogBrandEasterEggFrame,
  renderFrogStartupLockup,
} from '../frog-intro-renderer.js'
import { Text, useTheme } from '../theme.js'
import type { AppearanceSettings } from './types.js'

export function SetupBrand({
  width,
  height,
  appearance,
  animationId,
  elapsedMs,
  onFrogElement,
}: {
  width: number
  height: number
  appearance: AppearanceSettings
  animationId: number | undefined
  elapsedMs: number
  onFrogElement(element: DOMElement | null): void
}): ReactElement {
  const palette = useTheme()
  const frogTheme = appearance.frogTheme
  const frogOptions = {
    colorMode: palette.mode,
    customBase: appearance.customTheme.base,
    ...(frogTheme === 'custom' ? { frogColor: palette.frog } : {}),
  }
  const frogHitbox = frogStartupHitbox(width, height)
  return (
    <Box width={width} height={height + 2} paddingTop={2} flexShrink={0} overflow="hidden" position="relative">
      <Box width={width} height={height} overflow="hidden" position="relative">
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
                height
              )}
        </Text>
        <Box
          ref={onFrogElement}
          position="absolute"
          marginLeft={frogHitbox.left}
          marginTop={frogHitbox.top}
          width={frogHitbox.width}
          height={frogHitbox.height}
        />
      </Box>
    </Box>
  )
}
