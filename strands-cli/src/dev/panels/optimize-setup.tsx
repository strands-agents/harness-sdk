import { useState, type ReactElement, type ReactNode } from 'react'
import { useInput } from 'ink'

import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { Box, Text } from '../../ui/theme.js'
import {
  useWizardPosition,
  Wizard,
  type WizardField,
  type WizardNotice,
  type WizardStep,
  type WizardToggle,
} from '../../ui/panels/wizard.js'
import {
  sameCaseSplit,
  sameObjective,
  smallSplitWarning,
  type CaseSplit,
  type CrashScore,
  type Knob,
  type ModelChoices,
  type OptimizeDecision,
  type OptimizeObjective,
  type OptimizePlan,
  type OptimizeSession,
  type PickRule,
  type RunAgent,
  type UsageEstimate,
  type UsageRange,
} from './model.js'
import {
  agentModel,
  awsBedrockFact,
  Fill,
  fileToolWarnings,
  ItemList,
  KeyHints,
  labelWidthFor,
  Line,
  listed,
  PaidRunView,
  PanelTitle,
  plural,
  useCursor,
  usePaidRunConfirm,
  type ListItem,
  type PaidRun,
} from './ui.js'

export interface SetupViewProps extends DevChatPanelProps {
  readonly session: OptimizeSession
  readonly plan: OptimizePlan
}

const COMMAND = 'optimize'
const SUMMARY_LABEL_WIDTH = 12
const MODEL_CHOOSER_CHROME_ROWS = 5
const MODEL_FILTER = /^[\w.:/-]$/u
const PERCENT = 100
const MEAN_OF_EVERY_EVALUATOR = 'the mean of every evaluator'

const CRASH_TEXT: Readonly<Record<CrashScore, string>> = {
  worst: 'a crashed run scores the worst value',
  none: 'a crashed run counts as no data',
}

const PICK_TEXT: Readonly<Record<PickRule, string>> = {
  mean: 'the posterior mean',
  'lower-bound-25': 'a 25% lower bound, to ship cautiously',
  'lower-bound-10': 'a 10% lower bound, to ship more cautiously',
}

type ObjectiveField = keyof OptimizeObjective

interface PlanSource {
  readonly plan: OptimizePlan
  readonly session: OptimizeSession
  readonly latest: () => OptimizePlan
}

const splitText = ({ train, validation, test }: CaseSplit): string =>
  `${train} train / ${validation} validation / ${test} test`

const splitPosition = ({ split, splitChoices }: OptimizePlan): number =>
  splitChoices.findIndex((choice) => sameCaseSplit(choice, split))

const presetPosition = ({ objective, objectivePresets }: OptimizePlan): number =>
  objectivePresets.findIndex((preset) => sameObjective(preset.objective, objective))

const objectiveText = ({ expression }: OptimizeObjective): string => expression.trim() || MEAN_OF_EVERY_EVALUATOR

const feasibilityText = (threshold: number): string =>
  `${Math.round(threshold * PERCENT)}% sure that each constraint holds`

const testShareText = (share: number): string => {
  if (share === 0) return 'none, so the run has no test check'
  const perTest = Math.round((1 - share) / share)
  return perTest === 1 ? '1 test case for each validation case' : `1 test case for each ${perTest} validation cases`
}

const finalistText = ({ decision, validatedFinalists }: OptimizePlan): string =>
  validatedFinalists > decision.finalists
    ? `${plural(validatedFinalists, 'finalist')} on validation, the least that Pareto takes`
    : `${plural(decision.finalists, 'finalist')} on validation`

const knobToggle = (knob: Knob, session: OptimizeSession, chooseModels: () => void): WizardToggle => ({
  kind: 'toggle',
  key: knob.key,
  label: knob.label,
  ...(knob.detail === undefined ? {} : { detail: knob.detail }),
  ...(knob.unavailable === undefined ? {} : { unavailable: knob.unavailable }),
  checked: knob.enabled === true,
  hint: knob.kind === 'models' ? 'Enter choose models' : 'Enter toggle',
  toggle: (): void => {
    if (knob.kind !== 'models') return session.toggleKnob(knob.key)
    session.loadModels()
    chooseModels()
  },
})

