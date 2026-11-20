import { useState, useSyncExternalStore, type ReactElement } from 'react'
import { useInput } from 'ink'

import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { useSpinner } from '../../ui/animation.js'
import {
  isGenerating,
  type EvalsBrowser,
  type ExperimentRun,
  type ExperimentsState,
  type ExperimentSummary,
  type Generation,
  type RunAgent,
  type TestResults,
  type TestRun,
  type TestSession,
  type TestState,
} from './model.js'
import {
  agentModel,
  awsBedrockFact,
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
  shortcut,
  StoppedView,
  useCursor,
  useElapsed,
  usePaidRunConfirm,
  useSyncedState,
  type ListItem,
  type PaidRun,
  type Tone,
} from './ui.js'
import { BrowserView, useBrowserNotice } from './browser.js'
import { CaseReport } from './report.js'

export interface TestPanelProps extends DevChatPanelProps {
  readonly session: TestSession
  readonly browser?: EvalsBrowser
  readonly initialRun?: string
}

const COMMAND = 'evaluate'
const LIST_CHROME_ROWS = 3

type TestRow =
  | { readonly kind: 'experiment'; readonly experiment: ExperimentSummary; readonly run?: TestRun }
  | { readonly kind: 'waiting'; readonly generation: Generation }
  | { readonly kind: 'new' }

interface TestScope {
  readonly title: readonly string[]
  readonly cases: string
  readonly detail?: string
}

const experimentsScope = (experiments: readonly ExperimentSummary[]): TestScope => {
  const [only] = experiments
  if (only && experiments.length === 1)
    return { title: [only.name], cases: `the ${plural(only.caseCount, 'case')} of ${only.name}` }
  const total = experiments.reduce((sum, { caseCount }) => sum + caseCount, 0)
  return {
    title: [plural(experiments.length, 'experiment')],
    cases: `${plural(total, 'case')} from ${plural(experiments.length, 'experiment')}`,
    detail: `: ${listed(experiments.map(({ name, caseCount }) => `${name} ${caseCount}`))}`,
  }
}

const againScope = ({ name, caseCount }: ExperimentSummary, failed?: number): TestScope => ({
  title: [name],
  cases:
    failed === undefined
      ? `the ${plural(caseCount, 'case')} of ${name} again`
      : `the ${plural(failed, 'failed case')} of ${name} again`,
})

const paidTest = (
  { title, cases, detail = '' }: TestScope,
  agent: RunAgent | undefined,
  start: () => void
): PaidRun => ({
  title,
  facts: [
    `Your agent answers ${cases} with ${agentModel(agent)}${detail}.`,
    'Each answer makes paid model calls, and each evaluator that uses a judge model makes more.',
    awsBedrockFact('Judge calls'),
  ],
  warnings: fileToolWarnings(agent),
  start,
})

export const TestPanel = (props: TestPanelProps): ReactElement => {
  const { session } = props
  const tests = useSyncExternalStore(session.subscribe, session.snapshot)
  const experiments = useSyncExternalStore(session.experiments.subscribe, session.experiments.snapshot)
  const [open, setOpen] = useState<string | undefined>(props.initialRun)
  const browser = useBrowserNotice(props.browser)
  const confirm = usePaidRunConfirm()
  const shown = tests.runs.find(({ experiment }) => experiment.path === open)
  const back = (): void => setOpen(undefined)
  const ask = (scope: TestScope, start: () => void): void => confirm.ask(paidTest(scope, session.agent?.(), start))
  if (confirm.pending)
    return (
      <PaidRunView
        command={COMMAND}
        run={confirm.pending}
        width={props.width}
        height={props.height}
        backHint="Esc back"
        onAnswer={confirm.answer}
      />
    )
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
  if (shown?.run.status === 'running')
    return (
      <RunningView
        {...props}
        shown={shown}
        run={shown.run}
        onBack={back}
        onStop={() => session.stop(shown.experiment.path)}
      />
    )
  if (shown?.run.status === 'done')
    return (
      <ResultsView
        {...props}
        results={shown.run.results}
        experiment={shown.experiment.path}
        onBack={back}
        onRerun={() =>
          ask(againScope(shown.experiment, failedCases(shown.run)), () => session.rerunFailed(shown.experiment.path))
        }
        onRunAgain={() => ask(againScope(shown.experiment), () => session.run([shown.experiment]))}
      />
    )
  if (shown?.run.status === 'failed')
    return (
      <StoppedView
        {...props}
        command={`${COMMAND} · ${shown.experiment.name}`}
        message={shown.run.message}
        close={back}
        retry={() => ask(againScope(shown.experiment), () => session.run([shown.experiment]))}
      />
    )
  return <TestList {...props} tests={tests} experiments={experiments} onOpen={setOpen} />
}

