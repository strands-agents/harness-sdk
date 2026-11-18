import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import { useInput, usePaste } from 'ink'
import stringWidth from 'string-width'

import { createDiffPreview } from '../../agent/file-changes.js'
import { wrapWords } from '../../terminal/text.js'
import type { ChatDiffLine } from '../../agent/types.js'
import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { Box, Text, useTheme } from '../../ui/theme.js'
import { useDevPanelClicks } from '../../ui/panels/dev.js'
import { clipboardNoticeText, useClipboard } from '../../ui/clipboard.js'
import { BROWSER_KEY, browserHints, BrowserView, useBrowserNotice } from './browser.js'
import { ExperimentPicker, type PickerSection } from './picker.js'
import { CaseReport } from './report.js'
import {
  sameCaseSplit,
  formatObjective,
  formatObjectiveChange,
  measuredVersions,
  sameObjective,
  smallSplitWarning,
  type ObjectiveMeasure,
  type CandidateResult,
  type CaseSplit,
  type ExperimentSummary,
  type Knob,
  type ModelChoices,
  type OptimizeObjective,
  type OptimizePlan,
  type OptimizeProgress,
  type OptimizeStep,
  type ScoringProgress,
  type TrialProgress,
  type UsageEstimate,
  type UsageRange,
  type OptimizeReview,
  type OptimizeRun,
  type OptimizeRunState,
  type OptimizeSession,
  type EvalsBrowser,
  type EvalsBrowserPlace,
  type OptimizeState,
  type PastRun,
  type PastRuns,
  type ExperimentsState,
  type ProposedEdit,
  type RunAgent,
  type TestCheck,
} from './model.js'
import {
  agentModel,
  Field,
  fileToolWarnings,
  formatSeconds,
  Fill,
  Gap,
  ItemList,
  KeyHints,
  labelWidthFor,
  Line,
  listed,
  oneLine,
  PaidRunView,
  PanelTitle,
  plural,
  ProgressBar,
  Rule,
  shortcut,
  SplitLine,
  StoppedView,
  useCursor,
  useElapsed,
  usePaidRunConfirm,
  useSyncedState,
  editText,
  pasteText,
  TextField,
  textValue,
  type ListItem,
  type PaidRun,
  type TextValue,
  type Tone,
} from './ui.js'

export interface OptimizePanelProps extends DevChatPanelProps {
  readonly session: OptimizeSession
  readonly browser?: EvalsBrowser
}

const optimizationPlace = (state: OptimizeState): EvalsBrowserPlace => {
  const record =
    state.step === 'review'
      ? state.review.record
      : state.step === 'running'
        ? state.progress.record
        : state.step === 'failed'
          ? state.record
          : undefined
  return record ? { view: 'optimization', record } : { view: 'opt-runs' }
}

const BROWSABLE_STEPS: ReadonlySet<OptimizeState['step']> = new Set([
  'pick',
  'running',
  'review',
  'cancelled',
  'failed',
])

const COMMAND = 'optimize'
const BACK_HINT = 'Esc back to the list'
const SLIDER_WIDTH = 21
const SLIDER_LABEL_WIDTH = 12
const DIFF_CONTEXT_LINES = 2
const FULL_SETUP_ROWS = 12
const DIFF_INDENT = 2
const REVIEW_CHROME_ROWS = 3
const MAX_EDIT_ROWS = 3
const MAX_NOTICE_ROWS = 3
const NOTICE_INDENT = 4
const RUNNING_CHROME_ROWS = 5
const RUNS_CHROME_ROWS = 4

export const OptimizePanel = (props: OptimizePanelProps): ReactElement => {
  const { session } = props
  const state = useSyncExternalStore(session.subscribe, session.snapshot)
  const saved = useSyncExternalStore(session.experiments.subscribe, session.experiments.snapshot)
  const use = useCallback((experiment: ExperimentSummary) => session.plan(experiment), [session])
  const browser = useBrowserNotice(props.browser)
  useInput((input, key) => {
    if (!browser.notice && BROWSABLE_STEPS.has(state.step) && shortcut(input, key) === BROWSER_KEY)
      browser.open(optimizationPlace(state))
  })
  if (browser.notice)
    return (
      <BrowserView
        command={COMMAND}
        notice={browser.notice}
        width={props.width}
        onRetry={browser.retry}
        onBack={browser.dismiss}
      />
    )
  switch (state.step) {
    case 'pick': {
      const runs = state.runs ?? []
      if (state.experiment)
        return (
          <ExperimentRunsView
            {...props}
            experiment={state.experiment}
            runs={runs}
            pastRuns={state.pastRuns}
            onNew={use}
          />
        )
      const others = saved.loaded ? otherRunsSection(saved, runs, state.pastRuns, session) : undefined
      return (
        <ExperimentPicker
          {...props}
          experiments={session.experiments}
          command={COMMAND}
          onUse={(experiment) => session.openExperiment(experiment)}
          describe={(experiment) => runCounts(experiment.name, runs, state.pastRuns)}
          {...(others ? { section: others } : {})}
          extraHints={browserHints(props.browser)}
        />
      )
    }
    case 'setup':
      return <SetupView {...props} plan={state.plan} />
    case 'running':
      return <RunningView {...props} progress={state.progress} />
    case 'review':
      return <ReviewView {...props} review={state.review} />
    case 'cancelled':
      return (
        <StoppedView
          {...props}
          command={COMMAND}
          outcome="cancelled"
          tone="muted"
          retryHint="Enter back to the list"
          message={[
            `You cancelled the optimization of ${state.experiment}.`,
            'The agent source is unchanged.',
            ...(state.run ? [`Run: ${state.run}`] : []),
          ].join('\n')}
          retry={() => session.reset()}
          close={() => session.reset()}
          closeHint={BACK_HINT}
        />
      )
    case 'failed':
      return (
        <StoppedView
          {...props}
          command={COMMAND}
          message={state.record ? `${state.message}\nRecord: ${state.record}` : state.message}
          retryHint="Enter back to the list"
          retry={() => session.reset()}
          close={() => session.reset()}
          closeHint={BACK_HINT}
        />
      )
  }
}