const choiceField = <Value,>({
  key,
  label,
  choices,
  value,
  detail,
  hint,
  pick,
  latest,
}: {
  readonly key: string
  readonly label: string
  readonly choices: readonly Value[]
  readonly value: Value
  readonly detail: string
  readonly hint: string
  readonly pick: (value: Value) => void
  readonly latest: () => Value
}): WizardField => ({
  kind: 'choice',
  key,
  label,
  count: choices.length,
  position: Math.max(0, choices.indexOf(value)),
  detail,
  hint,
  move: (step): void => {
    const next = choices[choices.indexOf(latest()) + step]
    if (next !== undefined) pick(next)
  },
})

const decisionField = <Setting extends keyof OptimizeDecision>(
  { plan, session, latest }: PlanSource,
  setting: Setting,
  view: {
    readonly label: string
    readonly hint: string
    readonly describe: (value: OptimizeDecision[Setting]) => string
  }
): WizardField =>
  choiceField({
    key: setting,
    label: view.label,
    choices: plan.decisionChoices[setting],
    value: plan.decision[setting],
    detail: view.describe(plan.decision[setting]),
    hint: view.hint,
    pick: (value) => session.setDecision(setting, value),
    latest: () => latest().decision[setting],
  })

const objectiveFields = ({ plan, session, latest }: PlanSource): WizardField[] => {
  const position = presetPosition(plan)
  const custom = position < 0
  const edit =
    (field: ObjectiveField): ((text: string) => void) =>
    (text: string): void =>
      session.setObjective({ ...latest().objective, [field]: text })
  return [
    {
      kind: 'choice',
      key: 'objective',
      label: 'objective',
      count: plan.objectivePresets.length + Number(custom),
      position: custom ? plan.objectivePresets.length : position,
      detail: custom ? 'custom' : (plan.objectivePresets[position]?.label ?? ''),
      hint: '←→ preset · Enter edit',
      display: plan.objective.expression.trim(),
      edit: {
        value: plan.objective.expression,
        placeholder: 'empty means the mean of every evaluator',
        save: edit('expression'),
      },
      move: (step): void => {
        const current = latest()
        const at = presetPosition(current)
        const next = current.objectivePresets[(at < 0 ? current.objectivePresets.length : at) + step]
        if (next) session.setObjective(next.objective)
      },
    },
    {
      kind: 'text',
      key: 'constraints',
      label: 'constraints',
      display: plan.objective.constraints.trim() || 'none',
      hint: 'Enter edit',
      edit: {
        value: plan.objective.constraints,
        placeholder: 'such as tokens <= 4000, Correctness >= 0.8',
        save: edit('constraints'),
      },
    },
  ]
}

const goalFields = (source: PlanSource): WizardField[] => [
  ...objectiveFields(source),
  ...(source.plan.objective.constraints.trim()
    ? [decisionField(source, 'feasibility', { label: 'met at', hint: '←→ certainty', describe: feasibilityText })]
    : []),
  decisionField(source, 'crashScore', {
    label: 'crashes',
    hint: '←→ crashes',
    describe: (score) => CRASH_TEXT[score],
  }),
  decisionField(source, 'pickRule', { label: 'pick', hint: '←→ pick', describe: (rule) => PICK_TEXT[rule] }),
]

const caseFields = ({ plan, session, latest }: PlanSource): WizardField[] => [
  {
    kind: 'choice',
    key: 'cases',
    label: 'cases',
    count: plan.splitChoices.length,
    position: Math.max(0, splitPosition(plan)),
    detail: splitText(plan.split),
    hint: '←→ split',
    move: (step): void => {
      const current = latest()
      const next = current.splitChoices[splitPosition(current) + step]
      if (next) session.setSplit(next)
    },
  },
  choiceField({
    key: 'test',
    label: 'test',
    choices: plan.testShareChoices,
    value: plan.testShare,
    detail: testShareText(plan.testShare),
    hint: '←→ test cases',
    pick: (share) => session.setTestShare(share),
    latest: () => latest().testShare,
  }),
]

