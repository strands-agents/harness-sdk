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
  readonly placeholder: string
  readonly save: (text: string) => void
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
  readonly active?: boolean
  // Read at keypress time, so a view that onFinish opens also swallows the rest of that input burst.
  readonly blocked?: () => boolean
  readonly position?: WizardPosition
  /** Shown on every component so the developer can hand the next question to the agent. */
  readonly autofill?: { readonly on: boolean; readonly set: (on: boolean) => void }
  /** Hands the keyboard to the chat input, for a question the developer wants to leave open. */
  readonly onLeave?: () => void
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

const stepButtons = (at: number, count: number): readonly WizardButton[] => {
  if (at === count - 1) return ['finish', 'cancel']
  return at === 0 ? ['next', 'cancel'] : ['next', 'back']
}

const selectable = (field: WizardField): boolean =>
  field.kind === 'choice' ? field.count > 1 || field.edit !== undefined : true

const stepRows = (step: WizardStep, at: number, count: number): WizardRow[] => [
  ...step.fields.filter(selectable).map((field): WizardRow => ({ kind: 'field', field })),
  ...(count > 1 ? stepButtons(at, count).map((button): WizardRow => ({ kind: 'button', button })) : []),
]

const blockingNotice = (steps: readonly WizardStep[]): WizardNotice | undefined =>
  steps.map(({ notice }) => notice).find((notice) => notice?.tone === 'error')

