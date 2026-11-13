import chalk from 'chalk'
import { createElement } from 'react'
import { renderToString, type Key } from 'ink'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { commandAssistance } from '../../src/ui/chat/commands.js'
import {
  emptyEditor,
  promptViewport,
  reduceInput,
  reduceInputSequence,
  submitEditor,
  type EditorState,
} from '../../src/terminal/composer.js'
import { graphemes } from '../../src/terminal/text.js'
import { PromptEditor } from '../../src/ui/chat/prompt.js'
import { EditableText } from '../../src/ui/text-input.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'

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

    expect(output).toContain('│ 1234 │\n│ 5678 │\n│ 9▌')
  })

  it('renders programmatic control characters safely while preserving submission and cursor indices', () => {
    const input = '/review\u001b[31m-red'
    const characters = graphemes(input)
    for (let cursor = 0; cursor <= characters.length; cursor++) {
      const [row] = promptViewport(input, cursor, 40)
      expect(row).toEqual({
        before: characters.slice(0, cursor).join('').replace('\u001b', '�'),
        current: characters[cursor]?.replace('\u001b', '�') ?? ' ',
        after: characters
          .slice(cursor + 1)
          .join('')
          .replace('\u001b', '�'),
      })
    }
    const state = { ...emptyEditor(), input, cursor: characters.length }
    const output = renderToString(createElement(PromptEditor, { ...state, width: 40 }), { columns: 40 })
    expect(output).toContain('/review�[31m-red▌')
    expect(output).not.toContain('\u001b[31m')
    expect(reduceInput(state, '', { return: true }, 'idle')).toMatchObject({ action: 'submit', prompt: input })
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
