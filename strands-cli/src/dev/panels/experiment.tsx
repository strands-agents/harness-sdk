import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import { useInput, usePaste } from 'ink'

import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { Box, Text } from '../../ui/theme.js'
import {
  isGenerating,
  type CaseChange,
  type DraftCase,
  type ExperimentSession,
  type ExperimentsState,
  type ExperimentSummary,
  type Generation,
  type Review,
} from './model.js'
import {
  editText,
  Field,
  Fill,
  formatSeconds,
  ItemList,
  KeyHints,
  labelWidthFor,
  Line,
  PanelTitle,
  Paragraph,
  pasteText,
  plural,
  ProgressBar,
  quoted,
  Rule,
  shortcut,
  SplitLine,
  TextField,
  textValue,
  useCursor,
  useSyncedState,
  type ListItem,
  type TextValue,
} from './ui.js'

export interface ExperimentPanelProps extends DevChatPanelProps {
  readonly session: ExperimentSession
}

type View = { readonly kind: 'home' } | { readonly kind: 'detail'; readonly id: string }

const COMMAND = 'experiment'
const SECOND_MS = 1000
const ROOMY_HEIGHT = 14
const DETAIL_LABEL_WIDTH = 10

export const ExperimentPanel = (props: ExperimentPanelProps): ReactElement => {
  const { session, close } = props
  const state = useSyncExternalStore(session.subscribe, session.snapshot)
  const [view, setView] = useState<View>({ kind: 'home' })
  const home = (): void => setView({ kind: 'home' })
  if (state.review) return <ReviewView {...props} review={state.review} />
  const shown = view.kind === 'detail' ? state.generations.find(({ id }) => id === view.id) : undefined
  if (shown)
    return (
      <DetailView
        {...props}
        generation={shown}
        onBack={home}
        onFixInChat={() => {
          close()
          session.retryInChat(shown.id)
        }}
      />
    )
  return (
    <HomeView
      {...props}
      state={state}
      onNew={() => {
        close()
        session.startInChat()
      }}
      onDetail={(id) => setView({ kind: 'detail', id })}
    />
  )
}

const useNow = (ticking: boolean): number => {
  const [, setTicks] = useState(0)
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setTicks((ticks) => ticks + 1), SECOND_MS)
    return (): void => clearInterval(timer)
  }, [ticking])
  return Date.now()
}

const elapsed = (generation: Generation, now: number): string =>
  formatSeconds(((generation.endedAt ?? now) - generation.startedAt) / SECOND_MS)

const madeText = ({ made, failed, total }: Generation): string =>
  `${made}/${total} cases made${failed > 0 ? ` · ${failed} failed` : ''}`

export const generationSummary = (generation: Generation, now: number): string => {
  switch (generation.phase) {
    case 'preparing':
      return `preparing · ${generation.status} · ${elapsed(generation, now)}`
    case 'planning':
      return `planning ${plural(generation.settings.topics, 'topic')} · ${elapsed(generation, now)}`
    case 'cases':
      return `${madeText(generation)} · ${elapsed(generation, now)}`
    case 'rubric':
      return `${madeText(generation)} · writing the rubric · ${elapsed(generation, now)}`
    case 'ready':
      return `${plural(generation.made, 'case')} ready to review${generation.failed > 0 ? ` · ${generation.failed} failed` : ''}`
    case 'failed':
      return generation.error?.summary ?? 'stopped'
  }
}

type HomeRow =
  | { readonly kind: 'new' }
  | { readonly kind: 'generation'; readonly generation: Generation }
  | { readonly kind: 'saved'; readonly experiment: ExperimentSummary }

const homeRows = ({ generations, saved }: ExperimentsState): HomeRow[] => [
  { kind: 'new' },
  ...generations.map((generation) => ({ kind: 'generation' as const, generation })),
  ...saved.map((experiment) => ({ kind: 'saved' as const, experiment })),
]

