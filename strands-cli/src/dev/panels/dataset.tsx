import { useState, useSyncExternalStore, type ReactElement } from 'react'
import { useInput } from 'ink'

import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { useSpinner } from '../../ui/animation.js'
import type { DatasetSession, DatasetState, DraftCase, ExperimentSummary } from './model.js'
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
  Paragraph,
  plural,
  quoted,
  Rule,
  shortcut,
  useElapsed,
  type ListItem,
} from './ui.js'

export interface DatasetPanelProps extends DevChatPanelProps {
  readonly session: DatasetSession
  readonly command: string
  readonly onUse?: (experiment: ExperimentSummary) => void
}

const STARTER_HINT = "drafts cases and a rubric from your agent's instructions and tools"
const TITLE_ROWS = 1
const RULE_ROWS = 1
const HINT_ROWS = 1
const ROOMY_HEIGHT = 14

const useDatasetState = (session: DatasetSession): DatasetState =>
  useSyncExternalStore(session.subscribe, session.snapshot)

export const DatasetPanel = (props: DatasetPanelProps): ReactElement => {
  const { session } = props
  const state = useDatasetState(session)
  switch (state.step) {
    case 'loading':
      return <Waiting {...props} title="Reading experiments" />
    case 'empty':
      return <EmptyView {...props} folder={state.folder} />
    case 'pick':
      return <PickView {...props} experiments={state.experiments} />
    case 'drafting':
      return <DraftingView {...props} state={state} />
    case 'draft':
      return <DraftView {...props} state={state} />
    case 'failed':
      return <FailedView {...props} message={state.message} retry={() => session.refresh()} />
  }
}

const Waiting = ({ command, close, title }: DatasetPanelProps & { title: string }): ReactElement => {
  useInput((_input, key) => {
    if (key.escape) close()
  })
  return (
    <>
      <PanelTitle name={command} parts={[title]} />
      <Fill />
      <KeyHints hints={['Esc close']} />
    </>
  )
}

const EmptyView = ({ command, close, session, folder }: DatasetPanelProps & { folder: string }): ReactElement => {
  useInput((_input, key) => {
    if (key.escape) close()
    else if (key.return) session.generate()
  })
  return (
    <>
      <PanelTitle name={command} parts={[`no cases in ${folder}`]} />
      <Gap />
      <Line>{'  This agent has no eval cases yet. Pick a way to start:'}</Line>
      <Gap />
      <ItemList
        items={[{ key: 'generate', label: 'Generate a starter set', detail: STARTER_HINT, tone: 'muted' }]}
        selected={0}
        capacity={1}
        labelWidth={24}
      />
      <Fill />
      <KeyHints hints={['Enter choose', 'Esc close']} />
    </>
  )
}

const PickView = ({
  command,
  close,
  session,
  onUse,
  width,
  height,
  experiments,
}: DatasetPanelProps & { experiments: readonly ExperimentSummary[] }): ReactElement => {
  const [selected, setSelected] = useState(0)
  const items: ListItem[] = [
    ...experiments.map((experiment) => ({
      key: experiment.path,
      label: experiment.name,
      detail: plural(experiment.caseCount, 'case'),
      tone: 'muted' as const,
    })),
    { key: 'generate', label: 'Generate a starter set', detail: STARTER_HINT, mark: { text: '+' }, tone: 'muted' },
  ]
  const index = Math.min(selected, items.length - 1)
  useInput((_input, key) => {
    if (key.escape) close()
    else if (key.upArrow) setSelected(Math.max(0, index - 1))
    else if (key.downArrow) setSelected(Math.min(items.length - 1, index + 1))
    else if (key.return) {
      const experiment = experiments[index]
      if (!experiment) session.generate()
      else if (onUse) onUse(experiment)
      else session.open(experiment)
    }
  })
  return (
    <>
      <PanelTitle name={command} parts={[`${plural(experiments.length, 'experiment')} in this workspace`]} />
      <Gap />
      <ItemList
        items={items}
        selected={index}
        capacity={Math.max(1, height - TITLE_ROWS - 1 - HINT_ROWS - 1)}
        labelWidth={labelWidthFor(
          items.map(({ label }) => label),
          width
        )}
      />
      <Fill />
      <KeyHints hints={['↑↓', 'Enter choose', 'Esc close']} />
    </>
  )
}

