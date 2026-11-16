import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import { useInput } from 'ink'
import stringWidth from 'string-width'

import { createDiffPreview } from '../../agent/file-changes.js'
import type { ChatDiffLine } from '../../agent/types.js'
import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { Box, Text, useTheme } from '../../ui/theme.js'
import { useDevPanelClicks } from '../../ui/panels/dev.js'
import { ExperimentPicker } from './picker.js'
import type {
  CandidateResult,
  ExperimentSummary,
  Knob,
  ModelChoices,
  OptimizePlan,
  OptimizeProgress,
  OptimizeReview,
  OptimizeSession,
  ProposedEdit,
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
      return <ExperimentPicker {...props} experiments={session.experiments} command={COMMAND} onUse={use} />
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

const ChoiceSlider = ({ choices, value }: { choices: readonly number[]; value: number }): ReactElement => {
  const { accent } = useTheme()
  const position = Math.max(0, choices.indexOf(value))
  const step = choices.length > 1 ? (SLIDER_WIDTH - 1) / (choices.length - 1) : 0
  const at = Math.round(position * step)
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

const setupHints = (focused: SetupButton | Knob | undefined, ready: boolean): string[] => {
  if (focused === 'start') return ['↑↓', ready ? 'Enter start' : 'check a knob to start', '←→ budget', 'Esc cancel']
  if (focused === 'cancel') return ['↑↓', 'Enter cancel', 'Esc cancel']
  const action = focused?.unavailable
    ? 'not available'
    : focused?.kind === 'models'
      ? 'Enter choose models'
      : 'Enter toggle'
  return ['↑↓', action, '←→ budget', '↓ Start', 'Esc cancel']
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
  const cursor = useCursor(plan.knobs.length + SETUP_BUTTONS.length)
  const [choosingModels, setChoosingModels] = useState(false)
  const ready = plan.knobs.some((knob) => knob.enabled && !knob.unavailable)
  const compact = height < FULL_SETUP_ROWS
  const focusAt = (row: number): SetupButton | Knob | undefined =>
    plan.knobs[row] ?? SETUP_BUTTONS[row - plan.knobs.length]
  const focused = focusAt(cursor.index)
  const cancel = (): void => {
    session.reset()
    close()
  }
  const activate = (target: SetupButton | Knob | undefined): void => {
    if (target === 'start') {
      if (ready) session.start()
    } else if (target === 'cancel') cancel()
    else if (target?.kind === 'models' && !target.unavailable) {
      session.loadModels()
      setChoosingModels(true)
    } else if (target && !target.unavailable) session.toggleKnob(target.key)
  }
  const choose = (row: number): void => {
    cursor.set(row)
    activate(focusAt(row))
  }
  useInput(
    (input, key) => {
      if (key.escape) cancel()
      else if (key.upArrow) cursor.move(-1)
      else if (key.downArrow) cursor.move(1)
      else if (key.leftArrow || key.rightArrow) {
        const position = plan.iterationChoices.indexOf(plan.iterations)
        const next = plan.iterationChoices[position + (key.rightArrow ? 1 : -1)]
        if (next !== undefined) session.setIterations(next)
      } else if (key.return || shortcut(input, key) === ' ') activate(focusAt(cursor.current()))
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
  const { split } = plan
  return (
    <>
      <PanelTitle name={COMMAND} parts={[plan.experiment.name, plural(plan.experiment.caseCount, 'case')]} />
      {compact ? null : <Line>{'  knobs'}</Line>}
      <ItemList
        items={plan.knobs.map(knobItem)}
        selected={cursor.index < plan.knobs.length ? cursor.index : -1}
        capacity={Math.max(3, Math.min(plan.knobs.length, height - SETUP_CHROME_ROWS))}
        labelWidth={labelWidthFor(
          plan.knobs.map(({ label }) => label),
          width
        )}
        onClick={choose}
        onHover={cursor.set}
      />
      {compact ? null : <Gap />}
      <Field
        label="  cases"
        value={`${split.train} train / ${split.validation} validation / ${split.test} test · ${plural(plan.repetitions, 'run')} per candidate`}
        labelWidth={10}
      />
      <SplitLine
        left={
          <Text>
            <Text dimColor>{'  budget  '}</Text>
            <ChoiceSlider choices={plan.iterationChoices} value={plan.iterations} />
            <Text>{`  ${plural(plan.iterations, 'step')} × ${plan.width} candidates`}</Text>
          </Text>
        }
        right={<Text dimColor>{`~${plan.rollouts} rollouts · ~${plan.judgeCalls} judge calls`}</Text>}
      />
      {compact ? null : (
        <Line tone="muted">
          {'          The best candidate on the validation cases wins. Test cases check it at the end.'}
        </Line>
      )}
      {plan.warning ? <Line tone="warning">{`  ${plan.warning}`}</Line> : compact ? null : <Gap />}
      <SetupButtons
        ready={ready}
        focused={typeof focused === 'string' ? focused : undefined}
        onChoose={(button) => choose(plan.knobs.length + SETUP_BUTTONS.indexOf(button))}
        onHover={(button) => cursor.set(plan.knobs.length + SETUP_BUTTONS.indexOf(button))}
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
  const ci = candidate.ci ? `  CI [${candidate.ci[0].toFixed(2)}, ${candidate.ci[1].toFixed(2)}]` : ''
  return {
    key: String(candidate.number),
    label: `${where} · ${candidate.number}`,
    detail: `${candidate.kept ? 'kept    ' : 'not kept'}  ${candidate.summary}${delta}${ci}`,
    mark: candidate.kept ? { text: '✓', tone: 'success' } : { text: '·', tone: 'muted' },
    ...(candidate.kept ? {} : { tone: 'muted' as const }),
  }
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
          <Field
            label="  score"
            value={
              current.score === undefined
                ? 'not measured'
                : `${current.score.toFixed(2)}${current.ci ? `  CI [${current.ci[0].toFixed(2)}, ${current.ci[1].toFixed(2)}]` : ''}`
            }
            labelWidth={10}
          />
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
        <Line tone="muted">{`  lines ${offset + 1}-${offset + visible.length} of ${rows.length} · PgUp/PgDn scroll`}</Line>
      ) : null}
    </Box>
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
  const diffHeight = Math.max(1, height - REVIEW_CHROME_ROWS - listRows)
  const rows = useMemo(() => wrapDiff(diffs[index] ?? [], width), [diffs, index, width])
  const page = Math.max(1, diffHeight - 1)
  const lastOffset = Math.max(0, rows.length - page)
  const choose = (step: number): void => {
    cursor.move(step)
    scroll.set(0)
  }
  const acceptedNow = (): number => {
    const state = session.snapshot()
    return state.step === 'review' ? state.review.edits.filter((edit) => edit.accepted && !edit.unavailable).length : 0
  }
  useInput((input, key) => {
    const typed = shortcut(input, key)
    if (key.escape) {
      if (applied || !writable) session.reset()
      close()
    } else if (applied) return
    else if (typed === 'n') session.reset()
    else if (key.upArrow) choose(-1)
    else if (key.downArrow) choose(1)
    else if (key.pageDown) scroll.set((offset: number) => Math.min(lastOffset, offset + page))
    else if (key.pageUp) scroll.set((offset: number) => Math.max(0, offset - page))
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
  if (review.edits.length === 0)
    return (
      <>
        {title}
        <Gap />
        <Line>{'  No candidate beat your current agent, so there is nothing to change.'}</Line>
        <Line tone="muted">{`  Record: ${review.record}`}</Line>
        <Fill />
        <KeyHints hints={['Esc close']} />
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
        <KeyHints hints={['Esc close']} />
      </>
    )
  }
  const items = review.edits.map((edit, position) => editItem(edit, diffs[position] ?? []))
  return (
    <>
      {title}
      <ItemList
        items={items}
        selected={index}
        capacity={listRows}
        labelWidth={labelWidthFor(
          review.edits.map(({ label }) => label),
          width
        )}
      />
      <Rule width={width} />
      <DiffLines rows={rows} height={diffHeight} offset={Math.min(scroll.value, lastOffset)} />
      <Fill />
      <KeyHints
        hints={[
          '↑↓ edit',
          'a accept',
          'x reject',
          accepted > 0 ? 'Enter apply accepted' : 'accept an edit to apply',
          'n new run',
          'Esc later',
        ]}
      />
    </>
  )
}
