import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import { useInput } from 'ink'
import stringWidth from 'string-width'

import { createDiffPreview } from '../../agent/file-changes.js'
import type { ChatDiffLine } from '../../agent/types.js'
import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { Box, Text, useTheme } from '../../ui/theme.js'
import { ExperimentPicker } from './picker.js'
import type {
  CandidateResult,
  ExperimentSummary,
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

const SetupView = ({
  close,
  session,
  width,
  height,
  plan,
}: OptimizePanelProps & { plan: OptimizePlan }): ReactElement => {
  const cursor = useCursor(plan.knobs.length)
  const index = cursor.index
  const ready = plan.knobs.some((knob) => knob.enabled && !knob.unavailable)
  const compact = height < FULL_SETUP_ROWS
  useInput((input, key) => {
    if (key.escape) {
      session.reset()
      close()
    } else if (key.upArrow) cursor.move(-1)
    else if (key.downArrow) cursor.move(1)
    else if (shortcut(input, key) === ' ') {
      const knob = plan.knobs[cursor.current()]
      if (knob && !knob.unavailable) session.toggleKnob(knob.key)
    } else if (key.leftArrow || key.rightArrow) {
      const position = plan.iterationChoices.indexOf(plan.iterations)
      const next = plan.iterationChoices[position + (key.rightArrow ? 1 : -1)]
      if (next !== undefined) session.setIterations(next)
    } else if (key.return && ready) session.start()
  })
  const { split } = plan
  return (
    <>
      <PanelTitle name={COMMAND} parts={[plan.experiment.name, plural(plan.experiment.caseCount, 'case')]} />
      {compact ? null : <Line>{'  knobs'}</Line>}
      <ItemList
        items={plan.knobs.map(knobItem)}
        selected={index}
        capacity={plan.knobs.length}
        labelWidth={labelWidthFor(
          plan.knobs.map(({ label }) => label),
          width
        )}
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
      <StartButton ready={ready} />
      <Fill />
      <KeyHints hints={['Space toggle', '←→ budget', ready ? 'Enter start' : 'pick a knob', 'Esc cancel']} />
    </>
  )
}

const StartButton = ({ ready }: { ready: boolean }): ReactElement => {
  const { accent } = useTheme()
  return (
    <Box height={1} flexShrink={0}>
      <Text {...(ready ? { color: accent, bold: true } : { dimColor: true })}>{'  [ Start ]'}</Text>
      <Text>{'   Cancel'}</Text>
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
  const change = edit.knob === 'instructions' ? diffCounts(lines) : `${oneLine(edit.before)} → ${oneLine(edit.after)}`
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