const budgetFields = (source: PlanSource): WizardField[] => {
  const { plan, session, latest } = source
  return [
    choiceField({
      key: 'budget',
      label: 'budget',
      choices: plan.iterationChoices,
      value: plan.iterations,
      detail: `${plural(plan.iterations, 'step')} × ${plan.width} candidates`,
      hint: '←→ budget',
      pick: (iterations) => session.setIterations(iterations),
      latest: () => latest().iterations,
    }),
    choiceField({
      key: 'candidates',
      label: 'per step',
      choices: plan.widthChoices,
      value: plan.width,
      detail: `${plural(plan.width, 'candidate')} in each step`,
      hint: '←→ candidates',
      pick: (width) => session.setWidth(width),
      latest: () => latest().width,
    }),
    choiceField({
      key: 'runs',
      label: 'runs',
      choices: plan.repetitionChoices,
      value: plan.repetitions,
      detail: `${plural(plan.repetitions, 'run')} of each case per candidate`,
      hint: '←→ runs',
      pick: (repetitions) => session.setRepetitions(repetitions),
      latest: () => latest().repetitions,
    }),
    decisionField(source, 'finalists', {
      label: 'finalists',
      hint: '←→ finalists',
      describe: () => finalistText(plan),
    }),
    choiceField({
      key: 'workers',
      label: 'parallel',
      choices: plan.workerChoices,
      value: plan.workers,
      detail: `${plural(plan.workers, 'trial')} at once`,
      hint: '←→ parallel trials',
      pick: (workers) => session.setWorkers(workers),
      latest: () => latest().workers,
    }),
  ]
}

const tunedKnobs = ({ knobs }: OptimizePlan): Knob[] => knobs.filter((knob) => knob.enabled && !knob.unavailable)

const NO_KNOB: WizardNotice = { tone: 'error', text: 'Check a knob to tune.' }

const goalNotice = ({ objectiveProblem, objectiveWarning }: OptimizePlan): WizardNotice | undefined => {
  if (objectiveProblem) return { tone: 'error', text: objectiveProblem }
  return objectiveWarning ? { tone: 'warning', text: objectiveWarning } : undefined
}

const caseNotice = (plan: OptimizePlan): WizardNotice | undefined => {
  const warning = plan.warning ?? smallSplitWarning(plan.split)
  return warning ? { tone: 'warning', text: warning } : undefined
}

const budgetNotice = ({ budgetProblem }: OptimizePlan): WizardNotice | undefined =>
  budgetProblem ? { tone: 'error', text: budgetProblem } : undefined

const startHint = (plan: OptimizePlan, blocking: WizardNotice | undefined): string => {
  if (blocking === undefined) return 'Enter start'
  if (plan.objectiveProblem) return 'fix the objective to start'
  return plan.budgetProblem ? 'lower the budget to start' : 'check a knob to start'
}

