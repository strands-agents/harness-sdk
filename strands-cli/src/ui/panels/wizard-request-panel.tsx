import { createElement, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useInput } from 'ink'

import { diffSummaryText, wrappedDiffLines } from '../diff-rows.js'
import { Box } from '../theme.js'
import { useDevPanelClicks } from './dev.js'
import { Line, PanelTitle, useSyncedState } from './kit.js'
import { useWizardPosition, Wizard, type WizardField, type WizardStep } from './wizard.js'
import {
  defaultAnswers,
  wizardDiffTextWidth,
  type WizardAnswer,
  type WizardBroker,
  type WizardDiffSpec,
  type WizardFieldSpec,
  type WizardRequest,
  type WizardSelectSpec,
  type WizardStepSpec,
} from './wizard-request.js'

export interface WizardRequestPanelProps {
  readonly broker: WizardBroker
  readonly width: number
  readonly height: number
  readonly close: () => void
  readonly active?: boolean
  readonly blur?: () => void
  /** Reports the autofill state under the chat input, so the component stays about the question. */
  readonly onAutofill?: (on: boolean) => void
}

type Answers = Record<string, WizardAnswer>

const chosen = (answer: WizardAnswer | undefined): readonly string[] => {
  if (Array.isArray(answer)) return answer
  return typeof answer === 'string' && answer ? [answer] : []
}

const selectFields = (
  spec: WizardSelectSpec,
  answers: Answers,
  live: () => Answers,
  update: (key: string, value: WizardAnswer) => void
): WizardField[] => {
  const single = spec.multiple === false
  const pick = (value: string): void => {
    const was = chosen(live()[spec.key])
    if (single) return update(spec.key, value)
    update(spec.key, was.includes(value) ? was.filter((item) => item !== value) : [...was, value])
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
  }))
}

const choiceOf = (field: WizardFieldSpec & { kind: 'choice' }, answer: WizardAnswer | undefined): string => {
  const picked = typeof answer === 'string' ? answer : undefined
  return picked !== undefined && field.options.includes(picked) ? picked : (field.options[0] ?? '')
}

const toField = (
  spec: WizardFieldSpec,
  answers: Answers,
  live: () => Answers,
  update: (key: string, value: WizardAnswer) => void
): WizardField => {
  if (spec.kind === 'select') throw new Error('A select spec expands into several fields.')
  if (spec.kind === 'diff') throw new Error('A diff spec renders as rows to read, not as a field.')
  if (spec.kind === 'toggle')
    return {
      kind: 'toggle',
      key: spec.key,
      label: spec.label,
      ...(spec.detail === undefined ? {} : { detail: spec.detail }),
      ...(spec.unavailable === undefined ? {} : { unavailable: spec.unavailable }),
      checked: answers[spec.key] === true,
      hint: 'Enter toggle',
      toggle: () => update(spec.key, live()[spec.key] !== true),
    }
  if (spec.kind === 'text') {
    const value = typeof answers[spec.key] === 'string' ? (answers[spec.key] as string) : ''
    return {
      kind: 'text',
      key: spec.key,
      label: spec.label,
      // Before an answer, the row shows the example the question gave, faint, rather than a word that reads as one.
      display: value.trim() || spec.placeholder || 'none',
      ...(value.trim() ? {} : { unanswered: true }),
      hint: 'Enter edit',
      edit: {
        value,
        placeholder: spec.placeholder ?? '',
        save: (text) => update(spec.key, text),
      },
    }
  }
  const current = choiceOf(spec, answers[spec.key])
  return {
    kind: 'choice',
    key: spec.key,
    label: spec.label,
    count: spec.options.length,
    position: Math.max(0, spec.options.indexOf(current)),
    detail: current,
    hint: spec.hint ?? '←→ choose',
    move: (step): void => {
      const at = spec.options.indexOf(choiceOf(spec, live()[spec.key]))
      const next = spec.options[at + step]
      if (next !== undefined) update(spec.key, next)
    },
  }
}

const selectLabel = (spec: WizardStepSpec): string | undefined =>
  spec.listLabel ??
  spec.fields.flatMap((field) => (field.kind === 'select' && field.listLabel ? [field.listLabel] : []))[0]

const diffOf = (spec: WizardStepSpec): WizardDiffSpec | undefined =>
  spec.fields.flatMap((field) => (field.kind === 'diff' ? [field] : []))[0]

