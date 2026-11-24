import { useCallback, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { type Key } from 'ink'

import { emptyEditor, reduceInputSequence, type EditorState } from '../../terminal/composer.js'
import { graphemes, sanitizeTerminalText } from '../../terminal/text.js'
import { EditableText } from '../text-input.js'
import { Box, Text, useTheme } from '../theme.js'
import { useDevPanelClicks } from './dev.js'

export type Tone = 'success' | 'error' | 'warning' | 'muted'

export interface ListItem {
  readonly key: string
  readonly label: string
  readonly detail?: string
  readonly mark?: { readonly text: string; readonly tone?: Tone }
  readonly tone?: Tone
}

// The cursor and the mark that a list row draws before its label.
const LIST_MARK_COLUMNS = 4

export const oneLine = (text: string): string => sanitizeTerminalText(text).replace(/\s+/gu, ' ').trim()

const indented = (text: string): string => `${/^ */u.exec(text)?.[0] ?? ''}${oneLine(text)}`

export const shortcut = (input: string, key: Key): string => (key.ctrl || key.meta ? '' : input)

export const useToneColor = (): ((tone: Tone | undefined) => { color?: string; dimColor?: boolean }) => {
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

/** `verbatim` keeps the spacing inside the text, for a line of someone's file rather than a label. */
export const Line = ({
  children,
  tone,
  verbatim = false,
}: {
  children: string
  tone?: Tone
  verbatim?: boolean
}): ReactElement => {
  const toneColor = useToneColor()
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Text wrap="truncate-end" {...toneColor(tone)}>
        {verbatim ? sanitizeTerminalText(children).replace(/[\r\n]+/gu, ' ') : indented(children)}
      </Text>
    </Box>
  )
}

export const Gap = ({ rows = 1 }: { rows?: number }): ReactElement => <Box height={rows} flexShrink={0} />

export const Fill = (): ReactElement => <Box flexGrow={1} flexShrink={1} />

export const KeyHints = ({ hints }: { hints: readonly string[] }): ReactElement => (
  <Box height={1} flexShrink={0} overflow="hidden">
    <Text dimColor wrap="truncate-end">
      {hints.join(' · ')}
    </Text>
  </Box>
)

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
  onClick,
  onHover,
}: {
  items: readonly ListItem[]
  selected: number
  capacity: number
  labelWidth: number
  onClick?: (index: number) => void
  onHover?: (index: number) => void
}): ReactElement => {
  const { accent, selection } = useTheme()
  const toneColor = useToneColor()
  const clicks = useDevPanelClicks()
  const { start, end } = listWindow(selected, items.length, Math.max(1, capacity))
  const overflow = [start > 0 ? `↑ ${start} previous` : '', end < items.length ? `↓ ${items.length - end} more` : '']
    .filter(Boolean)
    .join(' · ')
  return (
    <Box flexDirection="column" flexShrink={0}>
      {items.slice(start, end).map((item, offset) => {
        const index = start + offset
        const active = index === selected
        return (
          <Box
            key={item.key}
            height={1}
            width="100%"
            {...(active ? { backgroundColor: selection } : {})}
            {...(clicks && onClick
              ? { ref: clicks.target(() => onClick(index), onHover ? (): void => onHover(index) : undefined) }
              : {})}
          >
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
      {overflow && capacity > 1 ? <Line tone="muted">{`  ${overflow}`}</Line> : null}
    </Box>
  )
}

/** Labels share the row with a detail and keep to a third of it; with no detail beside them they take what they need. */
export const labelWidthFor = (labels: readonly string[], width: number, detailed = true): number =>
  Math.min(
    Math.max(8, ...labels.map((label) => oneLine(label).length)),
    Math.max(8, detailed ? Math.floor(width / 3) : width - LIST_MARK_COLUMNS)
  )

export type TextValue = EditorState

export const textValue = (text: string): TextValue => ({
  ...emptyEditor(),
  input: text,
  cursor: graphemes(text).length,
})

export const editText = (value: TextValue, input: string, key: Key): TextValue =>
  reduceInputSequence(value, input.replace(/\r?\n/gu, ' '), key, 'idle').state

export const pasteText = (value: TextValue, text: string): TextValue =>
  reduceInputSequence(value, text.replace(/\r?\n/gu, ' '), {}, 'idle').state

export const TextField = ({
  label,
  value,
  active,
  labelWidth,
  width,
  placeholder,
  tone,
}: {
  label: string
  value: TextValue
  active: boolean
  labelWidth: number
  width: number
  placeholder: string
  tone?: Tone
}): ReactElement => {
  const { accent, selection } = useTheme()
  const toneColor = useToneColor()
  return (
    <Box height={1} flexShrink={0} overflow="hidden" {...(active ? { backgroundColor: selection } : {})}>
      <Box flexShrink={0}>
        <Text color={accent}>{active ? '› ' : '  '}</Text>
      </Box>
      <Box width={labelWidth} flexShrink={0}>
        <Text bold={active} {...toneColor(tone)}>
          {label}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <EditableText
          value={value.input}
          cursor={value.cursor}
          width={Math.max(1, width - labelWidth - 2)}
          active={active}
          placeholder={placeholder}
        />
      </Box>
    </Box>
  )
}

type Update<Value> = Value | ((current: Value) => Value)

export interface SyncedState<Value> {
  readonly value: Value
  readonly current: () => Value
  readonly set: (next: Update<Value>) => void
}

export const useSyncedState = <Value,>(initial: Value | (() => Value)): SyncedState<Value> => {
  const [value, setValue] = useState(initial)
  const latest = useRef(value)
  const set = useCallback((next: Update<Value>): void => {
    latest.current = next instanceof Function ? next(latest.current) : next
    setValue(latest.current)
  }, [])
  return { value, current: () => latest.current, set }
}

export interface Cursor {
  readonly index: number
  readonly current: () => number
  readonly move: (step: number) => void
  readonly set: (index: number) => void
}

export const cursorIn = (state: SyncedState<number>, count: number): Cursor => {
  const clamp = (index: number): number => Math.max(0, Math.min(index, count - 1))
  return {
    index: clamp(state.value),
    current: () => clamp(state.current()),
    move: (step) => state.set((index) => clamp(clamp(index) + step)),
    set: (index) => state.set(Math.max(0, index)),
  }
}
