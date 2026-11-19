import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import { useInput } from 'ink'
import stringWidth from 'string-width'

import { createDiffPreview } from '../../agent/file-changes.js'
import { wrapWords } from '../../terminal/text.js'
import type { ChatDiffLine } from '../../agent/types.js'
import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { Box, Text, useTheme } from '../../ui/theme.js'
import { clipboardNoticeText, useClipboard } from '../../ui/clipboard.js'
import { BROWSER_KEY, browserHints, BrowserView, useBrowserNotice } from './browser.js'
import { ExperimentPicker, type PickerSection } from './picker.js'
import { SetupView } from './optimize-setup.js'
import { CaseReport } from './report.js'
import {
  formatObjective,
  formatObjectiveChange,
  measuredVersions,
  type ObjectiveMeasure,
  type CandidateResult,
  type ExperimentSummary,
  type OptimizeProgress,
  type OptimizeStep,
  type ScoringProgress,
  type TrialProgress,
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
  type TestCheck,
} from './model.js'
import {
  Field,
  formatSeconds,
  Fill,
  Gap,
  ItemList,
  KeyHints,
  labelWidthFor,
  Line,
  oneLine,
  PanelTitle,
  plural,
  ProgressBar,
  Rule,
  shortcut,
  SplitLine,
  StoppedView,
  useCursor,
  useElapsed,
  useSyncedState,
  type ListItem,
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
const DIFF_CONTEXT_LINES = 2
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
          <Line>{'  Your agent reloads when its files change. Run /evaluate to check the new version.'}</Line>
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
