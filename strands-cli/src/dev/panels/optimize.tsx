import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import { useInput } from 'ink'
import stringWidth from 'string-width'

import { createDiffPreview } from '../../agent/file-changes.js'
import type { ChatDiffLine } from '../../agent/types.js'
import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { Box, Text, useTheme } from '../../ui/theme.js'
import { useDevPanelClicks } from '../../ui/panels/dev.js'
import { ExperimentPicker, type PickerSection } from './picker.js'
import {
  sameCaseSplit,
  type CandidateResult,
  type CaseSplit,
  type ExperimentSummary,
  type Knob,
  type ModelChoices,
  type OptimizePlan,
  type OptimizeProgress,
  type OptimizeReview,
  type OptimizeSession,
  type PastRuns,
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
  signed,
  SplitLine,
  StoppedView,
  useCursor,
  useElapsed,
  useSyncedState,
  type ListItem,
} from './ui.js'

export interface OptimizePanelProps extends DevChatPanelProps {
  readonly session: OptimizeSession
}

const COMMAND = 'optimize'
const SLIDER_WIDTH = 21
const SLIDER_LABEL_WIDTH = 8
const DIFF_CONTEXT_LINES = 2
const FULL_SETUP_ROWS = 12
const DIFF_INDENT = 2
const REVIEW_CHROME_ROWS = 3
const MAX_EDIT_ROWS = 3

