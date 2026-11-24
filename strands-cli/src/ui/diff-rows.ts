import type { ChatDiffPreview } from '../agent/types.js'
import { wrapWords } from '../terminal/text.js'
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

/** One row per diff line: its mark, its text, and its tone. */
function diffLineRows(diff: ChatDiffPreview): DiffRow[] {
  return diff.lines.map((line) => {
    const tone = LINE_TONE[line.kind]
    return {
      label: LINE_LABEL[line.kind],
      text: escapePermissionText(line.text),
      ...(tone === undefined ? {} : { tone }),
    }
  })
}

/** The summary row, then one row per diff line, for every surface that shows a file change. */
export function diffRows(diff: ChatDiffPreview): DiffRow[] {
  const summary = diffSummaryText(diff)
  return [
    ...(summary === undefined ? [] : [{ label: DIFF_SUMMARY_LABEL, text: summary, tone: 'muted' as const }]),
    ...diffLineRows(diff),
  ]
}

/** A change's lines wrapped to `width` columns between words, with the file's own spacing and no summary. */
export function wrappedDiffLines(diff: ChatDiffPreview, width: number): DiffRow[] {
  return diffLineRows(diff).flatMap((row) =>
    wrapWords(row.text, width).map((text, index) => ({ ...row, label: index === 0 ? row.label : '', text }))
  )
}