const ModelChooser = ({
  session,
  models,
  width,
  height,
  onDone,
}: {
  session: OptimizeSession
  models: ModelChoices
  width: number
  height: number
  onDone: () => void
}): ReactElement => {
  const [filter, setFilter] = useState('')
  const options = [
    { id: models.current, name: `${models.current} (current)` },
    ...(models.options ?? []).filter(({ id }) => id !== models.current),
  ].filter(({ id, name }) => `${id} ${name}`.toLowerCase().includes(filter.toLowerCase()))
  const cursor = useCursor(options.length)
  const toggle = (index: number): void => {
    const option = options[index]
    if (option && option.id !== models.current) session.pickModel(option.id, !models.picked.includes(option.id))
  }
  useInput((input, key) => {
    if (key.escape) onDone()
    else if (key.upArrow) cursor.move(-1)
    else if (key.downArrow) cursor.move(1)
    else if (key.return || input === ' ') toggle(cursor.current())
    else if (key.backspace || key.delete) setFilter((text) => text.slice(0, -1))
    else if (!key.ctrl && !key.meta && MODEL_FILTER.test(input)) setFilter((text) => text + input)
  })
  const items: ListItem[] = options.map(({ id, name }) => ({
    key: id,
    label: name,
    detail: id === models.current ? 'always tried' : id,
    mark:
      id === models.current || models.picked.includes(id)
        ? { text: '☑', tone: 'success' }
        : { text: '☐', tone: 'muted' },
    tone: 'muted',
  }))
  return (
    <>
      <PanelTitle name={COMMAND} parts={['models to try', plural(models.picked.length, 'other model')]} />
      <Line tone="muted">{`  filter: ${filter || 'type to filter'}`}</Line>
      {models.loading ? <Line tone="muted">{'  Listing the models of this provider…'}</Line> : null}
      {models.error ? <Line tone="error">{`  ${models.error}`}</Line> : null}
      <ItemList
        items={items}
        selected={cursor.index}
        capacity={Math.max(1, height - MODEL_CHOOSER_CHROME_ROWS)}
        labelWidth={labelWidthFor(
          items.map(({ label }) => label),
          width
        )}
        onClick={(index) => {
          cursor.set(index)
          toggle(index)
        }}
        onHover={cursor.set}
      />
      <Fill />
      <KeyHints hints={['↑↓', 'Enter pick', 'type to filter', 'Esc done']} />
    </>
  )
}

const THOUSAND = 1_000
const MILLION = 1_000_000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const MINUTES_SHOWN_AS_HOURS = 120
const PRICE_UNKNOWN = 'price unknown'

const spanText = (low: string, high: string): string => (low === high ? low : `${low}–${high}`)

const countText = (count: number): string =>
  count >= MILLION
    ? `${(count / MILLION).toFixed(1)}M`
    : count >= THOUSAND
      ? `${Math.round(count / THOUSAND)}k`
      : String(Math.round(count))

const tokensText = ({ low, high }: UsageRange): string => `${spanText(countText(low), countText(high))} tokens`

const durationText = ({ low, high }: UsageRange): string => {
  const minutes = (seconds: number): number => Math.max(1, Math.round(seconds / SECONDS_PER_MINUTE))
  if (minutes(high) < MINUTES_SHOWN_AS_HOURS) return `${spanText(String(minutes(low)), String(minutes(high)))} min`
  const hours = (seconds: number): string => (seconds / SECONDS_PER_MINUTE / MINUTES_PER_HOUR).toFixed(1)
  return `${spanText(hours(low), hours(high))} h`
}

const usageShort = (usage: UsageEstimate | undefined): string =>
  usage
    ? `~${tokensText(usage.tokens)} · ~${durationText(usage.seconds)} · ${PRICE_UNKNOWN}`
    : `no token or time estimate yet · ${PRICE_UNKNOWN}`

const usageSentence = (usage: UsageEstimate | undefined): string => {
  if (!usage) return 'strands dev cannot estimate the tokens and the time yet, and it has no model prices.'
  const { experiment, runs } = usage.basedOn
  const basis = `${runs === 1 ? 'the last run' : `the last ${runs} runs`} of ${experiment}`
  return (
    `About ${tokensText(usage.tokens)} and ${durationText(usage.seconds)}, from ${basis}. ` +
    'The price is unknown, because strands dev has no model prices.'
  )
}

const judgeCallsText = (calls: number, about: string): string =>
  calls === 0 ? 'no judge calls' : `${about}${calls} judge calls`

const rolloutsText = ({ rollouts, judgeCalls }: OptimizePlan): string =>
  `~${rollouts} rollouts · ${judgeCallsText(judgeCalls, '~')}`

const PROPOSER_RISK =
  'The commands get your environment, your credentials, and your network. This is not a sandbox, and text in the ' +
  'cases can carry prompt injection. To protect your credentials, run strands dev in a container or VM that has ' +
  'only the credentials that the run needs.'

