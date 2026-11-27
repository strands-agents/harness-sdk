import { expect, it } from 'vitest'
import { Text } from 'ink'
import { createElement } from 'react'

import { TerminalScreen } from './terminal-screen.mjs'
import { expectRestoredTerminal } from './terminal-harness.js'
import { render, ttyInput, ttyOutput } from './terminal.js'

it('consumes terminal output even when a test does not capture frames', async () => {
  const output = ttyOutput(80, 24)
  await new Promise<void>((resolve, reject) => {
    output.write(Buffer.alloc(128 * 1024, 'x'), (error) => (error ? reject(error) : resolve()))
  })
})

it('allows waiting after unmount without leaving process exit listeners behind', async () => {
  const listeners = process.listenerCount('beforeExit')
  const instance = render(createElement(Text, {}, 'Ready'), {
    stdin: ttyInput(),
    stdout: ttyOutput(80, 24),
    stderr: ttyOutput(80, 24),
  })
  await instance.waitUntilRenderFlush()
  instance.unmount()
  await instance.waitUntilExit()
  await instance.waitUntilExit()
  expect(process.listenerCount('beforeExit')).toBe(listeners)
})

it('reads viewport text and locates styled controls after wide characters', async () => {
  const screen = new TerminalScreen(20, 3)
  try {
    await screen.write('File 界\u001b[32mLaunch\u001b[0m\r\nReady')
    screen.resize(30, 4)
    expect(screen.text.split('\n')).toEqual(['File 界Launch', 'Ready', '', ''])
    expect(screen.locate('Launch')).toMatchObject({ column: 8, row: 1 })
    expect(screen.locate('Launch')!.style).not.toEqual(screen.locate('Ready')!.style)
    await screen.write('\u001b[?1049h\u001b[HReady\u001b[1;21HHidden')
    screen.resize(10, 4)
    expect(screen.text.split('\n')).toEqual(['Ready', '', '', ''])
    expect(screen.locate('Hidden')).toBeUndefined()
  } finally {
    screen.dispose()
  }
})

it('accepts equivalent mouse resets but rejects terminal modes left enabled', async () => {
  const screen = new TerminalScreen(20, 3)
  const output = '\u001b[?1049h\u001b[?1002h\u001b[?1006h\u001b[?2004h\u001b[?25l'
  const reset = '\u001b[?1003;1006l\u001b[?2004l\u001b[?2026l\u001b[?2031l\u001b[?25h'
  try {
    await screen.write(`${output}${reset}\u001b[?1049l`)
    const result = {
      returnCode: 0,
      inputModeRestored: null,
      terminalModes: screen.terminal.modes,
      output: `${output}${reset}\u001b[?1049l`,
      screens: [],
      resizeScreens: [],
      exportSaved: false,
    }
    expectRestoredTerminal(result)
    for (const enabled of ['1003', '1006', '2004', '2026', '2031']) {
      await screen.write(`${reset}\u001b[?${enabled}h`)
      expect(() =>
        expectRestoredTerminal({
          ...result,
          output: `${result.output}\u001b[?${enabled}h`,
          terminalModes: screen.terminal.modes,
        })
      ).toThrow()
    }
    await screen.write(`${reset}\u001b[?25l`)
    expect(() => expectRestoredTerminal({ ...result, output: `${result.output}\u001b[?25l` })).toThrow()
  } finally {
    screen.dispose()
  }
})
