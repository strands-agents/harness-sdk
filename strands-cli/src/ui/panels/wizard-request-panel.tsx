import { createElement, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useInput } from '../input.js'

import type { DevChatPanelProps } from '../chat/types.js'
import { Box } from '../theme.js'
import { useDevPanelClicks } from './dev.js'
import {
  Line,
  PanelTitle,
  useSyncedState,
  Wizard,
  type WizardField,
  type WizardStep,
  type WizardToggle,
} from './wizard.js'
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
  type WizardFieldSpec,
  type WizardOption,
  type WizardRequest,
  type WizardSelectSpec,
  type WizardStepSpec,
} from './wizard-request.js'

type Answers = Record<string, WizardAnswer>

interface Typed {
  readonly value: Readonly<Record<string, string>>
  readonly set: (key: string, text: string) => void
}

const chosen = (answer: WizardAnswer | undefined): readonly string[] => {
  if (Array.isArray(answer)) return answer
  return typeof answer === 'string' && answer ? [answer] : []
}

const selectFields = (
  spec: WizardSelectSpec,
  answers: Answers,
  live: () => Answers,
  update: (key: string, value: WizardAnswer) => void,
  typed: Typed
): WizardField[] => {
  const single = spec.multiple === false
  const pick = (value: string): void => {
    const was = chosen(live()[spec.key])
    if (single) return update(spec.key, value)
    update(spec.key, was.includes(value) ? was.filter((item) => item !== value) : [...was, value])
  }
  // Saving text picks the input row, and saving it empty unpicks it.
  const type = (value: string, text: string): void => {
    const trimmed = text.trim()
    typed.set(inputKey(spec.key, value), trimmed)
    const picked = chosen(live()[spec.key]).includes(value)
    if (trimmed && !picked) pick(value)
    else if (!trimmed && picked) {
      if (single) update(spec.key, '')
      else pick(value)
    }
  }
  const inputRow = (option: WizardOption): Pick<WizardToggle, 'hint' | 'detail' | 'edit'> => {
    const text = typed.value[inputKey(spec.key, option.value)] ?? ''
    return {
      hint: 'Enter type',
      detail: text || option.detail || '',
      edit: { value: text, save: (next: string) => type(option.value, next) },
    }
  }
  return spec.options.map((option): WizardField => ({
    kind: 'toggle',
    key: `${spec.key}.${option.value}`,
    label: option.label,
    ...(option.detail === undefined ? {} : { detail: option.detail }),
    ...(option.unavailable === undefined ? {} : { unavailable: option.unavailable }),
    mark: single ? 'radio' : 'check',
    checked: chosen(answers[spec.key]).includes(option.value),
    hint: single ? 'Enter pick' : 'Enter toggle',
    toggle: () => pick(option.value),
    ...(option.input ? inputRow(option) : {}),
  }))
}

const toField = (
  spec: Exclude<WizardFieldSpec, WizardSelectSpec | WizardDiffSpec>,
  answers: Answers,
  update: (key: string, value: WizardAnswer) => void
): WizardField => {
  if (spec.kind === 'number') {
    const value = answers[spec.key]
    const shown = typeof value === 'number' ? String(value) : ''
    return {
      kind: 'text',
      key: spec.key,
      label: spec.label,
      display: [shown || 'none', spec.detail].filter(Boolean).join('   '),
      hint: 'Enter edit',
      edit: {
        value: shown,
        numeric: true,
        save: (text) => update(spec.key, text ? Number(text) : ''),
      },
    }
  }
  const value = typeof answers[spec.key] === 'string' ? (answers[spec.key] as string) : ''
  return {
    kind: 'text',
    key: spec.key,
    label: spec.label,
    display: value.trim() || 'none',
    hint: 'Enter edit',
    edit: {
      value,
      save: (text) => update(spec.key, text),
    },
  }
}

const problemOf = (spec: WizardStepSpec, answers: Answers): string | undefined =>
  spec.fields
    .map((field) => (field.kind === 'number' ? numberProblem(field, answers[field.key]) : undefined))
    .find((problem) => problem !== undefined)

const diffOf = (spec: WizardStepSpec): WizardDiffSpec | undefined =>
  spec.fields.flatMap((field) => (field.kind === 'diff' ? [field] : []))[0]

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

const toStep = (
  spec: WizardStepSpec,
  answers: Answers,
  live: () => Answers,
  update: (key: string, value: WizardAnswer) => void,
  typed: Typed,
  { width, active }: { width: number; active: boolean }
): WizardStep => {
  const problem = problemOf(spec, answers)
  const change = diffOf(spec)
  return {
    key: spec.key,
    title: spec.title,
    fields: spec.fields.flatMap((field) => {
      if (field.kind === 'diff') return []
      return field.kind === 'select'
        ? selectFields(field, answers, live, update, typed)
        : [toField(field, answers, update)]
    }),
    ...(change
      ? {
          bodyRows: 1 + wrappedDiffLines(change.diff, wizardDiffTextWidth(width)).length,
          body: (room: number) => createElement(DiffBody, { spec: change, room, width, active }),
        }
      : {}),
    ...(problem === undefined ? {} : { notice: { tone: 'error' as const, text: problem } }),
  }
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
  const answers = useSyncedState<Answers>(() => defaultAnswers(request.steps))
  const texts = useSyncedState<Record<string, string>>(() => ({}))
  const typed: Typed = {
    value: texts.value,
    set: (key, text) => texts.set((current) => ({ ...current, [key]: text })),
  }
  const update = (key: string, value: WizardAnswer): void => answers.set((current) => ({ ...current, [key]: value }))
  const steps = request.steps.map((step) =>
    toStep(step, answers.value, answers.current, update, typed, { width, active })
  )
  useEffect(
    () => broker.draft(request.id, finishedAnswers(request.steps, answers.value, texts.value)),
    [broker, request, answers.value, texts.value]
  )
  return (
    <Wizard
      name={request.name}
      {...(request.question === undefined ? {} : { question: request.question })}
      {...(request.titleParts ? { titleParts: request.titleParts } : {})}
      steps={steps}
      {...(request.finishLabel === undefined ? {} : { finishLabel: request.finishLabel })}
      width={width}
      height={height}
      active={active}
      {...(blur ? { onLeave: blur } : {})}
      finishHint={(blocking) => (blocking ? 'fix the problem to finish' : 'Enter finish')}
      onFinish={() => broker.respond(request.id, finishedAnswers(request.steps, answers.current(), texts.current()))}
      onCancel={() => broker.respond(request.id, undefined)}
      {...(request.back ? { onBack: () => broker.respond(request.id, 'back') } : {})}
      // Closing a standing question answers nothing: whoever asked keeps it waiting, so Esc only closes it.
      {...(request.standing ? { escapeHint: 'Esc close' } : {})}
    />
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
