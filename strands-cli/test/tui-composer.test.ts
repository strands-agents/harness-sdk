import chalk from 'chalk'
import { createElement } from 'react'
import { renderToString, type Key } from 'ink'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { commandAssistance } from '../src/tui/chat/commands.js'
import {
  composerMaxRows,
  emptyEditor,
  graphemes,
  promptEditorHeight,
  promptViewport,
  reduceInput,
  reduceInputSequence,
  submitEditor,
  type EditorState,
} from '../src/tui/terminal/composer.js'
import { PromptEditor } from '../src/tui/view/prompt-editor.js'
import { EditableText } from '../src/tui/view/text-input.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'

describe('editable text', () => {
  it('keeps a useful one-line path around the caret without splitting wide graphemes or leaking masked text', () => {
    const value = 'prefix/界/👩‍💻/agent.ts'
    const render = (cursor: number, masked = false): string =>
      sanitizeTerminalText(
        renderToString(createElement(EditableText, { value, cursor, width: 13, active: true, masked }), { columns: 13 })
      )
    const atEnd = render(graphemes(value).length)
    expect(atEnd).toBe('/👩‍💻/agent.ts▌')
    expect(stringWidth(atEnd)).toBe(13)
    expect(render(0)).toBe('prefix/界/👩‍💻/')
    expect(render(graphemes(value).length, true)).toBe(`${'•'.repeat(12)}▌`)
  })
})