const textKnobs = (knobs: readonly Knob[]): string[] =>
  knobs.filter(({ kind }) => kind === 'text').map(({ label }) => label)

const proposerWarnings = (texts: readonly string[]): string[] =>
  texts.length === 0
    ? []
    : [
        `To rewrite the ${listed(texts)}, a proposer agent writes shell commands and runs them on this machine. ${PROPOSER_RISK}`,
      ]

const triedModels = (plan: OptimizePlan, knobs: readonly Knob[], agent: RunAgent | undefined): string => {
  const current = plan.models?.current ?? agentModel(agent)
  const others = knobs.some(({ kind }) => kind === 'models') ? (plan.models?.picked.length ?? 0) : 0
  return others > 0 ? `${current} and ${plural(others, 'other model')}` : current
}

const bedrockCalls = (judgeCalls: number, proposer: boolean): string | undefined => {
  const judges = judgeCalls > 0 ? `About ${judgeCalls} judge calls` : undefined
  if (judges && proposer) return `${judges} and the proposer calls`
  return judges ?? (proposer ? 'The proposer calls' : undefined)
}

const constraintsText = ({ objective, decision }: OptimizePlan): string => {
  const constraints = objective.constraints.trim()
  return constraints ? `${constraints}, ${feasibilityText(decision.feasibility)}` : 'none'
}

const pickText = (plan: OptimizePlan): string =>
  `${PICK_TEXT[plan.decision.pickRule]} of ${plural(plan.validatedFinalists, 'finalist')}`

const paidOptimization = (plan: OptimizePlan, agent: RunAgent | undefined, start: () => void): PaidRun => {
  const knobs = tunedKnobs(plan)
  const texts = textKnobs(knobs)
  const { train, validation, test } = plan.split
  const bedrock = bedrockCalls(plan.judgeCalls, texts.length > 0)
  return {
    title: [plan.experiment.name],
    facts: [
      `The optimizer tunes the ${listed(knobs.map(({ label }) => label))} of your agent on ${train} train, ` +
        `${validation} validation, and ${plural(test, 'test case')} of ${plan.experiment.name}.`,
      `It tries ${plural(plan.iterations, 'step')} of ${plural(plan.width, 'candidate')}` +
        `${plan.repetitions > 1 ? `, with each case run ${plan.repetitions} times` : ''}: about ${plan.rollouts} ` +
        `rollouts of your agent with ${triedModels(plan, knobs, agent)}. ${plural(plan.workers, 'trial')} run at once.`,
      ...(bedrock ? [awsBedrockFact(bedrock)] : []),
      usageSentence(plan.usage),
    ],
    warnings: [...proposerWarnings(texts), ...fileToolWarnings(agent)],
    start,
  }
}

const reviewFacts = (plan: OptimizePlan, agent: RunAgent | undefined): readonly (readonly [string, string])[] => {
  const knobs = tunedKnobs(plan)
  return [
    ['tune', knobs.length > 0 ? listed(knobs.map(({ label }) => label)) : 'no knob yet'],
    ['models', triedModels(plan, knobs, agent)],
    ['goal', objectiveText(plan.objective)],
    ['constraints', constraintsText(plan)],
    ['crashes', CRASH_TEXT[plan.decision.crashScore]],
    ['pick', pickText(plan)],
    ['cases', splitText(plan.split)],
    [
      'budget',
      `${plural(plan.iterations, 'step')} × ${plural(plan.width, 'candidate')}, ` +
        `${plural(plan.repetitions, 'run')} of each case`,
    ],
    ['parallel', `${plural(plan.workers, 'trial')} at once`],
  ]
}

const SummaryRow = ({ label, value }: { label: string; value: string }): ReactElement => (
  <Box height={1} flexShrink={0} overflow="hidden">
    <Text wrap="truncate-end">
      <Text dimColor>{`  ${label.padEnd(SUMMARY_LABEL_WIDTH)}`}</Text>
      <Text>{value}</Text>
    </Text>
  </Box>
)

