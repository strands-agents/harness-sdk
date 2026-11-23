import { Box, Text } from 'ink'
import { createElement, useState, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { splitUnfinishedMouseReport } from '../../src/terminal/mouse-input.js'
import { observeTerminalColorMode } from '../../src/terminal/theme-detection.js'
import { useTerminalInput } from '../../src/ui/input.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const REPORT = '\u001b[<64;50;20M'
// Ink waits 20 ms for the rest of an escape sequence before it hands the pieces on as typed text.
const LONGER_THAN_INK_WAITS = 60

const later = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The input as the app reads it: what the terminal sent, after the filter that every interactive run reads through. */
const filteredInput = () => {
  const terminal = ttyInput()
  const observer = observeTerminalColorMode(terminal, ttyOutput(80, 24))
  const passed: string[] = []
  observer.input.on('data', (chunk: Buffer) => passed.push(chunk.toString()))
  return { terminal, observer, passed: (): string => passed.join('') }
}

describe('a mouse report that a read stops inside', () => {
  it.each([
    ['nothing of a report', `ab${REPORT}c`, `ab${REPORT}c`, ''],
    ['the start of one', `ab${REPORT}\u001b[<64;50;2`, `ab${REPORT}`, '\u001b[<64;50;2'],
    ['only its first bytes', 'ab\u001b[<', 'ab', '\u001b[<'],
    ['one that lacks its last byte', '\u001b[<0;7;12', '', '\u001b[<0;7;12'],
    ['an escape that may be a key', 'ab\u001b', 'ab\u001b', ''],
    ['another escape sequence', 'ab\u001b[1;5', 'ab\u001b[1;5', ''],
    ['typed text that looks like one', 'ab[<64;50;2', 'ab[<64;50;2', ''],
  ])('shouldCutOffTheReportWhenTheValueEndsIn%s', (_case, value, finished, unfinished) => {
    expect(splitUnfinishedMouseReport(value)).toEqual({ finished, unfinished })
  })

  it('shouldWaitForTheEndOfTheReportHoweverLateItComes', async () => {
    const { terminal, observer, passed } = filteredInput()

    terminal.write('a\u001b[<64;50;2')
    await vi.waitFor(() => expect(passed()).toBe('a'))
    await later(LONGER_THAN_INK_WAITS)
    const whileWaiting = passed()
    terminal.write('0Mb')

    await vi.waitFor(() => expect(passed()).toBe(`a${REPORT}b`))
    expect(whileWaiting).toBe('a')
    observer.dispose()
  })

  it('shouldPutAReportTogetherWhenItArrivesInThreeReads', async () => {
    const { terminal, observer, passed } = filteredInput()

    for (const piece of ['\u001b[<', '64;50', ';20M']) {
      terminal.write(piece)
      await later(LONGER_THAN_INK_WAITS)
    }

    await vi.waitFor(() => expect(passed()).toBe(REPORT))
    observer.dispose()
  })

  it('shouldPassWholeReportsAndKeysOnAtOnce', async () => {
    const { terminal, observer, passed } = filteredInput()

    terminal.write(`${REPORT}${REPORT}x`)

    await vi.waitFor(() => expect(passed()).toBe(`${REPORT}${REPORT}x`))
    observer.dispose()
  })

  it('shouldLoseNothingWhenWhatFollowsIsNotTheEndOfTheReport', async () => {
    const { terminal, observer, passed } = filteredInput()

    terminal.write('\u001b[<64;50;2')
    terminal.write('typed')

    await vi.waitFor(() => expect(passed()).toBe('\u001b[<64;50;2typed'))
    observer.dispose()
  })

  it('shouldGiveInkOneReportAndNothingTypedWhenTheHalvesComeApart', async () => {
    const Heard = (): ReactElement => {
      const [heard, setHeard] = useState<string[]>([])
      useTerminalInput((input) => setHeard((current) => [...current, input]))
      return createElement(
        Box,
        { flexDirection: 'column' },
        createElement(Text, null, 'input'),
        createElement(Text, null, `heard ${JSON.stringify(heard)}`)
      )
    }
    const { terminal, observer } = filteredInput()
    const output = ttyOutput(120, 10)
    const frame = captureFrame(output)
    const instance = render(createElement(Heard), { stdin: observer.input, stdout: output })
    await instance.waitUntilRenderFlush()

    terminal.write('\u001b[<64;50;2')
    await later(LONGER_THAN_INK_WAITS)
    terminal.write('0M')

    await vi.waitFor(() => expect(frame().join('\n')).toContain('heard ["[<64;50;20M"]'))
    observer.dispose()
  })
})