const MARKS = {
  check: { on: '☑', off: '☐' },
  radio: { on: '◉', off: '○' },
} as const

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
    tone: 'muted',
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
}: {
  label: string
  value: string
  slider?: { count: number; position: number }
  active: boolean
  onPoint?: () => void
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
          {label.padEnd(LABEL_WIDTH)}
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
  estimate,
  focused,
  onChoose,
  onHover,
}: {
  buttons: readonly WizardButton[]
  ready: boolean
  finishLabel: string
  estimate: string
  focused: WizardButton | undefined
  onChoose: (button: WizardButton) => void
  onHover: (button: WizardButton) => void
}): ReactElement => {
  const { accent, selection } = useTheme()
  const clicks = useDevPanelClicks()
  const label = (name: WizardButton): string => (name === 'finish' ? finishLabel : BUTTON_LABELS[name])
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

const LEAVE_HINT = '↓ chat'

const oneQuestionActions = (field: WizardField | undefined): string[] => {
  if (field?.kind === 'text') return ['Enter type']
  if (field?.kind === 'choice') return [field.hint, 'Enter done']
  if (field?.kind !== 'toggle') return ['Enter done']
  if (field.unavailable !== undefined) return ['not available', 'Enter done']
  return field.mark === 'radio' ? ['Enter pick'] : ['Space toggle', 'Enter done']
}

const rowHints = (
  row: WizardRow | undefined,
  finishHint: (blocking: WizardNotice | undefined) => string,
  blocking: WizardNotice | undefined,
  walked: boolean,
  autofill: boolean,
  leave: boolean
): string[] => {
  const tab = walked ? ['Tab next tab'] : []
  const fill = autofill ? ['ctrl+a autofill'] : []
  const hints = (...actions: string[]): string[] => [...tab, '↑↓', ...actions, ...fill, 'Esc cancel']
  if (!walked)
    return hints(...oneQuestionActions(row?.kind === 'field' ? row.field : undefined), ...(leave ? [LEAVE_HINT] : []))
  if (row?.kind === 'button') return hints(buttonHint(row.button, finishHint, blocking))
  if (row?.kind !== 'field') return [...tab, ...fill, 'Esc cancel']
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
  active = true,
  blocked,
  position,
  autofill,
  onLeave,
}: WizardProps): ReactElement => {
  const own = useWizardPosition()
  const at = position?.step ?? own.step
  const editing = useSyncedState<Editor | undefined>(undefined)
  const step = steps[Math.min(at.value, steps.length - 1)] ?? steps[0]!
  const index = steps.indexOf(step)
  const rows = stepRows(step, index, steps.length)
  const buttons = stepButtons(index, steps.length)
  const cursor = cursorIn(position?.row ?? own.row, rows.length)
  const blocking = blockingNotice(steps)
  const ready = blocking === undefined
  const walked = steps.length > 1
  // One question is sized to its content, so it keeps its spacing; only a walked form has to crowd.
  const compact = walked && height < FULL_ROWS
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
      if (row.button === 'cancel') onCancel()
      else if (row.button === 'next') stepTo(1, ['next', 'finish'])
      else if (row.button === 'back') stepTo(-1, ['back', 'next'])
      else if (ready) onFinish()
      return
    }
    if (row?.kind !== 'field') return
    if (row.field.kind === 'toggle') {
      if (row.field.unavailable === undefined) row.field.toggle()
    } else if (row.field.kind === 'text') openEditor(row.field.key, row.field.edit)
    else if (row.field.edit) openEditor(row.field.key, row.field.edit)
  }
  const choose = (row: number): void => {
    cursor.set(row)
    activate(rows[row])
  }
  // One question has no buttons: Enter answers it, and a radio row picks before it does.
  const finishOne = (row: WizardRow | undefined): void => {
    const field = row?.kind === 'field' ? row.field : undefined
    if (field?.kind === 'text') return openEditor(field.key, field.edit)
    if (field?.kind === 'toggle' && field.mark === 'radio' && field.unavailable === undefined) field.toggle()
    if (ready) onFinish()
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
          if (!walked && ready) onFinish()
        } else if (!key.tab)
          editing.set((current) => current && { ...current, value: editText(current.value, input, key) })
        return
      }
      const row = rows[cursor.current()]
      if (key.ctrl && input === 'a') autofill?.set(!autofill.on)
      else if (key.escape) onCancel()
      else if (key.tab && walked) stepTo(key.shift ? -1 : 1, [])
      else if (key.upArrow) cursor.move(-1)
      else if (key.downArrow) {
        // Past the last row of one question, down carries on into the chat instead of stopping.
        if (!walked && onLeave && cursor.current() === rows.length - 1) onLeave()
        else cursor.move(1)
      } else if (key.leftArrow || key.rightArrow) {
        if (row?.kind === 'field' && row.field.kind === 'choice') row.field.move(key.rightArrow ? 1 : -1)
      } else if (!walked && key.return) finishOne(row)
      else if (key.return || shortcut(input, key) === ' ') activate(row)
    },
    { isActive: active }
  )
  usePaste((text) => editing.set((current) => current && { ...current, value: pasteText(current.value, text) }))
  const editorField = (field: WizardField): ReactElement => (
    <TextField
      label={field.label}
      value={editor?.value ?? textValue('')}
      active
      labelWidth={LABEL_WIDTH}
      width={width}
      placeholder={editor?.edit.placeholder ?? ''}
    />
  )
  const rowOf = (key: string): number => rows.findIndex((row) => row.kind === 'field' && row.field.key === key)
  const toggleRows = toggles.map(({ key }) => rowOf(key))
  // One scrolling list for every toggle of the step, placed where the first one was declared.
  const toggleList = (): ReactNode => (
    <>
      {compact || step.listLabel === undefined ? null : <Line>{`  ${step.listLabel}`}</Line>}
      <ItemList
        items={toggles.map(toggleItem)}
        selected={active ? toggleRows.indexOf(cursor.index) : -1}
        capacity={Math.max(
          MIN_LIST_ROWS,
          Math.min(toggles.length, height - LIST_CHROME_ROWS + (steps.length > 1 ? 0 : 1))
        )}
        labelWidth={labelWidthFor(
          toggles.map(({ label }) => label),
          width
        )}
        onClick={(item) => choose(toggleRows[item] ?? 0)}
        onHover={(item) => cursor.set(toggleRows[item] ?? 0)}
      />
    </>
  )
  const fieldView = (field: WizardField): ReactNode => {
    if (field.kind === 'toggle')
      return field.key === toggles[0]?.key ? (
        <Box key={field.key} flexDirection="column">
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
          label={field.label}
          value={field.display}
          active={cursorRow === row}
          {...(point ? { onPoint: point } : {})}
        />
      )
    const shown = selectable(field) ? (
      <ValueRow
        label={field.label}
        value={field.detail}
        {...(field.count > 1 ? { slider: { count: field.count, position: field.position } } : {})}
        active={cursorRow === row}
        {...(point ? { onPoint: point } : {})}
      />
    ) : (
      <ValueRow
        label={field.label}
        value={field.detail}
        {...(field.count > 1 ? { slider: { count: field.count, position: field.position } } : {})}
        active={false}
      />
    )
    if (!field.edit && field.display === undefined) return <Box key={field.key}>{shown}</Box>
    return (
      <Box key={field.key} flexDirection="column" flexShrink={0}>
        {shown}
        {editor?.key === field.key ? (
          editorField(field)
        ) : field.display ? (
          <Line tone="muted">{`${' '.repeat(LABEL_WIDTH + 2)}${field.display}`}</Line>
        ) : null}
      </Box>
    )
  }
  const notice = step.body ? undefined : (step.notice ?? blocking)
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
      {step.bodyFirst && step.body ? step.body(height - (compact ? COMPACT_BODY_CHROME_ROWS : BODY_CHROME_ROWS)) : null}
      {step.fields.map(fieldView)}
      {!step.bodyFirst && step.body
        ? step.body(height - (compact ? COMPACT_BODY_CHROME_ROWS : BODY_CHROME_ROWS))
        : null}
      {editor && step.editFootnote ? <Line tone="muted">{`  ${step.editFootnote}`}</Line> : null}
      {step.footnote !== undefined && !compact ? (
        <Line tone="muted">{`${' '.repeat(LABEL_WIDTH + 2)}${step.footnote}`}</Line>
      ) : null}
      {notice ? <Line tone={notice.tone}>{`  ${notice.text}`}</Line> : compact ? null : <Gap />}
      {walked ? (
        <WizardButtons
          buttons={buttons}
          ready={ready}
          finishLabel={finishLabel}
          estimate={footer}
          focused={focused?.kind === 'button' ? focused.button : undefined}
          onChoose={(button) => choose(firstButton + buttons.indexOf(button))}
          onHover={(button) => cursor.set(firstButton + buttons.indexOf(button))}
        />
      ) : footer ? (
        <Box height={1} flexShrink={0} justifyContent="flex-end" overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {footer}
          </Text>
        </Box>
      ) : null}
      <Fill />
      <KeyHints
        hints={
          active
            ? editor
              ? ['Enter save', 'Esc cancel']
              : rowHints(focused, finishHint, blocking, walked, autofill !== undefined, onLeave !== undefined)
            : ['↑ answer this']
        }
      />
    </>
  )
}
