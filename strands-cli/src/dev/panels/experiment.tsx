import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import { useInput, usePaste } from 'ink'

import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { Box, Text } from '../../ui/theme.js'
import {
  isGenerating,
  missingCaseField,
  type CaseChange,
  type CaseField,
  type DraftCase,
  type EvalsBrowser,
  type EvalsBrowserPlace,
  type ExperimentSession,
  type ExperimentsState,
  type ExperimentSummary,
  type Generation,
  type Review,
} from './model.js'
import {
  awsBedrockFact,
  editText,
  Field,
  Fill,
  formatSeconds,
  ItemList,
  KeyHints,
  labelWidthFor,
  Line,
  PaidRunView,
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
  usePaidRunConfirm,
  useSyncedState,
  type ListItem,
  type PaidRun,
  type TextValue,
} from './ui.js'
import { BROWSER_KEY, browserHints, BrowserView, useBrowserNotice } from './browser.js'

export interface ExperimentPanelProps extends DevChatPanelProps {
  readonly session: ExperimentSession
  readonly browser?: EvalsBrowser
}

type OpenInBrowser = (place: EvalsBrowserPlace) => void

type View = { readonly kind: 'home' } | { readonly kind: 'detail'; readonly id: string }

const COMMAND = 'experiment'
const SECOND_MS = 1000
const ROOMY_HEIGHT = 14
const DETAIL_LABEL_WIDTH = 10
const MISSING_FIELD = 'Write both the input and the expected answer before you save the case.'
const DEFAULT_GENERATOR_MODEL = 'the strands-evals default model on AWS Bedrock'

const paidGeneration = ({ name, settings }: Generation, start: () => void): PaidRun => ({
  title: [name],
  facts: [
    `The generator writes ${plural(settings.cases, 'case')} for ${name} again with ` +
      `${settings.model || DEFAULT_GENERATOR_MODEL}.`,
    'Generation makes paid model calls and can take minutes.',
    awsBedrockFact('Generator calls'),
  ],
  start,
})

export const ExperimentPanel = (props: ExperimentPanelProps): ReactElement => {
  const { session, close } = props
  const state = useSyncExternalStore(session.subscribe, session.snapshot)
  const [view, setView] = useState<View>({ kind: 'home' })
  const browser = useBrowserNotice(props.browser)
  const home = (): void => setView({ kind: 'home' })
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
  if (state.review) return <ReviewView {...props} review={state.review} onBrowser={browser.open} />
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
      onBrowser={browser.open}
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
  browser,
  onNew,
  onDetail,
  onBrowser,
}: ExperimentPanelProps & {
  state: ExperimentsState
  onNew: () => void
  onDetail: (id: string) => void
  onBrowser: OpenInBrowser
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
    else if (typed === BROWSER_KEY && browser)
      onBrowser(row?.kind === 'saved' ? { view: 'experiment', experiment: row.experiment.path } : { view: 'runs' })
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
      <KeyHints hints={['↑↓', 'Enter open', 'n new', ...actions, ...browserHints(browser), 'Esc close']} />
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
  readonly name?: string
  readonly field: CaseField
  readonly input: TextValue
  readonly expected: TextValue
  readonly opened: { readonly input: string; readonly expected: string }
  readonly problem?: string
}

const editorFor = (field: CaseField, input: string, expected: string, name?: string): CaseEditor => ({
  ...(name === undefined ? {} : { name }),
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

const ReviewView = ({
  session,
  browser,
  width,
  height,
  review,
  onBrowser,
}: ExperimentPanelProps & { review: Review; onBrowser: OpenInBrowser }): ReactElement => {
  const cursor = useCursor(review.cases.length)
  const editing = useSyncedState<CaseEditor | undefined>(undefined)
  const editor = editing.value
  const index = cursor.index
  const current = review.cases[index]
  const notice = editor?.problem ? { tone: 'error' as const, text: editor.problem } : review.notice
  const detailRows = height >= ROOMY_HEIGHT ? 2 : 1
  const capacity = Math.max(1, height - 4 - Number(Boolean(notice)) - detailRows * 2)
  const typeInto = (change: (value: TextValue) => TextValue): void =>
    editing.set((open) => open && { ...open, [open.field]: change(open[open.field]) })
  const saveEdit = (open: CaseEditor): void => {
    const missing = missingCaseField({ input: open.input.input, expected: open.expected.input })
    if (missing) {
      editing.set({ ...open, field: missing, problem: MISSING_FIELD })
      return
    }
    const change = changedFields(open)
    if (open.name === undefined) {
      session.add({ input: open.input.input, expected: open.expected.input })
      cursor.set(review.cases.length)
    } else {
      const at = review.cases.findIndex(({ name }) => name === open.name)
      if (at < 0) {
        editing.set({
          ...open,
          problem: `${open.name} is no longer in this experiment: it changed on disk. Press Esc.`,
        })
        return
      }
      if (Object.keys(change).length > 0) session.edit(at, change)
    }
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
    else if (typed === 'e' && item)
      editing.set(editorFor(missingCaseField(item) ?? 'expected', item.input, item.expected ?? '', item.name))
    else if (typed === 'n') editing.set(editorFor('input', '', ''))
    else if (typed === BROWSER_KEY && browser && review.path)
      onBrowser({ view: 'experiment', experiment: review.path, ...(item ? { case: item.name } : {}) })
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
      {notice ? <Line tone={notice.tone}>{`  ${notice.text}`}</Line> : null}
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
            label={editor.name === undefined ? 'new input' : 'input'}
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
            : [
                'Space keep',
                'd drop',
                'a keep all',
                'e edit',
                'n new case',
                'Enter save',
                ...(review.path ? browserHints(browser) : []),
                'Esc back',
              ]
        }
      />
    </>
  )
}

const DetailView = ({
  session,
  generation,
  width,
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
  const confirm = usePaidRunConfirm()
  const retry = (): void => {
    const failure = session.generate(generation.settings, generation.id)
    if (failure) setProblem(failure)
    else onBack()
  }
  useInput((input, key) => {
    if (confirm.asking()) return
    const typed = shortcut(input, key)
    if (key.escape) onBack()
    else if (ready) {
      if (key.return) session.review(generation.id)
    } else if (running && typed === 'x') {
      session.cancel(generation.id)
      onBack()
    } else if (!running && typed === 'r') confirm.ask(paidGeneration(generation, retry))
    else if (!running && (typed === 'e' || key.return)) onFixInChat()
    else if (!running && typed === 'd') {
      session.dismiss(generation.id)
      onBack()
    }
  })
  if (confirm.pending)
    return (
      <PaidRunView
        command={COMMAND}
        run={confirm.pending}
        width={width}
        height={height}
        backHint="Esc back"
        onAnswer={confirm.answer}
      />
    )
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
