import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import type { Key } from 'ink'

import { sanitizeTerminalText } from '../../terminal/text.js'
import { Box, Text, useTheme } from '../../ui/theme.js'

export type Tone = 'success' | 'error' | 'warning' | 'muted'

export interface ListItem {
  readonly key: string
  readonly label: string
  readonly detail?: string
  readonly mark?: { readonly text: string; readonly tone?: Tone }
  readonly tone?: Tone
}

const PROGRESS_WIDTH = 16
const ELAPSED_TICK_MS = 1000
const SECONDS_PER_MINUTE = 60

export const oneLine = (text: string): string => sanitizeTerminalText(text).replace(/\s+/gu, ' ').trim()

const indented = (text: string): string => `${/^ */u.exec(text)?.[0] ?? ''}${oneLine(text)}`

export const quoted = (text: string): string => `"${oneLine(text)}"`

export const shortcut = (input: string, key: Key): string => (key.ctrl || key.meta ? '' : input)

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

export const formatSeconds = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds))
  return whole < SECONDS_PER_MINUTE
    ? `${whole}s`
    : `${Math.floor(whole / SECONDS_PER_MINUTE)}m ${whole % SECONDS_PER_MINUTE}s`
}

export const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`

export const useElapsed = (startedAt: number): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return (): void => clearInterval(timer)
  }, [startedAt])
  return Math.max(0, (now - startedAt) / ELAPSED_TICK_MS)
}

const useToneColor = (): ((tone: Tone | undefined) => { color?: string; dimColor?: boolean }) => {
  const { success, error, warning } = useTheme()
  return (tone) => {
    if (tone === 'success') return { color: success }
    if (tone === 'error') return { color: error }
    if (tone === 'warning') return { color: warning }
    if (tone === 'muted') return { dimColor: true }
    return {}
  }
}

export const SplitLine = ({ left, right }: { left: ReactNode; right?: ReactNode }): ReactElement => (
  <Box height={1} flexShrink={0} justifyContent="space-between" overflow="hidden">
    <Box flexShrink={1} overflow="hidden">
      {left}
    </Box>
    {right === undefined ? null : (
      <Box flexShrink={0} marginLeft={2}>
        {right}
      </Box>
    )}
  </Box>
)

export const PanelTitle = ({
  name,
  parts = [],
  right,
}: {
  name: string
  parts?: readonly string[]
  right?: ReactNode
}): ReactElement => {
  const { accent } = useTheme()
  return (
    <SplitLine
      left={
        <Text wrap="truncate-end">
          <Text color={accent} bold>
            {oneLine(name)}
          </Text>
          {parts.map((part, index) => (
            <Text key={`${index}:${part}`}>{` · ${oneLine(part)}`}</Text>
          ))}
        </Text>
      }
      right={right}
    />
  )
}

export const Line = ({ children, tone }: { children: string; tone?: Tone }): ReactElement => {
  const toneColor = useToneColor()
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Text wrap="truncate-end" {...toneColor(tone)}>
        {indented(children)}
      </Text>
    </Box>
  )
}

export const Paragraph = ({ children, rows, tone }: { children: string; rows: number; tone?: Tone }): ReactElement => {
  const toneColor = useToneColor()
  return (
    <Box height={Math.max(1, rows)} flexShrink={0} overflow="hidden">
      <Text wrap="wrap" {...toneColor(tone)}>
        {sanitizeTerminalText(children)}
      </Text>
    </Box>
  )
}

export const Gap = ({ rows = 1 }: { rows?: number }): ReactElement => <Box height={rows} flexShrink={0} />

export const Fill = (): ReactElement => <Box flexGrow={1} flexShrink={1} />

export const Rule = ({ width }: { width: number }): ReactElement => (
  <Box height={1} flexShrink={0} overflow="hidden">
    <Text dimColor>{'─'.repeat(Math.max(0, width))}</Text>
  </Box>
)

export const KeyHints = ({ hints }: { hints: readonly string[] }): ReactElement => (
  <Box height={1} flexShrink={0} overflow="hidden">
    <Text dimColor wrap="truncate-end">
      {hints.join(' · ')}
    </Text>
  </Box>
)

export const ProgressBar = ({ done, total }: { done: number; total: number }): ReactElement => {
  const { accent } = useTheme()
  const clamped = Math.max(0, Math.min(done, total))
  const filled = total > 0 ? Math.round((clamped / total) * PROGRESS_WIDTH) : 0
  return (
    <Text>
      <Text color={accent}>{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(PROGRESS_WIDTH - filled)}</Text>
      <Text>{` ${clamped}/${total}`}</Text>
    </Text>
  )
}

export const Field = ({
  label,
  value,
  labelWidth,
  rows = 1,
  tone,
}: {
  label: string
  value: string
  labelWidth: number
  rows?: number
  tone?: Tone
}): ReactElement => {
  const toneColor = useToneColor()
  return (
    <Box height={Math.max(1, rows)} flexShrink={0} overflow="hidden">
      <Box width={labelWidth} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap={rows > 1 ? 'wrap' : 'truncate-end'} {...toneColor(tone)}>
          {rows > 1 ? sanitizeTerminalText(value) : oneLine(value)}
        </Text>
      </Box>
    </Box>
  )
}

export const listWindow = (selected: number, count: number, capacity: number): { start: number; end: number } => {
  if (count <= capacity) return { start: 0, end: count }
  const visible = capacity > 1 ? capacity - 1 : 1
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), count - visible))
  return { start, end: start + visible }
}

export const ItemList = ({
  items,
  selected,
  capacity,
  labelWidth,
}: {
  items: readonly ListItem[]
  selected: number
  capacity: number
  labelWidth: number
}): ReactElement => {
  const { accent, selection } = useTheme()
  const toneColor = useToneColor()
  const { start, end } = listWindow(selected, items.length, Math.max(1, capacity))
  const hidden = items.length - (end - start)
  return (
    <Box flexDirection="column" flexShrink={0}>
      {items.slice(start, end).map((item, offset) => {
        const active = start + offset === selected
        return (
          <Box key={item.key} height={1} width="100%" {...(active ? { backgroundColor: selection } : {})}>
            <Box flexShrink={0}>
              <Text color={accent}>{active ? '› ' : '  '}</Text>
              {item.mark ? <Text {...toneColor(item.mark.tone)}>{`${item.mark.text} `}</Text> : null}
            </Box>
            <Box width={labelWidth} flexShrink={0} overflow="hidden">
              <Text bold={active} wrap="truncate-end">
                {oneLine(item.label)}
              </Text>
            </Box>
            {item.detail ? (
              <Box flexShrink={1} marginLeft={2} overflow="hidden">
                <Text wrap="truncate-end" {...toneColor(item.tone)}>
                  {oneLine(item.detail)}
                </Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
      {hidden > 0 && capacity > 1 ? <Line tone="muted">{`  …${hidden} more`}</Line> : null}
    </Box>
  )
}

export const labelWidthFor = (labels: readonly string[], width: number): number =>
  Math.min(Math.max(8, ...labels.map((label) => oneLine(label).length)), Math.max(8, Math.floor(width / 3)))
