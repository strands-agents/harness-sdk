import { useCallback, useState, useSyncExternalStore, type ReactElement } from 'react'
import { useInput } from 'ink'

import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { useSpinner } from '../../ui/animation.js'
import { DatasetPanel, FailedView } from './dataset.js'
import type { CaseResult, ExperimentSummary, TestResults, TestSession, TestState } from './model.js'
import {
  Field,
  formatSeconds,
  Fill,
  Gap,
  ItemList,
  KeyHints,
  labelWidthFor,
  Line,
  PanelTitle,
  plural,
  ProgressBar,
  Rule,
  shortcut,
  SplitLine,
  useElapsed,
  type ListItem,
} from './ui.js'
import { Text, useTheme } from '../../ui/theme.js'

export interface TestPanelProps extends DevChatPanelProps {
  readonly session: TestSession
}

const COMMAND = 'test'
const FIXED_ROWS = 4
const SCORE_COLUMN = 6

export const TestPanel = (props: TestPanelProps): ReactElement => {
  const { session } = props
  const state = useSyncExternalStore(session.subscribe, session.snapshot)
  const use = useCallback((experiment: ExperimentSummary) => session.run(experiment), [session])
  switch (state.step) {
    case 'dataset':
      return <DatasetPanel {...props} session={session.dataset} command={COMMAND} onUse={use} />
    case 'running':
      return <RunningView {...props} state={state} />
    case 'results':
      return <ResultsView {...props} results={state.results} />
    case 'failed':
      return <FailedView {...props} command={COMMAND} message={state.message} retry={() => session.reset()} />
  }
}

const RunningView = ({
  close,
  state,
}: TestPanelProps & { state: Extract<TestState, { step: 'running' }> }): ReactElement => {
  const elapsed = useElapsed(state.startedAt)
  const spinner = useSpinner(true, true)
  useInput((_input, key) => {
    if (key.escape) close()
  })
  const judging = state.done >= state.cases
  return (
    <>
      <PanelTitle
        name={COMMAND}
        parts={[
          state.experiment,
          plural(state.cases, state.rerun ? 'failed case' : 'case'),
          plural(state.evaluators.length, 'evaluator'),
        ]}
        right={<ProgressBar done={state.done} total={state.cases} />}
      />
      <Line tone="muted">{`  ${formatSeconds(elapsed)}`}</Line>
      <Gap />
      <Line>
        {judging
          ? `  ${spinner} Every case has run. The evaluators are scoring the answers.`
          : `  ${spinner} Running your agent on each case. The evaluators score the answers at the end.`}
      </Line>
      <Fill />
      <KeyHints hints={['Esc run in background']} />
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
  close,
  session,
  width,
  height,
  results,
}: TestPanelProps & { results: TestResults }): ReactElement => {
  const [selected, setSelected] = useState(0)
  const ordered = failuresFirst(results)
  const index = Math.min(selected, Math.max(0, ordered.length - 1))
  const current = ordered[index]
  const failed = ordered.filter((result) => !result.passed).length
  const checks = results.cases.reduce((total, result) => total + result.verdicts.length, 0)
  const verdictRows = current?.verdicts.length ?? 0
  const capacity = Math.max(1, height - FIXED_ROWS - verdictRows - 1)
  useInput((input, key) => {
    if (key.escape) close()
    else if (key.upArrow) setSelected(Math.max(0, index - 1))
    else if (key.downArrow) setSelected(Math.min(ordered.length - 1, index + 1))
    else if (shortcut(input, key) === 'r' && failed > 0) session.rerunFailed()
    else if (key.return) session.reset()
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
      <KeyHints hints={['↑↓', ...(failed > 0 ? ['r rerun failed'] : []), 'Enter test again', 'Esc close']} />
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
