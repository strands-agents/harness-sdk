import type { Key } from 'ink'
import stringWidth from 'string-width'

import { commandAssistance, type LocalCommandSpec } from '../chat/commands.js'
import { sanitizeTerminalText } from './sanitize.js'

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export const MIN_PROMPT_HEIGHT = 3
export const MIN_PROMPT_ROWS = 2
export const DEFAULT_MAX_PROMPT_ROWS = 8
export const PROMPT_PADDING_WIDTH = 2

export function composerMaxRows(terminalHeight: number, statusRows = 0): number {
  return Math.max(MIN_PROMPT_ROWS, Math.min(12, Math.floor(terminalHeight) - 10 - Math.max(0, statusRows)))
}

export function promptEditorHeight(
  input: string,
  cursor: number,
  width = 80,
  maxRows = DEFAULT_MAX_PROMPT_ROWS,
  hasStatus = false,
  party = false
): number {
  if (hasStatus) {
    return MIN_PROMPT_HEIGHT
  }
  const promptPrefix = input.startsWith('!') ? '◆ shell ' : '◆ '
  const rows = promptViewport(
    input,
    cursor,
    width - stringWidth(promptPrefix) - PROMPT_PADDING_WIDTH,
    Math.max(MIN_PROMPT_ROWS, maxRows)
  )
  return Math.max(MIN_PROMPT_HEIGHT, rows.length + (party && input ? 2 : 1))
}

export interface EditorState {
  input: string
  cursor: number
  history: readonly string[]
  historyIndex: number
  draft: string
}

export type InputPhase = 'idle' | 'running'

type InputResult =
  | { state: EditorState; action: 'none' }
  | { state: EditorState; action: 'submit'; prompt: string }
  | { state: EditorState; action: 'steer'; prompt: string }
  | { state: EditorState; action: 'cancel' }

export interface PromptViewportRow {
  before: string
  current?: string
  after: string
}

export function emptyEditor(): EditorState {
  return { input: '', cursor: 0, history: [], historyIndex: 0, draft: '' }
}

export function reduceInput(state: EditorState, character: string, key: Partial<Key>, phase: InputPhase): InputResult {
  if (key.escape && phase === 'running') {
    return { state, action: 'cancel' }
  }
  if (key.ctrl && character === 'g' && phase === 'running') {
    const submitted = submitEditor(state, state.input)
    return submitted.action === 'submit' ? { ...submitted, action: 'steer' } : submitted
  }
  const characters = graphemes(state.input)
  if (character === '\n' || (key.ctrl && character === 'j')) {
    return edit(state, characters, state.cursor, state.cursor, ['\n'])
  }
  if (key.return && phase === 'running' && (key.ctrl || key.meta || key.super)) {
    const submitted = submitEditor(state, state.input)
    return submitted.action === 'submit' ? { ...submitted, action: 'steer' } : submitted
  }
  if (key.return) {
    return submitEditor(state, state.input)
  }
  if (key.upArrow) {
    if (state.history.length === 0) {
      return { state, action: 'none' }
    }
    const historyIndex = Math.max(0, Math.min(state.historyIndex, state.history.length) - 1)
    const draft = state.historyIndex === state.history.length ? state.input : state.draft
    const input = state.history[historyIndex] ?? ''
    return {
      state: { ...state, input, cursor: graphemes(input).length, historyIndex, draft },
      action: 'none',
    }
  }
  if (key.downArrow) {
    if (state.historyIndex >= state.history.length) {
      return { state, action: 'none' }
    }
    const historyIndex = state.historyIndex + 1
    const input = historyIndex === state.history.length ? state.draft : (state.history[historyIndex] ?? '')
    return {
      state: { ...state, input, cursor: graphemes(input).length, historyIndex },
      action: 'none',
    }
  }
  if (key.leftArrow || (key.ctrl && character === 'b')) {
    return moveCursor(state, key.meta ? previousWord(characters, state.cursor) : Math.max(0, state.cursor - 1))
  }
  if (key.rightArrow || (key.ctrl && character === 'f')) {
    return moveCursor(
      state,
      key.meta ? nextWord(characters, state.cursor) : Math.min(characters.length, state.cursor + 1)
    )
  }
  if (key.home || (key.ctrl && character === 'a')) {
    return moveCursor(state, 0)
  }
  if (key.end || (key.ctrl && character === 'e')) {
    return moveCursor(state, characters.length)
  }
  if (key.backspace || key.delete || character === '\u007f') {
    return state.cursor > 0 ? edit(state, characters, state.cursor - 1, state.cursor) : { state, action: 'none' }
  }
  if (key.tab) {
    const suggestions = commandAssistance(state.input)?.completions ?? []
    if (suggestions.length === 1) {
      return { state: completeSuggestion(state, suggestions[0]!), action: 'none' }
    }
    return { state, action: 'none' }
  }
  if (key.ctrl) {
    if (character === 'u') {
      return edit(state, characters, 0, state.cursor)
    }
    if (character === 'k') {
      return edit(state, characters, state.cursor, characters.length)
    }
    if (character === 'w') {
      return edit(state, characters, previousWord(characters, state.cursor), state.cursor)
    }
    return { state, action: 'none' }
  }
  if (key.super) {
    return { state, action: 'none' }
  }
  if (character) {
    const clean = sanitizeTerminalText(character)
    if (clean) {
      return edit(state, characters, state.cursor, state.cursor, graphemes(clean))
    }
  }
  return { state, action: 'none' }
}

