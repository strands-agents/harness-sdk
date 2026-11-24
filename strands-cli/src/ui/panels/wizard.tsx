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
    <Box height={1} flexShrink={0} justifyContent="space-between" overflow="hidden">
      <Box flexShrink={1} overflow="hidden">
        <Text wrap="truncate-end">
          <Text color={accent} bold>
            {oneLine(name)}
          </Text>
          {parts.map((part, index) => (
            <Text key={`${index}:${part}`}>{` · ${oneLine(part)}`}</Text>
          ))}
        </Text>
      </Box>
      {right === undefined ? null : (
        <Box flexShrink={0} marginLeft={2}>
          {right}
        </Box>
      )}
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

export interface WizardStep {
  readonly key: string
  readonly title: string
  readonly fields: readonly WizardField[]
  /** Why the form cannot finish yet. */
  readonly notice?: string
  /** Drawn above the fields, which are about it. */
  readonly body?: (room: number) => ReactNode
  /** The rows the body needs to show all of itself, so one question crowds only when they do not fit. */
  readonly bodyRows?: number
}

export interface WizardProps {
  readonly name: string
  readonly titleParts?: readonly string[]
  readonly steps: readonly WizardStep[]
  readonly question?: string
  readonly status?: string
  readonly width: number
  readonly height: number
  readonly finishLabel?: string
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
const FULL_ROWS = 12
const BODY_CHROME_ROWS = 6
const COMPACT_BODY_CHROME_ROWS = 4
const MIN_LIST_ROWS = 3

type WizardButton = 'next' | 'back' | 'finish' | 'cancel'

const BUTTON_LABELS: Readonly<Record<WizardButton, string>> = {
  next: '[ Next ]',
  back: 'Back',
  finish: '[ Start ]',
  cancel: 'Cancel',
}

type WizardRow =
  { readonly kind: 'field'; readonly field: WizardField } | { readonly kind: 'button'; readonly button: WizardButton }

interface Editor {
  readonly key: string
  readonly edit: WizardEdit
  readonly value: EditorState
}

const edited = (editor: Editor, value: Editor['value']): Editor =>
  editor.edit.numeric && /\D/u.test(value.input) ? editor : { ...editor, value }

const stepButtons = (at: number, count: number): readonly WizardButton[] => {
  if (at === count - 1) return ['finish', 'cancel']
  return at === 0 ? ['next', 'cancel'] : ['next', 'back']
}

const stepRows = (step: WizardStep, at: number, count: number): WizardRow[] => [
  ...step.fields.map((field): WizardRow => ({ kind: 'field', field })),
  ...stepButtons(at, count).map((button): WizardRow => ({ kind: 'button', button })),
]

// The rows one question draws around its body, counted row by row, so the body gets exactly what is left.
const rowsAroundBody = (step: WizardStep, { question, compact }: { question: boolean; compact: boolean }): number => {
  const gap = compact ? 0 : 1
  // The title, the buttons, and the key hints, then the gaps, one of them setting the body apart from its fields.
  return 3 + (question ? 1 : 0) + 3 * gap + step.fields.length
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

const StepBar = ({
  steps,
  at,
  right,
  onPick,
}: {
  steps: readonly WizardStep[]
  at: number
  right: string
  onPick: (index: number) => void
}): ReactElement => {
  const { accent, selection } = useTheme()
  const toneColor = useToneColor()
  const clicks = useDevPanelClicks()
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Box flexShrink={0}>
        {steps.map((step, index) => (
          <Box
            key={step.key}
            flexShrink={0}
            marginRight={1}
            {...(index === at ? { backgroundColor: selection } : {})}
            {...(clicks ? { ref: clicks.target(() => onPick(index)) } : {})}
          >
            <Text {...(index === at ? { color: accent, bold: true } : { dimColor: true })}>{` ${step.title}`}</Text>
            <Text {...toneColor(step.notice ? 'error' : undefined)}>{step.notice ? ' ! ' : '  '}</Text>
          </Box>
        ))}
      </Box>
      <Box flexGrow={1} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <Text dimColor wrap="truncate-end">
          {right}
        </Text>
      </Box>
    </Box>
  )
}

const WizardButtons = ({
  buttons,
  ready,
  finishLabel,
  cancelLabel,
  focused,
  onChoose,
  onHover,
}: {
  buttons: readonly WizardButton[]
  ready: boolean
  finishLabel: string
  cancelLabel: string
  focused: WizardButton | undefined
  onChoose: (button: WizardButton) => void
  onHover: (button: WizardButton) => void
}): ReactElement => {
  const { accent, selection } = useTheme()
  const clicks = useDevPanelClicks()
  const label = (name: WizardButton): string =>
    name === 'finish' ? finishLabel : name === 'cancel' ? cancelLabel : BUTTON_LABELS[name]
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
      {buttons.map((name) =>
        name === 'next' || name === 'finish'
          ? button(
              name,
              <Text {...(name === 'next' || ready ? { color: accent, bold: true } : { dimColor: true })}>
                {label(name)}
              </Text>
            )
          : button(name, <Text bold={focused === name}>{label(name)}</Text>)
      )}
    </Box>
  )
}