describe('prompt editor input', () => {
  it('scales the composer row cap with terminal height up to eight rows', () => {
    expect(composerMaxRows(12)).toBe(2)
    expect(composerMaxRows(16)).toBe(6)
    expect(composerMaxRows(30)).toBe(8)
    expect(composerMaxRows(16, 2)).toBe(4)
  })

  it('reports the rendered editor height for command-deck layout', () => {
    expect(promptEditorHeight('', 0, 80, 8)).toBe(4)
    expect(promptEditorHeight('one\ntwo', 8, 80, 8)).toBe(4)
    expect(promptEditorHeight('one\ntwo\nthree\nfour', 18, 80, 8)).toBe(6)
    expect(promptEditorHeight('one\ntwo\nthree\nfour', 18, 80, 3)).toBe(5)
    expect(promptEditorHeight(Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'), 0, 80, 8)).toBe(10)
    expect(promptEditorHeight('one\ntwo\nthree\nfour', 18, 80, 8, true)).toBe(4)
    expect(promptEditorHeight('', 0, 80, 8, false, true)).toBe(6)
    expect(promptEditorHeight('', 0, 80, 8, true, true)).toBe(6)
  })

  it('names the wrapped rows scrolled out of the prompt', () => {
    const input = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')
    const frame = (cursor: number): string[] =>
      renderToString(createElement(PromptEditor, { input, cursor, width: 40, maxRows: 8 }), { columns: 40 }).split('\n')

    const atEnd = frame(input.length)
    expect(atEnd).toHaveLength(10)
    expect(atEnd[0]).toBe(`┌${'─'.repeat(14)} ↑ 4 more ${'─'.repeat(14)}┐`)
    expect(atEnd.at(-1)).toBe(`└${'─'.repeat(38)}┘`)
    expect(frame(0).at(-1)).toContain(' ↓ 4 more ')
  })

  it('handles the DEL byte that Ink reports for Backspace', () => {
    const typed = reduceInput(emptyEditor(), 'hello', {}, 'idle').state
    expect(reduceInput(typed, '\u007f', {}, 'idle').state).toMatchObject({ input: 'hell', cursor: 4 })
  })

  it('applies embedded terminal DEL bytes when input arrives in one chunk', () => {
    expect(reduceInputSequence(emptyEditor(), 'junk\u007f\u007f\u007f\u007f/exit', {}, 'idle')).toMatchObject({
      action: 'none',
      state: { input: '/exit', cursor: 5 },
    })
  })

  it('completes slash-command arguments', () => {
    expect(commandAssistance('/voice o')?.completions ?? []).toEqual([
      expect.objectContaining({ usage: 'on', replacement: '/voice on ' }),
      expect.objectContaining({ usage: 'off', replacement: '/voice off ' }),
    ])
    expect(commandAssistance('/permissions ')).toMatchObject({
      signature: '/permissions [default|bypass]',
      completions: [],
    })
    expect(commandAssistance('/voice ')?.completions).toEqual([])
    expect(commandAssistance('/sessions ')?.completions).toEqual([])
    expect(
      reduceInput({ ...emptyEditor(), input: '/sessions ', cursor: 10 }, '', { tab: true }, 'idle').state
    ).toMatchObject({
      input: '/sessions ',
      cursor: 10,
    })

    const state = { ...emptyEditor(), input: '/permissions b', cursor: 14 }
    expect(reduceInput(state, '', { tab: true }, 'idle').state).toMatchObject({
      input: '/permissions bypass ',
      cursor: 20,
    })
  })

  it.each([
    [80, 'Enter to send • Ctrl+J for newline • / for commands'],
    [50, 'Enter send • Ctrl+J newline • / commands'],
    [40, 'Enter send • / commands'],
    [22, 'Enter send'],
  ])('fits placeholder guidance on one row at %i columns', (width, hint) => {
    const empty = renderToString(createElement(PromptEditor, { input: '', cursor: 0, width }), {
      columns: width,
    })
    expect(empty).toContain(`▌${hint}`)
    const typing = renderToString(createElement(PromptEditor, { input: 'draft', cursor: 5, width }), { columns: width })
    expect(typing).not.toContain('Enter')
    expect(empty.split('\n')).toHaveLength(typing.split('\n').length)
  })

  it('marks bang commands with a bold red bang and a shell placeholder', () => {
    const level = chalk.level
    chalk.level = 1
    try {
      const empty = renderToString(createElement(PromptEditor, { input: '!', cursor: 1 }))
      const command = renderToString(createElement(PromptEditor, { input: '!pwd', cursor: 4 }))

      expect(empty).toContain('Execute a direct shell command')
      // eslint-disable-next-line no-control-regex -- asserts the ANSI bold styling around the bang
      expect(command).toMatch(/\u001b\[1m\u001b\[9?1m!\u001b\[22m/u)
      expect(command).not.toContain('Execute a direct shell command')
      expect(command).not.toContain('shell')
    } finally {
      chalk.level = level
    }
  })

  it('does not insert command-modified text', () => {
    expect(reduceInput(emptyEditor(), 'x', { super: true }, 'idle')).toMatchObject({
      action: 'none',
      state: { input: '' },
    })
  })

  it('follows the cursor through explicit lines and terminal-width graphemes', () => {
    expect(promptViewport('one\ntwo\nthree', 13, 20)).toEqual([
      { before: 'two', after: '' },
      { before: 'three', current: ' ', after: '' },
    ])
    expect(promptViewport('ab界c', 4, 4)).toEqual([
      { before: 'ab界', after: '' },
      { before: 'c', current: ' ', after: '' },
    ])
  })

  it('grows the input surface to show wrapped text', () => {
    const output = renderToString(
      createElement(PromptEditor, {
        input: '123456789',
        cursor: 9,
        width: 8,
      })
    )

    expect(output).toContain('│ 1234 │\n│ 5678 │\n│ 9▌')
  })

  it('follows the cursor after reaching the configured row cap', () => {
    const output = renderToString(
      createElement(PromptEditor, {
        input: 'one\ntwo\nthree\nfour',
        cursor: 18,
        maxRows: 3,
      })
    )

    expect(output).not.toContain('one')
    expect(output).toContain('│ two')
    expect(output).toContain('│ three')
    expect(output).toContain('│ four▌')
  })

  it('reveals earlier multiline input when the cursor moves back', () => {
    expect(promptViewport('one\ntwo\nthree\nfour', 0, 20, 3)).toEqual([
      { before: '', current: 'o', after: 'ne' },
      { before: 'two', after: '' },
      { before: 'three', after: '' },
    ])
  })

  it('colors an actionable command token with the accent without coloring its argument', () => {
    const level = chalk.level
    chalk.level = 3
    try {
      const output = renderToString(
        createElement(PromptEditor, {
          input: '/model improve the response',
          cursor: 26,
          actionableCommandToken: '/model',
        })
      )
      expect(output).toContain(
        '\u001b[38;2;0;204;96m/model\u001b[38;2;236;239;241m improve the respons\u001b[7me\u001b[27m'
      )
    } finally {
      chalk.level = level
    }
  })

  it('deletes whole grapheme clusters', () => {
    const typed = reduceInput(emptyEditor(), 'A👩🏽‍💻', {}, 'idle').state
    expect(reduceInput(typed, '', { backspace: true }, 'idle').state.input).toBe('A')
  })

  it('supports Ctrl+J without submitting', () => {
    const first = reduceInput(emptyEditor(), 'one', {}, 'idle').state
    expect(reduceInput(first, '\n', {}, 'idle')).toMatchObject({
      action: 'none',
      state: { input: 'one\n' },
    })
  })

  it('submits and recalls history', () => {
    const typed = reduceInput(emptyEditor(), 'hello', {}, 'idle').state
    const submitted = submitEditor(typed, typed.input)
    expect(submitted).toMatchObject({ action: 'submit', prompt: 'hello', state: { input: '' } })
    expect(reduceInput(submitted.state, '', { upArrow: true }, 'idle').state.input).toBe('hello')
  })

  it('returns to the unsent draft after browsing and editing history', () => {
    const press = (state: EditorState, key: Partial<Key>, character = ''): EditorState =>
      reduceInput(state, character, key, 'idle').state
    let state = submitEditor(reduceInput(emptyEditor(), 'first', {}, 'idle').state, 'first').state
    state = submitEditor(reduceInput(state, 'second', {}, 'idle').state, 'second').state
    state = reduceInput(state, 'live draft', {}, 'idle').state

    state = press(state, { upArrow: true })
    state = press(state, { upArrow: true })
    expect(state.input).toBe('first')
    state = press(state, {}, '!')
    expect(state.input).toBe('first!')
    state = press(state, { downArrow: true })
    expect(state.input).toBe('second')
    state = press(state, { downArrow: true })
    expect(state).toMatchObject({ input: 'live draft', cursor: 10 })
    expect(press(state, { downArrow: true }).input).toBe('live draft')
  })

  it('moves between lines of a multi-line draft before reaching history', () => {
    let state = submitEditor(reduceInput(emptyEditor(), 'older', {}, 'idle').state, 'older').state
    state = reduceInput(state, 'one\nlonger two', {}, 'idle').state

    state = reduceInput(state, '', { upArrow: true }, 'idle').state
    expect(state).toMatchObject({ input: 'one\nlonger two', cursor: 3 })
    state = reduceInput(state, '', { downArrow: true }, 'idle').state
    expect(state).toMatchObject({ input: 'one\nlonger two', cursor: 7 })
    state = reduceInput(state, '', { upArrow: true }, 'idle').state
    expect(reduceInput(state, '', { upArrow: true }, 'idle').state.input).toBe('older')
  })

  it('queues with Enter and preserves drafts when interrupted', () => {
    const typed = reduceInput(emptyEditor(), 'change direction', {}, 'running').state

    expect(reduceInput(typed, '', { return: true }, 'running')).toMatchObject({
      action: 'submit',
      prompt: 'change direction',
      state: { input: '' },
    })
    expect(reduceInput(typed, '', { escape: true }, 'running')).toMatchObject({
      action: 'cancel',
      state: { input: 'change direction' },
    })
    expect(reduceInput(typed, '', { return: true, ctrl: true }, 'running')).toMatchObject({
      action: 'submit',
      prompt: 'change direction',
      state: { input: '' },
    })
    expect(reduceInput(typed, 'g', { ctrl: true }, 'running')).toMatchObject({
      action: 'none',
      state: { input: 'change direction' },
    })
  })
})