const reviewBody = (
  plan: OptimizePlan,
  agent: RunAgent | undefined,
  notices: readonly (readonly [string, WizardNotice | undefined])[],
  room: number
): ReactNode => {
  const lines = notices.flatMap(([title, notice]) =>
    notice ? [<Line key={title} tone={notice.tone}>{`  ${title}: ${notice.text}`}</Line>] : []
  )
  const facts = reviewFacts(plan, agent)
  const space = Math.max(0, room - lines.length)
  const shown = facts.length > space ? facts.slice(0, Math.max(0, space - 1)) : facts
  const hidden = facts.length - shown.length
  return (
    <>
      {shown.map(([label, value]) => (
        <SummaryRow key={label} label={label} value={value} />
      ))}
      {hidden > 0 ? <Line tone="muted">{`  ↓ ${hidden} more, in the tabs`}</Line> : null}
      {lines}
    </>
  )
}

const setupSteps = (source: PlanSource, agent: RunAgent | undefined, chooseModels: () => void): WizardStep[] => {
  const { plan, session } = source
  const tune = tunedKnobs(plan).length === 0 ? NO_KNOB : undefined
  const goal = goalNotice(plan)
  const cases = caseNotice(plan)
  const budget = budgetNotice(plan)
  const titled: readonly (readonly [string, WizardNotice | undefined])[] = [
    ['Tune', tune],
    ['Goal', goal],
    ['Cases', cases],
    ['Budget', budget],
  ]
  return [
    {
      key: 'tune',
      title: 'Tune',
      listLabel: 'knobs',
      fields: plan.knobs.map((knob) => knobToggle(knob, session, chooseModels)),
      ...(tune ? { notice: tune } : {}),
    },
    {
      key: 'goal',
      title: 'Goal',
      fields: goalFields(source),
      editFootnote: `metrics: ${plan.metrics.join(', ')}`,
      ...(goal ? { notice: goal } : {}),
    },
    {
      key: 'cases',
      title: 'Cases',
      fields: caseFields(source),
      footnote: 'Train cases guide the search. Validation picks the winner. Test checks it.',
      ...(cases ? { notice: cases } : {}),
    },
    {
      key: 'budget',
      title: 'Budget',
      fields: budgetFields(source),
      ...(budget ? { notice: budget } : {}),
    },
    {
      key: 'review',
      title: 'Review',
      fields: [],
      body: (room) => reviewBody(plan, agent, titled, room),
    },
  ]
}

export const SetupView = ({ session, width, height, plan }: SetupViewProps): ReactElement => {
  const latest = (): OptimizePlan => {
    const state = session.snapshot()
    return state.step === 'setup' ? state.plan : plan
  }
  const [choosingModels, setChoosingModels] = useState(false)
  const confirm = usePaidRunConfirm()
  const position = useWizardPosition()
  const agent = session.agent?.()
  const source: PlanSource = { plan, session, latest }
  const steps = setupSteps(source, agent, () => setChoosingModels(true))
  if (confirm.pending)
    return (
      <PaidRunView
        command={COMMAND}
        run={confirm.pending}
        width={width}
        height={height}
        backHint="Esc back to the setup"
        onAnswer={confirm.answer}
      />
    )
  if (choosingModels && plan.models)
    return (
      <ModelChooser
        session={session}
        models={plan.models}
        width={width}
        height={height}
        onDone={() => setChoosingModels(false)}
      />
    )
  return (
    <Wizard
      name={COMMAND}
      titleParts={[plan.experiment.name, plural(plan.experiment.caseCount, 'case'), splitText(plan.split)]}
      steps={steps}
      status={rolloutsText(plan)}
      footer={usageShort(plan.usage)}
      width={width}
      height={height}
      finishHint={(blocking) => startHint(plan, blocking)}
      onFinish={() => confirm.ask(paidOptimization(latest(), session.agent?.(), () => session.start()))}
      onCancel={() => session.reset()}
      active={!choosingModels}
      blocked={confirm.asking}
      position={position}
    />
  )
}