const pad = (value: number): string => String(value).padStart(2, '0')

const startedText = (startedAt: number | undefined): string => {
  if (startedAt === undefined) return ''
  const date = new Date(startedAt)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} · `
}

const reviewSummary = ({ baseline, best, measure, measuredOn, edits, applied }: OptimizeReview): string =>
  edits.length === 0
    ? `no better candidate · ${formatObjective(baseline, measure)} on ${measuredOn}`
    : `${formatObjective(baseline, measure)} → ${formatObjective(best, measure)} on ${measuredOn} · ${plural(edits.length, 'edit')}${applied?.length ? ' · applied' : ''}`

const runSummary = (state: OptimizeRunState): { readonly text: string; readonly tone?: Tone } => {
  switch (state.step) {
    case 'running': {
      const { progress } = state
      const finished = measuredVersions(progress)
      const best = progress.best ? ` · best ${formatObjective(progress.best.score, progress.measure)}` : ''
      const status = progress.stopping
        ? 'stopping'
        : progress.baseline === undefined
          ? 'running · measuring the baseline'
          : 'running'
      return { text: `${status} · ${finished}/${progress.planned} candidates${best}`, tone: 'warning' }
    }
    case 'review':
      return { text: reviewSummary(state.review) }
    case 'cancelled':
      return { text: 'cancelled · the agent source is unchanged', tone: 'muted' }
    case 'failed':
      return { text: `stopped: ${state.message}`, tone: 'error' }
  }
}

const runsNote = (
  runs: readonly OptimizeRun[],
  pastRuns: PastRuns | undefined
): Pick<PickerSection, 'note' | 'noteTone'> => {
  if (pastRuns?.error) return { note: pastRuns.error, noteTone: 'error' }
  if (runs.length > 0 || (pastRuns?.runs.length ?? 0) > 0) return {}
  return { note: pastRuns?.loading ? 'reading past runs…' : 'none yet · each run shows here' }
}

const pastRunsOf = (runs: readonly OptimizeRun[], pastRuns: PastRuns | undefined): readonly PastRun[] => {
  const current = new Set(runs.flatMap(({ record }) => (record ? [record] : [])))
  return (pastRuns?.runs ?? []).filter(({ record }) => !current.has(record))
}

const runCounts = (
  experiment: string,
  runs: readonly OptimizeRun[],
  pastRuns: PastRuns | undefined
): string | undefined => {
  const own = runs.filter((run) => run.experiment === experiment)
  const count = own.length + pastRunsOf(runs, pastRuns).filter((run) => run.experiment === experiment).length
  const running = own.filter(({ state }) => state.step === 'running').length
  if (count === 0) return undefined
  return [plural(count, 'run'), ...(running > 0 ? [`${running} running`] : [])].join(' · ')
}

const otherRunsSection = (
  { saved }: ExperimentsState,
  runs: readonly OptimizeRun[],
  pastRuns: PastRuns | undefined,
  session: OptimizeSession
): PickerSection | undefined => {
  const known = new Set(saved.map(({ name }) => name))
  const others = runs.filter(({ experiment }) => !known.has(experiment))
  const past = (pastRuns?.runs ?? []).filter(({ experiment }) => !known.has(experiment))
  if (others.length + past.length === 0) return undefined
  return {
    ...runsSection(others, pastRuns && { ...pastRuns, runs: past }, session),
    title: 'runs of other experiments',
  }
}

type RunsRow =
  | { readonly kind: 'new' }
  | { readonly kind: 'heading'; readonly title: string }
  | { readonly kind: 'note'; readonly text: string; readonly tone?: Tone }
  | { readonly kind: 'run'; readonly item: ListItem; readonly open?: () => void }

const startedLabel = (startedAt: number | undefined): string =>
  startedAt === undefined ? 'unknown time' : startedText(startedAt).slice(0, -' · '.length)

const experimentRunsRows = (
  experiment: string,
  runs: readonly OptimizeRun[],
  pastRuns: PastRuns | undefined,
  session: OptimizeSession
): RunsRow[] => {
  const own = runs.filter((run) => run.experiment === experiment)
  const past = pastRunsOf(runs, pastRuns).filter((run) => run.experiment === experiment)
  const { note, noteTone } = runsNote(own, pastRuns && { ...pastRuns, runs: past })
  const count = own.length + past.length
  return [
    { kind: 'new' },
    { kind: 'heading', title: count > 0 ? `runs (${count})` : 'runs' },
    ...(note ? [{ kind: 'note' as const, text: note, ...(noteTone ? { tone: noteTone } : {}) }] : []),
    ...own.map(({ id, startedAt, state }): RunsRow => {
      const { text, tone } = runSummary(state)
      const item = { key: id, label: startedLabel(startedAt), detail: text, ...(tone ? { tone } : {}) }
      return { kind: 'run', item, open: () => session.openRun(id) }
    }),
    ...past.map((run): RunsRow => ({
      kind: 'run',
      item: {
        key: run.record,
        label: startedLabel(run.startedAt),
        detail: run.summary,
        ...(run.opens ? {} : { tone: 'muted' as const }),
      },
      ...(run.opens ? { open: () => session.openPastRun(run.record) } : {}),
    })),
  ]
}

const runsRowItem = (row: RunsRow): ListItem => {
  switch (row.kind) {
    case 'new':
      return { key: 'new', label: '+ New optimization run', detail: 'choose what to tune, then start' }
    case 'heading':
      return { key: `heading:${row.title}`, label: row.title, tone: 'muted' }
    case 'note':
      return { key: `note:${row.text}`, label: '', detail: row.text, tone: row.tone ?? 'muted' }
    case 'run':
      return row.item
  }
}

const opensRow = (row: RunsRow | undefined): boolean =>
  row?.kind === 'new' || (row?.kind === 'run' && row.open !== undefined)

const ExperimentRunsView = ({
  session,
  browser,
  experiment,
  runs,
  pastRuns,
  onNew,
  width,
  height,
}: OptimizePanelProps & {
  experiment: ExperimentSummary
  runs: readonly OptimizeRun[]
  pastRuns: PastRuns | undefined
  onNew: (experiment: ExperimentSummary) => void
}): ReactElement => {
  const experiments = useSyncExternalStore(session.experiments.subscribe, session.experiments.snapshot)
  const shown = experiments.saved.find(({ path }) => path === experiment.path) ?? experiment
  const rows = experimentRunsRows(shown.name, runs, pastRuns, session)
  const cursor = useCursor(rows.length)
  const index = opensRow(rows[cursor.index]) ? cursor.index : 0
  const step = (direction: 1 | -1): void => {
    for (let at = cursor.current() + direction; at >= 0 && at < rows.length; at += direction) {
      if (opensRow(rows[at])) {
        cursor.set(at)
        return
      }
    }
  }
  const activate = (row: RunsRow | undefined): void => {
    if (row?.kind === 'new') onNew(shown)
    else if (row?.kind === 'run') row.open?.()
  }
  useInput((_input, key) => {
    if (key.escape) session.openExperiment(undefined)
    else if (key.upArrow) step(-1)
    else if (key.downArrow) step(1)
    else if (key.return) activate(rows[cursor.current()])
  })
  const running = runs.filter((run) => run.experiment === shown.name && run.state.step === 'running').length
  const items = rows.map(runsRowItem)
  return (
    <>
      <PanelTitle
        name={COMMAND}
        parts={[shown.name, plural(shown.caseCount, 'case'), ...(running > 0 ? [`${running} running`] : [])]}
      />
      <Gap />
      <ItemList
        items={items}
        selected={index}
        capacity={Math.max(1, height - RUNS_CHROME_ROWS)}
        labelWidth={labelWidthFor(
          items.map(({ label }) => label),
          width
        )}
        onClick={(at) => {
          if (!opensRow(rows[at])) return
          cursor.set(at)
          activate(rows[at])
        }}
      />
      <Fill />
      <KeyHints
        hints={[
          '↑↓',
          rows[index]?.kind === 'new' ? 'Enter set up a run' : 'Enter open the run',
          ...browserHints(browser),
          'Esc back to the experiments',
        ]}
      />
    </>
  )
}

const runsSection = (
  runs: readonly OptimizeRun[],
  pastRuns: PastRuns | undefined,
  session: OptimizeSession
): PickerSection => {
  const past = pastRunsOf(runs, pastRuns)
  const running = runs.filter(({ state }) => state.step === 'running').length
  const count = runs.length + past.length
  return {
    title: count > 0 ? `runs (${count})` : 'runs',
    ...(running > 0 ? { status: `${running} running` } : {}),
    items: [
      ...runs.map(({ id, experiment, startedAt, state }) => {
        const { text, tone } = runSummary(state)
        return { key: id, label: experiment, detail: `${startedText(startedAt)}${text}`, ...(tone ? { tone } : {}) }
      }),
      ...past.map((run) => ({
        key: run.record,
        label: run.experiment,
        detail: `${startedText(run.startedAt)}${run.summary}`,
        disabled: !run.opens,
      })),
    ],
    ...runsNote(runs, pastRuns),
    onChoose: (index): void => {
      const run = runs[index]
      if (run) return session.openRun(run.id)
      const pastRun = past[index - runs.length]
      if (pastRun?.opens) session.openPastRun(pastRun.record)
    },
  }
}

const knobItem = (knob: OptimizePlan['knobs'][number]): ListItem => {
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

type SetupButton = 'start' | 'cancel'

const SETUP_BUTTONS: readonly SetupButton[] = ['start', 'cancel']

interface SetupSlider {
  readonly key: string
  readonly label: string
  readonly count: number
  readonly position: number
  readonly detail: string
  readonly right?: string
  readonly hint: string
  readonly editable?: boolean
  readonly move: (step: 1 | -1) => void
}

type ObjectiveField = keyof OptimizeObjective

type SetupRow =
  | { readonly kind: 'knob'; readonly knob: Knob }
  | { readonly kind: 'slider'; readonly slider: SetupSlider }
  | { readonly kind: 'constraints' }
  | { readonly kind: 'advanced' }
  | { readonly kind: 'button'; readonly button: SetupButton }

interface ObjectiveEditor {
  readonly field: ObjectiveField
  readonly value: TextValue
}

const splitText = ({ train, validation, test }: CaseSplit): string =>
  `${train} train / ${validation} validation / ${test} test`

const splitPosition = ({ split, splitChoices }: OptimizePlan): number =>
  splitChoices.findIndex((choice) => sameCaseSplit(choice, split))

const presetPosition = ({ objective, objectivePresets }: OptimizePlan): number =>
  objectivePresets.findIndex((preset) => sameObjective(preset.objective, objective))

const objectiveSlider = (plan: OptimizePlan, session: OptimizeSession, latest: () => OptimizePlan): SetupSlider => {
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

const setupSliders = (plan: OptimizePlan, session: OptimizeSession, latest: () => OptimizePlan): SetupSlider[] => [
  objectiveSlider(plan, session, latest),
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
    key: 'runs',
    label: 'runs',
    choices: plan.repetitionChoices,
    value: plan.repetitions,
    detail: `${plural(plan.repetitions, 'run')} of each case per candidate`,
    hint: '←→ runs',
    pick: (value) => session.setRepetitions(value),
    latest: () => latest().repetitions,
  }),
  {
    key: 'budget',
    label: 'budget',
    count: plan.iterationChoices.length,
    position: Math.max(0, plan.iterationChoices.indexOf(plan.iterations)),
    detail: `${plural(plan.iterations, 'step')} × ${plan.width} candidates`,
    right: `~${plan.rollouts} rollouts · ${judgeCallsText(plan.judgeCalls, '~')}`,
    hint: '←→ budget',
    move: (step): void => {
      const current = latest()
      const next = current.iterationChoices[current.iterationChoices.indexOf(current.iterations) + step]
      if (next !== undefined) session.setIterations(next)
    },
  },
  choiceSlider({
    key: 'candidates',
    label: 'per step',
    choices: plan.widthChoices,
    value: plan.width,
    detail: `${plural(plan.width, 'candidate')} in each step`,
    hint: '←→ candidates',
    pick: (value) => session.setWidth(value),
    latest: () => latest().width,
  }),
]

const advancedSliders = (plan: OptimizePlan, session: OptimizeSession, latest: () => OptimizePlan): SetupSlider[] => [
  choiceSlider({
    key: 'workers',
    label: 'parallel',
    choices: plan.workerChoices,
    value: plan.workers,
    detail: `${plural(plan.workers, 'trial')} at once`,
    hint: '←→ parallel trials',
    pick: (value) => session.setWorkers(value),
    latest: () => latest().workers,
  }),
]

const choiceSlider = ({
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
  readonly choices: readonly number[]
  readonly value: number
  readonly detail: string
  readonly hint: string
  readonly pick: (value: number) => void
  readonly latest: () => number
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

const startHint = (plan: OptimizePlan, ready: boolean): string => {
  if (ready) return 'Enter start'
  if (plan.objectiveProblem) return 'fix the objective to start'
  return plan.budgetProblem ? 'lower the budget to start' : 'check a knob to start'
}

const setupHints = (focused: SetupRow | undefined, plan: OptimizePlan, ready: boolean): string[] => {
  if (focused?.kind === 'slider') return ['↑↓', focused.slider.hint, 'Esc cancel']
  if (focused?.kind === 'constraints') return ['↑↓', 'Enter edit', 'Esc cancel']
  if (focused?.kind === 'advanced') return ['↑↓', 'Enter show or hide', 'Esc cancel']
  if (focused?.kind === 'button')
    return focused.button === 'start'
      ? ['↑↓', startHint(plan, ready), 'Esc cancel']
      : ['↑↓', 'Enter cancel', 'Esc cancel']
  const action = focused?.knob.unavailable
    ? 'not available'
    : focused?.knob.kind === 'models'
      ? 'Enter choose models'
      : 'Enter toggle'
  return ['↑↓', action, 'Esc cancel']
}

const hasChoice = ({ count }: SetupSlider): boolean => count > 1

const isSelectable = (slider: SetupSlider): boolean => slider.editable === true || hasChoice(slider)

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
      justifyContent="space-between"
      overflow="hidden"
      {...(active ? { backgroundColor: selection } : {})}
      {...(clicks && onPoint ? { ref: clicks.target(onPoint, onPoint) } : {})}
    >
      <Box flexShrink={1} overflow="hidden">
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
      {slider.right ? (
        <Box flexShrink={0} marginLeft={2}>
          <Text dimColor>{slider.right}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

const SETUP_CHROME_ROWS = 12
const SETUP_EXTRA_ROWS = 3
const MODEL_CHOOSER_CHROME_ROWS = 5
const MODEL_FILTER = /^[\w.:/-]$/u

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

const PROPOSER_RISK =
  'The commands get your environment, your credentials, and your network. This is not a sandbox, and text in the ' +
  'cases can carry prompt injection. To protect your credentials, run strands dev in a container or VM that has ' +
  'only the credentials that the run needs.'

const PROPOSER_MODEL =
  "The proposer is the optimizer's own AWS Bedrock model. It uses the AWS credentials and region of the shell " +
  'that started strands dev, not the chat provider.'

const tunedKnobs = ({ knobs }: OptimizePlan): Knob[] => knobs.filter((knob) => knob.enabled && !knob.unavailable)

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

const paidOptimization = (plan: OptimizePlan, agent: RunAgent | undefined, start: () => void): PaidRun => {
  const knobs = tunedKnobs(plan)
  const texts = textKnobs(knobs)
  const { train, validation, test } = plan.split
  return {
    title: [plan.experiment.name],
    facts: [
      `The optimizer tunes the ${listed(knobs.map(({ label }) => label))} of your agent on ${train} train, ` +
        `${validation} validation, and ${plural(test, 'test case')} of ${plan.experiment.name}.`,
      `It tries ${plural(plan.iterations, 'step')} of ${plural(plan.width, 'candidate')}` +
        `${plan.repetitions > 1 ? `, with each case run ${plan.repetitions} times` : ''}: about ${plan.rollouts} ` +
        `rollouts of your agent with ${triedModels(plan, knobs, agent)}, and ${judgeCallsText(plan.judgeCalls, 'about ')}. ` +
        `${plural(plan.workers, 'trial')} run at once.`,
      usageSentence(plan.usage),
      ...(texts.length > 0 ? [PROPOSER_MODEL] : []),
    ],
    warnings: [...proposerWarnings(texts), ...fileToolWarnings(agent)],
    start,
  }
}

const objectiveNotice = (plan: OptimizePlan): { readonly tone: Tone; readonly text: string } | undefined => {
  if (plan.objectiveProblem) return { tone: 'error', text: plan.objectiveProblem }
  if (plan.budgetProblem) return { tone: 'error', text: plan.budgetProblem }
  if (plan.objectiveWarning) return { tone: 'warning', text: plan.objectiveWarning }
  const warning = plan.warning ?? smallSplitWarning(plan.split)
  return warning ? { tone: 'warning', text: warning } : undefined
}

const SetupView = ({ session, width, height, plan }: OptimizePanelProps & { plan: OptimizePlan }): ReactElement => {
  const latest = (): OptimizePlan => {
    const state = session.snapshot()
    return state.step === 'setup' ? state.plan : plan
  }
  const [advanced, setAdvanced] = useState(false)
  const sliders = setupSliders(plan, session, latest)
  const extras = advanced ? advancedSliders(plan, session, latest) : []
  const rows: SetupRow[] = [
    ...plan.knobs.map((knob) => ({ kind: 'knob' as const, knob })),
    ...sliders
      .filter(isSelectable)
      .flatMap((slider): SetupRow[] =>
        slider.key === 'objective'
          ? [{ kind: 'slider', slider }, { kind: 'constraints' }]
          : [{ kind: 'slider', slider }]
      ),
    { kind: 'advanced' },
    ...extras.filter(isSelectable).map((slider) => ({ kind: 'slider' as const, slider })),
    ...SETUP_BUTTONS.map((button) => ({ kind: 'button' as const, button })),
  ]
  const advancedRow = rows.findIndex((row) => row.kind === 'advanced')
  const rowOf = (match: (row: SetupRow) => boolean): number => rows.findIndex(match)
  const firstSlider = plan.knobs.length
  const firstButton = rowOf((row) => row.kind === 'button')
  const constraintsRow = rowOf((row) => row.kind === 'constraints')
  const cursor = useCursor(rows.length)
  const editing = useSyncedState<ObjectiveEditor | undefined>(undefined)
  const [choosingModels, setChoosingModels] = useState(false)
  const confirm = usePaidRunConfirm()
  const ready =
    plan.knobs.some((knob) => knob.enabled && !knob.unavailable) && !plan.objectiveProblem && !plan.budgetProblem
  const compact = height < FULL_SETUP_ROWS
  const focused = rows[cursor.index]
  const editor = editing.value
  const notice = objectiveNotice(plan)
  const cancel = (): void => session.reset()
  const edit = (field: ObjectiveField): void => editing.set({ field, value: textValue(latest().objective[field]) })
  const save = ({ field, value }: ObjectiveEditor): void => {
    session.setObjective({ ...latest().objective, [field]: value.input })
    editing.set(undefined)
  }
  const activate = (row: SetupRow | undefined): void => {
    if (row?.kind === 'button') {
      if (row.button === 'cancel') cancel()
      else if (ready) confirm.ask(paidOptimization(latest(), session.agent?.(), () => session.start()))
    } else if (row?.kind === 'slider' && row.slider.editable) edit('expression')
    else if (row?.kind === 'constraints') edit('constraints')
    else if (row?.kind === 'advanced') setAdvanced((open) => !open)
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
        else editing.set((current) => current && { ...current, value: editText(current.value, input, key) })
        return
      }
      const row = rows[cursor.current()]
      if (key.escape) cancel()
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
  return (
    <>
      <PanelTitle name={COMMAND} parts={[plan.experiment.name, plural(plan.experiment.caseCount, 'case')]} />
      {compact ? null : <Line>{'  knobs'}</Line>}
      <ItemList
        items={plan.knobs.map(knobItem)}
        selected={cursor.index < firstSlider ? cursor.index : -1}
        capacity={Math.max(
          3,
          Math.min(plan.knobs.length, height - SETUP_CHROME_ROWS - SETUP_EXTRA_ROWS - extras.length)
        )}
        labelWidth={labelWidthFor(
          plan.knobs.map(({ label }) => label),
          width
        )}
        onClick={choose}
        onHover={cursor.set}
      />
      {compact ? null : <Gap />}
      {sliders.map((slider) => {
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
      })}
      <FieldRow
        label="advanced"
        value={advanced ? 'hide' : `${plural(plan.workers, 'parallel trial')}`}
        active={cursor.index === advancedRow}
        onPoint={() => cursor.set(advancedRow)}
      />
      {extras.map((slider) => {
        const row = rowOf((entry) => entry.kind === 'slider' && entry.slider.key === slider.key)
        return (
          <SliderRow key={slider.key} slider={slider} active={cursor.index === row} onPoint={() => cursor.set(row)} />
        )
      })}
      {editor ? <Line tone="muted">{`  metrics: ${plan.metrics.join(', ')}`}</Line> : null}
      {compact || editor ? null : (
        <Line tone="muted">
          {`${' '.repeat(SLIDER_LABEL_WIDTH + 2)}Train cases guide the search. Validation picks the winner. Test checks it.`}
        </Line>
      )}
      {notice ? <Line tone={notice.tone}>{`  ${notice.text}`}</Line> : compact ? null : <Gap />}
      <SetupButtons
        ready={ready}
        estimate={usageShort(plan.usage)}
        focused={focused?.kind === 'button' ? focused.button : undefined}
        onChoose={(button) => choose(firstButton + SETUP_BUTTONS.indexOf(button))}
        onHover={(button) => cursor.set(firstButton + SETUP_BUTTONS.indexOf(button))}
      />
      <Fill />
      <KeyHints hints={editor ? ['Enter save', 'Esc cancel'] : setupHints(focused, plan, ready)} />
    </>
  )
}

const SetupButtons = ({
  ready,
  estimate,
  focused,
  onChoose,
  onHover,
}: {
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
      {button('start', <Text {...(ready ? { color: accent, bold: true } : { dimColor: true })}>{'[ Start ]'}</Text>)}
      {button('cancel', <Text bold={focused === 'cancel'}>Cancel</Text>)}
      <Box flexGrow={1} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <Text dimColor wrap="truncate-end">
          {estimate}
        </Text>
      </Box>
    </Box>
  )
}

const candidateLabel = ({ number, step }: CandidateResult): string =>
  number === 0 ? 'your agent' : `${step === undefined ? 'final' : `step ${step}`} · ${number}`

const scoringText = ({ done, total, score }: ScoringProgress, measure: ObjectiveMeasure | undefined): string =>
  `scoring ${done}/${total}${score === undefined ? '' : ` · ${formatObjective(score, measure)} so far`}`

const candidateItem = (candidate: CandidateResult, measure?: ObjectiveMeasure): ListItem => {
  const where = candidate.step === undefined ? 'final' : `step ${candidate.step}`
  if (candidate.number === 0)
    return {
      key: 'baseline',
      label: candidateLabel(candidate),
      detail: candidate.scoring
        ? scoringText(candidate.scoring, measure)
        : `baseline ${candidate.score === undefined ? 'not measured' : formatObjective(candidate.score, measure)}`,
      mark: { text: '●', tone: 'muted' },
      tone: 'muted',
    }
  if (candidate.scoring)
    return {
      key: String(candidate.number),
      label: candidateLabel(candidate),
      detail: `${scoringText(candidate.scoring, measure)} · ${candidate.summary}`,
      mark: { text: '◐', tone: 'warning' },
    }
  if (candidate.failed)
    return {
      key: String(candidate.number),
      label: `${where} · ${candidate.number}`,
      detail: `failed  ${candidate.failed}`,
      mark: { text: '✗', tone: 'error' },
      tone: 'error',
    }
  const delta = candidate.delta === undefined ? '' : `  ${formatObjectiveChange(candidate.delta, measure)}`
  return {
    key: String(candidate.number),
    label: `${where} · ${candidate.number}`,
    detail: `${candidate.kept ? 'kept    ' : 'not kept'}  ${candidate.summary}${delta}`,
    mark: candidate.kept ? { text: '✓', tone: 'success' } : { text: '·', tone: 'muted' },
    ...(candidate.kept ? {} : { tone: 'muted' as const }),
  }
}

const trialsText = ({ done, total }: TrialProgress): string => `${done} of ${plural(total, 'trial')}`

const scoreLabel = (value: number, measure: ObjectiveMeasure | undefined): string =>
  measure?.kind === 'metric' && measure.usage
    ? formatObjective(value, measure)
    : `score ${formatObjective(value, measure)}`

const trialsSummary = ({ scoring, score }: CandidateResult, measure: ObjectiveMeasure | undefined): string => {
  if (scoring) return scoring.score === undefined ? 'no score yet' : `${scoreLabel(scoring.score, measure)} so far`
  return score === undefined ? 'not measured' : scoreLabel(score, measure)
}

const finalistsText = (versions: number): string => {
  const finalists = versions - 1
  if (finalists === 0) return 'your agent'
  return `${finalists === 1 ? 'the best candidate' : `the best ${finalists} candidates`} and your agent`
}

const stepText = (step: OptimizeStep, iterations: number): string => {
  switch (step.kind) {
    case 'baseline':
      return `measuring your agent on the train cases · ${trialsText(step.trials)}`
    case 'proposing':
      return `step ${step.iteration} of ${iterations} · the proposer is writing new candidates from the scored conversations`
    case 'scoring':
      return `step ${step.iteration} of ${iterations} · scoring ${plural(step.versions, 'candidate')} on the train cases · ${trialsText(step.trials)}`
    case 'validating':
      return step.versions > 0
        ? `measuring ${finalistsText(step.versions)} on the validation cases · ${trialsText(step.trials)}`
        : 'picking the best candidates for the validation cases'
    case 'testing':
      return step.versions > 1
        ? `checking the winner against your agent on the test cases · ${trialsText(step.trials)}`
        : `no candidate beat your agent · checking your agent on the test cases · ${trialsText(step.trials)}`
  }
}

const scaleText = (measure: ObjectiveMeasure | undefined): string => {
  if (measure?.kind === 'combined') return ', the value of the objective, higher is better'
  if (measure?.kind === 'metric' && measure.usage) return ''
  return measure?.kind === 'metric' && measure.lower ? ', lower is better' : ', from 0 to 1'
}

const scoreText = (
  { score, delta, scoring }: CandidateResult,
  trainCases: number | undefined,
  measure?: ObjectiveMeasure
): string => {
  if (scoring)
    return scoring.score === undefined
      ? `0 of ${plural(scoring.total, 'training case')} finished so far`
      : `${formatObjective(scoring.score, measure)} so far, on ${scoring.done} of ${scoring.total} training cases`
  if (score === undefined) return 'not measured'
  const cases = trainCases === undefined ? 'the training cases' : plural(trainCases, 'training case')
  const change = delta === undefined ? '' : ` · ${formatObjectiveChange(delta, measure)} vs your agent`
  return `${formatObjective(score, measure)} average on ${cases}${scaleText(measure)}${change}`
}

const RunningView = ({
  session,
  browser,
  width,
  height,
  progress,
}: OptimizePanelProps & { progress: OptimizeProgress }): ReactElement => {
  const [selected, setSelected] = useState(0)
  const opened = useSyncedState<number | undefined>(undefined)
  const elapsed = useElapsed(progress.startedAt)
  const candidates = [
    ...[...progress.candidates].reverse(),
    ...(progress.baselineCandidate ? [progress.baselineCandidate] : []),
  ]
  const index = Math.min(selected, Math.max(0, candidates.length - 1))
  const current = candidates[index]
  const finished = measuredVersions(progress)
  const open = candidates.find(({ number }) => number === opened.value)
  const detailRows = 2 + Number(Boolean(current?.rationale))
  useInput((input, key) => {
    if (opened.current() !== undefined && open) return
    if (key.escape) session.reset()
    else if (key.upArrow) setSelected(Math.max(0, index - 1))
    else if (key.downArrow) setSelected(Math.min(candidates.length - 1, index + 1))
    else if ((key.return || key.rightArrow) && current) opened.set(current.number)
    else if (shortcut(input, key) === 'x' && !progress.stopping) session.stop()
  })
  if (open)
    return (
      <CaseReport
        command={COMMAND}
        context={[`run ${progress.run}`, candidateLabel(open)]}
        details={open.scoring ? [`${open.scoring.done}/${open.scoring.total} train cases`] : []}
        cases={open.trials ?? []}
        expected={Math.max(open.scoring?.total ?? 0, open.trials?.length ?? 0)}
        summary={trialsSummary(open, progress.measure)}
        backHint="Esc back to the run"
        width={width}
        height={height}
        onBack={() => opened.set(undefined)}
      />
    )
  const best = progress.best
  const summary = [
    progress.baseline === undefined
      ? 'measuring the baseline'
      : `baseline ${formatObjective(progress.baseline, progress.measure)}`,
    ...(best && progress.baseline !== undefined
      ? [
          `best ${formatObjective(best.score, progress.measure)} (${formatObjectiveChange(best.score - progress.baseline, progress.measure)})`,
        ]
      : []),
    progress.metric,
  ]
  return (
    <>
      <PanelTitle
        name={COMMAND}
        parts={[`run ${progress.run}`, ...(progress.stopping ? ['stopping'] : [])]}
        right={
          <Text>
            <ProgressBar done={finished} total={progress.planned} />
            <Text dimColor>{' candidates'}</Text>
          </Text>
        }
      />
      <SplitLine
        left={<Text>{`  ${summary.join('   ')}`}</Text>}
        right={<Text dimColor>{formatSeconds(elapsed)}</Text>}
      />
      {progress.step ? <Line tone="muted">{`  ${stepText(progress.step, progress.iterations)}`}</Line> : null}
      {candidates.length > 0 ? (
        <ItemList
          items={candidates.map((candidate) => candidateItem(candidate, progress.measure))}
          selected={index}
          capacity={Math.max(1, height - RUNNING_CHROME_ROWS - Number(Boolean(progress.step)) - detailRows)}
          labelWidth={labelWidthFor(
            candidates.map((candidate) => candidateItem(candidate, progress.measure).label),
            width
          )}
        />
      ) : (
        <Line tone="muted">{'  Starting the optimizer. Your agent shows here when its first case runs.'}</Line>
      )}
      <Rule width={width} />
      {current ? (
        <>
          <Field label="  change" value={current.summary} labelWidth={10} />
          {current.rationale ? <Field label="  why" value={current.rationale} labelWidth={10} /> : null}
          <Field label="  score" value={scoreText(current, progress.trainCases, progress.measure)} labelWidth={10} />
        </>
      ) : (
        <Gap rows={2} />
      )}
      <Fill />
      <KeyHints
        hints={[
          '↑↓',
          ...(current ? ['Enter open trials'] : []),
          progress.stopping ? 'stopping, the best so far is kept' : 'x stop and keep best',
          ...browserHints(browser),
          'Esc back to the list, the run goes on',
        ]}
      />
    </>
  )
}

const diffCounts = (lines: readonly ChatDiffLine[]): string => {
  const added = lines.filter((line) => line.kind === 'add').length
  const removed = lines.filter((line) => line.kind === 'remove').length
  return `+${added} −${removed}`
}

const editItem = (edit: ProposedEdit, lines: readonly ChatDiffLine[]): ListItem => {
  const where = edit.target ?? 'source not found'
  const change = edit.kind === 'text' ? diffCounts(lines) : `${oneLine(edit.before)} → ${oneLine(edit.after)}`
  if (edit.unavailable)
    return {
      key: edit.knob,
      label: edit.label,
      detail: `${change}  ${edit.unavailable}`,
      mark: { text: '☐', tone: 'muted' },
      tone: 'warning',
    }
  return {
    key: edit.knob,
    label: edit.label,
    detail: `${where}  ${change}`,
    mark: edit.accepted ? { text: '☑', tone: 'success' } : { text: '☐', tone: 'muted' },
  }
}

interface DiffRow {
  readonly kind: ChatDiffLine['kind']
  readonly text: string
}

const DIFF_MARKERS = { header: '', context: ' ', add: '+', remove: '-' } as const

const splitToWidth = (text: string, room: number): string[] => {
  const rows: string[] = []
  let current = ''
  let used = 0
  for (const character of text) {
    const size = stringWidth(character)
    if (used + size > room && current) {
      rows.push(current)
      current = ''
      used = 0
    }
    current += character
    used += size
  }
  rows.push(current)
  return rows
}

export const wrapDiff = (lines: readonly ChatDiffLine[], width: number): DiffRow[] => {
  const room = Math.max(1, width - DIFF_INDENT - 1)
  return lines.flatMap(({ kind, text }) =>
    splitToWidth(oneLine(text), room).map((part, index) => ({
      kind,
      text: `${index === 0 ? DIFF_MARKERS[kind] : ' '}${part}`,
    }))
  )
}

const DiffLines = ({
  rows,
  height,
  offset,
}: {
  rows: readonly DiffRow[]
  height: number
  offset: number
}): ReactElement => {
  const { success, error, accent } = useTheme()
  const more = rows.length > height
  const room = Math.max(1, height - (more ? 1 : 0))
  const visible = rows.slice(offset, offset + room)
  return (
    <Box flexDirection="column" flexShrink={0} height={Math.max(1, height)} overflow="hidden">
      {visible.map((row, index) => (
        <Box key={`${offset + index}:${row.kind}`} height={1} overflow="hidden">
          <Text
            wrap="truncate-end"
            {...(row.kind === 'add'
              ? { color: success }
              : row.kind === 'remove'
                ? { color: error }
                : row.kind === 'header'
                  ? { color: accent }
                  : {})}
          >
            {`  ${row.text}`}
          </Text>
        </Box>
      ))}
      {more ? (
        <Line tone="muted">{`  lines ${offset + 1}-${offset + visible.length} of ${rows.length} · ↑↓ scroll`}</Line>
      ) : null}
    </Box>
  )
}

const CHECK_LABEL = '  test check'
const CHECK_LABEL_WIDTH = 14

const checkVerdict = ({ range, cases }: TestCheck): string => {
  if (!range)
    return cases === 1 ? 'One test case is too few for a confidence range.' : 'The optimizer gave no confidence range.'
  if (range[0] > 0) return 'The whole range is above 0, so the gain is likely real.'
  if (range[1] < 0) return 'The whole range is below 0, so the change likely makes the agent worse.'
  return 'The range includes 0, so the gain may be luck. More test cases make the range narrower.'
}

const checkLines = (check: TestCheck, measure: ObjectiveMeasure | undefined): readonly [string, string] => {
  const gain = `${formatObjectiveChange(check.difference, measure)} on ${plural(check.cases, 'unseen test case')}`
  const range = check.range
    ? ` · ${Math.round(check.confidence * 100)}% confidence range ${formatObjectiveChange(check.range[0], measure)} to ${formatObjectiveChange(check.range[1], measure)}`
    : ''
  return [`${gain}${range}`, checkVerdict(check)]
}

interface CheckRow {
  readonly text: string
  readonly muted: boolean
}

const testCheckRows = (review: OptimizeReview, width: number): CheckRow[] => {
  const room = Math.max(1, width - CHECK_LABEL_WIDTH)
  const wrapped = (text: string, muted: boolean): CheckRow[] =>
    wrapWords(text, room).map((part) => ({ text: part, muted }))
  if (!review.testCheck) return wrapped('No test cases were left to check the winner on unseen cases.', true)
  const [result, verdict] = checkLines(review.testCheck, review.measure)
  return [...wrapped(result, false), ...wrapped(verdict, true)]
}

const TestCheckLines = ({ rows }: { rows: readonly CheckRow[] }): ReactElement => (
  <>
    {rows.map((row, index) => (
      <Field
        key={index}
        label={index === 0 ? CHECK_LABEL : ''}
        value={row.text}
        labelWidth={CHECK_LABEL_WIDTH}
        {...(row.muted ? { tone: 'muted' as const } : {})}
      />
    ))}
  </>
)

const ReviewView = ({
  session,
  browser,
  width,
  height,
  review,
}: OptimizePanelProps & { review: OptimizeReview }): ReactElement => {
  const cursor = useCursor(review.edits.length)
  const diffs = useMemo(
    () => review.edits.map((edit) => createDiffPreview(edit.label, edit.before, edit.after, DIFF_CONTEXT_LINES).lines),
    [review.edits]
  )
  const scroll = useSyncedState(0)
  const { copyText, clipboardNotice } = useClipboard()
  const index = cursor.index
  const focused = review.edits[index]
  const accepted = review.edits.filter((edit) => edit.accepted && !edit.unavailable).length
  const applied = review.applied !== undefined
  const notice = clipboardNotice
    ? clipboardNoticeText(clipboardNotice)
    : focused?.unavailable && !applied
      ? `${focused.unavailable} Press c to copy the new text, and a to check the file again.`
      : undefined
  const noticeRows = notice ? wrapWords(notice, Math.max(1, width - NOTICE_INDENT)).slice(0, MAX_NOTICE_ROWS) : []
  const listRows = Math.min(review.edits.length, MAX_EDIT_ROWS)
  const checkRows = useMemo(() => testCheckRows(review, width), [review, width])
  const diffHeight = Math.max(1, height - REVIEW_CHROME_ROWS - checkRows.length - listRows - noticeRows.length)
  const rows = useMemo(() => wrapDiff(diffs[index] ?? [], width), [diffs, index, width])
  const page = Math.max(1, diffHeight - 1)
  const lastOffset = Math.max(0, rows.length - page)
  const scrolls = rows.length > diffHeight
  const choose = (step: number): void => {
    cursor.move(step)
    scroll.set(0)
  }
  const pick = (at: number): void => {
    cursor.set(at)
    scroll.set(0)
  }
  const scrollBy = (step: number): void =>
    scroll.set((offset: number) => Math.max(0, Math.min(lastOffset, Math.min(offset, lastOffset) + step)))
  const leave = (): void => session.reset()
  const acceptedNow = (): number => {
    const state = session.snapshot()
    return state.step === 'review' ? state.review.edits.filter((edit) => edit.accepted && !edit.unavailable).length : 0
  }
  useInput((input, key) => {
    const typed = shortcut(input, key)
    if (key.escape) leave()
    else if (applied) return
    else if (key.leftArrow) choose(-1)
    else if (key.rightArrow) choose(1)
    else if (key.upArrow) scrollBy(-1)
    else if (key.downArrow) scrollBy(1)
    else if (key.pageUp) scrollBy(-page)
    else if (key.pageDown) scrollBy(page)
    else if (typed === 'a' || typed === 'x') {
      const at = cursor.current()
      const edit = review.edits[at]
      if (edit && (typed === 'a' || !edit.unavailable)) session.accept(at, typed === 'a')
    } else if (typed === 'c') {
      const edit = review.edits[cursor.current()]
      if (edit) copyText(edit.after)
    } else if (key.return && acceptedNow() > 0) session.apply()
  })
  const gain = `${formatObjective(review.baseline, review.measure)} → ${formatObjective(review.best, review.measure)} on ${review.measuredOn} (${formatObjectiveChange(review.best - review.baseline, review.measure)})`
  const title = (
    <PanelTitle
      name="review"
      parts={
        review.edits.length === 0
          ? [
              `run ${review.run}`,
              `best stayed at ${formatObjective(review.baseline, review.measure)} on ${review.measuredOn}`,
            ]
          : [
              `run ${review.run}`,
              gain,
              applied ? 'applied' : `${accepted} of ${plural(review.edits.length, 'edit')} accepted`,
            ]
      }
      right={review.edits.length > 0 ? <Text dimColor>{`${index + 1}/${review.edits.length}`}</Text> : undefined}
    />
  )
  if (review.edits.length === 0)
    return (
      <>
        {title}
        <Gap />
        <Line>{'  No candidate beat your current agent, so there is nothing to change.'}</Line>
        <Line tone="muted">{`  Record: ${review.record}`}</Line>
        <Fill />
        <KeyHints hints={[BACK_HINT]} />
      </>
    )
  if (applied) {
    const changed = review.applied ?? []
    return (
      <>
        {title}
        <Gap />
        {changed.length > 0 ? (
          <Line tone="success">{`  Applied ${plural(changed.length, 'edit')}: ${changed.join(', ')}`}</Line>
        ) : null}
        {review.applyError ? <Line tone="error">{`  ${review.applyError}`}</Line> : null}
        {changed.length > 0 ? (
          <Line>{'  Your agent reloads when its files change. Run /test to check the new version.'}</Line>
        ) : null}
        <Fill />
        <KeyHints hints={[BACK_HINT]} />
      </>
    )
  }
  const items = review.edits.map((edit, position) => editItem(edit, diffs[position] ?? []))
  return (
    <>
      {title}
      <TestCheckLines rows={checkRows} />
      <ItemList
        items={items}
        selected={index}
        capacity={listRows}
        labelWidth={labelWidthFor(
          review.edits.map(({ label }) => label),
          width
        )}
        onClick={pick}
      />
      <Rule width={width} />
      <DiffLines rows={rows} height={diffHeight} offset={Math.min(scroll.value, lastOffset)} />
      <Fill />
      {noticeRows.map((row) => (
        <Line key={row} tone={clipboardNotice?.status === 'success' ? 'muted' : 'warning'}>{`  ${row}`}</Line>
      ))}
      <KeyHints
        hints={[
          ...(review.edits.length > 1 ? ['←→ edit'] : []),
          ...(scrolls ? ['↑↓ scroll'] : []),
          ...(focused?.unavailable ? ['c copy the new text', 'a check again'] : ['a accept', 'x reject']),
          accepted > 0 ? 'Enter apply accepted' : 'accept an edit to apply',
          ...browserHints(browser),
          BACK_HINT,
        ]}
      />
    </>
  )
}