export const testRows = ({ saved, generations }: ExperimentsState, { runs }: TestState): TestRow[] => [
  ...saved.map((experiment) => {
    const run = runs.find((entry) => entry.experiment.path === experiment.path)?.run
    return { kind: 'experiment' as const, experiment, ...(run ? { run } : {}) }
  }),
  ...generations
    .filter((generation) => generation.phase !== 'failed')
    .map((generation) => ({ kind: 'waiting' as const, generation })),
  { kind: 'new' },
]

const reportSummary = ({ seconds, overall, tokens, cases }: TestResults): string => {
  const checks = cases.reduce((total, result) => total + result.verdicts.length, 0)
  const used = tokens === undefined ? '' : ` · ${tokens.toLocaleString('en-US')} tokens`
  return `${formatSeconds(seconds)} · ${plural(checks, 'check')} · score ${overall.toFixed(2)}${used}`
}

const failedCases = (run: TestRun): number =>
  run.status === 'done' ? run.results.cases.filter(({ passed }) => !passed).length : 0

const runDetail = (experiment: ExperimentSummary, run: TestRun | undefined): { text: string; tone?: Tone } => {
  const cases = plural(experiment.caseCount, 'case')
  if (!run) return { text: `${cases} · not run yet`, tone: 'muted' }
  if (run.status === 'running') return { text: `${cases} · running ${run.done}/${run.cases}`, tone: 'warning' }
  if (run.status === 'failed') return { text: `${cases} · stopped: ${oneLine(run.message)}`, tone: 'error' }
  const passed = run.results.cases.filter((result) => result.passed).length
  const total = run.results.cases.length
  return { text: `${cases} · ${passed}/${total} passed`, tone: passed === total ? 'success' : 'warning' }
}

const rowItem = (row: TestRow, chosen: ReadonlySet<string>): ListItem => {
  if (row.kind === 'new')
    return {
      key: 'new',
      label: 'Manage experiments',
      detail: 'opens /experiment',
      mark: { text: '+' },
      tone: 'muted',
    }
  if (row.kind === 'waiting')
    return {
      key: row.generation.id,
      label: row.generation.name,
      detail: isGenerating(row.generation)
        ? `generating · ${row.generation.made + row.generation.failed}/${row.generation.total} cases`
        : 'waiting for review in /experiment',
      mark: { text: isGenerating(row.generation) ? '◐' : '●', tone: 'muted' },
      tone: 'muted',
    }
  const { text, tone } = runDetail(row.experiment, row.run)
  return {
    key: row.experiment.path,
    label: row.experiment.name,
    detail: text,
    mark: chosen.has(row.experiment.path) ? { text: '☑', tone: 'success' } : { text: '☐', tone: 'muted' },
    ...(tone ? { tone } : {}),
  }
}

const selectable = (row: TestRow | undefined): boolean => row !== undefined && row.kind !== 'waiting'

const OPEN_HINTS: Record<TestRun['status'], string> = {
  running: 'Enter show progress',
  done: 'Enter open report',
  failed: 'Enter show why it stopped',
}

const enterHint = (chosen: number, row: TestRow | undefined): string => {
  if (chosen > 0) return `Enter run ${chosen}`
  if (row?.kind === 'new') return 'Enter open /experiment'
  return row?.kind === 'experiment' && row.run ? OPEN_HINTS[row.run.status] : 'Enter run'
}

