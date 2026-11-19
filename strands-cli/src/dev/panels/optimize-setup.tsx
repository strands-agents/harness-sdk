import { useState, type ReactElement } from 'react'
import { useInput, usePaste } from 'ink'

import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { Box, Text, useTheme } from '../../ui/theme.js'
import { useDevPanelClicks } from '../../ui/panels/dev.js'
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
  editText,
  Fill,
  fileToolWarnings,
  Gap,
  ItemList,
  KeyHints,
  labelWidthFor,
  Line,
  listed,
  PaidRunView,
  PanelTitle,
  pasteText,
  plural,
  shortcut,
  TextField,
  textValue,
  useCursor,
  usePaidRunConfirm,
  useSyncedState,
  useToneColor,
  type ListItem,
  type PaidRun,
  type TextValue,
  type Tone,
} from './ui.js'

export interface SetupViewProps extends DevChatPanelProps {
  readonly session: OptimizeSession
  readonly plan: OptimizePlan
}

const COMMAND = 'optimize'
const SLIDER_WIDTH = 21
const SLIDER_LABEL_WIDTH = 12
const FULL_SETUP_ROWS = 12
const TUNE_CHROME_ROWS = 9
const MODEL_CHOOSER_CHROME_ROWS = 5
const MODEL_FILTER = /^[\w.:/-]$/u
const PERCENT = 100
const MEAN_OF_EVERY_EVALUATOR = 'the mean of every evaluator'

type SetupTab = 'tune' | 'goal' | 'cases' | 'budget' | 'review'

const SETUP_TABS: readonly SetupTab[] = ['tune', 'goal', 'cases', 'budget', 'review']

const TAB_TITLES: Readonly<Record<SetupTab, string>> = {
  tune: 'Tune',
  goal: 'Goal',
  cases: 'Cases',
  budget: 'Budget',
  review: 'Review',
}

const CRASH_TEXT: Readonly<Record<CrashScore, string>> = {
  worst: 'a crashed run scores the worst value',
  none: 'a crashed run counts as no data',
}

const PICK_TEXT: Readonly<Record<PickRule, string>> = {
  mean: 'the posterior mean',
  'lower-bound-25': 'a 25% lower bound, to ship cautiously',
  'lower-bound-10': 'a 10% lower bound, to ship more cautiously',
}