const DIFF_INDENT = ' '.repeat(2)
const DIFF_MARK_COLUMNS = 2
const WHEEL_ROWS = 3
const MIN_ROOM_FOR_POSITION = 3

/** Where the window is in a change longer than it, in the words a list uses for rows it holds back. */
const diffPosition = (above: number, below: number, keys: boolean): string =>
  [above > 0 ? `↑ ${above} previous` : '', below > 0 ? `↓ ${below} more` : '', keys ? 'PgUp/PgDn scroll' : '']
    .filter(Boolean)
    .join(' · ')

/**
 * A change to read: the file and its counts, then its lines under a +/- mark. A long line wraps between words under
 * its own text, the spacing inside a line stays as the file has it, and a change longer than the room scrolls with
 * PgUp/PgDn while the question holds the keyboard, and with the wheel at any time.
 */
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
  // The header takes a row, and a change that does not fit gives one more to saying where the window is. On a panel
  // too short for that, the lines come first: the keys and the wheel still scroll them.
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
  { width, active }: { width: number; active: boolean }
): WizardStep => ({
  key: spec.key,
  title: spec.title,
  fields: spec.fields.flatMap((field) => {
    if (field.kind === 'diff') return []
    return field.kind === 'select'
      ? selectFields(field, answers, live, update)
      : [toField(field, answers, live, update)]
  }),
  ...(diffOf(spec)
    ? {
        bodyFirst: true,
        bodyRows: 1 + wrappedDiffLines(diffOf(spec)!.diff, wizardDiffTextWidth(width)).length,
        body: (room: number) => createElement(DiffBody, { spec: diffOf(spec)!, room, width, active }),
      }
    : {}),
  ...(spec.notice ? { notice: spec.notice } : {}),
  ...(selectLabel(spec) === undefined ? {} : { listLabel: selectLabel(spec)! }),
  ...(spec.footnote === undefined ? {} : { footnote: spec.footnote }),
})

const RequestView = ({
  request,
  broker,
  autofill,
  onAutofill,
  active,
  blur,
  width,
  height,
}: {
  request: WizardRequest
  broker: WizardBroker
  autofill: boolean
  onAutofill?: (on: boolean) => void
  active: boolean
  blur?: () => void
  width: number
  height: number
}): ReactElement => {
  const answers = useSyncedState<Answers>(() => defaultAnswers(request.steps))
  const position = useWizardPosition()
  const update = (key: string, value: WizardAnswer): void => answers.set((current) => ({ ...current, [key]: value }))
  const steps = request.steps.map((step) => toStep(step, answers.value, answers.current, update, { width, active }))
  return (
    <Wizard
      name={request.name}
      {...(request.question === undefined ? {} : { question: request.question })}
      {...(request.titleParts ? { titleParts: request.titleParts } : {})}
      steps={steps}
      {...(request.status === undefined ? {} : { status: request.status })}
      {...(request.footer === undefined ? {} : { footer: request.footer })}
      {...(request.finishLabel === undefined ? {} : { finishLabel: request.finishLabel })}
      width={width}
      height={height}
      active={active}
      {...(blur ? { onLeave: blur } : {})}
      finishHint={(blocking) => (blocking ? 'fix the problem to finish' : 'Enter finish')}
      onFinish={() => broker.respond(request.id, { ...answers.current() })}
      onCancel={() => broker.respond(request.id, undefined)}
      position={position}
      // Autofill is about the agent's own questions; one that stands for the developer does not offer it.
      {...(request.standing
        ? {}
        : {
            autofill: {
              on: autofill,
              set: (on: boolean): void => {
                broker.setAutofill(on)
                onAutofill?.(on)
              },
            },
          })}
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
  onAutofill,
}: WizardRequestPanelProps): ReactElement => {
  const [request, setRequest] = useState(() => broker.pending())
  const [autofill, setAutofill] = useState(() => broker.autofill())
  useEffect(
    () =>
      broker.subscribe((pending) => {
        setRequest(pending)
        setAutofill(broker.autofill())
      }),
    [broker]
  )
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
      autofill={autofill}
      {...(onAutofill ? { onAutofill } : {})}
      active={active}
      {...(blur ? { blur } : {})}
      width={width}
      height={height}
    />
  )
}