export function reduceInputSequence(
  state: EditorState,
  character: string,
  key: Partial<Key>,
  phase: InputPhase
): InputResult {
  if (!/[\b\u007f]/.test(character)) {
    return reduceInput(state, character, key, phase)
  }

  let current = state
  for (const segment of character.split(/([\b\u007f])/).filter(Boolean)) {
    const result = /[\b\u007f]/.test(segment)
      ? reduceInput(current, '', { delete: true }, phase)
      : reduceInput(current, segment, {}, phase)
    current = result.state
  }
  return { state: current, action: 'none' }
}

export function completeSuggestion(state: EditorState, command: LocalCommandSpec): EditorState {
  const completed = command.replacement ?? `/${command.name} `
  return updateInput(state, completed, graphemes(completed).length)
}

export function submitEditor(state: EditorState, input: string): Extract<InputResult, { action: 'submit' | 'none' }> {
  const prompt = input.trim()
  if (!prompt) {
    return { state, action: 'none' }
  }
  const history = state.history.at(-1) === prompt ? [...state.history] : [...state.history, prompt]
  return {
    state: { input: '', cursor: 0, history, historyIndex: history.length, draft: '' },
    action: 'submit',
    prompt,
  }
}

export function promptViewport(
  input: string,
  cursor: number,
  width: number,
  maxRows: number = MIN_PROMPT_ROWS
): PromptViewportRow[] {
  const characters = graphemes(input)
  const safeCursor = Math.max(0, Math.min(cursor, characters.length))
  const safeWidth = Math.max(1, width)
  const lines: Array<{ start: number; end: number }> = []
  let start = 0
  let columns = 0

  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]!
    if (character === '\n') {
      lines.push({ start, end: index })
      start = index + 1
      columns = 0
      continue
    }

    const characterWidth = stringWidth(character)
    if (columns > 0 && columns + characterWidth > safeWidth) {
      lines.push({ start, end: index })
      start = index
      columns = 0
    }
    columns += characterWidth
  }
  lines.push({ start, end: characters.length })

  if (safeCursor === characters.length && columns >= safeWidth) {
    lines.push({ start: characters.length, end: characters.length })
  }

  let cursorRow =
    safeCursor === characters.length
      ? lines.length - 1
      : lines.findIndex((line) => {
          if (characters[safeCursor] === '\n') {
            return line.end === safeCursor
          }
          return line.start <= safeCursor && safeCursor < line.end
        })
  if (cursorRow < 0) {
    cursorRow = lines.length - 1
  }

  const rowCount = Math.max(1, maxRows)
  const viewportStart = Math.max(0, cursorRow - rowCount + 1)
  return lines.slice(viewportStart, viewportStart + rowCount).map((line, index) => {
    if (viewportStart + index !== cursorRow) {
      return {
        before: characters.slice(line.start, line.end).join(''),
        after: '',
      }
    }

    const current = characters[safeCursor]
    const cursorEndsLine = safeCursor >= line.end || current === '\n'
    return {
      before: characters.slice(line.start, cursorEndsLine ? line.end : safeCursor).join(''),
      current: cursorEndsLine ? ' ' : (current ?? ' '),
      after: cursorEndsLine ? '' : characters.slice(safeCursor + 1, line.end).join(''),
    }
  })
}

export function graphemes(value: string): string[] {
  return [...SEGMENTER.segment(value)].map((segment) => segment.segment)
}

function edit(
  state: EditorState,
  characters: readonly string[],
  start: number,
  end: number,
  insertion: readonly string[] = []
): InputResult {
  const next = [...characters.slice(0, start), ...insertion, ...characters.slice(end)].join('')
  return {
    state: updateInput(state, next, start + insertion.length),
    action: 'none',
  }
}

function updateInput(state: EditorState, input: string, cursor: number): EditorState {
  return {
    ...state,
    input,
    cursor,
    historyIndex: state.history.length,
    draft: input,
  }
}

function moveCursor(state: EditorState, cursor: number): InputResult {
  return { state: { ...state, cursor }, action: 'none' }
}

function previousWord(characters: readonly string[], cursor: number): number {
  let index = cursor
  while (index > 0 && /\s/u.test(characters[index - 1]!)) {
    index--
  }
  while (index > 0 && !/\s/u.test(characters[index - 1]!)) {
    index--
  }
  return index
}

function nextWord(characters: readonly string[], cursor: number): number {
  let index = cursor
  while (index < characters.length && !/\s/u.test(characters[index]!)) {
    index++
  }
  while (index < characters.length && /\s/u.test(characters[index]!)) {
    index++
  }
  return index
}