const knobItem = (knob: Knob): ListItem => {
  if (knob.unavailable)
    return {
      key: knob.key,
      label: knob.label,
      detail: knob.unavailable,
      mark: { text: '☐', tone: 'muted' },
      tone: 'warning',
    }
  return {
    key: knob.key,
    label: knob.label,
    detail: knob.detail,
    mark: knob.enabled ? { text: '☑', tone: 'success' } : { text: '☐', tone: 'muted' },
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

type SetupButton = 'next' | 'back' | 'start' | 'cancel'

const BUTTON_LABELS: Readonly<Record<SetupButton, string>> = {
  next: '[ Next ]',
  back: 'Back',
  start: '[ Start ]',
  cancel: 'Cancel',
}

const tabButtons = (tab: SetupTab): readonly SetupButton[] => {
  if (tab === 'review') return ['start', 'cancel']
  return tab === 'tune' ? ['next', 'cancel'] : ['next', 'back']
}

interface SetupSlider {
  readonly key: string
  readonly label: string
  readonly count: number
  readonly position: number
  readonly detail: string
  readonly hint: string
  readonly editable?: boolean
  readonly move: (step: 1 | -1) => void
}

type ObjectiveField = keyof OptimizeObjective

type SetupRow =
  | { readonly kind: 'knob'; readonly knob: Knob }
  | { readonly kind: 'slider'; readonly slider: SetupSlider }
  | { readonly kind: 'constraints' }
  | { readonly kind: 'button'; readonly button: SetupButton }

interface ObjectiveEditor {
  readonly field: ObjectiveField
  readonly value: TextValue
}

interface Notice {
  readonly tone: Tone
  readonly text: string
}

type TabNotices = Partial<Readonly<Record<SetupTab, Notice>>>

interface SliderSource {
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

const choiceSlider = <Value,>({
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
}): SetupSlider => ({
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

const decisionSlider = <Setting extends keyof OptimizeDecision>(
  { plan, session, latest }: SliderSource,
  setting: Setting,
  view: {
    readonly label: string
    readonly hint: string
    readonly describe: (value: OptimizeDecision[Setting]) => string
  }
): SetupSlider =>
  choiceSlider({
    key: setting,
    label: view.label,
    choices: plan.decisionChoices[setting],
    value: plan.decision[setting],
    detail: view.describe(plan.decision[setting]),
    hint: view.hint,
    pick: (value) => session.setDecision(setting, value),
    latest: () => latest().decision[setting],
  })

const objectiveSlider = ({ plan, session, latest }: SliderSource): SetupSlider => {
  const position = presetPosition(plan)
  const custom = position < 0
  return {
    key: 'objective',
    label: 'objective',
    count: plan.objectivePresets.length + Number(custom),
    position: custom ? plan.objectivePresets.length : position,
    detail: custom ? 'custom' : (plan.objectivePresets[position]?.label ?? ''),
    hint: '←→ preset · Enter edit',
    editable: true,
    move: (step): void => {
      const current = latest()
      const at = presetPosition(current)
      const next = current.objectivePresets[(at < 0 ? current.objectivePresets.length : at) + step]
      if (next) session.setObjective(next.objective)
    },
  }
}

const goalSliders = (source: SliderSource): SetupSlider[] => [
  objectiveSlider(source),
  ...(source.plan.objective.constraints.trim()
    ? [decisionSlider(source, 'feasibility', { label: 'met at', hint: '←→ certainty', describe: feasibilityText })]
    : []),
  decisionSlider(source, 'crashScore', {
    label: 'crashes',
    hint: '←→ crashes',
    describe: (score) => CRASH_TEXT[score],
  }),
  decisionSlider(source, 'pickRule', { label: 'pick', hint: '←→ pick', describe: (rule) => PICK_TEXT[rule] }),
]

const caseSliders = ({ plan, session, latest }: SliderSource): SetupSlider[] => [
  {
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
  choiceSlider({
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

const budgetSliders = (source: SliderSource): SetupSlider[] => {
  const { plan, session, latest } = source
  return [
    choiceSlider({
      key: 'budget',
      label: 'budget',
      choices: plan.iterationChoices,
      value: plan.iterations,
      detail: `${plural(plan.iterations, 'step')} × ${plan.width} candidates`,
      hint: '←→ budget',
      pick: (iterations) => session.setIterations(iterations),
      latest: () => latest().iterations,
    }),
    choiceSlider({
      key: 'candidates',
      label: 'per step',
      choices: plan.widthChoices,
      value: plan.width,
      detail: `${plural(plan.width, 'candidate')} in each step`,
      hint: '←→ candidates',
      pick: (width) => session.setWidth(width),
      latest: () => latest().width,
    }),
    choiceSlider({
      key: 'runs',
      label: 'runs',
      choices: plan.repetitionChoices,
      value: plan.repetitions,
      detail: `${plural(plan.repetitions, 'run')} of each case per candidate`,
      hint: '←→ runs',
      pick: (repetitions) => session.setRepetitions(repetitions),
      latest: () => latest().repetitions,
    }),
    decisionSlider(source, 'finalists', {
      label: 'finalists',
      hint: '←→ finalists',
      describe: () => finalistText(plan),
    }),
    choiceSlider({
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

const tabSliders = (tab: SetupTab, source: SliderSource): SetupSlider[] => {
  if (tab === 'goal') return goalSliders(source)
  if (tab === 'cases') return caseSliders(source)
  if (tab === 'budget') return budgetSliders(source)
  return []
}

const hasChoice = ({ count }: SetupSlider): boolean => count > 1

const isSelectable = (slider: SetupSlider): boolean => slider.editable === true || hasChoice(slider)

const tabRows = (tab: SetupTab, plan: OptimizePlan, sliders: readonly SetupSlider[]): SetupRow[] => [
  ...(tab === 'tune'
    ? plan.knobs.map((knob): SetupRow => ({ kind: 'knob', knob }))
    : sliders
        .filter(isSelectable)
        .flatMap((slider): SetupRow[] =>
          slider.key === 'objective'
            ? [{ kind: 'slider', slider }, { kind: 'constraints' }]
            : [{ kind: 'slider', slider }]
        )),
  ...tabButtons(tab).map((button): SetupRow => ({ kind: 'button', button })),
]

const tunedKnobs = ({ knobs }: OptimizePlan): Knob[] => knobs.filter((knob) => knob.enabled && !knob.unavailable)

const NO_KNOB: Notice = { tone: 'error', text: 'Check a knob to tune.' }

const goalNotice = ({ objectiveProblem, objectiveWarning }: OptimizePlan): Notice | undefined => {
  if (objectiveProblem) return { tone: 'error', text: objectiveProblem }
  return objectiveWarning ? { tone: 'warning', text: objectiveWarning } : undefined
}

const tabNotices = (plan: OptimizePlan): TabNotices => {
  const goal = goalNotice(plan)
  const splitWarning = plan.warning ?? smallSplitWarning(plan.split)
  const cases: Notice | undefined = splitWarning ? { tone: 'warning', text: splitWarning } : undefined
  const budget: Notice | undefined = plan.budgetProblem ? { tone: 'error', text: plan.budgetProblem } : undefined
  return {
    ...(tunedKnobs(plan).length === 0 ? { tune: NO_KNOB } : {}),
    ...(goal ? { goal } : {}),
    ...(cases ? { cases } : {}),
    ...(budget ? { budget } : {}),
  }
}

const blockingNotice = (notices: TabNotices): Notice | undefined =>
  SETUP_TABS.map((tab) => notices[tab]).find((notice) => notice?.tone === 'error')

const startHint = (plan: OptimizePlan, ready: boolean): string => {
  if (ready) return 'Enter start'
  if (plan.objectiveProblem) return 'fix the objective to start'
  return plan.budgetProblem ? 'lower the budget to start' : 'check a knob to start'
}

const buttonHint = (button: SetupButton, plan: OptimizePlan, ready: boolean): string => {
  if (button === 'start') return startHint(plan, ready)
  if (button === 'next') return 'Enter next'
  return button === 'back' ? 'Enter back' : 'Enter cancel'
}

const setupHints = (focused: SetupRow | undefined, plan: OptimizePlan, ready: boolean): string[] => {
  const hints = (action: string): string[] => ['Tab next tab', '↑↓', action, 'Esc cancel']
  if (focused?.kind === 'slider') return hints(focused.slider.hint)
  if (focused?.kind === 'constraints') return hints('Enter edit')
  if (focused?.kind === 'button') return hints(buttonHint(focused.button, plan, ready))
  if (focused?.kind !== 'knob') return ['Tab next tab', 'Esc cancel']
  if (focused.knob.unavailable) return hints('not available')
  return hints(focused.knob.kind === 'models' ? 'Enter choose models' : 'Enter toggle')
}

const FieldRow = ({
  label,
  value,
  active,
  onPoint,
}: {
  label: string
  value: string
  active: boolean
  onPoint: () => void
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
          {label.padEnd(SLIDER_LABEL_WIDTH)}
        </Text>
        <Text>{value}</Text>
      </Text>
    </Box>
  )
}

const SliderRow = ({
  slider,
  active,
  onPoint,
}: {
  slider: SetupSlider
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
          {slider.label.padEnd(SLIDER_LABEL_WIDTH)}
        </Text>
        {hasChoice(slider) ? (
          <>
            <ChoiceSlider count={slider.count} position={slider.position} />
            <Text>{`  ${slider.detail}`}</Text>
          </>
        ) : (
          <Text>{slider.detail}</Text>
        )}
      </Text>
    </Box>
  )
}

const TabBar = ({
  tab,
  notices,
  right,
  onPick,
}: {
  tab: SetupTab
  notices: TabNotices
  right: string
  onPick: (tab: SetupTab) => void
}): ReactElement => {
  const { accent, selection } = useTheme()
  const toneColor = useToneColor()
  const clicks = useDevPanelClicks()
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Box flexShrink={0}>
        {SETUP_TABS.map((name) => {
          const notice = notices[name]
          return (
            <Box
              key={name}
              flexShrink={0}
              marginRight={1}
              {...(name === tab ? { backgroundColor: selection } : {})}
              {...(clicks ? { ref: clicks.target(() => onPick(name)) } : {})}
            >
              <Text {...(name === tab ? { color: accent, bold: true } : { dimColor: true })}>
                {` ${TAB_TITLES[name]}`}
              </Text>
              <Text {...toneColor(notice?.tone)}>{notice ? ' ! ' : '  '}</Text>
            </Box>
          )
        })}
      </Box>
      <Box flexGrow={1} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <Text dimColor wrap="truncate-end">
          {right}
        </Text>
      </Box>
    </Box>
  )
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
      <Text dimColor>{`  ${label.padEnd(SLIDER_LABEL_WIDTH)}`}</Text>
      <Text>{value}</Text>
    </Text>
  </Box>
)

const ReviewTab = ({
  plan,
  agent,
  notices,
}: {
  plan: OptimizePlan
  agent: RunAgent | undefined
  notices: TabNotices
}): ReactElement => (
  <>
    {reviewFacts(plan, agent).map(([label, value]) => (
      <SummaryRow key={label} label={label} value={value} />
    ))}
    {SETUP_TABS.flatMap((tab) => {
      const notice = notices[tab]
      return notice ? [<Line key={tab} tone={notice.tone}>{`  ${TAB_TITLES[tab]}: ${notice.text}`}</Line>] : []
    })}
  </>
)

export const SetupView = ({ session, width, height, plan }: SetupViewProps): ReactElement => {
  const latest = (): OptimizePlan => {
    const state = session.snapshot()
    return state.step === 'setup' ? state.plan : plan
  }
  const tab = useSyncedState<SetupTab>('tune')
  const source: SliderSource = { plan, session, latest }
  const sliders = tabSliders(tab.value, source)
  const rows = tabRows(tab.value, plan, sliders)
  const rowOf = (match: (row: SetupRow) => boolean): number => rows.findIndex(match)
  const firstButton = rowOf((row) => row.kind === 'button')
  const constraintsRow = rowOf((row) => row.kind === 'constraints')
  const cursor = useCursor(rows.length)
  const editing = useSyncedState<ObjectiveEditor | undefined>(undefined)
  const [choosingModels, setChoosingModels] = useState(false)
  const confirm = usePaidRunConfirm()
  const notices = tabNotices(plan)
  const ready = blockingNotice(notices) === undefined
  const compact = height < FULL_SETUP_ROWS
  const focused = rows[cursor.index]
  const editor = editing.value
  const notice = tab.value === 'review' ? undefined : (notices[tab.value] ?? blockingNotice(notices))
  const cancel = (): void => session.reset()
  const pickTab = (next: SetupTab): void => {
    tab.set(next)
    cursor.set(0)
  }
  const nextTab = (step: 1 | -1): SetupTab => {
    const at = SETUP_TABS.indexOf(tab.current())
    return SETUP_TABS[(at + step + SETUP_TABS.length) % SETUP_TABS.length]!
  }
  const moveTab = (step: 1 | -1): void => pickTab(nextTab(step))
  const stepTab = (step: 1 | -1, keep: readonly SetupButton[]): void => {
    const next = nextTab(step)
    const nextRows = tabRows(next, plan, tabSliders(next, source))
    const at = keep
      .map((button) => nextRows.findIndex((row) => row.kind === 'button' && row.button === button))
      .find((index) => index >= 0)
    tab.set(next)
    cursor.set(at ?? 0)
  }
  const edit = (field: ObjectiveField): void => editing.set({ field, value: textValue(latest().objective[field]) })
  const save = ({ field, value }: ObjectiveEditor): void => {
    session.setObjective({ ...latest().objective, [field]: value.input })
    editing.set(undefined)
  }
  const activate = (row: SetupRow | undefined): void => {
    if (row?.kind === 'button') {
      if (row.button === 'cancel') cancel()
      else if (row.button === 'next') stepTab(1, ['next', 'start'])
      else if (row.button === 'back') stepTab(-1, ['next'])
      else if (ready) confirm.ask(paidOptimization(latest(), session.agent?.(), () => session.start()))
    } else if (row?.kind === 'slider' && row.slider.editable) edit('expression')
    else if (row?.kind === 'constraints') edit('constraints')
    else if (row?.kind === 'knob' && !row.knob.unavailable) {
      if (row.knob.kind !== 'models') return session.toggleKnob(row.knob.key)
      session.loadModels()
      setChoosingModels(true)
    }
  }
  const choose = (index: number): void => {
    cursor.set(index)
    activate(rows[index])
  }
  useInput(
    (input, key) => {
      if (confirm.asking()) return
      const open = editing.current()
      if (open) {
        if (key.escape) editing.set(undefined)
        else if (key.return) save(open)
        else if (!key.tab)
          editing.set((current) => current && { ...current, value: editText(current.value, input, key) })
        return
      }
      const row = rows[cursor.current()]
      if (key.escape) cancel()
      else if (key.tab) moveTab(key.shift ? -1 : 1)
      else if (key.upArrow) cursor.move(-1)
      else if (key.downArrow) cursor.move(1)
      else if (key.leftArrow || key.rightArrow) {
        if (row?.kind === 'slider') row.slider.move(key.rightArrow ? 1 : -1)
      } else if (key.return || shortcut(input, key) === ' ') activate(row)
    },
    { isActive: !choosingModels }
  )
  usePaste((text) => editing.set((current) => current && { ...current, value: pasteText(current.value, text) }))
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
  const editorField = (label: string, placeholder: string): ReactElement => (
    <TextField
      label={label}
      value={editor?.value ?? textValue('')}
      active
      labelWidth={SLIDER_LABEL_WIDTH}
      width={width}
      placeholder={placeholder}
    />
  )
  const sliderRow = (slider: SetupSlider): ReactElement => {
    const row = rowOf((entry) => entry.kind === 'slider' && entry.slider.key === slider.key)
    const shown = isSelectable(slider) ? (
      <SliderRow key={slider.key} slider={slider} active={cursor.index === row} onPoint={() => cursor.set(row)} />
    ) : (
      <SliderRow key={slider.key} slider={slider} active={false} />
    )
    if (slider.key !== 'objective') return shown
    return (
      <Box key={slider.key} flexDirection="column" flexShrink={0}>
        {shown}
        {editor?.field === 'expression' ? (
          editorField('goal', 'empty means the mean of every evaluator')
        ) : plan.objective.expression.trim() ? (
          <Line tone="muted">{`${' '.repeat(SLIDER_LABEL_WIDTH + 2)}${plan.objective.expression.trim()}`}</Line>
        ) : null}
        {editor?.field === 'constraints' ? (
          editorField('constraints', 'such as tokens <= 4000, Correctness >= 0.8')
        ) : (
          <FieldRow
            label="constraints"
            value={plan.objective.constraints.trim() || 'none'}
            active={cursor.index === constraintsRow}
            onPoint={() => cursor.set(constraintsRow)}
          />
        )}
      </Box>
    )
  }
  return (
    <>
      <PanelTitle
        name={COMMAND}
        parts={[plan.experiment.name, plural(plan.experiment.caseCount, 'case'), splitText(plan.split)]}
      />
      <TabBar tab={tab.value} notices={notices} right={rolloutsText(plan)} onPick={pickTab} />
      {compact ? null : <Gap />}
      {tab.value === 'tune' ? (
        <>
          {compact ? null : <Line>{'  knobs'}</Line>}
          <ItemList
            items={plan.knobs.map(knobItem)}
            selected={focused?.kind === 'knob' ? cursor.index : -1}
            capacity={Math.max(3, Math.min(plan.knobs.length, height - TUNE_CHROME_ROWS))}
            labelWidth={labelWidthFor(
              plan.knobs.map(({ label }) => label),
              width
            )}
            onClick={choose}
            onHover={cursor.set}
          />
        </>
      ) : null}
      {sliders.map(sliderRow)}
      {tab.value === 'review' ? <ReviewTab plan={plan} agent={session.agent?.()} notices={notices} /> : null}
      {editor ? <Line tone="muted">{`  metrics: ${plan.metrics.join(', ')}`}</Line> : null}
      {tab.value === 'cases' && !compact ? (
        <Line tone="muted">
          {`${' '.repeat(SLIDER_LABEL_WIDTH + 2)}Train cases guide the search. Validation picks the winner. Test checks it.`}
        </Line>
      ) : null}
      {notice ? <Line tone={notice.tone}>{`  ${notice.text}`}</Line> : compact ? null : <Gap />}
      <SetupButtons
        buttons={tabButtons(tab.value)}
        ready={ready}
        estimate={usageShort(plan.usage)}
        focused={focused?.kind === 'button' ? focused.button : undefined}
        onChoose={(button) => choose(firstButton + tabButtons(tab.value).indexOf(button))}
        onHover={(button) => cursor.set(firstButton + tabButtons(tab.value).indexOf(button))}
      />
      <Fill />
      <KeyHints hints={editor ? ['Enter save', 'Esc cancel'] : setupHints(focused, plan, ready)} />
    </>
  )
}

const SetupButtons = ({
  buttons,
  ready,
  estimate,
  focused,
  onChoose,
  onHover,
}: {
  buttons: readonly SetupButton[]
  ready: boolean
  estimate: string
  focused: SetupButton | undefined
  onChoose: (button: SetupButton) => void
  onHover: (button: SetupButton) => void
}): ReactElement => {
  const { accent, selection } = useTheme()
  const clicks = useDevPanelClicks()
  const button = (name: SetupButton, label: ReactElement): ReactElement => (
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
      {label}
    </Box>
  )
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      {buttons.map((name) =>
        name === 'next' || name === 'start'
          ? button(
              name,
              <Text {...(name === 'next' || ready ? { color: accent, bold: true } : { dimColor: true })}>
                {BUTTON_LABELS[name]}
              </Text>
            )
          : button(name, <Text bold={focused === name}>{BUTTON_LABELS[name]}</Text>)
      )}
      <Box flexGrow={1} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <Text dimColor wrap="truncate-end">
          {estimate}
        </Text>
      </Box>
    </Box>
  )
}
