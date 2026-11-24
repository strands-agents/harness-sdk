import { useCallback, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { usePaste, type Key } from 'ink'
import { useInput } from '../input.js'

import { emptyEditor, reduceInputSequence, type EditorState } from '../../terminal/composer.js'
import { graphemes, sanitizeTerminalText } from '../../terminal/text.js'
import { EditableText } from '../text-input.js'
import { Box, Text, useTheme } from '../theme.js'
import { useDevPanelClicks } from './dev.js'

type Tone = 'success' | 'error' | 'warning' | 'muted'

interface ListItem {
  readonly key: string
  readonly label: string
  readonly detail?: string
  readonly mark?: { readonly text: string; readonly tone?: Tone }
  readonly tone?: Tone
}

// The cursor and the mark that a list row draws before its label.
const LIST_MARK_COLUMNS = 4

const oneLine = (text: string): string => sanitizeTerminalText(text).replace(/\s+/gu, ' ').trim()

const indented = (text: string): string => `${/^ */u.exec(text)?.[0] ?? ''}${oneLine(text)}`

const shortcut = (input: string, key: Key): string => (key.ctrl || key.meta ? '' : input)

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

export const PanelTitle = ({ name, parts = [] }: { name: string; parts?: readonly string[] }): ReactElement => {
  const { accent } = useTheme()
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Box flexShrink={1} marginRight={2} overflow="hidden">
        <Text wrap="truncate-end">
          <Text color={accent} bold>
            {oneLine(name)}
          </Text>
          {parts.map((part, index) => (
            <Text key={`${index}:${part}`}>{` · ${oneLine(part)}`}</Text>
          ))}
        </Text>
      </Box>
    </Box>
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

const Gap = (): ReactElement => <Box height={1} flexShrink={0} />

const listWindow = (selected: number, count: number, capacity: number): { start: number; end: number } => {
  if (count <= capacity) return { start: 0, end: count }
  const visible = capacity > 1 ? capacity - 1 : 1
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), count - visible))
  return { start, end: start + visible }
}

