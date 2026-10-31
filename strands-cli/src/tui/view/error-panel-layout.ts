import type { ChatPanel } from '../chat/types.js'
import { wrapLines } from './presentation.js'

export function errorPanelLayout(
  panel: ChatPanel,
  width: number,
  maxHeight = 10
): { lines: string[]; height: number; contentHeight: number; maxScroll: number } {
  const message = [panel.body, ...panel.rows.map((row) => row.description || row.label)]
    .filter(Boolean)
    .join('\n')
    .replaceAll('\t', '    ')
    .replaceAll('\r', '')
    .replace(/\n[ ]*(?:\n[ ]*)+/g, '\n')
  const lines = wrapLines(message, Math.max(1, width - 4))
  const height = Math.min(Math.max(1, maxHeight), lines.length + 3)
  const contentHeight = Math.max(1, height - 3)
  return { lines, height, contentHeight, maxScroll: Math.max(0, lines.length - contentHeight) }
}
