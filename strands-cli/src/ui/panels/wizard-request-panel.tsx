import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { usePaste, type Key } from 'ink'
import { useInput } from '../input.js'

import { emptyEditor, reduceInputSequence, type EditorState } from '../../terminal/composer.js'
import { graphemes, sanitizeTerminalText } from '../../terminal/text.js'
import type { DevChatPanelProps } from '../chat/types.js'
import { EditableText } from '../text-input.js'
import { Box, Text, useTheme } from '../theme.js'
import { useDevPanelClicks } from './dev.js'
import {
  defaultAnswers,
  diffSummaryText,
  finishedAnswers,
  inputKey,
  numberProblem,
  wizardDiffTextWidth,
  wrappedDiffLines,
  type WizardAnswer,
  type WizardBroker,
  type WizardDiffSpec,
  type WizardNumberSpec,
  type WizardOption,
  type WizardRequest,
  type WizardSelectSpec,
} from './wizard-request.js'

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

const PanelTitle = ({ name, parts = [] }: { name: string; parts?: readonly string[] }): ReactElement => {
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
const Line = ({
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

const useSyncedState = <Value,>(initial: Value | (() => Value)): SyncedState<Value> => {
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

const LABEL_WIDTH = 12
const MIN_LIST_ROWS = 3

const BUTTONS = ['finish', 'cancel'] as const

interface OptionRow {
  readonly kind: 'option'
  readonly key: string
  readonly field: WizardSelectSpec
  readonly option: WizardOption
}

type FieldRow = OptionRow | { readonly kind: 'number'; readonly key: string; readonly field: WizardNumberSpec }

type Button = (typeof BUTTONS)[number]

type Row = FieldRow | { readonly kind: 'button'; readonly button: Button }

interface Editor {
  readonly row: FieldRow
  readonly value: EditorState
}

// A number row refuses every keystroke or paste that would put a non-digit in it.
const edited = (editor: Editor, value: EditorState): Editor =>
  editor.row.kind === 'number' && /\D/u.test(value.input) ? editor : { ...editor, value }

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

const chosen = (answer: WizardAnswer | undefined): readonly string[] => {
  if (Array.isArray(answer)) return answer
  return typeof answer === 'string' && answer ? [answer] : []
}

const optionItem = ({ key, field, option }: OptionRow, picked: boolean, typed: string): ListItem => {
  const marks = MARKS[field.multiple === false ? 'radio' : 'check']
  if (option.unavailable !== undefined)
    return {
      key,
      label: option.label,
      detail: option.unavailable,
      mark: { text: marks.off, tone: 'muted' },
      tone: 'warning',
    }
  // An input row shows the text typed into it in place of its detail.
  const detail = option.input ? typed || option.detail || '' : option.detail
  return {
    key,
    label: option.label,
    ...(detail === undefined ? {} : { detail }),
    mark: picked ? { text: marks.on, tone: 'success' } : { text: marks.off, tone: 'muted' },
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
  focused: Button | undefined
  onChoose: (button: Button) => void
  onHover: (button: Button) => void
}): ReactElement => {
  const { accent, selection } = useTheme()
  const clicks = useDevPanelClicks()
  const button = (name: Button, text: ReactElement): ReactElement => (
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
  row: Row | undefined,
  blocked: boolean,
  { back, leave, escape }: { back: boolean; leave: boolean; escape: string }
): string[] => {
  const rest = [...(leave ? ['↓ chat'] : []), escape]
  const hints = (action: string, arrows = '↑↓'): string[] => [arrows, action, ...rest]
  if (!row) return rest
  if (row.kind === 'button') {
    if (row.button === 'cancel') return hints(back ? 'Enter back' : 'Enter cancel', '←→')
    return hints(blocked ? 'fix the problem to finish' : 'Enter finish', '←→')
  }
  if (row.kind === 'number') return hints('Enter edit')
  if (row.option.unavailable !== undefined) return hints('not available')
  return hints(row.option.input ? 'Enter type' : row.field.multiple === false ? 'Enter pick' : 'Enter toggle')
}

const DIFF_INDENT = ' '.repeat(2)
const DIFF_MARK_COLUMNS = 2
const WHEEL_ROWS = 3
const MIN_ROOM_FOR_POSITION = 3

const diffPosition = (above: number, below: number, keys: boolean): string =>
  [above > 0 ? `↑ ${above} previous` : '', below > 0 ? `↓ ${below} more` : '', keys ? 'PgUp/PgDn scroll' : '']
    .filter(Boolean)
    .join(' · ')

// A change to read: the file and its counts, then its wrapped lines; PgUp/PgDn and the wheel scroll a long one.
const DiffBody = ({
  spec,
  room,
  width,
  active,
}: {
  spec: WizardDiffSpec
  room: number
  width: number
  active: boolean
}): ReactElement => {
  const clicks = useDevPanelClicks()
  const rows = useMemo(() => wrappedDiffLines(spec.diff, wizardDiffTextWidth(width)), [spec.diff, width])
  const [offset, setOffset] = useState(0)
  // The header takes a row, and a change that does not fit gives one more to saying where the window is.
  const fits = rows.length <= room - 1
  const positioned = !fits && room >= MIN_ROOM_FOR_POSITION
  const capacity = Math.max(0, room - 1 - (positioned ? 1 : 0))
  const last = Math.max(0, rows.length - capacity)
  const start = Math.min(offset, last)
  const scroll = (by: number): void => setOffset((current) => Math.max(0, Math.min(last, Math.min(current, last) + by)))
  const page = Math.max(1, capacity - 1)
  useInput(
    (_input, key) => {
      if (key.pageDown) scroll(page)
      else if (key.pageUp) scroll(-page)
    },
    { isActive: active && !fits }
  )
  const shown = rows.slice(start, start + capacity)
  const header = [spec.path, diffSummaryText(spec.diff)].filter(Boolean).join(' · ')
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      {...(clicks && !fits ? { ref: clicks.wheel((direction) => scroll(direction * WHEEL_ROWS)) } : {})}
    >
      <Line tone="muted">{`${DIFF_INDENT}${header}`}</Line>
      {shown.map((row, index) => (
        <Line key={start + index} verbatim {...(row.tone ? { tone: row.tone } : {})}>
          {`${DIFF_INDENT}${row.label.padEnd(DIFF_MARK_COLUMNS)}${row.text}`}
        </Line>
      ))}
      {positioned ? (
        <Line tone="muted">{`${DIFF_INDENT}${diffPosition(start, rows.length - start - shown.length, active)}`}</Line>
      ) : null}
    </Box>
  )
}

const RequestView = ({
  request,
  broker,
  active,
  blur,
  width,
  height,
}: {
  request: WizardRequest
  broker: WizardBroker
  active: boolean
  blur?: () => void
  width: number
  height: number
}): ReactElement => {
  const { fields } = request
  const answers = useSyncedState<Record<string, WizardAnswer>>(() => defaultAnswers(fields))
  const texts = useSyncedState<Record<string, string>>(() => ({}))
  const editing = useSyncedState<Editor | undefined>(undefined)
  useEffect(
    () => broker.draft(request.id, finishedAnswers(fields, answers.value, texts.value)),
    [broker, request, answers.value, texts.value]
  )
  const fieldRows = fields.flatMap((field): FieldRow[] => {
    if (field.kind === 'select')
      return field.options.map((option) => ({ kind: 'option', key: inputKey(field.key, option.value), field, option }))
    return field.kind === 'number' ? [{ kind: 'number', key: field.key, field }] : []
  })
  const rows: Row[] = [...fieldRows, ...BUTTONS.map((button): Row => ({ kind: 'button', button }))]
  const firstButton = fieldRows.length
  const optionRows = fieldRows.filter((row) => row.kind === 'option')
  const optionIndexes = optionRows.map((row) => rows.indexOf(row))
  // Every label gets the width of the longest one, so the values line up.
  const labelWidth = Math.max(
    LABEL_WIDTH,
    ...fieldRows.map((row) => (row.kind === 'option' ? row.option : row.field).label.length + 2)
  )
  const cursor = cursorIn(useSyncedState(0), rows.length)
  const blocking = fields
    .map((field) => (field.kind === 'number' ? numberProblem(field, answers.value[field.key]) : undefined))
    .find((problem) => problem !== undefined)
  const ready = blocking === undefined
  const change = fields.find((field) => field.kind === 'diff')
  const hasQuestion = request.question !== undefined
  // The form is sized to its content, so it crowds only when its change does not fit.
  const compact =
    change !== undefined &&
    height <
      rowsAroundBody(fieldRows.length, { question: hasQuestion, compact: false }) +
        1 +
        wrappedDiffLines(change.diff, wizardDiffTextWidth(width)).length
  const bodyRoom = Math.max(1, height - rowsAroundBody(fieldRows.length, { question: hasQuestion, compact }))
  // Without the keyboard there is no cursor: the chat holds it.
  const focused = active ? rows[cursor.index] : undefined
  const editor = editing.value
  const update = (key: string, value: WizardAnswer): void => answers.set((current) => ({ ...current, [key]: value }))
  const pick = ({ field, option }: OptionRow): void => {
    if (field.multiple === false) return update(field.key, option.value)
    const was = chosen(answers.current()[field.key])
    update(field.key, was.includes(option.value) ? was.filter((item) => item !== option.value) : [...was, option.value])
  }
  // What a row's editor opens with: the text typed into an input row, or the number.
  const textOf = (row: FieldRow): string => {
    if (row.kind === 'option') return texts.value[row.key] ?? ''
    const value = answers.value[row.field.key]
    return typeof value === 'number' ? String(value) : ''
  }
  const editorOf = (row: FieldRow): Editor => ({ row, value: textValue(textOf(row)) })
  const save = ({ row, value: { input } }: Editor): void => {
    if (row.kind === 'number') return update(row.field.key, input ? Number(input) : '')
    // Saving text picks the input row, and saving it empty unpicks it.
    const trimmed = input.trim()
    texts.set((current) => ({ ...current, [row.key]: trimmed }))
    const picked = chosen(answers.current()[row.field.key]).includes(row.option.value)
    if (trimmed && !picked) pick(row)
    else if (!trimmed && picked) {
      if (row.field.multiple === false) update(row.field.key, '')
      else pick(row)
    }
  }
  const activate = (row: Row | undefined): void => {
    if (row?.kind === 'button') {
      // The Cancel button reads Back when the request offers it; Esc still cancels.
      if (row.button === 'cancel') broker.respond(request.id, request.back ? 'back' : undefined)
      else if (ready) broker.respond(request.id, finishedAnswers(fields, answers.current(), texts.current()))
      return
    }
    if (!row || (row.kind === 'option' && row.option.unavailable !== undefined)) return
    if (row.kind === 'option' && !row.option.input) pick(row)
    else editing.set(editorOf(row))
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
          save(open)
          editing.set(undefined)
        } else if (!key.tab) editing.set((current) => current && edited(current, editText(current.value, input, key)))
        return
      }
      const row = rows[cursor.current()]
      // A number row takes what is typed on it: the first character opens its editor and lands in it.
      if (row?.kind === 'number' && shortcut(input, key).trim() !== '') {
        const opened = editorOf(row)
        editing.set(edited(opened, editText(opened.value, input, key)))
        // Closing a standing question answers nothing: whoever asked keeps it waiting, so Esc only closes it.
      } else if (key.escape) broker.respond(request.id, undefined)
      // The buttons sit on one line, so ←→ moves between them and ↑ goes back to the fields.
      else if (row?.kind === 'button' && (key.leftArrow || key.rightArrow)) {
        cursor.set(firstButton + (key.rightArrow ? 1 : 0))
      } else if (row?.kind === 'button' && key.upArrow) {
        if (firstButton > 0) cursor.set(firstButton - 1)
      } else if (row?.kind === 'button' && key.downArrow) {
        // Below the buttons, down carries on into the chat.
        blur?.()
      } else if (key.upArrow) cursor.move(-1)
      else if (key.downArrow) cursor.move(1)
      else if (key.return || shortcut(input, key) === ' ') activate(row)
    },
    { isActive: active }
  )
  usePaste((text) => editing.set((current) => current && edited(current, editText(current.value, text))))
  const notice = change ? undefined : blocking
  // The list chrome is counted from what the panel renders, so a sized panel shows every option.
  const listChrome = 3 + (hasQuestion ? 1 : 0) + (compact ? 0 : 1) + (notice ? 1 : compact ? 0 : 1)
  return (
    <>
      <PanelTitle name={request.name} {...(request.titleParts ? { parts: request.titleParts } : {})} />
      {request.question === undefined ? null : <Line>{`  ${request.question}`}</Line>}
      {compact ? null : <Gap />}
      {change ? <DiffBody spec={change} room={bodyRoom} width={width} active={active} /> : null}
      {change && !compact ? <Gap /> : null}
      {fieldRows.map((row, index) => {
        // One scrolling list for the options of every select, placed where the first one was declared.
        if (row.kind === 'option')
          return row === optionRows[0] ? (
            <Box key={row.key} flexDirection="column" flexShrink={0}>
              <ItemList
                items={optionRows.map((item) => ({
                  ...optionItem(
                    item,
                    chosen(answers.value[item.field.key]).includes(item.option.value),
                    texts.value[item.key] ?? ''
                  ),
                  ...(item.key === editor?.row.key ? { detail: withCursor(editor.value) } : {}),
                }))}
                selected={active ? optionIndexes.indexOf(cursor.index) : -1}
                capacity={Math.max(MIN_LIST_ROWS, Math.min(optionRows.length, height - listChrome))}
                labelWidth={labelWidthFor(
                  optionRows.map(({ option }) => option.label),
                  width,
                  optionRows.some(
                    ({ option }) => option.detail !== undefined || option.unavailable !== undefined || option.input
                  )
                )}
                onClick={(item) => choose(optionIndexes[item] ?? 0)}
                onHover={(item) => cursor.set(optionIndexes[item] ?? 0)}
              />
            </Box>
          ) : null
        return editor?.row.key === row.key ? (
          <Box key={row.key} flexDirection="column" flexShrink={0}>
            <TextField label={row.field.label} value={editor.value} labelWidth={labelWidth} width={width} />
          </Box>
        ) : (
          <ValueRow
            key={row.key}
            labelWidth={labelWidth}
            label={row.field.label}
            value={[textOf(row) || 'none', row.field.detail].filter(Boolean).join('   ')}
            active={focused === row}
            onPoint={() => cursor.set(index)}
          />
        )
      })}
      {notice ? <Line tone="error">{`  ${notice}`}</Line> : compact ? null : <Gap />}
      <WizardButtons
        ready={ready}
        cancelLabel={request.back ? 'Back' : 'Cancel'}
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
                  back: request.back === true,
                  leave: blur !== undefined,
                  escape: request.standing ? 'Esc close' : 'Esc cancel',
                })
          ).join(' · ')}
        </Text>
      </Box>
    </>
  )
}

export const WizardRequestPanel = ({
  broker,
  width,
  height,
  close,
  active = true,
  blur,
}: Omit<DevChatPanelProps, 'openCommand'> & { broker: WizardBroker }): ReactElement => {
  const [request, setRequest] = useState(() => broker.pending())
  useEffect(() => broker.subscribe(setRequest), [broker])
  useEffect(() => {
    if (!request) close()
  }, [request, close])
  if (!request)
    return (
      <>
        <PanelTitle name="wizard" parts={['done']} />
        <Line tone="muted">{'  No question is waiting.'}</Line>
      </>
    )
  // Remount on a new request so its answers start from that request's own defaults.
  return (
    <RequestView
      key={request.id}
      request={request}
      broker={broker}
      active={active}
      {...(blur ? { blur } : {})}
      width={width}
      height={height}
    />
  )
}
