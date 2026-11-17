import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import { useInput, usePaste } from 'ink'
import stringWidth from 'string-width'

import { createDiffPreview } from '../../agent/file-changes.js'
import { wrapWords } from '../../terminal/text.js'
import type { ChatDiffLine } from '../../agent/types.js'
import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { Box, Text, useTheme } from '../../ui/theme.js'
import { useDevPanelClicks } from '../../ui/panels/dev.js'
import { BROWSER_KEY, browserHints, BrowserView, useBrowserNotice } from './browser.js'
import { ExperimentPicker, type PickerSection } from './picker.js'
import { CaseReport } from './report.js'
import {
  sameCaseSplit,
  formatObjective,
  formatObjectiveChange,
  measuredVersions,
  sameObjective,
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
  type OptimizeReview,
  type OptimizeRun,
  type OptimizeRunState,
  type OptimizeSession,
  type EvalsBrowser,
  type OptimizeState,
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
  SplitLine,
  StoppedView,
  useCursor,
  useElapsed,
  useSyncedState,
  editText,
  pasteText,
  TextField,
  textValue,
  type ListItem,
  type TextValue,
  type Tone,
} from './ui.js'

export interface OptimizePanelProps extends DevChatPanelProps {
  readonly session: OptimizeSession
  readonly browser?: EvalsBrowser
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
const SLIDER_LABEL_WIDTH = 11
const DIFF_CONTEXT_LINES = 2
const FULL_SETUP_ROWS = 12
const DIFF_INDENT = 2
const REVIEW_CHROME_ROWS = 3
const MAX_EDIT_ROWS = 3
const RUNNING_CHROME_ROWS = 5

export const OptimizePanel = (props: OptimizePanelProps): ReactElement => {
  const { session } = props
  const state = useSyncExternalStore(session.subscribe, session.snapshot)
  const use = useCallback((experiment: ExperimentSummary) => session.plan(experiment), [session])
  const browser = useBrowserNotice(props.browser)
  useInput((input, key) => {
    if (!browser.notice && BROWSABLE_STEPS.has(state.step) && shortcut(input, key) === BROWSER_KEY)
      browser.open({ view: 'opt-runs' })
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
    case 'pick':
      return (
        <ExperimentPicker
          {...props}
          experiments={session.experiments}
          command={COMMAND}
          onUse={use}
          section={runsSection(state.runs ?? [], state.pastRuns, session)}
          extraHints={browserHints(props.browser)}
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

const runsSection = (
  runs: readonly OptimizeRun[],
  pastRuns: PastRuns | undefined,
  session: OptimizeSession
): PickerSection => {
  const current = new Set(runs.flatMap(({ record }) => (record ? [record] : [])))
  const past = (pastRuns?.runs ?? []).filter(({ record }) => !current.has(record))
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
  | { readonly kind: 'limits' }
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

const startHint = (plan: OptimizePlan, ready: boolean): string => {
  if (ready) return 'Enter start'
  return plan.objectiveProblem ? 'fix the objective to start' : 'check a knob to start'
}

const setupHints = (focused: SetupRow | undefined, plan: OptimizePlan, ready: boolean): string[] => {
  if (focused?.kind === 'slider') return ['↑↓', focused.slider.hint, 'Esc cancel']
  if (focused?.kind === 'limits') return ['↑↓', 'Enter edit', 'Esc cancel']
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

const objectiveNotice = (plan: OptimizePlan): { readonly tone: Tone; readonly text: string } | undefined => {
  if (plan.objectiveProblem) return { tone: 'error', text: plan.objectiveProblem }
  if (plan.objectiveWarning) return { tone: 'warning', text: plan.objectiveWarning }
  return plan.warning ? { tone: 'warning', text: plan.warning } : undefined
}

const SetupView = ({ session, width, height, plan }: OptimizePanelProps & { plan: OptimizePlan }): ReactElement => {
  const latest = (): OptimizePlan => {
    const state = session.snapshot()
    return state.step === 'setup' ? state.plan : plan
  }
  const sliders = setupSliders(plan, session, latest)
  const rows: SetupRow[] = [
    ...plan.knobs.map((knob) => ({ kind: 'knob' as const, knob })),
    ...sliders
      .filter(isSelectable)
      .flatMap((slider): SetupRow[] =>
        slider.key === 'objective' ? [{ kind: 'slider', slider }, { kind: 'limits' }] : [{ kind: 'slider', slider }]
      ),
    ...SETUP_BUTTONS.map((button) => ({ kind: 'button' as const, button })),
  ]
  const rowOf = (match: (row: SetupRow) => boolean): number => rows.findIndex(match)
  const firstSlider = plan.knobs.length
  const firstButton = rowOf((row) => row.kind === 'button')
  const limitsRow = rowOf((row) => row.kind === 'limits')
  const cursor = useCursor(rows.length)
  const editing = useSyncedState<ObjectiveEditor | undefined>(undefined)
  const [choosingModels, setChoosingModels] = useState(false)
  const ready = plan.knobs.some((knob) => knob.enabled && !knob.unavailable) && !plan.objectiveProblem
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
      else if (ready) session.start()
    } else if (row?.kind === 'slider' && row.slider.editable) edit('expression')
    else if (row?.kind === 'limits') edit('limits')
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
        capacity={Math.max(3, Math.min(plan.knobs.length, height - SETUP_CHROME_ROWS))}
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
            {editor?.field === 'limits' ? (
              editorField('limits', 'such as tokens <= 4000, Correctness >= 0.8')
            ) : (
              <FieldRow
                label="limits"
                value={plan.objective.limits.trim() || 'none'}
                active={cursor.index === limitsRow}
                onPoint={() => cursor.set(limitsRow)}
              />
            )}
          </Box>
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
  const index = cursor.index
  const accepted = review.edits.filter((edit) => edit.accepted && !edit.unavailable).length
  const applied = review.applied !== undefined
  const listRows = Math.min(review.edits.length, MAX_EDIT_ROWS)
  const checkRows = useMemo(() => testCheckRows(review, width), [review, width])
  const diffHeight = Math.max(1, height - REVIEW_CHROME_ROWS - checkRows.length - listRows)
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
      if (edit && (typed === 'x' || !edit.unavailable)) session.accept(at, typed === 'a')
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
      <KeyHints
        hints={[
          ...(review.edits.length > 1 ? ['←→ edit'] : []),
          ...(scrolls ? ['↑↓ scroll'] : []),
          'a accept',
          'x reject',
          accepted > 0 ? 'Enter apply accepted' : 'accept an edit to apply',
          ...browserHints(browser),
          BACK_HINT,
        ]}
      />
    </>
  )
}