const homeItem = (row: HomeRow, now: number): ListItem => {
  if (row.kind === 'new')
    return {
      key: 'new',
      label: 'New experiment',
      detail: 'describe it to the agent in the chat',
      mark: { text: '+' },
      tone: 'muted',
    }
  if (row.kind === 'saved')
    return {
      key: row.experiment.path,
      label: row.experiment.name,
      detail: plural(row.experiment.caseCount, 'case'),
      mark: { text: ' ' },
      tone: 'muted',
    }
  const { generation } = row
  const detail = generationSummary(generation, now)
  if (generation.phase === 'failed')
    return { key: generation.id, label: generation.name, detail, mark: { text: '✗', tone: 'error' }, tone: 'error' }
  if (generation.phase === 'ready')
    return { key: generation.id, label: generation.name, detail, mark: { text: '●', tone: 'success' } }
  return { key: generation.id, label: generation.name, detail, mark: { text: '◐', tone: 'warning' } }
}

const homeNote = (row: HomeRow | undefined): string => {
  if (!row || row.kind === 'new')
    return 'Describe what to test, then approve generation with a separate AWS Bedrock model. Your chat model stays unchanged.'
  if (row.kind === 'saved') return `${row.experiment.path} · Enter opens it in the editor`
  const { generation } = row
  if (generation.phase === 'failed') return 'Enter shows why it stopped and how to fix it.'
  if (generation.phase === 'ready') return 'Enter reviews the cases. Nothing joins the experiment until you save it.'
  return `Log: ${generation.log}`
}

const HomeView = ({
  session,
  state,
  close,
  width,
  height,
  onNew,
  onDetail,
}: ExperimentPanelProps & {
  state: ExperimentsState
  onNew: () => void
  onDetail: (id: string) => void
}): ReactElement => {
  const rows = homeRows(state)
  const now = useNow(state.generations.some(isGenerating))
  const cursor = useCursor(rows.length)
  const discard = useSyncedState<string | undefined>(undefined)
  const index = cursor.index
  const current = rows[index]
  useInput((input, key) => {
    const typed = shortcut(input, key)
    const row = rows[cursor.current()]
    const confirmed = discard.current()
    if (typed !== 'x') discard.set(undefined)
    if (key.escape) close()
    else if (key.upArrow) cursor.move(-1)
    else if (key.downArrow) cursor.move(1)
    else if (typed === 'n') onNew()
    else if (key.return) {
      if (row?.kind === 'new') onNew()
      else if (row?.kind === 'saved') session.open(row.experiment)
      else if (row?.generation.phase === 'ready') session.review(row.generation.id)
      else if (row) onDetail(row.generation.id)
    } else if (typed === 'x' && row?.kind === 'generation') {
      const { generation } = row
      if (isGenerating(generation)) session.cancel(generation.id)
      else if (generation.phase === 'failed' || confirmed === generation.id) session.dismiss(generation.id)
      else discard.set(generation.id)
    }
  })
  const generating = state.generations.filter(isGenerating).length
  const parts = [
    plural(state.saved.length, 'saved experiment'),
    ...(generating > 0 ? [`${generating} generating`] : []),
  ]
  const confirming = current?.kind === 'generation' && discard.value === current.generation.id
  const actions =
    current?.kind === 'generation'
      ? isGenerating(current.generation)
        ? ['x cancel']
        : current.generation.phase === 'failed'
          ? ['x dismiss']
          : ['x discard']
      : []
  return (
    <>
      <PanelTitle name={COMMAND} parts={parts} right={<Text dimColor>{state.folder}</Text>} />
      {state.error ? <Line tone="error">{`  ${state.error}`}</Line> : null}
      <ItemList
        items={rows.map((row) => homeItem(row, now))}
        selected={index}
        capacity={Math.max(1, height - 4 - Number(Boolean(state.error)))}
        labelWidth={labelWidthFor(
          rows.map((row) => homeItem(row, now).label),
          width
        )}
      />
      <Fill />
      {confirming ? (
        <Line tone="warning">{`  Press x again to discard ${plural(current.generation.made, 'drafted case')}.`}</Line>
      ) : (
        <Line tone="muted">{`  ${homeNote(current)}`}</Line>
      )}
      <KeyHints hints={['↑↓', 'Enter open', 'n new', ...actions, 'Esc close']} />
    </>
  )
}

