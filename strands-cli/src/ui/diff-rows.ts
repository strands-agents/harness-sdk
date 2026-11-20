import type { ChatDiffPreview } from '../agent/types.js'
import { escapePermissionText } from './chat/panel-state.js'
import type { Tone } from './panels/kit.js'

export interface DiffRow {
  label: string
  text: string
  tone?: Tone
}

export const DIFF_SUMMARY_LABEL = 'Changes'

export function diffCounts(diff: ChatDiffPreview): { added: number; removed: number } {
  return {
    added: diff.lines.filter((line) => line.kind === 'add').length,
    removed: diff.lines.filter((line) => line.kind === 'remove').length,
  }
}

export function diffSummaryText(diff: ChatDiffPreview): string | undefined {
  const { added, removed } = diffCounts(diff)
  if (added + removed === 0) {
    return undefined
  }
  return `+${added} -${removed} lines${diff.truncated ? ' (preview truncated)' : ''}`
}

const LINE_TONE: Record<ChatDiffPreview['lines'][number]['kind'], Tone | undefined> = {
  add: 'success',
  remove: 'error',
  header: 'muted',
  context: undefined,
}

const LINE_LABEL: Record<ChatDiffPreview['lines'][number]['kind'], string> = {
  add: '+',
  remove: '-',
  header: '',
  context: '',
}

/** The summary row, then one row per diff line, for every surface that shows a file change. */
export function diffRows(diff: ChatDiffPreview): DiffRow[] {
  const summary = diffSummaryText(diff)
  const rows: DiffRow[] = summary === undefined ? [] : [{ label: DIFF_SUMMARY_LABEL, text: summary, tone: 'muted' }]
  for (const line of diff.lines) {
    const tone = LINE_TONE[line.kind]
    rows.push({
      label: LINE_LABEL[line.kind],
      text: escapePermissionText(line.text),
      ...(tone === undefined ? {} : { tone }),
    })
  }
  return rows
}
