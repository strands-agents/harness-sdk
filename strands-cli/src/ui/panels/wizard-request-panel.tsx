import { createElement, useEffect, useState, type ReactElement } from 'react'

import { wrapCells } from '../../terminal/text.js'
import { diffRows, DIFF_SUMMARY_LABEL, type DiffRow } from '../diff-rows.js'
import { Line, PanelTitle, useSyncedState } from './kit.js'
import { useWizardPosition, Wizard, type WizardField, type WizardStep } from './wizard.js'
import {
  defaultAnswers,
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
      display: value.trim() || 'none',
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

const DIFF_HEADER_ROWS = 2
const DIFF_INDENT = 2

/** A long line wraps under its own gutter rather than being cut, the way the permission prompt shows a change. */
const diffTextRows = (rows: readonly DiffRow[], width: number): DiffRow[] => {
  const gutter = DIFF_SUMMARY_LABEL.length + 1
  const room = Math.max(1, width - DIFF_INDENT - gutter)
  return rows.flatMap((row) =>
    wrapCells(row.text, room).map((text, index) => ({
      ...row,
      label: index === 0 ? row.label : '',
      text,
    }))
  )
}

/** Shows as many diff rows as the room allows, and says how many it held back. */
const DiffBody = ({ spec, room, width }: { spec: WizardDiffSpec; room: number; width: number }): ReactElement => {
  const rows = diffTextRows(diffRows(spec.diff), width)
  const capacity = Math.max(1, room - DIFF_HEADER_ROWS)
  const shown = rows.slice(0, capacity)
  const hidden = rows.length - shown.length
  const gutter = DIFF_SUMMARY_LABEL.length + 1
  return (
    <>
      <Line tone="muted">{`${' '.repeat(DIFF_INDENT)}${spec.path}`}</Line>
      {shown.map((row, index) => (
        <Line key={`${row.label}-${index}`} {...(row.tone ? { tone: row.tone } : {})}>
          {`${' '.repeat(DIFF_INDENT)}${row.label.padEnd(gutter)}${row.text}`}
        </Line>
      ))}
      {hidden > 0 ? <Line tone="muted">{`${' '.repeat(DIFF_INDENT)}${hidden} more lines`}</Line> : null}
    </>
  )
}

const toStep = (
  spec: WizardStepSpec,
  answers: Answers,
  live: () => Answers,
  update: (key: string, value: WizardAnswer) => void,
  width: number
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
    ? { bodyFirst: true, body: (room: number) => createElement(DiffBody, { spec: diffOf(spec)!, room, width }) }
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
  const steps = request.steps.map((step) => toStep(step, answers.value, answers.current, update, width))
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
      autofill={{
        on: autofill,
        set: (on) => {
          broker.setAutofill(on)
          onAutofill?.(on)
        },
      }}
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