const caseItem = (item: DraftCase, index: number): ListItem => ({
  key: `${index}:${item.name}`,
  label: item.name,
  detail: quoted(item.input),
  mark: item.kept ? { text: '☑', tone: 'success' } : { text: '☐', tone: 'muted' },
})

interface CaseEditor {
  readonly index?: number
  readonly field: 'input' | 'expected'
  readonly input: TextValue
  readonly expected: TextValue
  readonly opened: { readonly input: string; readonly expected: string }
}

const editorFor = (field: CaseEditor['field'], input: string, expected: string, index?: number): CaseEditor => ({
  ...(index === undefined ? {} : { index }),
  field,
  input: textValue(input),
  expected: textValue(expected),
  opened: { input, expected },
})

const changedFields = ({ input, expected, opened }: CaseEditor): CaseChange => ({
  ...(input.input === opened.input ? {} : { input: input.input }),
  ...(expected.input === opened.expected ? {} : { expected: expected.input }),
})

const reviewTitle = (review: Review): { name: string; parts: string[] } => {
  const kept = review.cases.filter(({ kept }) => kept).length
  return review.path
    ? { name: COMMAND, parts: [review.name, plural(review.cases.length, 'case'), `${kept} kept`] }
    : { name: 'review', parts: [review.name, `${review.cases.length} drafted`, `${kept} kept`] }
}

const ReviewView = ({ session, width, height, review }: ExperimentPanelProps & { review: Review }): ReactElement => {
  const cursor = useCursor(review.cases.length)
  const editing = useSyncedState<CaseEditor | undefined>(undefined)
  const editor = editing.value
  const index = cursor.index
  const current = review.cases[index]
  const detailRows = height >= ROOMY_HEIGHT ? 2 : 1
  const capacity = Math.max(1, height - 4 - Number(Boolean(review.notice)) - detailRows * 2)
  const typeInto = (change: (value: TextValue) => TextValue): void =>
    editing.set((open) => open && { ...open, [open.field]: change(open[open.field]) })
  const saveEdit = (open: CaseEditor): void => {
    const change = changedFields(open)
    if (open.index === undefined) {
      session.add({ input: open.input.input, expected: open.expected.input })
      cursor.set(review.cases.length)
    } else if (Object.keys(change).length > 0) session.edit(open.index, change)
    editing.set(undefined)
  }
  useInput((input, key) => {
    const open = editing.current()
    if (open) {
      if (key.escape) editing.set(undefined)
      else if (key.return) saveEdit(open)
      else if (key.tab || key.upArrow || key.downArrow)
        editing.set({ ...open, field: open.field === 'input' ? 'expected' : 'input' })
      else typeInto((value) => editText(value, input, key))
      return
    }
    const typed = shortcut(input, key)
    const at = cursor.current()
    const item = review.cases[at]
    if (key.escape) session.closeReview()
    else if (key.upArrow) cursor.move(-1)
    else if (key.downArrow) cursor.move(1)
    else if (typed === ' ' && item) session.toggle(at)
    else if (typed === 'd' && item) session.drop(at)
    else if (typed === 'a') session.keepAll()
    else if (typed === 'e' && item) editing.set(editorFor('expected', item.input, item.expected ?? '', at))
    else if (typed === 'n') editing.set(editorFor('input', '', ''))
    else if (key.return) void session.save()
  })
  usePaste((text) => typeInto((value) => pasteText(value, text)))
  const { name, parts } = reviewTitle(review)
  return (
    <>
      <PanelTitle
        name={name}
        parts={parts}
        right={review.cases.length > 0 ? <Text dimColor>{`${index + 1}/${review.cases.length}`}</Text> : undefined}
      />
      {review.notice ? <Line tone={review.notice.tone}>{`  ${review.notice.text}`}</Line> : null}
      <ItemList
        items={review.cases.map(caseItem)}
        selected={index}
        capacity={capacity}
        labelWidth={labelWidthFor(
          review.cases.map((item) => item.name),
          width
        )}
      />
      <Rule width={width} />
      {editor ? (
        <>
          <TextField
            label={editor.index === undefined ? 'new input' : 'input'}
            value={editor.input}
            active={editor.field === 'input'}
            labelWidth={DETAIL_LABEL_WIDTH + 2}
            width={width}
            placeholder="what the user asks"
          />
          <TextField
            label="expected"
            value={editor.expected}
            active={editor.field === 'expected'}
            labelWidth={DETAIL_LABEL_WIDTH + 2}
            width={width}
            placeholder="the outcome of a good answer"
          />
        </>
      ) : current ? (
        <>
          <Field label="  input" value={current.input} labelWidth={DETAIL_LABEL_WIDTH + 2} rows={detailRows} />
          <Field
            label="  expected"
            value={current.expected ?? '(none)'}
            labelWidth={DETAIL_LABEL_WIDTH + 2}
            rows={detailRows}
          />
        </>
      ) : (
        <Line tone="muted">{'  No cases left. Press n to write one, or Esc to go back.'}</Line>
      )}
      <Fill />
      <KeyHints
        hints={
          editor
            ? ['Tab field', 'Enter save the case', 'Esc cancel']
            : ['Space keep', 'd drop', 'a keep all', 'e edit', 'n new case', 'Enter save', 'Esc back']
        }
      />
    </>
  )
}

