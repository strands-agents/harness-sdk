import stringWidth from 'string-width'

// Ink can pass mouse reports with the leading escape byte removed.
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_PATTERN = /^\u001b?\[<(\d+);(\d+);(\d+)([Mm])$/
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_START = /\u001b\[<[\d;]*$/
const MOUSE_MOVE_INTERVAL_MS = 33
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export interface MouseInput {
  button: number
  column: number
  row: number
  action: 'press' | 'release' | 'move'
}

export interface MouseMoveState {
  column: number
  row: number
  acceptedAt: number
}

export interface ScreenSelectionSegment {
  column: number
  row: number
  text: string
}

export interface ScreenSelection {
  segments: ScreenSelectionSegment[]
  text: string
}

export function shouldProcessMouseInput(mouse: MouseInput, state: MouseMoveState, now = Date.now()): boolean {
  if (mouse.action !== 'move') {
    return true
  }
  if (mouse.column === state.column && mouse.row === state.row) {
    return false
  }
  if (now - state.acceptedAt < MOUSE_MOVE_INTERVAL_MS) {
    return false
  }
  state.column = mouse.column
  state.row = mouse.row
  state.acceptedAt = now
  return true
}

/**
 * Cuts off the mouse report that `value` stops in the middle of, so it can wait for its end. The terminal sends a
 * report whole, but a read can stop inside one when many arrive at once or the link is slow. Ink waits only a moment
 * for the rest of an escape sequence, and then hands both pieces to its handlers as typed text.
 */
export function splitUnfinishedMouseReport(value: string): { finished: string; unfinished: string } {
  const start = value.search(SGR_MOUSE_START)
  return start < 0
    ? { finished: value, unfinished: '' }
    : { finished: value.slice(0, start), unfinished: value.slice(start) }
}

export function parseMouseInput(value: string): MouseInput | undefined {
  const match = SGR_MOUSE_PATTERN.exec(value)
  if (!match) {
    return undefined
  }
  const button = Number(match[1])
  return {
    button,
    column: Number(match[2]),
    row: Number(match[3]),
    action: match[4] === 'm' ? 'release' : (button & 32) !== 0 ? 'move' : 'press',
  }
}

export function selectScreenText(
  lines: readonly string[],
  anchor: Pick<MouseInput, 'column' | 'row'>,
  focus: Pick<MouseInput, 'column' | 'row'>
): ScreenSelection | undefined {
  if (lines.length === 0) {
    return undefined
  }
  const [start, end] = [anchor, focus]
    .map((point) => ({
      column: Math.max(0, point.column - 1),
      row: Math.max(0, Math.min(lines.length - 1, point.row - 1)),
    }))
    .sort((left, right) => left.row - right.row || left.column - right.column)
  if (!start || !end || (start.column === end.column && start.row === end.row)) {
    return undefined
  }

  const segments: ScreenSelectionSegment[] = []
  const selectedLines: string[] = []
  for (let row = start.row; row <= end.row; row++) {
    const line = lines[row] ?? ''
    const from = row === start.row ? start.column : 0
    const to = row === end.row ? end.column + 1 : stringWidth(line)
    const selected = sliceScreenLine(line, from, to)
    selectedLines.push(selected.text)
    if (selected.text) {
      segments.push({ column: selected.column, row, text: selected.text })
    }
  }
  const text = selectedLines.join('\n')
  return text ? { segments, text } : undefined
}

function sliceScreenLine(line: string, from: number, to: number): { column: number; text: string } {
  let column = 0
  let selectedColumn = from
  let text = ''
  for (const { segment } of GRAPHEME_SEGMENTER.segment(line)) {
    const width = Math.max(1, stringWidth(segment))
    const nextColumn = column + width
    if (nextColumn > from && column < to) {
      if (!text) {
        selectedColumn = column
      }
      text += segment
    }
    column = nextColumn
    if (column >= to) {
      break
    }
  }
  return { column: selectedColumn, text }
}
