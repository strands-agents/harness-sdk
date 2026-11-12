import { useSyncExternalStore, type ReactElement } from 'react'
import { useInput } from 'ink'

import type { DevChatPanelProps } from '../../ui/chat/types.js'
import {
  isGenerating,
  type ExperimentSession,
  type ExperimentsState,
  type ExperimentSummary,
  type Generation,
} from './model.js'
import {
  Fill,
  Gap,
  ItemList,
  KeyHints,
  labelWidthFor,
  Line,
  PanelTitle,
  plural,
  useSyncedState,
  type ListItem,
} from './ui.js'

export interface ExperimentPickerProps extends DevChatPanelProps {
  readonly experiments: ExperimentSession
  readonly command: string
  readonly onUse: (experiment: ExperimentSummary) => void
}

type PickerRow =
  | { readonly kind: 'ready'; readonly experiment: ExperimentSummary }
  | { readonly kind: 'waiting'; readonly generation: Generation }
  | { readonly kind: 'new' }

const CHROME_ROWS = 3

export const pickerRows = ({ saved, generations }: ExperimentsState): PickerRow[] => [
  ...saved.map((experiment) => ({ kind: 'ready' as const, experiment })),
  ...generations
    .filter((generation) => generation.phase !== 'failed')
    .map((generation) => ({ kind: 'waiting' as const, generation })),
  { kind: 'new' },
]

const waitingDetail = (generation: Generation): string =>
  isGenerating(generation)
    ? generation.phase === 'cases'
      ? `generating · ${generation.made + generation.failed}/${generation.total} cases`
      : 'generating · preparing'
    : 'waiting for review in /experiment'

const rowItem = (row: PickerRow): ListItem => {
  switch (row.kind) {
    case 'ready':
      return { key: row.experiment.path, label: row.experiment.name, detail: plural(row.experiment.caseCount, 'case') }
    case 'waiting':
      return {
        key: row.generation.id,
        label: row.generation.name,
        detail: waitingDetail(row.generation),
        mark: { text: isGenerating(row.generation) ? '◐' : '●', tone: 'muted' },
        tone: 'muted',
      }
    case 'new':
      return { key: 'new', label: '+ Generate a new experiment', detail: 'opens /experiment', tone: 'muted' }
  }
}

const selectable = (row: PickerRow | undefined): boolean => row !== undefined && row.kind !== 'waiting'

const nextSelectable = (rows: readonly PickerRow[], from: number, step: 1 | -1): number => {
  for (let index = from + step; index >= 0 && index < rows.length; index += step) {
    if (selectable(rows[index])) return index
  }
  return from
}

export const ExperimentPicker = ({
  experiments,
  command,
  onUse,
  openCommand,
  close,
  width,
  height,
}: ExperimentPickerProps): ReactElement => {
  const state = useSyncExternalStore(experiments.subscribe, experiments.snapshot)
  const rows = pickerRows(state)
  const chosen = useSyncedState<string | undefined>(undefined)
  const indexOf = (key: string | undefined): number => {
    const found = rows.findIndex((row) => rowItem(row).key === key && selectable(row))
    return found >= 0 ? found : rows.findIndex(selectable)
  }
  const index = indexOf(chosen.value)
  const step = (direction: 1 | -1): void =>
    chosen.set((key) => rowItem(rows[nextSelectable(rows, indexOf(key), direction)]!).key)
  useInput((_input, key) => {
    if (key.escape) close()
    else if (key.upArrow) step(-1)
    else if (key.downArrow) step(1)
    else if (key.return) {
      const row = rows[indexOf(chosen.current())]
      if (row?.kind === 'ready') onUse(row.experiment)
      else if (row?.kind === 'new') openCommand('experiment')
    }
  })
  const generating = state.generations.filter(isGenerating).length
  const waiting = rows.some((row) => row.kind === 'waiting')
  const empty = state.loaded && state.saved.length === 0
  const parts = state.loaded
    ? [plural(state.saved.length, 'experiment'), ...(generating > 0 ? [`${generating} generating`] : [])]
    : ['reading experiments']
  return (
    <>
      <PanelTitle name={command} parts={parts} />
      {state.error ? <Line tone="error">{`  ${state.error}`}</Line> : <Gap />}
      {empty ? <Line>{'  No experiment is ready to run yet.'}</Line> : null}
      <ItemList
        items={rows.map(rowItem)}
        selected={index}
        capacity={Math.max(1, height - CHROME_ROWS - Number(empty) - Number(waiting))}
        labelWidth={labelWidthFor(
          rows.map((row) => rowItem(row).label),
          width
        )}
      />
      <Fill />
      {waiting ? (
        <Line tone="muted">{'  Grey experiments are still generating, or wait for review in /experiment.'}</Line>
      ) : null}
      <KeyHints hints={['↑↓', 'Enter choose', 'Esc close']} />
    </>
  )
}