const TestList = ({
  session,
  tests,
  experiments,
  close,
  openCommand,
  width,
  height,
  onOpen,
}: TestPanelProps & {
  tests: TestState
  experiments: ExperimentsState
  onOpen: (path: string) => void
}): ReactElement => {
  const rows = testRows(experiments, tests)
  const chosen = useSyncedState<ReadonlySet<string>>(new Set())
  const cursor = useCursor(rows.length, Math.max(0, rows.findIndex(selectable)))
  const confirm = usePaidRunConfirm()
  const step = (direction: 1 | -1): void => {
    for (let index = cursor.current() + direction; index >= 0 && index < rows.length; index += direction) {
      if (selectable(rows[index])) {
        cursor.set(index)
        return
      }
    }
  }
  const ready = rows.flatMap((row) => (row.kind === 'experiment' ? [row.experiment] : []))
  const runTests = (picked: readonly ExperimentSummary[]): void =>
    confirm.ask(
      paidTest(experimentsScope(picked), session.agent?.(), () => {
        session.run(picked)
        chosen.set(new Set())
      })
    )
  const activate = (row: TestRow | undefined): void => {
    if (row?.kind === 'new') openCommand('experiment')
    else if (row?.kind === 'experiment' && row.run) onOpen(row.experiment.path)
    else if (row?.kind === 'experiment') runTests([row.experiment])
  }
  const click = (index: number): void => {
    if (!selectable(rows[index])) return
    cursor.set(index)
    activate(rows[index])
  }
  useInput((input, key) => {
    if (confirm.asking()) return
    const typed = shortcut(input, key)
    const row = rows[cursor.current()]
    if (key.escape) close()
    else if (key.upArrow) step(-1)
    else if (key.downArrow) step(1)
    else if (typed === ' ' && row?.kind === 'experiment')
      chosen.set((current) => {
        const next = new Set(current)
        if (!next.delete(row.experiment.path)) next.add(row.experiment.path)
        return next
      })
    else if (typed === 'a')
      chosen.set((current) => (current.size === ready.length ? new Set() : new Set(ready.map(({ path }) => path))))
    else if (key.rightArrow && row?.kind === 'experiment' && row.run) onOpen(row.experiment.path)
    else if (key.return) {
      const picked = ready.filter(({ path }) => chosen.current().has(path))
      if (picked.length > 0) runTests(picked)
      else activate(row)
    }
  })
  const running = tests.runs.filter(({ run }) => run.status === 'running').length
  const waiting = rows.some((row) => row.kind === 'waiting')
  const parts = experiments.loaded
    ? [
        plural(experiments.saved.length, 'experiment'),
        ...(running > 0 ? [`${running} running`] : []),
        ...(chosen.value.size > 0 ? [`${chosen.value.size} selected`] : []),
      ]
    : ['reading experiments']
  const current = rows[cursor.index]
  if (confirm.pending)
    return (
      <PaidRunView
        command={COMMAND}
        run={confirm.pending}
        width={width}
        height={height}
        backHint="Esc back to the list"
        onAnswer={confirm.answer}
      />
    )
  return (
    <>
      <PanelTitle name={COMMAND} parts={parts} />
      {experiments.error ? <Line tone="error">{`  ${experiments.error}`}</Line> : <Gap />}
      <ItemList
        items={rows.map((row) => rowItem(row, chosen.value))}
        selected={cursor.index}
        capacity={Math.max(1, height - LIST_CHROME_ROWS - Number(waiting))}
        labelWidth={labelWidthFor(
          rows.map((row) => rowItem(row, chosen.value).label),
          width
        )}
        onClick={click}
      />
      <Fill />
      {waiting ? (
        <Line tone="muted">{'  Grey experiments are still generating, or wait for review in /experiment.'}</Line>
      ) : null}
      <KeyHints hints={['Space select', 'a all', enterHint(chosen.value.size, current), 'Esc close']} />
    </>
  )
}

const RunningView = ({
  shown,
  run,
  onBack,
  onStop,
}: TestPanelProps & {
  shown: ExperimentRun
  run: Extract<TestRun, { status: 'running' }>
  onBack: () => void
  onStop: () => void
}): ReactElement => {
  const elapsed = useElapsed(run.startedAt)
  const spinner = useSpinner(true, true)
  useInput((input, key) => {
    if (key.escape) onBack()
    else if (input === 's') onStop()
  })
  const judging = run.done >= run.cases
  return (
    <>
      <PanelTitle
        name={COMMAND}
        parts={[
          shown.experiment.name,
          plural(run.cases, run.rerun ? 'failed case' : 'case'),
          plural(run.evaluators.length, 'evaluator'),
        ]}
        right={<ProgressBar done={run.done} total={run.cases} />}
      />
      <Line tone="muted">{`  ${formatSeconds(elapsed)}`}</Line>
      <Gap />
      <Line>
        {judging
          ? `  ${spinner} Every case has run. The evaluators are scoring the answers.`
          : `  ${spinner} Running your agent on each case. The evaluators score the answers at the end.`}
      </Line>
      <Fill />
      <KeyHints hints={['s stop the run', 'Esc back to the list', 'the run goes on']} />
    </>
  )
}

const ResultsView = ({
  width,
  height,
  results,
  onBack,
  onRerun,
  onRunAgain,
}: TestPanelProps & {
  results: TestResults
  experiment: string
  onBack: () => void
  onRerun: () => void
  onRunAgain: () => void
}): ReactElement => {
  const failed = results.cases.filter((result) => !result.passed).length
  return (
    <CaseReport
      command={COMMAND}
      context={[results.experiment]}
      details={[plural(results.cases.length, 'case'), plural(results.evaluators.length, 'evaluator')]}
      cases={results.cases}
      summary={reportSummary(results)}
      keys={[
        ...(failed > 0 ? [{ key: 'r', hint: 'r rerun failed', run: onRerun }] : []),
        { key: 'a', hint: 'a rerun all', run: onRunAgain },
      ]}
      backHint="Esc back to the list"
      width={width}
      height={height}
      onBack={onBack}
    />
  )
}
