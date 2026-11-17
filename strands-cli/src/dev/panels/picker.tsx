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
  type Tone,
} from './ui.js'

export interface PickerSectionItem extends ListItem {
  readonly disabled?: boolean
}

export interface PickerSection {
  readonly title: string
  readonly status?: string
  readonly items: readonly PickerSectionItem[]
  readonly note?: string
  readonly noteTone?: Tone
  readonly onChoose: (index: number) => void
}

export interface ExperimentPickerProps extends DevChatPanelProps {
  readonly experiments: ExperimentSession
  readonly command: string
  readonly onUse: (experiment: ExperimentSummary) => void
  readonly section?: PickerSection
  readonly extraHints?: readonly string[]
  readonly describe?: (experiment: ExperimentSummary) => string | undefined
}

type PickerRow =
  | { readonly kind: 'ready'; readonly experiment: ExperimentSummary }
  | { readonly kind: 'waiting'; readonly generation: Generation }
  | { readonly kind: 'new' }
  | { readonly kind: 'heading'; readonly title: string }
  | { readonly kind: 'note'; readonly text: string; readonly tone?: Tone }
  | { readonly kind: 'extra'; readonly item: PickerSectionItem; readonly index: number }

const CHROME_ROWS = 3

const sectionRows = (section: PickerSection | undefined): PickerRow[] =>
  section
    ? [
        { kind: 'note', text: '' },
        { kind: 'heading', title: section.title },
        ...(section.note
          ? [{ kind: 'note' as const, text: section.note, ...(section.noteTone ? { tone: section.noteTone } : {}) }]
          : []),
        ...section.items.map((item, index) => ({ kind: 'extra' as const, item, index })),
      ]
    : []

export const pickerRows = ({ saved, generations }: ExperimentsState, section?: PickerSection): PickerRow[] => [
  ...saved.map((experiment) => ({ kind: 'ready' as const, experiment })),
  ...generations
    .filter((generation) => generation.phase !== 'failed')
    .map((generation) => ({ kind: 'waiting' as const, generation })),
  { kind: 'new' },
  ...sectionRows(section),
]

const waitingDetail = (generation: Generation): string =>
  isGenerating(generation)
    ? generation.phase === 'cases'
      ? `generating · ${generation.made + generation.failed}/${generation.total} cases`
      : 'generating · preparing'
    : 'waiting for review in /experiment'

const rowItem = (row: PickerRow, describe?: ExperimentPickerProps['describe']): ListItem => {
  switch (row.kind) {
    case 'ready':
      return {
        key: row.experiment.path,
        label: row.experiment.name,
        detail: [plural(row.experiment.caseCount, 'case'), describe?.(row.experiment)].filter(Boolean).join(' · '),
      }
    case 'waiting':
      return {
        key: row.generation.id,
        label: row.generation.name,
        detail: waitingDetail(row.generation),
        mark: { text: isGenerating(row.generation) ? '◐' : '●', tone: 'muted' },
        tone: 'muted',
      }
    case 'new':
      return { key: 'new', label: '+ Manage experiments', detail: 'opens /experiment', tone: 'muted' }
    case 'heading':
      return { key: `heading:${row.title}`, label: row.title, tone: 'muted' }
    case 'note':
      return { key: `note:${row.text}`, label: '', detail: row.text, tone: row.tone ?? 'muted' }
    case 'extra': {
      const { disabled, ...item } = row.item
      return { ...item, key: `extra:${item.key}`, ...(disabled ? { tone: 'muted' as const } : {}) }
    }
  }
}

const selectable = (row: PickerRow | undefined): boolean =>
  row?.kind === 'ready' || row?.kind === 'new' || (row?.kind === 'extra' && !row.item.disabled)

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
  section,
  extraHints = [],
  describe,
  openCommand,
  close,
  width,
  height,
}: ExperimentPickerProps): ReactElement => {
  const state = useSyncExternalStore(experiments.subscribe, experiments.snapshot)
  const rows = pickerRows(state, section)
  const chosen = useSyncedState<string | undefined>(undefined)
  const indexOf = (key: string | undefined): number => {
    const found = rows.findIndex((row) => rowItem(row).key === key && selectable(row))
    return found >= 0 ? found : rows.findIndex(selectable)
  }
  const index = indexOf(chosen.value)
  const step = (direction: 1 | -1): void =>
    chosen.set((key) => rowItem(rows[nextSelectable(rows, indexOf(key), direction)]!).key)
  const activate = (row: PickerRow | undefined): void => {
    if (row?.kind === 'ready') onUse(row.experiment)
    else if (row?.kind === 'new') openCommand('experiment')
    else if (row?.kind === 'extra') section?.onChoose(row.index)
  }
  const click = (at: number): void => {
    const row = rows[at]
    if (!row || !selectable(row)) return
    chosen.set(rowItem(row).key)
    activate(row)
  }
  useInput((_input, key) => {
    if (key.escape) close()
    else if (key.upArrow) step(-1)
    else if (key.downArrow) step(1)
    else if (key.return) activate(rows[indexOf(chosen.current())])
  })
  const generating = state.generations.filter(isGenerating).length
  const waiting = rows.some((row) => row.kind === 'waiting')
  const empty = state.loaded && state.saved.length === 0
  const parts = state.loaded
    ? [
        plural(state.saved.length, 'experiment'),
        ...(generating > 0 ? [`${generating} generating`] : []),
        ...(section?.status ? [section.status] : []),
      ]
    : ['reading experiments']
  return (
    <>
      <PanelTitle name={command} parts={parts} />
      {state.error ? <Line tone="error">{`  ${state.error}`}</Line> : <Gap />}
      {empty ? <Line>{'  No experiment is ready to run yet.'}</Line> : null}
      <ItemList
        items={rows.map((row) => rowItem(row, describe))}
        selected={index}
        capacity={Math.max(1, height - CHROME_ROWS - Number(empty) - Number(waiting))}
        labelWidth={labelWidthFor(
          rows.map((row) => rowItem(row).label),
          width
        )}
        onClick={click}
      />
      <Fill />
      {waiting ? (
        <Line tone="muted">{'  Grey experiments are still generating, or wait for review in /experiment.'}</Line>
      ) : null}
      <KeyHints
        hints={[
          '↑↓',
          rows[index]?.kind === 'extra' ? 'Enter open the report' : 'Enter choose',
          ...extraHints,
          'Esc close',
        ]}
      />
    </>
  )
}
