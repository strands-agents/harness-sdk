import { useState, useSyncExternalStore, type ReactElement } from 'react'
import { useInput } from 'ink'

import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { useSpinner } from '../../ui/animation.js'
import { Text, useTheme } from '../../ui/theme.js'
import {
  isGenerating,
  type CaseResult,
  type ExperimentRun,
  type ExperimentsState,
  type ExperimentSummary,
  type Generation,
  type TestResults,
  type TestRun,
  type TestSession,
  type TestState,
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

export interface TestPanelProps extends DevChatPanelProps {
  readonly session: TestSession
}

const COMMAND = 'test'
const FIXED_ROWS = 4
const SCORE_COLUMN = 6
const LIST_CHROME_ROWS = 3

type TestRow =
  | { readonly kind: 'experiment'; readonly experiment: ExperimentSummary; readonly run?: TestRun }
  | { readonly kind: 'waiting'; readonly generation: Generation }
  | { readonly kind: 'new' }

export const TestPanel = (props: TestPanelProps): ReactElement => {
  const { session } = props
  const tests = useSyncExternalStore(session.subscribe, session.snapshot)
  const experiments = useSyncExternalStore(session.experiments.subscribe, session.experiments.snapshot)
  const [open, setOpen] = useState<string | undefined>()
  const shown = tests.runs.find(({ experiment }) => experiment.path === open)
  const back = (): void => setOpen(undefined)
  if (shown?.run.status === 'running') return <RunningView {...props} shown={shown} run={shown.run} onBack={back} />
  if (shown?.run.status === 'done')
    return (
      <ResultsView
        {...props}
        results={shown.run.results}
        onBack={back}
        onRerun={() => session.rerunFailed(shown.experiment.path)}
        onRunAgain={() => session.run([shown.experiment])}
      />
    )
  if (shown?.run.status === 'failed')
    return (
      <StoppedView
        {...props}
        command={`${COMMAND} · ${shown.experiment.name}`}
        message={shown.run.message}
        close={back}
        retry={() => session.run([shown.experiment])}
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
      label: 'Generate a new experiment',
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
  const step = (direction: 1 | -1): void => {
    for (let index = cursor.current() + direction; index >= 0 && index < rows.length; index += direction) {
      if (selectable(rows[index])) {
        cursor.set(index)
        return
      }
    }
  }
  const ready = rows.flatMap((row) => (row.kind === 'experiment' ? [row.experiment] : []))
  const activate = (row: TestRow | undefined): void => {
    if (row?.kind === 'new') openCommand('experiment')
    else if (row?.kind === 'experiment' && row.run) onOpen(row.experiment.path)
    else if (row?.kind === 'experiment') session.run([row.experiment])
  }
  const click = (index: number): void => {
    if (!selectable(rows[index])) return
    cursor.set(index)
    activate(rows[index])
  }
  useInput((input, key) => {
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
      if (picked.length > 0) {
        session.run(picked)
        chosen.set(new Set())
      } else activate(row)
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
}: TestPanelProps & {
  shown: ExperimentRun
  run: Extract<TestRun, { status: 'running' }>
  onBack: () => void
}): ReactElement => {
  const elapsed = useElapsed(run.startedAt)
  const spinner = useSpinner(true, true)
  useInput((_input, key) => {
    if (key.escape) onBack()
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
      <KeyHints hints={['Esc back to the list', 'the run goes on']} />
    </>
  )
}

const caseLine = (result: CaseResult): ListItem => {
  const failure = result.verdicts.find((verdict) => !verdict.passed)
  return {
    key: result.name,
    label: result.name,
    detail: failure?.reason ?? result.verdicts[0]?.reason ?? '',
    mark: result.passed ? { text: '✓', tone: 'success' } : { text: '✗', tone: 'error' },
    ...(result.passed ? { tone: 'muted' as const } : {}),
  }
}

const failuresFirst = (results: TestResults): CaseResult[] => [
  ...results.cases.filter((result) => !result.passed),
  ...results.cases.filter((result) => result.passed),
]

const ResultsView = ({
  width,
  height,
  results,
  onBack,
  onRerun,
  onRunAgain,
}: TestPanelProps & {
  results: TestResults
  onBack: () => void
  onRerun: () => void
  onRunAgain: () => void
}): ReactElement => {
  const ordered = failuresFirst(results)
  const cursor = useCursor(ordered.length)
  const index = cursor.index
  const current = ordered[index]
  const failed = ordered.filter((result) => !result.passed).length
  const checks = results.cases.reduce((total, result) => total + result.verdicts.length, 0)
  const verdictRows = current?.verdicts.length ?? 0
  const capacity = Math.max(1, height - FIXED_ROWS - verdictRows - 1)
  useInput((input, key) => {
    if (key.escape) onBack()
    else if (key.upArrow) cursor.move(-1)
    else if (key.downArrow) cursor.move(1)
    else if (shortcut(input, key) === 'r' && failed > 0) onRerun()
    else if (key.return) onRunAgain()
  })
  const labelWidth = labelWidthFor(current?.verdicts.map(({ evaluator }) => evaluator) ?? [], width)
  return (
    <>
      <PanelTitle
        name={COMMAND}
        parts={[
          results.experiment,
          plural(results.cases.length, 'case'),
          plural(results.evaluators.length, 'evaluator'),
        ]}
        right={<ProgressBar done={results.cases.length} total={results.cases.length} />}
      />
      <SplitLine
        left={<Tally passed={results.cases.length - failed} failed={failed} />}
        right={
          <Text dimColor>
            {`${formatSeconds(results.seconds)} · ${plural(checks, 'check')} · score ${results.overall.toFixed(2)}`}
          </Text>
        }
      />
      <ItemList
        items={ordered.map(caseLine)}
        selected={index}
        capacity={capacity}
        labelWidth={labelWidthFor(
          ordered.map(({ name }) => name),
          width
        )}
        onClick={cursor.set}
      />
      <Rule width={width} />
      {current?.verdicts.map((verdict) => (
        <Field
          key={verdict.evaluator}
          label={verdict.evaluator}
          value={`${(verdict.passed ? '✓' : '✗').padEnd(2)} ${verdict.score.toFixed(2).padEnd(SCORE_COLUMN)}${verdict.reason}`}
          labelWidth={labelWidth + 2}
          {...(verdict.passed ? {} : { tone: 'error' as const })}
        />
      ))}
      <Fill />
      <KeyHints hints={['↑↓', ...(failed > 0 ? ['r rerun failed'] : []), 'Enter run again', 'Esc back to the list']} />
    </>
  )
}

const Tally = ({ passed, failed }: { passed: number; failed: number }): ReactElement => {
  const { success, error } = useTheme()
  return (
    <Text>
      <Text color={success}>{`  ✓ ${passed} passed`}</Text>
      <Text {...(failed > 0 ? { color: error } : { dimColor: true })}>{`   ✗ ${failed} failed`}</Text>
    </Text>
  )
}
