import { type ReactElement, type ReactNode } from 'react'
import { useInput, usePaste } from 'ink'

import { Box, Text, useTheme } from '../theme.js'
import { useDevPanelClicks } from './dev.js'
import {
  cursorIn,
  editText,
  Fill,
  Gap,
  ItemList,
  KeyHints,
  labelWidthFor,
  Line,
  PanelTitle,
  pasteText,
  shortcut,
  TextField,
  textValue,
  useSyncedState,
  useToneColor,
  type ListItem,
  type SyncedState,
  type Tone,
} from './kit.js'

export interface WizardNotice {
  readonly tone: Tone
  readonly text: string
}

export interface WizardEdit {
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

export interface WizardChoice extends FieldBase {
  readonly kind: 'choice'
  readonly count: number
  readonly position: number
  readonly detail: string
  readonly move: (step: 1 | -1) => void
  readonly display?: string
  readonly edit?: WizardEdit
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

export interface WizardText extends FieldBase {
  readonly kind: 'text'
  readonly display: string
  readonly edit: WizardEdit
}

export type WizardField = WizardChoice | WizardToggle | WizardText

export interface WizardStep {
  readonly key: string
  readonly title: string
  readonly fields: readonly WizardField[]
  readonly notice?: WizardNotice
  readonly listLabel?: string
  readonly body?: (room: number) => ReactNode
  /** The rows the body needs to show all of itself, so one question crowds only when they do not fit. */
  readonly bodyRows?: number
  /** Draws the body above the fields, for a body the fields are about. */
  readonly bodyFirst?: boolean
  readonly footnote?: string
  readonly editFootnote?: string
}

export interface WizardPosition {
  readonly step: SyncedState<number>
  readonly row: SyncedState<number>
}

// Hoist the position when a sub-view replaces the wizard, so returning lands on the same step and row.
export const useWizardPosition = (): WizardPosition => ({ step: useSyncedState(0), row: useSyncedState(0) })

export interface WizardProps {
  readonly name: string
  readonly titleParts?: readonly string[]
  readonly steps: readonly WizardStep[]
  readonly question?: string
  readonly status?: string
  readonly footer?: string
  readonly width: number
  readonly height: number
  readonly finishLabel?: string
  readonly finishHint: (blocking: WizardNotice | undefined) => string
  readonly onFinish: () => void
  readonly onCancel: () => void
  // When set, the Cancel button reads Back and calls this; Esc still cancels.
  readonly onBack?: () => void
  readonly active?: boolean
  // Read at keypress time, so a view that onFinish opens also swallows the rest of that input burst.
  readonly blocked?: () => boolean
  readonly position?: WizardPosition
  /** Lets the developer hand the agent's next questions back to it with ctrl+a. */
  readonly autofill?: { readonly on: boolean; readonly set: (on: boolean) => void }
  /** Hands the keyboard to the chat input, for a question the developer wants to leave open. */
  readonly onLeave?: () => void
  /** What Esc is called in the hints, when leaving the form does not cancel what it asks about. */
  readonly escapeHint?: string
}

const LABEL_WIDTH = 12
const SLIDER_WIDTH = 21
const FULL_ROWS = 12
const LIST_CHROME_ROWS = 9
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
  readonly value: ReturnType<typeof textValue>
}

const edited = (editor: Editor, value: Editor['value']): Editor =>
  editor.edit.numeric && /\D/u.test(value.input) ? editor : { ...editor, value }

const stepButtons = (at: number, count: number): readonly WizardButton[] => {
  if (at === count - 1) return ['finish', 'cancel']
  return at === 0 ? ['next', 'cancel'] : ['next', 'back']
}

const selectable = (field: WizardField): boolean =>
  field.kind === 'choice' ? field.count > 1 || field.edit !== undefined : true

const stepRows = (step: WizardStep, at: number, count: number): WizardRow[] => [
  ...step.fields.filter(selectable).map((field): WizardRow => ({ kind: 'field', field })),
  ...stepButtons(at, count).map((button): WizardRow => ({ kind: 'button', button })),
]

// The rows one question draws around its body, counted row by row, so the body gets exactly what is left.
const rowsAroundBody = (step: WizardStep, { question, compact }: { question: boolean; compact: boolean }): number => {
  const gap = compact ? 0 : 1
  const label = compact || step.listLabel === undefined ? 0 : 1
  const footnote = compact || step.footnote === undefined ? 0 : 1
  // The title, the buttons, and the key hints, then the gaps, and the row that sets a body apart from its fields.
  const apart = step.bodyFirst ? gap : 0
  return 3 + (question ? 1 : 0) + gap + apart + label + step.fields.length + footnote + gap
}

const blockingNotice = (steps: readonly WizardStep[]): WizardNotice | undefined =>
  steps.map(({ notice }) => notice).find((notice) => notice?.tone === 'error')

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

const ChoiceSlider = ({ count, position }: { count: number; position: number }): ReactElement => {
  const { accent } = useTheme()
  const step = count > 1 ? (SLIDER_WIDTH - 1) / (count - 1) : 0
  const at = Math.round(Math.max(0, Math.min(position, count - 1)) * step)
  return (
    <Text>
      <Text dimColor>{'─'.repeat(at)}</Text>
      <Text color={accent}>█</Text>
      <Text dimColor>{'─'.repeat(SLIDER_WIDTH - 1 - at)}</Text>
    </Text>
  )
}

const ValueRow = ({
  label,
  value,
  slider,
  active,
  onPoint,
  labelWidth = LABEL_WIDTH,
}: {
  label: string
  value: string
  slider?: { count: number; position: number }
  active: boolean
  onPoint?: () => void
  labelWidth?: number
}): ReactElement => {
  const { accent, selection } = useTheme()
  const clicks = useDevPanelClicks()
  return (
    <Box
      height={1}
      flexShrink={0}
      overflow="hidden"
      {...(active ? { backgroundColor: selection } : {})}
      {...(clicks && onPoint ? { ref: clicks.target(onPoint, onPoint) } : {})}
    >
      <Text wrap="truncate-end">
        <Text color={accent}>{active ? '› ' : '  '}</Text>
        <Text bold={active} dimColor={!active}>
          {label.padEnd(labelWidth)}
        </Text>
        {slider ? (
          <>
            <ChoiceSlider count={slider.count} position={slider.position} />
            <Text>{`  ${value}`}</Text>
          </>
        ) : (
          <Text>{value}</Text>
        )}
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
            <Text {...toneColor(step.notice?.tone)}>{step.notice ? ' ! ' : '  '}</Text>
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
  estimate,
  focused,
  onChoose,
  onHover,
}: {
  buttons: readonly WizardButton[]
  ready: boolean
  finishLabel: string
  cancelLabel: string
  estimate: string
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
      <Box flexGrow={1} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <Text dimColor wrap="truncate-end">
          {estimate}
        </Text>
      </Box>
    </Box>
  )
}

const buttonHint = (
  button: WizardButton,
  finishHint: (blocking: WizardNotice | undefined) => string,
  blocking: WizardNotice | undefined
): string => {
  if (button === 'finish') return finishHint(blocking)
  if (button === 'next') return 'Enter next'
  return button === 'back' ? 'Enter back' : 'Enter cancel'
}

const rowHints = (
  row: WizardRow | undefined,
  finishHint: (blocking: WizardNotice | undefined) => string,
  blocking: WizardNotice | undefined,
  {
    walked,
    back,
    autofill,
    leave,
    escape,
  }: { walked: boolean; back: boolean; autofill: boolean; leave: boolean; escape: string }
): string[] => {
  const tab = walked ? ['Tab next tab'] : []
  const rest = [...(autofill ? ['ctrl+a autofill'] : []), ...(leave && !walked ? ['↓ chat'] : []), escape]
  const hints = (action: string, arrows = '↑↓'): string[] => [...tab, arrows, action, ...rest]
  if (row?.kind === 'button')
    return hints(back && row.button === 'cancel' ? 'Enter back' : buttonHint(row.button, finishHint, blocking), '←→')
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
  footer = '',
  width,
  height,
  finishLabel = BUTTON_LABELS.finish,
  finishHint,
  onFinish,
  onCancel,
  onBack,
  active = true,
  blocked,
  position,
  autofill,
  onLeave,
  escapeHint = 'Esc cancel',
}: WizardProps): ReactElement => {
  const own = useWizardPosition()
  const at = position?.step ?? own.step
  const editing = useSyncedState<Editor | undefined>(undefined)
  const step = steps[Math.min(at.value, steps.length - 1)] ?? steps[0]!
  const index = steps.indexOf(step)
  const rows = stepRows(step, index, steps.length)
  // Every label of a step gets the width of its longest one, so the values line up.
  const labelWidth = Math.max(LABEL_WIDTH, ...step.fields.map((field) => field.label.length + 2))
  const buttons = stepButtons(index, steps.length)
  const cursor = cursorIn(position?.row ?? own.row, rows.length)
  const blocking = blockingNotice(steps)
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
    } else if (row.field.kind === 'text') openEditor(row.field.key, row.field.edit)
    else if (row.field.edit) openEditor(row.field.key, row.field.edit)
  }
  const choose = (row: number): void => {
    cursor.set(row)
    activate(rows[row])
  }
  useInput(
    (input, key) => {
      if (blocked?.() === true) return
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
      if (key.ctrl && input === 'a' && autofill) autofill.set(!autofill.on)
      // A text row takes what is typed on it: the first character opens its editor and lands in it.
      else if (row?.kind === 'field' && row.field.kind === 'text' && !key.ctrl && typed.trim() !== '') {
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
      else if (key.leftArrow || key.rightArrow) {
        if (row?.kind === 'field' && row.field.kind === 'choice') row.field.move(key.rightArrow ? 1 : -1)
      } else if (key.return || shortcut(input, key) === ' ') activate(row)
    },
    { isActive: active }
  )
  usePaste((text) => editing.set((current) => current && edited(current, pasteText(current.value, text))))
  const editorField = (field: WizardField): ReactElement => (
    <TextField
      label={field.label}
      value={editor?.value ?? textValue('')}
      active
      labelWidth={labelWidth}
      width={width}
      placeholder=""
    />
  )
  const rowOf = (key: string): number => rows.findIndex((row) => row.kind === 'field' && row.field.key === key)
  const toggleRows = toggles.map(({ key }) => rowOf(key))
  const notice = step.body ? undefined : (step.notice ?? blocking)
  // A single question is sized to its content, so its list chrome is counted, not approximated.
  const listChrome = walked
    ? LIST_CHROME_ROWS
    : 3 +
      (hasQuestion ? 1 : 0) +
      (compact ? 0 : 1) +
      (compact || step.listLabel === undefined ? 0 : 1) +
      (notice ? 1 : compact ? 0 : 1) +
      (step.footnote !== undefined && !compact ? 1 : 0)
  // One scrolling list for every toggle of the step, placed where the first one was declared.
  const toggleList = (): ReactNode => (
    <>
      {compact || step.listLabel === undefined ? null : <Line>{`  ${step.listLabel}`}</Line>}
      <ItemList
        items={toggles.map((field) =>
          field.key === editor?.key ? { ...toggleItem(field), detail: withCursor(editor.value) } : toggleItem(field)
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
    </>
  )
  const fieldView = (field: WizardField): ReactNode => {
    if (field.kind === 'toggle')
      return field.key === toggles[0]?.key ? (
        <Box key={field.key} flexDirection="column" flexShrink={0}>
          {toggleList()}
        </Box>
      ) : null
    const row = rowOf(field.key)
    const point = row < 0 ? undefined : (): void => cursor.set(row)
    if (field.kind === 'text')
      return editor?.key === field.key ? (
        <Box key={field.key} flexDirection="column" flexShrink={0}>
          {editorField(field)}
        </Box>
      ) : (
        <ValueRow
          key={field.key}
          labelWidth={labelWidth}
          label={field.label}
          value={field.display}
          active={cursorRow === row}
          {...(point ? { onPoint: point } : {})}
        />
      )
    const shown = selectable(field) ? (
      <ValueRow
        labelWidth={labelWidth}
        label={field.label}
        value={field.detail}
        {...(field.count > 1 ? { slider: { count: field.count, position: field.position } } : {})}
        active={cursorRow === row}
        {...(point ? { onPoint: point } : {})}
      />
    ) : (
      <ValueRow
        labelWidth={labelWidth}
        label={field.label}
        value={field.detail}
        {...(field.count > 1 ? { slider: { count: field.count, position: field.position } } : {})}
        active={false}
      />
    )
    if (!field.edit && field.display === undefined) return <Box key={field.key}>{shown}</Box>
    return (
      <Box key={field.key} flexDirection="column" flexShrink={0}>
        {editor?.key === field.key ? editorField(field) : shown}
        {editor?.key === field.key ? null : field.display ? (
          <Line tone="muted">{`${' '.repeat(labelWidth + 2)}${field.display}`}</Line>
        ) : null}
      </Box>
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
      {step.bodyFirst && step.body ? step.body(bodyRoom) : null}
      {step.bodyFirst && step.body && !walked && !compact ? <Gap /> : null}
      {step.fields.map(fieldView)}
      {!step.bodyFirst && step.body ? step.body(bodyRoom) : null}
      {editor && step.editFootnote ? <Line tone="muted">{`  ${step.editFootnote}`}</Line> : null}
      {step.footnote !== undefined && !compact ? (
        <Line tone="muted">{`${' '.repeat(labelWidth + 2)}${step.footnote}`}</Line>
      ) : null}
      {notice ? <Line tone={notice.tone}>{`  ${notice.text}`}</Line> : compact ? null : <Gap />}
      <WizardButtons
        buttons={buttons}
        ready={ready}
        finishLabel={finishLabel}
        cancelLabel={onBack ? BUTTON_LABELS.back : BUTTON_LABELS.cancel}
        estimate={footer}
        focused={focused?.kind === 'button' ? focused.button : undefined}
        onChoose={(button) => choose(firstButton + buttons.indexOf(button))}
        onHover={(button) => cursor.set(firstButton + buttons.indexOf(button))}
      />
      <Fill />
      <KeyHints
        hints={
          !active
            ? ['↑ answer this']
            : editor
              ? ['Enter save', 'Esc cancel']
              : rowHints(focused, finishHint, blocking, {
                  walked,
                  back: onBack !== undefined,
                  autofill: autofill !== undefined,
                  leave: onLeave !== undefined,
                  escape: escapeHint,
                })
        }
      />
    </>
  )
}
