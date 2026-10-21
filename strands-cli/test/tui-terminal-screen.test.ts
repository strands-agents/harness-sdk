import { expect, it } from 'vitest'
import { Text } from 'ink'
import { createElement } from 'react'

import { TerminalScreen } from './fixtures/terminal-screen.mjs'
import { render, ttyInput, ttyOutput } from './fixtures/terminal.js'

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

it('retains unchanged rows and removes stale text when only part of the screen is redrawn', async () => {
  const screen = new TerminalScreen(30, 4)
  try {
    await screen.write('Help\r\nControls\r\nSend a message')
    await screen.write('\u001b[2;1H\u001b[2KSearch')
    expect(screen.text.split('\n')).toEqual(['Help', 'Search', 'Send a message', ''])
    expect(screen.text).not.toContain('Controls')

    await screen.write('\u001b[2J\u001b[HExport complete')
    expect(screen.text).toContain('Export complete')
    expect(screen.text).not.toContain('Help')
    expect(screen.text).not.toContain('Send a message')
  } finally {
    screen.dispose()
  }
})

it('handles split UTF-8, split escape sequences, and terminal resizing', async () => {
  const screen = new TerminalScreen(20, 3)
  try {
    const text = Buffer.from('File 界')
    await screen.write(text.subarray(0, text.length - 1))
    await screen.write(text.subarray(text.length - 1))
    await screen.write('\u001b[')
    await screen.write('2;1HReady')
    screen.resize(30, 4)
    expect(screen.text.split('\n')).toEqual(['File 界', 'Ready', '', ''])
    await screen.write('\u001b[1;8H\u001b[32mLaunch')
    expect(screen.locate('Launch')).toMatchObject({ column: 8, row: 1 })
    expect(screen.locate('Launch')!.style).not.toEqual(screen.locate('Ready')!.style)
  } finally {
    screen.dispose()
  }
})
