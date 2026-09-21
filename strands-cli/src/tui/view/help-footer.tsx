import { createContext, useContext, type ReactElement } from 'react'
import { Box, type DOMElement } from 'ink'
import type { ChatPanel, ChatSnapshot } from '../chat/types.js'
import { Text, useTheme } from './theme.js'

export const PanelHelpContext = createContext<ChatPanel | undefined>(undefined)

export function PanelHelpFooter({ width }: { width: number }): ReactElement | null {
  const panel = useContext(PanelHelpContext)
  if (!panel) return null
  const permission = panel.kind === 'permission'
  const detail = panel.kind === 'detail'
  const actionable = panel.rows.some((row) => row.value !== undefined)
  const keys = permission
    ? '↑↓ · Enter choose · Esc deny'
    : detail
      ? '↑↓ scroll · Esc back'
      : !actionable
        ? 'Esc close'
        : panel.kind === 'settings'
          ? width < 42
            ? '↑↓ move · ←→ change · Esc back'
            : '↑↓ · ←→ change · Tab category · Esc back'
          : panel.kind === 'models'
            ? 'Tab · Enter choose · Esc back'
            : panel.filters?.length
              ? 'Tab category · Enter · Esc back'
              : '↑↓ · Enter open · Esc back'
  return (
    <Box width={Math.max(1, width)} height={1} flexShrink={0}>
      <Text dimColor wrap="truncate-end">
        {keys}
      </Text>
    </Box>
  )
}

export function ComposerHelpFooter({
  snapshot,
  width,
  onActionElement,
}: {
  snapshot: ChatSnapshot
  width: number
  onActionElement?: (action: 'settings' | 'setup' | 'help', element: DOMElement | null) => void
}): ReactElement {
  const { foreground, selection } = useTheme()
  const running = snapshot.status === 'running'
  const compact = width < 25
  return (
    <Box
      height={1}
      marginTop={1}
      marginX={compact ? -1 : 0}
      flexShrink={0}
      paddingX={compact ? 0 : 1}
      justifyContent="space-between"
    >
      <Box flexShrink={1} overflow="hidden">
        <Text dimColor wrap="truncate-end">
          <Text color={foreground}>Enter</Text> {running ? 'queue' : 'send'}
          {running ? (
            <>
              {' · '}
              <Text color={foreground}>Esc</Text> stop
            </>
          ) : (
            <>
              {width >= 86 ? (
                <>
                  {' · '}
                  <Text color={foreground}>Shift+Enter</Text> newline
                </>
              ) : null}
              {width >= 62 ? (
                <>
                  {' '}
                  · <Text color={foreground}>/</Text> commands
                </>
              ) : null}
            </>
          )}
        </Text>
      </Box>
      <Box flexShrink={0}>
        {(['settings', 'setup', 'help'] as const).map((action) => (
          <Box
            key={action}
            ref={(element) => onActionElement?.(action, element)}
            marginLeft={compact && action === 'settings' ? 0 : 1}
          >
            <Text backgroundColor={selection}>/{action}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
