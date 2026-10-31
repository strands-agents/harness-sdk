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

  it('renders pasted tabs without hiding the caret or overflowing narrow fields', () => {
    const render = (value: string, cursor: number, width: number): string =>
      sanitizeTerminalText(
        renderToString(createElement(EditableText, { value, cursor, width, active: true }), { columns: width })
      )
    expect(render('\tchanged', 8, 20)).toBe('    changed▌')
    for (const width of [1, 2, 3, 4]) {
      for (const cursor of [0, 1]) {
        const output = render('\t', cursor, width)
        expect(output).not.toContain('\t')
        expect(stringWidth(output)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('renders control characters in single-line values safely without changing edits or masked values', () => {
    const value = 'Agent\u001b[31mRed'
    const cursor = graphemes(value).length
    const render = (active: boolean, masked = false): string =>
      renderToString(createElement(EditableText, { value, cursor, width: 40, active, masked }), { columns: 40 })
    for (const active of [false, true]) {
      const output = render(active)
      expect(output).not.toContain('\u001b[31m')
      expect(sanitizeTerminalText(output)).toBe(`Agent�[31mRed${active ? '▌' : ''}`)
    }
    expect(sanitizeTerminalText(render(true, true))).toBe(`${'•'.repeat(cursor)}▌`)

    const edited = reduceInput({ ...emptyEditor(), input: value, cursor: cursor - 1 }, '!', {}, 'idle').state
    expect(edited).toMatchObject({ input: 'Agent\u001b[31mRe!d', cursor })
    expect(
      sanitizeTerminalText(
        renderToString(
          createElement(EditableText, { value: edited.input, cursor: edited.cursor, width: 40, active: true }),
          { columns: 40 }
        )
      )
    ).toBe('Agent�[31mRe!d')
    expect(reduceInput(edited, '', { return: true }, 'idle')).toMatchObject({
      action: 'submit',
      prompt: 'Agent\u001b[31mRe!d',
    })
  })
})

describe('prompt editor input', () => {
  it('scales the composer row cap with terminal height', () => {
    expect(composerMaxRows(12)).toBe(2)
    expect(composerMaxRows(20)).toBe(10)
    expect(composerMaxRows(30)).toBe(12)
    expect(composerMaxRows(20, 2)).toBe(8)
  })

  it('reports the rendered editor height for command-deck layout', () => {
    expect(promptEditorHeight('', 0, 80, 8)).toBe(7)
    expect(promptEditorHeight('one\ntwo\nthree\nfour', 18, 80, 8)).toBe(7)
    expect(promptEditorHeight('one\ntwo\nthree\nfour', 18, 80, 3)).toBe(7)
    expect(promptEditorHeight('one\ntwo\nthree\nfour', 18, 80, 8, true)).toBe(7)
    expect(promptEditorHeight('', 0, 80, 8, false, true)).toBe(9)
    expect(promptEditorHeight('', 0, 80, 8, true, true)).toBe(9)
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
    expect(commandAssistance('/permissions ')).toMatchObject({ signature: '/permissions [default|bypass]' })

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
    const empty = renderToString(createElement(PromptEditor, { input: '', cursor: 0, width, animateCursor: false }), {
      columns: width,
    })
    expect(empty).toContain(`▌${hint}`)
    const typing = renderToString(
      createElement(PromptEditor, { input: 'draft', cursor: 5, width, animateCursor: false }),
      { columns: width }
    )
    expect(typing).not.toContain('Enter')
    expect(empty.split('\n')).toHaveLength(typing.split('\n').length)
  })

  it('marks bang commands as shell execution', () => {
    const output = renderToString(
      createElement(PromptEditor, {
        input: '!pwd',
        cursor: 4,
      })
    )

    expect(output).toContain('◆ shell !pwd')
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

  it('displays pasted tabs as spaces while preserving the submitted text and cursor indices', () => {
    const input = 'code\n\tchanged'
    const state = reduceInput(emptyEditor(), input, {}, 'idle').state
    const output = renderToString(createElement(PromptEditor, { input, cursor: state.cursor, width: 30 }), {
      columns: 30,
    })
    expect(output).toContain('    changed▌')
    expect(output).not.toContain('\t')
    expect(reduceInput(state, '', { return: true }, 'idle')).toMatchObject({ action: 'submit', prompt: input })
    expect(promptViewport('\tx', 1, 8)).toEqual([{ before: '    ', current: 'x', after: '' }])
    for (const width of [1, 2, 3]) {
      const rows = promptViewport('\tx', 1, width)
      expect(rows.every((row) => stringWidth(row.before + (row.current ?? '') + row.after) <= width)).toBe(true)
    }
  })

  it('grows the input surface to show wrapped text', () => {
    const output = renderToString(
      createElement(PromptEditor, {
        input: '123456789',
        cursor: 9,
        width: 8,
      })
    )

    expect(output).toContain(' 123456\n 789')
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
    expect(output).toContain(' two\n three\n four')
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
        '\u001b[38;2;104;245;138m/model\u001b[38;2;236;239;241m improve the respons\u001b[7me\u001b[27m'
      )
    } finally {
      chalk.level = level
    }
  })

  it.each([
    ['A👩🏽‍💻', ''],
    ['Ae', '\u0301'],
    ['A👍', '🏽'],
    ['A👩', '‍💻'],
  ])('deletes whole grapheme clusters assembled from %s and %s', (first, continuation) => {
    const typed = reduceInput(emptyEditor(), first, {}, 'idle').state
    const composed = reduceInput(typed, continuation, {}, 'idle').state
    expect(composed).toMatchObject({ input: first + continuation, cursor: 2 })
    expect(reduceInput(composed, '', { backspace: true }, 'idle').state.input).toBe('A')
  })

  it('places the cursor after a grapheme joined with the following text', () => {
    const state = { ...reduceInput(emptyEditor(), 'A💻', {}, 'idle').state, cursor: 1 }
    const composed = reduceInput(state, '👩‍', {}, 'idle').state
    expect(composed).toMatchObject({ input: 'A👩‍💻', cursor: 2 })
    expect(reduceInput(composed, '', { backspace: true }, 'idle').state.input).toBe('A')
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

  it('queues with Enter, steers with Ctrl+G or modified Enter, and preserves drafts when interrupted', () => {
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
      action: 'steer',
      prompt: 'change direction',
      state: { input: '' },
    })
    expect(reduceInput(typed, 'g', { ctrl: true }, 'running')).toMatchObject({
      action: 'steer',
      prompt: 'change direction',
      state: { input: '' },
    })
  })
})
