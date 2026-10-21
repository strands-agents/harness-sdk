import type { ReactElement } from 'react'

import { Box, Text, useTheme } from '../theme.js'

export function SetupToggle({
  checked,
  focused = false,
  disabled = false,
}: {
  checked: boolean
  focused?: boolean
  disabled?: boolean
}): ReactElement {
  const { accent, foreground } = useTheme()
  return (
    <Box width={9} flexShrink={0}>
      <Text
        color={checked || focused ? accent : foreground}
        bold={!disabled && (checked || focused)}
        dimColor={disabled}
        wrap="truncate-end"
      >
        {checked ? ' ━━● On  ' : ' ●━━ Off '}
      </Text>
    </Box>
  )
}