const DraftingView = ({
  close,
  state,
}: DatasetPanelProps & { state: Extract<DatasetState, { step: 'drafting' }> }): ReactElement => {
  const elapsed = useElapsed(state.startedAt)
  const spinner = useSpinner(true, true)
  useInput((_input, key) => {
    if (key.escape) close()
  })
  return (
    <>
      <PanelTitle
        name={state.into ? 'more cases' : 'starter set'}
        parts={[`drafting ${plural(state.count, 'case')}`, ...(state.into ? [state.into] : [])]}
        right={<Line tone="muted">{formatSeconds(elapsed)}</Line>}
      />
      <Gap />
      <Line>{`  ${spinner} strands-evals is writing cases from your agent's instructions and tools.`}</Line>
      <Line tone="muted">{'  This takes a minute or two. You can close the panel; drafting goes on.'}</Line>
      <Fill />
      <KeyHints hints={['Esc close']} />
    </>
  )
}

const draftTitle = (state: Extract<DatasetState, { step: 'draft' }>): { name: string; parts: string[] } => {
  const kept = state.cases.filter((item) => item.kept).length
  if (!state.path)
    return {
      name: 'starter set',
      parts: [`${state.drafted} drafted`, `${kept} kept`, 'generated by strands-evals'],
    }
  const saved = state.cases.filter((item) => item.saved).length
  return {
    name: 'experiment',
    parts: [state.name, plural(saved, 'case'), ...(state.drafted > 0 ? [`${state.drafted} new drafted`] : [])],
  }
}

const caseItem = (item: DraftCase, index: number): ListItem => ({
  key: `${index}:${item.name}`,
  label: item.name,
  detail: quoted(item.input),
  mark: item.kept ? { text: '☑', tone: 'success' } : { text: '☐', tone: 'muted' },
})

const DraftView = ({
  close,
  session,
  onUse,
  width,
  height,
  state,
}: DatasetPanelProps & { state: Extract<DatasetState, { step: 'draft' }> }): ReactElement => {
  const [selected, setSelected] = useState(0)
  const index = Math.min(selected, Math.max(0, state.cases.length - 1))
  const current = state.cases[index]
  const detailRows = height >= ROOMY_HEIGHT ? 2 : 1
  const noticeRows = state.notice ? 1 : 0
  const capacity = Math.max(1, height - TITLE_ROWS - noticeRows - RULE_ROWS - detailRows * 2 - HINT_ROWS)
  const canDraft = Boolean(state.path) || state.cases.length === 0
  useInput((input, key) => {
    const typed = shortcut(input, key)
    if (key.escape) close()
    else if (key.upArrow) setSelected(Math.max(0, index - 1))
    else if (key.downArrow) setSelected(Math.min(state.cases.length - 1, index + 1))
    else if (typed === ' ') session.toggle(index)
    else if (typed === 'd') session.drop(index)
    else if (typed === 'a') session.keepAll()
    else if (typed === 'g' && canDraft) session.generate()
    else if (key.return)
      void session.save().then((saved) => {
        if (saved && onUse) onUse(saved)
      })
  })
  const { name, parts } = draftTitle(state)
  return (
    <>
      <PanelTitle
        name={name}
        parts={parts}
        right={state.cases.length > 0 ? <Line tone="muted">{`${index + 1}/${state.cases.length}`}</Line> : undefined}
      />
      {state.notice ? <Line tone={state.notice.tone}>{state.notice.text}</Line> : null}
      <ItemList
        items={state.cases.map(caseItem)}
        selected={index}
        capacity={capacity}
        labelWidth={labelWidthFor(
          state.cases.map((item) => item.name),
          width
        )}
      />
      <Rule width={width} />
      {current ? (
        <>
          <Field label="input" value={current.input} labelWidth={10} rows={detailRows} />
          <Field label="expected" value={current.expected ?? '(none)'} labelWidth={10} rows={detailRows} />
        </>
      ) : (
        <Line tone="muted">{'  No cases left. Press g to draft more, or Esc to close.'}</Line>
      )}
      <Fill />
      <KeyHints
        hints={[
          'Space keep',
          'd drop',
          'a keep all',
          ...(canDraft ? ['g draft more'] : []),
          onUse ? 'Enter save and use' : 'Enter save',
          'Esc close',
        ]}
      />
    </>
  )
}

export const FailedView = ({
  command,
  close,
  height,
  message,
  retry,
}: DevChatPanelProps & { command: string; message: string; retry: () => void }): ReactElement => {
  useInput((_input, key) => {
    if (key.escape) close()
    else if (key.return) retry()
  })
  return (
    <>
      <PanelTitle name={command} parts={['stopped']} />
      <Paragraph rows={Math.max(1, height - TITLE_ROWS - HINT_ROWS)} tone="error">
        {message}
      </Paragraph>
      <Fill />
      <KeyHints hints={['Enter try again', 'Esc close']} />
    </>
  )
}
