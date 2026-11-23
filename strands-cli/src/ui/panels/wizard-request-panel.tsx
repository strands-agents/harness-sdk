import { useEffect, useState, type ReactElement } from 'react'

import { Line, PanelTitle, useSyncedState } from './kit.js'
import { useWizardPosition, Wizard, type WizardField, type WizardStep, type WizardToggle } from './wizard.js'
import {
  defaultAnswers,
  finishedAnswers,
  inputKey,
  numberProblem,
  type WizardAnswer,
  type WizardBroker,
  type WizardFieldSpec,
  type WizardOption,
  type WizardRequest,
  type WizardSelectSpec,
  type WizardStepSpec,
} from './wizard-request.js'

export interface WizardRequestPanelProps {
  readonly broker: WizardBroker
  readonly width: number
  readonly height: number
  readonly close: () => void
}

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
  spec: Exclude<WizardFieldSpec, WizardSelectSpec>,
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

const toStep = (
  spec: WizardStepSpec,
  answers: Answers,
  live: () => Answers,
  update: (key: string, value: WizardAnswer) => void,
  typed: Typed
): WizardStep => {
  const problem = problemOf(spec, answers)
  return {
    key: spec.key,
    title: spec.title,
    fields: spec.fields.flatMap((field) =>
      field.kind === 'select' ? selectFields(field, answers, live, update, typed) : [toField(field, answers, update)]
    ),
    ...(problem === undefined ? {} : { notice: { tone: 'error' as const, text: problem } }),
  }
}

const RequestView = ({
  request,
  broker,
  width,
  height,
}: {
  request: WizardRequest
  broker: WizardBroker
  width: number
  height: number
}): ReactElement => {
  const answers = useSyncedState<Answers>(() => defaultAnswers(request.steps))
  const position = useWizardPosition()
  const texts = useSyncedState<Record<string, string>>(() => ({}))
  const typed: Typed = {
    value: texts.value,
    set: (key, text) => texts.set((current) => ({ ...current, [key]: text })),
  }
  const update = (key: string, value: WizardAnswer): void => answers.set((current) => ({ ...current, [key]: value }))
  const steps = request.steps.map((step) => toStep(step, answers.value, answers.current, update, typed))
  return (
    <Wizard
      name={request.name}
      {...(request.question === undefined ? {} : { question: request.question })}
      steps={steps}
      {...(request.finishLabel === undefined ? {} : { finishLabel: request.finishLabel })}
      width={width}
      height={height}
      finishHint={(blocking) => (blocking ? 'fix the problem to finish' : 'Enter finish')}
      onFinish={() => broker.respond(request.id, finishedAnswers(request.steps, answers.current(), texts.current()))}
      onCancel={() => broker.respond(request.id, undefined)}
      {...(request.back ? { onBack: () => broker.respond(request.id, 'back') } : {})}
      position={position}
    />
  )
}

export const WizardRequestPanel = ({ broker, width, height, close }: WizardRequestPanelProps): ReactElement => {
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
  return <RequestView key={request.id} request={request} broker={broker} width={width} height={height} />
}
