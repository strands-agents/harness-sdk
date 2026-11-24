import type { ChatDiffPreview } from '../agent/types.js'
import { wrapWords } from '../terminal/text.js'
import { escapePermissionText } from './chat/panel-state.js'
import type { Tone } from './panels/kit.js'

export function diffSummaryText(diff: ChatDiffPreview): string | undefined {
  const added = diff.lines.filter((line) => line.kind === 'add').length
  const removed = diff.lines.filter((line) => line.kind === 'remove').length
  if (added + removed === 0) {
    return undefined
  }
  return `+${added} -${removed} lines${diff.truncated ? ' (preview truncated)' : ''}`
}

const LINE_MARK: Record<ChatDiffPreview['lines'][number]['kind'], { label: string; tone?: Tone }> = {
  add: { label: '+', tone: 'success' },
  remove: { label: '-', tone: 'error' },
  header: { label: '', tone: 'muted' },
  context: { label: '' },
}

/** A change's lines wrapped to `width` columns between words, with the file's own spacing and no summary. */
export function wrappedDiffLines(diff: ChatDiffPreview, width: number): { label: string; text: string; tone?: Tone }[] {
  return diff.lines.flatMap((line) =>
    wrapWords(escapePermissionText(line.text), width).map((text, index) => ({
      ...LINE_MARK[line.kind],
      ...(index === 0 ? {} : { label: '' }),
      text,
    }))
  )
}
