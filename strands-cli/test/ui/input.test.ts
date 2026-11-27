import { Box, Text } from 'ink'
import { createElement, useState, type ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import { useInput, useTerminalInput } from '../../src/ui/input.js'
import { captureFrame, mouseInputSequence, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

/** What the terminal sends as the mouse moves, with Shift and Alt held, scrolls both ways, clicks, and lets go. */
const MOUSE_REPORTS = [
  mouseInputSequence(35, 49, 19, 'M'),
  mouseInputSequence(47, 89, 34, 'M'),
  mouseInputSequence(64, 49, 19, 'M'),
  mouseInputSequence(65, 49, 19, 'M'),
  mouseInputSequence(0, 49, 19, 'M'),
  mouseInputSequence(0, 49, 19, 'm'),
]

const Heard = ({ hook }: { hook: typeof useInput }): ReactElement => {
  const [heard, setHeard] = useState<string[]>([])
  hook((input) => setHeard((current) => [...current, input]))
  // Two rows, because the fixture reads a frame only when it has more than one.
  return createElement(
    Box,
    { flexDirection: 'column' },
    createElement(Text, null, 'input'),
    createElement(Text, null, `heard ${JSON.stringify(heard)}`)
  )
}

const heardBy = async (hook: typeof useInput): Promise<string> => {
  const input = ttyInput()
  const output = ttyOutput(200, 10)
  const frame = captureFrame(output)
  const instance = render(createElement(Heard, { hook }), { stdin: input, stdout: output })
  await instance.waitUntilRenderFlush()
  for (const sent of ['a', ...MOUSE_REPORTS, 'b', MOUSE_REPORTS.join(''), 'c']) {
    input.write(sent)
    await instance.waitUntilRenderFlush()
  }
  return frame().join('\n')
}

describe('input of the terminal', () => {
  it('shouldGiveAHandlerOfKeysAndTextWhatWasTypedAndNoneOfTheMouseReports', async () => {
    expect(await heardBy(useInput)).toContain('heard ["a","b","c"]')
  })

  it('shouldGiveAScreenThatFollowsTheMouseTheReportsToo', async () => {
    const heard = await heardBy(useTerminalInput)

    expect(heard).toContain('"a","[<35;50;20M","[<47;90;35M","[<64;50;20M","[<65;50;20M","[<0;50;20M","[<0;50;20m","b"')
    expect(heard).toContain('"c"]')
  })
})