const ItemList = ({
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
const labelWidthFor = (labels: readonly string[], width: number, detailed: boolean): number =>
  Math.min(
    Math.max(8, ...labels.map((label) => oneLine(label).length)),
    Math.max(8, detailed ? Math.floor(width / 3) : width - LIST_MARK_COLUMNS)
  )

const textValue = (text: string): EditorState => ({
  ...emptyEditor(),
  input: text,
  cursor: graphemes(text).length,
})

// Typed or pasted text; a field holds one line.
const editText = (value: EditorState, input: string, key: Partial<Key> = {}): EditorState =>
  reduceInputSequence(value, input.replace(/\r?\n/gu, ' '), key, 'idle').state

const TextField = ({
  label,
  value,
  labelWidth,
  width,
}: {
  label: string
  value: EditorState
  labelWidth: number
  width: number
}): ReactElement => {
  const { accent, selection } = useTheme()
  return (
    <Box height={1} flexShrink={0} overflow="hidden" backgroundColor={selection}>
      <Box flexShrink={0}>
        <Text color={accent}>{'› '}</Text>
      </Box>
      <Box width={labelWidth} flexShrink={0}>
        <Text bold>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <EditableText
          value={value.input}
          cursor={value.cursor}
          width={Math.max(1, width - labelWidth - 2)}
          active
          placeholder=""
        />
      </Box>
    </Box>
  )
}

type Update<Value> = Value | ((current: Value) => Value)

interface SyncedState<Value> {
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

interface Cursor {
  readonly index: number
  readonly current: () => number
  readonly move: (step: number) => void
  readonly set: (index: number) => void
}

const cursorIn = (state: SyncedState<number>, count: number): Cursor => {
  const clamp = (index: number): number => Math.max(0, Math.min(index, count - 1))
  return {
    index: clamp(state.value),
    current: () => clamp(state.current()),
    move: (step) => state.set((index) => clamp(clamp(index) + step)),
    set: (index) => state.set(Math.max(0, index)),
  }
}

interface WizardEdit {
  readonly value: string
  readonly save: (text: string) => void
  // Refuse every keystroke or paste that would put a non-digit in the field.
  readonly numeric?: boolean
}

interface FieldBase {
  readonly key: string
  readonly label: string
  readonly hint: string
}

export interface WizardToggle extends FieldBase {
  readonly kind: 'toggle'
  readonly detail?: string
  readonly checked: boolean
  readonly unavailable?: string
  readonly mark?: 'check' | 'radio'
  readonly toggle: () => void
  // An input row opens this editor instead of toggling.
  readonly edit?: WizardEdit
}

interface WizardText extends FieldBase {
  readonly kind: 'text'
  readonly display: string
  readonly edit: WizardEdit
}

export type WizardField = WizardToggle | WizardText

export interface WizardProps {
  readonly name: string
  readonly titleParts?: readonly string[]
  readonly question?: string
  readonly fields: readonly WizardField[]
  /** Why the form cannot finish yet. */
  readonly notice?: string
  /** Drawn above the fields, which are about it. */
  readonly body?: (room: number) => ReactNode
  /** The rows the body needs to show all of itself, so the form crowds only when they do not fit. */
  readonly bodyRows?: number
  readonly width: number
  readonly height: number
  readonly onFinish: () => void
  readonly onCancel: () => void
  // When set, the Cancel button reads Back and calls this; Esc still cancels.
  readonly onBack?: () => void
  readonly active?: boolean
  /** Hands the keyboard to the chat input, for a question the developer wants to leave open. */
  readonly onLeave?: () => void
  /** What Esc is called in the hints, when leaving the form does not cancel what it asks about. */
  readonly escapeHint?: string
}

const LABEL_WIDTH = 12
const MIN_LIST_ROWS = 3

const BUTTONS = ['finish', 'cancel'] as const

type WizardButton = (typeof BUTTONS)[number]

type WizardRow =
  { readonly kind: 'field'; readonly field: WizardField } | { readonly kind: 'button'; readonly button: WizardButton }

interface Editor {
  readonly key: string
  readonly edit: WizardEdit
  readonly value: EditorState
}

const edited = (editor: Editor, value: Editor['value']): Editor =>
  editor.edit.numeric && /\D/u.test(value.input) ? editor : { ...editor, value }

// The rows the form draws around its body, counted row by row, so the body gets exactly what is left.
const rowsAroundBody = (fields: number, { question, compact }: { question: boolean; compact: boolean }): number => {
  const gap = compact ? 0 : 1
  // The title, the buttons, and the key hints, then the gaps, one of them setting the body apart from its fields.
  return 3 + (question ? 1 : 0) + 3 * gap + fields
}

const MARKS = {
  check: { on: '☑', off: '☐' },
  radio: { on: '◉', off: '○' },
} as const

// The typed text with a bar at the cursor, for a row that is edited in place.
const withCursor = ({ input, cursor }: { input: string; cursor: number }): string =>
  `${input.slice(0, cursor)}▏${input.slice(cursor)}`

const toggleItem = (field: WizardToggle): ListItem => {
  const marks = MARKS[field.mark ?? 'check']
  if (field.unavailable !== undefined)
    return {
      key: field.key,
      label: field.label,
      detail: field.unavailable,
      mark: { text: marks.off, tone: 'muted' },
      tone: 'warning',
    }
  return {
    key: field.key,
    label: field.label,
    ...(field.detail === undefined ? {} : { detail: field.detail }),
    mark: field.checked ? { text: marks.on, tone: 'success' } : { text: marks.off, tone: 'muted' },
  }
}

const ValueRow = ({
  label,
  value,
  active,
  onPoint,
  labelWidth,
}: {
  label: string
  value: string
  active: boolean
  onPoint: () => void
  labelWidth: number
}): ReactElement => {
  const { accent, selection } = useTheme()
  const clicks = useDevPanelClicks()
  return (
    <Box
      height={1}
      flexShrink={0}
      overflow="hidden"
      {...(active ? { backgroundColor: selection } : {})}
      {...(clicks ? { ref: clicks.target(onPoint, onPoint) } : {})}
    >
      <Text wrap="truncate-end">
        <Text color={accent}>{active ? '› ' : '  '}</Text>
        <Text bold={active} dimColor={!active}>
          {label.padEnd(labelWidth)}
        </Text>
        <Text>{value}</Text>
      </Text>
    </Box>
  )
}

const WizardButtons = ({
  ready,
  cancelLabel,
  focused,
  onChoose,
  onHover,
}: {
  ready: boolean
  cancelLabel: string
  focused: WizardButton | undefined
  onChoose: (button: WizardButton) => void
  onHover: (button: WizardButton) => void
}): ReactElement => {
  const { accent, selection } = useTheme()
  const clicks = useDevPanelClicks()
  const button = (name: WizardButton, text: ReactElement): ReactElement => (
    <Box
      key={name}
      flexShrink={0}
      marginRight={2}
      {...(focused === name ? { backgroundColor: selection } : {})}
      {...(clicks
        ? {
            ref: clicks.target(
              () => onChoose(name),
              () => onHover(name)
            ),
          }
        : {})}
    >
      <Text color={accent}>{focused === name ? '› ' : '  '}</Text>
      {text}
    </Box>
  )
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      {button('finish', <Text {...(ready ? { color: accent, bold: true } : { dimColor: true })}>{'[ OK ]'}</Text>)}
      {button('cancel', <Text bold={focused === 'cancel'}>{cancelLabel}</Text>)}
    </Box>
  )
}

const rowHints = (
  row: WizardRow | undefined,
  blocked: boolean,
  { back, leave, escape }: { back: boolean; leave: boolean; escape: string }
): string[] => {
  const rest = [...(leave ? ['↓ chat'] : []), escape]
  const hints = (action: string, arrows = '↑↓'): string[] => [arrows, action, ...rest]
  if (row?.kind === 'button') {
    if (row.button === 'cancel') return hints(back ? 'Enter back' : 'Enter cancel', '←→')
    return hints(blocked ? 'fix the problem to finish' : 'Enter finish', '←→')
  }
  if (row?.kind !== 'field') return rest
  if (row.field.kind === 'toggle' && row.field.unavailable !== undefined) return hints('not available')
  return hints(row.field.hint)
}

export const Wizard = ({
  name,
  titleParts = [],
  question,
  fields,
  notice: blocking,
  body,
  bodyRows = 0,
  width,
  height,
  onFinish,
  onCancel,
  onBack,
  active = true,
  onLeave,
  escapeHint = 'Esc cancel',
}: WizardProps): ReactElement => {
  const editing = useSyncedState<Editor | undefined>(undefined)
  const rows: WizardRow[] = [
    ...fields.map((field): WizardRow => ({ kind: 'field', field })),
    ...BUTTONS.map((button): WizardRow => ({ kind: 'button', button })),
  ]
  // Every label gets the width of the longest one, so the values line up.
  const labelWidth = Math.max(LABEL_WIDTH, ...fields.map((field) => field.label.length + 2))
  const cursor = cursorIn(useSyncedState(0), rows.length)
  const ready = blocking === undefined
  const hasQuestion = question !== undefined
  // The form is sized to its content, so it crowds only when its body does not fit.
  const compact =
    body !== undefined && height < rowsAroundBody(fields.length, { question: hasQuestion, compact: false }) + bodyRows
  const bodyRoom = Math.max(1, height - rowsAroundBody(fields.length, { question: hasQuestion, compact }))
  // Without the keyboard there is no cursor: the chat holds it.
  const cursorRow = active ? cursor.index : -1
  const focused = active ? rows[cursor.index] : undefined
  const editor = editing.value
  const firstButton = fields.length
  const toggles = fields.filter((field): field is WizardToggle => field.kind === 'toggle')
  const openEditor = (key: string, edit: WizardEdit): void => editing.set({ key, edit, value: textValue(edit.value) })
  const activate = (row: WizardRow | undefined): void => {
    if (row?.kind === 'button') {
      if (row.button === 'cancel') (onBack ?? onCancel)()
      else if (ready) onFinish()
      return
    }
    if (row?.kind !== 'field') return
    if (row.field.kind === 'toggle') {
      if (row.field.unavailable !== undefined) return
      if (row.field.edit) openEditor(row.field.key, row.field.edit)
      else row.field.toggle()
    } else openEditor(row.field.key, row.field.edit)
  }
  const choose = (row: number): void => {
    cursor.set(row)
    activate(rows[row])
  }
  useInput(
    (input, key) => {
      const open = editing.current()
      if (open) {
        if (key.escape) editing.set(undefined)
        else if (key.return) {
          open.edit.save(open.value.input)
          editing.set(undefined)
        } else if (!key.tab) editing.set((current) => current && edited(current, editText(current.value, input, key)))
        return
      }
      const row = rows[cursor.current()]
      const typed = shortcut(input, key)
      // A text row takes what is typed on it: the first character opens its editor and lands in it.
      if (row?.kind === 'field' && row.field.kind === 'text' && !key.ctrl && typed.trim() !== '') {
        const opened = { key: row.field.key, edit: row.field.edit, value: textValue(row.field.edit.value) }
        editing.set(edited(opened, editText(opened.value, input, key)))
      } else if (key.escape) onCancel()
      // The buttons sit on one line, so ←→ moves between them and ↑ goes back to the fields.
      else if (row?.kind === 'button' && (key.leftArrow || key.rightArrow)) {
        cursor.set(firstButton + (key.rightArrow ? 1 : 0))
      } else if (row?.kind === 'button' && key.upArrow) {
        if (firstButton > 0) cursor.set(firstButton - 1)
      } else if (row?.kind === 'button' && key.downArrow) {
        // Below the buttons, down carries on into the chat.
        onLeave?.()
      } else if (key.upArrow) cursor.move(-1)
      else if (key.downArrow) cursor.move(1)
      else if (key.return || shortcut(input, key) === ' ') activate(row)
    },
    { isActive: active }
  )
  usePaste((text) => editing.set((current) => current && edited(current, editText(current.value, text))))
  const rowOf = (key: string): number => rows.findIndex((row) => row.kind === 'field' && row.field.key === key)
  const toggleRows = toggles.map(({ key }) => rowOf(key))
  const notice = body ? undefined : blocking
  // The list chrome is counted from what the panel renders, so a sized panel shows every option.
  const listChrome = 3 + (hasQuestion ? 1 : 0) + (compact ? 0 : 1) + (notice ? 1 : compact ? 0 : 1)
  const fieldView = (field: WizardField): ReactNode => {
    // One scrolling list for every toggle, placed where the first one was declared.
    if (field.kind === 'toggle')
      return field.key === toggles[0]?.key ? (
        <Box key={field.key} flexDirection="column" flexShrink={0}>
          <ItemList
            items={toggles.map((toggle) =>
              toggle.key === editor?.key
                ? { ...toggleItem(toggle), detail: withCursor(editor.value) }
                : toggleItem(toggle)
            )}
            selected={active ? toggleRows.indexOf(cursor.index) : -1}
            capacity={Math.max(MIN_LIST_ROWS, Math.min(toggles.length, height - listChrome))}
            labelWidth={labelWidthFor(
              toggles.map(({ label }) => label),
              width,
              toggles.some(({ detail, unavailable }) => detail !== undefined || unavailable !== undefined)
            )}
            onClick={(item) => choose(toggleRows[item] ?? 0)}
            onHover={(item) => cursor.set(toggleRows[item] ?? 0)}
          />
        </Box>
      ) : null
    const row = rowOf(field.key)
    return editor?.key === field.key ? (
      <Box key={field.key} flexDirection="column" flexShrink={0}>
        <TextField label={field.label} value={editor.value} labelWidth={labelWidth} width={width} />
      </Box>
    ) : (
      <ValueRow
        key={field.key}
        labelWidth={labelWidth}
        label={field.label}
        value={field.display}
        active={cursorRow === row}
        onPoint={() => cursor.set(row)}
      />
    )
  }
  return (
    <>
      <PanelTitle name={name} parts={titleParts} />
      {question === undefined ? null : <Line>{`  ${question}`}</Line>}
      {compact ? null : <Gap />}
      {body?.(bodyRoom)}
      {body && !compact ? <Gap /> : null}
      {fields.map(fieldView)}
      {notice ? <Line tone="error">{`  ${notice}`}</Line> : compact ? null : <Gap />}
      <WizardButtons
        ready={ready}
        cancelLabel={onBack ? 'Back' : 'Cancel'}
        focused={focused?.kind === 'button' ? focused.button : undefined}
        onChoose={(button) => choose(firstButton + BUTTONS.indexOf(button))}
        onHover={(button) => cursor.set(firstButton + BUTTONS.indexOf(button))}
      />
      <Box flexGrow={1} flexShrink={1} />
      <Box height={1} flexShrink={0} overflow="hidden">
        <Text dimColor wrap="truncate-end">
          {(!active
            ? ['↑ answer this']
            : editor
              ? ['Enter save', 'Esc cancel']
              : rowHints(focused, !ready, {
                  back: onBack !== undefined,
                  leave: onLeave !== undefined,
                  escape: escapeHint,
                })
          ).join(' · ')}
        </Text>
      </Box>
    </>
  )
}
