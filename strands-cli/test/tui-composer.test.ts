import chalk from 'chalk'
import { createElement } from 'react'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import { commandAssistance } from '../src/tui/chat/commands.js'
import {
  composerMaxRows,
  emptyEditor,
  promptEditorHeight,
  promptViewport,
  reduceInput,
  reduceInputSequence,
  submitEditor,
} from '../src/tui/terminal/composer.js'
import { PromptEditor } from '../src/tui/view/prompt-editor.js'

describe('prompt editor input', () => {
  it('scales the composer row cap with terminal height', () => {
    expect(composerMaxRows(12)).toBe(2)
    expect(composerMaxRows(20)).toBe(10)
    expect(composerMaxRows(30)).toBe(12)
    expect(composerMaxRows(20, 2)).toBe(8)
  })

  it('reports the rendered editor height for command-deck layout', () => {
    expect(promptEditorHeight('', 0, 80, 8)).toBe(3)
    expect(promptEditorHeight('one\ntwo\nthree\nfour', 18, 80, 8)).toBe(5)
    expect(promptEditorHeight('one\ntwo\nthree\nfour', 18, 80, 3)).toBe(4)
    expect(promptEditorHeight('one\ntwo\nthree\nfour', 18, 80, 8, true)).toBe(3)
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

  it('renders the caret before the empty editor placeholder', () => {
    const output = renderToString(
      createElement(PromptEditor, {
        input: '',
        cursor: 0,
        agentName: 'Strands harness',
        animateCursor: false,
      })
    )

    expect(output).toContain('◆ ▌Message Strands harness')
  })

  it('marks bang commands as shell execution', () => {
    const output = renderToString(
      createElement(PromptEditor, {
        input: '!pwd',
        cursor: 4,
        agentName: 'Strands harness',
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

  it('grows the input surface to show wrapped text', () => {
    const output = renderToString(
      createElement(PromptEditor, {
        input: '123456789',
        cursor: 9,
        agentName: 'Strands harness',
        width: 8,
      })
    )

    expect(output).toContain('◆ 1234')
    expect(output).toContain('  5678')
    expect(output).toContain('  9')
  })

  it('follows the cursor after reaching the configured row cap', () => {
    const output = renderToString(
      createElement(PromptEditor, {
        input: 'one\ntwo\nthree\nfour',
        cursor: 18,
        agentName: 'Strands harness',
        maxRows: 3,
      })
    )

    expect(output).not.toContain('one')
    expect(output).toContain('◆ two')
    expect(output).toContain('  three')
    expect(output).toContain('  four')
  })

  it('reveals earlier multiline input when the cursor moves back', () => {
    expect(promptViewport('one\ntwo\nthree\nfour', 0, 20, 3)).toEqual([
      { before: '', current: 'o', after: 'ne' },
      { before: 'two', after: '' },
      { before: 'three', after: '' },
    ])
  })

  it('colors an actionable command token purple without coloring its argument', () => {
    const level = chalk.level
    chalk.level = 3
    try {
      const output = renderToString(
        createElement(PromptEditor, {
          input: '/model improve the response',
          cursor: 26,
          agentName: 'Strands harness',
          actionableCommandToken: '/model',
        })
      )
      expect(output).toContain(
        '\u001b[38;2;192;132;252m/model\u001b[38;2;236;239;241m improve the respons\u001b[7me\u001b[27m'
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
