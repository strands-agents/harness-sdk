import { useEffect, useState, type ReactElement } from 'react'

import { Line, PanelTitle, useSyncedState } from './kit.js'
import { useWizardPosition, Wizard, type WizardField, type WizardStep } from './wizard.js'
import {
  defaultAnswers,
  type WizardAnswer,
  type WizardBroker,
  type WizardFieldSpec,
  type WizardRequest,
  type WizardStepSpec,
} from './wizard-request.js'

export interface WizardRequestPanelProps {
  readonly broker: WizardBroker
  readonly width: number
  readonly height: number
  readonly close: () => void
}

type Answers = Record<string, WizardAnswer>

const choiceOf = (field: WizardFieldSpec & { kind: 'choice' }, answer: WizardAnswer | undefined): string => {
  const picked = typeof answer === 'string' ? answer : undefined
  return picked !== undefined && field.options.includes(picked) ? picked : (field.options[0] ?? '')
}

const toField = (
  spec: WizardFieldSpec,
  answers: Answers,
  update: (key: string, value: WizardAnswer) => void
): WizardField => {
  if (spec.kind === 'toggle')
    return {
      kind: 'toggle',
      key: spec.key,
      label: spec.label,
      ...(spec.detail === undefined ? {} : { detail: spec.detail }),
      ...(spec.unavailable === undefined ? {} : { unavailable: spec.unavailable }),
      checked: answers[spec.key] === true,
      hint: 'Enter toggle',
      toggle: () => update(spec.key, answers[spec.key] !== true),
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
      const next = spec.options[spec.options.indexOf(current) + step]
      if (next !== undefined) update(spec.key, next)
    },
  }
}

const toStep = (
  spec: WizardStepSpec,
  answers: Answers,
  update: (key: string, value: WizardAnswer) => void
): WizardStep => ({
  key: spec.key,
  title: spec.title,
  fields: spec.fields.map((field) => toField(field, answers, update)),
  ...(spec.notice ? { notice: spec.notice } : {}),
  ...(spec.listLabel === undefined ? {} : { listLabel: spec.listLabel }),
  ...(spec.footnote === undefined ? {} : { footnote: spec.footnote }),
})

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
  const update = (key: string, value: WizardAnswer): void => answers.set((current) => ({ ...current, [key]: value }))
  const steps = request.steps.map((step) => toStep(step, answers.value, update))
  return (
    <Wizard
      name={request.name}
      {...(request.titleParts ? { titleParts: request.titleParts } : {})}
      steps={steps}
      {...(request.status === undefined ? {} : { status: request.status })}
      {...(request.footer === undefined ? {} : { footer: request.footer })}
      {...(request.finishLabel === undefined ? {} : { finishLabel: request.finishLabel })}
      width={width}
      height={height}
      finishHint={(blocking) => (blocking ? 'fix the problem to finish' : 'Enter finish')}
      onFinish={() => broker.respond(request.id, { ...answers.current() })}
      onCancel={() => broker.respond(request.id, undefined)}
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