const DetailView = ({
  session,
  generation,
  height,
  onBack,
  onFixInChat,
}: ExperimentPanelProps & {
  generation: Generation
  onBack: () => void
  onFixInChat: () => void
}): ReactElement => {
  const running = isGenerating(generation)
  const ready = generation.phase === 'ready'
  const now = useNow(running)
  const [problem, setProblem] = useState<string | undefined>()
  useInput((input, key) => {
    const typed = shortcut(input, key)
    if (key.escape) onBack()
    else if (ready) {
      if (key.return) session.review(generation.id)
    } else if (running && typed === 'x') {
      session.cancel(generation.id)
      onBack()
    } else if (!running && typed === 'r') {
      const failure = session.generate(generation.settings, generation.id)
      if (failure) setProblem(failure)
      else onBack()
    } else if (!running && (typed === 'e' || key.return)) onFixInChat()
    else if (!running && typed === 'd') {
      session.dismiss(generation.id)
      onBack()
    }
  })
  return (
    <>
      <PanelTitle
        name={COMMAND}
        parts={[generation.name, running || ready ? generation.phase : 'stopped']}
        right={<Text dimColor>{formatSeconds(((generation.endedAt ?? now) - generation.startedAt) / SECOND_MS)}</Text>}
      />
      {ready ? (
        <>
          <Line tone="success">{`  ✓ ${generationSummary(generation, now)}`}</Line>
          <Line>{'  Enter reviews the cases. Nothing joins the experiment until you save it.'}</Line>
          <Line tone="muted">{`  Log: ${generation.log}`}</Line>
        </>
      ) : running ? (
        <>
          <SplitLine
            left={<Text>{`  ${madeText(generation)}`}</Text>}
            right={<ProgressBar done={generation.made + generation.failed} total={generation.total} />}
          />
          <Line tone="muted">{`  ${generation.status}`}</Line>
          {generation.caseError ? <Line tone="warning">{`  Last failed case: ${generation.caseError}`}</Line> : null}
          <Line tone="muted">{`  Log: ${generation.log}`}</Line>
        </>
      ) : (
        <>
          <Line tone="error">{`  ✗ ${generation.error?.summary ?? 'Generation stopped'}`}</Line>
          {problem ? <Line tone="error">{`  ${problem}`}</Line> : null}
          <Box paddingLeft={2} flexShrink={0}>
            <Paragraph rows={Math.max(1, height - 4 - Number(Boolean(problem)))}>
              {generation.error?.detail ?? `Log: ${generation.log}`}
            </Paragraph>
          </Box>
        </>
      )}
      <Fill />
      <KeyHints
        hints={
          ready
            ? ['Enter review', 'Esc back']
            : running
              ? ['x cancel', 'Esc back']
              : ['r retry', 'Enter fix it in the chat', 'd dismiss', 'Esc back']
        }
      />
    </>
  )
}