export const OptimizePanel = (props: OptimizePanelProps): ReactElement => {
  const { session } = props
  const state = useSyncExternalStore(session.subscribe, session.snapshot)
  const use = useCallback((experiment: ExperimentSummary) => session.plan(experiment), [session])
  switch (state.step) {
    case 'pick':
      return (
        <ExperimentPicker
          {...props}
          experiments={session.experiments}
          command={COMMAND}
          onUse={use}
          {...pastRunsSection(state.pastRuns, (record) => session.openPastRun(record))}
        />
      )
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
          retryHint="Enter start again"
          message={[
            `You cancelled the optimization of ${state.experiment}.`,
            'The agent source is unchanged.',
            ...(state.run ? [`Run: ${state.run}`] : []),
          ].join('\n')}
          retry={() => session.reset()}
        />
      )
    case 'failed':
      return (
        <StoppedView
          {...props}
          command={COMMAND}
          message={state.record ? `${state.message}\nRecord: ${state.record}` : state.message}
          retry={() => session.reset()}
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

const pastRunsNote = ({ loading, runs, error }: PastRuns): Pick<PickerSection, 'note' | 'noteTone'> => {
  if (error) return { note: error, noteTone: 'error' }
  if (runs.length > 0) return {}
  return { note: loading ? 'reading past runs…' : 'none yet · each finished run shows here' }
}

const pastRunsSection = (
  pastRuns: PastRuns | undefined,
  open: (record: string) => void
): { section?: PickerSection } =>
  pastRuns
    ? {
        section: {
          title: pastRuns.runs.length > 0 ? `past runs (${pastRuns.runs.length})` : 'past runs',
          items: pastRuns.runs.map((run) => ({
            key: run.record,
            label: run.experiment,
            detail: `${startedText(run.startedAt)}${run.summary}`,
            disabled: !run.opens,
          })),
          ...pastRunsNote(pastRuns),
          onChoose: (index): void => {
            const run = pastRuns.runs[index]
            if (run?.opens) open(run.record)
          },
        },
      }
    : {}

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
  readonly move: (step: 1 | -1) => void
}

type SetupRow =
  | { readonly kind: 'knob'; readonly knob: Knob }
  | { readonly kind: 'slider'; readonly slider: SetupSlider }
  | { readonly kind: 'button'; readonly button: SetupButton }

const splitText = ({ train, validation, test }: CaseSplit): string =>
  `${train} train / ${validation} validation / ${test} test`

const splitPosition = ({ split, splitChoices }: OptimizePlan): number =>
  splitChoices.findIndex((choice) => sameCaseSplit(choice, split))

const setupSliders = (plan: OptimizePlan, session: OptimizeSession, latest: () => OptimizePlan): SetupSlider[] => [
  {
    key: 'cases',
    label: 'cases',
    count: plan.splitChoices.length,
    position: Math.max(0, splitPosition(plan)),
    detail: `${splitText(plan.split)} · ${plural(plan.repetitions, 'run')} per candidate`,
    hint: '←→ split',
    move: (step): void => {
      const current = latest()
      const next = current.splitChoices[splitPosition(current) + step]
      if (next) session.setSplit(next)
    },
  },
  {
    key: 'budget',
    label: 'budget',
    count: plan.iterationChoices.length,
    position: Math.max(0, plan.iterationChoices.indexOf(plan.iterations)),
    detail: `${plural(plan.iterations, 'step')} × ${plan.width} candidates`,
    right: `~${plan.rollouts} rollouts · ~${plan.judgeCalls} judge calls`,
    hint: '←→ budget',
    move: (step): void => {
      const current = latest()
      const next = current.iterationChoices[current.iterationChoices.indexOf(current.iterations) + step]
      if (next !== undefined) session.setIterations(next)
    },
  },
]

const setupHints = (focused: SetupRow | undefined, ready: boolean): string[] => {
  if (focused?.kind === 'slider') return ['↑↓', focused.slider.hint, 'Esc cancel']
  if (focused?.kind === 'button')
    return focused.button === 'start'
      ? ['↑↓', ready ? 'Enter start' : 'check a knob to start', 'Esc cancel']
      : ['↑↓', 'Enter cancel', 'Esc cancel']
  const action = focused?.knob.unavailable
    ? 'not available'
    : focused?.knob.kind === 'models'
      ? 'Enter choose models'
      : 'Enter toggle'
  return ['↑↓', action, 'Esc cancel']
}

const SliderRow = ({
  slider,
  active,
  onPoint,
}: {
  slider: SetupSlider
  active: boolean
  onPoint: () => void
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
      {...(clicks ? { ref: clicks.target(onPoint, onPoint) } : {})}
    >
      <Box flexShrink={1} overflow="hidden">
        <Text wrap="truncate-end">
          <Text color={accent}>{active ? '› ' : '  '}</Text>
          <Text bold={active} dimColor={!active}>
            {slider.label.padEnd(SLIDER_LABEL_WIDTH)}
          </Text>
          <ChoiceSlider count={slider.count} position={slider.position} />
          <Text>{`  ${slider.detail}`}</Text>
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

const SETUP_CHROME_ROWS = 10
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

const SetupView = ({
  close,
  session,
  width,
  height,
  plan,
}: OptimizePanelProps & { plan: OptimizePlan }): ReactElement => {
  const latest = (): OptimizePlan => {
    const state = session.snapshot()
    return state.step === 'setup' ? state.plan : plan
  }
  const sliders = setupSliders(plan, session, latest)
  const rows: SetupRow[] = [
    ...plan.knobs.map((knob) => ({ kind: 'knob' as const, knob })),
    ...sliders.map((slider) => ({ kind: 'slider' as const, slider })),
    ...SETUP_BUTTONS.map((button) => ({ kind: 'button' as const, button })),
  ]
  const firstSlider = plan.knobs.length
  const firstButton = firstSlider + sliders.length
  const cursor = useCursor(rows.length)
  const [choosingModels, setChoosingModels] = useState(false)
  const ready = plan.knobs.some((knob) => knob.enabled && !knob.unavailable)
  const compact = height < FULL_SETUP_ROWS
  const focused = rows[cursor.index]
  const cancel = (): void => {
    session.reset()
    close()
  }
  const activate = (row: SetupRow | undefined): void => {
    if (row?.kind === 'button') {
      if (row.button === 'cancel') cancel()
      else if (ready) session.start()
    } else if (row?.kind === 'knob' && !row.knob.unavailable) {
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
    <>
      <PanelTitle name={COMMAND} parts={[plan.experiment.name, plural(plan.experiment.caseCount, 'case')]} />
      {compact ? null : <Line>{'  knobs'}</Line>}
      <ItemList
        items={plan.knobs.map(knobItem)}
        selected={cursor.index < firstSlider ? cursor.index : -1}
        capacity={Math.max(3, Math.min(plan.knobs.length, height - SETUP_CHROME_ROWS))}
        labelWidth={labelWidthFor(
          plan.knobs.map(({ label }) => label),
          width
        )}
        onClick={choose}
        onHover={cursor.set}
      />
      {compact ? null : <Gap />}
      {sliders.map((slider, index) => (
        <SliderRow
          key={slider.key}
          slider={slider}
          active={cursor.index === firstSlider + index}
          onPoint={() => cursor.set(firstSlider + index)}
        />
      ))}
      {compact ? null : (
        <Line tone="muted">
          {'          Train cases guide the search. Validation picks the winner. Test checks it.'}
        </Line>
      )}
      {plan.warning ? <Line tone="warning">{`  ${plan.warning}`}</Line> : compact ? null : <Gap />}
      <SetupButtons
        ready={ready}
        focused={focused?.kind === 'button' ? focused.button : undefined}
        onChoose={(button) => choose(firstButton + SETUP_BUTTONS.indexOf(button))}
        onHover={(button) => cursor.set(firstButton + SETUP_BUTTONS.indexOf(button))}
      />
      <Fill />
      <KeyHints hints={setupHints(focused, ready)} />
    </>
  )
}

const SetupButtons = ({
  ready,
  focused,
  onChoose,
  onHover,
}: {
  ready: boolean
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
    <Box height={1} flexShrink={0}>
      {button('start', <Text {...(ready ? { color: accent, bold: true } : { dimColor: true })}>{'[ Start ]'}</Text>)}
      {button('cancel', <Text bold={focused === 'cancel'}>Cancel</Text>)}
    </Box>
  )
}

const candidateItem = (candidate: CandidateResult): ListItem => {
  const where = candidate.step === undefined ? 'final' : `step ${candidate.step}`
  if (candidate.failed)
    return {
      key: String(candidate.number),
      label: `${where} · ${candidate.number}`,
      detail: `failed  ${candidate.failed}`,
      mark: { text: '✗', tone: 'error' },
      tone: 'error',
    }
  const delta = candidate.delta === undefined ? '' : `  ${signed(candidate.delta)}`
  return {
    key: String(candidate.number),
    label: `${where} · ${candidate.number}`,
    detail: `${candidate.kept ? 'kept    ' : 'not kept'}  ${candidate.summary}${delta}`,
    mark: candidate.kept ? { text: '✓', tone: 'success' } : { text: '·', tone: 'muted' },
    ...(candidate.kept ? {} : { tone: 'muted' as const }),
  }
}

const scoreText = ({ score, delta }: CandidateResult, trainCases: number | undefined): string => {
  if (score === undefined) return 'not measured'
  const cases = trainCases === undefined ? 'the training cases' : plural(trainCases, 'training case')
  const change = delta === undefined ? '' : ` · ${signed(delta)} vs your agent`
  return `${score.toFixed(2)} average on ${cases}, from 0 to 1${change}`
}

const RunningView = ({
  close,
  session,
  width,
  height,
  progress,
}: OptimizePanelProps & { progress: OptimizeProgress }): ReactElement => {
  const [selected, setSelected] = useState(0)
  const elapsed = useElapsed(progress.startedAt)
  const candidates = [...progress.candidates].reverse()
  const index = Math.min(selected, Math.max(0, candidates.length - 1))
  const current = candidates[index]
  const finished = progress.candidates.length + (progress.baseline === undefined ? 0 : 1)
  useInput((input, key) => {
    if (key.escape) close()
    else if (key.upArrow) setSelected(Math.max(0, index - 1))
    else if (key.downArrow) setSelected(Math.min(candidates.length - 1, index + 1))
    else if (shortcut(input, key) === 'x' && !progress.stopping) session.stop()
  })
  const best = progress.best
  const summary = [
    progress.baseline === undefined ? 'measuring the baseline' : `baseline ${progress.baseline.toFixed(2)}`,
    ...(best && progress.baseline !== undefined
      ? [`best ${best.score.toFixed(2)} (${signed(best.score - progress.baseline)})`]
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
      {candidates.length > 0 ? (
        <ItemList
          items={candidates.map(candidateItem)}
          selected={index}
          capacity={Math.max(1, height - 7)}
          labelWidth={labelWidthFor(
            candidates.map((candidate) => candidateItem(candidate).label),
            width
          )}
        />
      ) : (
        <Line tone="muted">{'  The first candidates appear here when the baseline is measured.'}</Line>
      )}
      <Rule width={width} />
      {current ? (
        <>
          <Field label="  change" value={current.summary} labelWidth={10} />
          <Field label="  score" value={scoreText(current, progress.trainCases)} labelWidth={10} />
        </>
      ) : (
        <Gap rows={2} />
      )}
      <Fill />
      <KeyHints
        hints={[
          '↑↓',
          progress.stopping ? 'stopping, the best so far is kept' : 'x stop and keep best',
          'Esc run in background',
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

const checkLines = (check: TestCheck): readonly [string, string] => {
  const gain = `${signed(check.difference)} on ${plural(check.cases, 'unseen test case')}`
  const range = check.range
    ? ` · ${Math.round(check.confidence * 100)}% confidence range ${signed(check.range[0])} to ${signed(check.range[1])}`
    : ''
  return [`${gain}${range}`, checkVerdict(check)]
}

const TestCheckLines = ({ review }: { review: OptimizeReview }): ReactElement => {
  if (!review.testCheck)
    return (
      <Field
        label={CHECK_LABEL}
        value="No test cases were left to check the winner on unseen cases."
        labelWidth={CHECK_LABEL_WIDTH}
        tone="muted"
      />
    )
  const [result, verdict] = checkLines(review.testCheck)
  return (
    <>
      <Field label={CHECK_LABEL} value={result} labelWidth={CHECK_LABEL_WIDTH} />
      <Field label="" value={verdict} labelWidth={CHECK_LABEL_WIDTH} tone="muted" />
    </>
  )
}

const ReviewView = ({
  close,
  session,
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
  const index = cursor.index
  const accepted = review.edits.filter((edit) => edit.accepted && !edit.unavailable).length
  const writable = review.edits.some((edit) => !edit.unavailable)
  const applied = review.applied !== undefined
  const listRows = Math.min(review.edits.length, MAX_EDIT_ROWS)
  const checkRows = review.testCheck ? 2 : 1
  const diffHeight = Math.max(1, height - REVIEW_CHROME_ROWS - checkRows - listRows)
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
  const leave = (): void => {
    if (review.past) return session.reset()
    if (applied || !writable) session.reset()
    close()
  }
  const acceptedNow = (): number => {
    const state = session.snapshot()
    return state.step === 'review' ? state.review.edits.filter((edit) => edit.accepted && !edit.unavailable).length : 0
  }
  useInput((input, key) => {
    const typed = shortcut(input, key)
    if (key.escape) leave()
    else if (applied) return
    else if (typed === 'n') session.reset()
    else if (key.leftArrow) choose(-1)
    else if (key.rightArrow) choose(1)
    else if (key.upArrow) scrollBy(-1)
    else if (key.downArrow) scrollBy(1)
    else if (key.pageUp) scrollBy(-page)
    else if (key.pageDown) scrollBy(page)
    else if (typed === 'a' || typed === 'x') {
      const at = cursor.current()
      const edit = review.edits[at]
      if (edit && (typed === 'x' || !edit.unavailable)) session.accept(at, typed === 'a')
    } else if (key.return && acceptedNow() > 0) session.apply()
  })
  const gain = `${review.baseline.toFixed(2)} → ${review.best.toFixed(2)} on ${review.measuredOn} (${signed(review.best - review.baseline)})`
  const title = (
    <PanelTitle
      name="review"
      parts={
        review.edits.length === 0
          ? [`run ${review.run}`, `best stayed at ${review.baseline.toFixed(2)} on ${review.measuredOn}`]
          : [
              `run ${review.run}`,
              gain,
              applied ? 'applied' : `${accepted} of ${plural(review.edits.length, 'edit')} accepted`,
            ]
      }
      right={review.edits.length > 0 ? <Text dimColor>{`${index + 1}/${review.edits.length}`}</Text> : undefined}
    />
  )
  const leaveHint = review.past ? 'Esc back to past runs' : 'Esc close'
  if (review.edits.length === 0)
    return (
      <>
        {title}
        <Gap />
        <Line>{'  No candidate beat your current agent, so there is nothing to change.'}</Line>
        <Line tone="muted">{`  Record: ${review.record}`}</Line>
        <Fill />
        <KeyHints hints={[leaveHint]} />
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
        <KeyHints hints={[leaveHint]} />
      </>
    )
  }
  const items = review.edits.map((edit, position) => editItem(edit, diffs[position] ?? []))
  return (
    <>
      {title}
      <TestCheckLines review={review} />
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
      <KeyHints
        hints={[
          ...(review.edits.length > 1 ? ['←→ edit'] : []),
          ...(scrolls ? ['↑↓ scroll'] : []),
          'a accept',
          'x reject',
          accepted > 0 ? 'Enter apply accepted' : 'accept an edit to apply',
          'n new run',
          review.past ? 'Esc back to past runs' : 'Esc later',
        ]}
      />
    </>
  )
}