const buttonHint = (button: WizardButton, blocked: boolean): string => {
  if (button === 'finish') return blocked ? 'fix the problem to finish' : 'Enter finish'
  if (button === 'next') return 'Enter next'
  return button === 'back' ? 'Enter back' : 'Enter cancel'
}

const rowHints = (
  row: WizardRow | undefined,
  blocked: boolean,
  { walked, back, leave, escape }: { walked: boolean; back: boolean; leave: boolean; escape: string }
): string[] => {
  const tab = walked ? ['Tab next tab'] : []
  const rest = [...(leave && !walked ? ['↓ chat'] : []), escape]
  const hints = (action: string, arrows = '↑↓'): string[] => [...tab, arrows, action, ...rest]
  if (row?.kind === 'button')
    return hints(back && row.button === 'cancel' ? 'Enter back' : buttonHint(row.button, blocked), '←→')
  if (row?.kind !== 'field') return [...tab, ...rest]
  if (row.field.kind === 'toggle' && row.field.unavailable !== undefined) return hints('not available')
  return hints(row.field.hint)
}

export const Wizard = ({
  name,
  titleParts = [],
  steps,
  question,
  status = '',
  width,
  height,
  finishLabel = BUTTON_LABELS.finish,
  onFinish,
  onCancel,
  onBack,
  active = true,
  onLeave,
  escapeHint = 'Esc cancel',
}: WizardProps): ReactElement => {
  const at = useSyncedState(0)
  const editing = useSyncedState<Editor | undefined>(undefined)
  const step = steps[Math.min(at.value, steps.length - 1)] ?? steps[0]!
  const index = steps.indexOf(step)
  const rows = stepRows(step, index, steps.length)
  // Every label of a step gets the width of its longest one, so the values line up.
  const labelWidth = Math.max(LABEL_WIDTH, ...step.fields.map((field) => field.label.length + 2))
  const buttons = stepButtons(index, steps.length)
  const cursor = cursorIn(useSyncedState(0), rows.length)
  const blocking = steps.find(({ notice }) => notice)?.notice
  const ready = blocking === undefined
  const walked = steps.length > 1
  const hasQuestion = question !== undefined
  // One question is sized to its content, so it crowds only when its body does not fit; a walked form crowds when short.
  const compact = walked
    ? height < FULL_ROWS
    : step.body !== undefined &&
      height < rowsAroundBody(step, { question: hasQuestion, compact: false }) + (step.bodyRows ?? 0)
  const bodyRoom = walked
    ? height - (compact ? COMPACT_BODY_CHROME_ROWS : BODY_CHROME_ROWS)
    : Math.max(1, height - rowsAroundBody(step, { question: hasQuestion, compact }))
  // Without the keyboard there is no cursor: the chat holds it.
  const cursorRow = active ? cursor.index : -1
  const focused = active ? rows[cursor.index] : undefined
  const editor = editing.value
  const firstButton = rows.findIndex((row) => row.kind === 'button')
  const toggles = step.fields.filter((field): field is WizardToggle => field.kind === 'toggle')
  const pickStep = (next: number): void => {
    at.set(Math.max(0, Math.min(next, steps.length - 1)))
    cursor.set(0)
  }
  const wrapStep = (move: 1 | -1): number => (at.current() + move + steps.length) % steps.length
  const stepTo = (move: 1 | -1, keep: readonly WizardButton[]): void => {
    const next = wrapStep(move)
    const nextStep = steps[next]!
    const nextRows = stepRows(nextStep, next, steps.length)
    const landing = keep
      .map((button) => nextRows.findIndex((row) => row.kind === 'button' && row.button === button))
      .find((found) => found >= 0)
    at.set(next)
    cursor.set(landing ?? 0)
  }
  const openEditor = (key: string, edit: WizardEdit): void => editing.set({ key, edit, value: textValue(edit.value) })
  const activate = (row: WizardRow | undefined): void => {
    if (row?.kind === 'button') {
      if (row.button === 'cancel') (onBack ?? onCancel)()
      else if (row.button === 'next') stepTo(1, ['next', 'finish'])
      else if (row.button === 'back') stepTo(-1, ['back', 'next'])
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
      else if (key.tab && walked) stepTo(key.shift ? -1 : 1, [])
      // The buttons sit on one line, so ←→ moves between them and ↑ goes back to the fields.
      else if (row?.kind === 'button' && (key.leftArrow || key.rightArrow)) {
        const at = cursor.current() - firstButton + (key.rightArrow ? 1 : -1)
        cursor.set(firstButton + Math.max(0, Math.min(at, buttons.length - 1)))
      } else if (row?.kind === 'button' && key.upArrow) {
        if (firstButton > 0) cursor.set(firstButton - 1)
      } else if (row?.kind === 'button' && key.downArrow) {
        // Below the buttons of one question, down carries on into the chat.
        if (!walked) onLeave?.()
      } else if (key.upArrow) cursor.move(-1)
      else if (key.downArrow) cursor.move(1)
      else if (key.return || shortcut(input, key) === ' ') activate(row)
    },
    { isActive: active }
  )
  usePaste((text) => editing.set((current) => current && edited(current, editText(current.value, text))))
  const rowOf = (key: string): number => rows.findIndex((row) => row.kind === 'field' && row.field.key === key)
  const toggleRows = toggles.map(({ key }) => rowOf(key))
  const notice = step.body ? undefined : (step.notice ?? blocking)
  // The list chrome is counted from what the panel renders, so a sized panel shows every option.
  const listChrome = 3 + (walked ? 2 : 0) + (hasQuestion ? 1 : 0) + (compact ? 0 : 1) + (notice ? 1 : compact ? 0 : 1)
  const fieldView = (field: WizardField): ReactNode => {
    // One scrolling list for every toggle of the step, placed where the first one was declared.
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
      <PanelTitle
        name={name}
        parts={titleParts}
        {...(steps.length > 1 ? {} : { right: <Text dimColor>{status}</Text> })}
      />
      {steps.length > 1 ? <StepBar steps={steps} at={index} right={status} onPick={pickStep} /> : null}
      {question === undefined ? null : <Line>{`  ${question}`}</Line>}
      {compact ? null : <Gap />}
      {step.body?.(bodyRoom)}
      {step.body && !walked && !compact ? <Gap /> : null}
      {step.fields.map(fieldView)}
      {notice ? <Line tone="error">{`  ${notice}`}</Line> : compact ? null : <Gap />}
      <WizardButtons
        buttons={buttons}
        ready={ready}
        finishLabel={finishLabel}
        cancelLabel={onBack ? BUTTON_LABELS.back : BUTTON_LABELS.cancel}
        focused={focused?.kind === 'button' ? focused.button : undefined}
        onChoose={(button) => choose(firstButton + buttons.indexOf(button))}
        onHover={(button) => cursor.set(firstButton + buttons.indexOf(button))}
      />
      <Box flexGrow={1} flexShrink={1} />
      <Box height={1} flexShrink={0} overflow="hidden">
        <Text dimColor wrap="truncate-end">
          {(!active
            ? ['↑ answer this']
            : editor
              ? ['Enter save', 'Esc cancel']
              : rowHints(focused, !ready, {
                  walked,
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
