import { createContext, Fragment, useContext, type ReactElement } from 'react'
import { Box, type DOMElement } from 'ink'
import type { ChatPanel, ChatSnapshot } from '../chat/types.js'
import type { MetadataTarget } from './interaction.js'
import { contextColor, metadataPlacements } from './presentation.js'
import { Text, useTheme } from './theme.js'

export const PanelHelpContext = createContext<ChatPanel | undefined>(undefined)

export function PanelHelpFooter({
  width,
  centered = false,
}: {
  width: number
  centered?: boolean
}): ReactElement | null {
  const panel = useContext(PanelHelpContext)
  if (!panel) return null
  const permission = panel.kind === 'permission'
  const detail = panel.kind === 'detail'
  const actionable = panel.rows.some((row) => row.value !== undefined)
  const keys = permission
    ? '↑↓ · Enter choose · Esc deny'
    : detail
      ? '↑↓ scroll · Esc back'
      : panel.kind === 'rename'
        ? 'Enter save · Ctrl+U clear · Esc cancel'
        : panel.kind === 'effort'
          ? '←→ change · Enter done · Esc close'
          : !actionable
            ? 'Esc close'
            : panel.kind === 'settings'
              ? width < 42
                ? '↑↓ move · ←→ change · Esc back'
                : '↑↓ · ←→ change · Tab category · Esc back'
              : panel.kind === 'models'
                ? 'Tab · Enter choose · Esc back'
                : panel.kind === 'tools' || panel.kind === 'permissions'
                  ? '↑↓ · Enter toggle · Esc save'
                  : panel.kind === 'skills'
                    ? '↑↓ · Enter run · → details · Esc back'
                    : panel.filters?.length
                      ? 'Tab category · Enter · Esc back'
                      : '↑↓ · Enter open · Esc back'
  return (
    <Box width={Math.max(1, width)} height={1} flexShrink={0} justifyContent={centered ? 'center' : 'flex-start'}>
      <Text dimColor wrap="truncate-end">
        {keys}
      </Text>
    </Box>
  )
}

export function ComposerFooter({
  snapshot,
  width,
  pressed,
  hovered,
  settingsHovered = false,
  onMetadataElement,
  onActionElement,
}: {
  snapshot: ChatSnapshot
  width: number
  pressed?: MetadataTarget
  hovered?: MetadataTarget
  settingsHovered?: boolean
  onMetadataElement?: (target: MetadataTarget, element: DOMElement | null) => void
  onActionElement?: (action: 'settings' | 'setup' | 'help', element: DOMElement | null) => void
}): ReactElement {
  const palette = useTheme()
  const { accent, foreground } = palette
  return (
    <Box height={1} marginTop={1} width={width} flexShrink={0} paddingX={1} overflow="hidden">
      {metadataPlacements(snapshot, width).map((segment) => (
        <Box
          key={segment.target}
          width={segment.width}
          flexShrink={0}
          justifyContent={segment.alignment}
          overflow="hidden"
        >
          {segment.target === 'settings' ? (
            <Box ref={(element) => onActionElement?.('settings', element)}>
              <Text color={settingsHovered ? accent : foreground}>{segment.text}</Text>
            </Box>
          ) : segment.controls ? (
            segment.controls.map((control, index) => (
              <Fragment key={control.target}>
                {index > 0 ? <Text color={foreground}> • </Text> : null}
                <Box ref={(element) => onMetadataElement?.(control.target, element)}>
                  <Text
                    color={
                      hovered === control.target || pressed === control.target
                        ? accent
                        : control.target === 'context'
                          ? contextColor(snapshot.context, palette)
                          : foreground
                    }
                  >
                    {control.text}
                  </Text>
                </Box>
              </Fragment>
            ))
          ) : (
            <Text dimColor>{segment.text}</Text>
          )}
        </Box>
      ))}
    </Box>
  )
}
